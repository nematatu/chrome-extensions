"use strict";

importScripts("core.js", "collector.js");

const core = globalThis.GofileBulkCore;
const STORAGE_INDEX_KEY = "gofileBulkDownloadIndexV2";
const STORAGE_PENDING_KEY = "gofileBulkDownloadPendingV2";
const STORAGE_PREFIX = "gofileBulkDownloadV2:";
const STORAGE_WRITE_CHUNK_SIZE = 200;
const MAX_PARALLEL_DOWNLOADS = 4;
const MAX_START_ATTEMPTS_PER_PUMP = 16;
const MAX_VIDEOS = 10000;
const MAX_ACTIVE_BATCHES = 8;
const MAX_BATCHES = 4;
const MAX_PUBLIC_ROWS = 100;
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;

let operationQueue = Promise.resolve();
let stateCache = null;
let persistedBatchIds = new Set();
let persistedCounts = new Map();
let persistedSignatures = new Map();

function runExclusive(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

function emptyState() {
  return { version: 2, batches: {} };
}

function batchStorageKey(batchId) {
  return `${STORAGE_PREFIX}batch:${batchId}`;
}

function itemStorageKey(batchId, index) {
  return `${STORAGE_PREFIX}item:${batchId}:${index}`;
}

function skippedStorageKey(batchId, index) {
  return `${STORAGE_PREFIX}skip:${batchId}:${index}`;
}

function batchRecord(batch) {
  return {
    version: 2,
    id: batch.id,
    tabId: batch.tabId,
    incognito: batch.incognito === true,
    pageUrl: batch.pageUrl,
    folderId: batch.folderId,
    folderName: batch.folderName,
    scannedItems: batch.scannedItems,
    totalPages: batch.totalPages,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    lastStartedAt: Number(batch.lastStartedAt) || 0,
    status: batch.status,
    cancelRequested: batch.cancelRequested === true,
    retryRequested: batch.retryRequested === true,
    itemCount: batch.items.length,
    skippedCount: batch.skipped.length,
  };
}

function recordSignature(record) {
  return JSON.stringify(record);
}

async function getStorageValues(keys) {
  const output = {};
  for (let index = 0; index < keys.length; index += STORAGE_WRITE_CHUNK_SIZE) {
    Object.assign(output, await chrome.storage.local.get(keys.slice(index, index + STORAGE_WRITE_CHUNK_SIZE)));
  }
  return output;
}

function storageDescriptor(batchId, counts) {
  return {
    id: batchId,
    itemCount: Math.min(MAX_VIDEOS, Math.max(0, Number(counts?.itemCount) || 0)),
    skippedCount: Math.min(MAX_VIDEOS, Math.max(0, Number(counts?.skippedCount) || 0)),
  };
}

function descriptorStorageKeys(descriptor) {
  const keys = [batchStorageKey(descriptor.id)];
  for (let index = 0; index < descriptor.itemCount; index += 1) keys.push(itemStorageKey(descriptor.id, index));
  for (let index = 0; index < descriptor.skippedCount; index += 1) keys.push(skippedStorageKey(descriptor.id, index));
  return keys;
}

async function recoverPendingStorage(pending, indexRecord) {
  if (!pending || pending.version !== 2) return;
  const indexedIds = new Set(Array.isArray(indexRecord?.batchIds) ? indexRecord.batchIds : []);
  const obsolete = [];

  for (const descriptor of Array.isArray(pending.additions) ? pending.additions : []) {
    if (descriptor?.id && !indexedIds.has(descriptor.id)) obsolete.push(...descriptorStorageKeys(descriptor));
  }
  for (const descriptor of Array.isArray(pending.removals) ? pending.removals : []) {
    if (descriptor?.id && !indexedIds.has(descriptor.id)) obsolete.push(...descriptorStorageKeys(descriptor));
  }

  await removeStorageKeys(obsolete);
  await chrome.storage.local.remove(STORAGE_PENDING_KEY);
}

async function readState() {
  if (stateCache) return stateCache;

  const indexStored = await chrome.storage.local.get([STORAGE_INDEX_KEY, STORAGE_PENDING_KEY]);
  const indexRecord = indexStored?.[STORAGE_INDEX_KEY];
  await recoverPendingStorage(indexStored?.[STORAGE_PENDING_KEY], indexRecord);
  const batchIds = indexRecord?.version === 2 && Array.isArray(indexRecord.batchIds)
    ? indexRecord.batchIds.filter((id) => typeof id === "string")
    : [];
  const state = emptyState();
  const batchValues = await getStorageValues(batchIds.map(batchStorageKey));

  for (const batchId of batchIds) {
    const storedBatch = batchValues[batchStorageKey(batchId)];
    if (!storedBatch || storedBatch.version !== 2 || storedBatch.id !== batchId) continue;
    const itemCount = Math.min(MAX_VIDEOS, Math.max(0, Number(storedBatch.itemCount) || 0));
    const skippedCount = Math.min(MAX_VIDEOS, Math.max(0, Number(storedBatch.skippedCount) || 0));
    const recordKeys = [];
    for (let index = 0; index < itemCount; index += 1) recordKeys.push(itemStorageKey(batchId, index));
    for (let index = 0; index < skippedCount; index += 1) recordKeys.push(skippedStorageKey(batchId, index));
    const values = await getStorageValues(recordKeys);
    const items = [];
    const skipped = [];

    for (let index = 0; index < itemCount; index += 1) {
      const key = itemStorageKey(batchId, index);
      const item = values[key];
      if (item && typeof item === "object") items.push(item);
      persistedSignatures.set(key, recordSignature(item));
    }
    for (let index = 0; index < skippedCount; index += 1) {
      const key = skippedStorageKey(batchId, index);
      const item = values[key];
      if (item && typeof item === "object") skipped.push(item);
      persistedSignatures.set(key, recordSignature(item));
    }

    if (items.length !== itemCount || skipped.length !== skippedCount) continue;
    const batch = { ...storedBatch, items, skipped };
    delete batch.version;
    delete batch.itemCount;
    delete batch.skippedCount;
    state.batches[batchId] = batch;
    const batchKey = batchStorageKey(batchId);
    persistedSignatures.set(batchKey, recordSignature(storedBatch));
    persistedCounts.set(batchId, { itemCount, skippedCount });
  }

  persistedBatchIds = new Set(Object.keys(state.batches));
  stateCache = state;
  return state;
}

async function setStorageEntries(entries) {
  for (let index = 0; index < entries.length; index += STORAGE_WRITE_CHUNK_SIZE) {
    const chunk = entries.slice(index, index + STORAGE_WRITE_CHUNK_SIZE);
    const values = Object.fromEntries(chunk.map(({ key, value }) => [key, value]));
    await chrome.storage.local.set(values);
    for (const { key, signature } of chunk) persistedSignatures.set(key, signature);
  }
}

async function removeStorageKeys(keys) {
  if (typeof chrome.storage.local.remove !== "function") return;
  for (let index = 0; index < keys.length; index += STORAGE_WRITE_CHUNK_SIZE) {
    await chrome.storage.local.remove(keys.slice(index, index + STORAGE_WRITE_CHUNK_SIZE));
  }
}

async function writeState(state, scope = null) {
  const currentIds = Object.keys(state.batches);
  const currentSet = new Set(currentIds);
  const addedIds = currentIds.filter((id) => !persistedBatchIds.has(id));
  const removedIds = [...persistedBatchIds].filter((id) => !currentSet.has(id));
  const entries = [];

  try {
    const pending = addedIds.length > 0 || removedIds.length > 0
      ? {
          version: 2,
          additions: addedIds.map((id) => storageDescriptor(id, {
            itemCount: state.batches[id]?.items?.length,
            skippedCount: state.batches[id]?.skipped?.length,
          })),
          removals: removedIds.map((id) => storageDescriptor(id, persistedCounts.get(id))),
        }
      : null;
    if (pending) await chrome.storage.local.set({ [STORAGE_PENDING_KEY]: pending });

    const scopedBatches = scope
      ? [...new Set(Array.isArray(scope.batches) ? scope.batches : [])]
      : Object.values(state.batches);
    const records = [];
    for (const batch of scopedBatches) {
      if (batch && state.batches[batch.id] === batch) {
        records.push({ key: batchStorageKey(batch.id), value: batchRecord(batch) });
      }
    }

    if (scope) {
      for (const entry of Array.isArray(scope.items) ? scope.items : []) {
        const index = entry?.batch?.items?.indexOf(entry.item);
        if (index >= 0) records.push({ key: itemStorageKey(entry.batch.id, index), value: entry.item });
      }
      for (const entry of Array.isArray(scope.skipped) ? scope.skipped : []) {
        const index = entry?.batch?.skipped?.indexOf(entry.item);
        if (index >= 0) records.push({ key: skippedStorageKey(entry.batch.id, index), value: entry.item });
      }
    } else {
      for (const batch of Object.values(state.batches)) {
        records.push(
          ...batch.items.map((item, index) => ({ key: itemStorageKey(batch.id, index), value: item })),
          ...batch.skipped.map((item, index) => ({ key: skippedStorageKey(batch.id, index), value: item })),
        );
      }
    }

    const uniqueRecords = new Map(records.filter((record) => record?.key).map((record) => [record.key, record]));
    for (const record of uniqueRecords.values()) {
      const signature = recordSignature(record.value);
      if (persistedSignatures.get(record.key) !== signature) entries.push({ ...record, signature });
    }

    await setStorageEntries(entries);
    await chrome.storage.local.set({
      [STORAGE_INDEX_KEY]: { version: 2, batchIds: currentIds },
    });

    const obsoleteKeys = [];
    for (const batchId of removedIds) {
      const counts = persistedCounts.get(batchId) || { itemCount: 0, skippedCount: 0 };
      obsoleteKeys.push(batchStorageKey(batchId));
      for (let index = 0; index < counts.itemCount; index += 1) obsoleteKeys.push(itemStorageKey(batchId, index));
      for (let index = 0; index < counts.skippedCount; index += 1) obsoleteKeys.push(skippedStorageKey(batchId, index));
    }
    await removeStorageKeys(obsoleteKeys);
    if (pending) await chrome.storage.local.remove(STORAGE_PENDING_KEY);

    for (const key of obsoleteKeys) persistedSignatures.delete(key);
    for (const batchId of removedIds) persistedCounts.delete(batchId);
    for (const batch of Object.values(state.batches)) {
      persistedCounts.set(batch.id, { itemCount: batch.items.length, skippedCount: batch.skipped.length });
    }
    persistedBatchIds = currentSet;
    stateCache = state;
  } catch (error) {
    stateCache = null;
    persistedBatchIds = new Set();
    persistedCounts = new Map();
    persistedSignatures = new Map();
    throw error;
  }
}

function senderUrl(sender) {
  return sender?.url || sender?.tab?.url || "";
}

function isTrustedSender(sender, requireSharePage) {
  if (!sender?.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return false;
  try {
    const url = new URL(senderUrl(sender));
    if (url.origin !== "https://gofile.io") return false;
    return !requireSharePage || core.isGofilePageUrl(url.href);
  } catch {
    return false;
  }
}

function safeSkippedItems(input) {
  if (!Array.isArray(input)) return [];
  const output = [];
  const seen = new Set();
  const allowedReasons = new Set(["frozen", "overloaded", "missing-link", "unsafe-link", "invalid-metadata"]);

  for (const item of input.slice(0, MAX_VIDEOS)) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.slice(0, 160) : "";
    if (!id || seen.has(id)) continue;
    const sizeValue = Number(item.size);
    output.push({
      id,
      name: typeof item.name === "string" && item.name ? item.name.slice(0, 512) : `video-${id}`,
      size: Number.isSafeInteger(sizeValue) && sizeValue >= 0 ? sizeValue : 0,
      thumbnail: core.isAllowedThumbnailUrl(item.thumbnail) ? item.thumbnail : null,
      reason: allowedReasons.has(item.reason) ? item.reason : "missing-link",
    });
    seen.add(id);
  }
  return output;
}

function rejectedDiscoveryItems(input, acceptedVideos) {
  if (!Array.isArray(input)) return [];
  const acceptedIds = new Set(acceptedVideos.map((item) => item.id));
  const rejected = [];
  const seen = new Set();

  for (const item of input.slice(0, MAX_VIDEOS)) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.slice(0, 160) : "";
    if (!id || acceptedIds.has(id) || seen.has(id)) continue;
    const rawSize = Number(item.size);
    rejected.push({
      id,
      name: typeof item.name === "string" && item.name ? item.name.slice(0, 512) : `video-${id}`,
      size: Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : 0,
      thumbnail: core.isAllowedThumbnailUrl(item.thumbnail) ? item.thumbnail : null,
      reason: core.isAllowedDownloadUrl(item.link) ? "invalid-metadata" : "unsafe-link",
    });
    seen.add(id);
  }
  return rejected;
}

