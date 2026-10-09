const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ROOT, workHtml } = require('./fixtures.cjs');

const extension = path.resolve(__dirname, '../extension');
const content = fs.readFileSync(path.join(extension, 'library-content.js'), 'utf8');
const extract = fs.readFileSync(path.join(extension, 'extract.js'), 'utf8');
const ID = 'test-momoniji-extension';
const tick = () => new Promise(resolve => setTimeout(resolve, 85));
const saved = (overrides = {}) => ({ url: ROOT, title: 'テスト漫画', readLater: true, read: false, addedAt: 1, updatedAt: 1, downloadedAt: null, downloadedCount: 0, ...overrides });

function setup({ html = workHtml(), url = ROOT, entries = [], fetch, send } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const messages = [], listeners = [], fetched = [];
  dom.window.chrome = {
    runtime: {
      id: ID,
      onMessage: { addListener: listener => listeners.push(listener) },
      sendMessage: async message => {
        messages.push(message);
        if (send) return send(message);
        return { ok: true, entries };
      },
    },
  };
  dom.window.fetch = async (...args) => {
    fetched.push(args);
    if (!fetch) throw new Error('Unexpected fetch');
    return fetch(...args);
  };
  dom.window.eval(extract);
  dom.window.eval(fs.readFileSync(path.join(extension, 'library-core.js'), 'utf8'));
  const receive = (message, sender = { id: ID }) => new Promise(resolve => {
    let waiting = false;
    for (const listener of listeners) waiting = listener(message, sender, resolve) === true || waiting;
    if (!waiting) resolve(undefined);
  });
  dom.window.eval(content);
  return { dom, window: dom.window, document: dom.window.document, messages, fetched, receive };
}
function htmlResponse(html, url = ROOT, headers = {}) {
  return { ok: true, url, headers: { get: name => ({ 'content-type': 'text/html; charset=UTF-8', ...headers })[name] || null }, text: async () => html };
}

test('current work keeps reading-list and completed image-save states separate', async () => {
  const env = setup({ entries: [saved({ downloadedAt: 100, downloadedCount: 6 })] });
  try {
    await tick();
    const state = env.document.getElementById('momoniji-library-page-state').shadowRoot;
    assert.equal(state.getElementById('read-later').getAttribute('aria-pressed'), 'true');
    assert.match(state.getElementById('read-later').textContent, /後で読むに保存済み/);
    assert.equal(state.getElementById('library-download-status').hidden, false);
    assert.match(state.getElementById('library-download-status').textContent, /6ページ/);
    await env.receive({ type: 'MOMONIJI_LIBRARY_CHANGED', entries: [saved({ readLater: false, downloadedAt: 100, downloadedCount: 6 })] });
    await tick();
    assert.equal(state.getElementById('read-later').getAttribute('aria-pressed'), 'false');
    assert.equal(state.getElementById('library-download-status').hidden, false);
    assert.equal(env.messages.filter(message => message.type === 'MOMONIJI_LIBRARY_LIST').length, 1);
  } finally { env.window.close(); }
});

test('a reader created later gets one save toggle without changing download controls', async () => {
  const env = setup();
  try {
    await tick();
    const host = env.document.createElement('div'); host.id = 'momoniji-reader';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="toolbar"><button id="download">元の保存ボタン</button></div><div id="save-info"></div>';
    env.document.body.append(host);
    await tick();
    for (let index = 0; index < 3; index++) env.document.body.append(env.document.createElement('span'));
    await tick();
    assert.equal(shadow.querySelectorAll('#read-later').length, 1);
    assert.equal(shadow.querySelectorAll('#library-download-status').length, 1);
    assert.equal(shadow.getElementById('download').textContent, '元の保存ボタン');
    assert.equal(shadow.getElementById('read-later').getAttribute('aria-pressed'), 'false');
  } finally { env.window.close(); }
});

test('save and remove toggle send canonical verified metadata and retain image-save state', async () => {
  let records = [];
  const env = setup({ send: async message => {
    if (message.type === 'MOMONIJI_LIBRARY_SAVE') records = [saved({ downloadedAt: 10, downloadedCount: 6 })];
    if (message.type === 'MOMONIJI_LIBRARY_REMOVE') records = [saved({ readLater: false, downloadedAt: 10, downloadedCount: 6 })];
    return { ok: true, entries: records };
  } });
  try {
    await tick();
    const state = env.document.getElementById('momoniji-library-page-state').shadowRoot;
    const button = state.getElementById('read-later');
    button.click(); button.click();
    await tick();
    const saves = env.messages.filter(message => message.type === 'MOMONIJI_LIBRARY_SAVE');
    assert.equal(saves.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(saves[0].work)), { url: ROOT, title: 'テスト漫画' });
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    button.click(); await tick();
    assert.equal(env.messages.filter(message => message.type === 'MOMONIJI_LIBRARY_REMOVE').length, 1);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(state.getElementById('library-download-status').hidden, false);
  } finally { env.window.close(); }
});

