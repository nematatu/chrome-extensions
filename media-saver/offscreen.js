"use strict";

const jobs = new Map();
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_JOBS = 6;
const OUTPUT_TTL_MS = 30 * 60 * 1000;
let directoryPromise = null;

function errorCode(error, fallback) {
  const code = error && error.message;
  const known = [...MediaSaverHls.ERROR_CODES, ...MediaSaverDash.ERROR_CODES, "NOT_MEDIA", "CANCELED",
    "TOO_LARGE", "STORAGE_FAILED", "TIMEOUT", "RATE_LIMITED", "AUTH_REQUIRED", "NOT_FOUND", "UNSUPPORTED", "UNSAFE_TARGET"];
  return known.includes(code) ? code : (fallback || "UNSUPPORTED");
}

function validateUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    return true;
  } catch { return false; }
}

async function jobDirectory() {
  if (!directoryPromise) directoryPromise = (async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("media-saver-jobs-v1", { create: true });
    for await (const name of directory.keys()) {
      if (/^[a-f0-9-]{36}-\d+\.bin$/i.test(name)) await directory.removeEntry(name);
    }
    return directory;
  })().catch(() => { directoryPromise = null; throw new Error("STORAGE_FAILED"); });
  return directoryPromise;
}

async function createOutput(job, index) {
  let writer = null, handle = null, name = "";
  try {
    const directory = await jobDirectory();
    name = `${job.token}-${index}.bin`;
    handle = await directory.getFileHandle(name, { create: true });
    writer = await handle.createWritable();
    let position = 0;
    return {
      async write(data, at) {
        if (job.disposed) throw new Error("CANCELED");
        const offset = at == null ? position : at;
        await writer.write({ type: "write", position: offset, data });
        position = Math.max(position, offset + data.byteLength);
      },
      async finish(mime, extension) {
        await writer.close();
        writer = null;
        const file = await handle.getFile();
        if (!file.size) throw new Error("STORAGE_FAILED");
        // OPFS files have an empty type. Wrap the file in a typed Blob so
        // chrome.downloads and the saved file expose the real MIME type. Blob
        // composition references the same bytes instead of copying them.
        const typed = new Blob([file], { type: mime || "application/octet-stream" });
        return { blobUrl: URL.createObjectURL(typed), size: file.size, mime, extension };
      },
      async dispose() {
        if (writer) { try { await writer.abort(); } catch {} writer = null; }
        try { await directory.removeEntry(name); } catch {}
      }
    };
  } catch (error) {
    if (writer) { try { await writer.abort(); } catch {} }
    if (handle) { try { await (await jobDirectory()).removeEntry(name); } catch {} }
    throw new Error("STORAGE_FAILED");
  }
}

function disposeJob(job) {
  if (job.disposed) return job.cleanup;
  job.disposed = true;
  job.controller.abort();
  clearTimeout(job.timeout);
  clearTimeout(job.ttl);
  for (const output of job.outputs || []) {
    if (output.blobUrl) { try { URL.revokeObjectURL(output.blobUrl); } catch {} }
    output.output?.dispose?.().catch?.(() => {});
  }
  job.outputs = [];
  job.cleanup = Promise.allSettled((job.writers || []).map(output => output.dispose())).then(() => {});
  jobs.delete(job.token);
  return job.cleanup;
}

function report(job, phase, extra = {}, force = false) {
  if (job.disposed) return;
  const now = Date.now();
  if (!force && phase === "downloading" && now - job.lastReport < 800) return;
  job.lastReport = now;
  const payload = {
    type: "ms:job-progress", token: job.token, phase, received: job.received,
    total: job.total, completed: job.completed, segments: job.segments,
    error: job.error || null, outputs: job.outputs?.map(({ blobUrl, size, mime, extension, role }) => ({ blobUrl, size, mime, extension, role })),
    filenameHint: job.filenameHint || "", duration: job.duration || 0, ...extra
  };
  try { chrome.runtime.sendMessage(payload).catch?.(() => {}); } catch {}
}

function requestOptions(job, range) {
  return {
    method: "GET", credentials: "include", redirect: "follow", cache: "no-store",
    referrer: job.pageUrl || undefined, referrerPolicy: "strict-origin-when-cross-origin",
    signal: job.controller.signal,
    headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined
  };
}

// The only way this document reaches the network: every URL, from the page or from a manifest, is checked.
const requestFor = pageUrl => MediaSaverCommon.guardFetch(fetch, pageUrl);

async function fetchWithLimit(job, url, limit, range) {
  if (!validateUrl(url)) throw new Error("UNSUPPORTED");
  const response = await requestFor(job.pageUrl)(url, requestOptions(job, range));
  if (response.status === 429) throw new Error("RATE_LIMITED");
  if ([401, 403].includes(response.status)) throw new Error("AUTH_REQUIRED");
  if ([404, 410].includes(response.status)) throw new Error("NOT_FOUND");
  if (!response.ok) throw new Error("UNSUPPORTED");
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/json")) throw new Error("NOT_MEDIA");
  const declared = Number(response.headers.get("content-length"));
  if (!range || response.status === 206) {
    if (Number.isFinite(declared) && declared > limit) throw new Error("TOO_LARGE");
  }
  if (!response.body) throw new Error("UNSUPPORTED");
  return response;
}

