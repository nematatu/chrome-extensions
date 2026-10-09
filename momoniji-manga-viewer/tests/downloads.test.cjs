'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Core = require('../extension/download-core.js');

const URL_ROOT = 'https://momoniji.com/架空の漫画/';
const IMAGE_ROOT = 'https://img.momoniji.com/synthetic-fixtures/';
const clone = value => value === undefined ? undefined : structuredClone(value);
function manga(count = 4, overrides = {}) {
  return { title: 'テスト作品', pageUrl: URL_ROOT, images: Array.from({ length: count }, (_, index) => `${IMAGE_ROOT}${index + 1}.jpg`), ...overrides };
}
function fixture(initial, options = {}) {
  let stored = clone(initial);
  let time = 1780000000000;
  let id = 0;
  let failSave = false;
  let failStarts = 0;
  const records = new Map();
  const calls = []; const cancellations = []; const removals = []; const notices = []; const saves = []; const schedules = [];
  const api = {
    extensionId: 'test-extension',
    async load() { return clone(stored); },
    async save(state) {
      if (failSave) throw new Error('Sensitive API error must not leave this layer');
      stored = clone(state); saves.push(clone(state));
    },
    async download(request) {
      calls.push(clone(request));
      assert.ok(stored.jobs.some(job => job.pages.some(page => page.url === request.url && page.state === 'starting')), 'Journal must exist before download side effects');
      if (failStarts > 0) { failStarts -= 1; throw new Error('Synthetic network error'); }
      id += 1;
      records.set(id, { id, byExtensionId: api.extensionId, state: 'in_progress', url: request.url, finalUrl: request.url, filename: `/Downloads/${request.filename}`, mime: 'image/jpeg', startTime: new Date(time).toISOString() });
      return id;
    },
    async search(query) {
      const matches = [...records.values()].filter(item => query.id === undefined || item.id === query.id).filter(item => !query.url || item.url === query.url).filter(item => !query.startedAfter || item.startTime >= query.startedAfter);
      return clone(matches);
    },
    async cancel(downloadId) {
      cancellations.push(downloadId);
      const item = records.get(downloadId);
      if (item && item.state === 'in_progress') Object.assign(item, { state: 'interrupted', error: 'USER_CANCELED' });
    },
    async removeFile(downloadId) { removals.push(downloadId); records.get(downloadId).exists = false; },
    async notify(tabId, job) { notices.push({ tabId, job: clone(job) }); },
    async schedule(pending, nextAt) { schedules.push({ pending, nextAt }); }
  };
  const controller = new Core.Controller(api, { now: () => time });
  return { controller, api, records, calls, cancellations, removals, notices, saves, schedules, stored: () => clone(stored), time: () => time,
    advance(ms) { time += ms; }, failSave(value) { failSave = value; }, failStarts(value) { failStarts = value; },
    async change(downloadId, state, extra = {}) {
      Object.assign(records.get(downloadId), { state }, extra);
      await controller.changed({ id: downloadId, state: { current: state } });
    },
    async init() { await controller.init(); return this; }, ...options };
}