test('listing badges match canonical work links and update after additions and removals', async () => {
  const env = setup({ html: `<main><h1>作品一覧</h1><a id="work" href="${ROOT}"><img src="https://img.momoniji.com/test/001.png"></a><a id="middle" href="${ROOT}page/2/">次のページ</a><a id="foreign" href="https://attacker.example/test-comic/">外部</a><a id="category" href="/category/test/">分類</a></main>`, url: 'https://momoniji.com/', entries: [saved({ downloadedAt: 100, downloadedCount: 6 })] });
  try {
    await tick();
    assert.equal(env.document.querySelectorAll('.momoniji-library-badges').length, 2);
    assert.equal(env.document.querySelectorAll('.momoniji-library-saved').length, 2);
    assert.equal(env.document.querySelectorAll('.momoniji-library-downloaded').length, 2);
    assert.equal(env.document.getElementById('foreign').querySelector('.momoniji-library-badges'), null);
    assert.equal(env.document.getElementById('category').querySelector('.momoniji-library-badges'), null);
    const added = env.document.createElement('a'); added.href = ROOT; added.id = 'added'; env.document.querySelector('main').append(added);
    await tick();
    assert.ok(added.querySelector('.momoniji-library-badges'));
    await env.receive({ type: 'MOMONIJI_LIBRARY_CHANGED', entries: [saved({ readLater: false, downloadedAt: 100, downloadedCount: 6 })] }); await tick();
    assert.equal(env.document.querySelectorAll('.momoniji-library-saved').length, 0);
    assert.equal(env.document.querySelectorAll('.momoniji-library-downloaded').length, 3);
    env.document.getElementById('work').href = 'https://attacker.example/test-comic/'; await tick();
    assert.equal(env.document.getElementById('work').querySelector('.momoniji-library-badges'), null);
    await env.receive({ type: 'MOMONIJI_LIBRARY_CHANGED', entries: [] }); await tick();
    assert.equal(env.document.querySelectorAll('.momoniji-library-badges').length, 0);
  } finally { env.window.close(); }
});

test('messages from another extension cannot resolve work metadata or change saved indicators', async () => {
  const env = setup();
  try {
    await tick();
    assert.equal(await env.receive({ type: 'MOMONIJI_LIBRARY_RESOLVE', url: ROOT }, { id: 'foreign' }), undefined);
    await env.receive({ type: 'MOMONIJI_LIBRARY_CHANGED', entries: [saved()] }, { id: 'foreign' }); await tick();
    const button = env.document.getElementById('momoniji-library-page-state').shadowRoot.getElementById('read-later');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(env.fetched.length, 0);
  } finally { env.window.close(); }
});

test('current-page context resolution verifies comic markers without fetching all images', async () => {
  const env = setup({ url: 'https://momoniji.com/test-comic%2f' });
  try {
    const response = await env.receive({ type: 'MOMONIJI_LIBRARY_RESOLVE', url: `${ROOT}page/2/` });
    assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true, work: { url: ROOT, title: 'テスト漫画' } });
    assert.equal(env.fetched.length, 0);
  } finally { env.window.close(); }
});

test('right-clicked image inside a work link resolves the verified linked page rather than link text', async () => {
  const env = setup({ html: `<main><h1>作品一覧</h1><a href="${ROOT}"><img id="cover" src="https://img.momoniji.com/test/001.png">雑なリンク名</a></main>`, url: 'https://momoniji.com/', fetch: async () => htmlResponse(workHtml()) });
  try {
    env.document.getElementById('cover').dispatchEvent(new env.window.MouseEvent('contextmenu', { bubbles: true, composed: true }));
    const response = await env.receive({ type: 'MOMONIJI_LIBRARY_RESOLVE' });
    assert.deepEqual(JSON.parse(JSON.stringify(response.work)), { url: ROOT, title: 'テスト漫画' });
    assert.equal(env.fetched.length, 1);
    const [url, options] = env.fetched[0];
    assert.equal(url, ROOT); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'same-origin'); assert.ok(options.signal);
  } finally { env.window.close(); }
});

test('www listings retrieve linked metadata from their own origin while storing one canonical URL', async () => {
  const env = setup({ html: '<main><h1>作品一覧</h1></main>', url: 'https://www.momoniji.com/', fetch: async url => htmlResponse(workHtml(), url) });
  try {
    const response = await env.receive({ type: 'MOMONIJI_LIBRARY_RESOLVE', url: ROOT });
    assert.equal(response.ok, true);
    assert.equal(response.work.url, ROOT);
    assert.equal(env.fetched[0][0], 'https://www.momoniji.com/test-comic/');
  } finally { env.window.close(); }
});

