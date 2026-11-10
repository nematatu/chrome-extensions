'use strict';
// Loads the standalone extension and the My Tools build into Chromium and drives the real youtube.com UI.
// The native host is installed by the real CLI into a temporary HOME, and the test reads links.txt itself.
// A fake yt-dlp on PATH stands in for the playlist that the phone and other PCs save to.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const cli = path.join(root, 'cli/yt-queue');
const SEARCH = 'https://www.youtube.com/results?search_query=badminton+highlights';
const CHANNEL = 'https://www.youtube.com/@YouTube/videos';
const PLAYLIST_PAGE = 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';
const FAKE_YTDLP = '#!/bin/sh\ncat "$HOME/playlist"\n';
const variants = [
  // Each variant runs on a different YouTube theme so every check covers both.
  { name: 'standalone', dir: root, id: 'adcpjoppcbkeibgnegfinicchhcfkfic', theme: 'light' },
  { name: 'my-tools', dir: path.resolve(root, '../dist/my-tools'), id: 'pnggeglmncjlcgfeenoccflfdkblnidj', theme: 'dark' }
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;

// Thumbnail marks are direct children of the thumbnail link; preview marks live in the preview player wrapper.
const markFor = (page, id, kind = 'thumbnail') => page.locator(kind === 'title' ? `.ypq-mark--title[data-video-id="${id}"]` : `a > .ypq-mark--thumbnail[data-video-id="${id}"]`).first();
const linkFor = (page, id) => page.locator(`a:has(> .ypq-mark--thumbnail[data-video-id="${id}"])`).first();
const REGULAR_MARKS = 'a#thumbnail > .ypq-mark--thumbnail, a.ytLockupViewModelContentImage > .ypq-mark--thumbnail';
// The pointer at a thumbnail mark's position finds a mark for `id` on top (thumbnail or inline preview), with every ancestor fully opaque.
const markShownAt = ([id, status]) => {
  const box = document.querySelector(`a > .ypq-mark--thumbnail[data-video-id="${id}"]`)?.getBoundingClientRect();
  if (!box) return false; // YouTube is re-rendering the card; keep polling.
  const mark = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.ypq-mark');
  let opacity = 1;
  for (let node = mark; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
  return mark?.dataset.videoId === id && (!status || mark.dataset.status === status) && opacity === 1;
};
async function waitShown(page, id, status) {
  try { await page.waitForFunction(markShownAt, [id, status], { timeout: 10000, polling: 100 }); }
  catch (error) {
    const seen = await page.evaluate(target => {
      const box = document.querySelector(`a > .ypq-mark--thumbnail[data-video-id="${target}"]`)?.getBoundingClientRect();
      if (!box) return 'no thumbnail mark';
      const chain = []; for (let node = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); node && chain.length < 8; node = node.parentElement) chain.push(`${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]} op=${getComputedStyle(node).opacity}`);
      return { box: [box.x, box.y, box.width], chain };
    }, id);
    throw new Error(`no visible ${status} mark for ${id}: ${JSON.stringify(seen)}`, { cause: error });
  }
}
// The watch page keeps re-rendering its related list (ads, autoplay). Hover a visible addable video and
// pick another only when YouTube recycled that card meanwhile; a card that stays but shows no button fails.
async function hoverVisibleAdd(page) {
  for (let attempt = 1; ; attempt++) {
    const id = await (await page.waitForFunction(() => [...document.querySelectorAll('a > .ypq-mark--thumbnail[data-status="add"]')]
      .find(mark => { const box = mark.getBoundingClientRect(); return box.width && box.top > 80 && box.bottom < innerHeight - 20; })?.dataset.videoId, null, { timeout: 20000 })).jsonValue();
    const box = await markFor(page, id).boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      try { await waitShown(page, id, 'add'); return id; }
      catch (error) { if (attempt === 3 || await markFor(page, id).count()) throw error; }
    }
    if (attempt === 3) throw new Error('related cards kept being replaced while hovering');
    console.log(`NOTE YouTube replaced the related card ${id}; picking another`);
  }
}
// Clicks land where a user's pointer would: hover the thumbnail, then click the mark's centre.
async function clickMark(page, id, clickCount = 1) {
  await markFor(page, id).scrollIntoViewIfNeeded();
  const box = await markFor(page, id).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount });
}
async function waitStatus(page, id, status, kind = 'thumbnail') {
  const selector = `.ypq-mark--${kind}[data-video-id="${id}"]`;
  try { await page.waitForFunction(([target, value]) => document.querySelector(target)?.dataset.status === value, [selector, status], { timeout: 15000 }); }
  catch (error) {
    const found = await page.evaluate(target => [...document.querySelectorAll(target)].map(mark => mark.dataset.status), selector);
    throw new Error(`${selector} expected ${status}, found ${JSON.stringify(found)} on ${page.url()}`, { cause: error });
  }
}
async function waitToast(page, pattern) {
  await page.waitForFunction(source => new RegExp(source).test(document.querySelector('.ypq-toast:not([hidden])')?.textContent || ''), pattern.source, { timeout: 10000 });
}
// Every thumbnail link with a video URL must carry a mark for that video at its top-left corner.
const unmatched = () => {
  const pageVideoId = href => { if (!URL.canParse(href)) return null; const url = new URL(href); return url.searchParams.get('v') || url.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1]; };
  const links = [...document.querySelectorAll('a#thumbnail, a.ytLockupViewModelContentImage, a.shortsLockupViewModelHostEndpoint')].filter(link => pageVideoId(link.href));
  const misplaced = links.map(link => link.querySelector(':scope > .ypq-mark')).filter(mark => mark && mark.getBoundingClientRect().width).filter(mark => {
    const box = mark.getBoundingClientRect(), link = mark.parentElement.getBoundingClientRect();
    return Math.round(box.x - link.x) !== 6 || Math.round(box.y - link.y) !== 6;
  }).length;
  return { total: links.length, misplaced, misses: links.filter(link => link.querySelector(':scope > .ypq-mark')?.dataset.videoId !== pageVideoId(link.href))
    .map(link => ({ href: link.getAttribute('href'), mark: link.querySelector(':scope > .ypq-mark')?.dataset.videoId || null, className: link.className })) };
};
async function expectAllMarked(page) {
  await page.waitForFunction(`(${unmatched})().misses.length === 0`, null, { timeout: 5000, polling: 250 }).catch(() => {});
  const coverage = await page.evaluate(unmatched);
  assert.deepEqual(coverage.misses, [], `unmarked thumbnails on ${page.url()}`);
  assert.equal(coverage.misplaced, 0, `marks off the top-left corner on ${page.url()}`);
  return coverage;
}
const tokenColor = (page, id, kind) => markFor(page, id, kind).evaluate(mark => {
  const probe = document.createElement('i');
  probe.style.color = 'var(--mt-green-9)';
  mark.after(probe);
  const green = getComputedStyle(probe).color;
  probe.remove();
  return { background: getComputedStyle(mark).backgroundColor, green };
});