test('canonical pages match Japanese paths, lower-case escapes, encoded trailing slash and paginated articles', () => {
  const canonical = Core.canonicalPageUrl(URL_ROOT);
  assert.equal(canonical, Core.canonicalPageUrl('https://momoniji.com/%e6%9e%b6%e7%a9%ba%e3%81%ae%e6%bc%ab%e7%94%bb%2f'));
  assert.equal(canonical, Core.canonicalPageUrl(`${URL_ROOT}page/2/?utm_source=fixture#panel`));
  assert.equal(canonical, Core.canonicalPageUrl(`${URL_ROOT}page/999`));
  assert.throws(() => Core.canonicalPageUrl('https://momoniji.com/%ff/'));
  assert.throws(() => Core.canonicalPageUrl('https://momoniji.com/'));
  assert.throws(() => Core.canonicalPageUrl('https://other.example/作品/'));
});
test('folder and filenames cannot traverse paths and preserve page order with stable IDs', () => {
  const normalized = Core.normalizeManga(manga(2, { title: '../ CON\\<>:"|?*\n作品.. /' }));
  assert.match(normalized.folder, /^momoniji-manga-viewer\/[^/\\]+-[a-f0-9]{16}$/u);
  assert.ok(!normalized.folder.includes('..'));
  assert.ok(!/[<>:"\\|?*\u0000-\u001f]/u.test(normalized.folder));
  const job = { ...normalized, pages: normalized.images.map(url => ({ url })) };
  assert.equal(Core.filenameFor(job, job.pages[0], 0), `${normalized.folder}/0001.jpg`);
  assert.equal(Core.filenameFor(job, { url: `${IMAGE_ROOT}2.JPEG?fixture=1` }, 1), `${normalized.folder}/0002.jpg`);
  assert.equal(Core.filenameFor(job, { url: `${IMAGE_ROOT}3.jp%67` }, 2), `${normalized.folder}/0003.jpg`);
  assert.equal(Core.safeTitle('CON'), '_CON');
  assert.equal(Core.safeTitle('...'), '_');
  assert.ok(Buffer.byteLength(Core.safeTitle('あ'.repeat(100))) <= 96);
  assert.equal(Core.normalizeManga(manga(2)).id, Core.normalizeManga(manga(2, { pageUrl: `${URL_ROOT}page/2/`, title: 'タイトルが変化' })).id);
});
test('reject unsupported schemes, deceptive hosts, credentials, executable URLs and oversized payloads', () => {
  for (const url of ['http://img.momoniji.com/1.jpg', 'file:///1.jpg', 'data:image/jpeg;base64,AAAA', 'https://img.momoniji.com.evil.example/1.jpg', 'https://evil.example/1.jpg', 'https://user:pass@img.momoniji.com/1.jpg', 'https://img.momoniji.com:8443/1.jpg', `${IMAGE_ROOT}1.exe`, `${IMAGE_ROOT}1.svg`, `${IMAGE_ROOT}%00.jpg`, `${IMAGE_ROOT}%5c1.jpg`]) {
    assert.throws(() => Core.normalizeManga(manga(1, { images: [url] })), { code: 'INVALID_URL' });
  }
  assert.throws(() => Core.normalizeManga(manga(1001)), { code: 'TOO_MANY_IMAGES' });
  assert.throws(() => Core.normalizeManga(manga(1, { images: [`${IMAGE_ROOT}${'x'.repeat(2048)}.jpg`] })), { code: 'INVALID_URL' });
  assert.throws(() => Core.normalizeManga(manga(400, { images: Array.from({ length: 400 }, (_, index) => `${IMAGE_ROOT}${index}-${'x'.repeat(900)}.jpg`) })), { code: 'PAYLOAD_TOO_LARGE' });
  assert.throws(() => Core.normalizeManga(manga(1, { images: [`${IMAGE_ROOT}1.jpg`, `${IMAGE_ROOT}1.jpg#dup`] })), { code: 'INVALID_REQUEST' });
  assert.throws(() => Core.normalizeManga(manga(0)), { code: 'INVALID_REQUEST' });
});
test('messages require extension identity, top frame and the same article', () => {
  const sender = { id: 'test-extension', tab: { id: 7 }, frameId: 0, url: `${URL_ROOT}page/2/` };
  assert.equal(Core.authorizedSender(sender, 'test-extension', URL_ROOT), true);
  assert.equal(Core.authorizedSender({ ...sender, id: 'external-extension' }, 'test-extension', URL_ROOT), false);
  assert.equal(Core.authorizedSender({ ...sender, frameId: 1 }, 'test-extension', URL_ROOT), false);
  assert.equal(Core.authorizedSender({ ...sender, tab: undefined }, 'test-extension', URL_ROOT), false);
  assert.equal(Core.authorizedSender({ ...sender, url: 'https://evil.example/作品/' }, 'test-extension', URL_ROOT), false);
  assert.equal(Core.authorizedSender(sender, 'test-extension', 'https://momoniji.com/別の作品/'), false);
});
test('start persists before API calls, limits concurrency and counts only confirmed complete transfers', async () => {
  const f = await fixture().init();
  const job = await f.controller.start(manga(4), 7);
  assert.equal(job.total, 4); assert.equal(job.completed, 0); assert.equal(job.active, 2); assert.equal(job.pending, 2);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.filename.slice(-8)), ['0001.jpg', '0002.jpg']);
  assert.ok(f.calls.every(call => call.saveAs === false && call.conflictAction === 'uniquify'));
  await f.change(1, 'complete');
  assert.equal(f.calls.length, 3);
  assert.equal((await f.controller.status(URL_ROOT)).completed, 1);
  await f.controller.changed({ id: 1, state: { current: 'complete' } });
  assert.equal((await f.controller.status(URL_ROOT)).completed, 1, 'Duplicate events must not double-count');
  await f.change(2, 'complete'); await f.change(3, 'complete'); await f.change(4, 'complete');
  const final = await f.controller.status(URL_ROOT);
  assert.equal(final.state, 'completed'); assert.equal(final.completed, 4); assert.equal(final.active, 0);
  assert.equal(f.schedules.at(-1).pending, false);
  assert.ok(!('images' in final) && !('pages' in final));
  assert.ok(f.notices.some(notice => notice.job.completed === 4));
});
test('concurrent duplicate START requests do not enqueue duplicate downloads', async () => {
  const f = await fixture().init();
  const results = await Promise.all([f.controller.start(manga(4), 7), f.controller.start(manga(4), 8), f.controller.start(manga(4), 9)]);
  assert.equal(f.calls.length, 2); assert.equal(f.stored().jobs.length, 1);
  assert.ok(results.every(job => job.id === results[0].id));
  assert.equal(f.stored().jobs[0].tabId, 9);
});
test('network interruption retries after a delay and stops after three attempts', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  await f.change(1, 'interrupted', { error: 'NETWORK_TIMEOUT' });
  assert.equal((await f.controller.status(URL_ROOT)).completed, 0);
  assert.equal((await f.controller.status(URL_ROOT)).pending, 1); assert.equal(f.calls.length, 1);
  await f.controller.reconcile(); assert.equal(f.calls.length, 1);
  f.advance(Core.RETRY_DELAY_MS); await f.controller.reconcile(); assert.equal(f.calls.length, 2);
  await f.change(2, 'interrupted', { error: 'NETWORK_TIMEOUT' });
  f.advance(Core.RETRY_DELAY_MS); await f.controller.reconcile(); assert.equal(f.calls.length, 3);
  await f.change(3, 'interrupted', { error: 'NETWORK_TIMEOUT' });
  const job = await f.controller.status(URL_ROOT);
  assert.equal(job.state, 'failed'); assert.equal(job.failed, 1); assert.deepEqual(job.failures, [{ page: 1, reason: 'NETWORK_TIMEOUT' }]);
  f.advance(Core.RETRY_DELAY_MS); await f.controller.reconcile(); assert.equal(f.calls.length, 3);
});
test('start errors are bounded and expose only a fixed safe reason', async () => {
  const f = await fixture().init(); f.failStarts(3);
  await f.controller.start(manga(1), 7);
  for (let index = 0; index < 2; index += 1) { f.advance(Core.RETRY_DELAY_MS); await f.controller.reconcile(); }
  const job = await f.controller.status(URL_ROOT);
  assert.equal(job.state, 'failed'); assert.equal(job.failures[0].reason, 'START_FAILED'); assert.equal(f.calls.length, 3);
});
test('manual retry retains completed pages and retries permanent failures', async () => {
  const f = await fixture().init(); await f.controller.start(manga(2), 7);
  await f.change(1, 'complete'); await f.change(2, 'interrupted', { error: 'SERVER_FORBIDDEN' });
  assert.equal((await f.controller.status(URL_ROOT)).failed, 1);
  const job = await f.controller.retry(URL_ROOT, 7);
  assert.equal(job.completed, 1); assert.equal(job.active, 1); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].filename, f.calls[1].filename);
  await f.change(3, 'complete'); assert.equal((await f.controller.status(URL_ROOT)).state, 'completed');
});
test('cancel stops active downloads, leaves saved pages intact and permits resuming remaining pages', async () => {
  const f = await fixture().init(); await f.controller.start(manga(5), 7);
  await f.change(1, 'complete');
  const job = await f.controller.cancel(URL_ROOT);
  assert.equal(job.state, 'cancelled'); assert.equal(job.completed, 1); assert.equal(job.cancelled, 4); assert.equal(job.pending, 0);
  assert.deepEqual(f.cancellations.sort((a, b) => a - b), [2, 3]); assert.equal(f.calls.length, 3);
  f.advance(Core.RETRY_DELAY_MS); await f.controller.reconcile(); assert.equal(f.calls.length, 3);
  const resumed = await f.controller.retry(URL_ROOT, 7);
  assert.equal(resumed.completed, 1); assert.equal(resumed.active, 2); assert.equal(resumed.pending, 2);
});
test('Chrome user cancellation is not automatically retried', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  await f.change(1, 'interrupted', { error: 'USER_CANCELED' });
  assert.equal((await f.controller.status(URL_ROOT)).state, 'cancelled');
  f.advance(Core.RETRY_DELAY_MS); await f.controller.reconcile(); assert.equal(f.calls.length, 1);
});
test('a restarted worker reconciles missed completion events and resumes queued pages', async () => {
  const f = await fixture().init(); await f.controller.start(manga(4), 7);
  Object.assign(f.records.get(1), { state: 'complete' });
  const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
  const job = await restored.status(URL_ROOT);
  assert.equal(job.completed, 1); assert.equal(job.active, 2); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].filename.slice(-8), '0003.jpg');
});
test('a worker stopped between Chrome download start and ID storage adopts the existing transfer', async () => {
  const f = await fixture().init(); await f.controller.start(manga(2), 7);
  const state = f.stored();
  state.jobs[0].pages[0].state = 'starting'; state.jobs[0].pages[0].downloadId = null;
  await f.api.save(state);
  const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
  const job = await restored.status(URL_ROOT);
  assert.equal(job.active, 2); assert.equal(f.calls.length, 2);
  assert.equal(f.stored().jobs[0].pages[0].downloadId, 1);
});
test('recovery does not adopt a transfer owned by another extension', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  const state = f.stored(); state.jobs[0].pages[0].state = 'starting'; state.jobs[0].pages[0].downloadId = null;
  f.records.get(1).byExtensionId = 'different-extension'; await f.api.save(state);
  const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
  assert.equal((await restored.status(URL_ROOT)).pending, 1);
  assert.equal(f.calls.length, 1);
});
test('restore retains retry delay and resumes only when due', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  await f.change(1, 'interrupted', { error: 'NETWORK_TIMEOUT' });
  const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
  assert.equal(f.calls.length, 1); f.advance(Core.RETRY_DELAY_MS); await restored.reconcile(); assert.equal(f.calls.length, 2);
});
test('cancelled job is cancelled again on restart until Chrome confirms interruption', async () => {
  const f = await fixture().init(); await f.controller.start(manga(2), 7);
  const state = f.stored(); state.jobs[0].cancelRequested = true; await f.api.save(state);
  const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
  assert.equal((await restored.status(URL_ROOT)).state, 'cancelled'); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.cancellations, [1, 2]);
});
test('HTML responses and redirects outside approved image hosts never count as saved images', async () => {
  const f = await fixture().init(); await f.controller.start(manga(2), 7);
  await f.change(1, 'complete', { mime: 'text/html' });
  await f.change(2, 'complete', { finalUrl: 'https://evil.example/file.jpg' });
  const job = await f.controller.status(URL_ROOT);
  assert.equal(job.completed, 0); assert.equal(job.failed, 2);
  assert.deepEqual(job.failures.map(value => value.reason), ['UNEXPECTED_CONTENT', 'BLOCKED_URL']);
  assert.deepEqual(f.removals, [1, 2]);
});
test('cleanup never removes a completed file with a different owner, URL or filename', async () => {
  for (const changed of [{ byExtensionId: 'other-extension' }, { url: `${IMAGE_ROOT}unrelated.jpg` }, { filename: '/Downloads/unrelated.jpg' }]) {
    const f = await fixture().init(); await f.controller.start(manga(1), 7);
    await f.change(1, 'complete', { mime: 'text/html', ...changed });
    assert.equal((await f.controller.status(URL_ROOT)).completed, 0); assert.deepEqual(f.removals, []);
  }
});
test('Chrome filename conflict counters are accepted for safe completed-file cleanup', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  const filename = f.records.get(1).filename.replace('.jpg', ' (1).jpg');
  await f.change(1, 'complete', { mime: 'text/html', filename });
  assert.deepEqual(f.removals, [1]);
});
test('a failed file cleanup is visible as a fixed reason without exception contents', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  f.api.removeFile = async () => { throw new Error('secret filesystem information'); };
  await f.change(1, 'complete', { mime: 'text/html' });
  assert.equal((await f.controller.status(URL_ROOT)).failures[0].reason, 'UNEXPECTED_CONTENT_FILE_REMAINS');
});
test('unexpected MIME or redirect events interrupt a transfer before completion', async () => {
  const f = await fixture().init(); await f.controller.start(manga(2), 7);
  await f.controller.changed({ id: 1, mime: { current: 'text/html' } });
  await f.controller.changed({ id: 2, finalUrl: { current: 'https://evil.example/file.jpg' } });
  assert.equal((await f.controller.status(URL_ROOT)).failed, 2); assert.deepEqual(f.cancellations, [1, 2]);
});
test('storage failure prevents starting unjournalled download side effects', async () => {
  const f = await fixture().init(); f.failSave(true);
  await assert.rejects(() => f.controller.start(manga(2), 7), { code: 'STORAGE_FAILED' });
  assert.equal(f.calls.length, 0);
});
test('malformed journal entries are discarded without initiating downloads', async () => {
  const f = await fixture({ version: 1, jobs: [{ title: '../', pageUrl: URL_ROOT, id: 'malformed', folder: '../../outside', pages: [{ url: 'https://evil.example/payload.exe' }] }] }).init();
  assert.equal(f.stored().jobs.length, 0); assert.equal(f.calls.length, 0);
});
test('unrelated download events do not mutate the queue', async () => {
  const f = await fixture().init(); await f.controller.start(manga(2), 7);
  const previous = f.stored(); await f.controller.changed({ id: 9999, state: { current: 'complete' } }); await f.controller.erased(9999);
  assert.deepEqual(f.stored(), previous); assert.equal(f.calls.length, 2);
});
test('concurrency applies across works and queued work proceeds after an earlier work finishes', async () => {
  const f = await fixture().init(); await f.controller.start(manga(2), 7);
  await f.controller.start(manga(1, { pageUrl: 'https://momoniji.com/作品B/' }), 8);
  assert.equal(f.calls.length, 2);
  await f.change(1, 'complete'); assert.equal(f.calls.length, 3);
  assert.equal((await f.controller.status('https://momoniji.com/作品B/')).active, 1);
});
test('retry cannot exceed the three-work limit and leaves the failed journal intact', async () => {
  const f = await fixture().init();
  await f.controller.start(manga(1), 7); await f.change(1, 'interrupted', { error: 'SERVER_FORBIDDEN' });
  for (let index = 1; index <= 3; index += 1) await f.controller.start(manga(1, { pageUrl: `https://momoniji.com/active-${index}/` }), 7);
  const before = f.stored();
  await assert.rejects(() => f.controller.retry(URL_ROOT, 7), { code: 'TOO_MANY_JOBS' });
  assert.deepEqual(f.stored(), before);
  assert.equal(f.stored().jobs.filter(job => job.state === 'running').length, 3);
  await f.change(2, 'complete');
  const retried = await f.controller.retry(URL_ROOT, 7);
  assert.equal(retried.state, 'running'); assert.equal(f.stored().jobs.filter(job => job.state === 'running').length, 3);
});
test('manual cancellation never touches an ID belonging to another owner, original URL or path', async () => {
  for (const changed of [{ byExtensionId: 'other-extension' }, { byExtensionId: undefined }, { url: `${IMAGE_ROOT}unrelated.jpg` }, { filename: '/Downloads/unrelated.jpg' }]) {
    const f = await fixture().init(); await f.controller.start(manga(1), 7);
    Object.assign(f.records.get(1), changed);
    await f.controller.cancel(URL_ROOT);
    assert.deepEqual(f.cancellations, []); assert.deepEqual(f.removals, []);
    assert.equal(f.records.get(1).state, 'in_progress');
  }
});
test('recovery with a corrupt journal ID cannot cancel another extension or unrelated user download', async () => {
  for (const changed of [{ byExtensionId: 'other-extension' }, { byExtensionId: undefined }, { url: `${IMAGE_ROOT}unrelated.jpg` }, { filename: '/Downloads/unrelated.jpg' }]) {
    const f = await fixture().init(); await f.controller.start(manga(1), 7);
    const state = f.stored(); state.jobs[0].cancelRequested = true;
    await f.api.save(state); Object.assign(f.records.get(1), changed);
    const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
    assert.deepEqual(f.cancellations, []); assert.deepEqual(f.removals, []);
    assert.equal(f.records.get(1).state, 'in_progress');
  }
});
test('blocking a suspect response never cancels another owner, URL or unrelated path', async () => {
  for (const changed of [{ byExtensionId: 'other-extension' }, { byExtensionId: undefined }, { url: `${IMAGE_ROOT}unrelated.jpg` }, { filename: '/Downloads/unrelated.jpg' }]) {
    const f = await fixture().init(); await f.controller.start(manga(1), 7);
    Object.assign(f.records.get(1), changed);
    await f.controller.changed({ id: 1, mime: { current: 'text/html' } });
    assert.deepEqual(f.cancellations, []); assert.deepEqual(f.removals, []);
    assert.equal(f.records.get(1).state, 'in_progress');
  }
});
test('finished work history is bounded and explicit fresh starts do not overwrite files', async () => {
  const f = await fixture().init();
  for (let index = 0; index < 10; index += 1) {
    const work = manga(1, { pageUrl: `https://momoniji.com/作品${index}/` });
    await f.controller.start(work, 7); await f.change(index + 1, 'complete');
  }
  assert.equal(f.stored().jobs.length, 8);
  assert.equal(await f.controller.status('https://momoniji.com/作品0/'), null);
  await f.controller.start(manga(1, { pageUrl: 'https://momoniji.com/作品9/' }), 7);
  assert.equal(f.calls.length, 11); assert.equal(f.calls.at(-1).conflictAction, 'uniquify');
});

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}
function loadBackground() {
  const onMessage = event(); const onChanged = event(); const onErased = event(); const onDeterminingFilename = event(); const onAlarm = event();
  const f = fixture();
  const alarms = new Map(); const extraStorage = {}; let storageReads = 0; let accessLevel;
  const chrome = {
    runtime: { id: f.api.extensionId, onMessage, onStartup: event(), onInstalled: event(), async sendMessage() {} },
    storage: { local: {
      async get() { storageReads += 1; return { [Core.STORAGE_KEY]: await f.api.load(), ...extraStorage }; },
      async set(value) { if (Core.STORAGE_KEY in value) await f.api.save(value[Core.STORAGE_KEY]); else Object.assign(extraStorage, value); },
      async setAccessLevel(value) { accessLevel = value; }
    } },
    downloads: { onChanged, onErased, onDeterminingFilename, download: f.api.download, search: f.api.search, cancel: f.api.cancel, removeFile: f.api.removeFile },
    tabs: { async query() { return []; }, sendMessage: async (tabId, message) => f.api.notify(tabId, message.job) },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    contextMenus: { onClicked: event(), removeAll(callback) { callback(); }, create(options, callback) { callback(); return options.id; } },
    alarms: { onAlarm, async get(name) { return alarms.get(name); }, async create(name, value) { alarms.set(name, value); }, async clear(name) { alarms.delete(name); } }
  };
  const context = vm.createContext({ chrome, URL, TextEncoder, Date, console, setTimeout, clearTimeout });
  context.importScripts = filename => vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', filename), 'utf8'), context, { filename });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context, { filename: 'background.js' });
  return { f, chrome, alarms, accessLevel: () => accessLevel, storageReads: () => storageReads,
    send(message, sender = { id: f.api.extensionId, tab: { id: 7 }, frameId: 0, url: URL_ROOT }) {
      return new Promise(resolve => { const result = onMessage.listeners[0](message, sender, response => resolve(clone(response))); if (result === false && !message.type?.startsWith('MOMONIJI_DOWNLOAD_')) resolve(undefined); });
    } };
}
test('background returns forbidden before storage/download API access for external and mismatched messages', async () => {
  const b = loadBackground();
  const denied = await b.send({ type: 'MOMONIJI_DOWNLOAD_START', manga: manga(1) }, { id: 'external', tab: { id: 7 }, frameId: 0, url: URL_ROOT });
  assert.equal(denied.code, 'FORBIDDEN'); assert.equal(b.storageReads(), 0); assert.equal(b.f.calls.length, 0);
  const crossArticle = await b.send({ type: 'MOMONIJI_DOWNLOAD_STATUS', pageUrl: 'https://momoniji.com/別作品/' });
  assert.equal(crossArticle.code, 'FORBIDDEN'); assert.equal(b.storageReads(), 0);
  assert.equal(b.accessLevel().accessLevel, 'TRUSTED_CONTEXTS');
});
test('background message contract starts, queries, cancels and retries with recoverable alarms', async () => {
  const b = loadBackground();
  const started = await b.send({ type: 'MOMONIJI_DOWNLOAD_START', manga: manga(3) });
  assert.equal(started.ok, true); assert.equal(started.job.completed, 0); assert.equal(started.job.active, 2);
  assert.equal(b.alarms.get('momoniji-download-recovery').periodInMinutes, 1);
  const status = await b.send({ type: 'MOMONIJI_DOWNLOAD_STATUS', pageUrl: URL_ROOT }); assert.equal(status.job.total, 3);
  const cancelled = await b.send({ type: 'MOMONIJI_DOWNLOAD_CANCEL', pageUrl: URL_ROOT }); assert.equal(cancelled.job.cancelled, 3);
  assert.equal(b.alarms.has('momoniji-download-recovery'), false);
  const retried = await b.send({ type: 'MOMONIJI_DOWNLOAD_RETRY', pageUrl: URL_ROOT }); assert.equal(retried.job.active, 2);
});
test('background rejects malicious URL input without echoing URL or API exception text', async () => {
  const b = loadBackground();
  const response = await b.send({ type: 'MOMONIJI_DOWNLOAD_START', manga: manga(1, { images: ['https://evil.example/payload.exe?private=secret'] }) });
  assert.equal(response.ok, false); assert.equal(response.code, 'INVALID_URL');
  assert.ok(!JSON.stringify(response).includes('secret')); assert.equal(b.f.calls.length, 0);
});

