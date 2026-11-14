'use strict';

/*
 * Real-browser check for the Media Saver module inside the generated My Tools
 * extension. Run with:
 *
 *   cd unified-tools
 *   NODE_PATH=../instagram-media-downloader/node_modules node tests/media-browser.cjs
 */

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const extension = path.join(root, 'dist/my-tools');
const fixtures = path.join(root, 'media-saver/tests/fixtures');
const output = path.join(__dirname, '../test-results/media');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const canFfprobe = (() => {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const gallery = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>My Tools Media Fixture</title></head>
<body>
  <main>
    <h1>My Tools Media Fixture</h1>
    <video id="clip" src="/media/clip.mp4" preload="auto" width="320" height="480" controls></video>
    <audio id="tone" src="/media/tone.mp3" preload="auto" controls></audio>
    <img id="photo" src="/media/photo.png" alt="Fixture photo" width="320" height="180">
    <img id="gallery" src="/media/gallery.jpg" alt="Gallery thumbnail" width="128" height="128">
    <script>
      Promise.all([
        fetch('/media/hls-av/master.m3u8').then(response => response.text()),
        fetch('/media/dash-template/manifest.mpd').then(response => response.text())
      ]).then(() => { document.body.dataset.ready = '1'; });
    </script>
  </main>
</body>
</html>`;

const gated = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Gated media fixture</title></head>
<body><video id="gated" src="/media/clip.mp4?gated=1" preload="auto" controls></video></body></html>`;

const contentTypes = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};

function fixtureFile(urlPath) {
  let relative;
  try { relative = decodeURIComponent(urlPath).replace(/^\/media\//, ''); } catch { return null; }
  if (!relative || relative.includes('\0')) return null;
  const file = path.join(fixtures, relative);
  if (!file.startsWith(fixtures + path.sep)) return null;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { file, size: stat.size } : null;
  } catch { return null; }
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/gallery.html' || url.pathname === '/gated.html') {
      const body = Buffer.from(url.pathname === '/gated.html' ? gated : gallery);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const found = fixtureFile(url.pathname);
    if (!found) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return; }
    let start = 0, end = found.size - 1, status = 200;
    const range = /^bytes=(\d+)-(\d*)$/i.exec(String(request.headers.range || ''));
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), found.size - 1) : found.size - 1;
      if (start > end || start >= found.size) { response.writeHead(416, { 'content-range': `bytes */${found.size}` }); response.end(); return; }
      status = 206;
    }
    const headers = {
      'content-type': contentTypes[path.extname(found.file).toLowerCase()] || 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'range',
      'access-control-expose-headers': 'content-length, content-range'
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${found.size}`;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    fs.createReadStream(found.file, { start, end }).pipe(response);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitFor(check, label, timeout = 45000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'my-tools-media-'));
  const downloads = path.join(temporary, 'downloads');
  const profile = path.join(temporary, 'profile');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let context = null;
  const checks = [];
  const check = name => { checks.push(name); console.log(`PASS ${name}`); };

  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: !process.env.HEADED, acceptDownloads: true, downloadsPath: downloads,
      viewport: { width: 1100, height: 850 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server', '--disable-component-update']
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/popup.html`);
    await manager.locator('#mediasaver:not([disabled])').waitFor();
    assert.equal(await manager.getByRole('switch').count(), 19);
    assert.equal(await manager.locator('#mediasaver').getAttribute('aria-checked'), 'true');
    await manager.getByRole('button', { name: 'Media Saverの画面を開く', exact: true }).isEnabled();
    check('My Tools exposes Media Saver as one of its 19 enabled modules');

    const page = await context.newPage();
    await page.goto(`${base}/gallery.html`);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, `${base}/gallery.html`);
    assert.ok(Number.isInteger(tabId), 'fixture tab should exist');
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);

    const errors = [];
    manager.on('pageerror', error => errors.push(`manager: ${error.message}`));
    page.on('pageerror', error => errors.push(`page: ${error.message}`));
    await manager.getByRole('button', { name: 'Media Saverの画面を開く', exact: true }).click();
    const frame = manager.frameLocator('#module-frame');
    await frame.locator('#page-title').waitFor();
    await waitFor(async () => (await frame.locator('#page-title').getAttribute('title')) === page.url(), 'module to target the active fixture page');
    check('Media Saver popup loads inside the My Tools module frame and keeps the active page');

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await frame.locator('#refresh').click();
    await waitFor(() => frame.locator('.media-card').count().then(count => count >= 5), 'detected media cards');
    const list = await frame.locator('body').evaluate((element, id) => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:list', tabId: id }), tabId);
    assert.equal(list.ok, true, JSON.stringify(list));
    const urls = list.items.map(item => item.url);
    assert.ok(urls.includes(`${base}/media/hls-av/master.m3u8`));
    assert.ok(urls.includes(`${base}/media/clip.mp4`));
    assert.ok(urls.includes(`${base}/media/tone.mp3`));
    assert.ok(urls.includes(`${base}/media/photo.png`));
    check('Dynamic content injection and webRequest detection populate the integrated popup');
    await delay(250);
    await manager.screenshot({ path: path.join(output, 'media-saver-panel.png'), fullPage: true });
    await manager.setViewportSize({ width: 420, height: 600 });
    await delay(250);
    await manager.screenshot({ path: path.join(output, 'media-saver-panel-narrow.png'), fullPage: true });
    await manager.screenshot({ path: path.join(output, 'media-saver-panel-narrow-viewport.png') });
    await frame.locator('body').screenshot({ path: path.join(output, 'media-saver-frame-narrow.png') });
    const layout = await frame.locator('body').evaluate(body => {
      const footer = document.querySelector('.footer');
      return {
        innerWidth,
        innerHeight,
        bodyWidth: body.getBoundingClientRect().width,
        bodyHeight: body.getBoundingClientRect().height,
        scrollWidth: body.scrollWidth,
        footerBottom: footer ? footer.getBoundingClientRect().bottom : 0
      };
    });
    assert.ok(layout.bodyWidth <= layout.innerWidth, JSON.stringify(layout));
    assert.ok(layout.scrollWidth <= layout.innerWidth, JSON.stringify(layout));
    assert.ok(layout.bodyHeight <= layout.innerHeight, JSON.stringify(layout));
    assert.ok(layout.footerBottom <= layout.innerHeight + 1, JSON.stringify(layout));
    await manager.setViewportSize({ width: 1100, height: 850 });
    check('Media Saver fits the narrow My Tools frame without horizontal overflow or a clipped footer');

    const hlsCard = frame.locator('.media-card').filter({ has: frame.locator('.kind-hls') });
    const quality = hlsCard.locator('select.quality-select');
    await quality.waitFor();
    await quality.focus();
    await waitFor(() => quality.locator('option').count().then(count => count >= 2), 'HLS quality options from shared offscreen');
    check('Shared offscreen processing answers the HLS probe');

    const beforeDownloads = new Set((await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }))).map(item => item.id));
    await hlsCard.locator('.download-button').click();
    const hlsJob = await waitFor(async () => {
      const result = await frame.locator('body').evaluate(() => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:jobs' }));
      const jobs = result?.jobs || [];
      const failed = jobs.find(job => job.kind === 'hls' && job.state === 'failed');
      if (failed) throw new Error(`HLS job failed: ${failed.error}`);
      return jobs.find(job => job.kind === 'hls' && job.state === 'completed') || null;
    }, 'HLS job completion');
    const hlsDownload = (await worker.evaluate(ids => chrome.downloads.search({ state: 'complete' }).then(items => items.filter(item => !ids.includes(item.id))), [...beforeDownloads]))
      .find(item => item.mime === 'video/mp4');
    assert.ok(hlsDownload, 'HLS MP4 download should exist');
    assert.ok(fs.existsSync(hlsDownload.filename), hlsDownload.filename);
    assert.ok(fs.statSync(hlsDownload.filename).size > 10000);
    if (canFfprobe) {
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', hlsDownload.filename], { encoding: 'utf8' }));
      assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
    }
    assert.ok(hlsJob.downloads.length === 1);
    check('Integrated HLS save produces a playable MP4 through the shared offscreen document');

    const photoCard = frame.locator('.media-card').filter({ has: frame.locator('.kind-image') }).filter({ hasText: 'photo' }).first();
    await photoCard.locator('.download-button').click();
    const imageJob = await waitFor(async () => {
      const result = await frame.locator('body').evaluate(() => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:jobs' }));
      return (result?.jobs || []).find(job => job.kind === 'image' && job.state === 'completed') || null;
    }, 'image job completion');
    const imageDownload = (await worker.evaluate(ids => chrome.downloads.search({ state: 'complete' }).then(items => items.filter(item => !ids.includes(item.id))), [...beforeDownloads]))
      .find(item => item.mime === 'image/png');
    assert.ok(imageDownload && fs.existsSync(imageDownload.filename));
    assert.deepEqual(fs.readFileSync(imageDownload.filename), fs.readFileSync(path.join(fixtures, 'photo.png')));
    assert.ok(imageJob.downloads.length === 1);
    check('Integrated direct image download preserves the original bytes');

    const optionsOpened = context.waitForEvent('page');
    await frame.locator('#settings').click();
    const options = await optionsOpened;
    options.on('pageerror', error => errors.push(`options: ${error.message}`));
    await options.waitForLoadState();
    assert.match(options.url(), new RegExp(`chrome-extension://${extensionId}/modules/mediasaver/options\\.html$`));
    await options.locator('#folder').waitFor();
    assert.equal(await options.locator('#folder').inputValue(), 'MediaSaver');
    await options.screenshot({ path: path.join(output, 'media-saver-options.png'), fullPage: true });
    await options.locator('#folder').fill('MyToolsMedia');
    await options.locator('#detect-images').uncheck();
    await options.locator('#save').click();
    await waitFor(() => options.locator('#save-status').textContent().then(text => text.includes('設定を保存しました')), 'options save status');
    const settings = await options.evaluate(() => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:settings' }));
    assert.equal(settings.ok, true);
    assert.equal(settings.settings.folder, 'MyToolsMedia');
    assert.equal(settings.settings.detectImages, false);
    await options.reload();
    await options.locator('#folder').waitFor();
    assert.equal(await options.locator('#folder').inputValue(), 'MyToolsMedia');
    assert.equal(await options.locator('#detect-images').isChecked(), false);
    check('Media Saver settings open in their own options tab and persist in the module namespace');

    await frame.locator('#refresh').click();
    await waitFor(() => frame.locator('.media-card').count().then(count => count === 4), 'image detection to be disabled');
    assert.equal(await frame.locator('.kind-image').count(), 0);
    check('Saving Media Saver settings updates the integrated popup');

    await manager.locator('#module-back').click();
    await manager.locator('#mediasaver').uncheck();
    await manager.getByRole('status').filter({ hasText: '設定を保存しました' }).waitFor();
    const disabledScan = await options.evaluate(async id => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:scan', tabId: id }), tabId);
    assert.equal(disabledScan.ok, false);
    assert.match(disabledScan.error, /オフ/);
    const disabledStart = await options.evaluate(async id => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:start', tabId: id, items: [{ url: 'https://example.com/video.mp4', kind: 'video' }] }), tabId);
    assert.equal(disabledStart.ok, false);
    assert.match(disabledStart.error, /オフ/);
    const disabledProbe = await options.evaluate(async ({ id, url }) => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:probe', tabId: id, url, kind: 'hls' }), { id: tabId, url: `${base}/media/hls-av/master.m3u8` });
    assert.equal(disabledProbe.ok, false);
    assert.match(disabledProbe.error, /オフ/);
    await page.goto(`${base}/gated.html`);
    await delay(800);
    const offList = await options.evaluate(async id => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:list', tabId: id }), tabId);
    assert.equal(offList.ok, true);
    assert.ok(!offList.items.some(item => item.url.endsWith('?gated=1')));
    await manager.locator('#mediasaver').check();
    await manager.getByRole('status').filter({ hasText: '設定を保存しました' }).waitFor();
    await page.bringToFront();
    await page.goto(`${base}/gated.html?reload=${Date.now()}`);
    await page.evaluate(() => {
      const video = document.querySelector('video');
      video.src = `/media/clip.mp4?gated=1&reload=${Date.now()}`;
      video.load();
    });
    const gatedItem = await waitFor(async () => {
      const result = await options.evaluate(async id => window.MyToolsClient.moduleChrome('mediasaver').runtime.sendMessage({ type: 'ms:list', tabId: id }), tabId);
      return result.ok && result.items.find(item => item.url.includes('gated=1'));
    }, 'webRequest detection after Media Saver is re-enabled');
    assert.equal(gatedItem.kind, 'video');
    check('Media Saver OFF blocks scans, probes, starts and webRequest capture; re-enable restores detection');

    assert.deepEqual(errors, []);
    await manager.screenshot({ path: path.join(output, 'module-panel.png'), fullPage: true });
    console.log(`PASS ${checks.length} integrated Media Saver browser checks`);
  } finally {
    await context?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
