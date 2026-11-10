"use strict";

importScripts("lib/common.js");

const C = self.MediaSaverCommon;
const SETTINGS_KEY = "settings";
const JOBS_KEY = "jobs";
const MAX_ITEMS = 300;
const MAX_HISTORY = 60;
const FINISHED = ["completed", "failed", "canceled"];

let settings = null;
let initPromise = null;
const tabCache = new Map();
const tabLoading = new Map();
const tabPersistTimers = new Map();
const badgeTimers = new Map();
const jobCache = new Map();
const probeCache = new Map();
let creatingOffscreen = null;
let pumping = false;
let jobsPersistTimer = null;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function broadcast(message) {
  try { chrome.runtime.sendMessage(message).catch(() => {}); } catch { /* no receiver */ }
}

function tabKey(tabId) { return `tab:${tabId}`; }

async function getTabMap(tabId) {
  if (tabCache.has(tabId)) return tabCache.get(tabId);
  if (tabLoading.has(tabId)) return tabLoading.get(tabId);
  const promise = (async () => {
    let items = [];
    try {
      const key = tabKey(tabId);
      const stored = await chrome.storage.session.get(key);
      items = Array.isArray(stored[key]) ? stored[key] : [];
    } catch { items = []; }
    const map = new Map();
    for (const item of items) {
      if (!item || typeof item.url !== "string" || !C.isHttpUrl(item.url)) continue;
      map.set(item.url, item);
    }
    tabCache.set(tabId, map);
    tabLoading.delete(tabId);
    return map;
  })();
  tabLoading.set(tabId, promise);
  return promise;
}

function persistTab(tabId) {
  clearTimeout(tabPersistTimers.get(tabId));
  tabPersistTimers.set(tabId, setTimeout(async () => {
    tabPersistTimers.delete(tabId);
    const map = tabCache.get(tabId);
    if (!map) return;
    try { await chrome.storage.session.set({ [tabKey(tabId)]: [...map.values()] }); } catch { /* session quota */ }
  }, 250));
}

function updateBadge(tabId) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(async () => {
    badgeTimers.delete(tabId);
    try {
      const map = await getTabMap(tabId);
      const count = [...map.values()].filter(item => visible(item)).length;
      await chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : "" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f6ef7" });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    } catch { /* tab closed */ }
  }), 200);
}

function visible(item) {
  if (!item || !settings) return false;
  if (C.isBlacklisted(item.url, settings.blacklist)) return false;
  if (item.kind === "video" && !settings.detectVideo) return false;
  if (item.kind === "audio" && !settings.detectAudio) return false;
  if (item.kind === "image" && !settings.detectImages) return false;
  if (item.kind === "hls" || item.kind === "dash") {
    if (!settings.detectVideo && !settings.detectAudio) return false;
  }
  if (settings.minSizeMB > 0 && Number(item.size) > 0 && Number(item.size) < settings.minSizeMB * 1024 * 1024) return false;
  return true;
}

function tabItems(map) {
  const order = { hls: 0, dash: 1, video: 2, audio: 3, image: 4 };
  return [...map.values()].filter(visible).sort((left, right) => {
    const kind = (order[left.kind] ?? 9) - (order[right.kind] ?? 9);
    return kind || Number(right.detectedAt || 0) - Number(left.detectedAt || 0);
  });
}

async function clearTab(tabId, removeStorage = true) {
  tabCache.delete(tabId);
  if (removeStorage) { try { await chrome.storage.session.remove(tabKey(tabId)); } catch { /* ignore */ } }
  await updateBadge(tabId);
}

