/* All listeners are registered synchronously so MV3 events can wake this worker. */
'use strict';
importScripts('download-core.js');
importScripts('library-core.js');

const Core = globalThis.MomonijiDownloads;
const Library = globalThis.MomonijiLibrary;
const LIBRARY_MENU = 'momoniji-read-later';
const RECOVERY_ALARM = 'momoniji-download-recovery';
const RETRY_ALARM = 'momoniji-download-retry';
const libraryController = new Library.Controller({
  async load() { return (await chrome.storage.local.get(Library.STORAGE_KEY))[Library.STORAGE_KEY]; },
  async save(state) { await chrome.storage.local.set({ [Library.STORAGE_KEY]: state }); },
  changed: broadcastLibrary
});
const controller = new Core.Controller({
  extensionId: chrome.runtime.id,
  async load() { return (await chrome.storage.local.get(Core.STORAGE_KEY))[Core.STORAGE_KEY]; },
  async save(state) {
    await chrome.storage.local.set({ [Core.STORAGE_KEY]: state });
    await recordCompletedDownloads(state);
  },
  download: options => chrome.downloads.download(options),
  search: query => chrome.downloads.search(query),
  cancel: id => chrome.downloads.cancel(id),
  removeFile: id => chrome.downloads.removeFile(id),
  async notify(tabId, job) { await chrome.tabs.sendMessage(tabId, { type: 'MOMONIJI_DOWNLOAD_PROGRESS', job }); },
  async schedule(pending, nextAttemptAt) {
    if (pending) {
      if (!(await chrome.alarms.get(RECOVERY_ALARM))) await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 1 });
    } else await chrome.alarms.clear(RECOVERY_ALARM);
    if (nextAttemptAt !== null) await chrome.alarms.create(RETRY_ALARM, { when: Math.max(Date.now() + 1000, nextAttemptAt) });
    else await chrome.alarms.clear(RETRY_ALARM);
  }
});

