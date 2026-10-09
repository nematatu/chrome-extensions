/* Real MV3 library integration, using only synthetic pages/images in a disposable Chrome profile. */
'use strict';
const { chromium } = require('playwright');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { ROOT, workHtml } = require('./fixtures.cjs');

const LISTING = 'https://momoniji.com/listing/';
const SECOND = 'https://momoniji.com/second-comic/';
const TITLES = ['ガギグゲゴ・後で読むテスト漫画', '別のテスト漫画'];

function png() {
  const width = 720, height = 1017, raw = Buffer.alloc((width * 3 + 1) * height, 240);
  for (let row = 0; row < height; row++) raw[row * (width * 3 + 1)] = 0;
  function chunk(type, body) {
    const typeBuffer = Buffer.from(type); let crc = 0xffffffff;
    for (const byte of Buffer.concat([typeBuffer, body])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, typeBuffer, body, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momoniji-library-browser-'));
  const profile = path.join(temp, 'profile'), downloadDirectory = path.join(temp, 'downloads');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.mkdirSync(downloadDirectory);
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDirectory, prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
  const extension = path.resolve(__dirname, '../extension'), cert = path.join(temp, 'cert.pem'), key = path.join(temp, 'key.pem');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=momoniji.test'], { stdio: 'ignore' }).status, 0);
  const image = png(); const hits = [];
  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.hostname === 'img.momoniji.com') {
      if (!/^\/test\/00[12]\.png$/.test(url.pathname)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'no-store' }); return res.end(image);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/listing/') return res.end(`<!doctype html><html lang="ja"><head><title>一覧</title></head><body><main><h1>漫画一覧</h1><article><a id="comic-link" href="${ROOT}page/2/?source=listing#comic"><img src="https://img.momoniji.com/test/001.png" alt="${TITLES[0]}"><h2>${TITLES[0]}</h2></a></article><article><a id="second-link" href="${SECOND}"><img src="https://img.momoniji.com/test/002.png" alt="${TITLES[1]}"><h2>${TITLES[1]}</h2></a></article><a id="non-comic" href="https://momoniji.com/about/">サイトについて</a></main></body></html>`);
    if (url.pathname === '/about/') return res.end('<!doctype html><html><body><main><h1>サイトについて</h1><p>漫画ではありません。</p></main></body></html>');
    const second = url.pathname === new URL(SECOND).pathname;
    if (url.pathname === new URL(ROOT).pathname || second || url.pathname === `${new URL(ROOT).pathname}page/2/`) {
      hits.push(second ? 'second' : 'first');
      // All pages are present in this small fixture. A page/2 URL is used only
      // for duplicate canonicalization from the listing link, not navigation.
      return res.end(workHtml({ id: second ? '456' : '123', title: TITLES[second ? 1 : 0], total: 2, perSitePage: 2, links: [second ? SECOND : ROOT], pagerRanges: true }));
    }
    res.writeHead(404); res.end('Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const options = { channel: 'chromium', headless: true, acceptDownloads: false, viewport: { width: 1100, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP momoniji.com 127.0.0.1:${port}, MAP www.momoniji.com 127.0.0.1:${port}, MAP img.momoniji.com 127.0.0.1:${port}`] };
  let context, worker, page, popup, extensionId;
  const errors = [];
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, options);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    extensionId = new URL(worker.url()).host;
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await (await context.newCDPSession(page)).send('Browser.setDownloadBehavior', { behavior: 'default' });
    popup = await context.newPage(); await popup.setViewportSize({ width: 420, height: 680 }); popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  };
  const message = value => popup.evaluate(value => chrome.runtime.sendMessage(value), value);
  const entries = async () => {
    const response = await message({ type: 'MOMONIJI_LIBRARY_LIST' }); assert.equal(response.ok, true, JSON.stringify(response));
    return response.entries;
  };
  const wait = async (fn, text, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${text}`);
  };
  const get = async url => (await entries()).find(entry => entry.url === url);
  const clickContext = async (target, info) => {
    await target.click({ button: 'right' }); await page.keyboard.press('Escape');
    const tab = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0], page.url());
    assert.ok(tab && Number.isInteger(tab.id), 'actual site tab exists');
    return worker.evaluate(async ({ info, tab }) => {
      const result = await handleLibraryContextClick({ menuItemId: 'momoniji-read-later', frameId: 0, ...info }, tab);
      return result === undefined ? null : result;
    }, { info: { pageUrl: page.url(), ...info }, tab });
  };
  const readerButton = () => page.locator('#momoniji-reader').locator('#read-later');
  const savedBadge = url => page.locator(`.momoniji-library-badges[data-momoniji-library-url="${url}"] .momoniji-library-saved`);
  const downloadedBadge = url => page.locator(`.momoniji-library-badges[data-momoniji-library-url="${url}"] .momoniji-library-downloaded`);

  try {
    await launch();
    await wait(async () => await worker.evaluate(async () => { try { await chrome.contextMenus.update('momoniji-read-later', {}); return true; } catch { return false; } }), 'native context menu registration');
    assert.equal(await worker.evaluate(() => chrome.contextMenus.onClicked.hasListener(handleLibraryContextClick)), true, 'the tested function is the registered native-menu click listener');
    await page.goto(LISTING);
    await clickContext(page.locator('#comic-link img'), { linkUrl: `${ROOT}page/2/?source=listing#comic`, srcUrl: 'https://img.momoniji.com/test/001.png', mediaType: 'image' });
    const first = await wait(() => get(ROOT), 'right-click save creates a canonical work');
    assert.equal(first.title, TITLES[0]); assert.equal(first.readLater, true); assert.equal(first.read, false);
    assert.ok(hits.includes('first'), 'site work metadata, rather than only the link label, is resolved');
    await savedBadge(ROOT).waitFor(); assert.equal(await downloadedBadge(ROOT).count(), 0, 'read-later save does not claim an image download');
    await clickContext(page.locator('#comic-link'), { linkUrl: ROOT });
    assert.equal((await entries()).length, 1, 'repeated saves and page-two links do not create duplicates');
    assert.equal((await get(ROOT)).addedAt, first.addedAt, 'duplicate saves keep original registration time');
    console.log('PASS native menu registration and manga-link save: authoritative metadata, canonical duplicate, live listing badge');

    await page.goto(ROOT);
    await page.locator('#momoniji-reader').locator('.mv-page-slider').waitFor();
    assert.equal(await readerButton().getAttribute('aria-pressed'), 'true');
    assert.match(await readerButton().textContent(), /保存済み/);
    await clickContext(page.locator('#momoniji-reader').locator('#reader-stage').locator('.mv-tap-area.mv-right'), {});
    assert.equal((await entries()).length, 1, 'right-click inside the OSS viewer resolves the current work');
    await readerButton().click();
    await wait(async () => !(await get(ROOT))?.readLater, 'reader button removes read-later state');
    await readerButton().click();
    await wait(async () => (await get(ROOT))?.readLater, 'reader button adds read-later state');

    await page.goto(SECOND);
    await page.locator('#momoniji-reader').locator('.mv-page-slider').waitFor();
    await page.bringToFront(); await popup.reload();
    await popup.locator('#current-save').waitFor();
    await wait(async () => await popup.locator('#current-save').isEnabled(), 'popup resolves active comic tab');
    await popup.locator('#current-save').click();
    await wait(() => get(SECOND), 'popup saves the active work');
    await clickContext(page.locator('#momoniji-reader').locator('#reader-stage').locator('.mv-tap-area.mv-right'), {});
    await wait(() => get(SECOND), 'second work saved from its viewer');
    assert.equal((await entries()).filter(entry => entry.readLater).length, 2);
    console.log('PASS reader save/remove controls, current viewer right-click, popup active-work save');

    await popup.reload();
    // Popup controls intentionally use accessible names so the test verifies
    // the actual user-facing workflow and does not depend on presentation CSS.
    await popup.locator('#search').fill(TITLES[0]);
    await wait(async () => (await popup.getByRole('link', { name: TITLES[0], exact: true }).count()) === 1 && (await popup.getByRole('link', { name: TITLES[1], exact: true }).count()) === 0, 'popup search filters saved works');
    await popup.locator('#search').fill('');
    await popup.getByRole('link', { name: TITLES[0], exact: true }).waitFor();
    if (process.env.SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      for (const colorScheme of ['light', 'dark']) {
        await popup.emulateMedia({ colorScheme });
        await popup.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `momoniji-library-popup-${colorScheme}-synthetic.png`) });
      }
      await popup.emulateMedia({ colorScheme: 'light' });
    }
    const firstRow = popup.locator(`article.library-item[data-url="${ROOT}"]`);
    await firstRow.locator('[data-action="toggle-read"]').click();
    await wait(async () => (await get(ROOT))?.read === true, 'popup mark-as-read persists');
    await popup.locator('#tab-read').click();
    await popup.getByRole('link', { name: TITLES[0], exact: true }).waitFor();
    assert.equal(await popup.getByRole('link', { name: TITLES[1], exact: true }).count(), 0, 'read filter excludes unread work');
    await popup.locator('#tab-read').focus(); await popup.keyboard.press('ArrowRight');
    assert.equal(await popup.locator('#tab-downloaded').getAttribute('aria-selected'), 'true', 'keyboard navigation switches to the downloaded tab');
    await popup.keyboard.press('Home');
    assert.equal(await popup.locator('#tab-unread').getAttribute('aria-selected'), 'true', 'Home selects the first reading-list tab');
    await popup.getByRole('link', { name: TITLES[1], exact: true }).waitFor();
    assert.equal(await popup.getByRole('link', { name: TITLES[0], exact: true }).count(), 0, 'unread filter excludes read work');
    await popup.locator('#tab-read').click();
    await firstRow.locator('[data-action="remove"]').click();
    await wait(async () => !(await get(ROOT))?.readLater, 'popup remove is saved');
    await popup.locator('#undo').click();
    await wait(async () => (await get(ROOT))?.readLater && (await get(ROOT))?.read === true, 'undo restores membership and read state');
    console.log('PASS actual popup search, keyboard/read filters, delete and undo');

    await page.goto(ROOT);
    await page.locator('#momoniji-reader').locator('.mv-page-slider').waitFor();
    await page.locator('#momoniji-reader').locator('#download').click();
    const downloaded = await wait(async () => { const entry = await get(ROOT); return entry?.downloadedCount === 2 && entry.downloadedAt ? entry : null; }, 'complete image download is durably recorded', 30000);
    assert.equal(downloaded.readLater, true); assert.ok(downloaded.downloadFolder.startsWith('momoniji-manga-viewer/'));
    await page.locator('#momoniji-reader').locator('#library-download-status').waitFor({ state: 'visible' });
    const files = await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }));
    assert.equal(files.length, 2, 'two synthetic images were actually downloaded');
    for (const item of files) assert.deepEqual(fs.readFileSync(item.filename), image);
    await popup.locator('#tab-downloaded').click();
    await popup.getByRole('link', { name: TITLES[0], exact: true }).waitFor();
    assert.equal(await popup.getByRole('link', { name: TITLES[1], exact: true }).count(), 0, 'downloaded tab distinguishes downloaded work from read-later membership');
    await firstRow.locator('[data-action="remove"]').click();
    await wait(async () => (await get(ROOT))?.readLater === false, 'removing read later keeps a downloaded-only record');
    assert.equal((await get(ROOT)).downloadedCount, 2);
    await popup.getByRole('link', { name: TITLES[0], exact: true }).waitFor();
    assert.equal(await firstRow.locator('[data-action="remove"]').count(), 0, 'downloaded-only history does not pretend to be a read-later entry');
    await popup.locator('#undo').click();
    await wait(async () => (await get(ROOT))?.readLater && (await get(ROOT))?.read === true, 'undo preserves read state and existing downloaded history');
    await worker.evaluate(async ids => { for (const id of ids) await chrome.downloads.erase({ id }); }, files.map(item => item.id));
    assert.equal((await get(ROOT)).downloadedCount, 2, 'erasing Chrome transfer history keeps extension-owned download metadata');
    await page.goto(LISTING); await savedBadge(ROOT).waitFor(); await downloadedBadge(ROOT).waitFor();

    const external = await message({ type: 'MOMONIJI_LIBRARY_SAVE', work: { url: 'https://example.com/not-a-comic/', title: '対象外' } });
    assert.equal(external.ok, false, 'external URLs are refused');
    const invalid = await message({ type: 'MOMONIJI_LIBRARY_SAVE', work: { url: 'javascript:alert(1)', title: '対象外' } });
    assert.equal(invalid.ok, false, 'script URLs are refused');
    const beforeNonComic = (await entries()).length;
    await clickContext(page.locator('#non-comic'), { linkUrl: 'https://momoniji.com/about/' });
    assert.equal((await entries()).length, beforeNonComic, 'native save does not accept an about page as a manga');

    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.clearDataForOrigin', { origin: 'https://momoniji.com', storageTypes: 'all' });
    await page.reload(); await savedBadge(ROOT).waitFor(); await downloadedBadge(ROOT).waitFor();
    assert.equal((await get(ROOT)).downloadedCount, 2, 'site data deletion keeps extension-local metadata');

    // Worker termination is issued against this test extension only, then an
    // actual popup message wakes its registered MV3 handler again.
    const workerVersions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => { for (const version of versions) workerVersions.set(version.versionId, version); });
    await cdp.send('ServiceWorker.enable');
    const version = await wait(async () => [...workerVersions.values()].find(value => value.scriptURL === `chrome-extension://${extensionId}/background.js` && value.runningStatus === 'running'), 'worker version metadata', 5000);
    await worker.evaluate(() => { globalThis.libraryBrowserSentinel = true; });
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await wait(async () => workerVersions.get(version.versionId)?.runningStatus === 'stopped', 'original worker actually stops', 5000);
    await popup.reload();
    assert.equal((await get(ROOT)).downloadedCount, 2, 'worker restart retains downloaded history');
    assert.equal((await get(SECOND)).readLater, true, 'worker restart retains read later');
    worker = context.serviceWorkers().find(value => value.url().includes(extensionId)) || await context.waitForEvent('serviceworker');
    assert.equal(await worker.evaluate(() => globalThis.libraryBrowserSentinel === true), false, 'restart creates a fresh worker global context');
    await context.close(); context = null;
    await launch();
    assert.equal((await get(ROOT)).downloadedCount, 2, 'profile restart retains image-download history');
    assert.equal((await get(SECOND)).readLater, true, 'profile restart retains read later');
    await page.goto(LISTING); await savedBadge(ROOT).waitFor(); await downloadedBadge(ROOT).waitFor();
    await popup.reload(); await popup.locator('#tab-read').click(); await popup.getByRole('link', { name: TITLES[0], exact: true }).waitFor();
    const seeded = await popup.evaluate(async () => {
      for (let number = 1; number <= 101; number++) {
        const response = await chrome.runtime.sendMessage({ type: 'MOMONIJI_LIBRARY_SAVE', work: { url: `https://momoniji.com/library-fixture-${number}/`, title: `段階表示の合成漫画 ${String(number).padStart(3, '0')}` } });
        if (!response?.ok) return false;
      }
      return true;
    });
    assert.equal(seeded, true, 'extension messages seed synthetic large-library metadata');
    await popup.reload();
    await wait(async () => await popup.locator('article.library-item').count() === 100, 'large library initially renders one hundred entries');
    await popup.locator('#load-more').waitFor();
    const dimensions = await popup.evaluate(() => ({ height: document.body.getBoundingClientRect().height, scrollHeight: document.body.scrollHeight, scrollWidth: document.documentElement.scrollWidth, listHeight: document.getElementById('library-list').clientHeight, listScrollHeight: document.getElementById('library-list').scrollHeight }));
    assert.ok(dimensions.height <= 600 && dimensions.scrollHeight <= 600, `popup stays within Chrome's six-hundred-pixel height (${JSON.stringify(dimensions)})`);
    assert.ok(dimensions.scrollWidth <= 420, 'large library has no horizontal overflow');
    assert.ok(dimensions.listScrollHeight > dimensions.listHeight, 'large library scrolls inside its list');
    if (process.env.SCREENSHOT_DIR) await popup.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'momoniji-library-popup-many-synthetic.png') });
    await popup.locator('#load-more').click();
    assert.equal(await popup.locator('article.library-item').count(), 102, 'load more renders remaining unread entries');
    await popup.locator('#search').fill('合成漫画 101');
    assert.equal(await popup.locator('article.library-item').count(), 1, 'search includes records beyond the first displayed batch');
    await popup.locator('#search').fill('');
    assert.equal(await popup.locator('article.library-item').count(), 100, 'clearing search resets the displayed batch');
    console.log('PASS large actual popup: one-hundred-entry batches, additional entries, complete-library search, inner scrolling, 600px height and no horizontal overflow');
    assert.deepEqual(errors, [], 'no uncaught content or popup errors');
    if (process.env.SCREENSHOT_DIR) { fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true }); await popup.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'momoniji-library-popup-synthetic.png') }); }
    console.log('PASS real Chrome library: native context-menu registration, actual right-click target capture with registered callback invocation, manga-link/current-viewer save, duplicate/page-two canonicalization, reader toggle, live listing badges, popup search/read filters/remove/undo, complete synthetic downloads and durable distinct history, unsafe/non-comic rejection, site-storage deletion, worker restart, profile restart');
    console.log('LIMITATION: headless Chrome cannot select the native OS menu item; after an actual page right-click, the same registered click callback is invoked in its real service worker with actual tab information.');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
