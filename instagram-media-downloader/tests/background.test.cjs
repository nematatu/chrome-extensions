const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const core = require('../core.js');
function harness(previous = {}, options = {}) {
  const listeners = {};
  const downloads = new Map();
  const state = structuredClone(previous);
  const calls = [];
  const local = structuredClone(options.local || { savedMedia: {}, savedHistoryMigratedV1: true });
  let failWrites = false;
  const chrome = {
    storage: {
      session: { get: async () => structuredClone(state), set: async data => Object.assign(state, structuredClone(data)) },
      local: { get: async () => structuredClone(local), set: async data => { if (failWrites) throw new Error('fixture quota'); Object.assign(local, structuredClone(data)); } },
    },
    runtime: { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`, onMessage: { addListener: fn => listeners.message = fn } },
    tabs: { sendMessage: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: fn => listeners.alarm = fn } },
    downloads: {
      search: async ({ id }) => id === undefined ? structuredClone(options.previousDownloads || []) : downloads.has(id) ? [downloads.get(id)] : [],
      download: async options => { calls.push(options); const id = calls.length; downloads.set(id, { id, state: 'in_progress' }); return id; },
      cancel: async id => {
        if (options.completeOnCancel) { downloads.set(id, { id, state: 'complete' }); throw new Error('fixture already complete'); }
        downloads.set(id, { id, state: 'interrupted' });
      },
      onChanged: { addListener: fn => listeners.change = fn },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), { chrome, crypto, URL, importScripts() {}, IGMediaCore: core });
  const sender = { url: 'https://www.instagram.com/p/BA/', tab: { id: 7 } };
  const send = (message, from = sender) => new Promise(resolve => listeners.message(message, from, resolve));
  return { send, calls, downloads, state, listeners, local, failWrites: value => failWrites = value };
}
const item = n => ({ url: `https://scontent.cdninstagram.com/${n}.jpg`, filename: `Instagram/alice/BA_0${n}.jpg` });
test('queue counts actual completions and serializes downloads', async () => {
  const h = harness();
  const start = await h.send({ type: 'ig-download-start', items: [item(1), item(2)] });
  assert.equal(start.ok, true);
  assert.equal(start.jobs[0].complete, 0);
  assert.equal(h.calls.length, 1);
  h.downloads.set(1, { id: 1, state: 'complete' });
  h.listeners.change({ id: 1, state: { current: 'complete' } });
  const status = await h.send({ type: 'ig-download-status' });
  assert.equal(status.jobs[0].complete, 1);
  assert.equal(h.calls.length, 2);
  h.downloads.set(2, { id: 2, state: 'interrupted' });
  const failed = await h.send({ type: 'ig-download-status' });
  assert.equal(failed.jobs[0].failed, 1);
  assert.equal(failed.jobs[0].complete, 1);
  assert.equal(JSON.stringify(failed).includes('cdninstagram'), false);
});
test('pause stops next item, resume starts it, cancel cancels active and waiting', async () => {
  const h = harness();
  const start = await h.send({ type: 'ig-download-start', items: [item(1), item(2), item(3)] });
  const id = start.jobs[0].id;
  await h.send({ type: 'ig-download-pause', id });
  h.downloads.set(1, { id: 1, state: 'complete' });
  assert.equal((await h.send({ type: 'ig-download-status' })).jobs[0].pending, 2);
  assert.equal(h.calls.length, 1);
  await h.send({ type: 'ig-download-pause', id });
  assert.equal(h.calls.length, 2);
  const canceled = await h.send({ type: 'ig-download-cancel', id });
  assert.equal(canceled.jobs[0].canceled, true);
  assert.equal(canceled.jobs[0].active, 0);
  assert.equal(canceled.jobs[0].pending, 0);
  assert.equal(h.downloads.get(2).state, 'interrupted');
});
test('rejects invalid origin, invalid batch, cross-tab controls and concurrent jobs', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'ig-download-start', items: [item(1)] }, { url: 'https://evil.test', tab: { id: 7 } })).ok, false);
  assert.equal((await h.send({ type: 'ig-download-start', items: [{ ...item(1), filename: '../escape.jpg' }] })).ok, false);
  const start = await h.send({ type: 'ig-download-start', items: [item(1)] });
  assert.equal((await h.send({ type: 'ig-download-start', items: [item(2)] })).ok, false);
  assert.equal((await h.send({ type: 'ig-download-cancel', id: start.jobs[0].id }, { url: 'https://www.instagram.com/', tab: { id: 8 } })).ok, false);
});
test('worker recovery reconciles active browser state without starting duplicates', async () => {
  const h = harness({ jobs: [{ id: 'restored', tabId: 7, paused: false, canceled: false, items: [{ ...item(1), state: 'active', downloadId: 99 }] }] });
  h.downloads.set(99, { id: 99, state: 'complete' });
  assert.equal((await h.send({ type: 'ig-download-status' })).jobs[0].complete, 1);
  assert.equal(h.calls.length, 0);
});