async function addOrUpdate(tabId, candidate) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await ensureInitialized();
  if (!visible(candidate)) return;
  const map = await getTabMap(tabId);
  const existing = map.get(candidate.url);
  if (existing) {
    existing.kind = candidate.kind || existing.kind;
    if (candidate.contentType) existing.contentType = candidate.contentType;
    if (candidate.size) existing.size = candidate.size;
    if (candidate.filenameHint) existing.filenameHint = candidate.filenameHint;
    if (candidate.title && !existing.title) existing.title = candidate.title;
    if (candidate.poster && !existing.poster) existing.poster = candidate.poster;
    if (candidate.frame && !existing.frame) existing.frame = candidate.frame;
    if (candidate.duration && !existing.duration) existing.duration = candidate.duration;
    if (candidate.width && !existing.width) existing.width = candidate.width;
    if (candidate.height && !existing.height) existing.height = candidate.height;
    existing.detectedAt = Math.max(existing.detectedAt || 0, candidate.detectedAt || Date.now());
    if (candidate.source === "dom") existing.source = existing.source || "dom";
  } else {
    if (map.size >= MAX_ITEMS) {
      const oldest = [...map.values()].sort((left, right) => (left.detectedAt || 0) - (right.detectedAt || 0))[0];
      if (oldest) map.delete(oldest.url);
    }
    map.set(candidate.url, {
      id: C.idFor(candidate.url), url: candidate.url, kind: candidate.kind,
      contentType: candidate.contentType || null, size: Number(candidate.size) || 0,
      title: candidate.title || "", poster: candidate.poster || "", frame: candidate.frame || "",
      duration: Number(candidate.duration) || 0, width: Number(candidate.width) || 0,
      height: Number(candidate.height) || 0, source: candidate.source || "network",
      filenameHint: candidate.filenameHint || "", detectedAt: candidate.detectedAt || Date.now()
    });
    updateBadge(tabId);
  }
  persistTab(tabId);
}

function classifyCandidate(url) {
  const media = C.classify(url);
  if (!media || !["hls", "dash", "video", "audio"].includes(media.kind)) return null;
  return media;
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return;
  if (!/^https?:/i.test(details.url)) return;
  const media = classifyCandidate(details.url);
  if (!media) return;
  void addOrUpdate(details.tabId, {
    url: details.url, kind: media.kind, contentType: media.contentType || "",
    size: 0, source: "network", detectedAt: Date.now()
  });
}, { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] });

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  if (!/^https?:/i.test(details.url)) return;
  let contentType = "", size = 0, disposition = "";
  for (const header of details.responseHeaders || []) {
    const name = String(header.name || "").toLowerCase();
    if (name === "content-type") contentType = String(header.value || "").split(";")[0].trim().toLowerCase();
    else if (name === "content-length") size = Number(header.value) || 0;
    else if (name === "content-disposition") disposition = String(header.value || "");
  }
  if (!contentType && !size) return;
  const media = C.classify(details.url, contentType);
  if (!media || !["hls", "dash", "video", "audio"].includes(media.kind)) return;
  void addOrUpdate(details.tabId, {
    url: details.url, kind: media.kind, contentType: contentType || media.contentType || "",
    size, filenameHint: disposition ? C.parseContentDisposition(disposition) : "",
    source: "network", detectedAt: Date.now()
  });
}, { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] }, ["responseHeaders"]);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") void clearTab(tabId);
  if (changeInfo.status === "complete") updateBadge(tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabCache.delete(tabId);
  try { chrome.storage.session.remove(tabKey(tabId)); } catch { /* ignore */ }
});

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: C.DEFAULT_SETTINGS });
  await ensureInitialized();
});

chrome.runtime.onStartup.addListener(() => { initPromise = null; settings = null; void ensureInitialized(); });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "ms-pump") void pump();
});

function ensureInitialized() {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

async function initialize() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = C.normalizeSettings(stored[SETTINGS_KEY]);
  await restoreJobs();
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) if (tab.id != null) updateBadge(tab.id);
  } catch { /* ignore */ }
}

