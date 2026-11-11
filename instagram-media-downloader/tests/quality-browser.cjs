'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const extensionPath = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'better-ig');
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'downloads', 'storage']);
  assert.ok(manifest.content_scripts.find(script => script.js.includes('quality-content.js')).js.includes('content.js'));
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'better-ig-quality-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.storage.sync.set({ downloadEnabled: false }));
    const extensionId = new URL(worker.url()).host;
    await context.route('https://scontent.cdninstagram.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1080"><rect width="100%" height="100%" fill="#7354cc"/></svg>' }));
    await context.route('https://www.instagram.com/**', route => {
      const body = new URL(route.request().url()).pathname.includes('/live')
        ? '<main><video id="live" style="width:320px;height:480px"></video></main>'
        : '<main><article><img id="post-image" width="320" height="240" src="https://scontent.cdninstagram.com/small.svg" srcset="https://scontent.cdninstagram.com/small.svg 320w, https://scontent.cdninstagram.com/large.svg 1440w" sizes="320px"></article></main>';
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });
    });
    const page = await context.newPage(), popup = await context.newPage();
    const errors = [];for (const p of [page,popup]) p.on('pageerror', error => errors.push(error.message));
    const checks = [];
    await page.goto('https://www.instagram.com/p/ABC123/');
    await page.waitForFunction(() => document.querySelector('#post-image')?.classList.contains('instagram-hq-image'));
    const image = page.locator('#post-image');
    assert.match(await image.getAttribute('src'), /\/large\.svg$/);
    assert.equal(await image.getAttribute('srcset'), null);assert.equal(await image.getAttribute('sizes'), null);
    assert.equal(await page.locator('#igmd-root .tools:not(.hidden)').count(), 0);
    checks.push('HQ works while downloads are disabled');
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#export-history:not([disabled])').waitFor();
    assert.equal(await popup.locator('#download-enabled').isChecked(), false);
    assert.equal(await popup.locator('#quality-enabled').isChecked(), true);
    assert.equal(await popup.locator('#rotate-live').isChecked(), true);
    assert.equal(await popup.locator('#save').isDisabled(), true);
    await popup.locator('#quality-enabled').uncheck();
    await page.waitForFunction(() => !document.querySelector('#post-image').classList.contains('instagram-hq-image'));
    assert.match(await image.getAttribute('srcset'), /small\.svg 320w/);
    await popup.locator('#quality-enabled').check();
    await page.waitForFunction(() => document.querySelector('#post-image').classList.contains('instagram-hq-image'));
    checks.push('HQ setting restores and reapplies original image attributes');
    await popup.locator('#download-enabled').check();
    await page.locator('#igmd-root .tools:not(.hidden)').waitFor();
    await popup.locator('#download-enabled').uncheck();
    await page.waitForFunction(() => !document.querySelector('#igmd-root').shadowRoot.querySelector('.tools:not(.hidden)'));
    assert.equal(await popup.locator('#save').isDisabled(), true);
    checks.push('download toggle updates open page and bulk action immediately');
    await page.goto('https://www.instagram.com/alice/live/');
    await page.locator('#live').evaluate(video => {
      Object.defineProperties(video, { videoWidth: { configurable: true, value: 1080 }, videoHeight: { configurable: true, value: 1920 }, duration: { configurable: true, value: Infinity } });
      video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#live').classList.contains('instagram-hq-live-video'));
    await popup.locator('#rotate-live').uncheck();
    await page.waitForFunction(() => !document.querySelector('#live').classList.contains('instagram-hq-live-video'));
    checks.push('Live rotation and restoration remain independent of image quality');
    await popup.reload();await popup.locator('#export-history:not([disabled])').waitFor();
    assert.equal(await popup.locator('#download-enabled').isChecked(), false);
    assert.equal(await popup.locator('#quality-enabled').isChecked(), true);
    assert.equal(await popup.locator('#rotate-live').isChecked(), false);
    assert.deepEqual(errors, []);
    checks.push('combined popup persists all settings and retains history export');
    const output = path.join(extensionPath, 'test-results/quality');fs.mkdirSync(output,{recursive:true});
    await popup.screenshot({ path:path.join(output,'better-ig-popup.png'), fullPage:true });
    console.log(`PASS ${checks.length} better-ig quality and settings browser checks`);
    for(const check of checks)console.log('PASS '+check);
  } finally { await context?.close();fs.rmSync(profilePath,{recursive:true,force:true}); }
})().catch(error => { console.error(error);process.exitCode=1; });