const historyItem = n => ({ ...item(n), historyKeys: [`m:64:${n}:image`] });
const group = { key: 'g:64', members: ['m:64:1:image', 'm:64:2:image'] };
test('history records completion only, never pending, failed, or canceled items', async () => {
  const h = harness();
  await h.send({ type: 'ig-download-start', items: [historyItem(1), historyItem(2), historyItem(3)] });
  assert.deepEqual(h.local.savedMedia, {});
  h.downloads.set(1, { id: 1, state: 'complete' });
  await h.send({ type: 'ig-download-status' });
  assert.ok(h.local.savedMedia['m:64:1:image']);
  assert.equal(h.local.savedMedia['m:64:2:image'], undefined);
  h.downloads.set(2, { id: 2, state: 'interrupted' });
  const status = await h.send({ type: 'ig-download-status' });
  await h.send({ type: 'ig-download-cancel', id: status.jobs[0].id });
  assert.equal(h.local.savedMedia['m:64:2:image'], undefined);
  assert.equal(h.local.savedMedia['m:64:3:image'], undefined);
  assert.equal(JSON.stringify(h.local).includes('cdninstagram'), false);
  assert.equal(JSON.stringify(h.local).includes('Instagram/alice'), false);
});
test('all-media markers require every member, and persist after a worker restart', async () => {
  const h = harness();
  const alias = await core.postHistoryKey('BA');
  await h.send({ type: 'ig-download-start', items: [historyItem(1), historyItem(2)], completeGroups: [{ ...group, aliases: [alias] }] });
  h.downloads.set(1, { id: 1, state: 'complete' });
  await h.send({ type: 'ig-download-status' });
  assert.equal(h.local.savedMedia['g:64'], undefined);
  assert.equal(h.local.savedMedia[alias], undefined);
  h.downloads.set(2, { id: 2, state: 'complete' });
  await h.send({ type: 'ig-download-status' });
  assert.ok(h.local.savedMedia['g:64']); assert.ok(h.local.savedMedia[alias]);
  const restored = harness({}, { local: h.local });
  await restored.send({ type: 'ig-download-status' });
  assert.deepEqual(restored.local.savedMedia, h.local.savedMedia);
  assert.equal(restored.calls.length, 0);
});
test('failed group stays unmarked while successful members survive retry', async () => {
  const h = harness();
  await h.send({ type: 'ig-download-start', items: [historyItem(1), historyItem(2)], completeGroups: [group] });
  h.downloads.set(1, { id: 1, state: 'complete' }); await h.send({ type: 'ig-download-status' });
  h.downloads.set(2, { id: 2, state: 'interrupted' }); await h.send({ type: 'ig-download-status' });
  assert.ok(h.local.savedMedia['m:64:1:image']); assert.equal(h.local.savedMedia['g:64'], undefined);
  assert.equal((await h.send({ type: 'ig-download-start', items: [historyItem(2)], completeGroups: [group] })).ok, true);
  h.downloads.set(3, { id: 3, state: 'complete' }); await h.send({ type: 'ig-download-status' });
  assert.ok(h.local.savedMedia['m:64:2:image']);
  assert.ok(h.local.savedMedia['g:64']);
});
test('local history write failure preserves successful downloads and retries without redownloading', async () => {
  const h = harness();
  await h.send({ type: 'ig-download-start', items: [historyItem(1)] });
  h.failWrites(true); h.downloads.set(1, { id: 1, state: 'complete' });
  const failedWrite = await h.send({ type: 'ig-download-status' });
  assert.equal(failedWrite.ok, true); assert.equal(failedWrite.jobs[0].complete, 1);
  assert.match(failedWrite.jobs[0].historyError, /保存履歴/);
  assert.equal(h.local.savedMedia['m:64:1:image'], undefined);
  h.failWrites(false);
  const retried = await h.send({ type: 'ig-download-status' });
  assert.equal(retried.jobs[0].historyError, ''); assert.ok(h.local.savedMedia['m:64:1:image']);
  assert.equal(h.calls.length, 1);
});
test('a completed job with unwritten history survives starting the next job', async () => {
  const h = harness();
  await h.send({ type: 'ig-download-start', items: [historyItem(1)] });
  h.failWrites(true); h.downloads.set(1, { id: 1, state: 'complete' }); await h.send({ type: 'ig-download-status' });
  await h.send({ type: 'ig-download-start', items: [historyItem(2)] });
  assert.equal(h.state.jobs.length, 2);
  h.failWrites(false); await h.send({ type: 'ig-download-status' });
  assert.ok(h.local.savedMedia['m:64:1:image']);
});
test('history metadata rejects unknown keys and unrelated group members', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'ig-download-start', items: [{ ...item(1), historyKeys: ['https://cdninstagram.com/private'] }] })).ok, false);
  assert.equal((await h.send({ type: 'ig-download-start', items: [historyItem(1)], completeGroups: [{ ...group, members: ['m:64:1:image', 'm:99:2:image'] }] })).ok, false);
  assert.equal((await h.send({ type: 'ig-download-start', items: [historyItem(1)], completeGroups: [{ ...group, members: ['m:64:2:image'] }] })).ok, false);
  assert.equal((await h.send({ type: 'ig-download-start', items: [historyItem(1)], completeGroups: [{ ...group, members: ['m:64:1:image', 'u:' + 'a'.repeat(64)] }] })).ok, false);
  assert.equal(h.calls.length, 0);
});
test('migration imports only completed downloads by this extension and normalizes duplicate names', async () => {
  const own = { byExtensionId: 'fixture', state: 'complete', filename: '/Downloads/Instagram/alice/BA_01 (2).jpg', url: 'https://scontent.cdninstagram.com/photo.jpg?token=private' };
  const h = harness({}, { local: {}, previousDownloads: [own,
    { ...own, byExtensionId: 'other', filename: '/Downloads/Instagram/alice/BA_02.jpg' },
    { ...own, state: 'interrupted', filename: '/Downloads/Instagram/alice/BA_03.jpg' },
    { ...own, filename: '/Downloads/not-instagram/BA_04.jpg' },
    { ...own, filename: 'C:\\Downloads\\Instagram\\alice\\BA_05.jpg' },
  ] });
  await h.send({ type: 'ig-download-status' });
  assert.equal(h.local.savedHistoryMigratedV1, true);
  assert.ok(h.local.savedMedia[await core.filenameHistoryKey('Instagram/alice/BA_01.jpg')]);
  assert.ok(h.local.savedMedia[await core.filenameHistoryKey('Instagram/alice/BA_05.jpg')]);
  assert.equal(h.local.savedMedia[await core.filenameHistoryKey('Instagram/alice/BA_02.jpg')], undefined);
  assert.equal(h.local.savedMedia[await core.filenameHistoryKey('Instagram/alice/BA_03.jpg')], undefined);
  assert.equal(Object.keys(h.local.savedMedia).some(key => key.startsWith('g:')), false);
  assert.equal(JSON.stringify(h.local).includes('private'), false);
});