function makeBatch(discovery, sender) {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const folderId = typeof discovery.folderId === "string" ? discovery.folderId.slice(0, 160) : "folder";
  const folderName = typeof discovery.folderName === "string" ? discovery.folderName.slice(0, 512) : "Gofile";
  const pageUrl = core.isGofilePageUrl(discovery.pageUrl) ? discovery.pageUrl : senderUrl(sender);
  const videos = core.normalizeVideos(discovery.videos, MAX_VIDEOS);

  const items = videos.map((video) => ({
    id: video.id,
    name: video.name,
    size: video.size,
    mimetype: video.mimetype,
    thumbnail: video.thumbnail,
    url: video.link,
    filename: core.buildDownloadPath(folderName, video.name, video.id),
    status: "queued",
    downloadId: null,
    bytesReceived: 0,
    totalBytes: video.size,
    error: null,
    danger: "safe",
    attempts: 0,
    attemptToken: null,
    startingAt: 0,
    retryable: true,
    ambiguousDownloadIds: [],
    ambiguousTerminalDownloads: [],
  }));

  const skipped = safeSkippedItems([
    ...(Array.isArray(discovery.skipped) ? discovery.skipped : []),
    ...rejectedDiscoveryItems(discovery.videos, videos),
  ]);

  return {
    id: batchId,
    tabId: sender.tab.id,
    incognito: sender.tab.incognito === true,
    pageUrl,
    folderId,
    folderName,
    scannedItems: Number(discovery.scannedItems) || 0,
    totalPages: Number(discovery.totalPages) || 1,
    createdAt: now,
    updatedAt: now,
    lastStartedAt: 0,
    cancelRequested: false,
    retryRequested: false,
    status: core.deriveBatchStatus(items),
    items,
    skipped,
  };
}