async function appendResponse(job, response, output, limit, range) {
  const reader = response.body.getReader();
  if (range && response.status !== 206) {
    // The server ignored Range. Keep only the requested window and stop early.
    const end = range.offset + range.length;
    let position = 0, written = 0;
    while (position < end) {
      const { value, done } = await reader.read();
      if (done) break;
      if (job.disposed) throw new Error("CANCELED");
      const start = Math.max(0, range.offset - position);
      const stop = Math.min(value.byteLength, end - position);
      if (stop > start) {
        const part = value.subarray(start, stop);
        await output.write(part);
        job.received += part.byteLength;
        written += part.byteLength;
      }
      position += value.byteLength;
    }
    if (written !== range.length) throw new Error("UNSUPPORTED");
    if (job.received > MAX_FILE_BYTES) throw new Error("TOO_LARGE");
    try { await reader.cancel(); } catch {}
    return;
  }
  let size = 0;
  const maximum = range ? Math.max(limit, range.length) : limit;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (job.disposed) throw new Error("CANCELED");
    size += value.byteLength;
    if (size > maximum) { try { await reader.cancel(); } catch {} throw new Error("TOO_LARGE"); }
    job.received += value.byteLength;
    if (job.received > MAX_FILE_BYTES) throw new Error("TOO_LARGE");
    await output.write(value);
  }
  if (range && size < range.length) throw new Error("UNSUPPORTED");
}

