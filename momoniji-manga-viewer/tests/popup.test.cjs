'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const Library = require('../extension/library-core.js');

const extension = path.resolve(__dirname, '../extension');
const flush = () => new Promise(resolve => setImmediate(resolve));

function work(number, overrides = {}) {
  return {
    url: `https://momoniji.com/work-${number}/`, title: `作品 ${number}`, readLater: true, read: false,
    addedAt: 1700000000000 + number, updatedAt: 1700000000000 + number,
    downloadedAt: null, downloadedCount: 0, downloadFolder: null, ...overrides
  };
}

async function popup(t, options = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(extension, 'popup.html'), 'utf8'), {
    url: 'https://extension.test/popup.html', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  let entries = structuredClone(options.entries || []);
  const state = { fail: null, calls: [], opened: [] };
  const messageListeners = [];
  const storageListeners = [];
  dom.window.chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListeners.push(listener); } },
      async sendMessage(message) {
        state.calls.push(message);
        if (state.fail || options.failList && message.type === 'MOMONIJI_LIBRARY_LIST') return { ok: false, error: state.fail || '保存情報を読み込めません' };
        const entry = entries.find(value => value.url === message.url || value.url === message.work?.url);
        if (message.type === 'MOMONIJI_LIBRARY_SAVE') {
          if (entry) { entry.readLater = true; entry.read = false; }
          else entries.push(work(999, { ...message.work }));
        }
        if (message.type === 'MOMONIJI_LIBRARY_READ' && entry) entry.read = message.read;
        if (message.type === 'MOMONIJI_LIBRARY_REMOVE' && entry) {
          if (entry.downloadedAt) { entry.readLater = false; entry.read = false; }
          else entries = entries.filter(value => value !== entry);
        }
        return { ok: true, entries: structuredClone(entries) };
      }
    },
    tabs: {
      async query() { return [{ id: 1, url: options.tabUrl || 'https://momoniji.com/work-999/' }]; },
      async sendMessage() { return options.current === false ? { ok: false } : { ok: true, work: options.current || work(999) }; },
      async create(value) { state.opened.push(value.url); }
    },
    storage: { onChanged: { addListener(listener) { storageListeners.push(listener); } } }
  };
  dom.window.eval(fs.readFileSync(path.join(extension, 'library-core.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(extension, 'popup.js'), 'utf8'));
  await flush();
  return {
    document: dom.window.document, window: dom.window, state,
    get entries() { return entries; },
    setEntries(next) { entries = structuredClone(next); },
    changed() { messageListeners.forEach(listener => listener({ type: 'MOMONIJI_LIBRARY_CHANGED' })); },
    storageChanged(changes) { storageListeners.forEach(listener => listener(changes, 'local')); }
  };
}

test('popup uses canonical allowed work URLs and renders titles as text', async t => {
  const ui = await popup(t, { entries: [
    work(1, { url: 'https://www.momoniji.com/work-1/page/2/?x=1#bottom', title: '<img src=x onerror=alert(1)>' }),
    work(2, { url: 'javascript:alert(1)' }), work(3, { url: 'https://momoniji.com/category/test/' }),
    work(4, { url: 'https://momoniji.com/' }), work(5, { url: 'https://example.com/work/' })
  ], current: false });
  assert.equal(ui.document.querySelectorAll('.library-item').length, 1);
  assert.equal(ui.document.querySelectorAll('img').length, 0);
  const link = ui.document.querySelector('.item-title');
  assert.equal(link.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(link.href, 'https://momoniji.com/work-1/');
  link.click(); await flush();
  assert.deepEqual(ui.state.opened, ['https://momoniji.com/work-1/']);
});

test('unread, read and downloaded filters preserve independent records and search all titles', async t => {
  const ui = await popup(t, { entries: [
    work(1, { title: 'ＡＢＣ 未読', downloadedAt: 1700000005000, downloadedCount: 3 }),
    work(2, { read: true }), work(3, { readLater: false, downloadedAt: 1700000006000, downloadedCount: 2 })
  ] });
  assert.equal(ui.document.querySelector('#count-unread').textContent, '1');
  assert.equal(ui.document.querySelector('#count-read').textContent, '1');
  assert.equal(ui.document.querySelector('#count-downloaded').textContent, '2');
  ui.document.querySelector('#tab-downloaded').click();
  assert.equal(ui.document.querySelectorAll('.library-item').length, 2);
  assert.equal(ui.document.querySelector('[data-url="https://momoniji.com/work-3/"] [data-action="remove"]'), null);
  const search = ui.document.querySelector('#search');
  search.value = 'abc'; search.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.document.querySelectorAll('.library-item').length, 1);
  assert.match(ui.document.querySelector('.downloaded-label').textContent, /3枚/);
});

test('successful current save becomes checked, duplicate additions are disabled, failed save stays unsaved', async t => {
  const ui = await popup(t);
  const save = ui.document.querySelector('#current-save');
  assert.equal(save.disabled, false);
  ui.state.fail = '書き込みできません';
  save.click(); await flush();
  assert.equal(ui.document.querySelector('#error').textContent, '書き込みできません');
  assert.equal(save.classList.contains('saved'), false);
  assert.equal(save.disabled, false);
  ui.state.fail = null;
  save.click(); await flush();
  assert.equal(save.classList.contains('saved'), true);
  assert.equal(save.disabled, true);
  assert.equal(ui.document.querySelector('#current-save-label').textContent, '後で読むに保存済み');
  assert.equal(ui.entries.filter(entry => entry.readLater).length, 1);
});

test('continuation-page aliases show both reading-list and download saved states', async t => {
  const ui = await popup(t, {
    entries: [work(1, { downloadedAt: 1700000005000, downloadedCount: 5 })],
    tabUrl: 'https://www.momoniji.com/work-1/page/2/?source=test',
    current: { url: 'https://www.momoniji.com/work-1/page/2/?source=test', title: '作品 1' }
  });
  assert.equal(ui.document.querySelector('#current-save').disabled, true);
  assert.equal(ui.document.querySelector('#current-save-label').textContent, '後で読むに保存済み');
  assert.match(ui.document.querySelector('#current-description').textContent, /ダウンロード済み/);
  assert.match(ui.document.querySelector('.downloaded-label').textContent, /5枚/);
});

test('read toggle keeps download metadata and announces the new state', async t => {
  const original = work(1, { downloadedAt: 1700000005000, downloadedCount: 6, downloadFolder: 'momoniji-manga-viewer/work-1234567890abcdef' });
  const ui = await popup(t, { entries: [original] });
  ui.document.querySelector('[data-action="toggle-read"]').click(); await flush();
  assert.equal(ui.entries[0].read, true);
  assert.equal(ui.entries[0].downloadedCount, 6);
  assert.equal(ui.entries[0].downloadFolder, original.downloadFolder);
  assert.equal(ui.document.querySelector('#notice-text').textContent, '読了にしました');
  ui.document.querySelector('#tab-read').click();
  assert.equal(ui.document.querySelectorAll('.library-item').length, 1);
  ui.document.querySelector('[data-action="toggle-read"]').click(); await flush();
  assert.equal(ui.entries[0].read, false);
});

test('delete then undo restores read status and retains completed downloads', async t => {
  const original = work(1, { read: true, downloadedAt: 1700000005000, downloadedCount: 8, downloadFolder: 'momoniji-manga-viewer/work-1234567890abcdef' });
  const ui = await popup(t, { entries: [original] });
  ui.document.querySelector('#tab-read').click();
  ui.document.querySelector('[data-action="remove"]').click(); await flush();
  assert.equal(ui.entries[0].readLater, false);
  assert.equal(ui.document.querySelector('#undo').hidden, false);
  assert.equal(ui.document.activeElement.id, 'undo');
  ui.document.querySelector('#undo').click(); await flush();
  assert.equal(ui.entries[0].readLater, true);
  assert.equal(ui.entries[0].read, true);
  assert.equal(ui.entries[0].downloadedCount, original.downloadedCount);
  assert.equal(ui.entries[0].downloadFolder, original.downloadFolder);
  assert.equal(ui.document.querySelectorAll('.library-item').length, 1);
});

test('large lists render 100 entries at a time while search reaches hidden entries', async t => {
  const ui = await popup(t, { entries: Array.from({ length: 250 }, (_, index) => work(index + 1)) });
  assert.equal(ui.document.querySelectorAll('.library-item').length, 100);
  assert.match(ui.document.querySelector('#result-count').textContent, /250/);
  ui.document.querySelector('#load-more').click();
  assert.equal(ui.document.querySelectorAll('.library-item').length, 200);
  ui.document.querySelector('#load-more').click();
  assert.equal(ui.document.querySelectorAll('.library-item').length, 250);
  assert.equal(ui.document.querySelector('#load-more').hidden, true);
  const search = ui.document.querySelector('#search');
  search.value = '作品 1'; search.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.document.querySelectorAll('.library-item').length, 100);
  search.value = '作品 42'; search.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.document.querySelectorAll('.library-item').length, 1);
  assert.equal(ui.document.querySelector('.item-title').textContent, '作品 42');
  ui.document.querySelector('#tab-unread').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(ui.document.querySelector('#tab-read').getAttribute('aria-selected'), 'true');
  assert.equal(ui.document.activeElement.id, 'tab-read');
});

test('external library changes refresh the popup while unrelated storage writes do not', async t => {
  const ui = await popup(t, { entries: [work(1)] });
  const initialCalls = ui.state.calls.length;
  ui.storageChanged({ momonijiDownloadJobs: {} });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(ui.state.calls.length, initialCalls);
  ui.setEntries([work(1), work(2)]);
  ui.changed();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(ui.document.querySelectorAll('.library-item').length, 2);
  ui.setEntries([work(1)]);
  ui.storageChanged({ [Library.STORAGE_KEY]: {} });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(ui.document.querySelectorAll('.library-item').length, 1);
});

test('an unavailable library is shown as an error and never as an empty saved list', async t => {
  const ui = await popup(t, { failList: true });
  assert.equal(ui.document.querySelector('#error').hidden, false);
  assert.equal(ui.document.querySelector('#library-panel').getAttribute('aria-busy'), 'false');
  assert.equal(ui.document.querySelector('#empty').hidden, true);
  assert.equal(ui.document.querySelector('#current-save').disabled, true);
});