async function ensureOffscreen() {
  // chrome.offscreen.hasDocument() is only available in Chrome 150+. The
  // manifest supports Chrome 116+, so use runtime.getContexts() instead.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length > 0) return;
  } else if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
    return;
  }
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["BLOBS"],
    justification: "HLS/DASHのセグメントを結合し、保存用ファイルを生成するため"
  }).catch(error => {
    if (!String(error?.message || error).includes("single offscreen")) throw error;
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function sendOffscreen(message) {
  try {
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ ...message, target: "ms-offscreen" });
  } catch (error) {
    return { ok: false, error: String(error?.message || "OFFSCREEN_FAILED") };
  }
}

async function scanTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, error: "TAB_NOT_FOUND" }; }
  const pageUrl = /^https?:/i.test(tab.url || "") ? tab.url : "";
  let result = null, restricted = false;
  if (pageUrl) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
      result = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: "ms:scan" }, { frameId: 0 }),
        delay(2500).then(() => null)
      ]);
    } catch { restricted = true; }
  } else restricted = true;
  if (result?.ok && pageUrl) {
    for (const item of result.items || []) {
      if (!item || typeof item.url !== "string" || !C.isHttpUrl(item.url)) continue;
      const media = C.classify(item.url);
      const kind = media?.kind || (["video", "audio", "image"].includes(item.kind) ? item.kind : "");
      if (!kind || kind === "image" && !settings.detectImages) continue;
      if ((kind === "video" || kind === "hls" || kind === "dash") && !settings.detectVideo) continue;
      if (kind === "audio" && !settings.detectAudio) continue;
      await addOrUpdate(tabId, {
        url: item.url, kind, contentType: media?.contentType || "",
        size: 0, title: item.title || "", poster: item.poster || "", frame: item.frame || "",
        duration: item.duration || 0, width: item.width || 0, height: item.height || 0,
        source: "dom", detectedAt: Date.now()
      });
    }
  }
  const map = await getTabMap(tabId);
  return {
    ok: true, pageUrl: pageUrl || tab.url || "", pageTitle: result?.pageTitle || tab.title || "",
    items: tabItems(map), blobVideos: result?.blobVideos || 0, restricted
  };
}

async function listTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, error: "TAB_NOT_FOUND" }; }
  const map = await getTabMap(tabId);
  return {
    ok: true, pageUrl: /^https?:/i.test(tab.url || "") ? tab.url : "", pageTitle: tab.title || "",
    items: tabItems(map)
  };
}

async function probeMedia(tabId, url, kind) {
  if (!["hls", "dash"].includes(kind) || !C.isHttpUrl(url)) return { ok: false, error: "UNSUPPORTED" };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = tab && /^https?:/i.test(tab.url || "") ? tab.url : "";
  if (!C.isSafeTarget(url, pageUrl)) return { ok: false, error: "UNSAFE_TARGET" };
  const cached = probeCache.get(url);
  if (cached && cached.expires > Date.now()) return { ok: true, result: cached.result };
  const response = await sendOffscreen({ action: "probe", url, kind, pageUrl });
  if (!response?.ok) return { ok: false, error: response?.error || "PROBE_FAILED" };
  probeCache.set(url, { result: response.result, expires: Date.now() + 5 * 60 * 1000 });
  if (probeCache.size > 100) probeCache.delete(probeCache.keys().next().value);
  return { ok: true, result: response.result };
}

