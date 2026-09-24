// Chrome for Testing で実サイトと拡張機能を起動する通しテスト。
// Cbox への投稿は行わず、読み込まれた iframe の DOM にだけ検証用投稿を追加する。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chromeBin = process.env.CHROME_BIN;
if (!chromeBin) {
  throw new Error("CHROME_BIN に Chrome for Testing の実行ファイルを指定してください");
}

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = mkdtempSync(path.join(tmpdir(), "kltra-danmaku-e2e-"));
const pageUrl = "https://kltratv13.blogspot.com/p/galaxy.html";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chrome = spawn(chromeBin, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-allow-origins=*",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extension}`,
  `--load-extension=${extension}`,
  "about:blank",
], { stdio: "ignore" });

let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number(readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (port) break;
    } catch { /* Chrome の起動を待つ */ }
    await sleep(100);
  }
  assert.ok(port, "Chrome for Testing が起動しませんでした");

  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((tab) => tab.type === "page");
  assert.ok(page, "ブラウザーのタブを開けませんでした");

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const frames = new Map();
  const contexts = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
    if (message.method === "Target.attachedToTarget") {
      frames.set(message.params.sessionId, message.params.targetInfo);
    }
    if (message.method === "Target.targetInfoChanged") {
      for (const [sessionId, info] of frames) {
        if (info.targetId === message.params.targetInfo.targetId) frames.set(sessionId, message.params.targetInfo);
      }
    }
    if (message.method === "Runtime.executionContextCreated") {
      contexts.push({ sessionId: message.sessionId, id: message.params.context.id,
        name: message.params.context.name, origin: message.params.context.origin });
    }
  };
  const send = (method, params = {}, sessionId, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome DevTools が応答しません: ${method}`));
    }, timeoutMs);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (expression, sessionId, userGesture = false, timeoutMs = 5000) => {
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture }, sessionId, timeoutMs);
    if (reply.error || reply.result?.exceptionDetails) {
      throw new Error(reply.error?.message || reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text);
    }
    return reply.result?.result?.value;
  };
  const state = async () => JSON.parse(await evaluate(`JSON.stringify({
    url:location.href,
    chatTabOpen:document.querySelector('#chat')?.classList.contains('active'),
    pageButtons:document.querySelectorAll('.kltra-danmaku-button').length,
    frameSrc:document.querySelector('#chat .chat-iframe')?.getAttribute('src'),
    layerHeight:document.querySelector('.kltra-danmaku-layer')?.clientHeight
  })`));

  await send("Page.enable");
  await send("Network.enable");
  // サイトの開発者ツール検出のみ停止する。チャットと配信のコードは変更しない。
  await send("Network.setBlockedURLs", { urls: ["*disable-devtool*"] });
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url: pageUrl });
  for (let i = 0; i < 100; i++) {
    try {
      const current = await state();
      if (current.url === pageUrl && current.layerHeight > 100) break;
    } catch { /* ページ遷移中の実行コンテキスト切り替えを待つ */ }
    await sleep(100);
  }
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  let chatSession;
  for (let i = 0; i < 200; i++) {
    chatSession = [...frames].find(([, info]) => info.type === "iframe" && info.url.startsWith("https://www3.cbox.ws/box/"))?.[0];
    if (chatSession) break;
    await sleep(100);
  }
  assert.ok(chatSession, `Cbox iframe が読み込まれませんでした: ${JSON.stringify([...frames.values()].map((item) => item.url))}`);
  console.log("Cbox iframe ready");
  await send("Runtime.enable", {}, chatSession);
  for (let i = 0; i < 80 && !contexts.some((item) => item.sessionId === chatSession && item.name === "KLTRA 弾幕チャット"); i++) {
    await sleep(25);
  }
  assert.ok(contexts.some((item) => item.sessionId === chatSession && item.name === "KLTRA 弾幕チャット"), "Cbox 側のコンテンツスクリプトが起動しませんでした");

  if (process.env.KLTRA_INSPECT_IMAGES === "1") {
    const structure = await evaluate(`JSON.stringify((() => {
      const messages = [...document.querySelectorAll('#messages .msg')];
      return {
        count:messages.length,
        imageMessages:messages.filter(message => message.querySelector('.body img')).length,
        samples:messages.filter(message => message.querySelector('.body img')).slice(0, 5).map(message =>
          [...message.querySelectorAll('.body img')].map(img => ({
            className:img.className, attributes:img.getAttributeNames(),
            parentTag:img.parentElement?.tagName, parentClass:img.parentElement?.className,
            inEmote:!!img.closest('.emote'),
            host:(() => { try { return new URL(img.currentSrc || img.src).hostname; } catch { return ''; } })(),
          }))),
      };
    })())`, chatSession);
    console.log(`Cbox image structure: ${structure}`);
  }

  const initial = await state();
  assert.equal(initial.url, pageUrl);
  assert.equal(initial.chatTabOpen, false);
  assert.equal(initial.pageButtons, 0);
  assert.ok(initial.frameSrc?.startsWith("https://www3.cbox.ws/box/"));
  assert.ok(initial.layerHeight > 100);
  console.log("Page content script ready");
  const pageContext = contexts.find((item) => !item.sessionId && item.name === "KLTRA 弾幕チャット");
  const translationProbe = await send("Runtime.evaluate", {
    expression: `(async () => JSON.stringify({ api:typeof Translator, detector:typeof LanguageDetector,
      indonesian:await Translator.availability({sourceLanguage:'id',targetLanguage:'ja'}),
      english:await Translator.availability({sourceLanguage:'en',targetLanguage:'ja'}) }))()`,
    contextId: pageContext.id, returnByValue: true, awaitPromise: true,
  });
  assert.ok(!translationProbe.result?.exceptionDetails, "翻訳スクリプトが読み込まれませんでした");
  console.log(`Translation API probe: ${translationProbe.result?.result?.value}`);

  const inject = (id, body) => evaluate(`(() => {
    const message = document.createElement('div');
    message.className = 'msg';
    message.dataset.id = '${id}';
    const name = document.createElement('div');
    name.className = 'nme';
    name.textContent = 'E2E';
    const text = document.createElement('div');
    text.className = 'body';
    text.textContent = '${body}';
    message.append(name, text);
    document.querySelector('#messages').prepend(message);
  })()`, chatSession);
  const injectSticker = (id, caption = "") => evaluate(`(() => {
    const message = document.createElement('div');
    message.className = 'msg';
    message.dataset.id = '${id}';
    const name = document.createElement('div');
    name.className = 'nme';
    name.textContent = 'E2E';
    const body = document.createElement('div');
    body.className = 'body';
    if (${JSON.stringify(Boolean(caption))}) body.append(document.createTextNode(${JSON.stringify(caption)}));
    const sticker = document.createElement('div');
    sticker.className = 'emote imgBox Defer';
    sticker.dataset.alt = ':123:';
    sticker.dataset.url = 'https://cbox.im/i/Udwsy.jpg';
    body.append(sticker);
    message.append(name, body);
    document.querySelector('#messages').prepend(message);
  })()`, chatSession);

  await inject("999999999999001", "弾幕動作確認");
  let shown = false;
  for (let i = 0; i < 40; i++) {
    shown = await evaluate(`!![...document.querySelectorAll('.kltra-danmaku-item')].find(x=>x.textContent==='E2E: 弾幕動作確認')`);
    if (shown) break;
    await sleep(50);
  }
  assert.ok(shown, "新着投稿が弾幕になりませんでした");
  const visual = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
    const item = document.querySelector('.kltra-danmaku-item');
    const layer = document.querySelector('.kltra-danmaku-layer');
    return { x:item?.getBoundingClientRect().x, animation:item&&getComputedStyle(item).animationName,
      pointerEvents:layer&&getComputedStyle(layer).pointerEvents };
  })())`));
  const first = await visual();
  await sleep(400);
  const second = await visual();
  assert.equal(first.animation, "kltra-danmaku-move");
  assert.equal(first.pointerEvents, "none");
  assert.ok(second.x < first.x, "弾幕が左へ移動しませんでした");
  console.log("Danmaku movement verified");

  await injectSticker("999999999999006");
  let sticker;
  for (let i = 0; i < 100; i++) {
    sticker = JSON.parse(await evaluate(`JSON.stringify((() => {
      const img = document.querySelector('.kltra-danmaku-item img.kltra-danmaku-sticker');
      return { found:!!img, code:img?.alt, width:img?.getBoundingClientRect().width,
        height:img?.getBoundingClientRect().height };
    })())`));
    if (sticker.found) break;
    await sleep(50);
  }
  assert.ok(sticker.found, "ステッカー投稿が弾幕になりませんでした");
  assert.equal(sticker.code, ":123:");
  assert.ok(sticker.width >= 100 && sticker.height >= 40, "ステッカー表示サイズが小さすぎます");
  console.log("Sticker danmaku verified");

  const extensionOrigin = contexts.find((item) => !item.sessionId && item.name === "KLTRA 弾幕チャット")?.origin;
  assert.ok(extensionOrigin?.startsWith("chrome-extension://"), "拡張機能の ID を取得できませんでした");
  const created = await send("Target.createTarget", { url: `${extensionOrigin}/popup.html`, background: true });
  assert.ok(created.result?.targetId, "ポップアップを開けませんでした");
  const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
  const popupSession = attached.result?.sessionId;
  assert.ok(popupSession, "ポップアップに接続できませんでした");
  console.log("Popup target attached");
  await send("Runtime.enable", {}, popupSession);
  let popupStatus;
  for (let i = 0; i < 40; i++) {
    popupStatus = await evaluate(`document.querySelector('#status')?.textContent`, popupSession);
    if (popupStatus === "このタブで動作中") break;
    await sleep(50);
  }
  assert.equal(popupStatus, "このタブで動作中", "ポップアップが配信タブを認識できませんでした");
  console.log("Popup ready");

  const popupChange = (key, value) => evaluate(`(() => {
    const input = document.getElementById('${key}');
    if (input.type === 'checkbox') input.checked = ${JSON.stringify(value)};
    else input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`, popupSession);

  if (process.env.KLTRA_TRANSLATION_E2E === "1") {
    await popupChange("translationEngine", "local");
    await sleep(150);
    await send("Page.bringToFront", {}, popupSession);
    await send("Runtime.evaluate", { expression: "prepareTranslation(); 'started'",
      returnByValue: true, userGesture: true }, popupSession);
    let translationStatus;
    for (let i = 0; i < 240; i++) {
      translationStatus = await evaluate(`document.querySelector('#translationStatus').textContent`, popupSession);
      if (translationStatus.includes("準備ができています") || translationStatus.includes("インドネシア語翻訳は利用可能") ||
          translationStatus.includes("配信ページを一度クリック") ||
          translationStatus.includes("準備できませんでした")) break;
      await sleep(500);
    }
    console.log(`Translation preparation: ${translationStatus}`);
    assert.ok(translationStatus.includes("準備ができています") || translationStatus.includes("インドネシア語翻訳は利用可能") ||
      translationStatus.includes("配信ページを一度クリック"),
      `翻訳モデルの取得が完了しませんでした: ${translationStatus}`);
    await send("Page.bringToFront");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 500, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 500, button: "left", clickCount: 1 });
    await sleep(1000);
    await inject("999999999999004", "Pertandingan sudah dimulai");
    let translated = false;
    for (let i = 0; i < 80; i++) {
      translated = await evaluate(`!![...document.querySelectorAll('.kltra-danmaku-item')]
        .find(x => x.textContent.startsWith('E2E: ') &&
          /[\u3040-\u30ff\u3400-\u9fff]/u.test(x.textContent) &&
          x.textContent !== 'E2E: 弾幕動作確認')`);
      if (translated) break;
      await sleep(100);
    }
    assert.ok(translated, "チャットが日本語の弾幕に変わりませんでした");
    console.log("Japanese translation verified");
  }

  if (process.env.KLTRA_ONLINE_TRANSLATION_E2E === "1") {
    await popupChange("translationEngine", "online");
    await sleep(100);
    await popupChange("enabled", false);
    await popupChange("enabled", true);
    await sleep(100);
    const started = performance.now();
    await inject("999999999999008", "China pless kamu bisa");
    let translated;
    for (let i = 0; i < 70; i++) {
      translated = await evaluate(`!![...document.querySelectorAll('.kltra-danmaku-item')]
        .find(x => /中国.*頑張れ/.test(x.textContent))`);
      if (translated) break;
      await sleep(50);
    }
    assert.ok(translated, "実際のオンライン翻訳で励まし表現が日本語になりませんでした");
    console.log(`Real online translation verified: China pless kamu bisa (${Math.round(performance.now() - started)} ms)`);
  }
  if (process.env.KLTRA_MOCK_TRANSLATION_E2E === "1") {
    await popupChange("translationEngine", "local");
    await sleep(150);
    const mocked = await send("Runtime.evaluate", {
      expression: `(() => {
        const fake = { availability: async () => 'available',
          create: async () => ({ translate: async () => '試合開始' }) };
        globalThis.Translator = fake;
        globalThis.LanguageDetector = { availability: async () => 'available',
          create: async () => ({ detect: async () => [{detectedLanguage:'id',confidence:0.99}] }) };
        return globalThis.Translator === fake;
      })()`, contextId: pageContext.id, returnByValue: true,
    });
    assert.equal(mocked.result?.result?.value, true, "テスト用翻訳 API を設定できませんでした");
    await popupChange("translationEnabled", false);
    await popupChange("translationEnabled", true);
    await sleep(200);
    await evaluate(`globalThis.Translator = {
      create: async () => ({ destroy() {} })
    }`, popupSession);
    await evaluate(`prepareTranslation()`, popupSession, true);
    const translationUi = await evaluate(`document.querySelector('#translationStatus').textContent`, popupSession);
    assert.ok(translationUi.includes("準備ができています"), "ポップアップの翻訳準備結果が表示されませんでした");
    await popupChange("enabled", false);
    await popupChange("enabled", true);
    await sleep(150);
    await injectSticker("999999999999005", "Pertandingan sudah dimulai");
    let translated = false;
    for (let i = 0; i < 40; i++) {
      translated = await evaluate(`!![...document.querySelectorAll('.kltra-danmaku-item')]
        .find(x => x.textContent === 'E2E: 試合開始')`);
      if (translated) break;
      await sleep(50);
    }
    assert.ok(translated, "翻訳結果が移動中の弾幕に反映されませんでした");
    assert.ok(await evaluate(`!![...document.querySelectorAll('.kltra-danmaku-item')]
      .find(x => x.textContent === 'E2E: 試合開始' && x.querySelector('img.kltra-danmaku-sticker'))`),
      "翻訳後に投稿ステッカーが消えました");
    console.log("Japanese danmaku update verified with mocked model");
  }
  await popupChange("enabled", false);
  await sleep(150);
  await inject("999999999999002", "非表示確認");
  await sleep(150);
  assert.equal(await evaluate(`document.querySelectorAll('.kltra-danmaku-item').length`), 0);
  await popupChange("fontSize", 34);
  await popupChange("transparency", 50);
  await popupChange("position", 100);
  await popupChange("speed", 200);
  await popupChange("showName", false);
  await popupChange("translationEnabled", false);
  await popupChange("translationSource", "en");
  await popupChange("translationEngine", "online");
  await popupChange("enabled", true);
  await sleep(200);
  await inject("999999999999003", "再表示確認");
  await sleep(150);
  const configured = JSON.parse(await evaluate(`JSON.stringify((() => {
    const item = [...document.querySelectorAll('.kltra-danmaku-item')].find(x=>x.textContent==='再表示確認');
    const layer = document.querySelector('.kltra-danmaku-layer');
    return { visible:!!item, fontSize:item&&getComputedStyle(item).fontSize,
      opacity:getComputedStyle(layer).opacity, top:item?.offsetTop,
      layerHeight:layer.clientHeight, duration:item&&parseFloat(getComputedStyle(item).animationDuration),
      expectedDuration:item&&(layer.clientWidth+item.getBoundingClientRect().width+8)/200 };
  })())`));
  assert.equal(configured.visible, true, "ユーザー名 OFF または弾幕 ON が反映されませんでした");
  assert.equal(configured.fontSize, "34px");
  assert.equal(configured.opacity, "0.5");
  assert.ok(configured.top > configured.layerHeight / 2, "表示位置が下側になりませんでした");
  assert.ok(Math.abs(configured.duration - configured.expectedDuration) < 0.1, "速度が反映されませんでした");

  await send("Page.enable", {}, popupSession);
  await send("Page.reload", {}, popupSession);
  let saved;
  for (let i = 0; i < 40; i++) {
    try {
      saved = JSON.parse(await evaluate(`JSON.stringify({
        enabled:document.querySelector('#enabled')?.checked,
        fontSize:document.querySelector('#fontSize')?.value,
        transparency:document.querySelector('#transparency')?.value,
        position:document.querySelector('#position')?.value,
        speed:document.querySelector('#speed')?.value,
        showName:document.querySelector('#showName')?.checked,
        translationEnabled:document.querySelector('#translationEnabled')?.checked,
        translationSource:document.querySelector('#translationSource')?.value,
        translationEngine:document.querySelector('#translationEngine')?.value,
        status:document.querySelector('#status')?.textContent
      })`, popupSession));
      if (saved.status === "このタブで動作中" && saved.fontSize === "34") break;
    } catch { /* 再読み込み中の実行コンテキスト切り替えを待つ */ }
    await sleep(50);
  }
  assert.deepEqual(saved, {
    enabled: true, fontSize: "34", transparency: "50", position: "100", speed: "200",
    showName: false, translationEnabled: false, translationSource: "en", translationEngine: "online",
    status: "このタブで動作中",
  }, "設定が保存されませんでした");

  if (process.env.KLTRA_POPUP_SCREENSHOT) {
    await send("Emulation.setDeviceMetricsOverride", { width: 340, height: 620, deviceScaleFactor: 1, mobile: false }, popupSession);
    const shot = await send("Page.captureScreenshot", { format: "png" }, popupSession);
    assert.ok(shot.result?.data, "ポップアップの画像を取得できませんでした");
    writeFileSync(process.env.KLTRA_POPUP_SCREENSHOT, Buffer.from(shot.result.data, "base64"));
  }

  await evaluate(`document.querySelector('#fullscreen').click()`, popupSession, true);
  await sleep(250);
  const fullscreen = JSON.parse(await evaluate(`JSON.stringify({
    element:document.fullscreenElement?.id,
    wrapperHeight:document.querySelector('#video-wrapper-container').getBoundingClientRect().height,
    layerHeight:document.querySelector('.kltra-danmaku-layer').clientHeight
  })`));
  assert.equal(fullscreen.element, "video-wrapper-container");
  assert.ok(Math.abs(fullscreen.wrapperHeight - fullscreen.layerHeight) < 2);

  console.log(JSON.stringify({ result: "PASS", chatTabOpen: initial.chatTabOpen,
    cboxLoaded: true, movedPx: Math.round(first.x - second.x),
    settings: "PASS", toggle: "PASS", fullscreen: "PASS" }));
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
}