async function runVariant(variant, temp) {
  const home = path.join(temp, variant.name, 'home'), queue = path.join(home, 'queue'), bin = path.join(temp, variant.name, 'bin');
  for (const folder of [queue, bin]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(bin, 'yt-dlp'), FAKE_YTDLP, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\n', { mode: 0o755 }); // setup must not touch the real launchd
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const yt = args => spawnSync('python3', [cli, ...args], { env, encoding: 'utf8' });
  const links = path.join(queue, 'links.txt'), archive = path.join(queue, 'download_archive.txt');
  // The CLI installs the host manifest under the default Chromium profile path of $HOME.
  const context = await chromium.launchPersistentContext(path.join(home, 'Library/Application Support/Chromium'), {
    channel: 'chromium', headless: true, env, locale: 'ja-JP', viewport: { width: 1280, height: 900 }, colorScheme: variant.theme,
    args: [`--disable-extensions-except=${variant.dir}`, `--load-extension=${variant.dir}`]
  });
  // YouTube's own theme setting lives in its PREF cookie (f6=400 is dark) and must be set before the first visit.
  if (variant.theme === 'dark') await context.addCookies([{ name: 'PREF', value: 'f6=400&hl=ja', domain: '.youtube.com', path: '/', secure: true }]);
  const shot = async (page, name) => page.screenshot({ path: path.join(output, `${variant.name}-${variant.theme}-${name}.png`) });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.equal(new URL(worker.url()).host, variant.id);
    pass(`${variant.name}: fixed extension ID ${variant.id}`);
    if (variant.name === 'my-tools') {
      // Pages load after My Tools has registered its scripts, as after a real install. Chrome must report the
      // registrations exactly as My Tools wants them, so a worker restart keeps them instead of re-registering.
      const shapes = await worker.evaluate(async () => {
        const shape = script => JSON.stringify([[...script.matches || []].sort(), [...script.excludeMatches || []].sort(), script.js || [], script.css || [],
          script.world || 'ISOLATED', script.runAt || 'document_idle', Boolean(script.allFrames), Boolean(script.matchOriginAsFallback)]);
        for (let tries = 0; tries < 100 && !(await chrome.scripting.getRegisteredContentScripts()).some(script => script.id === 'tools-ytqueue-0'); tries++) await new Promise(resolve => setTimeout(resolve, 100));
        const existing = new Map((await chrome.scripting.getRegisteredContentScripts()).map(script => [script.id, shape(script)]));
        return MyToolsConfig.registrations.map(script => existing.get(script.id) === shape(script));
      });
      assert.ok(shapes.length > 0 && shapes.every(Boolean), `registrations differ from Chrome's copy: ${JSON.stringify(shapes)}`);
      pass(`${variant.name}: all ${shapes.length} content-script registrations match Chrome's stored copy, so restarts keep them`);
    }

    // Before yt-queue is set up: marks render, a click explains what to run.
    const page = await context.newPage();
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(selector => new Set([...document.querySelectorAll(selector)].map(mark => mark.dataset.videoId)).size >= 8, REGULAR_MARKS, { timeout: 30000 });
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('dark')), variant.theme === 'dark');
    const ids = [...new Set(await page.$$eval(REGULAR_MARKS, marks => marks.map(mark => mark.dataset.videoId)))];
    assert.ok(ids.length >= 8, `only ${ids.length} regular thumbnails`);
    const [inQueue, downloaded, target, doubled, failing, external, saved, previewed] = ids;
    await clickMark(page, target);
    await waitToast(page, /yt-queue が未設定です/);
    assert.equal(fs.existsSync(links), false);
    await page.waitForSelector('.ypq-toast', { state: 'hidden', timeout: 8000 });
    pass(`${variant.name}: without yt-queue a click explains the setup, writes nothing, and the notice hides after 5 seconds`);

    // The popup reports the missing host, then the real setup.
    const popup = await context.newPage();
    const popupUrl = `chrome-extension://${variant.id}/${variant.name === 'my-tools' ? 'modules/ytqueue/' : ''}popup.html`;
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => /yt-queue が未設定です/.test(document.getElementById('message').textContent));
    assert.equal(await popup.textContent('#target'), '未接続');
    fs.writeFileSync(links, `${watchUrl(inQueue)}\n`);
    fs.writeFileSync(archive, `youtube ${downloaded}\n`);
    assert.equal(yt(['setup', '--queue-dir', queue]).status, 0);
    await popup.click('#refresh');
    await popup.waitForFunction(() => document.getElementById('message').textContent === '読み込み直しました。');
    assert.equal(await popup.textContent('#target'), path.join(fs.realpathSync(queue), 'links.txt'));
    assert.deepEqual([await popup.textContent('#queued'), await popup.textContent('#downloaded')], ['キューに登録済み: 1件', 'ダウンロード済み: 1件']);
    await shot(popup, 'popup');
    pass(`${variant.name}: popup shows the missing host, then the links.txt path and counts after yt-queue setup`);

    // The YouTube tab stayed in the background and updated from the worker's notice.
    await waitStatus(page, inQueue, 'queued');
    await waitStatus(page, downloaded, 'downloaded');
    await waitStatus(page, target, 'add');
    await page.bringToFront();
    const geometry = await page.evaluate(id => {
      const mark = document.querySelector(`a > .ypq-mark--thumbnail[data-video-id="${id}"]`);
      mark.scrollIntoView({ block: 'center' });
      const box = mark.getBoundingClientRect(), image = mark.parentElement.getBoundingClientRect();
      return { dx: Math.round(box.x - image.x), dy: Math.round(box.y - image.y), label: mark.getAttribute('aria-label'), disabled: mark.disabled };
    }, inQueue);
    assert.deepEqual(geometry, { dx: 6, dy: 6, label: 'キューに登録済み', disabled: true });
    assert.equal(await page.evaluate(markShownAt, [inQueue, 'queued']), true);
    const colors = await tokenColor(page, inQueue);
    assert.equal(colors.background, colors.green);
    assert.equal(await markFor(page, downloaded).getAttribute('aria-label'), 'ダウンロード済み');
    await shot(page, 'search');
    pass(`${variant.name}: green check 6px from the thumbnail top-left, visible, for queued and downloaded videos`);

    // The add button appears in the same corner on hover; one click appends to links.txt without navigating.
    await linkFor(page, target).scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await page.waitForFunction(id => getComputedStyle(document.querySelector(`a > .ypq-mark--thumbnail[data-video-id="${id}"]`)).opacity === '0', target, { timeout: 5000 });
    // A second tab shows the same video's watch page; it must turn green when the add happens in the first tab.
    const other = await context.newPage();
    await other.goto(watchUrl(target), { waitUntil: 'domcontentloaded' });
    await waitStatus(other, target, 'add', 'title');
    await page.bringToFront();
    await linkFor(page, target).hover();
    await waitShown(page, target, 'add');
    await shot(page, 'search-hover');
    const before = page.url();
    await clickMark(page, target);
    await waitStatus(page, target, 'queued');
    await wait(800);
    assert.equal(page.url(), before);
    assert.deepEqual(lines(links), [watchUrl(inQueue), watchUrl(target)]);
    await waitStatus(other, target, 'queued', 'title');
    await other.close();
    pass(`${variant.name}: hover shows the add button in the check's corner, one click appends to links.txt without navigating, and other tabs follow`);

    // The inline preview player covers the thumbnail after a moment; it carries the same mark.
    await linkFor(page, previewed).scrollIntoViewIfNeeded();
    await linkFor(page, previewed).hover();
    await page.locator(`ytd-video-preview .ypq-mark--thumbnail[data-video-id="${previewed}"]`).waitFor({ state: 'visible', timeout: 10000 });
    await waitShown(page, previewed, 'add');
    const placement = await page.evaluate(id => {
      const mark = document.querySelector(`ytd-video-preview .ypq-mark--thumbnail[data-video-id="${id}"]`);
      const thumb = document.querySelector(`a > .ypq-mark--thumbnail[data-video-id="${id}"]`).parentElement.getBoundingClientRect();
      const box = mark.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { dx: Math.round(box.x - thumb.x), dy: Math.round(box.y - thumb.y), onTop: mark === hit || mark.contains(hit) };
    }, previewed);
    assert.deepEqual(placement, { dx: 6, dy: 6, onTop: true });
    await shot(page, 'search-preview');
    const previewBox = await page.locator(`ytd-video-preview .ypq-mark--thumbnail[data-video-id="${previewed}"]`).boundingBox();
    await page.mouse.click(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);
    await waitStatus(page, previewed, 'queued');
    await wait(800);
    assert.equal(page.url(), before);
    assert.equal(lines(links).filter(line => line === watchUrl(previewed)).length, 1);
    pass(`${variant.name}: inline preview shows the mark at the same corner and adds without navigating`);

    // A double click queues once.
    await clickMark(page, doubled, 2);
    await waitStatus(page, doubled, 'queued');
    await wait(500);
    assert.equal(lines(links).filter(line => line === watchUrl(doubled)).length, 1);
    pass(`${variant.name}: double click appends the video once`);

    // A video already in links.txt (added elsewhere) is recognised by yt-queue, not duplicated.
    fs.appendFileSync(links, `https://youtu.be/${external}\n`);
    await clickMark(page, external);
    await waitToast(page, /既に links\.txt にあります/);
    await waitStatus(page, external, 'queued');
    assert.equal(lines(links).filter(line => line.includes(external)).length, 1);
    pass(`${variant.name}: a video added elsewhere is reported as already queued and not duplicated`);

    // A write failure is explained and the video stays addable.
    fs.chmodSync(links, 0o444);
    await clickMark(page, failing);
    await waitToast(page, /links\.txt またはダウンロード履歴を読み書きできませんでした/);
    await waitStatus(page, failing, 'add');
    await shot(page, 'search-error');
    fs.chmodSync(links, 0o644);
    assert.ok(!lines(links).some(line => line.includes(failing)));
    pass(`${variant.name}: an unwritable links.txt is reported and nothing is marked`);

    // Infinite scroll: newly loaded results get marks too.
    const initial = await page.locator('.ypq-mark--thumbnail').count();
    for (let attempt = 0; attempt < 10 && await page.locator('.ypq-mark--thumbnail').count() <= initial; attempt++) {
      await page.mouse.wheel(0, 6000);
      await wait(1500);
    }
    const coverage = await expectAllMarked(page);
    assert.ok(coverage.total > initial, 'no new results loaded');
    pass(`${variant.name}: ${coverage.total} thumbnails after scrolling all carry a matching mark`);
    const shorts = page.locator('a.shortsLockupViewModelHostEndpoint > .ypq-mark--thumbnail').first();
    if (await shorts.count()) {
      const offset = await shorts.evaluate(mark => { const box = mark.getBoundingClientRect(), link = mark.parentElement.getBoundingClientRect(); return [Math.round(box.x - link.x), Math.round(box.y - link.y)]; });
      assert.deepEqual(offset, [6, 6]);
      pass(`${variant.name}: Shorts thumbnails get the mark at the top-left`);
    } else console.log(`NOTE ${variant.name}: no Shorts shelf in these results`);

    // Saved to the playlist from the phone or another PC: the 10-minute job appends it, and 読み込み直す shows it at once.
    fs.writeFileSync(path.join(home, 'playlist'), `${saved}\n${inQueue}\n${downloaded}\n`);
    assert.equal(yt(['setup', '--queue-dir', queue, '--playlist', PLAYLIST_PAGE]).status, 0);
    assert.match(yt(['sync']).stdout, new RegExp(`再生リストから 1件追加: ${saved}\n$`));
    await waitStatus(page, saved, 'add'); // the cached state does not know it yet
    await popup.bringToFront();
    await popup.click('#refresh');
    await popup.waitForFunction(() => document.getElementById('message').textContent === '読み込み直しました。');
    await page.bringToFront();
    await waitStatus(page, saved, 'queued');
    assert.equal(lines(links).filter(line => line === watchUrl(saved)).length, 1);
    assert.equal(lines(links).filter(line => line === watchUrl(inQueue)).length, 1);
    assert.ok(!lines(links).some(line => line.includes(downloaded)));
    pass(`${variant.name}: a playlist video appended by the 10-minute job turns green after 読み込み直す, without duplicates`);

    // Channel and playlist lists use other renderers; every thumbnail gets a mark there too.
    for (const url of [CHANNEL, PLAYLIST_PAGE]) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelectorAll('a > .ypq-mark--thumbnail').length >= 6, null, { timeout: 30000 });
      const { total } = await expectAllMarked(page);
      await shot(page, url === CHANNEL ? 'channel' : 'playlist');
      pass(`${variant.name}: ${total} thumbnails on ${new URL(url).pathname} carry a matching mark at the top-left`);
    }

    // Watch page title mark, then SPA navigation re-keys it and adds in one click.
    await page.goto(watchUrl(inQueue), { waitUntil: 'domcontentloaded' });
    await waitStatus(page, inQueue, 'queued', 'title');
    const titleLayout = () => {
      const mark = document.querySelector('.ypq-mark--title'), next = mark.nextElementSibling;
      const text = next?.getBoundingClientRect(), box = mark.getBoundingClientRect();
      return { parent: mark.parentElement.matches('ytd-watch-metadata #title h1'), next: next?.tagName.toLowerCase() || null, textWidth: Math.round(text?.width || 0),
        gap: text ? Math.round(text.x - box.right) : null, middle: text ? Math.round(Math.abs((box.y + box.height / 2) - (text.y + Math.min(text.height, 40) / 2))) : null };
    };
    // YouTube fills the title text after navigation; measure once it has rendered.
    await page.waitForFunction(`(${titleLayout})().textWidth > 0 && (${titleLayout})().gap === 8`, null, { timeout: 10000, polling: 250 }).catch(() => {});
    const title = await page.evaluate(titleLayout);
    assert.deepEqual({ parent: title.parent, next: title.next, gap: title.gap }, { parent: true, next: 'yt-formatted-string', gap: 8 }, JSON.stringify(title));
    assert.ok(title.middle < 10, `title mark is ${title.middle}px off the first line`);
    await shot(page, 'watch');
    const related = await page.waitForSelector('a.ytLockupViewModelContentImage[href*="/watch?v="], ytd-compact-video-renderer a#thumbnail', { timeout: 20000 });
    const relatedId = await related.evaluate(link => new URL(link.href).searchParams.get('v'));
    await related.scrollIntoViewIfNeeded();
    const box = await related.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.75);
    await page.waitForURL(url => url.searchParams.get('v') === relatedId, { timeout: 20000 });
    await page.waitForFunction(id => document.querySelector('.ypq-mark--title')?.dataset.videoId === id, relatedId, { timeout: 15000 });
    assert.equal(await page.locator('.ypq-mark--title').count(), 1);
    if (!lines(links).includes(watchUrl(relatedId))) {
      await waitStatus(page, relatedId, 'add', 'title');
      await page.click('.ypq-mark--title');
    }
    await waitStatus(page, relatedId, 'queued', 'title');
    assert.equal(lines(links).filter(line => line === watchUrl(relatedId)).length, 1);
    const titleColors = await tokenColor(page, relatedId, 'title');
    assert.equal(titleColors.background, titleColors.green);
    pass(`${variant.name}: watch title mark follows SPA navigation, adds in one click and turns green`);
    await hoverVisibleAdd(page);
    await shot(page, 'watch-hover');
    pass(`${variant.name}: ${variant.theme} theme: hover add button on related videos`);

    // My Tools shows the module in its manager and refuses new adds while it is switched off.
    if (variant.name === 'my-tools') {
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${variant.id}/popup.html`);
      await manager.click('button.module-open[data-module="ytqueue"]');
      const frame = await (await manager.waitForSelector('#module-frame')).contentFrame();
      await frame.waitForFunction(() => document.getElementById('target').textContent.endsWith('links.txt'));
      await shot(manager, 'manager-frame');
      const toggle = enabled => manager.evaluate(value => chrome.runtime.sendMessage({ type: 'my-tools:set', module: 'ytqueue', enabled: value }), enabled);
      assert.equal((await toggle(false)).ok, true);
      await page.bringToFront();
      const count = lines(links).length;
      const offId = await hoverVisibleAdd(page);
      await clickMark(page, offId);
      await waitToast(page, /この機能はオフになっています/);
      assert.equal(lines(links).length, count);
      assert.equal((await toggle(true)).ok, true);
      const onId = await hoverVisibleAdd(page);
      await clickMark(page, onId);
      await waitStatus(page, onId, 'queued');
      assert.equal(lines(links).length, count + 1);
      pass(`${variant.name}: the manager opens the module; switching it off blocks adds, switching it on restores them`);
    }
  } catch (error) {
    // Leave evidence: every open page's URL and a screenshot.
    for (const [index, open] of context.pages().entries()) {
      console.log(`FAILED page ${index}: ${open.url()}`);
      await open.screenshot({ path: path.join(output, `${variant.name}-failure-${index}.png`) }).catch(() => {});
    }
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ypq-browser-'));
  try {
    for (const variant of variants) await runVariant(variant, temp);
    console.log(`${checks.length} checks passed`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