async function restoreJobs() {
  let stored = [];
  try { stored = (await chrome.storage.session.get(JOBS_KEY))[JOBS_KEY] || []; } catch { stored = []; }
  if (!Array.isArray(stored)) stored = [];
  const now = Date.now();
  for (const job of stored) {
    if (!job || typeof job.id !== "string" || typeof job.token !== "string") continue;
    if (FINISHED.includes(job.state) && now - (job.createdAt || 0) > 24 * 60 * 60 * 1000) continue;
    jobCache.set(job.id, job);
  }
  for (const job of jobCache.values()) {
    if (job.state === "downloading" && Array.isArray(job.downloads)) {
      for (const entry of job.downloads) {
        try {
          const [download] = await chrome.downloads.search({ id: entry.id });
          if (!download) { entry.state = "failed"; job.error = "INTERRUPTED"; continue; }
          entry.state = download.state === "complete" ? "complete" : download.state === "interrupted" ? "failed" : "downloading";
          if (download.state === "interrupted" && !job.error) job.error = download.error || "DOWNLOAD_FAILED";
        } catch {}
      }
      // Outputs that were never started cannot finish, so the job fails like one with a failed output.
      if (job.downloads.length < (Number(job.expectedDownloads) || job.downloads.length)) {
        job.error = "INTERRUPTED";
        await failJob(job);
      } else await settleDownloads(job);
    } else if (job.state === "preparing") {
      const response = await sendOffscreen({ action: "query", token: job.token });
      if (!response?.ok || !response.present) { job.state = "failed"; job.error = "INTERRUPTED"; }
      else if (response.phase === "failed") {
        // The failure was reported while this worker was gone, so nobody released the job.
        job.state = "failed"; job.error = response.error || "PROCESSING_FAILED";
        await releaseJob(job);
      } else if (response.phase === "ready" && Array.isArray(response.outputs)) {
        job.state = "downloading";
        await beginDownloads(job, response.outputs);
      }
    }
  }
  schedulePersistJobs();
  if (jobCache.size) void pump();
}

// Unfinished jobs are always kept, so a restarted worker can resume them; only finished jobs are
// limited, to the MAX_HISTORY newest.
function trimHistory() {
  const finished = [...jobCache.values()].filter(job => FINISHED.includes(job.state))
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
  for (const job of finished.slice(MAX_HISTORY)) jobCache.delete(job.id);
}

function schedulePersistJobs() {
  clearTimeout(jobsPersistTimer);
  jobsPersistTimer = setTimeout(async () => {
    jobsPersistTimer = null;
    trimHistory();
    try { await chrome.storage.session.set({ [JOBS_KEY]: [...jobCache.values()] }); } catch { /* quota */ }
  }, 300);
}

function publicJobs() {
  return [...jobCache.values()].sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0)).map(job => ({
    id: job.id, token: job.token, kind: job.kind, title: job.title, pageUrl: job.pageUrl,
    state: job.state, progress: job.progress || 0, received: job.received || 0, total: job.total || 0,
    segments: job.segments || 0, completedSegments: job.completed || 0, error: job.error || null,
    createdAt: job.createdAt, quality: job.quality?.label || "",
    downloads: (job.downloads || []).map(entry => ({ id: entry.id, state: entry.state }))
  }));
}

function pushJobs() {
  broadcast({ type: "ms:jobs-updated", jobs: publicJobs() });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    await ensureInitialized();
    const active = [...jobCache.values()].filter(job => ["preparing", "downloading"].includes(job.state));
    let slots = Math.max(0, settings.concurrency - active.length);
    const queued = [...jobCache.values()].filter(job => job.state === "queued").sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
    for (const job of queued) {
      if (slots <= 0) break;
      // Starting an earlier job awaits the offscreen document, and this one may have been cancelled meanwhile.
      if (job.state !== "queued") continue;
      slots--;
      job.state = "preparing";
      job.progress = 0;
      schedulePersistJobs();
      pushJobs();
      const response = await sendOffscreen({
        action: "start",
        job: {
          token: job.token, kind: job.kind, url: job.url, pageUrl: job.pageUrl,
          quality: job.quality || null
        }
      });
      if (!response?.ok) {
        job.state = "failed";
        job.error = response?.error || "START_FAILED";
        pushJobs();
      }
    }
    if ([...jobCache.values()].some(job => job.state === "queued")) {
      chrome.alarms.create("ms-pump", { periodInMinutes: 1 });
    } else {
      chrome.alarms.clear("ms-pump");
    }
    schedulePersistJobs();
  } finally { pumping = false; }
}

