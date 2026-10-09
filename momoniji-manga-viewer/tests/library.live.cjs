/* Optional real-site library test. Only same-work HTML is allowed; images/scripts are blocked.
   No work URL, title, page text, image data or screenshot is printed or retained. */
'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const Library = require('../extension/library-core.js');
let phase = 'input';
const metadata = { allowedHtmlRequests: 0, successfulHtmlResponses: 0, blockedImages: 0, blockedScripts: 0, otherBlockedRequests: 0, imageResponses: 0, pageErrors: 0 };

async function main() {
  assert.ok(process.env.MOMONIJI_LIVE_URL, 'A supported live URL is required');
  const source = new URL(process.env.MOMONIJI_LIVE_URL);
  const canonical = Library.canonicalWorkUrl(source.href);
  const expected = process.env.MOMONIJI_LIVE_EXPECTED_PAGES ? Number(process.env.MOMONIJI_LIVE_EXPECTED_PAGES) : null;
  if (expected !== null) assert.ok(Number.isSafeInteger(expected) && expected > 0);
  const extension = path.resolve(__dirname, '../extension');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momoniji-library-live-'));
  let context;
  try {
    phase = 'launch';
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, acceptDownloads: false, viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      const type = request.resourceType();
      if (type === 'image') { metadata.blockedImages++; return route.abort(); }
      if (type === 'script') { metadata.blockedScripts++; return route.abort(); }
      let sameWork = false;
      try { sameWork = Library.canonicalWorkUrl(url.href) === canonical; } catch { /* Unrelated request is blocked. */ }
      if (sameWork && ['document', 'fetch', 'xhr'].includes(type)) { metadata.allowedHtmlRequests++; return route.continue(); }
      metadata.otherBlockedRequests++; return route.abort();
    });
    context.on('response', response => {
      if (response.request().resourceType() === 'image') metadata.imageResponses++;
      try {
        if (Library.canonicalWorkUrl(response.url()) === canonical && response.status() === 200 && /^text\/html(?:\s*;|$)/iu.test(response.headers()['content-type'] || '')) metadata.successfulHtmlResponses++;
      } catch { /* No remote content is retained. */ }
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    page.on('pageerror', () => { metadata.pageErrors++; });
    phase = 'navigate';
    const response = await page.goto(source.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    metadata.httpStatus = response?.status() ?? null;
    metadata.responseIsHtml = /^text\/html(?:\s*;|$)/iu.test(response?.headers()['content-type'] || '');
    assert.equal(metadata.httpStatus, 200, 'The work HTML must be retrieved successfully');
    assert.equal(metadata.responseIsHtml, true, 'The retrieved work must be HTML');
    phase = 'viewer';
    const reader = page.locator('#momoniji-reader');
    await reader.locator('.mv-page-slider').waitFor({ timeout: 45000 });
    metadata.totalPages = Number(await reader.locator('.mv-page-slider').getAttribute('max'));
    assert.ok(metadata.totalPages > 0);
    if (expected !== null) assert.equal(metadata.totalPages, expected, 'All work pages are collected from HTML');
    const button = reader.locator('#read-later');
    await button.waitFor();
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'Disposable profile starts without the work saved');
    phase = 'save';
    await button.click();
    await page.waitForFunction(() => document.querySelector('#momoniji-reader')?.shadowRoot?.querySelector('#read-later')?.getAttribute('aria-pressed') === 'true');
    assert.match(await button.textContent(), /保存済み/u);
    metadata.readerSaved = true;
    assert.equal(await worker.evaluate(() => chrome.contextMenus.onClicked.hasListener(handleLibraryContextClick)), true, 'Native-menu callback is registered');
    phase = 'duplicate';
    // Actual right-click is performed on the visible viewer toolbar. The OS
    // menu cannot be selected in headless Chrome, so call its registered listener.
    await button.click({ button: 'right' }); await page.keyboard.press('Escape');
    const actualTab = await worker.evaluate(async pageUrl => (await chrome.tabs.query({})).find(tab => tab.url === pageUrl), page.url());
    assert.ok(Number.isInteger(actualTab?.id));
    const duplicate = await worker.evaluate(async ({ tab, pageUrl }) => {
      const result = await handleLibraryContextClick({ menuItemId: 'momoniji-read-later', pageUrl, frameId: 0 }, tab);
      return { ok: result?.ok === true, count: result?.entries?.length, saved: result?.entries?.[0]?.readLater === true };
    }, { tab: actualTab, pageUrl: page.url() });
    assert.deepEqual(duplicate, { ok: true, count: 1, saved: true }, 'Native duplicate save keeps one work record');
    metadata.nativeDuplicateVerified = true;
    phase = 'popup';
    const popup = await context.newPage();
    popup.on('pageerror', () => { metadata.pageErrors++; });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront(); await popup.reload();
    await popup.locator('article.library-item').waitFor();
    assert.equal(await popup.locator('article.library-item').count(), 1, 'Popup shows one saved work');
    await popup.waitForFunction(() => document.getElementById('current-save')?.classList.contains('saved') === true);
    assert.equal(await popup.locator('#current-save').isDisabled(), true, 'Current work is already saved');
    assert.match(await popup.locator('#current-save-label').textContent(), /保存済み/u);
    const checks = await popup.evaluate(async expectedUrl => {
      const result = await chrome.runtime.sendMessage({ type: 'MOMONIJI_LIBRARY_LIST' });
      const entry = result?.entries?.[0];
      const title = document.querySelector('article.library-item .item-title')?.textContent;
      return { ok: result?.ok === true, oneRecord: result?.entries?.length === 1, correctWork: entry?.url === expectedUrl, titleMatchesRecord: typeof title === 'string' && title.length > 0 && title === entry?.title, readLater: entry?.readLater === true, falselyDownloaded: entry?.downloadedAt !== null };
    }, canonical);
    assert.deepEqual(checks, { ok: true, oneRecord: true, correctWork: true, titleMatchesRecord: true, readLater: true, falselyDownloaded: false });
    metadata.popupSaved = true;
    phase = 'site-reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await reader.locator('#read-later').waitFor();
    await page.waitForFunction(() => document.querySelector('#momoniji-reader')?.shadowRoot?.querySelector('#read-later')?.getAttribute('aria-pressed') === 'true');
    assert.equal(metadata.imageResponses, 0, 'No remote images were fetched');
    assert.ok(metadata.blockedImages > 0, 'Remote image requests were actively blocked');
    assert.ok(metadata.successfulHtmlResponses > 0, 'Live HTML was actually retrieved');
    assert.equal(metadata.pageErrors, 0, 'No uncaught page or extension errors');
    metadata.reloadSaved = true;
    phase = 'complete';
    console.log('PASS optional real-site library: actual same-work HTML, reader saved state, registered native duplicate callback, one canonical record, popup saved state, page-reload persistence; image/script requests blocked, no site content retained');
    console.log(JSON.stringify(metadata));
    console.log('LIMITATION: headless Chrome cannot select the native OS context-menu item; its registered callback is invoked after an actual right-click using actual tab information.');
  } finally {
    try { if (context) await context.close(); }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
}
main().catch(error => {
  // Error messages and stacks may include a work URL or title: never print them.
  console.error(`FAIL optional real-site library (${error?.name || 'Error'}, phase=${phase}); no site details retained`);
  console.error(JSON.stringify(metadata));
  process.exitCode = 1;
});