// Restrict the persistent URL journal to extension contexts, where supported.
const storageAccessReady = chrome.storage.local.setAccessLevel ? chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }) : Promise.resolve();
let ready;
let libraryReady;
const libraryRecordWarnings = new Set();
const completedLibraryRuns = new Set();
async function broadcastLibrary(result) {
  const message = { type: 'MOMONIJI_LIBRARY_CHANGED', ...result };
  await chrome.action.setBadgeText({ text: result.unreadCount ? String(Math.min(result.unreadCount, 99)) + (result.unreadCount > 99 ? '+' : '') : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.runtime.sendMessage(message).catch(() => {});
  const tabs = await chrome.tabs.query({ url: ['https://momoniji.com/*', 'https://www.momoniji.com/*'] });
  await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => chrome.tabs.sendMessage(tab.id, message, { frameId: 0 })));
}
function initializeLibrary() {
  if (!libraryReady) libraryReady = storageAccessReady.then(async () => {
    await libraryController.init();
    for (const entry of libraryController.entries) if (entry.downloadedRun) completedLibraryRuns.add(entry.downloadedRun);
    const stored = (await chrome.storage.local.get(Core.STORAGE_KEY))[Core.STORAGE_KEY];
    await recordCompletedDownloads(stored, true);
    await broadcastLibrary(await libraryController.list());
  }).catch(error => { libraryReady = null; throw error; });
  return libraryReady;
}
async function recordCompletedDownloads(state, initialized = false) {
  if (state?.version !== Core.VERSION || !Array.isArray(state.jobs) || state.jobs.length > 8) return;
  const finished = state.jobs.filter(job => job?.state === 'completed' && Array.isArray(job.pages) && job.pages.length && job.pages.every(page => page.state === 'complete' && Number.isInteger(page.downloadId) && page.downloadId >= 0));
  if (!finished.length) return;
  try { if (!initialized) await initializeLibrary(); }
  catch { for (const job of finished) await warnLibraryRecord(job); return; }
  for (const job of finished) {
    try {
      const run = `${job.id}:${job.createdAt}:${job.pages.at(-1).downloadId}`;
      if (completedLibraryRuns.has(run)) continue;
      const normalized = Core.normalizeManga({ title: job.title, pageUrl: job.pageUrl, images: job.pages.map(page => page.url) });
      const legacy = `momoniji/${Core.safeTitle(normalized.title)}-${normalized.id}`;
      if (job.id !== normalized.id || ![normalized.folder, legacy].includes(job.folder)) continue;
      await libraryController.recordDownload({ url: job.pageUrl, title: job.title, total: job.pages.length, folder: job.folder,
        completedAt: job.updatedAt, run });
      completedLibraryRuns.add(run);
    } catch { await warnLibraryRecord(job); }
  }
}
async function warnLibraryRecord(job) {
  const warning = `${job.id}:${job.createdAt}`;
  if (!libraryRecordWarnings.has(warning) && Number.isInteger(job.tabId)) {
    libraryRecordWarnings.add(warning);
    await chrome.tabs.sendMessage(job.tabId, { type: 'MOMONIJI_LIBRARY_NOTICE', ok: false,
      message: '画像は保存できましたが、作品の保存履歴を記録できませんでした。後で読む一覧と空き容量をご確認ください。' }, { frameId: 0 }).catch(() => {});
  }
}
function initialize() {
  if (!ready) ready = storageAccessReady.then(() => controller.init()).catch(error => { ready = null; throw error; });
  return ready;
}
function safeError(error) {
  const code = error instanceof Core.DownloadError ? error.code : 'INTERNAL_ERROR';
  return { ok: false, code, error: Core.ERRORS[code] || Core.ERRORS.INTERNAL_ERROR };
}
function allowedMessage(message, sender) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (!['MOMONIJI_DOWNLOAD_START', 'MOMONIJI_DOWNLOAD_STATUS', 'MOMONIJI_DOWNLOAD_RETRY', 'MOMONIJI_DOWNLOAD_CANCEL'].includes(message.type)) return false;
  const pageUrl = message.type === 'MOMONIJI_DOWNLOAD_START' ? message.manga && message.manga.pageUrl : message.pageUrl;
  return Core.authorizedSender(sender, chrome.runtime.id, pageUrl);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('MOMONIJI_DOWNLOAD_')) return false;
  if (!allowedMessage(message, sender)) { respond(safeError(new Core.DownloadError('FORBIDDEN'))); return false; }
  (async () => {
    await initialize();
    let job;
    if (message.type === 'MOMONIJI_DOWNLOAD_START') job = await controller.start(message.manga, sender.tab.id);
    else if (message.type === 'MOMONIJI_DOWNLOAD_STATUS') job = await controller.status(message.pageUrl, sender.tab.id);
    else if (message.type === 'MOMONIJI_DOWNLOAD_RETRY') job = await controller.retry(message.pageUrl, sender.tab.id);
    else job = await controller.cancel(message.pageUrl);
    respond({ ok: true, job });
  })().catch(error => respond(safeError(error)));
  return true;
});

