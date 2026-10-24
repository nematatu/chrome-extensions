const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const c = require('../core.js');

function png(width, height) {
  function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const buffer = Buffer.alloc(data.length + 12);
    buffer.writeUInt32BE(data.length); buffer.write(type, 4); data.copy(buffer, 8);
    buffer.writeUInt32BE(crc32(buffer.subarray(4, -4)), buffer.length - 4); return buffer;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 3 + 1) + 1 + x * 3;
    const line = Math.abs(x - width * .15) < 3 || Math.abs(x - width * .85) < 3 || Math.abs(y - height * .5) < 3;
    pixels[i] = line ? 230 : 38 + y / height * 20;
    pixels[i + 1] = line ? 230 : 99 + x / width * 25;
    pixels[i + 2] = line ? 230 : 106;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const portrait = png(400, 600), landscape = png(800, 400);
const clip = fs.readFileSync(path.join(__dirname, 'fixtures/clip.mp4'));
const cdn = 'https://scontent.cdninstagram.com/';
const photo = (id, name) => ({ pk: String(id), media_type: 1, image_versions2: { candidates: [{ url: `${cdn}${name}.png`, width: 400, height: 600 }] } });
const video = (id, name) => ({ pk: String(id), media_type: 2, video_versions: [{ url: `${cdn}${name}.mp4`, width: 320, height: 480 }],
  image_versions2: { candidates: [{ url: `${cdn}portrait.png`, width: 400, height: 600 }] } });
