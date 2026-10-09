/* Exercises the real MV3 extension, downloads API and OSS viewer using only synthetic images. */
const { chromium } = require('playwright');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { ROOT, workHtml } = require('./fixtures.cjs');
const WORK_TITLE = 'ガギグゲゴ・パピプペポの漫画';
const DOWNLOAD_ROOT = 'momoniji-manga-viewer';
const SINGLE_PAGE_ROOT = 'https://momoniji.com/single-page-comic/';

function png(number) {
  const width = 720, height = 1017;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const index = row + 1 + x * 3;
      const border = x < 24 || x >= width - 24 || y < 24 || y >= height - 24;
      const panel = x > 65 && x < 655 && ((y > 90 && y < 340) || (y > 390 && y < 920));
      const circle = (x - 360) ** 2 + (y - 645) ** 2 < 95 ** 2;
      raw[index] = border ? 30 + number * 20 : circle ? 34 : panel ? 220 : 250;
      raw[index + 1] = border ? 70 : circle ? 120 : panel ? 226 : 250;
      raw[index + 2] = border ? 150 : circle ? 170 : panel ? 234 : 250;
    }
  }
  function chunk(type, body) {
    const typeBuffer = Buffer.from(type);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([typeBuffer, body])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, typeBuffer, body, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momoniji-browser-'));
  const downloadDirectory = path.join(temp, 'downloads');
  fs.mkdirSync(path.join(temp, 'profile', 'Default'), { recursive: true });
  fs.mkdirSync(downloadDirectory);
  fs.writeFileSync(path.join(temp, 'profile', 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDirectory, prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
  const extension = fs.existsSync(path.resolve(__dirname, '../extension/manifest.json')) ? path.resolve(__dirname, '../extension') : path.resolve(__dirname, '..');
  const certPath = path.join(temp, 'cert.pem'), keyPath = path.join(temp, 'key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=momoniji.test'], { stdio: 'ignore' });
  assert.equal(generated.status, 0, 'openssl creates a temporary local-test certificate');
  const failedPages = new Set();
  const hits = [];
  const timers = new Set();
  let slow = false, failChapter = false;
  const images = new Map(Array.from({ length: 6 }, (_, index) => [index + 1, png(index + 1)]));
  const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.hostname === 'momoniji.com') {
      if (url.pathname === '/listing/') { res.setHeader('Content-Type', 'text/html'); return res.end('<main><h1>一覧</h1></main>'); }
      if (url.pathname === '/single-page-comic/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        hits.push('html:single-blank');
        return res.end(workHtml({ id: '456', title: '全ページ数が空の単ページ漫画', total: 11, perSitePage: 11, metadataTotal: null, pagerRanges: true, links: [SINGLE_PAGE_ROOT] }).replace('/test/006.png', '/test/006.webp'));
      }
      const sitePage = Number(url.pathname.match(/\/page\/(\d+)\//)?.[1] || 1);
      if (failChapter && sitePage === 2) { res.writeHead(503); return res.end('Unavailable'); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      hits.push(`html:${sitePage}`);
      return res.end(workHtml({ sitePage, title: WORK_TITLE, pagerRanges: true, metadataTotal: sitePage === 1 ? 5 : null, omitTotal: sitePage === 3 }).replace('/test/006.png', '/test/006.webp'));
    }
    const number = Number(url.pathname.match(/\/test\/(\d+)\.(?:png|webp)$/)?.[1]);
    hits.push(`image:${number || 'excluded'}`);
    if (!number || !images.has(number)) { res.writeHead(404); return res.end('Not found'); }
    if (failedPages.has(number)) { res.writeHead(503); return res.end('Unavailable'); }
    const body = images.get(number);
    res.writeHead(200, { 'Content-Type': number === 6 ? 'image/webp' : 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    if (!slow) return res.end(body);
    res.write(body.subarray(0, Math.floor(body.length / 2)));
    const timer = setTimeout(() => { timers.delete(timer); res.end(body.subarray(Math.floor(body.length / 2))); }, 12000);
    timers.add(timer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, acceptDownloads: false, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP momoniji.com 127.0.0.1:${port}, MAP img.momoniji.com 127.0.0.1:${port}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    // Chromium encodes a synthetic canvas as an actual WebP; the sixth page must
    // exercise image/webp handling rather than PNG bytes with a renamed suffix.
    const webp = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 720; canvas.height = 1017;
      const draw = canvas.getContext('2d');
      draw.fillStyle = '#fafafa'; draw.fillRect(0, 0, 720, 1017);
      draw.fillStyle = '#2678aa'; draw.fillRect(30, 30, 660, 957);
      draw.fillStyle = '#dee2ea'; draw.fillRect(65, 90, 590, 250); draw.fillRect(65, 390, 590, 530);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
      if (!blob || blob.type !== 'image/webp') throw new Error('Synthetic WebP encoding unavailable');
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    images.set(6, Buffer.from(webp));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const reader = page.locator('#momoniji-reader');
    const inner = selector => reader.locator(selector);
    const job = (pageUrl = ROOT) => worker.evaluate(async pageUrl => {
      await initialize();
      return { ok: true, job: await controller.status(pageUrl) };
    }, pageUrl);
    const downloads = () => worker.evaluate(() => chrome.downloads.search({}));
    const waitJob = async (predicate, timeout = 30000, pageUrl = ROOT) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const response = await job(pageUrl);
        if (response.ok && response.job && predicate(response.job)) return response.job;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Download job did not reach the required state');
    };

    await page.goto('https://momoniji.com/listing/');
    assert.equal(await reader.count(), 0, 'listing pages are unchanged');
    await page.goto(ROOT);
    await inner('.mv-page-slider').waitFor();
    assert.equal(await inner('.mv-page-slider').getAttribute('max'), '6', 'verified pager ranges override the stale five-page table');
    assert.equal(await inner('#reader-stage').isVisible(), true, 'viewer automatically opens');
    assert.equal(await inner('#download').isEnabled(), true, 'download enables only after the complete work is collected');
    assert.ok(hits.includes('html:2') && hits.includes('html:3'), 'later site pages with blank or absent count tables are collected');
    await inner('.mv-tap-area.mv-left').click();
    await page.waitForFunction(() => Number(document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').shadowRoot.querySelector('.mv-page-slider').value) > 1);
    assert.ok(await inner('.mv-spread-slot').count() > 0, 'landscape includes two-page spreads');
    const moveTo = async number => {
      await inner('.mv-page-slider').evaluate((element, number) => { element.value = String(number); element.dispatchEvent(new Event('input', { bubbles: true })); }, number);
      await page.waitForFunction(number => document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').dataset.page === String(number), number);
    };
    await inner('#direction').selectOption('ltr');
    await moveTo(1);
    await inner('.mv-tap-area.mv-right').click();
    await page.waitForFunction(() => Number(document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').dataset.page) > 1);
    await inner('#direction').selectOption('rtl');
    assert.equal(await inner('.mv-resume-dialog').count(), 0, 'direction switch dismisses any resume dialog');
    const pageBeforeModeChange = await inner('#reader-stage').getAttribute('data-page');
    await inner('#mode').selectOption('scroll');
    assert.equal(await inner('.mv-scroll-mode').count(), 1, 'vertical mode is available');
    assert.equal(await inner('#reader-stage').getAttribute('data-page'), pageBeforeModeChange, 'mode switch keeps the reading position');
    assert.equal(await inner('.mv-resume-dialog').count(), 0);
    await inner('#mode').selectOption('page');
    await inner('.mv-zoom-btn[title="Zoom in"]').click();
    assert.equal(await inner('.mv-zoom-btn[title="Reset zoom"]').isEnabled(), true);
    await inner('#reader-stage').focus();
    await page.keyboard.press('Escape');
    assert.equal(await inner('#reader-stage').isVisible(), true, 'Escape resets zoom first');
    assert.equal(await inner('.mv-zoom-btn[title="Reset zoom"]').isEnabled(), false);
    await page.keyboard.press('Escape');
    assert.equal(await inner('#reader-stage').isVisible(), false, 'second Escape closes the viewer');
    await inner('#open').click();
    await inner('#close').click();
    assert.equal(await inner('#reader-stage').isVisible(), false);
    await inner('#open').click();
    assert.equal(await inner('#reader-stage').isVisible(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await reader.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'mobile reader fits viewport');
    await page.setViewportSize({ width: 1280, height: 900 });
    await moveTo(1);
    await inner('#reader-stage').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => Number(document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').dataset.page) > 1);
    await moveTo(2);
    await page.waitForFunction(() => {
      const outer = document.querySelector('#momoniji-reader').shadowRoot;
      const stage = outer.querySelector('#reader-stage');
      const rect = stage.getBoundingClientRect();
      const images = Array.from(stage.shadowRoot.querySelectorAll('.mv-page-slot[data-slot="1"] img'));
      return images.length === 2 && images.every(image => {
        const imageRect = image.getBoundingClientRect();
        return image.naturalWidth > 0 && imageRect.width > 0 && imageRect.x >= rect.x - 1 && imageRect.right <= rect.right + 1 && imageRect.y >= rect.y - 1 && imageRect.bottom <= rect.bottom + 1;
      }) && rect.y >= outer.querySelector('#toolbar').getBoundingClientRect().bottom;
    });
    if (process.env.SCREENSHOT_DIR) {
      await page.waitForFunction(() => {
        const loading = document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').shadowRoot.querySelector('.mv-loading-screen');
        return !loading || getComputedStyle(loading).display === 'none' || Number(getComputedStyle(loading).opacity) < 0.01;
      });
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'momoniji-synthetic-reader.png') });
    }

    await inner('#download').click();
    const complete = await waitJob(value => !value.active && value.completed === 6 && value.failed === 0);
    assert.equal(complete.total, 6);
    assert.match(complete.folder, new RegExp(`^${DOWNLOAD_ROOT}/${WORK_TITLE}-[a-f0-9]{16}$`), 'extension root contains a separate Japanese work-title directory');
    const firstDownloads = (await downloads()).filter(download => download.state === 'complete');
    assert.equal(firstDownloads.length, 6, 'real Chrome downloads saves all pages');
    const parentFolders = new Set(firstDownloads.map(download => path.dirname(download.filename)));
    assert.equal(parentFolders.size, 1, 'one work uses one directory');
    assert.equal([...parentFolders][0].normalize('NFC'), path.join(downloadDirectory, complete.folder).normalize('NFC'), 'Chrome honors the extension and per-work subdirectories, including Unicode-equivalent Japanese titles');
    assert.equal(fs.readdirSync(downloadDirectory).map(value => value.normalize('NFC')).join(), DOWNLOAD_ROOT, 'the Downloads root contains only the extension directory');
    assert.equal(fs.readdirSync(path.join(downloadDirectory, DOWNLOAD_ROOT)).length, 1, 'the extension directory contains the work directory');
    assert.equal(new Set(firstDownloads.map(download => path.basename(download.filename))).size, 6, 'page filenames are unique');
    assert.ok(firstDownloads.every(download => /^\d{4}\.(?:png|webp)$/.test(path.basename(download.filename))), 'numbered filenames are padded for stable sorting');
    assert.deepEqual(firstDownloads.map(download => Number(path.parse(download.filename).name)).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    for (const download of firstDownloads) {
      const bytes = fs.readFileSync(download.filename);
      if (download.filename.endsWith('.webp')) {
        assert.equal(download.mime, 'image/webp');
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
        assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      } else assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    assert.equal(await inner('#progress').evaluate(element => Number(element.value) / Number(element.max)), 1);

    failedPages.add(3);
    await inner('#download').click();
    const partial = await waitJob(value => value.failed === 1 && !value.active && !value.pending);
    assert.equal(partial.completed, 5);
    assert.equal(partial.total, 6);
    assert.equal(partial.failures[0].page, 3);
    assert.ok(await inner('#retry').isVisible());
    failedPages.clear();
    const successfulBeforeRetry = (await downloads()).filter(download => download.state === 'complete').length;
    await inner('#retry').click();
    await waitJob(value => value.completed === 6 && value.failed === 0 && !value.active);
    const successfulAfterRetry = (await downloads()).filter(download => download.state === 'complete').length;
    assert.equal(successfulAfterRetry - successfulBeforeRetry, 1, 'retry downloads only the failed page');
    const repeatedDownloads = (await downloads()).filter(download => download.state === 'complete' && !firstDownloads.some(first => first.id === download.id));
    assert.equal(repeatedDownloads.length, 6, 'repeated save and retry preserve all six pages');
    assert.ok(repeatedDownloads.every(download => /^\d{4} \(1\)\.(?:png|webp)$/.test(path.basename(download.filename))), 'Chrome uniquifies repeated page files inside the same work directory');
    assert.ok(repeatedDownloads.every(download => path.dirname(download.filename).normalize('NFC') === path.join(downloadDirectory, complete.folder).normalize('NFC')), 'repeated downloads stay in the extension/work directory');

    slow = true;
    await inner('#download').click();
    await waitJob(value => value.active > 0);
    await inner('#cancel').click();
    const cancelled = await waitJob(value => !value.active && !value.pending && value.cancelled > 0);
    assert.ok(cancelled.cancelled > 0, 'cancellation stops pending and active downloads');
    slow = false;

    await moveTo(6);
    failChapter = true;
    await page.reload();
    await inner('#error').waitFor({ state: 'visible' });
    assert.equal(await inner('#download').isEnabled(), false, 'partial work cannot be downloaded');
    failChapter = false;
    await inner('#reload').click();
    await inner('.mv-page-slider').waitFor();
    assert.equal(await inner('#download').isEnabled(), true, 'page collection can recover');
    await inner('.mv-resume-btn.mv-primary').click();
    await page.waitForFunction(() => document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').dataset.page === '6');
    // The OSS viewer saves on beforeunload, so clear only after the new document starts.
    await page.addInitScript(() => localStorage.clear());
    await page.goto(`${ROOT}page/2/`);
    await inner('.mv-page-slider').waitFor();
    await page.waitForFunction(() => document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').dataset.page === '3');
    assert.equal(await inner('.mv-page-slider').getAttribute('max'), '6', 'middle-site-page entry collects the complete work despite its blank table and the stale first-page table');
    for (let number = 7; number <= 11; number += 1) images.set(number, png(number));
    await page.goto(SINGLE_PAGE_ROOT);
    await inner('.mv-page-slider').waitFor();
    assert.equal(await inner('.mv-page-slider').getAttribute('max'), '11', 'a single site page with a blank total table opens the full eleven-page viewer');
    assert.equal(await inner('#reader-stage').isVisible(), true);
    assert.equal(await inner('#download').isEnabled(), true);
    assert.equal(await inner('#error').count(), 0, 'the blank count table does not stop the viewer');
    await inner('#download').click();
    const blankTotal = await waitJob(value => value.completed === 11 && value.failed === 0 && !value.active, 30000, SINGLE_PAGE_ROOT);
    assert.equal(blankTotal.total, 11);
    const blankTotalDownloads = (await downloads()).filter(download => download.state === 'complete' && path.dirname(download.filename).normalize('NFC') === path.join(downloadDirectory, blankTotal.folder).normalize('NFC'));
    assert.equal(blankTotalDownloads.length, 11, 'all eleven images are actually saved for the blank-table work');
    assert.notEqual(blankTotal.folder, complete.folder, 'a different work has its own directory');
    assert.deepEqual(blankTotalDownloads.map(download => Number(path.parse(download.filename).name)).sort((a, b) => a - b), Array.from({ length: 11 }, (_, index) => index + 1));
    for (const download of blankTotalDownloads) assert.deepEqual(fs.readFileSync(download.filename), images.get(Number(path.parse(download.filename).name)), 'saved synthetic image bytes are complete');
    assert.deepEqual(errors, [], 'no uncaught extension errors');
    console.log('PASS actual MV3 browser: automatic OSS viewer, stale/blank/absent total-table recovery through verified pager ranges, complete chapter collection, RTL/LTR navigation, spreads, vertical mode, zoom, reading-position resume, close/open, mobile layout, extension/work download directories, Japanese voiced and semi-voiced filenames, actual PNG/WebP image downloads, repeated-save uniquify, retry-only-failures, cancellation, fetch-error recovery, eleven-page single-site-page viewer and complete image save');
  } finally {
    if (context) await context.close();
    for (const timer of timers) clearTimeout(timer);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
