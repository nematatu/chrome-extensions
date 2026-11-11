'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const extension = path.resolve(__dirname, '../../dist/my-tools');
const output = path.resolve(__dirname, '../test-results/native-popup.png');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'my-tools-native-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(temp, {
      channel: 'chromium', headless: true, viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const cdp = await context.browser().newBrowserCDPSession();
    await worker.evaluate(() => chrome.action.openPopup());
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find(item => item.url === new URL('popup.html', worker.url()).href);
    assert.ok(target, 'actual action popup target exists');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    let nextId = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const finish = (error, result) => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); error ? reject(error) : resolve(result); };
      const receive = event => {
        const reply = JSON.parse(event.message);
        if (event.sessionId === sessionId && reply.id === id) finish(reply.error && new Error(reply.error.message), reply.result);
      };
      const timer = setTimeout(() => finish(new Error(`Popup ${method} timed out`)), 10000);
      cdp.on('Target.receivedMessageFromTarget', receive);
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => finish(error));
    });
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await send('Runtime.evaluate', { expression: `JSON.stringify({width:innerWidth,height:innerHeight,ready:!!document.querySelector('#instagram:not([disabled])'),instagram:document.querySelector('#instagram')?.getBoundingClientRect().toJSON()})`, returnByValue: true });
      result = JSON.parse(response.result.value);
      if (result.ready && result.width >= 380) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(result.ready, true);
    assert.ok(result.width >= 380 && result.width <= 800, `actual popup width ${result.width}px`);
    assert.ok(result.height > 200 && result.height <= 600, `actual popup height ${result.height}px`);
    assert.ok(result.instagram.left >= 0 && result.instagram.right <= result.width, 'Instagram switch fits actual popup');
    assert.ok(result.instagram.top >= 0 && result.instagram.bottom <= result.height, 'Instagram switch visible on opening');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    console.log(`PASS actual chrome.action popup ${result.width}x${result.height}; Instagram switch visible`);
  } finally {
    await context?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
