import { convertClip } from "./convert.mjs";

const jobs = new Map();
let running = false;
const notify = message => chrome.runtime.sendMessage({ target: "background", ...message }).catch(() => {});
const release = job => {
  if (job.url) URL.revokeObjectURL(job.url);
  clearTimeout(job.timer);
  job.controller.abort();
  jobs.delete(job.id);
};
async function runNext() {
  if (running) return;
  const job = [...jobs.values()].find(item => item.state === "queued");
  if (!job) return;
  running = true; job.state = "processing";
  await notify({ type: "update", id: job.id, state: "processing", message: "MP4を作成しています…" });
  let lastProgress = -1;
  try {
    const tracks = job.tracks.map(track => {
      const data = new Uint8Array(track.size);
      let offset = 0;
      for (const chunk of track.chunks) { data.set(chunk, offset); offset += chunk.length; }
      track.chunks = [];
      return { mime: track.mime, offset: track.offset, data };
    });

    const blob = await convertClip(tracks, job, { signal: job.controller.signal, progress: value => {
      const rounded = Math.floor(value / 10) * 10;
      if (rounded !== lastProgress) { lastProgress = rounded; void notify({ type: "update", id: job.id, state: "processing", message: `MP4を作成しています… ${rounded}%` }); }
    } });
    job.tracks = [];
    job.url = URL.createObjectURL(blob);
    job.state = "saving";
    clearTimeout(job.timer);
    job.timer = setTimeout(() => release(job), 10 * 60 * 1000);
    await notify({ type: "save", id: job.id, url: job.url });
  } catch (error) {
    // 変換処理の例外に配信URLやページ上の値は含めない。
    const message = job.controller.signal.aborted ? "保存を中止しました。" :
      /^[\u3000-\u9fffこの区間映像指定処理].{0,160}$/.test(error.message || "") ? error.message : "MP4への変換に失敗しました。タブを再読み込みして再試行してください。";
    await notify({ type: "update", id: job.id, state: "error", message });
    release(job);
  } finally { running = false; void runNext(); }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "offscreen" || sender.id !== chrome.runtime.id || sender.tab) return;
  try {
    if (message.type === "begin") {
      if (jobs.size >= 2 || jobs.has(message.job.id)) throw new Error();
      const job = { ...message.job, state: "receiving", controller: new AbortController(),
        tracks: message.tracks.map(track => ({ ...track, received: 0, chunks: [] })) };
      job.timer = setTimeout(() => {
        job.controller.abort();
        if (job.state === "receiving" || job.state === "queued") {
          void notify({ type: "update", id: job.id, state: "error", message: "データの受け取りがタイムアウトしました。" }); release(job);
        }
      }, 120000);
      jobs.set(job.id, job); respond({ ok: true }); return;
    }
    const job = jobs.get(message.id);
    if (!job) throw new Error();
    if (message.type === "chunk") {
      const track = job.tracks[message.track];
      if (job.state !== "receiving" || !track || message.offset !== track.received ||
          typeof message.data !== "string" || message.data.length > 350000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw new Error();
      const decoded = atob(message.data);
      if (decoded.length + track.received > track.size) throw new Error();
      track.chunks.push(Uint8Array.from(decoded, char => char.charCodeAt(0)));
      track.received += decoded.length; respond({ ok: true }); return;
    }
    if (message.type === "finish") {
      if (job.state !== "receiving" || job.tracks.some(track => track.received !== track.size)) throw new Error();
      job.state = "queued"; respond({ ok: true }); void runNext(); return;
    }
    if (message.type === "release" || message.type === "cancel") {
      job.controller.abort();
      if (job.state !== "processing") release(job);
      respond({ ok: true }); return;
    }
    throw new Error();
  } catch { respond({ ok: false }); }
});
setInterval(() => { if (jobs.size) void notify({ type: "heartbeat" }); }, 15000);
