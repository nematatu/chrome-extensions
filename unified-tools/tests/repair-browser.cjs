'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const extension = path.join(root, 'dist/my-tools');
const output = path.resolve(__dirname, '../test-results');
const html = '<!doctype html><html><body><main style="width:420px;margin:40px auto"><article><a href="/p/STALE/">fixture</a><video id="media" src="https://scontent.cdninstagram.com/v/repair.mp4" width="420" height="570" style="display:block"></video></article></main></body></html>';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-repair-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, viewport: { width: 1100, height: 850 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    context.setDefaultTimeout(20000);
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    let expected = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      expected = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
      if (expected > 20) break;
      await wait(100);
    }
    assert.ok(expected > 20, `expected all registrations, got ${expected}`);
    await context.route('https://www.instagram.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));

    const registrations = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    await worker.evaluate(ids => chrome.scripting.unregisterContentScripts({ ids }), registrations.map(value => value.id));
    const page = await context.newPage();
    await page.goto('https://www.instagram.com/p/STALE/');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#igmd-root').count(), 0);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.instagram.com/p/STALE/' }))[0].id);
    assert.equal(await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => Boolean(globalThis.MyToolsClient) }))[0].result, tabId), false, 'the stale tab must start without content scripts');

    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/popup.html`);
    await manager.locator('#instagram:not([disabled])').waitFor();
    await page.bringToFront();
    const first = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'my-tools:ensure-active' }));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.injected > 0, JSON.stringify(first));
    await page.getByRole('button', { name: 'この画像・動画を保存', exact: true }).waitFor();
    assert.equal(await page.locator('#igmd-root').count(), 1);
    const second = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'my-tools:ensure-active' }));
    assert.equal(second.ok, true);
    assert.equal(second.injected, 0);
    assert.equal(await page.locator('#igmd-root').count(), 1);
    assert.equal(await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => Boolean(globalThis.MyToolsClient) }))[0].result, tabId), true);
    console.log('PASS opening the manager injects a stale active tab once without duplicate UI');
    await page.screenshot({ path: path.join(output, 'repair-instagram.png'), fullPage: true });
  } finally {
    await context?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
