'use strict';

/*
 * Real-browser integration test for Media Saver.
 *
 * Playwright is not a dependency of this repository. Point PLAYWRIGHT_MODULE at
 * an installed copy, for example:
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
 *     node tests/browser.cjs
 *
 * The test loads the unpacked extension in Chromium, serves the real media
 * fixtures over HTTP, and verifies detection, the popup, HLS/DASH assembly,
 * downloads, and the options page.
 */

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { contentType, trackKinds, topLevelBoxes } = require('./helpers.cjs');

const extension = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const output = path.resolve(__dirname, '..', 'test-results');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const canFfprobe = (() => {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const gallery = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture Gallery</title></head>
<body>
  <main>
    <h1>Fixture Gallery</h1>
    <video id="clip" src="/media/clip.mp4" preload="auto" width="320" height="480" controls></video>
    <audio id="tone" src="/media/tone.mp3" preload="auto" controls></audio>
    <img id="photo" src="/media/photo.png" alt="Fixture photo" width="320" height="180">
    <img id="gallery" src="/media/gallery.jpg" alt="Gallery thumbnail" width="128" height="128">
    <a id="photo-link" href="/media/photo.png">Photo</a>
    <script>
      Promise.all([
        fetch('/media/hls-av/master.m3u8').then(response => response.text()),
        fetch('/media/dash-template/manifest.mpd').then(response => response.text())
      ]).then(() => { document.body.dataset.ready = '1'; });
    </script>
  </main>
</body>
</html>`;

function fixtureFile(urlPath) {
  let relative;
  try { relative = decodeURIComponent(urlPath).replace(/^\/media\//, ''); } catch { return null; }
  if (!relative || relative.includes('\0')) return null;
  const file = path.join(fixtures, relative);
  if (!file.startsWith(fixtures + path.sep)) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return { file, size: stat.size };
  } catch { return null; }
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/gallery.html') {
      const body = Buffer.from(gallery);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store'
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    const found = fixtureFile(url.pathname);
    if (!found) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    let start = 0, end = found.size - 1, status = 200;
    const range = /^bytes=(\d+)-(\d*)$/i.exec(String(request.headers.range || ''));
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), found.size - 1) : found.size - 1;
      if (start > end || start >= found.size) {
        response.writeHead(416, { 'content-range': `bytes */${found.size}` });
        response.end();
        return;
      }
      status = 206;
    }
    const headers = {
      'content-type': contentType(found.file),
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'range',
      'access-control-expose-headers': 'content-length, content-range, content-disposition'
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${found.size}`;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    fs.createReadStream(found.file, { start, end }).pipe(response);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitFor(check, label, timeout = 30000) {
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

async function settle(page) {
  await page.bringToFront();
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation =>
    animation.finished.catch(() => {}))));
  await delay(120);
}

function filesUnder(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (!entry.name.endsWith('.crdownload')) files.push(full);
  }
  return files;
}

