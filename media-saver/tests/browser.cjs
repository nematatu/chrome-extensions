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
 * downloads, and the options page. public.test resolves to the same server, so
 * a page there counts as public and 127.0.0.1 as a private network address.
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

function sendText(request, response, type, text) {
  const body = Buffer.from(text);
  response.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(request.method === 'HEAD' ? undefined : body);
}

// Manifests on a public page that point at the private server address, and a redirect there.
function unsafeResponse(pathname, privateMedia) {
  if (pathname === '/unsafe/master.m3u8') {
    return ['application/vnd.apple.mpegurl', `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90\n${privateMedia}hls-fmp4/stream.m3u8?leak=hls\n`];
  }
  if (pathname === '/unsafe/manifest.mpd') {
    const manifest = fs.readFileSync(path.join(fixtures, 'dash-list/manifest.mpd'), 'utf8');
    return ['application/dash+xml', manifest.replace(/(sourceURL|media)="([^"]+)"/g, `$1="${privateMedia}dash-list/$2?leak=dash"`)];
  }
  return null;
}

function startServer() {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/' || url.pathname === '/gallery.html') {
      sendText(request, response, 'text/html; charset=utf-8', gallery);
      return;
    }
    if (url.pathname === '/public.html') {
      sendText(request, response, 'text/html; charset=utf-8', '<!doctype html><title>Public page</title><p>Public page</p>');
      return;
    }
    const privateMedia = `http://127.0.0.1:${server.address().port}/media/`;
    const unsafe = unsafeResponse(url.pathname, privateMedia);
    if (unsafe) { sendText(request, response, ...unsafe); return; }
    // Manifests that moved: relative references must resolve against where they ended up.
    const moved = { '/moved/master.m3u8': '/media/hls-av/master.m3u8', '/moved/manifest.mpd': '/media/dash-template/manifest.mpd' }[url.pathname];
    if (moved) {
      response.writeHead(302, { location: moved });
      response.end();
      return;
    }
    if (url.pathname === '/unsafe/redirect.png') {
      response.writeHead(302, { location: `${privateMedia}tiny.png?leak=redirect` });
      response.end();
      return;
    }
    // /held/<fixture> answers only after server.release(), keeping its job busy until then.
    if (url.pathname.startsWith('/held/')) {
      held.then(() => serveFixture(request, response, url.pathname.replace(/^\/held\//, '/media/')));
      return;
    }
    serveFixture(request, response, url.pathname);
  });
  server.requests = requests;
  server.release = () => release();
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serveFixture(request, response, pathname) {
  const found = fixtureFile(pathname);
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
  const publicBase = `http://public.test:${server.address().port}`;
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
        '--disable-component-update',
        '--host-resolver-rules=MAP public.test 127.0.0.1'
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

    const tabFor = url => worker.evaluate(async target => (await chrome.tabs.query({})).find(tab => tab.url === target)?.id, url);
    const finished = ids => waitFor(async () => {
      const jobs = (await rpc({ type: 'ms:jobs' })).jobs.filter(job => ids.includes(job.id));
      return jobs.length === ids.length && jobs.every(job => ['completed', 'failed', 'canceled'].includes(job.state)) ? jobs : null;
    }, `${ids.length} jobs to finish`, 120000);

    // On a public page, URLs read from manifests and redirect targets face the same private-network check
    // as the media URL. fetch follows a redirect before exposing it, so that one request is sent, but its
    // response is rejected unread.
    const publicPage = await context.newPage();
    await publicPage.goto(`${publicBase}/public.html`);
    const publicTab = await tabFor(`${publicBase}/public.html`);
    const seen = server.requests.length;
    const unsafe = await rpc({ type: 'ms:start', tabId: publicTab, items: [
      { url: `${publicBase}/unsafe/master.m3u8`, kind: 'hls', title: 'unsafe-hls' },
      { url: `${publicBase}/unsafe/manifest.mpd`, kind: 'dash', title: 'unsafe-dash' },
      { url: `${publicBase}/unsafe/redirect.png`, kind: 'image', title: 'unsafe-redirect' }
    ] });
    assert.equal(unsafe.ok, true);
    const unsafeJobs = await finished(unsafe.jobs);
    assert.deepEqual(unsafeJobs.map(job => [job.state, job.error, job.downloads.length]), Array(3).fill(['failed', 'UNSAFE_TARGET', 0]));
    const requested = server.requests.slice(seen);
    for (const manifest of ['/unsafe/master.m3u8', '/unsafe/manifest.mpd', '/unsafe/redirect.png']) assert.ok(requested.includes(manifest), manifest);
    assert.deepEqual(requested.filter(request => /leak=(hls|dash)/.test(request)), []);
    await publicPage.close();
    pass('Private-network URLs from public-page manifests are never requested, and a redirect there is rejected');

    // A manifest served through a redirect resolves relative references against the final URL.
    const movedProbe = await rpc({ type: 'ms:probe', tabId, url: `${base}/moved/master.m3u8`, kind: 'hls' });
    assert.equal(movedProbe.ok, true, JSON.stringify(movedProbe));
    assert.deepEqual(movedProbe.result.variants.map(variant => [variant.url, variant.audioUrl]),
      [[`${base}/media/hls-av/stream_0.m3u8`, `${base}/media/hls-av/stream_1.m3u8`]]);
    const movedStart = await rpc({ type: 'ms:start', tabId, items: [
      { url: `${base}/moved/master.m3u8`, kind: 'hls', title: 'moved-hls' },
      { url: `${base}/moved/manifest.mpd`, kind: 'dash', title: 'moved-dash' }
    ] });
    const movedJobs = await finished(movedStart.jobs);
    assert.deepEqual(movedJobs.map(job => [job.kind, job.state, job.error, job.downloads.length]).sort(),
      [['dash', 'completed', null, 2], ['hls', 'completed', null, 1]]);
    pass('Redirected HLS and DASH manifests resolve their segments against the final URL when probing and saving');

    // Cancelling while Chrome is still starting a download cancels that download and starts no further output.
    await worker.evaluate(() => {
      const original = chrome.downloads.download;
      let open;
      self.downloadGate = { original, started: 0, ids: [], opened: new Promise(resolve => { open = resolve; }) };
      self.downloadGate.open = () => open();
      chrome.downloads.download = async options => {
        self.downloadGate.started++;
        await self.downloadGate.opened;
        const id = await original.call(chrome.downloads, options);
        self.downloadGate.ids.push(id);
        return id;
      };
    });
    const gated = await rpc({ type: 'ms:start', tabId, items: [{ url: expected.dash, kind: 'dash', title: 'cancel-while-starting' }] });
    await waitFor(() => worker.evaluate(() => self.downloadGate.started === 1), 'the first DASH download to be starting');
    assert.deepEqual(await rpc({ type: 'ms:cancel', jobId: gated.jobs[0] }), { ok: true });
    await worker.evaluate(() => self.downloadGate.open());
    const [gateIds] = await Promise.all([
      waitFor(async () => { const ids = await worker.evaluate(() => self.downloadGate.ids); return ids.length ? ids : null; }, 'the gated download ID'),
      delay(1500)
    ]);
    const gatedDownload = await waitFor(async () => {
      const [item] = await worker.evaluate(id => chrome.downloads.search({ id }), gateIds[0]);
      return item && item.state !== 'in_progress' ? item : null;
    }, 'the gated download to stop');
    assert.equal(gatedDownload.state, 'interrupted');
    assert.deepEqual(await worker.evaluate(() => [self.downloadGate.started, self.downloadGate.ids.length]), [1, 1]);
    const [gatedJob] = (await rpc({ type: 'ms:jobs' })).jobs.filter(job => job.id === gated.jobs[0]);
    assert.deepEqual([gatedJob.state, gatedJob.downloads.length], ['canceled', 0]);
    await worker.evaluate(() => { chrome.downloads.download = self.downloadGate.original; });
    pass('Cancelling while a download is starting cancels it and starts no further output');

    // More items than the old 50-item batch limit are all queued; more than the detector keeps (300) are refused whole.
    const original = (await rpc({ type: 'ms:settings' })).settings;
    await rpc({ type: 'ms:set-settings', settings: { ...original, concurrency: 1 } });
    const images = (key, count) => Array.from({ length: count }, (_, index) => ({ url: `${base}/media/tiny.png?${key}=${index}`, kind: 'image', title: `${key}-${index}` }));
    const before = (await rpc({ type: 'ms:jobs' })).jobs.length;
    assert.deepEqual(await rpc({ type: 'ms:start', tabId, items: images('over', 301) }), { ok: false, error: 'TOO_MANY_ITEMS' });
    assert.equal((await rpc({ type: 'ms:jobs' })).jobs.length, before);
    const firstBatch = await rpc({ type: 'ms:start', tabId, items: [{ url: `${base}/held/tiny.png`, kind: 'image', title: 'held' }, ...images('a', 59)] });
    assert.equal(firstBatch.jobs.length, 60);
    const secondBatch = await rpc({ type: 'ms:start', tabId, items: images('b', 50) });
    assert.equal(secondBatch.jobs.length, 50);
    const bulk = [...firstBatch.jobs, ...secondBatch.jobs];
    pass('A 60-item batch is queued in full and a batch over 300 items is refused without queuing any');

    // With the held job blocking the queue, every unfinished job must be in session storage, where a restarted
    // service worker reloads them from; finished jobs are then trimmed to the 60 newest.
    const unfinished = state => !['completed', 'failed', 'canceled'].includes(state);
    const stored = () => worker.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs || []);
    const live = (await rpc({ type: 'ms:jobs' })).jobs.filter(job => bulk.includes(job.id) && unfinished(job.state));
    assert.ok(live.length > 100, `only ${live.length} unfinished jobs`);
    await waitFor(async () => {
      const ids = new Set((await stored()).filter(job => unfinished(job.state)).map(job => job.id));
      return live.every(job => ids.has(job.id));
    }, 'every unfinished job to be persisted', 5000);
    server.release();
    const bulkJobs = await finished(bulk);
    assert.ok(bulkJobs.every(job => job.state === 'completed'), JSON.stringify(bulkJobs.filter(job => job.state !== 'completed')));
    await waitFor(async () => (await stored()).length === 60, 'persisted history to be trimmed to 60');
    const history = (await rpc({ type: 'ms:jobs' })).jobs;
    assert.equal(history.length, 60);
    assert.ok(history.every(job => job.state === 'completed' && bulk.includes(job.id)));
    await rpc({ type: 'ms:set-settings', settings: original });
    pass('Unfinished jobs are always persisted, all 110 complete, and finished history keeps the 60 newest');

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
