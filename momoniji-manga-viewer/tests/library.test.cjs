'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Library = require('../extension/library-core.js');
const Downloads = require('../extension/download-core.js');
const WORK = { url: 'https://momoniji.com/test-library/', title: '後で読む・テスト漫画' };
const clone = value => structuredClone(value);
function fixture(stored) {
  let state = clone(stored), writes = 0, now = 1000;
  const updates = [];
  const api = { async load() { return clone(state); }, async save(value) { writes++; state = clone(value); }, async changed(result) { updates.push(clone(result)); } };
  const controller = new Library.Controller(api, { now: () => now });
  return { controller, api, updates, state: () => clone(state), writes: () => writes, advance: () => now += 1000,
    async init() { await controller.init(); return this; } };
}
function download(overrides = {}) {
  return { ...WORK, total: 2, folder: 'momoniji-manga-viewer/テスト-1234567890abcdef', completedAt: 1000, run: 'test:1000:2', ...overrides };
}
test('library canonicalizes encoded Japanese paths, page parts, www, query and fragments', () => {
  const canonical = Library.canonicalWorkUrl('https://momoniji.com/作品ガイド%2f');
  assert.equal(Library.canonicalWorkUrl('https://www.momoniji.com/作品ガイド/page/2/?source=test#c41'), canonical);
  assert.equal(Library.canonicalWorkUrl('https://momoniji.com/' + '作品ガイド'.normalize('NFD') + '/'), canonical);
});
test('percent and reserved characters remain stable through canonicalization and storage reload', async () => {
  const f = await fixture().init();
  for (const slug of ['test%25name', 'test%252f', 'test%3fname', 'test%23name', 'test%252e%252e']) {
    const url = Library.canonicalWorkUrl(`https://momoniji.com/${slug}/`);
    assert.equal(Library.canonicalWorkUrl(url), url);
    await f.controller.save({ url, title: '記号を含む作品' });
  }
  const restored = await fixture(f.state()).init();
  assert.deepEqual(await restored.controller.list(), await f.controller.list());
  assert.throws(() => Library.canonicalWorkUrl('https://momoniji.com/' + 'あ'.repeat(500) + '/'), { code: 'INVALID_URL' });
});
test('library refuses external hosts, script URLs, credentials, root/listing paths and malformed input', () => {
  for (const url of ['https://evil.example/work/', 'https://momoniji.com.evil.example/work/', 'javascript:alert(1)', 'http://momoniji.com/work/', 'https://user:secret@momoniji.com/work/', 'https://momoniji.com:444/work/', 'https://momoniji.com/', 'https://momoniji.com/category/test/', 'https://momoniji.com/tag/', 'https://momoniji.com/work/%zz', 'https://momoniji.com/work%5cname/', 3]) assert.throws(() => Library.canonicalWorkUrl(url), { code: 'INVALID_URL' });
  for (const title of ['', ' '.repeat(4), 'x'.repeat(513), null]) assert.throws(() => Library.normalizeWork({ ...WORK, title }));
});
test('concurrent saves and continuation URLs produce one persistent unread record', async () => {
  const f = await fixture().init();
  await Promise.all([f.controller.save(WORK), f.controller.save({ ...WORK, url: WORK.url + 'page/2/?x=1' }), f.controller.save(WORK)]);
  const list = await f.controller.list();
  assert.equal(list.entries.length, 1); assert.equal(list.unreadCount, 1); assert.equal(f.writes(), 1);
  f.advance(); await f.controller.markRead(WORK.url, true); await f.controller.save(WORK);
  assert.equal((await f.controller.list()).entries[0].read, true, 'repeated additions do not undo a read decision');
  assert.equal((await f.controller.list()).entries[0].addedAt, 1000);
});
test('worker reload retains records and download history independently of reading membership', async () => {
  const f = await fixture().init(); await f.controller.save(WORK); await f.controller.recordDownload(download());
  await f.controller.markRead(WORK.url, true); await f.controller.remove(WORK.url);
  const restored = await fixture(f.state()).init();
  const [entry] = (await restored.controller.list()).entries;
  assert.equal(entry.readLater, false); assert.equal(entry.downloadedCount, 2); assert.equal(entry.downloadedAt, 1000);
  assert.equal((await restored.controller.list()).unreadCount, 0);
  restored.advance(); await restored.controller.save(WORK);
  const [added] = (await restored.controller.list()).entries;
  assert.equal(added.readLater, true); assert.equal(added.read, false); assert.equal(added.downloadedCount, 2);
});
test('removing a reading-only work deletes its record and leaves unrelated works unchanged', async () => {
  const f = await fixture().init(); await f.controller.save(WORK); await f.controller.save({ url: 'https://momoniji.com/second/', title: '別作品' });
  await f.controller.remove(WORK.url); await f.controller.remove(WORK.url);
  const list = await f.controller.list(); assert.equal(list.entries.length, 1); assert.equal(list.entries[0].title, '別作品');
});
test('download recording is idempotent, does not mark unread, and records a fresh completed run', async () => {
  const f = await fixture().init();
  await f.controller.recordDownload(download()); await f.controller.recordDownload(download());
  assert.equal(f.writes(), 1); assert.equal((await f.controller.list()).unreadCount, 0);
  f.advance(); await f.controller.recordDownload(download({ completedAt: 2000, run: 'test:2000:4' }));
  assert.equal(f.writes(), 2); assert.equal((await f.controller.list()).entries[0].downloadedAt, 2000);
});
test('failed writes never update saved/read/deleted indicators or broadcast success', async () => {
  const f = await fixture().init(); await f.controller.save(WORK);
  const before = f.state(), updates = f.updates.length;
  f.api.save = async () => { throw new Error('private failure'); };
  for (const operation of [() => f.controller.save({ url: 'https://momoniji.com/second/', title: '別作品' }), () => f.controller.remove(WORK.url), () => f.controller.markRead(WORK.url, true), () => f.controller.recordDownload(download())]) await assert.rejects(operation(), { code: 'STORAGE_FAILED' });
  assert.deepEqual(f.state(), before); assert.equal(f.updates.length, updates);
  assert.equal((await f.controller.list()).entries[0].read, false);
});
test('unavailable or malformed persisted state is an error rather than an empty successful library', async () => {
  for (const value of [{ version: 99, entries: [] }, { version: 1, entries: [{ ...WORK }] }, { version: 1, entries: Array(Library.MAX_ENTRIES + 1).fill({}) }]) await assert.rejects(fixture(value).init());
  const f = fixture(); f.api.load = async () => { throw new Error('private data'); };
  await assert.rejects(f.init(), { code: 'STORAGE_FAILED' }); assert.equal(f.writes(), 0);
});
test('a full library preserves all existing records and still permits duplicate save and read/remove', async () => {
  const initial = await fixture().init(); await initial.controller.save(WORK);
  const template = initial.state().entries[0];
  const state = { version: 1, entries: Array.from({ length: Library.MAX_ENTRIES }, (_, i) => ({ ...template, url: `https://momoniji.com/work-${i}/`, title: `作品${i}` })) };
  const f = await fixture(state).init();
  await assert.rejects(f.controller.save(WORK), { code: 'LIBRARY_FULL' });
  await f.controller.save({ url: state.entries[0].url, title: state.entries[0].title });
  assert.equal((await f.controller.list()).entries.length, Library.MAX_ENTRIES);
  await f.controller.remove(state.entries[0].url); await f.controller.save(WORK);
  assert.equal((await f.controller.list()).entries.length, Library.MAX_ENTRIES);
});
test('the byte budget rejects oversized saves without evicting older bookmarks', async () => {
  const initial = await fixture().init(); await initial.controller.save(WORK);
  const template = initial.state().entries[0];
  const state = { version: 1, entries: Array.from({ length: 2000 }, (_, i) => ({ ...template, url: `https://momoniji.com/${i}-${'a'.repeat(1950)}/`, title: 'タイトル'.repeat(80) })) };
  const f = await fixture(state).init();
  await assert.rejects(f.controller.save(WORK), { code: 'LIBRARY_TOO_LARGE' });
  assert.equal(f.writes(), 0); assert.equal((await f.controller.list()).entries.length, 2000);
});
test('download records reject invalid totals, folder traversal and invalid dates', async () => {
  const f = await fixture().init();
  for (const value of [download({ total: 0 }), download({ total: 1001 }), download({ folder: '../test-1234567890abcdef' }), download({ folder: '/absolute/test-1234567890abcdef' }), download({ completedAt: NaN }), download({ run: '' })]) await assert.rejects(f.controller.recordDownload(value));
  assert.equal(f.writes(), 0);
  await assert.rejects(f.controller.markRead(WORK.url, true), { code: 'NO_ENTRY' });
});