async function beginDownloads(job, outputs) {
  if (job.state === "canceled" || job.downloads?.length) return;
  job.state = "downloading";
  job.progress = 0.9;
  job.outputs = outputs;
  job.downloads = [];
  job.expectedDownloads = outputs.length;
  for (let index = 0; index < outputs.length; index++) {
    const output = outputs[index];
    if (!output?.blobUrl || !String(output.blobUrl).startsWith("blob:")) {
      job.state = "failed"; job.error = "INVALID_OUTPUT"; break;
    }
    const extension = C.sanitizeSegment(output.extension || "mp4", "mp4").toLowerCase();
    const site = C.hostOf(job.pageUrl || job.url) || "media";
    const baseTitle = job.title || C.titleFromUrl(job.url);
    const suffix = output.role === "audio" ? " (音声)" : outputs.length > 1 ? ` (${index + 1})` : "";
    const filename = C.buildFilename(settings, {
      title: baseTitle + suffix, site, quality: job.quality?.label || "", index: index + 1
    }, extension);
    try {
      const downloadId = await chrome.downloads.download({
        url: output.blobUrl, filename, conflictAction: "uniquify", saveAs: false
      });
      // cancelJob may have run while Chrome was starting this download, and it only knew the earlier IDs.
      if (job.state === "canceled") {
        try { await chrome.downloads.cancel(downloadId); } catch {}
        break;
      }
      job.downloads.push({ id: downloadId, state: "downloading", size: output.size || 0, filename });
    } catch (error) {
      job.state = "failed";
      job.error = "DOWNLOAD_FAILED";
      break;
    }
  }
  if (job.state === "downloading" && job.downloads.length === 0) {
    job.state = "failed"; job.error = "NO_OUTPUT";
  }
  if (job.state === "failed") await failJob(job);
  pushJobs();
  schedulePersistJobs();
}

// Used both for live download events and after a worker restart: every output saved completes the job,
// and one failed output fails it.
async function settleDownloads(job) {
  const { downloads } = job;
  if (downloads.length && downloads.length >= (job.expectedDownloads || downloads.length) && downloads.every(entry => entry.state === "complete")) {
    job.state = "completed"; job.progress = 1;
    await releaseJob(job);
  } else if (downloads.some(entry => entry.state === "failed")) await failJob(job);
}

// Every way a downloading job fails ends here: outputs still downloading are stopped and the files freed.
async function failJob(job) {
  job.state = "failed";
  for (const entry of job.downloads) if (entry.state === "downloading") { try { await chrome.downloads.cancel(entry.id); } catch {} }
  await releaseJob(job);
}

async function releaseJob(job) {
  if (!job?.token || job.released) return;
  job.released = true;
  await sendOffscreen({ action: "release", token: job.token });
}

async function jobForDownload(downloadId) {
  for (const job of jobCache.values()) {
    if ((job.downloads || []).some(entry => entry.id === downloadId)) return job;
  }
  return null;
}

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta?.id) return;
  await ensureInitialized();
  const job = await jobForDownload(delta.id);
  if (!job || job.state !== "downloading") return;
  const entry = job.downloads.find(item => item.id === delta.id);
  if (!entry) return;
  if (delta.state?.current === "complete") entry.state = "complete";
  else if (delta.state?.current === "interrupted") {
    entry.state = "failed";
    job.error = delta.error?.current || "DOWNLOAD_FAILED";
  }
  if (delta.bytesReceived?.current != null) job.received = Math.max(job.received || 0, delta.bytesReceived.current);
  if (delta.totalBytes?.current) job.total = delta.totalBytes.current;
  if (delta.bytesReceived?.current != null || delta.totalBytes?.current) {
    const ratio = job.total > 0 ? Math.min(1, job.received / job.total) : 0;
    job.progress = Math.max(job.progress || 0, 0.9 + ratio * 0.1);
  }
  await settleDownloads(job);
  pushJobs();
  schedulePersistJobs();
  if (job.state === "completed" || job.state === "failed") void pump();
});