function cleanState(state) {
  const now = Date.now();
  const batches = Object.values(state.batches).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const keep = new Set();

  for (const batch of batches) {
    const active = batch.status === "active" || batch.cancelRequested === true || batch.retryRequested === true;
    const recent = now - Number(batch.updatedAt || 0) <= TERMINAL_RETENTION_MS;
    if (active || (recent && keep.size < MAX_BATCHES)) keep.add(batch.id);
  }

  for (const id of Object.keys(state.batches)) {
    if (!keep.has(id)) delete state.batches[id];
  }
}

function updateBatchStatus(batch) {
  batch.status = core.deriveBatchStatus(batch.items);
  batch.updatedAt = Date.now();
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    thumbnail: item.thumbnail,
    status: item.status,
    bytesReceived: Math.max(0, Number(item.bytesReceived) || 0),
    totalBytes: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : Number(item.size) || 0,
    error: item.error || null,
    danger: item.danger || "safe",
    retryable: item.retryable !== false,
    progress: core.itemProgress(item),
  };
}

function prioritizedPublicItems(items, limit) {
  const priorities = [
    new Set(["downloading", "starting", "failed", "interrupted"]),
    new Set(["queued"]),
    new Set(["complete", "canceled"]),
  ];
  const output = [];
  const seen = new Set();
  for (const statuses of priorities) {
    for (const item of items) {
      if (output.length >= limit) return output;
      if (!statuses.has(item.status) || seen.has(item.id)) continue;
      output.push(publicItem(item));
      seen.add(item.id);
    }
  }
  return output;
}

function publicBatch(batch) {
  if (!batch) return null;
  const summary = core.summarizeItems(batch.items);
  const reservedSkippedRows = Math.min(10, batch.skipped.length);
  const items = prioritizedPublicItems(batch.items, MAX_PUBLIC_ROWS - reservedSkippedRows);
  const remainingRows = Math.max(0, MAX_PUBLIC_ROWS - items.length);
  const skipped = batch.skipped.slice(0, remainingRows).map((item) => ({ ...item }));
  const retryableFailures = batch.items.filter(
    (item) =>
      (item.status === "failed" || item.status === "interrupted") &&
      item.retryable !== false &&
      core.isAllowedDownloadUrl(item.url),
  ).length;
  const skippedReasons = {};
  for (const item of batch.skipped) {
    const reason = typeof item.reason === "string" ? item.reason : "missing-link";
    skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
  }

  return {
    id: batch.id,
    folderId: batch.folderId,
    folderName: batch.folderName,
    pageUrl: batch.pageUrl,
    status: batch.status,
    cancelRequested: batch.cancelRequested === true,
    retryRequested: batch.retryRequested === true,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    scannedItems: batch.scannedItems,
    totalPages: batch.totalPages,
    summary: { ...summary, retryableFailures },
    itemCount: batch.items.length,
    skippedCount: batch.skipped.length,
    skippedReasons,
    omittedCount: Math.max(0, batch.items.length + batch.skipped.length - items.length - skipped.length),
    items,
    skipped,
  };
}

async function notifyBatch(batch) {
  try {
    await chrome.tabs.sendMessage(batch.tabId, {
      type: "gofile-bulk:updated",
      batchId: batch.id,
    });
  } catch {
    // タブが閉じられていても、バックグラウンドの保存処理は継続します。
  }
}

async function queryDownloads(query) {
  try {
    const results = await chrome.downloads.search(query);
    return { ok: true, value: Array.isArray(results) ? results : [] };
  } catch {
    return { ok: false, value: [] };
  }
}

async function searchDownload(downloadId) {
  const result = await queryDownloads({ id: downloadId });
  return { ok: result.ok, value: result.value[0] || null };
}

function clearAmbiguousTracking(item) {
  item.ambiguousDownloadIds = [];
  item.ambiguousTerminalDownloads = [];
}

