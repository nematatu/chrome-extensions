/* Canonically equivalent filenames must not be confused with different directories. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../extension/download-core.js');
const PAGE_URL = 'https://momoniji.com/synthetic-unicode/';
const MANGA = { title: 'テスト・ガイド（パート２）', pageUrl: PAGE_URL, images: ['https://img.momoniji.com/synthetic-unicode/1.webp'] };
async function fixture(transform = value => value) {
  let stored;
  const records = new Map(), cancellations = [], removals = [];
  const api = {
    extensionId: 'unicode-test-extension',
    async load() { return structuredClone(stored); },
    async save(state) { stored = structuredClone(state); },
    async download(request) {
      records.set(1, { id: 1, byExtensionId: api.extensionId, state: 'in_progress', url: request.url, finalUrl: request.url, filename: transform(`/Downloads/${request.filename}`), mime: 'image/webp', startTime: new Date().toISOString() });
      return 1;
    },
    async search() { return [...records.values()].map(record => structuredClone(record)); },
    async cancel(id) { cancellations.push(id); records.get(id).state = 'interrupted'; records.get(id).error = 'USER_CANCELED'; },
    async removeFile(id) { removals.push(id); records.get(id).exists = false; }
  };
  const controller = new Core.Controller(api);
  await controller.init();
  await controller.start(MANGA, 7);
  return { api, controller, records, cancellations, removals,
    async change(state, extra = {}) { Object.assign(records.get(1), { state }, extra); await controller.changed({ id: 1, state: { current: state } }); },
    stored: () => structuredClone(stored) };
}
test('WebP files in Japanese NFC title directories complete', async () => {
  const f = await fixture(); await f.change('complete');
  assert.equal((await f.controller.status(PAGE_URL)).completed, 1);
});
test('WebP files in canonically equivalent NFD title directories complete', async () => {
  const f = await fixture(value => value.normalize('NFD')); await f.change('complete');
  assert.equal((await f.controller.status(PAGE_URL)).completed, 1);
});
test('NFD directory with Chrome conflict counter completes', async () => {
  const f = await fixture(value => value.replace(/\.webp$/u, ' (12).webp').normalize('NFD')); await f.change('complete');
  assert.equal((await f.controller.status(PAGE_URL)).completed, 1);
});
test('NFC directory with Chrome conflict counter completes', async () => {
  const f = await fixture(value => value.replace(/\.webp$/u, ' (1).webp')); await f.change('complete');
  assert.equal((await f.controller.status(PAGE_URL)).completed, 1);
});
test('manual cancel cancels an owned download with an NFD path', async () => {
  const f = await fixture(value => value.normalize('NFD')); await f.controller.cancel(PAGE_URL);
  assert.deepEqual(f.cancellations, [1]);
  assert.equal((await f.controller.status(PAGE_URL)).cancelled, 1);
});
test('bad response in an owned NFD file is removed and reports content failure', async () => {
  const f = await fixture(value => value.normalize('NFD')); await f.change('complete', { mime: 'text/html' });
  const result = await f.controller.status(PAGE_URL);
  assert.equal(result.failures[0].reason, 'UNEXPECTED_CONTENT');
  assert.deepEqual(f.removals, [1]);
});
test('worker recovery identifies an owned completed NFD file whose ID was not journalled', async () => {
  const f = await fixture(value => value.normalize('NFD'));
  const stored = f.stored(); stored.jobs[0].pages[0].downloadId = null; stored.jobs[0].pages[0].state = 'starting';
  await f.api.save(stored); Object.assign(f.records.get(1), { state: 'complete' });
  const restored = new Core.Controller(f.api); await restored.init();
  assert.equal((await restored.status(PAGE_URL)).completed, 1);
});
test('compatibility-equivalent fullwidth path is rejected as a different file', async () => {
  const f = await fixture(value => value.replace('/' + Core.DOWNLOAD_ROOT + '/', '/' + Core.DOWNLOAD_ROOT.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0)) + '/'));
  await f.change('complete', { mime: 'text/html' });
  assert.equal((await f.controller.status(PAGE_URL)).failures[0].reason, 'SAVE_PATH_CHANGED');
  assert.deepEqual(f.removals, []);
});
test('unrelated root-level file is never accepted or removed', async () => {
  const f = await fixture(() => '/Downloads/0001.webp'); await f.change('complete', { mime: 'text/html' });
  assert.equal((await f.controller.status(PAGE_URL)).failures[0].reason, 'SAVE_PATH_CHANGED');
  assert.deepEqual(f.removals, []);
});
test('retry reconciles an existing completed NFD image previously marked as a mismatch', async () => {
  const f = await fixture(value => value.normalize('NFD'));
  const stored = f.stored();
  stored.jobs[0].pages[0].state = 'failed'; stored.jobs[0].pages[0].error = 'DOWNLOAD_MISMATCH';
  await f.api.save(stored); Object.assign(f.records.get(1), { state: 'complete' });
  const restored = new Core.Controller(f.api); await restored.init();
  assert.equal((await restored.status(PAGE_URL)).failed, 1);
  f.api.download = async () => { assert.fail('already saved image must not download again'); };
  const result = await restored.retry(PAGE_URL, 7);
  assert.equal(result.completed, 1); assert.equal(result.failed, 0);
});
test('retry downloads again when the old mismatched image was deleted', async () => {
  const f = await fixture(value => value.normalize('NFD'));
  const stored = f.stored();
  stored.jobs[0].pages[0].state = 'failed'; stored.jobs[0].pages[0].error = 'DOWNLOAD_MISMATCH';
  await f.api.save(stored); Object.assign(f.records.get(1), { state: 'complete', exists: false });
  const restored = new Core.Controller(f.api); await restored.init();
  let starts = 0;
  const originalDownload = f.api.download;
  f.api.download = async request => { starts++; return originalDownload(request); };
  const result = await restored.retry(PAGE_URL, 7);
  assert.equal(result.completed, 0); assert.equal(result.active, 1);
  assert.equal(starts, 1, 'a missing file is downloaded without waiting for an automatic retry');
  await restored.changed({ id: 1, state: { current: 'complete' } });
  assert.equal((await restored.status(PAGE_URL)).completed, 0, 'an in-progress replacement cannot count as saved');
  Object.assign(f.records.get(1), { state: 'complete', exists: true });
  await restored.changed({ id: 1, state: { current: 'complete' } });
  assert.equal((await restored.status(PAGE_URL)).completed, 1);
});
