importScripts('clip.js');
const { videoId, validateRequest, ClipError } = globalThis.YouTubeFiveSecondClip;
const jobs = [];
let opening;
let writes = Promise.resolve();
const unfinished = job => ['receiving', 'queued', 'processing', 'saving'].includes(job.state);
const snapshot = () => jobs.map(({ id, filename, state, message }) => ({ id, filename, state, message }));
const persist = () => {
  const data = jobs.map(job => ({ ...job }));
  writes = writes.catch(() => {}).then(() => chrome.storage.session.set({ jobs: data }));
  return writes;
};
const ready = chrome.storage.session.get('jobs').then(async saved => {
  const alive = await chrome.offscreen.hasDocument();
  for (const old of (saved.jobs || []).slice(-20)) {
    jobs.push({ ...old, state: !alive && unfinished(old) && old.state !== 'saving' ? 'error' : old.state,
      message: !alive && unfinished(old) && old.state !== 'saving' ? '処理が中断しました。もう一度保存してください。' : old.message });
  }
});
async function ensureOffscreen() {
  if (opening) return opening;
  opening = (async () => {
    if (!await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'],
        justification: '読み込まれた動画データをブラウザー内でMP4化し、保存用Blobを作成するため' });
    }
  })();
  try { await opening; } finally { opening = null; }
}
const forward = message => chrome.runtime.sendMessage({ target: 'offscreen', ...message });
async function fail(job, message) {
  job.state = 'error'; job.message = message;
  await forward({ type: 'cancel', id: job.id }).catch(() => {});
  await persist();
}
function authorizeTab(sender, job) {
  if (!sender.tab || sender.frameId !== 0 || sender.tab.id !== job.tabId || sender.documentId !== job.documentId) {
    throw new ClipError('動画ページを確認できません。もう一度保存してください。');
  }
}
function validateTracks(tracks) {
      if (!Array.isArray(tracks) || tracks.length !== 2) throw new ClipError('映像・音声データがありません。');
  let total = 0;
  const result = tracks.map((track, index) => {
    if (typeof track.mime !== 'string' || !new RegExp(`^${index === 0 ? 'video' : 'audio'}/(mp4|webm)(;.{0,100})?$`).test(track.mime) ||
        !Number.isSafeInteger(track.size) || track.size < 16 || track.size > 65 * 1024 * 1024 ||
        !Number.isFinite(track.offset) || Math.abs(track.offset) > 604800) throw new ClipError('動画データの形式またはサイズが不正です。');
    total += track.size;
    return { mime: track.mime, size: track.size, offset: track.offset };
  });
  if (total > 128 * 1024 * 1024) throw new ClipError('動画データが大きすぎます。');
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'offscreen') return;
  (async () => {
    await ready;
    if (sender.id !== chrome.runtime.id) throw new ClipError('送信元を確認できません。');
    if (message?.target === 'background') {
      if (sender.url !== chrome.runtime.getURL('offscreen.html')) throw new ClipError('送信元を確認できません。');
      if (message.type === 'heartbeat') return { ok: true };
      const job = jobs.find(item => item.id === message.id);
      if (!job || !unfinished(job)) return { ok: false };
      if (message.type === 'update' && ['processing', 'error'].includes(message.state)) {
        job.state = message.state;
        job.message = String(message.message || '').slice(0, 200);
        await persist(); return { ok: true };
      }
      if (message.type === 'save') {
        if (!['processing', 'queued'].includes(job.state) || typeof message.url !== 'string' ||
            !message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) throw new ClipError('保存データが不正です。');
        job.state = 'saving'; job.message = 'MP4をダウンロードしています…';
        await persist();
        try {
          job.downloadId = await chrome.downloads.download({ url: message.url, filename: `YouTube-Clips/${job.filename}`, conflictAction: 'uniquify' });
          await persist();
          // 短いファイルがonChangedより先に完了した場合も状態を確認する。
          const [download] = await chrome.downloads.search({ id: job.downloadId });
          if (download && download.state !== 'in_progress') await downloaded(job, download.state);
        } catch { await fail(job, 'ダウンロードを開始できませんでした。Chromeの保存設定を確認してください。'); }
        return { ok: true };
      }
      return { ok: false };
    }
    if (message?.type === 'list') return { ok: true, jobs: snapshot() };
    if (message?.type === 'clip') {
      const request = validateRequest(message);
      if (!sender.tab || sender.frameId !== 0 || videoId(sender.url) !== request.videoId) throw new ClipError('通常のYouTube動画ページから実行してください。');
      if (jobs.filter(unfinished).length >= 2) throw new ClipError('保存処理が2件あります。完了を待ってから押してください。');
      if (jobs.some(job => job.id === request.id)) throw new ClipError('この保存要求はすでに受け付けています。');
      const tracks = validateTracks(message.tracks);
      const job = { ...request, tabId: sender.tab.id, documentId: sender.documentId, state: 'receiving', message: '動画データを準備しています…' };
      jobs.push(job);
      while (jobs.length > 20) jobs.splice(jobs.findIndex(item => !unfinished(item)), 1);
      await persist();
      try {
        await ensureOffscreen();
        const result = await forward({ type: 'begin', job: request, tracks });
        if (!result?.ok) throw new Error();
      } catch { await fail(job, 'MP4処理を開始できませんでした。拡張を再読み込みしてください。'); return { ok: false, error: job.message }; }
      return { ok: true, id: job.id };
    }
    if (['chunk', 'finish', 'abort'].includes(message?.type)) {
      const job = jobs.find(item => item.id === message.id);
      if (!job || job.state !== 'receiving') throw new ClipError('動画データの受付が終了しています。');
      authorizeTab(sender, job);
      if (message.type === 'abort') { await fail(job, '動画データの準備を中止しました。'); return { ok: true }; }
      if (message.type === 'chunk' && (typeof message.data !== 'string' || message.data.length > 350000 || !Number.isSafeInteger(message.offset))) {
        throw new ClipError('動画データのサイズが不正です。');
      }
      if (message.type === 'finish') { job.state = 'queued'; job.message = 'MP4の保存待ち'; await persist(); }
      const result = await forward({ type: message.type, id: job.id, track: message.track, offset: message.offset, data: message.data });
      if (!result?.ok) { await fail(job, '動画データを受け取れませんでした。再試行してください。'); return { ok: false, error: job.message }; }
      return { ok: true };
    }
    if (message?.type === 'cancel') {
      if (sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) throw new ClipError('保存状況から中止してください。');
      const job = jobs.find(item => item.id === message.id);
      if (job && unfinished(job)) {
        if (job.downloadId) await chrome.downloads.cancel(job.downloadId).catch(() => {});
        await fail(job, '保存を中止しました。');
      }
      return { ok: true };
    }
    throw new ClipError('不明な操作です。');
  })().then(respond, error => respond({ ok: false, error: error instanceof ClipError ? error.message : '処理に失敗しました。タブを再読み込みしてください。' }));
  return true;
});
async function downloaded(job, state) {
  if (job.state !== 'saving') return;
  job.state = state === 'complete' ? 'done' : 'error';
  job.message = state === 'complete' ? 'YouTube-Clips フォルダーにMP4を保存しました。' : 'ダウンロードが中断されました。';
  await persist();
  await forward({ type: 'release', id: job.id }).catch(() => {});
}
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  void ready.then(async () => {
    const job = jobs.find(item => item.downloadId === delta.id);
    if (job) await downloaded(job, delta.state.current);
  });
});