function terminalDownloadRecords(downloads) {
  return downloads
    .filter(
      (download) =>
        Number.isInteger(download?.id) &&
        (download.state === "complete" || download.state === "interrupted"),
    )
    .map((download) => ({
      id: download.id,
      state: download.state,
      error: typeof download.error === "string" ? download.error : null,
    }))
    .sort((a, b) => a.id - b.id);
}

function mergeAmbiguousTerminalRecords(candidateIds, previousRecords, observedRecords) {
  const candidateIdSet = new Set(candidateIds);
  const records = new Map();
  for (const entry of Array.isArray(previousRecords) ? previousRecords : []) {
    if (
      Number.isInteger(entry?.id) &&
      candidateIdSet.has(entry.id) &&
      (entry.state === "complete" || entry.state === "interrupted")
    ) {
      records.set(entry.id, {
        id: entry.id,
        state: entry.state,
        error: typeof entry.error === "string" ? entry.error : null,
      });
    }
  }
  for (const entry of observedRecords) records.set(entry.id, entry);
  return [...records.values()].sort((a, b) => a.id - b.id);
}

function forgetAmbiguousTerminalState(item, downloadId) {
  const previous = Array.isArray(item.ambiguousTerminalDownloads) ? item.ambiguousTerminalDownloads : [];
  const next = previous.filter((entry) => entry?.id !== downloadId);
  if (next.length === previous.length) return false;
  item.ambiguousTerminalDownloads = next;
  return true;
}

function recordAmbiguousTerminalState(item, downloadId, state, error = null) {
  const candidateIds = Array.isArray(item.ambiguousDownloadIds)
    ? item.ambiguousDownloadIds.filter(Number.isInteger)
    : [];
  if (
    !candidateIds.includes(downloadId) ||
    (state !== "complete" && state !== "interrupted")
  ) {
    return { changed: false, settled: false };
  }

  const candidateIdSet = new Set(candidateIds);
  const previous = Array.isArray(item.ambiguousTerminalDownloads)
    ? item.ambiguousTerminalDownloads.filter(
        (entry) =>
          Number.isInteger(entry?.id) &&
          candidateIdSet.has(entry.id) &&
          entry.id !== downloadId &&
          (entry.state === "complete" || entry.state === "interrupted"),
      )
    : [];
  const records = [
    ...previous,
    {
      id: downloadId,
      state,
      error: typeof error === "string" ? error : null,
    },
  ].sort((a, b) => a.id - b.id);
  const changed = JSON.stringify(records) !== JSON.stringify(item.ambiguousTerminalDownloads || []);
  item.ambiguousTerminalDownloads = records;

  if (!candidateIds.every((id) => records.some((record) => record.id === id))) {
    return { changed, settled: false };
  }

  const completed = records.some((record) => record.state === "complete");
  const representative = records.find((record) => record.state === "interrupted");
  const statusChanged = applyDownloadSnapshot(item, completed
    ? {
        state: "complete",
        bytesReceived: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : Number(item.size) || 0,
        totalBytes: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : Number(item.size) || 0,
        danger: item.danger || "safe",
      }
    : {
        state: "interrupted",
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        danger: item.danger || "safe",
        error: representative?.error || "DOWNLOAD_INTERRUPTED",
      });
  return { changed: changed || statusChanged, settled: true };
}

function findTrackedDownload(state, downloadId) {
  for (const batch of Object.values(state.batches)) {
    for (const item of batch.items) {
      if (item.downloadId === downloadId) return { batch, item, ambiguous: false };
      if (Array.isArray(item.ambiguousDownloadIds) && item.ambiguousDownloadIds.includes(downloadId)) {
        return { batch, item, ambiguous: true };
      }
    }
  }
  return null;
}

function applyDownloadSnapshot(item, download) {
  if (!download) return false;
  let changed = false;

  item.bytesReceived = Math.max(0, Number(download.bytesReceived) || 0);
  if (Number(download.totalBytes) > 0) item.totalBytes = Number(download.totalBytes);
  if (typeof download.danger === "string" && item.danger !== download.danger) {
    item.danger = download.danger;
    changed = true;
  }

  if (item.status === "canceled") return changed;
  if (download.state === "complete" && item.status !== "complete") {
    item.status = "complete";
    item.error = null;
    item.url = null;
    item.retryable = false;
    clearAmbiguousTracking(item);
    changed = true;
  } else if (download.state === "interrupted" && item.status !== "interrupted") {
    item.status = "interrupted";
    item.error = typeof download.error === "string" ? download.error : "DOWNLOAD_INTERRUPTED";
    item.retryable = true;
    clearAmbiguousTracking(item);
    changed = true;
  } else if (download.state === "in_progress" && item.status !== "downloading") {
    item.status = "downloading";
    item.error = null;
    item.retryable = true;
    changed = true;
  }

  return changed;
}

function applyTerminalDelta(item, delta) {
  const state = delta?.state?.current;
  if (state === "complete") {
    return applyDownloadSnapshot(item, {
      state: "complete",
      bytesReceived: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : Number(item.size) || 0,
      totalBytes: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : Number(item.size) || 0,
      danger: delta?.danger?.current || item.danger || "safe",
    });
  }
  if (state === "interrupted") {
    return applyDownloadSnapshot(item, {
      state: "interrupted",
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      danger: delta?.danger?.current || item.danger || "safe",
      error: delta?.error?.current || "DOWNLOAD_INTERRUPTED",
    });
  }
  return false;
}

function usedDownloadIds(state, exceptItem) {
  const used = new Set();
  for (const batch of Object.values(state.batches)) {
    for (const item of batch.items) {
      if (item !== exceptItem && Number.isInteger(item.downloadId)) used.add(item.downloadId);
      if (item !== exceptItem && Array.isArray(item.ambiguousDownloadIds)) {
        for (const id of item.ambiguousDownloadIds) if (Number.isInteger(id)) used.add(id);
      }
    }
  }
  return used;
}