function event() { const listeners = []; return { listeners, addListener(fn) { listeners.push(fn); } }; }
function background(initial = {}) {
  const store = clone(initial), notices = [], badges = [], menus = [], id = 'reading-test-extension'; let reads = 0, writes = 0, resolveWork;
  const onMessage = event(), onClicked = event();
  const chrome = {
    runtime: { id, onMessage, onStartup: event(), onInstalled: event(), async sendMessage() {} },
    storage: { local: {
      async get(key) { reads++; return { [key]: clone(store[key]) }; },
      async set(value) { writes++; Object.assign(store, clone(value)); }, async setAccessLevel() {}
    } },
    downloads: { onChanged: event(), onErased: event(), onDeterminingFilename: event(), async download() { throw new Error('unexpected download'); }, async search() { return []; }, async cancel() {}, async removeFile() {} },
    alarms: { onAlarm: event(), async get() {}, async create() {}, async clear() {} },
    action: { async setBadgeText(value) { badges.push(value.text); }, async setBadgeBackgroundColor() {} },
    contextMenus: { onClicked, removeAll(callback) { menus.length = 0; callback(); }, create(value, callback) { menus.push(clone(value)); callback(); return value.id; } },
    tabs: { async query() { return [{ id: 7, url: WORK.url }]; }, async sendMessage(tabId, message) { if (message.type === 'MOMONIJI_LIBRARY_RESOLVE') return resolveWork ? resolveWork(message) : { ok: true, work: WORK }; notices.push(clone(message)); } }
  };
  const context = vm.createContext({ chrome, URL, TextEncoder, Date, console, setTimeout, clearTimeout });
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context, { filename: file });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const sender = { id, url: `chrome-extension://${id}/popup.html` };
  return { chrome, store, notices, badges, menus, reads: () => reads, writes: () => writes, setResolve: value => resolveWork = value,
    call: expression => vm.runInContext(expression, context),
    send(message, source = sender) { return new Promise(resolve => { for (const fn of onMessage.listeners) { const result = fn(message, source, value => resolve(clone(value))); if (result === true) return; } }); }
  };
}
test('library messages reject foreign, iframe and unauthorized extension contexts before storage access', async () => {
  const b = background();
  for (const sender of [{ id: 'foreign', url: WORK.url, tab: { id: 7 }, frameId: 0 }, { id: b.chrome.runtime.id, url: 'https://momoniji.com.evil.example/work/', tab: { id: 7 }, frameId: 0 }, { id: b.chrome.runtime.id, url: WORK.url, tab: { id: 7 }, frameId: 1 }, { id: b.chrome.runtime.id, url: `chrome-extension://${b.chrome.runtime.id}/other.html` }, { id: b.chrome.runtime.id }]) {
    assert.equal((await b.send({ type: 'MOMONIJI_LIBRARY_LIST' }, sender)).code, 'FORBIDDEN');
  }
  assert.equal(b.reads(), 0); assert.equal(b.writes(), 0);
});
test('popup and same-site content messages add/read/remove records and update the unread badge', async () => {
  const b = background();
  const content = { id: b.chrome.runtime.id, url: 'https://momoniji.com/', tab: { id: 7 }, frameId: 0 };
  const saved = await b.send({ type: 'MOMONIJI_LIBRARY_SAVE', work: WORK }, content);
  assert.equal(saved.ok, true); assert.equal(saved.entries.length, 1); assert.equal(b.badges.at(-1), '1');
  const read = await b.send({ type: 'MOMONIJI_LIBRARY_READ', url: WORK.url, read: true });
  assert.equal(read.unreadCount, 0); assert.equal(b.badges.at(-1), '');
  const removed = await b.send({ type: 'MOMONIJI_LIBRARY_REMOVE', url: WORK.url });
  assert.equal(removed.entries.length, 0);
  const bad = await b.send({ type: 'MOMONIJI_LIBRARY_SAVE', work: { url: 'https://evil.example/work/?private=secret', title: 'x' } });
  assert.equal(bad.code, 'INVALID_URL'); assert.ok(!JSON.stringify(bad).includes('secret'));
});
test('native context menu resolves real work metadata and canonicalizes links before save', async () => {
  const b = background(); await b.call('setupLibraryMenu()');
  assert.equal(b.menus.length, 1); assert.deepEqual(b.menus[0].contexts, ['page', 'image', 'link']);
  const result = await b.call('handleLibraryContextClick')({ menuItemId: 'momoniji-read-later', pageUrl: 'https://momoniji.com/', linkUrl: WORK.url + 'page/2/?source=test', frameId: 0 }, { id: 7 });
  assert.equal(result.ok, true); assert.equal(result.entries[0].url, WORK.url);
  assert.ok(b.notices.some(message => message.type === 'MOMONIJI_LIBRARY_NOTICE' && message.ok));
});
test('native context save refuses non-work metadata, foreign links and iframes without success', async () => {
  const b = background(), fn = b.call('handleLibraryContextClick');
  for (const extra of [{ linkUrl: 'https://evil.example/work/' }, { frameId: 1 }]) {
    const result = await fn({ menuItemId: 'momoniji-read-later', pageUrl: WORK.url, frameId: 0, ...extra }, { id: 7 });
    assert.equal(result.ok, false);
  }
  b.setResolve(() => ({ ok: true, work: { url: 'https://momoniji.com/unrelated/', title: '別作品' } }));
  const result = await fn({ menuItemId: 'momoniji-read-later', pageUrl: WORK.url, frameId: 0 }, { id: 7 });
  assert.equal(result.code, 'INVALID_WORK');
  assert.equal((await b.send({ type: 'MOMONIJI_LIBRARY_LIST' })).entries.length, 0);
  assert.ok(!b.notices.some(message => message.type === 'MOMONIJI_LIBRARY_NOTICE' && message.ok));
});
test('existing complete download jobs migrate into durable history but failures do not', async () => {
  const normalized = Downloads.normalizeManga({ title: WORK.title, pageUrl: WORK.url, images: ['https://img.momoniji.com/test/001.png'] });
  const complete = { ...normalized, createdAt: 1000, updatedAt: 2000, state: 'completed', tabId: 7, pages: [{ url: normalized.images[0], state: 'complete', downloadId: 1 }] };
  const failed = { ...complete, pageUrl: 'https://momoniji.com/failed/', state: 'failed' };
  const b = background({ [Downloads.STORAGE_KEY]: { version: Downloads.VERSION, jobs: [complete, failed] } });
  const result = await b.send({ type: 'MOMONIJI_LIBRARY_LIST' });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].downloadedCount, 1); assert.equal(result.entries[0].readLater, false);
  assert.ok(b.store[Library.STORAGE_KEY]);
  b.store[Downloads.STORAGE_KEY] = { version: Downloads.VERSION, jobs: [] };
  assert.equal((await b.send({ type: 'MOMONIJI_LIBRARY_LIST' })).entries[0].downloadedCount, 1, 'short queue retention does not delete durable history');
});