async function readText(job, url, limit) {
  const response = await fetchWithLimit(job, url, limit);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { try { await reader.cancel(); } catch {} throw new Error("TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("UNSUPPORTED"); }
}

async function downloadDirect(job, url, output, role) {
  const response = await fetchWithLimit(job, url, MAX_FILE_BYTES);
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  const disposition = response.headers.get("content-disposition") || "";
  const filenameHint = MediaSaverCommon.parseContentDisposition(disposition);
  job.filenameHint = job.filenameHint || filenameHint;
  job.total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (job.disposed) throw new Error("CANCELED");
    job.received += value.byteLength;
    if (job.received > MAX_FILE_BYTES) throw new Error("TOO_LARGE");
    await output.write(value);
    report(job, "downloading");
  }
  const extension = MediaSaverCommon.extensionForMime(type) || MediaSaverCommon.extensionOf(response.url || url) || "mp4";
  const mime = type || "application/octet-stream";
  return { output, extension, mime, role, filenameHint };
}

async function fetchManifest(job, url, kind) {
  const text = await readText(job, url, kind === "dash" ? 4 * 1024 * 1024 : 2 * 1024 * 1024);
  return text;
}

async function runHls(job) {
  const output = await createOutput(job, 0);
  job.writers = [output];
  const result = await MediaSaverHls.assemble(job.url, {
    request: requestFor(job.pageUrl), pageUrl: job.pageUrl, signal: job.controller.signal,
    variantUrl: job.quality?.url || "", maxHeight: Number(job.quality?.height) || 0,
    output: { write: (data, position) => output.write(data, position) },
    progress({ bytes, completed: done, total }) {
      job.received = bytes; job.completed = done; job.segments = total;
      job.progress = total ? done / total * 0.9 : 0;
      report(job, "downloading");
    }
  });
  const finished = await output.finish(result.mime, result.extension);
  finished.role = "file";
  job.outputs = [finished];
  job.duration = result.duration;
  report(job, "ready", { progress: 1 }, true);
}

async function runDashTrack(job, index, track, role) {
  const output = await createOutput(job, index);
  job.writers.push(output);
  if (track.singleUrl) {
    const info = await downloadDirect(job, track.singleUrl, output, role);
    const finished = await output.finish(
      role === "audio" ? "audio/mp4" : info.mime,
      role === "audio" ? "m4a" : info.extension
    );
    finished.role = role;
    return finished;
  }
  if (track.initUrl) {
    const response = await fetchWithLimit(job, track.initUrl, 64 * 1024 * 1024, track.initRange || null);
    await appendResponse(job, response, output, 64 * 1024 * 1024, track.initRange || null);
  }
  for (const segment of track.segments) {
    if (job.disposed) throw new Error("CANCELED");
    const response = await fetchWithLimit(job, segment.url, 128 * 1024 * 1024, segment.range || null);
    await appendResponse(job, response, output, 128 * 1024 * 1024, segment.range || null);
    job.completed++;
    report(job, "downloading");
  }
  const finished = await output.finish(track.mime || (role === "audio" ? "audio/mp4" : "video/mp4"), role === "audio" ? "m4a" : "mp4");
  finished.role = role;
  return finished;
}

async function runDash(job) {
  const text = await fetchManifest(job, job.url, "dash");
  const parsed = MediaSaverDash.parseMpd(text, job.url);
  const plan = MediaSaverDash.selectPlan(parsed, job.quality || null);
  const tracks = [];
  if (plan.video) tracks.push({ track: plan.video, role: "video" });
  if (plan.audio) tracks.push({ track: plan.audio, role: "audio" });
  job.segments = tracks.reduce((sum, item) => sum + (item.track.segments?.length || 1), 0);
  job.duration = plan.duration;
  const outputs = [];
  for (let index = 0; index < tracks.length; index++) {
    if (job.disposed) throw new Error("CANCELED");
    outputs.push(await runDashTrack(job, index, tracks[index].track, tracks[index].role));
    job.completed = job.segments;
  }
  job.outputs = outputs;
  report(job, "ready", { progress: 1 }, true);
}

async function startJob(message) {
  const data = message.job || {};
  if (!validateUrl(data.url)) throw new Error("UNSUPPORTED");
  if (!["hls", "dash", "video", "audio", "image"].includes(data.kind)) throw new Error("UNSUPPORTED");
  if (!/^[a-f0-9-]{36}$/i.test(data.token || "")) throw new Error("UNSUPPORTED");
  const job = {
    token: data.token, kind: data.kind, url: data.url, pageUrl: data.pageUrl || "", quality: data.quality || null,
    controller: new AbortController(), disposed: false, received: 0, total: 0, completed: 0, segments: 0,
    progress: 0, lastReport: 0, outputs: [], writers: [], error: null
  };
  jobs.set(job.token, job);
  job.timeout = setTimeout(() => { job.controller.abort(); job.error = "TIMEOUT"; report(job, "failed", {}, true); disposeJob(job); }, 2 * 60 * 60 * 1000);
  report(job, "preparing", { progress: 0 }, true);
  (async () => {
    try {
      if (data.kind === "hls") await runHls(job);
      else if (data.kind === "dash") await runDash(job);
      else {
        const output = await createOutput(job, 0);
        job.writers.push(output);
        const info = await downloadDirect(job, data.url, output, "file");
        const finished = await output.finish(info.mime, info.extension);
        finished.role = "file";
        job.outputs = [finished];
        report(job, "ready", { progress: 1 }, true);
      }
    } catch (error) {
      if (job.disposed) return;
      job.error = job.controller.signal.aborted ? "CANCELED" : errorCode(error, "UNSUPPORTED");
      for (const output of job.writers) { try { await output.dispose(); } catch {} }
      job.writers = [];
      report(job, "failed", { progress: 0 }, true);
      clearTimeout(job.timeout);
      job.ttl = setTimeout(() => disposeJob(job), 5 * 60 * 1000);
      return;
    }
    clearTimeout(job.timeout);
    job.ttl = setTimeout(() => disposeJob(job), OUTPUT_TTL_MS);
  })();
  return job;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "ms-offscreen") return undefined;
  if (sender?.id !== chrome.runtime.id || sender.tab || (sender.url && !sender.url.startsWith(chrome.runtime.getURL("")))) {
    sendResponse({ ok: false });
    return undefined;
  }
  if (message.action === "probe") {
    if (!validateUrl(message.url)) { sendResponse({ ok: false, error: "UNSUPPORTED" }); return undefined; }
    (async () => {
      try {
        let result;
        if (message.kind === "hls") {
          result = await MediaSaverHls.probe(message.url, { request: requestFor(message.pageUrl), pageUrl: message.pageUrl });
        } else if (message.kind === "dash") {
          const text = await readText({ controller: new AbortController(), pageUrl: message.pageUrl, disposed: false }, message.url, 4 * 1024 * 1024);
          result = MediaSaverDash.probe(text, message.url);
        } else {
          throw new Error("UNSUPPORTED");
        }
        sendResponse({ ok: true, result });
      } catch (error) { sendResponse({ ok: false, error: errorCode(error, "UNSUPPORTED") }); }
    })();
    return true;
  }
  if (message.action === "start") {
    if (jobs.size >= MAX_JOBS) { sendResponse({ ok: false, error: "BUSY" }); return undefined; }
    if (jobs.has(message.job?.token)) { sendResponse({ ok: true }); return undefined; }
    startJob(message).then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: errorCode(error, "UNSUPPORTED") }));
    return true;
  }
  const job = jobs.get(message.token);
  if (!job) { sendResponse({ ok: false, error: "NOT_FOUND" }); return undefined; }
  if (message.action === "cancel") {
    job.error = "CANCELED"; job.controller.abort();
    disposeJob(job).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.action === "release") {
    disposeJob(job).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.action === "query") {
    sendResponse({ ok: true, present: true, phase: job.disposed ? "failed" : job.outputs?.length ? "ready" : "downloading",
      received: job.received, total: job.total, progress: job.progress, error: job.error,
      outputs: job.outputs?.map(({ blobUrl, size, mime, extension, role }) => ({ blobUrl, size, mime, extension, role })) });
    return undefined;
  }
  sendResponse({ ok: false });
  return undefined;
});
