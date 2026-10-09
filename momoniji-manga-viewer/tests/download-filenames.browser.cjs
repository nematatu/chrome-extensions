/* Real Chrome filename arbitration with a second synthetic extension. No remote requests or real artwork. */
'use strict';
const { chromium } = require('playwright');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { ROOT, workHtml } = require('./fixtures.cjs');
const WORK_TITLE = 'ガギグゲゴ・パピプペポの漫画';
// A synthetic transparent one-pixel PNG; it is not site artwork.
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function main({ ownLast = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momoniji-filenames-'));
  const downloadDirectory = path.join(temp, 'downloads');
  const profile = path.join(temp, 'profile');
  const interfering = path.join(temp, 'interfering-extension');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.mkdirSync(downloadDirectory);
  fs.mkdirSync(interfering);
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDirectory, prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
  fs.writeFileSync(path.join(interfering, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic filename arbitration fixture', version: '1.0.0', permissions: ['downloads', 'storage'], background: { service_worker: 'rename.js' } }));
  fs.writeFileSync(path.join(interfering, 'rename.js'), String.raw`
    function determineFixtureFilename(item, suggest) {
      chrome.storage.local.get(['mode', 'folder', 'targetId']).then(async options => {
        if (item.byExtensionId !== options.targetId) { suggest(); return; }
        if (options.mode === 'respect') { suggest(); return; }
        const number = Number(new URL(item.url).pathname.match(/\/(\d+)\.png$/)?.[1]);
        if (!number) { suggest(); return; }
        const filename = options.mode === 'nfd'
          ? (options.folder + '/' + String(number).padStart(4, '0') + '.png').normalize('NFD')
          : 'ルート.png';
        await chrome.storage.local.set({ observedMode: options.mode, observedFilename: filename });
        suggest({ filename, conflictAction: 'uniquify' });
      }).catch(() => suggest());
      return true;
    }
    chrome.downloads.onDeterminingFilename.addListener(determineFixtureFilename);
  `);
  const extension = fs.existsSync(path.resolve(__dirname, '../extension/manifest.json')) ? path.resolve(__dirname, '../extension') : path.resolve(__dirname, '..');
  const certPath = path.join(temp, 'cert.pem'), keyPath = path.join(temp, 'key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=momoniji.test'], { stdio: 'ignore' });
  assert.equal(generated.status, 0);
  const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.hostname === 'momoniji.com') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(workHtml({ total: 6, title: WORK_TITLE, sitePage: Number(url.pathname.match(/\/page\/(\d+)\//)?.[1] || 1) }));
    }
    if (!/\/test\/\d+\.png$/.test(url.pathname)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': IMAGE.length, 'Cache-Control': 'no-store' });
    res.end(IMAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    const port = server.address().port;
    const extensions = ownLast ? [interfering, extension] : [extension, interfering];
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, acceptDownloads: false, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extensions.join(',')}`, `--load-extension=${extensions.join(',')}`, '--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP momoniji.com 127.0.0.1:${port}, MAP img.momoniji.com 127.0.0.1:${port}`],
    });
    const page = await context.newPage();
    await (await context.newCDPSession(page)).send('Browser.setDownloadBehavior', { behavior: 'default' });
    await page.goto(ROOT);
    const reader = page.locator('#momoniji-reader');
    await reader.locator('.mv-page-slider').waitFor();
    await page.waitForFunction(() => !document.querySelector('#momoniji-reader').shadowRoot.querySelector('#download').disabled);
    const findWorker = async suffix => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const found = context.serviceWorkers().find(worker => worker.url().endsWith(suffix));
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Synthetic extension worker unavailable');
    };
    const worker = await findWorker('/background.js');
    const renamer = await findWorker('/rename.js');
    const targetId = new URL(worker.url()).host;
    const folder = await worker.evaluate(({ title, pageUrl }) => Core.normalizeManga({ title, pageUrl, images: ['https://img.momoniji.com/test/001.png'] }).folder, { title: WORK_TITLE, pageUrl: ROOT });
    const configure = mode => renamer.evaluate(async options => {
      await chrome.storage.local.set(options);
      // Disabling another extension unregisters its listener. Keeping a listener
      // that calls suggest() still lets Chrome choose the tentative URL basename.
      if (options.mode === 'respect') chrome.downloads.onDeterminingFilename.removeListener(determineFixtureFilename);
    }, { mode, folder, targetId });
    const status = () => worker.evaluate(async pageUrl => { await initialize(); return controller.status(pageUrl); }, ROOT);
    const waitSettled = async (afterUpdatedAt = null) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const job = await status();
        if (job && !job.active && !job.pending && (afterUpdatedAt === null || job.updatedAt > afterUpdatedAt)) return job;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Synthetic filename job did not settle');
    };
    const ownedDownloads = () => worker.evaluate(extensionId => chrome.downloads.search({}).then(items => items.filter(item => item.byExtensionId === extensionId)), targetId);

    await configure('nfd');
    await reader.locator('#download').click();
    const normalized = await waitSettled();
    assert.equal(normalized.completed, 6, 'canonically equivalent NFD Japanese directory names are accepted');
    assert.equal(normalized.failed, 0);
    const equivalentFiles = await ownedDownloads();
    assert.equal(equivalentFiles.length, 6);
    assert.ok(equivalentFiles.every(item => item.state === 'complete' && path.dirname(item.filename).normalize('NFC') === path.join(downloadDirectory, folder).normalize('NFC')));
    const firstSuggestion = await renamer.evaluate(() => chrome.storage.local.get(['observedMode', 'observedFilename']));
    assert.equal(firstSuggestion.observedMode, 'nfd');
    assert.notEqual(firstSuggestion.observedFilename, firstSuggestion.observedFilename.normalize('NFC'), 'a different extension supplied decomposed Japanese filenames');
    if (!ownLast) assert.ok(equivalentFiles.some(item => item.filename !== item.filename.normalize('NFC')), 'the later extension controls the filename with its NFD suggestion');
    assert.ok(equivalentFiles.every(item => fs.existsSync(item.filename)));

    await configure('foreign-folder');
    const beforeForeign = await status();
    await reader.locator('#download').click();
    const changed = await waitSettled(beforeForeign.updatedAt);
    assert.equal((await renamer.evaluate(() => chrome.storage.local.get('observedFilename'))).observedFilename, 'ルート.png', 'the synthetic other extension actually suggests the Downloads root');
    if (ownLast) {
      assert.equal(changed.completed, 6, 'our later-installed extension preserves the work folder against an older filename override');
      assert.equal(changed.failed, 0);
      const protectedFiles = (await ownedDownloads()).filter(item => !equivalentFiles.some(first => first.id === item.id));
      assert.equal(protectedFiles.length, 6);
      assert.ok(protectedFiles.every(item => item.state === 'complete' && path.dirname(item.filename).normalize('NFC') === path.join(downloadDirectory, folder).normalize('NFC')));
      assert.ok(protectedFiles.every(item => /^\d{4} \(1\)\.png$/.test(path.basename(item.filename)) && fs.existsSync(item.filename)));
      assert.deepEqual(fs.readdirSync(downloadDirectory), ['momoniji-manga-viewer'], 'no overridden files are placed in the Downloads root');
      console.log('PASS actual MV3 filename arbitration: own extension installed later preserves extension/work folders against an older overriding extension');
      return;
    }
    assert.equal(changed.completed, 0, 'downloads redirected outside the intended work folder are not reported as saved');
    assert.equal(changed.failed, 6);
    assert.ok(changed.failures.every(failure => failure.reason === 'SAVE_PATH_CHANGED'), 'foreign folder changes have a specific save-path diagnostic');
    await reader.locator('#failure').waitFor({ state: 'visible' });
    assert.match(await reader.locator('#failure').textContent(), /保存先が指定した作品フォルダと異なります/, 'the reader explains the changed save path');
    const redirectedFiles = (await ownedDownloads()).filter(item => !equivalentFiles.some(first => first.id === item.id));
    assert.equal(redirectedFiles.length, 6);
    assert.ok(redirectedFiles.every(item => path.dirname(item.filename) === downloadDirectory), 'the synthetic other extension actually changed Chrome filenames');
    assert.ok(redirectedFiles.every(item => fs.existsSync(item.filename)), 'files outside the intended work directory are not automatically removed');
    assert.ok(equivalentFiles.every(item => fs.existsSync(item.filename)), 'the completed files from the first job remain untouched');
    await configure('respect');
    const beforeRetry = await status();
    await reader.locator('#retry').click();
    const recovered = await waitSettled(beforeRetry.updatedAt);
    assert.equal(recovered.completed, 6, `retry recovers after the other extension stops changing the save path (${JSON.stringify({ state: recovered.state, failures: recovered.failures })})`);
    assert.equal(recovered.failed, 0);
    const recoveredFiles = (await ownedDownloads()).filter(item => ![...equivalentFiles, ...redirectedFiles].some(previous => previous.id === item.id));
    assert.equal(recoveredFiles.length, 6);
    assert.ok(recoveredFiles.every(item => item.state === 'complete' && path.dirname(item.filename).normalize('NFC') === path.join(downloadDirectory, folder).normalize('NFC')));
    console.log('PASS actual MV3 filename arbitration: NFD Japanese filenames, six saved PNG pages, other-extension folder changes detected, unrelated paths preserved, retry after interference ends');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => main({ ownLast: true })).catch(error => { console.error(error); process.exitCode = 1; });
