/* Optional real-site technical smoke test. No screenshots, site text, image URLs or images are retained. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
let phase = 'input';
let metadata = {};

async function snapshot(page) {
  const current = await page.evaluate(() => {
    const host = document.querySelector('#momoniji-reader');
    const shadow = host?.shadowRoot;
    const errorText = shadow?.querySelector('#error')?.textContent || '';
    const statusText = shadow?.querySelector('#status')?.textContent || '';
    const fixedErrors = [
      ['全ページを取得できません', 'INCOMPLETE_WORK'], ['対象外のページ', 'UNSUPPORTED_PAGE'], ['ページURLが不正', 'INVALID_PAGE_URL'], ['作品ページではありません', 'NOT_WORK_PATH'],
      ['作品情報を確認できません', 'INVALID_WORK_METADATA'], ['全ページ数を確認できません', 'INVALID_PAGE_COUNT'], ['漫画画像の情報が不正', 'INVALID_IMAGE_METADATA'], ['漫画画像を確認できません', 'MISSING_IMAGES'],
      ['ページ番号が不正', 'INVALID_PAGE_NUMBER'], ['作品ページの取得に失敗', 'PAGE_FETCH_FAILED'], ['作品ページの形式が変わっています', 'PAGE_CONTENT_TYPE_CHANGED'],
      ['作品ページが大きすぎます', 'PAGE_TOO_LARGE'], ['作品ページが多すぎます', 'TOO_MANY_SITE_PAGES'], ['作品ページの形式が不正', 'INVALID_PAGE_FORMAT'],
      ['同じ作品のページを確認できません', 'WORK_IDENTITY_MISMATCH'], ['ページの重複を確認しました', 'CONFLICTING_PAGE_DUPLICATE'], ['作品を確認できません', 'MISSING_WORK'],
      ['Failed to fetch', 'FETCH_NETWORK_FAILURE'], ['Load failed', 'FETCH_LOAD_FAILURE'], ['NetworkError', 'FETCH_NETWORK_ERROR'],
      ['timed out', 'FETCH_TIMEOUT'], ['TimeoutError', 'FETCH_TIMEOUT'], ['aborted', 'FETCH_ABORTED'], ['AbortError', 'FETCH_ABORTED'], ['Illegal invocation', 'ILLEGAL_INVOCATION'],
      ['AbortSignal.any is not a function', 'ABORT_SIGNAL_ANY_UNSUPPORTED'], ['AbortSignal.timeout is not a function', 'ABORT_SIGNAL_TIMEOUT_UNSUPPORTED'],
      ['TrustedHTML', 'TRUSTED_HTML_REQUIRED'], ['Trusted Types', 'TRUSTED_TYPES_REQUIRED'], ['Cannot read properties', 'NULL_PROPERTY_ACCESS'], ['is not defined', 'MISSING_GLOBAL'],
    ];
    const errorCode = !errorText ? 'NONE' : fixedErrors.find(([text]) => errorText.includes(text))?.[1] || 'UNKNOWN_RENDERER_ERROR';
    const statusCode = statusText.includes('作品ページを取得中') ? 'COLLECTING' : statusText.includes('読み込めました') ? 'READY' : statusText.includes('作品の取得に失敗') ? 'WORK_FETCH_FAILED' : statusText.includes('保存完了') ? 'SAVED' : 'OTHER';
    const count = statusText.match(/(\d+)\s*\/\s*(\d+)/);
    const whitelist = ['TypeError', 'fetch', 'AbortSignal', 'DOMParser', 'TrustedHTML', 'Trusted', 'parseFromString', 'signal', 'timeout', 'abort', 'invocation', 'CORS', 'blocked', 'redirect', 'NetworkError', 'Error', 'permission', 'storage', 'chrome', 'MomonijiMangaViewer', 'MangaViewer', 'undefined', 'null'];
    const errorTokens = Object.fromEntries(whitelist.map(token => [token, errorText.includes(token)]));
    return { topFrame: window.top === window, readyState: document.readyState, cifCount: document.querySelectorAll('#cif').length, siteImageCount: document.querySelectorAll('#cif .iw img[id^="c"]').length, extensionPresent: !!host, shadowPresent: !!shadow, stagePresent: !!shadow?.querySelector('#reader-stage'), rendererErrorPresent: !!shadow?.querySelector('#error'), rendererErrorCode: errorCode, errorTokens, statusCode, progressCount: count ? Number(count[1]) : null, progressTotal: count ? Number(count[2]) : null };
  });
  metadata = { ...metadata, ...current };
}

async function main() {
  assert.ok(process.env.MOMONIJI_LIVE_URL, 'MOMONIJI_LIVE_URL is required');
  const source = new URL(process.env.MOMONIJI_LIVE_URL);
  const allowedHosts = new Set(['momoniji.com', 'www.momoniji.com', 'img.momoniji.com']);
  assert.ok(source.protocol === 'https:' && ['momoniji.com', 'www.momoniji.com'].includes(source.hostname) && !source.username && !source.password && !source.port, 'live URL must belong to the supported site');
  const expected = process.env.MOMONIJI_LIVE_EXPECTED_PAGES ? Number(process.env.MOMONIJI_LIVE_EXPECTED_PAGES) : null;
  if (expected !== null) assert.ok(Number.isSafeInteger(expected) && expected > 0);
  const extension = fs.existsSync(path.resolve(__dirname, '../extension/manifest.json')) ? path.resolve(__dirname, '../extension') : path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momoniji-live-'));
  const downloadDirectory = path.join(temp, 'downloads');
  fs.mkdirSync(path.join(temp, 'profile', 'Default'), { recursive: true });
  fs.mkdirSync(downloadDirectory);
  fs.writeFileSync(path.join(temp, 'profile', 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDirectory, prompt_for_download: false } }));
  let context;
  let page;
  try {
    phase = 'launch';
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, acceptDownloads: false, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const failedNetwork = { ssl: 0, dns: 0, connection: 0, other: 0 };
    const failedRequestCodes = {};
    const failedRequestTypes = {};
    const failedHttp = [];
    context.on('requestfailed', request => {
      const url = new URL(request.url());
      if (!allowedHosts.has(url.hostname)) return;
      const text = request.failure()?.errorText || '';
      const type = /SSL|CERT/i.test(text) ? 'ssl' : /NAME_NOT_RESOLVED|DNS/i.test(text) ? 'dns' : /CONNECTION|TIMED_OUT/i.test(text) ? 'connection' : 'other';
      failedNetwork[type]++;
      const code = /^net::ERR_[A-Z_]+$/.test(text) ? text.slice(5) : 'UNCLASSIFIED';
      failedRequestCodes[code] = (failedRequestCodes[code] || 0) + 1;
      const kind = ['document', 'image', 'fetch', 'xhr', 'script', 'stylesheet', 'font', 'other'].includes(request.resourceType()) ? request.resourceType() : 'other';
      failedRequestTypes[kind] = (failedRequestTypes[kind] || 0) + 1;
    });
    context.on('response', response => { if (allowedHosts.has(new URL(response.url()).hostname) && response.status() >= 400) failedHttp.push(response.status()); });
    metadata.failedNetwork = failedNetwork; metadata.failedHttpStatuses = failedHttp; metadata.failedRequestCodes = failedRequestCodes; metadata.failedRequestTypes = failedRequestTypes;
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || request.resourceType() === 'script') return route.abort();
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    phase = 'goto';
    const response = await page.goto(source.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    metadata.httpStatus = response?.status() ?? null;
    metadata.responseType = response?.headers()['content-type']?.includes('text/html') ? 'HTML' : 'OTHER';
    await snapshot(page);
    phase = 'viewer';
    await page.locator('#momoniji-reader').locator('.mv-page-slider').waitFor({ timeout: 30000 });
    const technical = await page.evaluate(() => {
      const shadow = document.querySelector('#momoniji-reader').shadowRoot;
      const stage = shadow.querySelector('#reader-stage');
      return { total: Number(stage.shadowRoot.querySelector('.mv-page-slider').max), images: stage.shadowRoot.querySelectorAll('img[src]').length, saveEnabled: !shadow.querySelector('#download').disabled };
    });
    assert.equal(technical.images, technical.total);
    assert.ok(technical.total > 0 && technical.saveEnabled);
    if (expected !== null) assert.equal(technical.total, expected);
    phase = 'images';
    await page.waitForFunction(() => {
      const root = document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').shadowRoot;
      return Array.from(root.querySelectorAll('img[src]')).some(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    }, null, { timeout: 30000 });
    console.log(`PASS real-site DOM: ${technical.total} complete comic pages and loaded image dimensions`);

    if (process.env.MOMONIJI_LIVE_DOWNLOAD === '1' || process.env.MOMONIJI_LIVE_DOWNLOAD === 'all') {
      phase = 'download';
      const all = process.env.MOMONIJI_LIVE_DOWNLOAD === 'all';
      const imageUrl = await page.evaluate(() => {
        const root = document.querySelector('#momoniji-reader').shadowRoot.querySelector('#reader-stage').shadowRoot;
        return Array.from(root.querySelectorAll('img[src]')).find(image => image.complete && image.naturalWidth > 0)?.src;
      });
      const checked = new URL(imageUrl);
      assert.ok(checked.protocol === 'https:' && allowedHosts.has(checked.hostname) && !checked.username && !checked.password && !checked.port);
      const extensionName = checked.pathname.match(/\.(jpg|jpeg|png|webp|gif|avif)$/i)?.[1]?.toLowerCase();
      assert.ok(extensionName);
      if (all) await page.locator('#momoniji-reader').locator('#download').click();
      else await worker.evaluate(async ({ url, pageUrl, title }) => {
        await initialize();
        const canonical = Core.canonicalPageUrl(pageUrl);
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(tab => { try { return Core.canonicalPageUrl(tab.url) === canonical; } catch { return false; } });
        if (!tab) throw new Error('Live technical tab unavailable');
        return controller.start({ title, pageUrl: canonical, images: [url] }, tab.id);
      }, { url: imageUrl, pageUrl: page.url(), title: await page.locator('#momoniji-reader').locator('#title').textContent() });
      const deadline = Date.now() + (all ? 240000 : 45000);
      let download, job;
      let lastLog = Date.now();
      while (Date.now() < deadline) {
        const result = await worker.evaluate(async pageUrl => {
          const summary = await controller.status(pageUrl);
          const work = controller.jobs.find(work => work.pageUrl === Core.canonicalPageUrl(pageUrl));
          const id = work?.pages[0].downloadId;
          const items = id === null || id === undefined ? [] : await chrome.downloads.search({ id });
          return { job: summary, download: items[0] };
        }, page.url());
        job = result.job; download = result.download;
        if (job && !job.active && !job.pending) break;
        if (Date.now() - lastLog > 15000) {
          console.log(JSON.stringify({ completed: job?.completed, failed: job?.failed, total: job?.total })); lastLog = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const transfers = await worker.evaluate(async pageUrl => {
        const work = controller.jobs.find(work => work.pageUrl === Core.canonicalPageUrl(pageUrl));
        const records = await chrome.downloads.search({});
        return { folder: work.folder, extensionId: chrome.runtime.id, pages: work.pages.map((p, i) => ({ ...p, number: i + 1, expected: Core.filenameFor(work, p, i), download: records.find(d => d.id === p.downloadId) })) };
      }, page.url());
      const reasonCounts = {};
      for (const p of transfers.pages) {
        if (p.error) reasonCounts[p.error] = (reasonCounts[p.error] || 0) + 1;
      }
      const pathChecks = transfers.pages.filter(p => p.download).map(p => ({ number: p.number, state: p.download.state, reason: p.error, mime: p.download.mime,
        ownerMatches: p.download.byExtensionId === transfers.extensionId, urlMatches: p.download.url === p.url,
        rawPathMatches: p.download.filename.replace(/\\/g, '/').endsWith('/' + p.expected),
        normalizedPathMatches: p.download.filename.replace(/\\/g, '/').normalize('NFC').endsWith('/' + p.expected.normalize('NFC')),
        decomposedFilename: p.download.filename !== p.download.filename.normalize('NFC'),
        inTargetFolder: path.dirname(p.download.filename).normalize('NFC') === path.join(downloadDirectory, transfers.folder).normalize('NFC'),
      }));
      metadata.downloadSummary = { total: job?.total, completed: job?.completed, failed: job?.failed, reasonCounts, checks: pathChecks.filter(p => p.reason).slice(0, 5) };
      console.log(JSON.stringify({ total: job?.total, completed: job?.completed, failed: job?.failed, reasonCounts }));
      assert.equal(job?.completed, all ? technical.total : 1);
      assert.equal(job?.failed, 0);
      assert.equal(transfers.pages.length, all ? technical.total : 1);
      for (const p of transfers.pages) {
        const d = p.download;
        assert.equal(d?.state, 'complete');
        assert.equal(path.dirname(d.filename).normalize('NFC'), path.join(downloadDirectory, job.folder).normalize('NFC'));
        assert.ok(!path.relative(downloadDirectory, d.filename).startsWith('..'));
        const bytes = fs.readFileSync(d.filename);
        assert.ok(bytes.length > 32);
        const recognized = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 0, 3) === 'GIF' || bytes.toString('ascii', 4, 8) === 'ftyp';
        assert.ok(recognized, 'downloaded bytes have a recognized image signature');
        fs.unlinkSync(d.filename);
        await worker.evaluate(id => chrome.downloads.erase({ id }), d.id);
      }
      console.log(`PASS real Chrome image downloads: ${job.completed} complete files, correct per-work directory and image signatures; temporary files deleted`);
    }
    phase = 'complete';
  } catch (error) {
    if (page) await Promise.race([snapshot(page).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
    throw error;
  } finally {
    if (context) await context.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  // Browser errors can contain a work URL, so never print their original text or stack.
  console.error(`FAIL optional live smoke test (${error.name || 'Error'}, phase=${phase}); no site details retained`);
  console.error(JSON.stringify(metadata));
  process.exitCode = 1;
});