function allowedLibrarySender(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname === '/popup.html') return true;
    return url.protocol === 'https:' && Library.HOSTS.has(url.hostname) && !url.port && !url.username && !url.password && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && sender.tab.id >= 0;
  } catch { return false; }
}
function libraryError(error) {
  const code = error instanceof Library.LibraryError ? error.code : 'INTERNAL_ERROR';
  return { ok: false, code, error: Library.ERRORS[code] || Library.ERRORS.INTERNAL_ERROR };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !['MOMONIJI_LIBRARY_LIST', 'MOMONIJI_LIBRARY_SAVE', 'MOMONIJI_LIBRARY_REMOVE', 'MOMONIJI_LIBRARY_READ'].includes(message.type)) return false;
  if (!allowedLibrarySender(sender)) { respond(libraryError(new Library.LibraryError('FORBIDDEN'))); return false; }
  (async () => {
    await initializeLibrary();
    let result;
    if (message.type === 'MOMONIJI_LIBRARY_LIST') result = await libraryController.list();
    else if (message.type === 'MOMONIJI_LIBRARY_SAVE') result = await libraryController.save(message.work);
    else if (message.type === 'MOMONIJI_LIBRARY_REMOVE') result = await libraryController.remove(message.url);
    else result = await libraryController.markRead(message.url, message.read);
    respond({ ok: true, ...result });
  })().catch(error => respond(libraryError(error)));
  return true;
});
async function setupLibraryMenu() {
  // Callback forms also work on the declared Chrome 120 minimum.
  await new Promise((resolve, reject) => chrome.contextMenus.removeAll(() => chrome.runtime.lastError ? reject(new Library.LibraryError('INTERNAL_ERROR')) : resolve()));
  await new Promise((resolve, reject) => chrome.contextMenus.create({ id: LIBRARY_MENU, title: 'この漫画を後で読むに保存', contexts: ['page', 'image', 'link'],
    documentUrlPatterns: ['https://momoniji.com/*', 'https://www.momoniji.com/*'] }, () => chrome.runtime.lastError ? reject(new Library.LibraryError('INTERNAL_ERROR')) : resolve()));
}
async function handleLibraryContextClick(info, tab) {
  if (info.menuItemId !== LIBRARY_MENU) return;
  try {
    if (!Number.isInteger(tab?.id) || tab.id < 0 || info.frameId && info.frameId !== 0) throw new Library.LibraryError('FORBIDDEN');
    const page = new URL(info.pageUrl || tab.url);
    if (page.protocol !== 'https:' || !Library.HOSTS.has(page.hostname) || page.port || page.username || page.password) throw new Library.LibraryError('FORBIDDEN');
    const url = Library.canonicalWorkUrl(info.linkUrl || info.pageUrl || tab.url);
    await initializeLibrary();
    const resolved = await chrome.tabs.sendMessage(tab.id, { type: 'MOMONIJI_LIBRARY_RESOLVE', url }, { frameId: 0 });
    if (!resolved?.ok || Library.canonicalWorkUrl(resolved.work?.url) !== url) throw new Library.LibraryError('INVALID_WORK');
    const result = await libraryController.save(resolved.work);
    await chrome.tabs.sendMessage(tab.id, { type: 'MOMONIJI_LIBRARY_NOTICE', ok: true, message: '後で読むに保存しました。' }, { frameId: 0 }).catch(() => {});
    return { ok: true, ...result };
  } catch (error) {
    const result = libraryError(error);
    if (Number.isInteger(tab?.id)) await chrome.tabs.sendMessage(tab.id, { type: 'MOMONIJI_LIBRARY_NOTICE', ok: false, message: result.error }, { frameId: 0 }).catch(() => {});
    return result;
  }
}
chrome.contextMenus.onClicked.addListener(handleLibraryContextClick);
chrome.downloads.onChanged.addListener(delta => { initialize().then(() => controller.changed(delta)).catch(() => {}); });
chrome.downloads.onErased.addListener(id => { initialize().then(() => controller.erased(id)).catch(() => {}); });
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = controller.determineFilename(item);
  // Suggest only for this extension's journalled transfers; every event gets one response.
  if (filename) suggest({ filename, conflictAction: 'uniquify' });
  else if (item.byExtensionId === chrome.runtime.id) {
    controller.recoverFilename(item).then(recovered => {
      if (recovered) suggest({ filename: recovered, conflictAction: 'uniquify' });
      else suggest();
    }, () => suggest());
    return true;
  }
  else suggest();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECOVERY_ALARM || alarm.name === RETRY_ALARM) initialize().then(() => controller.reconcile()).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { initialize().catch(() => {}); initializeLibrary().catch(() => {}); setupLibraryMenu().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { initialize().catch(() => {}); initializeLibrary().catch(() => {}); setupLibraryMenu().catch(() => {}); });