function ffprobe(file) {
  const text = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file
  ], { encoding: 'utf8' });
  return JSON.parse(text);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'media-saver-browser-'));
  const downloads = path.join(temporary, 'downloads');
  const profile = path.join(temporary, 'profile');
  fs.mkdirSync(downloads, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let context = null;
  const checks = [];
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };

  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      downloadsPath: downloads,
      viewport: { width: 410, height: 580 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--no-proxy-server',
        '--disable-component-update'
      ]
    });
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 720 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloads,
      eventsEnabled: true
    });
    await page.goto(`${base}/gallery.html`);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    const tabId = await worker.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(tab => tab.url === url)?.id;
    }, `${base}/gallery.html`);
    assert.ok(Number.isInteger(tabId), 'fixture tab should exist');

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 410, height: 580 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
    const rpc = message => popup.evaluate(value => chrome.runtime.sendMessage(value), message);

    // A freshly loaded extension can miss webRequest events from a page that was
    // already loading. Reloading is the documented way to start HLS/DASH
    // detection, and it also exercises the per-tab reset path.
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await popup.locator('#refresh').click();

    const expected = {
      hls: `${base}/media/hls-av/master.m3u8`,
      dash: `${base}/media/dash-template/manifest.mpd`,
      video: `${base}/media/clip.mp4`,
      audio: `${base}/media/tone.mp3`,
      image: `${base}/media/photo.png`
    };
    const list = await waitFor(async () => {
      const response = await rpc({ type: 'ms:list', tabId });
      return response?.ok && response.items.length >= 6 ? response : null;
    }, 'six detected media items');
    const urls = new Set(list.items.map(item => item.url));
    for (const url of Object.values(expected)) assert.ok(urls.has(url), `missing ${url}`);
    assert.ok(urls.has(`${base}/media/gallery.jpg`));
    assert.equal(list.items.length, 6, `unexpected items: ${[...urls].join(', ')}`);
    assert.equal(list.items.find(item => item.url === expected.hls).kind, 'hls');
    assert.equal(list.items.find(item => item.url === expected.dash).kind, 'dash');
    assert.equal(list.items.find(item => item.url === expected.video).kind, 'video');
    assert.equal(list.items.find(item => item.url === expected.audio).kind, 'audio');
    assert.equal(list.items.find(item => item.url === expected.image).kind, 'image');
    pass('Network and DOM detection find HLS, DASH, MP4, MP3, and both images once each');

    const badge = await waitFor(async () => {
      const text = await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId);
      return text === '6' ? text : null;
    }, 'badge count 6');
    assert.equal(badge, '6');
    pass('Toolbar badge reports the visible media count');

    await waitFor(() => popup.locator('.media-card').count().then(count => count === 6), 'popup media cards');
    assert.equal(await popup.locator('.media-card').count(), 6);
    assert.equal(await popup.locator('#page-title').getAttribute('title'), page.url());
    assert.equal(await popup.locator('#media-count').textContent(), '6');
    const kinds = await popup.locator('.kind-badge').allTextContents();
    assert.equal(kinds.filter(kind => kind === 'HLS').length, 1);
    assert.equal(kinds.filter(kind => kind === 'DASH').length, 1);
    assert.equal(kinds.filter(kind => kind === 'IMAGE').length, 2);
    pass('Popup renders detected media with page context and type badges');

    await popup.getByRole('button', { name: '音声', exact: true }).click();
    assert.equal(await popup.locator('.media-card').count(), 1);
    await popup.getByRole('button', { name: '画像', exact: true }).click();
    assert.equal(await popup.locator('.media-card').count(), 2);
    await popup.getByRole('button', { name: '動画', exact: true }).click();
    assert.equal(await popup.locator('.media-card').count(), 3);
    await popup.getByRole('button', { name: 'すべて', exact: true }).click();
    assert.equal(await popup.locator('.media-card').count(), 6);
    pass('All, video, audio, and image filters show the correct cards');

    await popup.locator('#select-all').check();
    assert.equal(await popup.locator('.media-card.is-selected').count(), 6);
    assert.equal(await popup.locator('#save-selected').isEnabled(), true);
    assert.match(await popup.locator('#save-selected').textContent(), /6 件を保存/);
    await popup.locator('#select-all').uncheck();
    assert.equal(await popup.locator('.media-card.is-selected').count(), 0);
    assert.equal(await popup.locator('#save-selected').isDisabled(), true);
    pass('Select-all updates cards, selection count, and batch-save button state');

    const hlsCard = popup.locator('.media-card').filter({ has: popup.locator('.kind-hls') });
    const quality = hlsCard.locator('select.quality-select');
    await quality.focus();
    await waitFor(async () => (await quality.locator('option').count()) >= 2, 'HLS quality options');
    const qualityLabels = await quality.locator('option').allTextContents();
    assert.ok(qualityLabels.some(label => label.includes('90p')), qualityLabels.join(' | '));
    await quality.selectOption({ index: 1 });
    assert.equal(await quality.inputValue(), '0');
    assert.match(await quality.locator('option:checked').textContent(), /90p/);
    pass('HLS quality selector probes the master playlist in the offscreen document');

    await settle(popup);
    await popup.screenshot({ path: path.join(output, 'popup-media.png') });
    const completedIds = new Set((await rpc({ type: 'ms:jobs' })).jobs.filter(job => job.state === 'completed').map(job => job.id));
    const jobFor = async (kind, previous = completedIds) => waitFor(async () => {
      const response = await rpc({ type: 'ms:jobs' });
      const jobs = response.jobs || [];
      const failed = jobs.find(job => job.kind === kind && job.state === 'failed' && !previous.has(job.id));
      if (failed) throw new Error(`${kind} job failed: ${failed.error}`);
      return jobs.find(job => job.kind === kind && job.state === 'completed' && !previous.has(job.id)) || null;
    }, `${kind} download to complete`, 45000);
    const downloadsFor = async job => {
      const entries = await Promise.all(job.downloads.map(entry =>
        popup.evaluate(async id => (await chrome.downloads.search({ id }))[0] || null, entry.id)));
      assert.ok(entries.every(Boolean), 'every download record should exist');
      assert.ok(entries.every(entry => entry.state === 'complete'), 'every download should be complete');
      for (const entry of entries) assert.ok(fs.existsSync(entry.filename), `${entry.filename} should exist`);
      return entries;
    };

    await hlsCard.locator('.download-button').click();
    const hlsJob = await jobFor('hls');
    assert.equal(hlsJob.title, 'Fixture Gallery');
    assert.match(hlsJob.quality, /90p/);
    const hlsFiles = await downloadsFor(hlsJob);
    assert.equal(hlsFiles.length, 1);
    assert.equal(hlsFiles[0].mime, 'video/mp4');
    const hlsBuffer = fs.readFileSync(hlsFiles[0].filename);
    assert.deepEqual(trackKinds(hlsBuffer).sort(), ['soun', 'vide']);
    assert.ok(topLevelBoxes(hlsBuffer).some(box => box.type === 'moov'));
    assert.ok(hlsBuffer.length > 10000, `HLS output was only ${hlsBuffer.length} bytes`);
    if (canFfprobe) {
      const probe = ffprobe(hlsFiles[0].filename);
      const types = probe.streams.map(stream => stream.codec_type).sort();
      assert.deepEqual(types, ['audio', 'video']);
      assert.ok(Number(probe.format.duration) > 1.8 && Number(probe.format.duration) < 2.3);
    }
    pass('HLS download assembles one playable MP4 with merged video and audio');

    const directJobs = [];
    for (const [kind, url, mime] of [
      ['video', expected.video, 'video/mp4'],
      ['audio', expected.audio, 'audio/mpeg'],
      ['image', expected.image, 'image/png']
    ]) {
      const card = popup.locator('.media-card').filter({ has: popup.locator(`.kind-${kind}`) })
        .filter({ hasText: path.basename(url).replace(/\.[^.]+$/, '') }).first();
      assert.ok(await card.count(), `card for ${kind}`);
      await card.locator('.download-button').click();
      const job = await jobFor(kind);
      const files = await downloadsFor(job);
      assert.equal(files.length, 1);
      const fixture = kind === 'video' ? 'clip.mp4' : kind === 'audio' ? 'tone.mp3' : 'photo.png';
      assert.deepEqual(fs.readFileSync(files[0].filename), fs.readFileSync(path.join(fixtures, fixture)));
      assert.equal(files[0].mime, mime);
      directJobs.push(job);
    }
    pass('Direct MP4, MP3, and PNG downloads save byte-identical files with the right MIME types');

    const dashCard = popup.locator('.media-card').filter({ has: popup.locator('.kind-dash') });
    await dashCard.locator('.download-button').click();
    const dashJob = await jobFor('dash');
    const dashFiles = await downloadsFor(dashJob);
    assert.equal(dashFiles.length, 2);
    const byMime = Object.fromEntries(dashFiles.map(entry => [entry.mime, entry]));
    assert.ok(byMime['video/mp4'] && byMime['audio/mp4'], dashFiles.map(entry => entry.mime).join(', '));
    assert.deepEqual(trackKinds(fs.readFileSync(byMime['video/mp4'].filename)), ['vide']);
    assert.deepEqual(trackKinds(fs.readFileSync(byMime['audio/mp4'].filename)), ['soun']);
    if (canFfprobe) {
      assert.deepEqual(ffprobe(byMime['video/mp4'].filename).streams.map(stream => stream.codec_type), ['video']);
      assert.deepEqual(ffprobe(byMime['audio/mp4'].filename).streams.map(stream => stream.codec_type), ['audio']);
    }
    pass('DASH download saves separate video MP4 and audio M4A files');

    await popup.getByRole('button', { name: /ダウンロード/ }).click();
    await waitFor(() => popup.locator('.job-card').count().then(count => count >= 5), 'download history cards');
    assert.ok(await popup.locator('.job-card').filter({ hasText: '完了' }).count() >= 5);
    assert.equal(await popup.evaluate(() => document.querySelector('.main').scrollTop), 0);
    await waitFor(() => popup.locator('#toast').isHidden(), 'completion toast to disappear');
    await settle(popup);
    await popup.screenshot({ path: path.join(output, 'popup-downloads.png') });
    pass('Download tab shows completed history for every job');

    const listed = (await rpc({ type: 'ms:jobs' })).jobs.filter(job => job.state === 'completed');
    assert.ok(listed.length >= 5);
    assert.ok(listed.filter(job => job.kind === 'dash').every(job => job.downloads.length === 2));
    await popup.getByRole('button', { name: /メディア/ }).click();

    const options = await context.newPage();
    await options.setViewportSize({ width: 1120, height: 900 });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#folder').waitFor();
    assert.equal(await options.locator('#folder').inputValue(), 'MediaSaver');
    await options.locator('#folder').fill('BrowserTest');
    await options.locator('#filename-template').fill('{date}-{title}');
    await options.locator('#subfolder').uncheck();
    await options.locator('#detect-images').uncheck();
    await options.locator('#theme').selectOption('dark');
    await options.locator('#save').click();
    await waitFor(() => options.locator('#save-status').textContent().then(text => text.includes('設定を保存しました')), 'settings saved');
    const settings = await rpc({ type: 'ms:settings' });
    assert.equal(settings.ok, true);
    assert.equal(settings.settings.folder, 'BrowserTest');
    assert.equal(settings.settings.filenameTemplate, '{date}-{title}');
    assert.equal(settings.settings.subfolder, false);
    assert.equal(settings.settings.detectImages, false);
    assert.equal(settings.settings.theme, 'dark');
    await options.reload();
    await options.locator('#folder').waitFor();
    assert.equal(await options.locator('#folder').inputValue(), 'BrowserTest');
    assert.equal(await options.locator('#detect-images').isChecked(), false);
    assert.equal(await options.locator('html').getAttribute('data-theme'), 'dark');
    pass('Options page saves normalized settings and reloads them');

    await options.locator('#blacklist-input').fill('ads.example.com');
    await options.locator('#blacklist-add').click();
    await waitFor(() => options.locator('.blacklist-chip').count().then(count => count === 1), 'blacklist chip');
    assert.match(await options.locator('.blacklist-chip').textContent(), /ads\.example\.com/);
    await options.locator('.blacklist-chip button').click();
    await waitFor(() => options.locator('.blacklist-chip').count().then(count => count === 0), 'blacklist removal');
    pass('Options page adds and removes a blocked domain');

    await waitFor(async () => {
      const text = await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId);
      return text === '4' ? text : null;
    }, 'badge count 4 after disabling images');
    assert.equal(await popup.locator('html').getAttribute('data-theme'), 'dark');
    await popup.locator('#refresh').click();
    await waitFor(() => popup.locator('.media-card').count().then(count => count === 4), 'popup refresh without images');
    await popup.getByRole('button', { name: '画像', exact: true }).click();
    assert.equal(await popup.locator('.media-card').count(), 0);
    assert.match(await popup.locator('#empty h2').textContent(), /この種類のメディアはありません/);
    await popup.getByRole('button', { name: 'すべて', exact: true }).click();
    assert.equal(await popup.locator('.media-card').count(), 4);
    assert.equal(await popup.evaluate(() => document.querySelector('.main').scrollTop), 0);
    await waitFor(() => popup.locator('#toast').isHidden(), 'completion toast to disappear');
    await settle(popup);
    await popup.screenshot({ path: path.join(output, 'popup-dark.png') });
    pass('Settings broadcast updates popup theme and refresh hides disabled media types');

    await options.locator('#reset').click();
    await waitFor(async () => {
      const response = await rpc({ type: 'ms:settings' });
      return response.settings.folder === 'MediaSaver' && response.settings.detectImages === true;
    }, 'settings reset');
    await options.reload();
    await options.locator('#folder').waitFor();
    assert.equal(await options.locator('#theme').inputValue(), 'auto');
    await popup.locator('#refresh').click();
    await waitFor(() => popup.locator('.media-card').count().then(count => count === 6), 'popup refresh after reset');
    assert.equal(await popup.locator('html').getAttribute('data-theme'), null);
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await settle(popup);
    await popup.screenshot({ path: path.join(output, 'popup-reset.png') });
    pass('Reset restores defaults, all media types, and the system theme');

    assert.ok(filesUnder(downloads).length >= 6, filesUnder(downloads).join('\n'));
    await options.setViewportSize({ width: 760, height: 900 });
    await settle(options);
    await options.screenshot({ path: path.join(output, 'options.png'), fullPage: true });
    console.log(`PASS ${checks.length} Media Saver browser checks`);
    console.log(`Screenshots: ${output}`);
  } finally {
    await context?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
