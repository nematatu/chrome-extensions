/* Stops only this disposable Chrome profile's MV3 worker before image response headers arrive. */
'use strict';
const { chromium } = require('playwright');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { ROOT, workHtml } = require('./fixtures.cjs');
const TITLE = 'ガギグゲゴ・パピプペポの復旧漫画';
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momoniji-recovery-'));
  const downloadsDirectory = path.join(temp, 'downloads');
  const profile = path.join(temp, 'profile');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.mkdirSync(downloadsDirectory);
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadsDirectory, prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
  const extension = fs.existsSync(path.resolve(__dirname, '../extension/manifest.json')) ? path.resolve(__dirname, '../extension') : path.resolve(__dirname, '..');
  const certPath = path.join(temp, 'cert.pem'), keyPath = path.join(temp, 'key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=momoniji.test'], { stdio: 'ignore' });
  assert.equal(generated.status, 0);
  const pendingResponses = [];
  let released = false;
  const sendImage = response => {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': IMAGE.length, 'Cache-Control': 'no-store' });
    response.end(IMAGE);
  };
  const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.hostname === 'momoniji.com') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(workHtml({ title: TITLE, sitePage: Number(url.pathname.match(/\/page\/(\d+)\//)?.[1] || 1) }));
    }
    if (/^\/recovery\/\d+\.png$/.test(url.pathname)) {
      pendingResponses.push(res);
      if (released) sendImage(res);
      return;
    }
    if (/^\/test\/\d+\.png$/.test(url.pathname)) return sendImage(res);
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    const port = server.address().port;
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, acceptDownloads: false, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP momoniji.com 127.0.0.1:${port}, MAP img.momoniji.com 127.0.0.1:${port}`],
    });
    const page = await context.newPage();
    await (await context.newCDPSession(page)).send('Browser.setDownloadBehavior', { behavior: 'default' });
    await page.goto(ROOT);
    await page.locator('#momoniji-reader').locator('.mv-page-slider').waitFor();
    const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.js')) || await context.waitForEvent('serviceworker', { predicate: worker => worker.url().endsWith('/background.js') });
    const control = await context.newPage();
    const controlCdp = await context.newCDPSession(control);
    const versions = new Map();
    controlCdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => { for (const version of updates) versions.set(version.versionId, version); });
    await controlCdp.send('ServiceWorker.enable');
    void worker.evaluate(async ({ title, pageUrl }) => {
      await initialize();
      const canonical = Core.canonicalPageUrl(pageUrl);
      const tab = (await chrome.tabs.query({})).find(tab => { try { return Core.canonicalPageUrl(tab.url) === canonical; } catch { return false; } });
      if (!tab) throw new Error('Synthetic download tab unavailable');
      return controller.start({ title, pageUrl, images: ['https://img.momoniji.com/recovery/001.png'] }, tab.id);
    }, { title: TITLE, pageUrl: ROOT }).catch(() => { /* The original execution context is deliberately stopped below. */ });
    const requestDeadline = Date.now() + 10000;
    while (pendingResponses.length < 1 && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(pendingResponses.length, 1, 'Chrome download is waiting for response headers');
    const before = await worker.evaluate(async pageUrl => {
      const stored = (await chrome.storage.local.get(Core.STORAGE_KEY))[Core.STORAGE_KEY];
      const job = stored.jobs.find(job => job.pageUrl === Core.canonicalPageUrl(pageUrl));
      return { states: job.pages.map(page => page.state), downloadIds: job.pages.map(page => page.downloadId) };
    }, ROOT);
    assert.deepEqual(before.states, ['starting'], 'starting transfer has a persistent journal entry before response headers');
    assert.deepEqual(before.downloadIds, [null], 'Chrome has not returned its download ID before response headers');
    // A closed source tab cannot poll status and accidentally wake the worker.
    await page.close();
    const versionDeadline = Date.now() + 5000;
    while (![...versions.values()].some(version => version.scriptURL === worker.url()) && Date.now() < versionDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    const version = [...versions.values()].find(version => version.scriptURL === worker.url() && version.runningStatus === 'running');
    assert.ok(version, 'the exact extension worker has a CDP service-worker version');
    await worker.evaluate(() => { globalThis.fixtureRecoverySentinel = true; });
    await controlCdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    const stoppedDeadline = Date.now() + 5000;
    while (versions.get(version.versionId)?.runningStatus !== 'stopped' && Date.now() < stoppedDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(versions.get(version.versionId)?.runningStatus, 'stopped', 'the original extension worker stopped according to CDP');
    released = true;
    for (const response of pendingResponses) sendImage(response);
    const restartDeadline = Date.now() + 15000;
    while (versions.get(version.versionId)?.runningStatus !== 'running' && Date.now() < restartDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(versions.get(version.versionId)?.runningStatus, 'running', 'the delayed image response restarts the MV3 worker');
    // Playwright may retain the same Worker object across a CDP stop/restart.
    // CDP runningStatus and the cleared global sentinel prove that it restarted.
    const restarted = context.serviceWorkers().find(current => current.url() === worker.url()) || await context.waitForEvent('serviceworker', { predicate: current => current.url() === worker.url(), timeout: 5000 });
    assert.equal(await restarted.evaluate(() => globalThis.fixtureRecoverySentinel === true), false, 'the restarted worker has a fresh global execution context');
    const deadline = Date.now() + 30000;
    let result;
    while (Date.now() < deadline) {
      result = await restarted.evaluate(async pageUrl => {
        await initialize();
        const job = await controller.status(pageUrl);
        const items = await chrome.downloads.search({});
        return { job, items: items.filter(item => item.byExtensionId === chrome.runtime.id) };
      }, ROOT);
      if (result.job && !result.job.active && !result.job.pending) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(result?.job?.completed, 1, `worker restart preserves the target filename (${JSON.stringify(result?.job?.failures)})`);
    assert.equal(result.job.failed, 0);
    assert.equal(result.items.length, 1, 'the existing native transfer is recovered without a duplicate download');
    assert.match(result.job.folder, /^momoniji-manga-viewer\/[^/]+-[a-f0-9]{16}$/u);
    assert.ok(result.items.every(item => item.state === 'complete' && path.dirname(item.filename).normalize('NFC') === path.join(downloadsDirectory, result.job.folder).normalize('NFC')));
    assert.deepEqual(result.items.map(item => path.basename(item.filename)).sort(), ['0001.png']);
    for (const item of result.items) assert.deepEqual(fs.readFileSync(item.filename).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(fs.readdirSync(downloadsDirectory), ['momoniji-manga-viewer']);
    console.log('PASS actual MV3 worker recovery: starting transfer survives worker stop, delayed response headers restart the worker, journal restores the Japanese work-directory filename, PNG saved without a duplicate download');
  } finally {
    for (const response of pendingResponses) if (!response.writableEnded) response.destroy();
    if (context) await context.close().catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