async function reconnectStartingItem(state, batch, item) {
  if (!(Number(item.startingAt) > 0) || !core.isAllowedDownloadUrl(item.url)) {
    item.status = "interrupted";
    item.error = "START_STATE_LOST";
    item.retryable = true;
    clearAmbiguousTracking(item);
    return true;
  }

  const beforeStartToleranceMs = 10 * 1000;
  const afterStartToleranceMs = 2 * 60 * 1000;
  const result = await queryDownloads({
    url: item.url,
    startedAfter: new Date(item.startingAt - beforeStartToleranceMs).toISOString(),
    startedBefore: new Date(item.startingAt + afterStartToleranceMs).toISOString(),
    limit: 50,
  });
  if (!result.ok) return false;

  const usedIds = usedDownloadIds(state, item);
  let candidates = result.value.filter(
    (download) =>
      Number.isInteger(download?.id) &&
      !usedIds.has(download.id) &&
      download.url === item.url &&
      download.byExtensionId === chrome.runtime.id &&
      (download.incognito === true) === batch.incognito,
  );
  if (candidates.length === 1) {
    item.downloadId = candidates[0].id;
    clearAmbiguousTracking(item);
    item.retryable = true;
    applyDownloadSnapshot(item, candidates[0]);
    return true;
  }

  if (candidates.length > 1 && candidates.some((download) => download.state === "in_progress")) {
    const candidateIds = candidates.map((download) => download.id).sort((a, b) => a - b);
    const previousIds = Array.isArray(item.ambiguousDownloadIds) ? item.ambiguousDownloadIds : [];
    const previousTerminals = Array.isArray(item.ambiguousTerminalDownloads) ? item.ambiguousTerminalDownloads : [];
    // onChangedの終端通知はsearch結果より先行し得るため、明示的なin_progress通知が来るまで保持します。
    const terminalDownloads = mergeAmbiguousTerminalRecords(
      candidateIds,
      previousTerminals,
      terminalDownloadRecords(candidates),
    );
    const idsChanged = candidateIds.length !== previousIds.length || candidateIds.some((id, index) => id !== previousIds[index]);
    const terminalsChanged = JSON.stringify(terminalDownloads) !== JSON.stringify(previousTerminals);
    const changed = item.status !== "starting" || item.error !== "START_STATE_AMBIGUOUS" || item.retryable !== false || idsChanged || terminalsChanged;
    item.status = "starting";
    item.error = "START_STATE_AMBIGUOUS";
    item.retryable = false;
    item.ambiguousDownloadIds = candidateIds;
    item.ambiguousTerminalDownloads = terminalDownloads;
    return changed;
  }
  if (candidates.length > 1 && candidates.some((download) => download.state === "complete")) {
    item.status = "complete";
    item.error = null;
    item.url = null;
    item.retryable = false;
    clearAmbiguousTracking(item);
    return true;
  }

  if (candidates.length > 1 && candidates.every((download) => download.state === "interrupted")) {
    item.status = "interrupted";
    item.error = candidates.find((download) => download.error)?.error || "DOWNLOAD_INTERRUPTED";
    item.retryable = true;
    clearAmbiguousTracking(item);
    return true;
  }

  item.status = "interrupted";
  item.error = candidates.length === 0 ? "START_STATE_LOST" : "START_STATE_AMBIGUOUS";
  item.retryable = candidates.length === 0;
  clearAmbiguousTracking(item);
  return true;
}

async function reconcileBatch(state, batch) {
  let changed = false;
  const changedItems = new Set();
  const orphanedStarts = batch.items.filter(
    (item) => item.status === "starting" && item.downloadId === null,
  );
  for (const item of orphanedStarts) {
    const itemChanged = await reconnectStartingItem(state, batch, item);
    if (itemChanged) changedItems.add(item);
    changed = itemChanged || changed;
  }

  const activeItems = batch.items.filter(
    (item) => item.downloadId !== null && (item.status === "starting" || item.status === "downloading"),
  );

  const snapshots = await Promise.all(activeItems.map((item) => searchDownload(item.downloadId)));
  for (let index = 0; index < activeItems.length; index += 1) {
    const item = activeItems[index];
    const result = snapshots[index];
    if (!result.ok) continue;
    if (!result.value) {
      item.status = "interrupted";
      item.error = "DOWNLOAD_NOT_FOUND";
      item.retryable = true;
      changedItems.add(item);
      changed = true;
      continue;
    }
    const itemChanged = applyDownloadSnapshot(item, result.value);
    if (itemChanged) changedItems.add(item);
    changed = itemChanged || changed;
  }

  if (changed) updateBatchStatus(batch);
  return { changed, items: [...changedItems] };
}

function globalActiveCount(state) {
  let total = 0;
  for (const batch of Object.values(state.batches)) {
    total += batch.items.filter((item) => item.status === "starting" || item.status === "downloading").length;
  }
  return total;
}

async function startQueuedItem(state, batch, item) {
  if (!core.isAllowedDownloadUrl(item.url)) {
    item.status = "failed";
    item.error = "INVALID_DOWNLOAD_URL";
    item.retryable = false;
    updateBatchStatus(batch);
    await writeState(state);
    return false;
  }

  item.status = "starting";
  item.error = null;
  item.retryable = true;
  item.attempts += 1;
  item.attemptToken = crypto.randomUUID();
  item.startingAt = Date.now();
  batch.lastStartedAt = item.startingAt;
  updateBatchStatus(batch);
  await writeState(state, { batches: [batch], items: [{ batch, item }] });

  try {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename: item.filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    if (!Number.isInteger(downloadId)) throw new Error("download id unavailable");
    item.downloadId = downloadId;
    item.status = "downloading";
  } catch {
    item.status = "failed";
    item.error = "START_FAILED";
    item.retryable = true;
  }
  updateBatchStatus(batch);
  await writeState(state, { batches: [batch], items: [{ batch, item }] });
  return item.status === "downloading";
}

async function pumpBatches(state) {
  let activeCount = globalActiveCount(state);
  let attempts = 0;
  const changedBatchIds = new Set();

  while (activeCount < MAX_PARALLEL_DOWNLOADS && attempts < MAX_START_ATTEMPTS_PER_PUMP) {
    const candidates = Object.values(state.batches)
      .filter(
        (batch) =>
          batch.cancelRequested !== true &&
          batch.retryRequested !== true &&
          batch.items.some((item) => item.status === "queued"),
      )
      .sort((a, b) => (Number(a.lastStartedAt) || 0) - (Number(b.lastStartedAt) || 0) || a.createdAt - b.createdAt);
    if (candidates.length === 0) break;

    const batch = candidates[0];
    const item = batch.items.find((candidate) => candidate.status === "queued");
    if (!item) break;
    const started = await startQueuedItem(state, batch, item);
    changedBatchIds.add(batch.id);
    attempts += 1;
    if (started) activeCount += 1;
  }

  return changedBatchIds;
}