const longCode = 'BAABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const posts = {
  BA: { pk: '64', code: 'BA', user: { pk: '11', username: 'alice' }, carousel_media: [photo(1, 'portrait'), photo(2, 'landscape'), video(3, 'clip')] },
  BB: { pk: '65', code: 'BB', user: { pk: '11', username: 'alice' }, ...video(65, 'clip') },
  BC: { pk: '66', code: 'BC', user: { username: 'alice' }, ...photo(66, 'broken') },
  BF: { pk: '70', code: 'BF', user: { username: 'alice' }, carousel_media: [video(501, 'fallback-first'), video(502, 'fallback-second')] },
  BE: { pk: '69', code: 'BE', user: { username: 'alice' }, carousel_media: [photo(401, 'union-portrait'), photo(402, 'union-landscape'), video(403, 'union-clip')] },
  BD: { pk: '67', code: 'BD', user: { username: 'alice' }, carousel_media: [photo(4, 'slow'), photo(5, 'landscape'), photo(6, 'portrait')] },
};
posts[longCode] = { ...posts.BA, pk: '68', code: longCode };
const reelOverlay = `<div id="reel-overlay" style="position:fixed;inset:0;z-index:10;background:#111;display:grid;place-items:center"><div style="position:relative;width:822px;height:464px"><div><video id="media" src="blob:https://www.instagram.com/fixture" poster="${cdn}portrait.png" style="display:block;width:822px;height:464px;object-fit:contain"></video></div><div style="position:absolute;inset:0"></div></div></div>`;
function html(route) {
  const story = route.startsWith('/stories/');
  const requestedCode = route.match(/\/(?:p|reel|reels)\/([^/]+)/)?.[1];
  const code = posts[requestedCode] ? requestedCode : 'BA';
  if (route === '/reels/BB/') return `<!doctype html><html><body style="margin:0;background:#111"><main hidden><article><video src="${cdn}clip.mp4" width="420" height="570"></video></article></main>${reelOverlay}</body></html>`;
  if (route === '/alice/') return `<!doctype html><html><body style="margin:0;background:#111"><main style="width:700px;margin:100px auto;display:grid;grid-template-columns:320px 320px;gap:4px"><a href="/alice/p/BA/" aria-label="投稿を開く" style="display:block;position:relative;width:320px;height:400px"><img id="media" src="${cdn}portrait.png" style="display:block;width:320px;height:400px;object-fit:cover"><div style="position:absolute;inset:0;background:#0001"></div></a></main></body></html>`;
  const media = story ? `<img id="media" src="${cdn}portrait.png" style="width:380px;height:570px;object-fit:contain">` :
    code === 'BB' ? `<div style="position:relative;width:420px;height:570px"><div><div><div><div><video id="media" src="blob:https://www.instagram.com/fixture" poster="${cdn}portrait.png" style="width:420px;height:570px;object-fit:contain"></video></div></div></div></div><div style="position:absolute;inset:0"></div></div>` :
    `<div id="crop" style="overflow:hidden;position:relative"><div><img id="media" src="${cdn}portrait.png" srcset="${cdn}portrait.png 400w" style="width:600px;height:400px;object-fit:contain;object-position:50% 50%;display:block"></div><div id="interaction-layer" style="position:absolute;inset:0"></div></div>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
    body{margin:0;background:#0c0e10;color:#eee;font:14px -apple-system,sans-serif}nav{height:68px;border-bottom:1px solid #ffffff18;display:flex;align-items:center;padding:0 40px;font-size:22px;letter-spacing:-.7px}main{width:600px;margin:28px auto}header{display:flex;align-items:center;height:62px;gap:12px}.avatar{height:30px;width:30px;border-radius:50%;background:linear-gradient(135deg,#d72b72,#fdb868)}small{color:#999;margin-left:auto}article{border-bottom:1px solid #ffffff18;padding-bottom:20px}a{color:inherit;text-decoration:none}.actions{padding:18px 0;font-size:21px;letter-spacing:8px}p{color:#ccc;font-size:13px}footer{padding:18px 0;color:#777;font-size:11px}.story{width:380px;margin:auto;position:relative}.story header{position:absolute;top:5px;left:16px;right:16px;z-index:2}.story img{border-radius:12px}.story small{font-size:11px}.story .segments{position:absolute;left:14px;right:14px;top:12px;height:2px;background:repeating-linear-gradient(90deg,#fff 0 55px,#ffffff40 55px 60px)}
    </style></head><body><nav>Instagram <small>UI 検証用の再現ページ</small></nav><main>${story ? `<div class="story"><div class="segments"></div><header><span class="avatar"></span><strong>alice</strong><small>13時間前</small></header>${media}</div>` : `<article><header><span class="avatar"></span><strong>alice</strong><small>2時間前 · •••</small></header><a href="/alice/p/${code}/" id="permalink" aria-label="投稿を開く"></a>${media}<div class="actions">♡ ♧ ↗ <span style="float:right">♧</span></div><strong>337 いいね！</strong><p><strong>alice</strong> 今日の練習の記録。</p><footer>fixture · 外部アカウントのデータは使用していません。</footer></article>`}</main><div style="height:900px"></div></body></html>`.replace(story ? /<main>/g : /$^/, '<div style="width:600px;margin:28px auto">').replace(story ? /<\/main>/g : /$^/, '</div>');
}
async function main() {
  const extensionPath = path.resolve(process.env.IGMD_EXTENSION_PATH || path.join(__dirname, '..'));
  const output = path.join(extensionPath, 'test-results'); fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'igmd-browser-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${temp}/key.pem`, '-out', `${temp}/cert.pem`, '-days', '1', '-subj', '/CN=scontent.cdninstagram.com'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(`${temp}/key.pem`), cert: fs.readFileSync(`${temp}/cert.pem`) }, (req, res) => {
    const pathname = new URL(req.url, cdn).pathname;
    if (pathname.includes('broken')) { res.writeHead(404); res.end(); return; }
    const body = pathname.endsWith('.mp4') ? clip : pathname.includes('landscape') ? landscape : portrait;
    res.writeHead(200, { 'Content-Type': pathname.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'Content-Length': body.length });
    if (pathname.includes('slow')) { res.write(body.subarray(0, 100)); setTimeout(() => res.end(body.subarray(100)), 2500); }
    else res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: true, acceptDownloads: true, downloadsPath: path.join(output, 'downloads'),
    viewport: { width: 1120, height: 850 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--ignore-certificate-errors', '--no-proxy-server',
      `--host-resolver-rules=MAP scontent.cdninstagram.com 127.0.0.1:${server.address().port}`],
  });
  const checks = [];
  try {
    await context.grantPermissions(['local-network-access'], { origin: 'https://www.instagram.com' });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      await chrome.storage.local.set({ unrelatedSecret: 'fixture-signed-url-canary' });
    });
    checks.push('履歴表示をローカルストレージの信頼済みコンテキスト制限下で検証');
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => { if (request.url().startsWith(cdn)) console.error('Fixture network failure:', request.failure()?.errorText); });
    page.on('console', msg => { if (msg.type() === 'error') console.error('Fixture console:', msg.text()); });
    let queryStatus = 200, queryCount = 0, storyIncomplete = false, queryDelay = 0;
    await context.route('https://www.instagram.com/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith('/graphql/query')) {
        queryCount++;
        if (queryDelay) await new Promise(resolve => setTimeout(resolve, queryDelay));
        if (queryStatus !== 200) return route.fulfill({ status: queryStatus, contentType: 'application/json', body: '{}' });
        const params = new URLSearchParams(request.postData());
        const vars = JSON.parse(params.get('variables'));
        let data;
        if (params.get('fb_api_req_friendly_name') === 'PolarisPostRootQuery') data = { xdt_api__v1__media__shortcode__web_info: { items: [posts[vars.shortcode]] } };
        else if (params.get('fb_api_req_friendly_name') === 'PolarisSearchBoxRefetchableQuery') data = { xdt_api__v1__fbsearch__topsearch_connection: { users: [{ user: { id: '11', username: 'alice' } }] } };
        else data = { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { id: vars.initial_reel_id, user: { username: 'alice', pk: '11' }, more_available: storyIncomplete, items: [photo(101, 'portrait'), video(102, 'clip'), photo(103, 'landscape')] } }] } };
        return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: 'for (;;);' + JSON.stringify({ data }) });
      }
      return route.fulfill({ contentType: 'text/html', body: html(url.pathname) });
    });
    const tools = () => page.locator('#igmd-root .tools:not(.hidden)');
    const single = () => tools().getByRole('button', { name: 'この画像・動画を保存', exact: true });
    const all = () => page.getByRole('button', { name: 'この投稿の全画像・動画を保存', exact: true }).filter({ visible: true });
    const done = async count => {
      try { await page.getByRole('status').filter({ hasText: `ダウンロード完了 ${count}/${count}` }).waitFor(); }
      catch (error) { throw new Error(`Expected ${count} completed downloads; status=${await page.getByRole('status').allTextContents()}; detail=${await page.locator('#igmd-root .detail').allTextContents()}`, { cause: error }); }
    };
    const savePage = () => worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await chrome.tabs.sendMessage(tab.id, { type: 'ig-download-page' }); });
    const assertSaved = (button, expected) => button.evaluate((el, saved) => {
      if (el.dataset.saved !== String(saved)) throw new Error(`Expected saved=${saved}, got ${el.dataset.saved}`);
      if (saved && (!el.title.includes('保存済み') || !el.querySelector('svg path')?.getAttribute('d').includes('L19 6'))) throw new Error('Saved button lacks check icon or saved description');
    }, expected);
    const waitSaved = async (button, expected) => {
      const label = await button.getAttribute('aria-label');
      await page.waitForFunction(({ label, saved }) => [...document.querySelector('#igmd-root').shadowRoot.querySelectorAll('button')]
        .some(el => el.getAttribute('aria-label') === label && el.getBoundingClientRect().width > 0 && el.dataset.saved === String(saved)), { label, saved: expected });
      await assertSaved(button, expected);
    };
    const state = () => worker.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs);
    async function assertPosition() {
      await page.waitForFunction(() => {
        const el = document.querySelector('#media'), button = document.querySelector('#igmd-root').shadowRoot.querySelector('.tools:not(.hidden) button');
        if (!button) return false;
        const box = el.getBoundingClientRect(), css = getComputedStyle(el);
        const rect = IGMediaCore.drawnRect(box, el.naturalWidth || el.videoWidth, el.naturalHeight || el.videoHeight, css.objectFit, css.objectPosition);
        const actual = button.getBoundingClientRect();
        return Math.abs(actual.right - rect.right + 10) < 2 && Math.abs(actual.top - rect.top - 10) < 2;
      });
      const values = await page.locator('#media').evaluate(el => {
        const box = el.getBoundingClientRect(); const css = getComputedStyle(el);
        return { rect: { left: box.left, top: box.top, width: box.width, height: box.height }, w: el.naturalWidth || el.videoWidth, h: el.naturalHeight || el.videoHeight, fit: css.objectFit, pos: css.objectPosition };
      });
      const expected = c.drawnRect(values.rect, values.w, values.h, values.fit, values.pos);
      const actual = await single().boundingBox();
      assert.ok(actual, 'single button must be visible');
      assert.ok(Math.abs(actual.x + actual.width - expected.right + 10) < 2, 'right edge follows rendered pixels');
      assert.ok(Math.abs(actual.y - expected.top - 10) < 2, 'top edge follows rendered pixels');
    }
    await page.goto('https://www.instagram.com/p/BA/'); await single().waitFor();
    assert.equal(await page.getByRole('button', { name: '表示済みの投稿を一括保存', exact: true }).count(), 0);
    await page.locator('#media').evaluate(el => el.decode());
    await assertPosition(); checks.push('contain余白のある画像の描画領域右上');
    await page.locator('#media').evaluate(el => el.style.objectPosition = '100% 0%');
    await assertPosition(); checks.push('object-position変更への追随');
    await page.evaluate(() => scrollTo(0, 60));
    await assertPosition(); checks.push('スクロール後の右上位置');
    await page.evaluate(() => scrollTo(0, 0));
    const watchingTab = await context.newPage();
    await watchingTab.goto('https://www.instagram.com/p/BA/');
    await watchingTab.waitForFunction(() => !!document.querySelector('#igmd-root')?.shadowRoot.querySelector('.tools button'));
    await page.bringToFront();
    await single().click(); await done(1);
    let jobs = await state();
    let [saved] = await worker.evaluate(id => chrome.downloads.search({ id }), jobs.at(-1).items[0].downloadId);
    assert.equal(saved.state, 'complete'); assert.equal(fs.existsSync(saved.filename), true);
    assert.deepEqual(fs.readFileSync(saved.filename), portrait); checks.push('個別画像の実ファイル保存');
    await waitSaved(single(), true); await waitSaved(all(), false);
    const savedColor = await single().evaluate(el => getComputedStyle(el).backgroundImage);
    assert.ok(savedColor.includes('20, 136, 99'), 'saved button uses green background');
    checks.push('保存完了した個別ボタンだけ緑のチェック表示');
    await watchingTab.waitForFunction(() => document.querySelector('#igmd-root')?.shadowRoot.querySelector('.tools button')?.dataset.saved === 'true');
    await watchingTab.close(); await page.bringToFront();
    checks.push('開いている別タブも保存完了後にチェックへ更新');
    await page.reload(); await single().waitFor(); await waitSaved(single(), true); await waitSaved(all(), false);
    checks.push('ページ再読込後も個別保存履歴が残る');

    await page.evaluate(groups => window.postMessage({ source: 'ig-media-downloader', groups }, location.origin), c.groups({ items: [posts.BA] }));
    await page.evaluate(() => window.postMessage({ source: 'ig-media-downloader', groups: [{
      id: '64', code: 'BA', username: 'instagram', complete: true,
      media: [{ id: '64_11', index: 0, kind: 'image', url: 'https://scontent.cdninstagram.com/portrait.png' }],
    }] }, location.origin));
    await page.waitForTimeout(600);
    await assertSaved(single(), true); await assertSaved(all(), false);
    checks.push('投稿全体のプレビュー受信後も個別のチェックと全件判定を保持');

    await all().click(); await done(3);
    jobs = await state(); assert.equal(jobs.at(-1).items.length, 3);
    assert.ok(jobs.at(-1).items[2].filename.endsWith('.mp4')); checks.push('未表示を含むカルーセル3件の保存');
    await waitSaved(all(), true);
    await page.reload(); await single().waitFor(); await waitSaved(all(), true);
    const otherTab = await context.newPage();
    await otherTab.goto('https://www.instagram.com/p/BA/');
    await otherTab.waitForFunction(() => document.querySelector('#igmd-root')?.shadowRoot.querySelector('.tools button')?.dataset.saved === 'true');
    await otherTab.close(); await page.bringToFront();
    checks.push('投稿全件のチェック表示・再読込・別タブへの履歴反映');

    assert.equal(await single().evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    assert.equal(await page.getByRole('status').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    await page.locator('#media').evaluate(el => el.style.objectPosition = '50% 50%');
    await assertPosition();
    await page.screenshot({ path: path.join(output, 'post.png') });
    await page.locator('#media').evaluate(el => { el.srcset = ''; el.src = 'https://scontent.cdninstagram.com/landscape.png'; });
    await page.locator('#media').evaluate(el => el.decode()); await single().click(); await done(1);
    jobs = await state(); assert.ok(jobs.at(-1).items[0].filename.endsWith('_02.png')); checks.push('カルーセル切替後の現在画像選択');
    await page.evaluate(() => { history.pushState({}, '', '/reel/BB/'); document.querySelector('main').innerHTML = '<video id="media" src="blob:https://www.instagram.com/fixture" poster="https://scontent.cdninstagram.com/portrait.png" style="width:420px;height:570px"></video>'; });
    await single().waitFor(); await single().click(); await done(1);
    jobs = await state(); assert.ok(jobs.at(-1).items[0].filename.endsWith('.mp4'));
    const [reelDownload] = await worker.evaluate(id => chrome.downloads.search({ id }), jobs.at(-1).items[0].downloadId);
    assert.equal(reelDownload.url, `${cdn}clip.mp4`); checks.push('SPA遷移・blob動画からMP4解決');
    await page.goto('https://www.instagram.com/p/BA/'); await single().waitFor();
    const feedButton = await single().elementHandle();
    await page.evaluate(markup => {
      window.scrollTo(0, 200);
      document.querySelector('main').hidden = true;
      document.querySelector('#media').removeAttribute('id');
      document.querySelector('main').insertAdjacentHTML('beforeend', '<video src="https://scontent.cdninstagram.com/clip.mp4" width="420" height="570"></video>');
      document.body.insertAdjacentHTML('beforeend', markup);
      history.pushState({}, '', '/reels/BB/');
    }, reelOverlay);
    await page.waitForFunction(button => !button.isConnected, feedButton);
    await single().waitFor(); await all().waitFor(); await assertPosition();
    assert.equal(await tools().count(), 1);
    await single().click(); await done(1); jobs = await state();
    assert.equal((await worker.evaluate(id => chrome.downloads.search({ id }), jobs.at(-1).items[0].downloadId))[0].url, `${cdn}clip.mp4`);
    await page.reload(); await single().waitFor(); await all().waitFor(); await assertPosition();
    assert.equal(await tools().count(), 1);
    checks.push('ホームから開く意味的コンテナー外のリール・再読込・MP4保存');
    await page.goto(`https://www.instagram.com/p/${longCode}/?img_index=1`);
    await single().waitFor(); await single().click(); await done(1);
    jobs = await state();
    assert.equal(jobs.at(-1).items.length, 1);
    assert.equal((await worker.evaluate(id => chrome.downloads.search({ id }), jobs.at(-1).items[0].downloadId))[0].url, `${cdn}portrait.png`);
    assert.ok(jobs.at(-1).items[0].filename.includes(longCode));
    await all().click(); await done(3);
    jobs = await state();
    assert.equal(jobs.at(-1).items.length, 3);
    assert.equal((await worker.evaluate(id => chrome.downloads.search({ id }), jobs.at(-1).items[2].downloadId))[0].url, `${cdn}clip.mp4`);
    assert.equal(await page.getByText('投稿IDが不正です。', { exact: true }).count(), 0);
    checks.push('長い投稿コードの個別保存とカルーセル全件保存');
    posts[longCode] = { ...posts.BA };
    await page.reload(); await single().waitFor(); await single().click(); await done(1);
    jobs = await state(); assert.ok(jobs.at(-1).items[0].filename.includes('BA_01'));
    await all().click(); await done(3);
    jobs = await state(); assert.equal(jobs.at(-1).items.length, 3);
    checks.push('長いURLに対して通常コードで返る投稿の個別・全件保存');
    await page.goto('https://www.instagram.com/alice/');
    await all().waitFor(); await page.locator('#media').evaluate(el => el.decode());
    assert.equal(await all().count(), 1);
    assert.equal(await single().count(), 0);
    assert.equal(await page.locator('#igmd-root .bulk').filter({ visible: true }).count(), 0);
    const profileImage = await page.locator('#media').boundingBox();
    const profileButton = await all().boundingBox();
    assert.ok(profileImage && profileButton);
    assert.ok(Math.abs(profileButton.x + profileButton.width - profileImage.x - profileImage.width + 10) < 2, 'profile bulk button follows thumbnail right edge');
    assert.ok(Math.abs(profileButton.y - profileImage.y - 10) < 2, 'profile bulk button follows thumbnail top edge');
    await all().click(); await done(3);
    jobs = await state(); assert.equal(jobs.at(-1).items.length, 3);
    checks.push('プロフィール右上の1ボタンで投稿全件保存・下側ボタン非表示');
    await page.evaluate(() => {
      history.pushState({}, '', '/p/BA/');
      document.querySelector('main').innerHTML = '<div role="dialog"><a href="/alice/p/BA/" aria-label="投稿を開く"></a><img id="media" src="https://scontent.cdninstagram.com/portrait.png" style="display:block;width:600px;height:400px;object-fit:contain"></div>';
    });
    await single().waitFor(); await page.locator('#media').evaluate(el => el.decode());
    assert.equal(await single().count(), 1);
    await assertPosition(); await single().click(); await done(1);
    jobs = await state(); assert.equal(jobs.at(-1).items.length, 1);
    checks.push('プロフィールから投稿詳細へSPA遷移すると右上は個別保存');
    await page.goto('https://www.instagram.com/');
    await page.evaluate(() => {
      window.fixtureHomeDocument = true;
      document.body.insertAdjacentHTML('afterbegin', '<button id="open-story">ホームのストーリーを開く</button>');
      document.querySelector('#open-story').addEventListener('click', () => {
        history.pushState({}, '', '/stories/alice/101/');
        document.querySelectorAll('body > *').forEach(el => el.remove());
        document.body.insertAdjacentHTML('beforeend', '<div id="reposted-story" style="position:relative;width:380px;height:570px;margin:28px auto"><div><div><img id="media" src="https://scontent.cdninstagram.com/portrait.png" style="display:block;width:380px;height:570px;object-fit:contain"></div></div><div style="position:absolute;left:25%;top:25%;width:50%;height:50%"></div></div>');
        window.fixtureStoryTaps = 0;
        document.addEventListener('click', () => window.fixtureStoryTaps++);
      });
    });
    await page.getByRole('button', { name: 'ホームのストーリーを開く', exact: true }).click();
    const storySingle = () => page.getByRole('button', { name: 'このストーリーを保存', exact: true }).filter({ visible: true });
    const storyAll = () => page.getByRole('button', { name: 'このアカウントのストーリーを一括保存', exact: true }).filter({ visible: true });
    await storySingle().waitFor(); await storyAll().waitFor();
    assert.equal(await storySingle().count(), 1); assert.equal(await storyAll().count(), 1);
    assert.equal(await page.evaluate(() => window.fixtureHomeDocument), true);
    assert.equal(await page.locator('main').count(), 0);
    await page.locator('#media').evaluate(el => el.decode());
    const storyImageBox = await page.locator('#media').boundingBox(), storySingleBox = await storySingle().boundingBox();
    assert.ok(storyImageBox && storySingleBox);
    assert.ok(Math.abs(storySingleBox.x - storyImageBox.x - storyImageBox.width + 94) < 2);
    assert.ok(Math.abs(storySingleBox.y - storyImageBox.y - 64) < 2);
    await page.evaluate(() => window.fixtureStoryTaps = 0);
    await storySingle().click(); await done(1);
    jobs = await state(); assert.equal(jobs.at(-1).items.length, 1);
    assert.equal((await worker.evaluate(id => chrome.downloads.search({ id }), jobs.at(-1).items[0].downloadId))[0].url, `${cdn}portrait.png`);
    await storyAll().click(); await done(3);
    jobs = await state(); assert.equal(jobs.at(-1).items.length, 3);
    assert.equal(await page.evaluate(() => window.fixtureStoryTaps), 0);
    assert.equal(new URL(page.url()).pathname, '/stories/alice/101/');
    checks.push('ホームから再投稿ストーリーへSPA遷移し個別・一括保存');
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="blocking-dialog" role="dialog" style="position:fixed;inset:0;background:#222;z-index:1000">別のダイアログ</div>'));
    await page.waitForFunction(() => document.querySelector('#igmd-root').shadowRoot.querySelectorAll('.tools:not(.hidden)').length === 0);
    assert.equal(await storySingle().count(), 0); assert.equal(await storyAll().count(), 0);
    await page.locator('#blocking-dialog').evaluate(el => el.remove());
    await storySingle().waitFor(); await storyAll().waitFor();
    checks.push('別ダイアログがストーリーを覆う間は保存ボタンを隠す');
    await page.goto('https://www.instagram.com/stories/alice/101/');
    await page.getByRole('button', { name: 'このストーリーを保存', exact: true }).filter({ visible: true }).waitFor();
    await page.getByRole('button', { name: 'このストーリーを保存', exact: true }).filter({ visible: true }).click(); await done(1); checks.push('ストーリー個別保存');
    await page.getByRole('button', { name: 'このアカウントのストーリーを一括保存', exact: true }).filter({ visible: true }).click(); await done(3); checks.push('ストーリー画像・動画3件の一括保存');
    await page.screenshot({ path: path.join(output, 'story.png') });
    storyIncomplete = true;
    await page.getByRole('button', { name: 'このアカウントのストーリーを一括保存', exact: true }).filter({ visible: true }).click();
    await page.getByText('ストーリーを全件取得できませんでした。一括保存を中断しました。', { exact: true }).waitFor(); checks.push('不完全なストーリーの全件保存を拒否'); storyIncomplete = false;
    await page.goto('https://www.instagram.com/p/BC/'); await all().click();
    await page.getByRole('status').filter({ hasText: '失敗 1件' }).waitFor(); checks.push('CDNの404を成功扱いしない');
    await waitSaved(all(), false); checks.push('保存失敗した投稿を保存済み表示にしない');
    await page.goto('https://www.instagram.com/p/BA/'); queryStatus = 429; const before = queryCount;
    await all().click(); await page.getByText('Instagramの取得制限です。時間をおいて再実行してください。', { exact: true }).waitFor();
    assert.equal(queryCount - before, 1); checks.push('429時の中断・自動連打なし'); queryStatus = 200;
    await page.goto('https://www.instagram.com/p/BD/'); await all().click();
    await page.getByRole('button', { name: '次の保存を一時停止', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '一時停止中 1/3' }).waitFor();
    await page.getByRole('button', { name: '保存を再開', exact: true }).click(); await done(3); checks.push('一括保存の待機・再開');
    await page.goto('https://www.instagram.com/p/BD/'); await all().click();
    await page.getByRole('button', { name: 'ダウンロードを中止', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '中止しました' }).waitFor(); checks.push('進行中・未開始ファイルの中止');
    await page.goto('https://www.instagram.com/p/BA/');
    const previousJob = (await state()).at(-1).id;
    queryDelay = 1500;
    await savePage();
    await page.getByRole('button', { name: '取得を中止', exact: true }).click();
    await page.getByText('取得を中止しました。', { exact: true }).waitFor();
    assert.equal((await state()).at(-1).id, previousJob); checks.push('取得準備中の中止');
    await savePage();
    await page.evaluate(() => history.pushState({}, '', '/bob/'));
    await page.getByText('取得を中止しました。', { exact: true }).waitFor();
    assert.equal((await state()).at(-1).id, previousJob); checks.push('一括取得中のSPA遷移で保存を中断');
    queryDelay = 0;
    await page.goto('https://www.instagram.com/explore/'); queryStatus = 429;
    await page.evaluate(() => { document.querySelector('main').innerHTML = '<a href="/reel/BB/"><img id="media" src="https://scontent.cdninstagram.com/portrait.png" width="240" height="360"></a>'; });
    await single().click();
    await page.getByText('Instagramの取得制限です。時間をおいて再実行してください。', { exact: true }).waitFor();
    assert.equal((await state()).at(-1).id, previousJob); checks.push('動画サムネイルへの画像フォールバックを拒否'); queryStatus = 200;
    await page.goto('https://www.instagram.com/p/BD/');
    await worker.evaluate(() => {
      const original = chrome.storage.session.set.bind(chrome.storage.session);
      let delay = true;
      globalThis.fixtureStorageHeld = false;
      globalThis.fixtureRestoreStorage = () => { chrome.storage.session.set = original; };
      chrome.storage.session.set = async value => {
        if (delay && value.jobs?.some(j => j.items.some(i => i.state === 'queued'))) {
          delay = false; globalThis.fixtureStorageHeld = true;
          globalThis.fixtureHeldJobId = value.jobs.find(j => j.items.some(i => i.state === 'queued')).id;
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
        return original(value);
      };
    });
    await all().click();
    await worker.evaluate(async () => {
      const deadline = Date.now() + 5000;
      while (!globalThis.fixtureStorageHeld) {
        if (Date.now() > deadline) throw new Error('Start handoff was not observed');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await page.getByRole('button', { name: '取得を中止', exact: true }).click();
    const heldId = await worker.evaluate(() => globalThis.fixtureHeldJobId);
    await worker.evaluate(async id => {
      const deadline = Date.now() + 7000;
      while (true) {
        const job = (await chrome.storage.session.get('jobs')).jobs.find(j => j.id === id);
        if (job?.canceled && !job.items.some(i => ['queued', 'active', 'starting'].includes(i.state))) return;
        if (Date.now() > deadline) throw new Error('Accepted job did not receive cancellation during start handoff');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }, heldId);
    await page.getByRole('status').filter({ hasText: /^中止しました/ }).waitFor();
    jobs = await state(); assert.equal(jobs.at(-1).canceled, true);
    assert.equal(jobs.at(-1).id, heldId);
    assert.equal(jobs.at(-1).items.filter(i => ['queued', 'active'].includes(i.state)).length, 0);
    await worker.evaluate(() => globalThis.fixtureRestoreStorage()); checks.push('保存開始応答の待機中に中止してキューへ反映');
    await page.goto('https://www.instagram.com/p/BE/');
    await single().waitFor();
    await page.locator('#media').evaluate(el => { el.srcset = ''; el.src = 'https://scontent.cdninstagram.com/union-portrait.png'; });
    await page.locator('#media').evaluate(el => el.decode());
    await single().click(); await done(1); await waitSaved(all(), false);
    await page.locator('#media').evaluate(el => el.src = 'https://scontent.cdninstagram.com/union-landscape.png');
    await page.locator('#media').evaluate(el => el.decode());
    await single().click(); await done(1); await waitSaved(all(), false);
    await page.locator('#media').evaluate(el => {
      const video = document.createElement('video'); video.id = 'media';
      video.src = 'blob:https://www.instagram.com/fixture'; video.poster = 'https://scontent.cdninstagram.com/portrait.png';
      video.style.cssText = 'display:block;width:600px;height:400px;object-fit:contain'; el.replaceWith(video);
    });
    await single().waitFor(); await waitSaved(single(), false);
    await single().click(); await done(1); await waitSaved(all(), true);
    await page.reload(); await all().waitFor(); await waitSaved(all(), true);
    checks.push('個別保存を積み上げた投稿全件のチェックが再読込後も残る');
    await page.goto('https://www.instagram.com/p/BF/');
    await page.locator('#media').evaluate(el => {
      const video = document.createElement('video'); video.id = 'media';
      video.src = 'https://scontent.cdninstagram.com/unidentified.mp4';
      video.style.cssText = 'display:block;width:600px;height:400px;object-fit:contain'; el.replaceWith(video);
    });
    await single().waitFor(); await single().click(); await done(1);
    jobs = await state(); assert.ok(jobs.at(-1).items[0].filename.includes('_visible_'));
    await page.locator('#media').evaluate(el => el.src = 'https://scontent.cdninstagram.com/fallback-first.mp4');
    await waitSaved(single(), false); await waitSaved(all(), false);
    checks.push('未特定動画の保存で別のカルーセル項目を保存済みにしない');

    await page.goto('https://www.instagram.com/p/BA/');
    await savePage(); await done(3); checks.push('ページ一括保存');
    await page.setViewportSize({ width: 700, height: 800 }); await assertPosition(); checks.push('ウインドウ幅変更への追随');
    await page.evaluate(() => {
      const current = document.querySelector('#media'), next = current.cloneNode();
      next.id = 'replacement'; current.after(next);
    });
    await page.locator('#replacement').evaluate(el => el.decode());
    await page.waitForFunction(() => document.querySelector('#igmd-root').shadowRoot.querySelectorAll('.tools').length === 2);
    await page.evaluate(() => document.querySelector('#media').style.display = 'none');
    await page.waitForFunction(() => document.querySelector('#igmd-root').shadowRoot.querySelectorAll('.tools:not(.hidden)').length === 1);
    checks.push('非表示メディアがあっても現在画像のボタンを表示');
    await page.evaluate(() => { document.querySelector('main').innerHTML = ''; });
    await page.waitForFunction(() => document.querySelector('#igmd-root').shadowRoot.querySelectorAll('.tools').length === 0); checks.push('DOM削除時のボタン除去');
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const exportButton = popup.getByRole('button', { name: '移行用に保存履歴を書き出す', exact: true });
    await exportButton.waitFor();
    const exportDownload = popup.waitForEvent('download');
    await exportButton.click();
    const exported = await exportDownload;
    assert.equal(exported.suggestedFilename(), 'my-tools-instagram-history.json');
    const transfer = JSON.parse(fs.readFileSync(await exported.path(), 'utf8'));
    assert.deepEqual(Object.keys(transfer).sort(), ['format', 'instagram', 'version']);
    assert.equal(transfer.format, 'nematatu-tools'); assert.equal(transfer.version, 1);
    assert.deepEqual(Object.keys(transfer.instagram), ['savedMedia']);
    assert.deepEqual(transfer.instagram.savedMedia, await worker.evaluate(() => globalThis.IGMediaHistory.read()));
    c.validateHistory(transfer.instagram.savedMedia);
    assert.equal(JSON.stringify(transfer).includes('fixture-signed-url-canary'), false);
    assert.equal(JSON.stringify(transfer).includes('https://'), false);
    checks.push('旧単独版ポップアップから安全な履歴JSONだけを書き出す');
    await popup.locator('body').screenshot({ path: path.join(output, 'popup.png') });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ surface: 'isolated Chromium with synthetic Instagram and local CDN', liveInstagram: 'not verified', checks }, null, 2));
    console.log(`PASS: ${checks.length} browser checks, real extension loaded, real downloads completed, no page exceptions`);
  } finally { await context.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