test('invalid and external URL requests are rejected before any fetch', async () => {
  const env = setup({ html: '<main><h1>作品一覧</h1></main>', url: 'https://momoniji.com/' });
  try {
    for (const url of ['javascript:alert(1)', 'https://attacker.example/test-comic/', 'https://momoniji.com/', 'https://momoniji.com/category/test/', 'https://momoniji.com/%ZZ/']) {
      const response = await env.receive({ type: 'MOMONIJI_LIBRARY_RESOLVE', url });
      assert.equal(response.ok, false, url);
    }
    assert.equal(env.fetched.length, 0);
  } finally { env.window.close(); }
});

test('linked metadata rejects missing manga markers, unsupported images and invalid titles', async () => {
  for (const html of [
    '<main><h1>記事</h1></main>',
    workHtml().replace('data="123"', 'data="evil"'),
    workHtml().replaceAll('https://img.momoniji.com/test/', 'https://attacker.example/test/'),
    workHtml({ title: 'x'.repeat(501) }),
    workHtml().replace('テスト漫画</h1>', 'テスト\u0001漫画</h1>'),
  ]) {
    const env = setup({ html: '<main><h1>作品一覧</h1></main>', url: 'https://momoniji.com/', fetch: async () => htmlResponse(html) });
    try {
      const response = await env.receive({ type: 'MOMONIJI_LIBRARY_RESOLVE', url: ROOT });
      assert.equal(response.ok, false);
    } finally { env.window.close(); }
  }
});

test('linked metadata rejects unexpected content, foreign redirects, oversized HTML and network failures', async () => {
  for (const fetch of [
    async () => htmlResponse(workHtml(), ROOT, { 'content-type': 'application/json' }),
    async () => htmlResponse(workHtml(), 'https://attacker.example/test-comic/'),
    async () => htmlResponse(workHtml(), ROOT, { 'content-length': '4000001' }),
    async () => htmlResponse('x'.repeat(4_000_001)),
    async () => { throw new Error('Network unavailable'); },
  ]) {
    const env = setup({ html: '<main><h1>作品一覧</h1></main>', url: 'https://momoniji.com/', fetch });
    try { assert.equal((await env.receive({ type: 'MOMONIJI_LIBRARY_RESOLVE', url: ROOT })).ok, false); }
    finally { env.window.close(); }
  }
});

test('native-menu feedback uses safe text and reports failures accessibly', async () => {
  const env = setup({ html: '<main><h1>作品一覧</h1></main>', url: 'https://momoniji.com/' });
  try {
    await env.receive({ type: 'MOMONIJI_LIBRARY_NOTICE', ok: true, message: '後で読むに保存しました。' });
    const notice = env.document.getElementById('momoniji-library-notice');
    assert.equal(notice.getAttribute('role'), 'status');
    await env.receive({ type: 'MOMONIJI_LIBRARY_NOTICE', ok: false, message: '<img onerror="alert(1)">保存できませんでした。' });
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(notice.querySelector('img'), null);
    assert.match(notice.textContent, /保存できません/);
  } finally { env.window.close(); }
});

test('reader displays quota and menu failures in its visible save-info instead of the inert source page', async () => {
  const quota = '作品の記録が保存容量の上限に達しました。後で読む一覧を整理してください。';
  const env = setup({ send: async message => message.type === 'MOMONIJI_LIBRARY_SAVE' ?
    { ok: false, error: quota, code: 'LIBRARY_TOO_LARGE' } : { ok: true, entries: [] } });
  try {
    await tick();
    const host = env.document.createElement('div'); host.id = 'momoniji-reader';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="toolbar"><button id="download">画像を保存</button></div><div id="save-info"></div>';
    for (const element of env.document.body.children) element.inert = true;
    env.document.body.append(host);
    await tick();
    shadow.getElementById('read-later').click();
    await tick();
    const notice = shadow.getElementById('library-notice');
    assert.equal(notice.parentElement.id, 'save-info');
    assert.equal(notice.hidden, false);
    assert.equal(notice.textContent, quota);
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(env.document.getElementById('momoniji-library-page-state').shadowRoot.getElementById('library-notice').hidden, true);
    await env.receive({ type: 'MOMONIJI_LIBRARY_NOTICE', ok: false, message: '画像は保存できましたが、作品の保存履歴を記録できませんでした。' });
    assert.match(notice.textContent, /保存履歴を記録できません/);
    assert.equal(notice.getAttribute('role'), 'alert');
    await env.receive({ type: 'MOMONIJI_LIBRARY_NOTICE', ok: true, message: '後で読むに保存しました。' });
    assert.equal(notice.getAttribute('role'), 'status');
    assert.equal(shadow.querySelectorAll('#library-notice').length, 1);
  } finally { env.window.close(); }
});
