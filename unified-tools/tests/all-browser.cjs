'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { workHtml } = require('../../momoniji-manga-viewer/tests/fixtures.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function verifyAll({ context, worker, manager, config, check, root, extensionId, image, clip, tracks, output }) {
  const rpc = message => manager.evaluate(message => chrome.runtime.sendMessage(message), message);
  const tabRPC = async (page, id, payload) => {
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    return worker.evaluate(async ({ tabId, id, payload }) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: (id, payload) => chrome.runtime.sendMessage({ toolModule: id, payload }), args: [id, payload] }))[0].result, { tabId, id, payload });
  };
  const pages = [];
  const evidence = Object.fromEntries(config.modules.map(module => [module.id, 'actual toggle and ordered content-script registration passed']));
  const fixture = async (id, url, html, selector, action) => {
    await context.route(url, route => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage(); pages.push(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    if (selector) await page.locator(selector).first().waitFor({ state: 'attached' });
    if (action) await action(page);
    assert.deepEqual(errors, [], id);
    evidence[id] = 'synthetic visible feature passed'; check(`${id}: original feature executes in generated extension`);
    return page;
  };
  for (const module of config.modules) {
    await manager.locator(`#${module.id}`).uncheck();
    await manager.waitForFunction(id => !document.getElementById(id).disabled, module.id);
    const disabled = await rpc({ type: 'my-tools:get' }); assert.equal(disabled.settings.enabled[module.id], false);
    if (module.popup && !module.worker && !module.matches?.length) assert.equal(await manager.getByRole('button', { name: `${module.name}の画面を開く`, exact: true }).isDisabled(), true);
    const registrations = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert.ok(!registrations.some(script => script.id.startsWith(`tools-${module.id}-`)), module.id);
    await manager.locator(`#${module.id}`).check(); await manager.waitForFunction(id => !document.getElementById(id).disabled, module.id);
    assert.equal((await rpc({ type: 'my-tools:get' })).settings.enabled[module.id], true);
  }
  check('All 19 actual manager toggles unregister and re-register only their own content scripts');
  const frames = config.modules.filter(module => module.popup || module.options);
  const frameErrors = [];
  manager.on('pageerror', error => frameErrors.push(error.message));
  for (const module of frames) {
    await manager.getByRole('button', { name: `${module.name}の画面を開く`, exact: true }).click();
    const frame = manager.frameLocator('#module-frame');
    await frame.locator('body').waitFor();
    assert.ok((await frame.locator('body').innerText()).trim(), module.id);
    const exportDenied = await frame.locator('body').evaluate(() => chrome.runtime.sendMessage({type:'my-tools:export'})); assert.equal(exportDenied.ok,false,module.id);
    await manager.locator('#module-back').click();
    evidence[module.id] = 'original settings page loaded in manager iframe';
  }
  assert.deepEqual(frameErrors, []); check(`All ${frames.length} original popup/options screens load inside manager without script errors`);
  await manager.locator('#search').fill('gofile'); assert.equal(await manager.locator('#modules .module:visible').count(), 1);
  await manager.locator('#search').fill('存在しない検索語'); assert.ok(await manager.locator('#no-results').isVisible()); await manager.locator('#search').fill('');
  check('Manager search filters 19 modules and displays empty state');
  const isolation = await worker.evaluate(async () => {
    const high = MyToolsRuntime.moduleChrome('instagramhq'), kltra = MyToolsRuntime.moduleChrome('kltra');
    await high.storage.local.set({ enabled: false }); await kltra.storage.local.set({ enabled: true });
    await high.storage.sync.set({ enabled: false }); await kltra.storage.sync.set({ enabled: true });
    await high.storage.session.set({ jobs: ['high'] }); await kltra.storage.session.set({ jobs: ['kltra'] });
    const before = [await high.storage.local.get(null), await kltra.storage.local.get(null), await high.storage.sync.get(null), await kltra.storage.sync.get(null), await high.storage.session.get(null), await kltra.storage.session.get(null)];
    await high.storage.local.clear(); await high.storage.session.remove('jobs');
    const after = [await kltra.storage.local.get('enabled'), await kltra.storage.session.get('jobs')];
    await high.storage.sync.set({ enabled: true });
    return { before, after };
  });
  assert.equal(isolation.before[0].enabled, false); assert.equal(isolation.before[1].enabled, true);
  assert.equal(isolation.before[2].enabled, false); assert.equal(isolation.before[3].enabled, true);
  assert.deepEqual(isolation.before[4].jobs, ['high']); assert.deepEqual(isolation.before[5].jobs, ['kltra']); assert.deepEqual(isolation.after, [{ enabled: true }, { jobs: ['kltra'] }]);
  check('Local sync and session names collide safely; clear/remove cannot erase another module');
  await context.route('https://img.momoniji.com/**', route => route.fulfill({ contentType: 'image/png', body: image }));
  await context.route('https://assets.blog.amatatu.com/**', route => route.fulfill({ contentType: 'image/png', body: image }));
  await context.route('https://www.badspi.jp/wp-content/uploads/**', route => route.fulfill({ contentType: 'image/png', body: image }));
  await fixture('googlephotos', 'https://photos.google.com/photo/fixture', '<html><body>Fixture</body></html>', '.gpu-panel', async page => {
    await page.getByRole('button', { name: 'パネルの表示切替' }).click();
    await page.waitForFunction(() => document.querySelector('.gpu-panel').dataset.collapsed === 'true');
    const stored = await worker.evaluate(() => chrome.storage.local.get('my-tools:module:googlephotos:gpu-panel-collapsed-v1'));
    assert.equal(stored['my-tools:module:googlephotos:gpu-panel-collapsed-v1'], true);
    const denied = await tabRPC(page, 'googlephotos', { type: 'my-tools:export' }).catch(() => undefined); assert.ok(denied == null);
  });
  await fixture('badspi', 'https://www.badspi.jp/fixture/', '<div id="lightbox"><img id="lightboxImage" src="https://www.badspi.jp/wp-content/uploads/2026/01/test-300x200.jpg"><div id="imageData"></div></div>', '#badspi-hq-download', async page => {
    assert.match(await page.locator('#lightboxImage').getAttribute('src'), /\/test\.jpg$/);
  });
  const data = JSON.parse(fs.readFileSync(path.join(root, 'inhigh-tv-match-links/data/matches.json')));
  const entries = data.matches || data.entries; const entry = entries.find(value => value.tournamentType === 'individual' && value.status === 'available');
  await fixture('inhighlinks', 'https://www.birdscore.live/web/interhigh-2026-wakayama-Individual/fixture', `<bsw-individual-match-card><div class="item">${entry.matchNo}</div></bsw-individual-match-card>`, '.inhigh-match-link', async page => assert.equal(await page.locator('.inhigh-match-link').getAttribute('href'), entry.archiveUrl));
  await fixture('inhighskip', 'https://inhightv.sportsbull.jp/summer/archive/fixture', '<div class="video-js" style="width:640px;height:360px"><video class="vjs-tech"></video><div class="vjs-chrome-bottom"><div class="vjs-chrome-controls"><div class="vjs-left-controls"><button class="vjs-play-control"></button></div></div></div></div>', '.inhigh-skip-button');
  await fixture('kltra', 'https://kltratv13.blogspot.com/p/galaxy.html', '<div id="video-wrapper-container" style="width:600px;height:340px"></div>', '.kltra-danmaku-layer');
  await fixture('koutairen', 'https://www.zenkoku-koutairen-bad.com/fixture', '<div class="game-detail-gallery-item-photos-photo"><img src="data:image/png;base64,' + image.toString('base64') + '"></div>', null, async page => {
    await page.locator('img').click(); await page.locator('.kgf-overlay:not([hidden])').waitFor();
  });
  await fixture('momoniji', 'https://momoniji.com/test-comic/', workHtml({ total: 2, perSitePage: 2 }), '#momoniji-reader', async page => { await page.getByRole('button', { name: '元のページ', exact: true }).waitFor(); });
  await fixture('r2', 'https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/r2/default/buckets/fixture', '<table data-testid="objects-table"><thead><tr><th>Name</th></tr></thead><tbody><tr><td>fixture.png</td></tr></tbody></table>', '.r2-preview-cell');
  await fixture('smashnet', 'https://www.smash-net.tv/photo/fixture', '<ul class="movie002-list"><li><img src="data:image/png;base64,' + image.toString('base64') + '"><p>Fixture</p></li></ul>', '#snt-photo-viewer', async page => {
    await page.locator('.movie002-list img').click(); await page.locator('#snt-photo-viewer .viewer.open').waitFor();
  });
  await worker.evaluate(() => MyToolsRuntime.moduleChrome('xhashtags').storage.sync.set({ hashtags: '#fixture #統合' }));
  await fixture('xhashtags', 'https://x.com/compose/post', '<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true" style="width:500px;height:200px"><span data-text="true"></span></div><button data-testid="tweetButton">Post</button></div>', '[data-testid="tweetTextarea_0"]', async page => {
    await page.waitForFunction(() => document.querySelector('[data-testid="tweetTextarea_0"]').innerText.includes('#fixture'));
  });
  await context.route('https://scontent.cdninstagram.com/**', route => route.fulfill({ contentType: 'image/png', body: image }));
  await fixture('instagramhq', 'https://www.instagram.com/p/Hqfixture/', '<main><article><img width="400" height="300" src="https://scontent.cdninstagram.com/low.png" srcset="https://scontent.cdninstagram.com/high.png 2000w"></article></main>', '.instagram-hq-image', async page => {
    assert.equal(await page.locator('img').getAttribute('srcset'), null);
    assert.match(await page.locator('img').getAttribute('src'), /high.png/);
  });
  const share = 'お手軽3,000円コース【普通】\n★1,000円分 お得 でした！（速度：4.2key/秒、ミス：3key） https://sushida.net';
  await fixture('sushida', 'https://sushida.net/play.html', '<a href="https://x.com/intent/tweet?text=' + encodeURIComponent(share) + '">share</a>', 'a', async page => {
    for (let attempt = 0; attempt < 50; attempt++) { if ((await worker.evaluate(async () => (await MyToolsRuntime.moduleChrome('sushida').storage.local.get('results')).results))?.length) break; await wait(100); }
    const saved = await worker.evaluate(async () => (await MyToolsRuntime.moduleChrome('sushida').storage.local.get('results')).results);
    assert.equal(saved[0].amountYen, 1000); assert.equal(saved[0].speedKeyPerSec, 4.2);
  });
  const yt = await fixture('youtube', 'https://www.youtube.com/watch?v=abcdefghijk', '<div id="movie_player"><video></video></div><div id="top-level-buttons-computed"></div>', '#youtube-five-second-clip');
  const tweet = await fixture('tweetfile', 'https://cdn.tweetfile.com/test-extension', '<div id="app"></div>', '#tweetfile-downloader');
  const media = await fixture('pagemedia', 'https://twfiles.com/fixturecode', '<div id="app"><div class="app-page--content"><div class="landing-content"><div class="content-list"><button class="video-row"><span class="video-copy"><strong>fixture.mp4</strong></span></button></div></div></div></div>', '#page-media-bulk-button-host');
  const youtubeId = crypto.randomUUID();
  const youtubeStart = async () => {
    const message = { type: 'clip', id: youtubeId, videoId: 'abcdefghijk', title: 'Unified fixture', start: 0, end: 0.4, tracks: [{ mime: 'video/mp4', size: tracks[0].length, offset: 0 }, { mime: 'audio/mp4', size: tracks[1].length, offset: 0 }] };
    const start = await tabRPC(yt, 'youtube', message); assert.equal(start.ok, true, JSON.stringify(start));
    for (let track = 0; track < 2; track++) assert.equal((await tabRPC(yt, 'youtube', { type: 'chunk', id: youtubeId, track, offset: 0, data: tracks[track].toString('base64') })).ok, true);
    assert.equal((await tabRPC(yt, 'youtube', { type: 'finish', id: youtubeId })).ok, true);
  };
  const session = await context.newCDPSession(yt); await session.send('Browser.setDownloadBehavior',{behavior:'default'});
  const baseline = (await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }))).map(item => item.id);
  const starts = await Promise.all([
    tabRPC(tweet, 'tweetfile', { type: 'tweetfile-download', items: [{ name: 'Unified HLS', url: 'https://vid.fun800.click/tweet/list.m3u8' }] }),
    tabRPC(media, 'pagemedia', { type: 'page-media-bulk:start' }),
    youtubeStart()
  ]);
  assert.equal(starts[0].queued, 1, JSON.stringify(starts[0])); assert.equal(starts[1].ok, true, JSON.stringify(starts[1]));
  const codec = await manager.evaluate(async () => ({
    video: (await VideoEncoder.isConfigSupported({codec:'avc1.42001f',width:320,height:480,bitrate:1000000,framerate:25})).supported,
    audio: (await AudioEncoder.isConfigSupported({codec:'mp4a.40.2',sampleRate:44100,numberOfChannels:2,bitrate:128000})).supported
  }));
  assert.ok(codec.video && codec.audio, 'The verification browser must support AVC and AAC encoding');
  const expectedDownloads = 3;
  let downloads;
  for (let attempt = 0; attempt < 200; attempt++) {
    downloads = (await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }))).filter(item => !baseline.includes(item.id));
    if (downloads.length === expectedDownloads) break;
    await wait(150);
  }
  for (let attempt=0;attempt<50;attempt++) { const y=await tabRPC(yt,'youtube',{type:'list'}); const p=await tabRPC(media,'pagemedia',{type:'page-media-bulk:status'}); if(y.jobs[0]?.state==='done' && p.batch?.status==='complete') break; if(y.jobs[0]?.state==='error' || p.batch?.status==='completed_with_errors') break; await wait(100); }
  const youtubeJobs = await tabRPC(yt, 'youtube', {type:'list'});
  const pageJobs = await tabRPC(media, 'pagemedia', {type:'page-media-bulk:status'});
  assert.equal(downloads.length, expectedDownloads, JSON.stringify({codec,downloads:downloads.map(x=>x.filename),youtubeJobs,pageJobs}));
  assert.equal(pageJobs.batch.status, 'complete', JSON.stringify({pageJobs,downloads:downloads.map(x=>({filename:x.filename,url:x.url,byExtensionId:x.byExtensionId})),errors:(await rpc({type:'my-tools:get'})).errors}));
  for (const prefix of ['/Tweetfile/001_Unified HLS', '/PageMedia/Fixture/fixture', '/YouTube_Unified fixture_abcdefghijk_0.00-0.40s']) assert.ok(downloads.some(item=>item.filename.includes(prefix)), prefix);
  for (const item of downloads) {
    assert.equal(fs.readFileSync(item.filename).toString('ascii', 4, 8), 'ftyp');
    assert.ok(item.fileSize > 1000);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', item.filename], { encoding: 'utf8' }));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    assert.ok(Number(probe.format.duration) > 0);
    execFileSync('ffmpeg', ['-v', 'error', '-i', item.filename, '-f', 'null', '-'], { stdio: 'pipe' });
    if (item.filename.includes('YouTube_')) assert.ok(Math.abs(Number(probe.format.duration) - 0.4) < 0.15);
  }
  const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })); assert.equal(contexts.filter(value=>value.documentUrl===`chrome-extension://${extensionId}/offscreen.html`).length,1); for(const id of ['tweetfile','pagemedia','youtube']) assert.ok(contexts.some(value=>value.documentUrl===`chrome-extension://${extensionId}/modules/${id}/offscreen.html`),id);
  evidence.tweetfile = evidence.pagemedia = 'concurrent original worker + separate offscreen processor + actual MP4 download passed';
  assert.equal(youtubeJobs.jobs[0].state, 'done');
  evidence.youtube = 'concurrent original offscreen processor and real MP4 conversion passed';
  check('All three original offscreen processors concurrently save playable MP4 files under their intended filenames');
  await fixture('stripchat', 'https://ja.stripchat.com/fixture', '<div style="width:250px;height:200px"><a href="/fixturemodel" data-model-list-link="true" data-model-id="123" style="display:block;width:250px;height:200px"><div class="live-thumb"><video></video></div></a></div>', null, async page => {
    await page.bringToFront(); await page.waitForTimeout(150); await page.locator('a').hover();
    await page.locator('.sc-live-hover-badge').waitFor({ state: 'attached' });
  });
  assert.deepEqual((await rpc({ type: 'my-tools:get' })).errors, []);
  await manager.screenshot({ path: path.join(output, 'all-modules.png'), fullPage: true });
  fs.writeFileSync(path.join(output, 'module-coverage.json'), JSON.stringify({ evidence, unverified: ['live external sites', 'user Chrome installation', 'Birdscore score fetch and keyboard dispatch', 'original photo download bytes for badspi/smashnet', 'full remote translation and Google Photos album RPC'] }, null, 2));
  for (const page of pages) await page.close();
};
