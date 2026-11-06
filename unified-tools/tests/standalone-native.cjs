'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(__dirname, '../test-results/ui');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function targetSession(cdp, sessionId) {
  let nextId = 0;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const finish = (error, result) => {
      clearTimeout(timer);
      cdp.off('Target.receivedMessageFromTarget', receive);
      error ? reject(error) : resolve(result);
    };
    const receive = event => {
      const reply = JSON.parse(event.message);
      if (event.sessionId === sessionId && reply.id === id) finish(reply.error && new Error(reply.error.message), reply.result);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), 10000);
    cdp.on('Target.receivedMessageFromTarget', receive);
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => finish(error));
  });
}

async function inspect(module) {
  const extension = path.join(root, module.source);
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `standalone-native-${module.id}-`));
  let context;
  try {
    context = await chromium.launchPersistentContext(temp, {
      channel: 'chromium', headless: true, viewport: null, colorScheme: 'light',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const listing = await context.newPage();
    await listing.goto('chrome://extensions/');
    const item = listing.locator('extensions-item').filter({ hasText: manifest.name });
    await item.waitFor();
    const extensionId = await item.getAttribute('id');
    assert.match(extensionId, /^[a-p]{32}$/);
    const popupURL = `chrome-extension://${extensionId}/${manifest.action.default_popup}`;
    const source = await context.newPage();
    await source.goto(popupURL);
    const sourceCDP = await context.newCDPSession(source);
    const sourceTarget = (await sourceCDP.send('Target.getTargetInfo')).targetInfo.targetId;
    await source.evaluate(() => chrome.action.openPopup());
    const cdp = await context.browser().newBrowserCDPSession();
    let target;
    for (let attempt = 0; attempt < 50; attempt++) {
      target = (await cdp.send('Target.getTargets')).targetInfos.find(item => item.url === popupURL && item.targetId !== sourceTarget);
      if (target) break;
      await wait(50);
    }
    assert.ok(target, `${module.id} actual action popup target exists`);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    const send = targetSession(cdp, sessionId);
    let metrics, previous = "", stable = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body?.getBoundingClientRect().width,footerBottom:document.querySelector("#media-footer")?.getBoundingClientRect().bottom,footerTop:document.querySelector("#media-footer")?.getBoundingClientRect().top,mainTop:document.querySelector(".main")?.getBoundingClientRect().top,rescan:document.querySelector("#empty-refresh")?.getBoundingClientRect().toJSON(),restricted:document.querySelector("#restricted-hint") ? !document.querySelector("#restricted-hint").hidden : undefined,title:document.title,settings:[...document.querySelectorAll(".settings input[type=checkbox]")].map(el=>({id:el.id,checked:el.checked})),ready:document.readyState === "complete"})',
        returnByValue: true,
      });
      metrics = JSON.parse(response.result.value);
      const current = JSON.stringify(metrics);
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (metrics.ready && stable >= 3) break;
      await wait(100);
    }
    if (module.id === "instagram") {
      assert.equal(metrics.title, "better-ig");
      assert.deepEqual(metrics.settings, [{id:"download-enabled",checked:true},{id:"quality-enabled",checked:true},{id:"rotate-live",checked:true}]);
    }
    if (module.id === "mediasaver") {
      assert.ok(metrics.height >= 400, "Media Saver retains a usable scrollable media area");
      assert.ok(metrics.footerBottom <= metrics.height, `Media Saver footer visible (${metrics.footerBottom}/${metrics.height})`);
      assert.equal(metrics.restricted, true, "Media Saver native test covers a restricted page");
      assert.ok(metrics.rescan?.width > 0, "Media Saver empty state rescan button is visible");
      assert.ok(metrics.rescan.top >= metrics.mainTop && metrics.rescan.bottom <= metrics.footerTop, "Media Saver rescan button fits above the footer without scrolling");
    }
    fs.writeFileSync(path.join(output, `native-${module.id}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    assert.equal(metrics.ready, true, `${module.id} document is ready`);
    assert.ok(metrics.width >= 360 && metrics.width <= 800, `${module.id} native width ${metrics.width}px`);
    assert.ok(metrics.height > 40 && metrics.height <= 600, `${module.id} native height ${metrics.height}px`);
    assert.ok(metrics.scrollWidth <= metrics.width, `${module.id} no horizontal overflow (${metrics.scrollWidth}/${metrics.width})`);
    assert.ok(metrics.bodyWidth > 300 && metrics.bodyWidth <= metrics.width, `${module.id} body fits native width`);
    console.log(`PASS ${module.id} native action popup ${metrics.width}x${metrics.height}`);
    return { id: module.id, ...metrics };
  } finally {
    await context?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { modules } = await import('../modules.mjs');
  const popups = modules.filter(module => JSON.parse(fs.readFileSync(path.join(root, module.source, 'manifest.json'), 'utf8')).action?.default_popup);
  const evidence = [], failures = [];
  for (const module of popups) {
    try { evidence.push(await inspect(module)); }
    catch (error) { failures.push(`${module.id}: ${error.message}`); console.error(`FAIL ${module.id}: ${error.message}`); }
  }
  fs.writeFileSync(path.join(output, 'native-popups.json'), JSON.stringify({ results: evidence, failures }, null, 2));
  assert.deepEqual(failures, []);
  assert.equal(evidence.length, popups.length);
  console.log(`PASS ${evidence.length} standalone native action popups`);
})().catch(error => { console.error(error); process.exitCode = 1; });
