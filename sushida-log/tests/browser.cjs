'use strict';
// Loads Sushida Log into Chromium and serves stand-in sushida.net pages, then checks what the extension
// saves and downloads. Run from this folder: npm ci && npx playwright install chromium && npm run test:browser
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SHARE = '高級10,000円コース【普通】\n★7,700円分 お得でした！（速度：5.9key/秒、ミス：18key）\nhttps://sushida.net/ #寿司打';
const PAGE = 'https://sushida.net/play.html';
const html = body => `<!doctype html><meta charset="utf-8"><title>sushida</title><body>${body}</body>`;

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sushida-log-'));
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: path.join(temp, 'downloads'),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    // Every sushida.net request gets a local page, so nothing reaches the real site.
    await context.route('https://sushida.net/**', route => route.fulfill({ contentType: 'text/html', body: html('') }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    // Playwright stores downloads under random names, so record the names the extension asks for.
    await worker.evaluate(() => {
      const download = chrome.downloads.download.bind(chrome.downloads);
      self.requested = [];
      chrome.downloads.download = options => { self.requested.push(options.filename); return download(options); };
    });
    const downloads = () => worker.evaluate(async () => ({ requested: self.requested, files: (await chrome.downloads.search({ state: 'complete' })).map(item => item.filename) }));

    // A finished game shows an X share link; the result is saved once and the CSV goes to sushida-log/.
    const page = await context.newPage();
    await page.goto(PAGE);
    await page.evaluate(text => { const link = document.createElement('a'); link.href = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`; link.textContent = 'share'; document.body.append(link); }, SHARE);
    let saved;
    for (let i = 0; i < 50 && !(saved = await worker.evaluate(async () => (await chrome.storage.local.get('results')).results || [])).length; i++) await page.waitForTimeout(100);
    assert.equal(saved.length, 1, 'the share text is saved');
    assert.equal(saved[0].amountYen, 7700);
    await page.waitForTimeout(1500);
    const { requested, files } = await downloads();
    assert.deepEqual(requested, ['sushida-log/sushida-results.csv'], `one CSV in sushida-log/, got ${JSON.stringify(requested)}`);
    assert.equal(files.length, 1);
    const csv = fs.readFileSync(files[0], 'utf8');
    assert.match(csv, /^savedAt,updatedAt,source,course,/);
    assert.equal(csv.match(/"高級10,000円コース","普通","profit","7700"/g)?.length, 1, 'the result appears once');
    console.log(`PASS one CSV per result: ${requested[0]}`);

    // The network record keeps the page URL, which comes from sender.tab.url.
    await worker.evaluate(() => chrome.storage.local.set({ settings: { autoDownloadCsv: false, autoResultNetworkRecord: true, autoDownloadJson: false, settingsVersion: 2 } }));
    await page.evaluate(() => window.postMessage({ source: 'SUSHIDA_LOG_PAGE', type: 'result-response', url: 'https://sushida.net/php/r.php', responseText: 'ok' }, '*'));
    let network;
    for (let i = 0; i < 50 && !(network = await worker.evaluate(async () => (await chrome.storage.local.get('networkResults')).networkResults || [])).length; i++) await page.waitForTimeout(100);
    assert.equal(network.length, 1, 'the result request is recorded');
    assert.equal(network[0].pageUrl, PAGE);
    console.log(`PASS network record keeps the page URL: ${network[0].pageUrl}`);
  } finally {
    await context.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