async function notifyBatches(state, batchIds) {
  await Promise.all([...batchIds].map((batchId) => state.batches[batchId]).filter(Boolean).map(notifyBatch));
}

function sameSharePage(first, second) {
  try {
    const a = new URL(first);
    const b = new URL(second);
    const aPath = a.pathname.endsWith("/") ? a.pathname.slice(0, -1) : a.pathname;
    const bPath = b.pathname.endsWith("/") ? b.pathname.slice(0, -1) : b.pathname;
    return a.origin === b.origin && aPath === bPath;
  } catch {
    return false;
  }
}

function sameBatchContext(batch, sender) {
  return batch?.incognito === (sender?.tab?.incognito === true)
    && sameSharePage(batch.pageUrl, senderUrl(sender));
}

function findBatchForSender(state, sender) {
  const ordered = Object.values(state.batches).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return ordered.find((batch) => batch.tabId === sender.tab.id && sameBatchContext(batch, sender))
    || ordered.find((batch) => sameBatchContext(batch, sender))
    || null;
}

function findActiveBatch(state, sender, folderId) {
  return Object.values(state.batches).find(
    (batch) =>
      batch.status === "active" &&
      sameBatchContext(batch, sender) &&
      (!folderId || batch.folderId === folderId),
  );
}

function findIntentBatch(state, sender, folderId) {
  return Object.values(state.batches)
    .filter(
      (batch) =>
        (batch.cancelRequested === true || batch.retryRequested === true) &&
        sameBatchContext(batch, sender) &&
        (!folderId || batch.folderId === folderId),
    )
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

function canAccessBatch(batch, sender) {
  return Boolean(batch && sameBatchContext(batch, sender));
}

async function executeCollector(sender) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, frameIds: [0] },
    world: "MAIN",
    func: globalThis.collectGofilePageVideos,
    args: [senderUrl(sender)],
  });
  return Array.isArray(results) ? results[0]?.result : null;
}

async function startBatch(sender) {
  const existing = await runExclusive(async () => {
    const state = await readState();
    const pending = findIntentBatch(state, sender);
    if (pending) await settlePendingIntent(state, pending);
    return findActiveBatch(state, sender);
  });
  if (existing) return { ok: true, batch: publicBatch(existing), reused: true };

  let discovery;
  try {
    discovery = await executeCollector(sender);
  } catch {
    return { ok: false, error: "INJECTION_FAILED" };
  }

  if (!discovery || discovery.ok !== true) {
    return { ok: false, error: discovery?.error || "SCAN_FAILED" };
  }
  if (
    !Array.isArray(discovery.videos) ||
    !Array.isArray(discovery.skipped) ||
    discovery.videos.length + discovery.skipped.length > MAX_VIDEOS
  ) {
    return { ok: false, error: "TOO_MANY_VIDEOS" };
  }

  return runExclusive(async () => {
    const state = await readState();
    const pending = findIntentBatch(state, sender, discovery.folderId);
    if (pending) await settlePendingIntent(state, pending);
    let duplicate = findActiveBatch(state, sender, discovery.folderId);
    if (duplicate) return { ok: true, batch: publicBatch(duplicate), reused: true };
    if (
      Object.values(state.batches).filter(
        (batch) => batch.status === "active" || batch.cancelRequested || batch.retryRequested,
      ).length >= MAX_ACTIVE_BATCHES
    ) {
      return { ok: false, error: "TOO_MANY_ACTIVE_BATCHES" };
    }

    cleanState(state);
    const batch = makeBatch(discovery, sender);
    state.batches[batch.id] = batch;
    await writeState(state);
    const pumpedBatchIds = await pumpBatches(state);
    pumpedBatchIds.add(batch.id);
    await notifyBatches(state, pumpedBatchIds);
    return { ok: true, batch: publicBatch(batch), reused: false };
  });
}

async function getStatus(sender) {
  return runExclusive(async () => {
    const state = await readState();
    const batch = findBatchForSender(state, sender);
    if (!batch) return { ok: true, batch: null };

    if (batch.cancelRequested || batch.retryRequested) {
      await settlePendingIntent(state, batch);
      const changedBatchIds = await pumpBatches(state);
      changedBatchIds.add(batch.id);
      await notifyBatches(state, changedBatchIds);
      return { ok: true, batch: publicBatch(batch) };
    }

    const reconciled = await reconcileBatch(state, batch);
    if (reconciled.changed) {
      await writeState(state, {
        batches: [batch],
        items: reconciled.items.map((item) => ({ batch, item })),
      });
    }
    const changedBatchIds = await pumpBatches(state);
    if (reconciled.changed) changedBatchIds.add(batch.id);
    if (changedBatchIds.size > 0) await notifyBatches(state, changedBatchIds);
    return { ok: true, batch: publicBatch(batch) };
  });
}

function finalizeCanceledItem(item) {
  item.status = "canceled";
  item.error = null;
  item.url = null;
  item.retryable = false;
  clearAmbiguousTracking(item);
}

