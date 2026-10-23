"use strict";

const hlsJobs = new Map();
const MAX_BUFFER_BYTES = 512 * 1024 * 1024;
let bufferedBytes = 0;
let hlsDirectoryPromise = null;

function hlsDirectory() {
  if (!hlsDirectoryPromise) hlsDirectoryPromise = (async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("page-media-hls-mp4-v1", {create: true});
    // This directory contains only this extension's transient MP4 output.
    for await (const name of directory.keys()) {
      if (/^[a-f0-9-]{36}\.mp4$/i.test(name)) await directory.removeEntry(name);
    }
    return directory;
  })().catch(() => { hlsDirectoryPromise = null; throw new Error("HLS_STORAGE_FAILED"); });
  return hlsDirectoryPromise;
}

async function createHlsOutput(job) {
  const directory = await hlsDirectory();
  if (job.disposed) throw new Error("HLS_CANCELED");
  const name = job.token + ".mp4";
  let writer;
  try {
    const handle = await directory.getFileHandle(name, {create: true});
    writer = await handle.createWritable();
    let closed = false;
    return {
      async write(data, position) {
        if (job.disposed) throw new Error("HLS_CANCELED");
        try { await writer.write(position == null ? data : {type: "write", position, data}); }
        catch { throw new Error("HLS_STORAGE_FAILED"); }
      },
      async finish() {
        try {
          await writer.close(); closed = true;
          return new Blob([await handle.getFile()], {type: "video/mp4"});
        } catch { throw new Error("HLS_STORAGE_FAILED"); }
      },
      async dispose() {
        if (!closed) { try { await writer.abort(); } catch {} closed = true; }
        try { await directory.removeEntry(name); } catch {}
      },
    };
  } catch {
    try { await writer?.abort(); } catch {}
    try { await directory.removeEntry(name); } catch {}
    throw new Error("HLS_STORAGE_FAILED");
  }
}

function disposeHlsJob(job) {
  if (job.disposed) return job.cleanup;
  job.disposed = true;
  job.controller.abort();
  clearInterval(job.heartbeat);
  clearTimeout(job.timeout);
  if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
  bufferedBytes -= job.bufferBytes;
  job.bufferBytes = 0;
  hlsJobs.delete(job.token);
  job.cleanup = job.outputReady ? job.outputReady.then(output => output.dispose()).catch(() => {}) : Promise.resolve();
  return job.cleanup;
}

async function reportHlsJob(job) {
  if (job.disposed || job.reporting) return;
  job.reporting = true;
  try {
    const reply = await chrome.runtime.sendMessage({type: "page-media-bulk:hls-update", target: "worker",
      token: job.token, phase: job.phase, bytes: job.bytes, completed: job.completed, total: job.total,
      blobUrl: job.blobUrl, size: job.size, format: "mp4", mp4Version: 2, error: job.error});
    if (reply?.ok && !reply.active) await disposeHlsJob(job);
  } catch { /* A restarting worker will receive the next heartbeat. */ }
  finally { job.reporting = false; }
}

async function prepareHlsJob(job, message) {
  try {
    job.outputReady = createHlsOutput(job);
    const output = await job.outputReady;
    if (job.disposed) { await output.dispose(); return; }
    const blob = await PageMediaHls.assemble(message.url, {signal: job.controller.signal, output,
      reserve(bytes) {
        if (job.disposed) { if (bytes < 0) return; throw new Error("HLS_CANCELED"); }
        if (!Number.isSafeInteger(bytes) || job.bufferBytes + bytes < 0) throw new Error("HLS_RESOURCE_LIMIT");
        if (bufferedBytes + bytes > MAX_BUFFER_BYTES) throw new Error("HLS_RESOURCE_LIMIT");
        bufferedBytes += bytes; job.bufferBytes += bytes;
      },
      async progress({bytes, completed, total}) {
        job.bytes = bytes; job.completed = completed; job.total = total;
        if (Date.now() - job.lastReport >= 1000) {
          job.lastReport = Date.now(); await reportHlsJob(job);
        }
      }});
    if (job.disposed) return;
    job.blobUrl = URL.createObjectURL(blob); job.size = blob.size; job.phase = "ready";
    clearTimeout(job.timeout);
  } catch (error) {
    if (job.disposed) return;
    bufferedBytes -= job.bufferBytes; job.bufferBytes = 0; job.bytes = 0; job.phase = "failed";
    if (job.outputReady) { try { await (await job.outputReady).dispose(); } catch {} }
    job.error = job.timedOut ? "HLS_TIMEOUT" : PageMediaHls.ERROR_CODES.includes(error?.message) ? error.message : "HLS_FETCH_FAILED";
    clearTimeout(job.timeout);
  }
  await reportHlsJob(job);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return undefined;
  if (sender?.id !== chrome.runtime.id || sender.tab || (sender.url && !sender.url.startsWith(chrome.runtime.getURL("")))) {
    sendResponse({ok: false}); return undefined;
  }
  const token = typeof message.token === "string" ? message.token : "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) { sendResponse({ok: false}); return undefined; }
  const existing = hlsJobs.get(token);
  if (message.action === "cancel") {
    void (existing ? disposeHlsJob(existing) : Promise.resolve()).then(() => sendResponse({ok: true}));
    return true;
  }
  if (message.action === "query") {
    sendResponse(existing ? {ok: true, present: true, phase: existing.phase, blobUrl: existing.blobUrl,
      size: existing.size, format: "mp4", mp4Version: 2, error: existing.error} : {ok: true, present: false}); return undefined;
  }
  if (message.action !== "start" || !PageMediaBulkCore.isHostedHlsUrl(message.url, message.pageUrl)) {
    sendResponse({ok: false}); return undefined;
  }
  if (existing) { sendResponse({ok: true}); return undefined; }
  if (hlsJobs.size >= 4) { sendResponse({ok: false, error: "HLS_RESOURCE_LIMIT"}); return undefined; }
  const job = {token, controller: new AbortController(), bytes: 0, bufferBytes: 0, completed: 0, total: 0,
    phase: "collecting", lastReport: 0, reporting: false, disposed: false};
  hlsJobs.set(token, job);
  job.heartbeat = setInterval(() => { void reportHlsJob(job); }, 5000);
  job.timeout = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, 60 * 60 * 1000);
  sendResponse({ok: true});
  void prepareHlsJob(job, message);
  return undefined;
});