test('cancel reconciles an already completed file without starting queued files', async () => {
  const h = harness();
  const start = await h.send({ type: 'ig-download-start', items: [historyItem(1), historyItem(2)], completeGroups: [group] });
  h.downloads.set(1, { id: 1, state: 'complete' });
  const canceled = await h.send({ type: 'ig-download-cancel', id: start.jobs[0].id });
  assert.equal(canceled.ok, true); assert.equal(canceled.jobs[0].canceled, true);
  assert.equal(canceled.jobs[0].complete, 1); assert.equal(canceled.jobs[0].pending, 0);
  assert.equal(h.calls.length, 1);
  assert.ok(h.local.savedMedia['m:64:1:image']);
  assert.equal(h.local.savedMedia['m:64:2:image'], undefined);
  assert.equal(h.local.savedMedia['g:64'], undefined);
});
test('completion during cancellation still records the completed file', async () => {
  const h = harness({}, { completeOnCancel: true });
  const start = await h.send({ type: 'ig-download-start', items: [historyItem(1), historyItem(2)] });
  const canceled = await h.send({ type: 'ig-download-cancel', id: start.jobs[0].id });
  assert.equal(canceled.ok, true); assert.equal(canceled.jobs[0].complete, 1);
  assert.equal(h.calls.length, 1);
  assert.ok(h.local.savedMedia['m:64:1:image']);
  assert.equal(h.local.savedMedia['m:64:2:image'], undefined);
});

test('individual saves accumulate into durable all-media markers across worker restarts', async () => {
  const alias = await core.postHistoryKey('BA');
  const coverage = { ...group, aliases: [alias] };
  const first = harness();
  assert.equal((await first.send({ type: 'ig-download-start', items: [historyItem(1)], completeGroups: [coverage] })).ok, true);
  assert.equal(first.local.savedMedia['g:64'], undefined);
  first.downloads.set(1, { id: 1, state: 'complete' });
  await first.send({ type: 'ig-download-status' });
  assert.ok(first.local.savedMedia['m:64:1:image']);
  assert.equal(first.local.savedMedia['g:64'], undefined);
  assert.equal(first.local.savedMedia[alias], undefined);
  const second = harness({}, { local: first.local });
  assert.equal((await second.send({ type: 'ig-download-start', items: [historyItem(2)], completeGroups: [coverage] })).ok, true);
  assert.equal(second.local.savedMedia['g:64'], undefined);
  second.downloads.set(1, { id: 1, state: 'complete' });
  await second.send({ type: 'ig-download-status' });
  assert.ok(second.local.savedMedia['m:64:1:image']);
  assert.ok(second.local.savedMedia['m:64:2:image']);
  assert.ok(second.local.savedMedia['g:64']);
  assert.ok(second.local.savedMedia[alias]);
  const restored = harness({}, { local: second.local });
  await restored.send({ type: 'ig-download-status' });
  assert.deepEqual(restored.local.savedMedia, second.local.savedMedia);
  assert.equal(restored.calls.length, 0);
});
