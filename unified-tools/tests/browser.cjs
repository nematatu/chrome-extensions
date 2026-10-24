'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const extension = path.join(root, 'dist/my-tools');
const configText = fs.readFileSync(path.join(extension, 'config.js'), 'utf8');
const fixtureConfig = require('node:vm').runInNewContext(`${configText}; MyToolsConfig`);
const defaults = Object.fromEntries(fixtureConfig.modules.map(module => [module.id, true]));
const envelope = (id, payload) => ({ toolModule: id, payload });
const output = path.resolve(__dirname, '../test-results');
const clip = fs.readFileSync(path.join(root, 'instagram-media-downloader/tests/fixtures/clip.mp4'));
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
const cdn = 'https://scontent.cdninstagram.com/';
const post = { pk: '64', code: 'BA', user: { username: 'fixture' }, media_type: 2,
  video_versions: [{ url: `${cdn}clip.mp4`, width: 320, height: 480 }], image_versions2: { candidates: [{ url: `${cdn}image.png`, width: 1, height: 1 }] } };
const igHTML = `<!doctype html><html><body><main style="width:420px;margin:40px auto"><article><a href="/p/BA/">fixture</a><video id="media" src="${cdn}clip.mp4" width="420" height="570" style="display:block"></video></article></main></body></html>`;
const goHTML = '<!doctype html><html><body><div id="filemanager_maincontent">Synthetic Gofile folder</div></body></html>';
const canary = 'synthetic-gofile-private-canary';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-browser-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${temp}/key.pem`, '-out', `${temp}/cert.pem`, '-days', '1', '-subj', '/CN=scontent.cdninstagram.com'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(`${temp}/key.pem`), cert: fs.readFileSync(`${temp}/cert.pem`) }, (req, res) => {
    const data = req.url.endsWith('.png') ? image : clip;
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.png') ? 'image/png' : 'video/mp4', 'Content-Length': data.length }); res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  const checks = [];
  const check = name => { checks.push(name); console.log(`PASS ${name}`); };
  const launch = () => chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: path.join(output, 'downloads'), viewport: { width: 1100, height: 850 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-proxy-server',
      `--host-resolver-rules=MAP scontent.cdninstagram.com 127.0.0.1:${server.address().port}, MAP file1.gofile.io 127.0.0.1:${server.address().port}`],
  });
  try {
    context = await launch();
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await context.route('https://www.instagram.com/**', async route => {
      if (new URL(route.request().url()).pathname.startsWith('/graphql/query')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { xdt_api__v1__media__shortcode__web_info: { items: [post] } } }) });
      const second = new URL(route.request().url()).pathname.includes('/BB/');
      const fixture = second ? { ...post, pk: '65', code: 'BB', video_versions: [{ url: `${cdn}second.mp4`, width: 320, height: 480 }] } : post;
      const body = second ? igHTML.replaceAll('/BA/', '/BB/').replace('clip.mp4', 'second.mp4').replace('</body>', `<script type="application/json">${JSON.stringify({ items: [fixture] })}</script></body>`) : igHTML;
      return route.fulfill({ contentType: 'text/html', body });
    });
    await context.route('https://gofile.io/**', route => route.fulfill({ contentType: 'text/html', body: goHTML }));
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/popup.html`);
    await manager.locator('#instagram:not([disabled])').waitFor();
    const rpc = message => manager.evaluate(message => chrome.runtime.sendMessage(message), message);
    const initial = await rpc({ type: 'my-tools:get' }); assert.equal(initial.ok, true); assert.deepEqual(initial.settings.enabled, defaults); assert.equal(fixtureConfig.modules.length, 19); assert.equal(await manager.locator('#modules input[type=checkbox]').count(), 19);
    let registrations = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts()); assert.equal(registrations.length, fixtureConfig.registrations.length);
    for (const expected of fixtureConfig.registrations) { const actual = registrations.find(r => r.id === expected.id); assert.ok(actual, expected.id); assert.deepEqual(actual.js, [...expected.js]); assert.equal(actual.world, expected.world || 'ISOLATED'); }
    assert.deepEqual(registrations.find(r => r.id === 'tools-instagram-1').js, ['config.js', 'client.js', 'modules/instagram/__isolated__/core.js', 'modules/instagram/instagram-api.js', 'modules/instagram/content.js']);
    assert.equal(registrations.find(r => r.id === 'tools-instagram-0').runAt, 'document_start');
    assert.equal(registrations.find(r => r.id === 'tools-gofile-1').runAt, 'document_idle'); check('All 19 module controls and every ordered MAIN/ISOLATED registration exist');
    await worker.evaluate(value => chrome.storage.local.set({ gofilePrivateCanary: { url: `https://file1.gofile.io/${value}`, token: value } }), canary);
    const ig = await context.newPage(); await ig.goto('https://www.instagram.com/p/BA/');
    const single = () => ig.getByRole('button', { name: 'この画像・動画を保存', exact: true }); await single().waitFor();
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.instagram.com/p/BA/' }))[0].id);
    const contentRPC = payload => { const message = envelope('instagram', payload); return worker.evaluate(async ({ tabId, message }) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: message => chrome.runtime.sendMessage(message), args: [message] }))[0].result, { tabId, message }); };
    const storageRead = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: async () => { try { return { value: await chrome.storage.local.get(null) }; } catch { return { denied: true }; } } }))[0].result, tabId);
    assert.equal(storageRead.denied, true); check('Instagram content cannot read trusted local storage or Gofile canary');
    assert.equal((await worker.evaluate(async ({ tabId }) => (await chrome.scripting.executeScript({ target: { tabId }, func: () => chrome.runtime.sendMessage({ type: 'my-tools:export' }) }))[0].result, { tabId })).ok, false); check('Instagram content cannot invoke management export');
    await single().click();
    await ig.waitForFunction(() => [...document.querySelector('#igmd-root').shadowRoot.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'この画像・動画を保存' && b.dataset.saved === 'true'));
    assert.match(await single().getAttribute('title'), /保存済み/);
    const downloadedIG = await worker.evaluate(() => chrome.downloads.search({ state: 'complete' })); assert.equal(downloadedIG.length, 1); assert.ok(downloadedIG[0].fileSize > 1000); check('Generated Instagram module saves actual MP4 and turns button into saved check');
    await ig.reload(); await single().waitFor(); await ig.waitForFunction(() => document.querySelector('#igmd-root').shadowRoot.querySelector('button[data-saved="true"]')); check('Saved check persists after page reload');
    const hist = await contentRPC({ type: 'ig-download-history' }); assert.equal(hist.ok, true); assert.ok(Object.keys(hist.savedMedia).length);
    const beforeHistory = hist.savedMedia;
    const watching = await context.newPage(); await watching.goto('https://www.instagram.com/p/BB/');
    const watchButton = watching.getByRole('button', { name: 'この画像・動画を保存', exact: true }); await watchButton.waitFor();
    assert.equal(await watchButton.getAttribute('data-saved'), 'false');
    assert.equal((await rpc({ type: 'my-tools:import', backup: { format: 'nematatu-tools', version: 1, instagram: { savedMedia: { 'm:65:65:video': Date.now() - 100 } } } })).ok, true);
    await watching.waitForFunction(() => document.querySelector('#igmd-root').shadowRoot.querySelector('button[data-saved="true"]'));
    check('Privileged history merge notifies an already-open Instagram content script without exposing raw storage');
    const legacy = { format: 'nematatu-tools', version: 1, instagram: { savedMedia: { 'm:900:901:image': Date.now() - 100 } } };
    assert.equal((await rpc({ type: 'my-tools:import', backup: legacy })).ok, true);
    assert.equal((await rpc({ type: 'my-tools:import', backup: legacy })).ok, true);
    const merged = await rpc({ type: 'my-tools:export' }); assert.equal(merged.ok, true);
    for (const key of Object.keys(beforeHistory)) assert.ok(merged.backup.instagram.savedMedia[key]); assert.ok(merged.backup.instagram.savedMedia['m:900:901:image']);
    assert.deepEqual(Object.keys(merged.backup).sort(), ['format', 'instagram', 'preferences', 'settings', 'version']); assert.deepEqual(Object.keys(merged.backup.instagram), ['savedMedia']);
    assert.doesNotMatch(JSON.stringify(merged.backup), /https:|synthetic-gofile|token|jobs|gofileBulk/); check('Legacy tagged import merges twice without clobber; export excludes URLs tokens and jobs');
    const prior = JSON.stringify(merged.backup);
    for (const backup of [ { ...legacy, jobs: {} }, { ...legacy, settings: { enabled: { instagram: false, gofile: false, unknown: true } } }, { ...legacy, instagram: { savedMedia: { bad: Date.now() } } } ]) {
      assert.equal((await rpc({ type: 'my-tools:import', backup })).ok, false); assert.equal(JSON.stringify((await rpc({ type: 'my-tools:export' })).backup), prior);
    }
    check('Malformed imports reject before changing settings or history');
    await manager.locator('#instagram').uncheck(); await manager.getByRole('status').filter({ hasText: '設定を保存しました' }).waitFor();
    assert.equal((await contentRPC({ type: 'ig-download-start', items: [] })).ok, false);
    await ig.reload(); assert.equal(await ig.locator('#igmd-root').count(), 0);
    registrations = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts()); assert.equal(registrations.length, fixtureConfig.registrations.filter(r => r.module !== 'instagram').length); check('Instagram toggle blocks stale starts and removes scripts after reload');
    await manager.locator('#instagram').check(); await manager.getByRole('status').filter({ hasText: '設定を保存しました' }).waitFor(); await ig.reload(); await single().waitFor(); check('Instagram re-enable restores content controls');
    const go = await context.newPage(); await go.goto('https://gofile.io/d/TestCode');
    await go.evaluate(() => { globalThis.appdata = { fileManager: { contentFilter: '', mainContent: { status: 'ok', data: { id: 'folder-id', type: 'folder', name: 'Fixture', canAccess: true, children: { video: { id: 'video', type: 'file', name: 'fixture.mp4', mimetype: 'video/mp4', size: 100, link: 'https://file1.gofile.io/download/web/video/fixture.mp4' } } }, metadata: { page: 1, pageSize: 1000, totalPages: 1 } } } }; });
    const goTabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://gofile.io/d/TestCode' }))[0].id);
    const goRPC = payload => { const message = envelope('gofile', payload); return worker.evaluate(async ({ id, message }) => (await chrome.scripting.executeScript({ target: { tabId: id }, world: 'ISOLATED', func: message => chrome.runtime.sendMessage(message), args: [message] }))[0].result, { id: goTabId, message }); };
    const started = await goRPC({ type: 'gofile-bulk:start' }); assert.equal(started.ok, true, JSON.stringify(started));
    let completed;
    for (let i = 0; i < 100; i++) { completed = await worker.evaluate(() => chrome.downloads.search({ state: 'complete' })); if (completed.length === 2) break; await delay(100); }
    assert.equal(completed.length, 2); assert.ok(completed.every(item => item.fileSize > 1000)); for (const item of completed) assert.deepEqual(fs.readFileSync(item.filename), clip); assert.equal((await goRPC({ type: 'gofile-bulk:status' })).ok, true); check('Generated Gofile worker uses actual MAIN collector and completes actual MP4 download');
    await manager.locator('#gofile').uncheck(); await manager.getByRole('status').filter({ hasText: '設定を保存しました' }).waitFor(); assert.equal((await goRPC({ type: 'gofile-bulk:start' })).ok, false); assert.equal((await goRPC({ type: 'gofile-bulk:status' })).ok, true);
    await go.reload(); assert.equal(await go.locator('#gofile-bulk-video-button-host').count(), 0); check('Gofile toggle blocks new starts and preserves existing status');
    await manager.locator('#gofile').check(); await manager.getByRole('status').filter({ hasText: '設定を保存しました' }).waitFor();
    await manager.reload(); await manager.locator('#instagram:not([disabled])').waitFor();
    await manager.screenshot({ path: path.join(output, 'popup.png'), fullPage: true });
    await manager.setViewportSize({ width: 380, height: 850 });
    await manager.screenshot({ path: path.join(output, 'popup-narrow.png'), fullPage: true }); check('Generated common management screen rendered and captured');
    const downloadEvent = manager.waitForEvent('download'); await manager.locator('#export').click(); const backupDownload = await downloadEvent; const file = path.join(output, 'backup.json'); await backupDownload.saveAs(file); const exported = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(exported.format, 'nematatu-tools'); assert.doesNotMatch(JSON.stringify(exported), /synthetic-gofile|https:|token|jobs/); check('Actual export button downloads allowlisted JSON');
    await manager.locator('#import-file').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) }); await manager.getByRole('status').filter({ hasText: '履歴を追加しました' }).waitFor(); check('Actual file input imports tagged legacy JSON');
    const savedBeforeBulk = (await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }))).length;
    await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabId);
    await manager.locator('#save').click();
    await manager.getByRole('status').filter({ hasText: 'Instagram画面の右下で進捗をご確認ください' }).waitFor();
    let afterBulk;
    for (let i = 0; i < 100; i++) { afterBulk = await worker.evaluate(() => chrome.downloads.search({ state: 'complete' })); if (afterBulk.length > savedBeforeBulk) break; await delay(100); }
    assert.equal(afterBulk.length, savedBeforeBulk + 1);
    assert.deepEqual(fs.readFileSync(afterBulk.find(item => !completed.some(previous => previous.id === item.id) && !item.filename.endsWith('.json')).filename), clip);
    check('Actual common Instagram bulk-save button routes to active content and completes real MP4 download');
    const finalHistory = (await rpc({ type: 'my-tools:export' })).backup.instagram.savedMedia;
    await context.close(); context = await launch(); worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const restarted = await context.newPage(); await restarted.goto(`chrome-extension://${extensionId}/popup.html`); await restarted.locator('#instagram:not([disabled])').waitFor();
    const after = await restarted.evaluate(() => chrome.runtime.sendMessage({ type: 'my-tools:export' })); assert.deepEqual(after.backup.instagram.savedMedia, finalHistory); assert.deepEqual(after.backup.settings.enabled, defaults); check('History and settings survive browser and worker restart');
    console.log(`PASS ${checks.length} generated-extension browser checks`);
  } finally { await context?.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