function startJobRecord(tabId, item, tab, pageTitle) {
  for (const existing of jobCache.values()) {
    if (existing.tabId === tabId && existing.url === item.url && ["queued", "preparing", "downloading"].includes(existing.state)) return existing;
  }
  const kind = ["hls", "dash", "video", "audio", "image"].includes(item.kind) ? item.kind : "video";
  const quality = item.quality && typeof item.quality === "object" ? {
    url: typeof item.quality.url === "string" && C.isHttpUrl(item.quality.url) ? item.quality.url : "",
    bandwidth: Number(item.quality.bandwidth) || 0,
    height: Number(item.quality.height) || 0,
    label: String(item.quality.label || "").slice(0, 40)
  } : null;
  return {
    id: crypto.randomUUID(), token: crypto.randomUUID(), tabId, kind, url: item.url,
    quality, pageUrl: tab.url, title: String(item.title || (kind === "hls" || kind === "dash" ? pageTitle : "") || C.titleFromUrl(item.url)).slice(0, 300),
    pageTitle: String(pageTitle || "").slice(0, 300), state: "queued", progress: 0,
    received: 0, total: 0, segments: 0, completed: 0, downloads: [], outputs: [],
    error: null, createdAt: Date.now()
  };
}

async function startJobs(tabId, items) {
  await ensureInitialized();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/i.test(tab.url || "")) return { ok: false, error: "PAGE_UNSUPPORTED" };
  const pageUrl = tab.url;
  const pageTitle = tab.title || "";
  const list = Array.isArray(items) ? items : [];
  // The popup can select every detected item, so a batch holds up to MAX_ITEMS. A larger one is refused
  // whole, which leaves the popup's selection in place.
  if (list.length > MAX_ITEMS) return { ok: false, error: "TOO_MANY_ITEMS" };
  const created = [];
  for (const item of list) {
    if (!item || !C.isHttpUrl(item.url) || !C.isSafeTarget(item.url, pageUrl)) continue;
    const job = startJobRecord(tabId, item, tab, pageTitle);
    if (jobCache.has(job.id)) { created.push(job.id); continue; }
    jobCache.set(job.id, job);
    created.push(job.id);
  }
  if (!created.length) return { ok: false, error: "NO_VALID_ITEMS" };
  schedulePersistJobs();
  pushJobs();
  void pump();
  return { ok: true, jobs: created };
}

async function cancelJob(jobId) {
  const job = jobCache.get(jobId);
  if (!job) return { ok: false, error: "NOT_FOUND" };
  if (job.state === "completed" || job.state === "failed" || job.state === "canceled") return { ok: true };
  job.state = "canceled";
  if (job.downloads?.length) {
    for (const entry of job.downloads) { try { await chrome.downloads.cancel(entry.id); } catch {} }
  }
  await sendOffscreen({ action: "cancel", token: job.token });
  await releaseJob(job);
  pushJobs(); schedulePersistJobs(); void pump();
  return { ok: true };
}