test('filename determination suggests the journalled subdirectory before the start ID is returned', async () => {
  const f = fixture();
  const download = f.api.download;
  f.api.download = async request => {
    const id = await download(request);
    assert.equal(f.controller.determineFilename(f.records.get(id)), request.filename);
    assert.equal(f.controller.determineFilename({ ...f.records.get(id), byExtensionId: 'other-extension' }), null);
    return id;
  };
  await f.init(); await f.controller.start(manga(1), 7);
  assert.equal(f.controller.determineFilename(f.records.get(1)), f.calls[0].filename);
  assert.equal(f.controller.determineFilename({ ...f.records.get(1), url: `${IMAGE_ROOT}unrelated.jpg` }), null);
});
test('background responds once to filename events and leaves other downloads unchanged', async () => {
  const b = loadBackground();
  await b.send({ type: 'MOMONIJI_DOWNLOAD_START', manga: manga(1) });
  const listener = b.chrome.downloads.onDeterminingFilename.listeners[0];
  const suggestions = [];
  listener(b.f.records.get(1), suggestion => suggestions.push(clone(suggestion)));
  assert.deepEqual(suggestions, [{ filename: b.f.calls[0].filename, conflictAction: 'uniquify' }]);
  listener({ ...b.f.records.get(1), byExtensionId: 'other-extension' }, suggestion => suggestions.push(clone(suggestion)));
  assert.equal(suggestions.length, 2); assert.equal(suggestions[1], undefined);
});
test('filename recovery reads the durable journal without waiting for the running queue', { timeout: 1000 }, async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  const fresh = new Core.Controller(f.api, { now: f.time });
  fresh.chain = new Promise(() => {}); // A downloads.download() call could be waiting for this filename event.
  assert.equal(fresh.determineFilename(f.records.get(1)), null);
  assert.equal(await fresh.recoverFilename(f.records.get(1)), f.calls[0].filename);
  const state = f.stored(); state.jobs[0].pages[0].state = 'starting'; state.jobs[0].pages[0].downloadId = null;
  await f.api.save(state);
  assert.equal(await fresh.recoverFilename(f.records.get(1)), f.calls[0].filename, 'the ID need not have been journalled before the worker stopped');
  assert.equal(fresh.jobs.length, 0, 'read-only filename recovery does not initialize or mutate the queue');
  assert.equal(f.calls.length, 1);
});
test('filename recovery rejects unrelated downloads and corrupt stored destinations', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  const fresh = new Core.Controller(f.api, { now: f.time });
  let reads = 0; const load = f.api.load;
  f.api.load = async () => { reads++; return load(); };
  assert.equal(await fresh.recoverFilename({ ...f.records.get(1), byExtensionId: 'other-extension' }), null);
  assert.equal(reads, 0);
  assert.equal(await fresh.recoverFilename({ ...f.records.get(1), url: `${IMAGE_ROOT}unrelated.jpg` }), null);
  const state = f.stored(); state.jobs[0].folder = '../arbitrary'; await f.api.save(state);
  assert.equal(await fresh.recoverFilename(f.records.get(1)), null);
  await f.api.save({ version: Core.VERSION, jobs: Array(9).fill(state.jobs[0]) });
  assert.equal(await fresh.recoverFilename(f.records.get(1)), null);
  assert.equal(f.calls.length, 1);
});
test('a filename event waking a fresh background worker responds once from storage', { timeout: 1000 }, async () => {
  const b = loadBackground();
  await b.f.init(); await b.f.controller.start(manga(1), 7);
  const listener = b.chrome.downloads.onDeterminingFilename.listeners[0];
  let calls = 0, result;
  await new Promise(resolve => {
    result = listener(b.f.records.get(1), suggestion => {
      calls++; assert.equal(suggestion.filename, b.f.calls[0].filename); resolve();
    });
  });
  assert.equal(result, true, 'the listener keeps Chrome waiting for the asynchronous storage read');
  assert.equal(calls, 1); assert.equal(b.f.calls.length, 1);
  b.chrome.storage.local.get = async () => { throw new Error('private storage exception'); };
  await new Promise(resolve => {
    assert.equal(listener(b.f.records.get(1), suggestion => { assert.equal(suggestion, undefined); calls++; resolve(); }), true);
  });
  assert.equal(calls, 2, 'storage failure also responds exactly once');
});
test('legacy queues resume safely in their recorded folder while fresh starts use the extension directory', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  const state = f.stored();
  state.jobs[0].folder = state.jobs[0].folder.replace(/^momoniji-manga-viewer\//, 'momoniji/');
  f.records.get(1).filename = f.records.get(1).filename.replace('/momoniji-manga-viewer/', '/momoniji/');
  Object.assign(f.records.get(1), { state: 'complete' });
  await f.api.save(state);
  const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
  assert.equal((await restored.status(URL_ROOT)).completed, 1);
  await restored.start(manga(1), 7);
  assert.ok(f.calls.at(-1).filename.startsWith('momoniji-manga-viewer/'));
});
test('an unrelated folder in a stored job is rejected instead of being accepted as a migration', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  const state = f.stored(); state.jobs[0].folder = 'unrelated/other'; await f.api.save(state);
  const restored = new Core.Controller(f.api, { now: f.time }); await restored.init();
  assert.equal(await restored.status(URL_ROOT), null);
});
test('completed downloads in another directory report SAVE_PATH_CHANGED without deleting the file', async () => {
  const f = await fixture().init(); await f.controller.start(manga(1), 7);
  await f.change(1, 'complete', { filename: '/Downloads/0001.jpg' });
  const job = await f.controller.status(URL_ROOT);
  assert.equal(job.completed, 0); assert.equal(job.failures[0].reason, 'SAVE_PATH_CHANGED');
  assert.deepEqual(f.cancellations, []); assert.deepEqual(f.removals, []);
});