async function completeCancelRequest(state, batch) {
  await reconcileBatch(state, batch);
  let unresolved = false;

  for (const item of batch.items) {
    if (item.status === "queued") {
      finalizeCanceledItem(item);
      continue;
    }
    if (item.status === "canceled" || item.status === "complete") continue;
    if (item.status === "interrupted" && item.error === "USER_CANCELED") {
      finalizeCanceledItem(item);
      continue;
    }
    if (
      (item.status === "interrupted" || item.status === "failed") &&
      ["START_STATE_LOST", "DOWNLOAD_NOT_FOUND", "DOWNLOAD_ERASED"].includes(item.error)
    ) {
      finalizeCanceledItem(item);
      continue;
    }
    if (item.status === "interrupted" || item.status === "failed") {
      // キャンセル意思が確定した後は、直前の失敗理由にかかわらず再開可能なURLを残しません。
      item.url = null;
      item.retryable = false;
      clearAmbiguousTracking(item);
      continue;
    }

    if (item.status === "starting" && item.downloadId === null) {
      const ambiguousIds = Array.isArray(item.ambiguousDownloadIds)
        ? item.ambiguousDownloadIds.filter(Number.isInteger)
        : [];
      if (ambiguousIds.length === 0) {
        item.error = "CANCEL_PENDING";
        item.retryable = false;
        unresolved = true;
        continue;
      }

      await Promise.allSettled(ambiguousIds.map((id) => chrome.downloads.cancel(id)));
      const results = await Promise.all(ambiguousIds.map(searchDownload));
      if (!results.every((result) => result.ok)) {
        item.error = "CANCEL_PENDING";
        item.retryable = false;
        unresolved = true;
        continue;
      }
      const snapshots = results.map((result) => result.value).filter(Boolean);
      if (snapshots.some((snapshot) => snapshot.state === "complete")) {
        item.status = "complete";
        item.error = null;
        item.url = null;
        item.retryable = false;
        clearAmbiguousTracking(item);
      } else if (snapshots.some((snapshot) => snapshot.state === "in_progress")) {
        item.error = "CANCEL_PENDING";
        item.retryable = false;
        unresolved = true;
      } else if (snapshots.every((snapshot) => snapshot.error === "USER_CANCELED")) {
        finalizeCanceledItem(item);
      } else {
        item.status = "interrupted";
        item.error = snapshots[0]?.error || "CANCEL_STATE_UNKNOWN";
        item.url = null;
        item.retryable = false;
        clearAmbiguousTracking(item);
      }
      continue;
    }

    if (item.status === "downloading" && item.downloadId !== null) {
      try {
        await chrome.downloads.cancel(item.downloadId);
      } catch {
        // 完了との競合を含め、直後の照合結果だけで状態を確定します。
      }
      const result = await searchDownload(item.downloadId);
      if (!result.ok || result.value?.state === "in_progress") {
        item.error = "CANCEL_PENDING";
        item.retryable = false;
        unresolved = true;
      } else if (!result.value || result.value.error === "USER_CANCELED") {
        finalizeCanceledItem(item);
      } else if (result.value.state === "complete") {
        applyDownloadSnapshot(item, result.value);
      } else {
        applyDownloadSnapshot(item, result.value);
        item.url = null;
        item.retryable = false;
      }
    }
  }

  updateBatchStatus(batch);
  await writeState(state, {
    batches: [batch],
    items: batch.items.map((item) => ({ batch, item })),
  });
  if (unresolved) return false;

  batch.cancelRequested = false;
  batch.retryRequested = false;
  updateBatchStatus(batch);
  await writeState(state, { batches: [batch], items: [] });
  return true;
}

function queueRetryableItem(item) {
  item.status = "queued";
  item.downloadId = null;
  item.bytesReceived = 0;
  item.totalBytes = item.size;
  item.error = null;
  item.danger = "safe";
  item.attemptToken = null;
  item.startingAt = 0;
  item.retryable = true;
  clearAmbiguousTracking(item);
}

async function completeRetryRequest(state, batch) {
  for (const item of batch.items) {
    if (
      (item.status === "failed" || item.status === "interrupted") &&
      item.retryable !== false &&
      core.isAllowedDownloadUrl(item.url)
    ) {
      queueRetryableItem(item);
    }
  }

  updateBatchStatus(batch);
  await writeState(state, {
    batches: [batch],
    items: batch.items.map((item) => ({ batch, item })),
  });
  batch.retryRequested = false;
  updateBatchStatus(batch);
  await writeState(state, { batches: [batch], items: [] });
}

async function settlePendingIntent(state, batch) {
  if (batch?.cancelRequested) {
    await completeCancelRequest(state, batch);
  } else if (batch?.retryRequested) {
    await completeRetryRequest(state, batch);
  }
}

async function cancelBatch(sender, batchId) {
  return runExclusive(async () => {
    const state = await readState();
    const batch = state.batches[batchId];
    if (!canAccessBatch(batch, sender)) return { ok: false, error: "BATCH_NOT_FOUND" };

    if (batch.cancelRequested !== true) {
      batch.cancelRequested = true;
      batch.retryRequested = false;
      updateBatchStatus(batch);
      await writeState(state, { batches: [batch], items: [] });
    }
    await completeCancelRequest(state, batch);
    const changedBatchIds = await pumpBatches(state);
    changedBatchIds.add(batch.id);
    await notifyBatches(state, changedBatchIds);
    return { ok: true, batch: publicBatch(batch) };
  });
}

async function retryBatch(sender, batchId) {
  return runExclusive(async () => {
    const state = await readState();
    const batch = state.batches[batchId];
    if (!canAccessBatch(batch, sender)) return { ok: false, error: "BATCH_NOT_FOUND" };
    if (batch.cancelRequested) return { ok: false, error: "BATCH_ACTIVE" };
    if (batch.retryRequested) {
      await completeRetryRequest(state, batch);
      const changedBatchIds = await pumpBatches(state);
      changedBatchIds.add(batch.id);
      await notifyBatches(state, changedBatchIds);
      return { ok: true, batch: publicBatch(batch) };
    }
    if (batch.status === "active" && !batch.retryRequested) return { ok: false, error: "BATCH_ACTIVE" };

    const retryCount = batch.items.filter(
      (item) =>
        (item.status === "failed" || item.status === "interrupted") &&
        item.retryable !== false &&
        core.isAllowedDownloadUrl(item.url),
    ).length;
    if (retryCount === 0) return { ok: false, error: "NOTHING_TO_RETRY" };

    batch.retryRequested = true;
    updateBatchStatus(batch);
    await writeState(state, { batches: [batch], items: [] });
    await completeRetryRequest(state, batch);
    const changedBatchIds = await pumpBatches(state);
    changedBatchIds.add(batch.id);
    await notifyBatches(state, changedBatchIds);
    return { ok: true, batch: publicBatch(batch) };
  });
}

async function dismissBatch(sender, batchId) {
  return runExclusive(async () => {
    const state = await readState();
    const batch = state.batches[batchId];
    if (!canAccessBatch(batch, sender)) return { ok: true };
    if (batch.status === "active" || batch.cancelRequested || batch.retryRequested) {
      return { ok: false, error: "BATCH_ACTIVE" };
    }
    delete state.batches[batchId];
    await writeState(state);
    return { ok: true };
  });
}

