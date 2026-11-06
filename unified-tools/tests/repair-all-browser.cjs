'use strict';

/*
 * Verifies that the active-tab repair path restores every page feature, not
 * only Instagram. Content scripts are unregistered before each fixture page is
 * opened, so each page starts in the same stale state as a tab that was open
 * before My Tools was loaded or updated.
 *
 *   cd unified-tools
 *   NODE_PATH=../instagram-media-downloader/node_modules node tests/repair-all-browser.cjs
 */

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { workHtml } = require('../../momoniji-manga-viewer/tests/fixtures.cjs');

const root = path.resolve(__dirname, '../..');
const extension = path.join(root, 'dist/my-tools');
const config = vm.runInNewContext(fs.readFileSync(path.join(extension, 'config.js'), 'utf8') + ';MyToolsConfig');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function patternMatches(pattern, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (pattern === '<all_urls>') return true;
    const parts = pattern.match(/^(\*|https?|file):\/\/([^/]+)(\/.*)$/);
    if (!parts || (parts[1] !== '*' && `${parts[1]}:` !== url.protocol)) return false;
    const host = parts[2];
    if (host !== '*' && !(host.startsWith('*.') ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.host === host)) return false;
    return new RegExp(`^${parts[3].split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(url.pathname + url.search);
  } catch { return false; }
}

function expectedInjections(url) {
  const direct = config.registrations.filter(script => (script.matches || []).some(pattern => patternMatches(pattern, url))
    && !(script.excludeMatches || []).some(pattern => patternMatches(pattern, url)));
  const directIds = new Set(direct.map(script => script.id));
  const modules = new Set(direct.map(script => script.module));
  return config.registrations.filter(script => directIds.has(script.id) || (script.allFrames && modules.has(script.module))).length;
}

const igHtml = '<!doctype html><html><body><main style="width:420px;margin:40px auto"><article><a href="/p/REPAIR/">fixture</a><video src="https://scontent.cdninstagram.com/v/repair.mp4" width="420" height="570" style="display:block"></video><img width="400" height="300" src="https://scontent.cdninstagram.com/low.png" srcset="https://scontent.cdninstagram.com/high.png 2000w"></article></main></body></html>';
const gofileHtml = '<!doctype html><html><body><div id="index_header"></div><div id="filemanager_maincontent">Synthetic Gofile folder</div></body></html>';
const videoJs = '<div class="video-js" style="width:640px;height:360px"><video class="vjs-tech"></video><div class="vjs-chrome-bottom"><div class="vjs-chrome-controls"><div class="vjs-left-controls"><button class="vjs-play-control"></button></div></div></div></div>';
const data = JSON.parse(fs.readFileSync(path.join(root, 'inhigh-tv-match-links/data/matches.json')));
const entries = data.matches || data.entries;
const entry = entries.find(value => value.tournamentType === 'individual' && value.status === 'available');
const share = 'お手軽3,000円コース【普通】\n★1,000円分 お得 でした！（速度：4.2key/秒、ミス：3key） https://sushida.net';

const fixtures = [
  { id: 'instagram', url: 'https://www.instagram.com/p/REPAIR/', selector: '#igmd-root' },
  { id: 'gofile', url: 'https://gofile.io/d/RepairCode', selector: '#gofile-bulk-video-button-host' },
  { id: 'googlephotos', url: 'https://photos.google.com/photo/repair', html: '<html><body>Fixture</body></html>', selector: '.gpu-panel' },
  { id: 'badspi', url: 'https://www.badspi.jp/repair/', html: '<div id="lightbox"><img id="lightboxImage" src="https://www.badspi.jp/wp-content/uploads/2026/01/test-300x200.jpg"><div id="imageData"></div></div>', selector: '#badspi-hq-download' },
  { id: 'inhighlinks', url: 'https://www.birdscore.live/web/interhigh-2026-wakayama-Individual/repair', html: `<bsw-individual-match-card><div class="item">${entry.matchNo}</div></bsw-individual-match-card>`, selector: '.inhigh-match-link' },
  { id: 'inhighskip', url: 'https://inhightv.sportsbull.jp/summer/archive/repair', html: videoJs, selector: '.inhigh-skip-button' },
  { id: 'kltra', url: 'https://kltratv13.blogspot.com/p/galaxy.html', html: '<div id="video-wrapper-container" style="width:600px;height:340px"></div><div id="chat"><iframe class="chat-iframe" data-src="https://www3.cbox.ws/box/?boxid=3538770&boxtag=Dn3dpG" src="https://www3.cbox.ws/box/?boxid=3538770&boxtag=Dn3dpG"></iframe></div>', selector: '.kltra-danmaku-layer' },
  { id: 'koutairen', url: 'https://www.zenkoku-koutairen-bad.com/repair', html: '<div class="game-detail-gallery-item-photos-photo"><img src="data:image/png;base64,' + image.toString('base64') + '"></div>', selector: '.kgf-overlay:not([hidden])', after: async page => { await page.locator('img').click(); } },
  { id: 'momoniji', url: 'https://momoniji.com/repair-comic/', html: workHtml({ total: 2, perSitePage: 2 }), selector: '#momoniji-reader' },
  { id: 'r2', url: 'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/r2/default/buckets/repair', html: '<table data-testid="objects-table"><thead><tr><th>Name</th></tr></thead><tbody><tr><td>fixture.png</td></tr></tbody></table>', selector: '.r2-preview-cell' },
  { id: 'smashnet', url: 'https://www.smash-net.tv/photo/repair', html: '<ul class="movie002-list"><li><img src="data:image/png;base64,' + image.toString('base64') + '"><p>Fixture</p></li></ul>', selector: '#snt-photo-viewer .viewer.open', after: async page => { await page.locator('.movie002-list img').click(); } },
  { id: 'sushida', url: 'https://sushida.net/play.html', html: '<a href="https://x.com/intent/tweet?text=' + encodeURIComponent(share) + '">share</a>', after: async page => { await page.locator('a').waitFor(); } },
  { id: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk', html: '<div id="movie_player"><video></video></div><div id="top-level-buttons-computed"></div>', selector: '#youtube-five-second-clip' },
  { id: 'tweetfile', url: 'https://cdn.tweetfile.com/repair', html: '<div id="app"></div>', selector: '#tweetfile-downloader' },
  { id: 'pagemedia', url: 'https://twfiles.com/repaircode', html: '<div id="app"><div class="app-page--content"><div class="landing-content"><div class="content-list"><button class="video-row"><span class="video-copy"><strong>fixture.mp4</strong></span></button></div></div></div></div>', selector: '#page-media-bulk-button-host' },
  { id: 'stripchat', url: 'https://ja.stripchat.com/repair', html: '<div style="width:250px;height:200px"><a href="/fixturemodel" data-model-list-link="true" data-model-id="123" style="display:block;width:250px;height:200px"><div class="live-thumb"><video></video></div></a></div>', selector: '.sc-live-hover-badge', after: async page => { await page.locator('a').hover(); } },
  { id: 'xhashtags', url: 'https://x.com/compose/post', html: '<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true" style="width:500px;height:200px"><span data-text="true"></span></div><button data-testid="tweetButton">Post</button></div>', after: async page => { await page.waitForFunction(() => document.querySelector('[data-testid="tweetTextarea_0"]').innerText.includes('#repair')); } }
];

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-repair-all-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium', headless: true, viewport: { width: 1100, height: 850 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    context.setDefaultTimeout(20000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    let registrations = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    for (let attempt = 0; attempt < 100 && registrations.length < config.registrations.length; attempt++) {
      await wait(100);
      registrations = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    }
    assert.equal(registrations.length, config.registrations.length, 'all generated registrations must be present before the stale-tab test');

    await context.route('https://www.instagram.com/**', route => {
      const body = igHtml;
      return route.fulfill({ contentType: 'text/html', body });
    });
    await context.route('https://scontent.cdninstagram.com/**', route => route.fulfill({ contentType: 'image/png', body: image }));
    await context.route('https://gofile.io/**', route => route.fulfill({ contentType: 'text/html', body: gofileHtml }));
    await context.route('https://www.badspi.jp/wp-content/uploads/**', route => route.fulfill({ contentType: 'image/png', body: image }));
    await context.route('https://img.momoniji.com/**', route => route.fulfill({ contentType: 'image/png', body: image }));
    await context.route('https://assets.blog.amatatu.com/**', route => route.fulfill({ contentType: 'image/png', body: image }));
    await context.route('https://www3.cbox.ws/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="messages"></div></body></html>' }));
    for (const fixture of fixtures) {
      if (fixture.html) await context.route(fixture.url, route => route.fulfill({ contentType: 'text/html', body: fixture.html }));
    }

    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/popup.html`);
    await manager.locator('#instagram:not([disabled])').waitFor();
    const snapshot = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'my-tools:get' }));
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    for (const fixture of fixtures) assert.equal(snapshot.settings.enabled[fixture.id], true, `${fixture.id} must be enabled`);
    await worker.evaluate(() => MyToolsRuntime.moduleChrome('xhashtags').storage.sync.set({ hashtags: '#repair #unified' }));
    await worker.evaluate(() => MyToolsRuntime.moduleChrome('kltra').storage.local.set({ translationEnabled: false }));

    const registry = async () => worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then(items => items.map(item => item.id)));
    const frameMarkers = tabId => worker.evaluate(async tabId => (await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'ISOLATED',
      func: () => ({ href: location.href, marker: Boolean(globalThis.MyToolsClient) })
    })).map(injection => injection.result), tabId);
    const clearRegistrations = async () => {
      const ids = await registry();
      if (ids.length) await worker.evaluate(ids => chrome.scripting.unregisterContentScripts({ ids }), ids);
      await wait(100);
    };
    await clearRegistrations();
    assert.deepEqual(await registry(), [], 'content scripts must start unregistered');

    for (const fixture of fixtures) {
      await clearRegistrations();
      assert.deepEqual(await registry(), [], `${fixture.id}: stale state must have no registrations`);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
      await wait(300);
      let cboxFrame;
      if (fixture.id === 'kltra') {
        for (let attempt = 0; attempt < 50; attempt++) {
          cboxFrame = page.frames().find(frame => frame.url().startsWith('https://www3.cbox.ws/'));
          if (cboxFrame) break;
          await wait(100);
        }
        assert.ok(cboxFrame, 'kltra: embedded Cbox frame exists');
        await cboxFrame.waitForLoadState('domcontentloaded');
      }
      const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
      assert.ok(Number.isInteger(tabId), `${fixture.id}: fixture tab exists`);
      if (fixture.id === 'kltra') {
        const cboxBefore = (await frameMarkers(tabId)).find(frame => frame.href.startsWith('https://www3.cbox.ws/'));
        assert.ok(cboxBefore, 'kltra: Cbox frame is visible to scripting');
        assert.equal(cboxBefore.marker, false, 'kltra: Cbox frame must start stale');
      }
      const marker = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => Boolean(globalThis.MyToolsClient)
      }))[0].result, tabId);
      assert.equal(marker, false, `${fixture.id}: fixture must start without My Tools`);
      if (fixture.selector) assert.equal(await page.locator(fixture.selector).count(), 0, `${fixture.id}: feature must be absent before repair`);

      await page.bringToFront();
      const expected = expectedInjections(fixture.url);
      assert.ok(expected > 0, `${fixture.id}: at least one registration must match`);
      const repaired = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'my-tools:ensure-active' }));
      assert.equal(repaired.ok, true, `${fixture.id}: ${JSON.stringify(repaired)}`);
      assert.deepEqual(repaired.failed, [], `${fixture.id}: no registration failed`);
      assert.equal(repaired.matched, expected, `${fixture.id}: matched registration count`);
      assert.equal(repaired.injected, expected, `${fixture.id}: injected registration count`);

      if (fixture.after) await fixture.after(page);
      let featureCount = 0;
      if (fixture.selector) {
        await page.locator(fixture.selector).first().waitFor({ state: 'attached' });
        featureCount = await page.locator(fixture.selector).count();
        assert.ok(featureCount >= 1, `${fixture.id}: feature root exists`);
      }
      if (fixture.id === 'instagram') {
        await page.locator('.instagram-hq-image').waitFor();
        assert.equal(await page.locator('img').getAttribute('srcset'), null);
        assert.match(await page.locator('img').getAttribute('src'), /high\.png$/);
      }
      if (fixture.id === 'kltra') {
        const cboxAfter = (await frameMarkers(tabId)).find(frame => frame.href.startsWith('https://www3.cbox.ws/'));
        assert.equal(cboxAfter?.marker, true, 'kltra: Cbox frame repaired');
        await cboxFrame.evaluate(() => {
          document.getElementById('messages').insertAdjacentHTML('beforeend',
            '<div class="msg" data-id="123"><span class="nme">Alice</span><div class="body">hello from Cbox</div></div>');
        });
        await page.locator('.kltra-danmaku-item').filter({ hasText: 'hello from Cbox' }).waitFor();
      }
      if (fixture.id === 'sushida') {
        let results;
        for (let attempt = 0; attempt < 80; attempt++) {
          results = await worker.evaluate(async () => (await MyToolsRuntime.moduleChrome('sushida').storage.local.get('results')).results);
          if (results?.length) break;
          await wait(100);
        }
        assert.equal(results?.length, 1, 'sushida: one repaired result');
        assert.equal(results[0].amountYen, 1000);
        assert.equal(results[0].speedKeyPerSec, 4.2);
      }
      if (fixture.id === 'xhashtags') {
        assert.match(await page.locator('[data-testid="tweetTextarea_0"]').innerText(), /#repair/);
      }
      assert.deepEqual(errors, [], `${fixture.id}: content script page errors`);

      if (fixture.selector) assert.equal(await page.locator(fixture.selector).count(), featureCount, `${fixture.id}: repaired DOM stays stable`);
      const again = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'my-tools:ensure-active' }));
      assert.equal(again.ok, true, `${fixture.id}: second repair ${JSON.stringify(again)}`);
      assert.equal(again.injected, 0, `${fixture.id}: second repair must not inject again`);
      assert.equal(await worker.evaluate(async tabId => (await chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', func: () => Boolean(globalThis.MyToolsClient)
      }))[0].result, tabId), true, `${fixture.id}: marker must be set`);
      if (fixture.selector) assert.equal(await page.locator(fixture.selector).count(), featureCount, `${fixture.id}: second repair must not duplicate the feature`);
      if (fixture.id === 'kltra') {
        const cboxAgain = (await frameMarkers(tabId)).find(frame => frame.href.startsWith('https://www3.cbox.ws/'));
        assert.equal(cboxAgain?.marker, true, 'kltra: second repair keeps the Cbox adapter');
      }
      if (fixture.id === 'sushida') {
        const results = await worker.evaluate(async () => (await MyToolsRuntime.moduleChrome('sushida').storage.local.get('results')).results);
        assert.equal(results?.length, 1, 'sushida: second repair must not duplicate the result');
      }
      if (fixture.id === 'xhashtags') assert.match(await page.locator('[data-testid="tweetTextarea_0"]').innerText(), /#repair/);
      await page.close();
      console.log(`PASS ${fixture.id}: stale tab repaired once (${expected} registration${expected === 1 ? '' : 's'})`);
    }
    assert.deepEqual(await registry(), [], 'repair must not re-register stale content scripts');
    console.log(`PASS all ${fixtures.length} page modules repaired in already-open tabs`);
  } finally {
    await context?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