async function updateBlacklist(domain, add) {
  const normalized = String(domain || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/^\.+/, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) return { ok: false, error: "INVALID_DOMAIN" };
  const blacklist = new Set(settings.blacklist || []);
  if (add) blacklist.add(normalized); else blacklist.delete(normalized);
  settings = C.normalizeSettings({ ...settings, blacklist: [...blacklist] });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  for (const [tabId, map] of tabCache) {
    let changed = false;
    for (const [url, item] of map) if (!visible(item)) { map.delete(url); changed = true; }
    if (changed) { persistTab(tabId); updateBadge(tabId); }
  }
  broadcast({ type: "ms:settings-updated", settings });
  return { ok: true, settings };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("ms:")) return undefined;
  if (message.type === "ms:job-progress") {
    if (sender?.id !== chrome.runtime.id || !String(sender.url || "").includes("/offscreen.html")) return undefined;
    void (async () => {
      await ensureInitialized();
      let job = null;
      for (const candidate of jobCache.values()) if (candidate.token === message.token) { job = candidate; break; }
      if (!job) { sendResponse({ ok: false }); return; }
      if (job.state === "canceled") { sendResponse({ ok: false, active: false }); return; }
      job.received = Number(message.received) || job.received || 0;
      job.total = Number(message.total) || job.total || 0;
      job.segments = Number(message.segments) || job.segments || 0;
      job.completed = Number(message.completed) || job.completed || 0;
      if (message.phase === "preparing") { job.state = "preparing"; job.progress = 0; }
      else if (message.phase === "downloading") {
        if (job.state === "downloading" || job.state === "completed") {
          sendResponse({ ok: true, active: true }); return;
        }
        job.state = "preparing";
        if (job.total > 0) job.progress = Math.min(0.9, job.received / job.total * 0.9);
        else if (job.segments > 0) job.progress = Math.min(0.9, job.completed / job.segments * 0.9);
        else job.progress = Math.max(job.progress || 0, 0.05);
      } else if (message.phase === "ready") {
        if (job.downloads?.length) { sendResponse({ ok: true, active: true }); return; }
        job.progress = 0.9;
        job.state = "downloading";
        await beginDownloads(job, Array.isArray(message.outputs) ? message.outputs : []);
      } else if (message.phase === "failed") {
        job.state = "failed"; job.error = message.error || "PROCESSING_FAILED";
        await releaseJob(job);
      }
      pushJobs(); schedulePersistJobs();
      sendResponse({ ok: true, active: true });
    })();
    return true;
  }
  if (sender?.id !== chrome.runtime.id) return undefined;
  void (async () => {
    try {
      await ensureInitialized();
      if (message.type === "ms:list") {
        sendResponse(await listTab(Number(message.tabId)));
      } else if (message.type === "ms:scan") {
        sendResponse(await scanTab(Number(message.tabId)));
      } else if (message.type === "ms:probe") {
        sendResponse(await probeMedia(Number(message.tabId), String(message.url || ""), String(message.kind || "")));
      } else if (message.type === "ms:start") {
        sendResponse(await startJobs(Number(message.tabId), message.items));
      } else if (message.type === "ms:jobs") {
        sendResponse({ ok: true, jobs: publicJobs() });
      } else if (message.type === "ms:cancel") {
        sendResponse(await cancelJob(String(message.jobId || "")));
      } else if (message.type === "ms:clear-jobs") {
        for (const [id, job] of jobCache) {
          if (FINISHED.includes(job.state)) jobCache.delete(id);
        }
        schedulePersistJobs(); pushJobs(); sendResponse({ ok: true });
      } else if (message.type === "ms:show") {
        const id = Number(message.downloadId);
        if (!Number.isInteger(id)) sendResponse({ ok: false });
        else { await chrome.downloads.show(id); sendResponse({ ok: true }); }
      } else if (message.type === "ms:settings") {
        sendResponse({ ok: true, settings });
      } else if (message.type === "ms:set-settings") {
        settings = C.normalizeSettings(message.settings);
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) if (tab.id != null) updateBadge(tab.id);
        broadcast({ type: "ms:settings-updated", settings });
        sendResponse({ ok: true, settings });
      } else if (message.type === "ms:blacklist") {
        sendResponse(await updateBlacklist(message.domain, message.add !== false));
      } else if (message.type === "ms:remove-item") {
        const url = String(message.url || "");
        if (!C.isHttpUrl(url)) { sendResponse({ ok: false }); return; }
        const map = await getTabMap(Number(message.tabId));
        map.delete(url); persistTab(Number(message.tabId)); updateBadge(Number(message.tabId));
        sendResponse({ ok: true });
      } else if (message.type === "ms:clear-tab") {
        await clearTab(Number(message.tabId)); sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || "INTERNAL_ERROR") });
    }
  })();
  return true;
});

void ensureInitialized();