async function recoverBatches() {
  return runExclusive(async () => {
    const state = await readState();
    cleanState(state);
    for (const batch of Object.values(state.batches)) {
      if (batch.cancelRequested || batch.retryRequested) {
        await settlePendingIntent(state, batch);
        continue;
      }
      if (batch.status !== "active") continue;
      await reconcileBatch(state, batch);
    }
    await writeState(state);
    const changedBatchIds = await pumpBatches(state);
    if (changedBatchIds.size > 0) await notifyBatches(state, changedBatchIds);
  });
}

async function handleMessage(message, sender) {
  const type = message?.type;
  if (type === "gofile-bulk:start") {
    if (!isTrustedSender(sender, true)) return { ok: false, error: "UNTRUSTED_PAGE" };
    return startBatch(sender);
  }

  if (!["gofile-bulk:status", "gofile-bulk:cancel", "gofile-bulk:retry", "gofile-bulk:dismiss"].includes(type)) {
    return undefined;
  }
  if (!isTrustedSender(sender, true)) return { ok: false, error: "UNTRUSTED_PAGE" };

  if (type === "gofile-bulk:status") return getStatus(sender);
  if (type === "gofile-bulk:cancel") return cancelBatch(sender, String(message.batchId || ""));
  if (type === "gofile-bulk:retry") return retryBatch(sender, String(message.batchId || ""));
  return dismissBatch(sender, String(message.batchId || ""));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const known = typeof message?.type === "string" && message.type.startsWith("gofile-bulk:");
  if (!known) return undefined;

  handleMessage(message, sender)
    .then((response) => sendResponse(response ?? { ok: false, error: "UNKNOWN_MESSAGE" }))
    .catch(() => sendResponse({ ok: false, error: "INTERNAL_ERROR" }));
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!Number.isInteger(delta?.id)) return;
  void runExclusive(async () => {
    const state = await readState();
    const match = findTrackedDownload(state, delta.id);
    if (!match) return;
    const { batch: matchedBatch, item: matchedItem } = match;

    if (matchedBatch.cancelRequested) {
      await completeCancelRequest(state, matchedBatch);
      const changedBatchIds = await pumpBatches(state);
      changedBatchIds.add(matchedBatch.id);
      await notifyBatches(state, changedBatchIds);
      return;
    }

    if (match.ambiguous) {
      const recorded = recordAmbiguousTerminalState(
        matchedItem,
        delta.id,
        delta?.state?.current,
        delta?.error?.current,
      );
      if (recorded.settled) {
        updateBatchStatus(matchedBatch);
        await writeState(state, {
          batches: [matchedBatch],
          items: [{ batch: matchedBatch, item: matchedItem }],
        });
        const changedBatchIds = await pumpBatches(state);
        changedBatchIds.add(matchedBatch.id);
        await notifyBatches(state, changedBatchIds);
        return;
      }

      const resumed = delta?.state?.current === "in_progress"
        ? forgetAmbiguousTerminalState(matchedItem, delta.id)
        : false;

      const reconciled = await reconcileBatch(state, matchedBatch);
      const changedItems = new Set(reconciled.items);
      if (recorded.changed || resumed) changedItems.add(matchedItem);
      if ((recorded.changed || resumed) && !reconciled.changed) updateBatchStatus(matchedBatch);
      if (changedItems.size > 0) {
        await writeState(state, {
          batches: [matchedBatch],
          items: [...changedItems].map((item) => ({ batch: matchedBatch, item })),
        });
      }
      const changedBatchIds = await pumpBatches(state);
      changedBatchIds.add(matchedBatch.id);
      await notifyBatches(state, changedBatchIds);
      return;
    }

    const deltaChanged = applyTerminalDelta(matchedItem, delta);

    const result = await searchDownload(delta.id);
    const snapshotChanged = result.ok && result.value
      ? applyDownloadSnapshot(matchedItem, result.value)
      : deltaChanged;
    updateBatchStatus(matchedBatch);
    if (snapshotChanged) {
      await writeState(state, { batches: [matchedBatch], items: [{ batch: matchedBatch, item: matchedItem }] });
    }
    const changedBatchIds = await pumpBatches(state);
    changedBatchIds.add(matchedBatch.id);
    await notifyBatches(state, changedBatchIds);
  });
});

if (chrome.downloads.onErased) {
  chrome.downloads.onErased.addListener((downloadId) => {
    if (!Number.isInteger(downloadId)) return;
    void runExclusive(async () => {
      const state = await readState();
      const match = findTrackedDownload(state, downloadId);
      if (!match) return;
      const { batch, item } = match;
      if (item.status === "complete" || item.status === "canceled") return;
      if (batch.cancelRequested) {
        await completeCancelRequest(state, batch);
        const changedBatchIds = await pumpBatches(state);
        changedBatchIds.add(batch.id);
        await notifyBatches(state, changedBatchIds);
        return;
      }

      if (match.ambiguous) {
        const recorded = recordAmbiguousTerminalState(item, downloadId, "interrupted", "DOWNLOAD_ERASED");
        if (recorded.settled) {
          updateBatchStatus(batch);
          await writeState(state, { batches: [batch], items: [{ batch, item }] });
          const changedBatchIds = await pumpBatches(state);
          changedBatchIds.add(batch.id);
          await notifyBatches(state, changedBatchIds);
          return;
        }

        const reconciled = await reconcileBatch(state, batch);
        const changedItems = new Set(reconciled.items);
        if (recorded.changed) changedItems.add(item);
        if (recorded.changed && !reconciled.changed) updateBatchStatus(batch);
        if (changedItems.size > 0) {
          await writeState(state, {
            batches: [batch],
            items: [...changedItems].map((changedItem) => ({ batch, item: changedItem })),
          });
        }
      } else {
        item.status = "interrupted";
        item.error = "DOWNLOAD_ERASED";
        item.retryable = true;
        updateBatchStatus(batch);
        await writeState(state, { batches: [batch], items: [{ batch, item }] });
      }
      const changedBatchIds = await pumpBatches(state);
      changedBatchIds.add(batch.id);
      await notifyBatches(state, changedBatchIds);
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void recoverBatches();
});

chrome.runtime.onStartup.addListener(() => {
  void recoverBatches();
});

if (chrome.storage.local.setAccessLevel) {
  void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);
}

void recoverBatches();
