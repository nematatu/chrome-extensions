"use strict";
importScripts("core.js");
const core = globalThis.IGMediaCore;
let jobs = [];
const lastNotified = new Map();
let serial = Promise.resolve();
let savedMedia = {}, historyLoaded = false, historyMigrated = false;
async function loadHistory() {
  const value = await chrome.storage.local.get(["savedMedia", "savedHistoryMigratedV1"]);
  const records = value.savedMedia === undefined ? {} : value.savedMedia;
  savedMedia = core.validateHistory(records);
  historyMigrated = value.savedHistoryMigratedV1 === true;
  historyLoaded = true;
}
const ready = Promise.all([
  chrome.storage.session.get("jobs").then(result => { jobs = result.jobs || []; }),
  loadHistory().catch(() => {}),
]);
const save = () => chrome.storage.session.set({ jobs });
function summary(job) {
  return { id: job.id, tabId: job.tabId, paused: job.paused, canceled: job.canceled, total: job.items.length,
    complete: job.items.filter(i => i.state === "complete").length,
    failed: job.items.filter(i => i.state === "failed").length,
    active: job.items.filter(i => i.state === "active" || i.state === "starting").length,
    pending: job.items.filter(i => i.state === "queued").length,
    error: job.items.find(i => i.error)?.error || "", historyError: job.historyError || "" };
}
async function notify(job) {
  const value = summary(job), key = JSON.stringify(value);
  if (lastNotified.get(job.id) === key) return;
  try { await chrome.tabs.sendMessage(job.tabId, { type: "ig-download-progress", job: value }); lastNotified.set(job.id, key); } catch {}
}
function run(work) {
  const result = serial.then(async () => { await ready; return work(); });
  serial = result.catch(() => {});
  return result;
}
globalThis.IGMediaHistory = {
  read: () => run(async () => {
    await loadHistory();
    return { ...savedMedia };
  }),
  merge: records => run(async () => {
    const incoming = core.validateHistory(records);
    await loadHistory();
    const merged = { ...savedMedia };
    for (const [key, time] of Object.entries(incoming)) merged[key] = Math.max(merged[key] || 0, time);
    const validated = core.validateHistory(merged);
    await chrome.storage.local.set({ savedMedia: validated });
    savedMedia = validated;
    return { count: Object.keys(savedMedia).length };
  }),
};
async function reconcile(job) {
  for (const item of job.items) {
    if (item.state === "starting") { item.state = "failed"; item.error = "保存開始を確認できませんでした。元のボタンから再実行してください。"; }
    if (item.state !== "active") continue;
    const [download] = await chrome.downloads.search({ id: item.downloadId });
    if (!download || download.state === "interrupted") {
      item.state = "failed"; item.error = "保存が中断されました。元のボタンから再取得してください。";
    } else if (download.state === "complete") item.state = "complete";
  }
}
async function itemHistoryKeys(item, supplied = []) {
  if (!Array.isArray(supplied) || supplied.length > 12 || supplied.some(key => !core.validHistoryKey(key) || (key.startsWith("g:") || key.startsWith("p:")))) {
    throw new Error("保存履歴の識別情報が不正です。");
  }
  const kind = /\.mp4$/i.test(item.filename) ? "video" : "image";
  return [...new Set([...supplied, await core.filenameHistoryKey(item.filename), await core.urlHistoryKey(item.url, kind)].filter(Boolean))];
}
function completeGroups(value, items) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error("一括保存の履歴情報が不正です。");
  const keys = new Set(items.flatMap(item => item.historyKeys));
  let count = 0;
  return value.map(group => {
    if (!core.validHistoryKey(group?.key) || !group.key.startsWith("g:") || !Array.isArray(group.members) ||
        !group.members.length || (count += group.members.length) > 500 ||
        group.members.some(key => !core.validHistoryKey(key) || !(key.startsWith(`m:${group.key.slice(2)}:`) || key.startsWith("f:"))) ||
        !group.members.some(key => keys.has(key))) {
      throw new Error("一括保存の履歴情報が不正です。");
    }
    const aliases = group.aliases || [];
    if (!Array.isArray(aliases) || aliases.length > 1 || aliases.some(key => !core.validHistoryKey(key) || !key.startsWith("p:"))) {
      throw new Error("一括保存の履歴情報が不正です。");
    }
    return { key: group.key, members: [...new Set(group.members)], aliases };
  });
}
function historyPending(job) {
  return job.items.some(item => item.state === "complete" && (item.historyKeys || []).some(key => !savedMedia[key])) ||
    (job.completeGroups || []).some(group => [group.key, ...(group.aliases || [])].some(key => !savedMedia[key]) && group.members.every(key => savedMedia[key]));
}
async function importPreviousDownloads(candidate) {
  const records = await chrome.downloads.search({ state: "complete", filenameRegex: "[/\\\\]Instagram[/\\\\]", limit: 0 });
  for (const record of records) {
    if (record.byExtensionId !== chrome.runtime.id || record.state !== "complete") continue;
    const relative = record.filename?.replace(/\\/g, "/").match(/(?:^|\/)(Instagram\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+_\d+)(?: \(\d+\))?\.(jpg|png|webp|avif|mp4)$/i);
    if (!relative) continue;
    const filename = `${relative[1]}.${relative[2].toLowerCase()}`, kind = relative[2].toLowerCase() === "mp4" ? "video" : "image";
    const time = Date.parse(record.endTime) || Date.now();
    const keys = await Promise.all([core.filenameHistoryKey(filename), core.urlHistoryKey(record.url, kind), core.urlHistoryKey(record.finalUrl, kind)]);
    for (const key of keys.filter(Boolean)) if (!candidate[key]) candidate[key] = time;
  }
}
async function persistHistory() {
  try {
    if (!historyLoaded) await loadHistory();
    const candidate = { ...savedMedia }, now = Date.now();
    if (!historyMigrated) await importPreviousDownloads(candidate);
    for (const job of jobs) {
      for (const item of job.items) if (item.state === "complete") {
        if (!item.historyKeys) item.historyKeys = await itemHistoryKeys(item);
        for (const key of item.historyKeys) if (!candidate[key]) candidate[key] = now;
      }
      for (const group of job.completeGroups || []) {
        if (group.members.every(key => candidate[key])) for (const key of [group.key, ...(group.aliases || [])]) if (!candidate[key]) candidate[key] = now;
      }
    }
    if (!historyMigrated || Object.keys(candidate).length !== Object.keys(savedMedia).length) {
      await chrome.storage.local.set({ savedMedia: candidate, savedHistoryMigratedV1: true });
      savedMedia = candidate; historyMigrated = true;
    }
    for (const job of jobs) delete job.historyError;
  } catch {
    for (const job of jobs) if (job.items.some(item => item.state === "complete")) {
      job.historyError = "保存は完了しましたが、保存履歴を記録できませんでした。空き容量を確認してください。";
    }
  }
}
async function pump() {
  for (const job of jobs) {
    await reconcile(job);
    while (!job.paused && !job.canceled && !job.items.some(i => i.state === "active")) {
      const item = job.items.find(i => i.state === "queued");
      if (!item) break;
      if (item) {
        item.state = "starting";
        await save();
        try {
          item.downloadId = await chrome.downloads.download({ url: item.url, filename: item.filename,
            conflictAction: "uniquify", saveAs: false });
          item.state = "active";
        } catch {
          item.state = "failed";
          item.error = "保存を開始できませんでした。Chromeのダウンロード設定を確認してください。";
        }
      }
    }
    for (const item of job.items) {
      if (item.state === "complete" && !item.historyKeys) item.historyKeys = await itemHistoryKeys(item);
      if (["complete", "failed", "canceled"].includes(item.state)) delete item.url;
    }
  }
  await persistHistory();
  for (const job of jobs) await notify(job);
  await save();
  if (jobs.some(j => (!j.canceled && j.items.some(i => ["queued", "active"].includes(i.state))) || historyPending(j))) {
    await chrome.alarms.create("ig-download-queue", { periodInMinutes: 1 });
  } else await chrome.alarms.clear("ig-download-queue");
}
function isInstagram(sender) {
  try { return new URL(sender.url).origin === "https://www.instagram.com" && Number.isInteger(sender.tab?.id); }
  catch { return false; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !["ig-download-start", "ig-download-status", "ig-download-pause", "ig-download-cancel", "ig-download-history"].includes(message.type)) return;
  const popup = sender.url === chrome.runtime.getURL("popup.html");
  if (!isInstagram(sender) && !(popup && ["ig-download-status", "ig-download-history"].includes(message.type))) {
    respond({ ok: false, error: "Instagramのタブから操作してください。" }); return;
  }
  run(async () => {
    if (message.type === "ig-download-history") {
      await loadHistory();
      return { ok: true, savedMedia: { ...savedMedia } };
    }
    const tabId = sender.tab?.id;
    if (message.type === "ig-download-status") {
      await pump();
      return { ok: true, jobs: jobs.filter(j => popup || j.tabId === tabId).map(summary) };
    }
    if (message.type === "ig-download-start") {
      if (jobs.some(j => j.tabId === tabId && !j.canceled && j.items.some(i => ["queued", "active"].includes(i.state)))) {
        throw new Error("このタブでは保存が進行中です。完了または中止してから再実行してください。");
      }
      const validated = core.validateItems(message.items);
      const items = await Promise.all(validated.map(async (item, index) => ({ ...item,
        historyKeys: await itemHistoryKeys(item, message.items[index].historyKeys) })));
      const groups = completeGroups(message.completeGroups, items);
      const pending = jobs.flatMap(j => j.items).filter(i => ["queued", "active"].includes(i.state));
      if (pending.length + items.length > 500 || [...pending, ...items].reduce((sum, i) => sum + (i.url?.length || 0), 0) > 3 * 1024 * 1024) {
        throw new Error("他のタブの保存完了を待ってから再実行してください。全タブ合計で500件まで保存できます。");
      }
      jobs = jobs.filter(j => j.tabId !== tabId || j.items.some(i => ["queued", "active"].includes(i.state)) || historyPending(j));
      jobs.push({ id: crypto.randomUUID(), tabId, paused: false, canceled: false, completeGroups: groups,
        items: items.map(i => ({ ...i, state: "queued" })) });
      jobs = jobs.filter((j, index) => index >= jobs.length - 20 || j.items.some(i => ["queued", "active"].includes(i.state)) || historyPending(j));
    } else {
      const job = jobs.find(j => j.id === message.id && j.tabId === tabId);
      if (!job) throw new Error("保存処理が見つかりません。");
      if (message.type === "ig-download-pause") job.paused = !job.paused;
      else {
        await reconcile(job);
        job.canceled = true;
        for (const item of job.items) {
          if (item.state === "active") {
            try { await chrome.downloads.cancel(item.downloadId); }
            catch {
              const [download] = await chrome.downloads.search({ id: item.downloadId });
              if (download?.state === "complete") { item.state = "complete"; continue; }
            }
          }
          if (["queued", "active"].includes(item.state)) item.state = "canceled";
        }
      }
    }
    await save();
    await pump();
    return { ok: true, jobs: jobs.filter(j => j.tabId === tabId).map(summary) };
  }).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.error) void run(pump).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "ig-download-queue") void run(pump).catch(() => {});
});
void run(pump).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.savedMedia) return;
  void chrome.tabs.query({}).then(tabs => Promise.all(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: "ig-download-history-changed" }).catch(() => {})))).catch(() => {});
});
