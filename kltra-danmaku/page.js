(() => {
  const CHAT_URL = "https://www3.cbox.ws/box/?boxid=3538770&boxtag=Dn3dpG";
  const CHAT_ORIGIN = "https://www3.cbox.ws";
  const CHANNEL = "kltra-danmaku-v1";
  const DEFAULTS = { enabled: true, fontSize: 23, transparency: 0, position: 0, speed: 130, showName: true,
    translationEnabled: true, translationSource: "auto", translationEngine: "online" };
  const LIMITS = { fontSize: [14, 40], transparency: [0, 100], position: [0, 100], speed: [60, 300] };
  const seen = new Set();
  let settings = { ...DEFAULTS };
  let settingsLoaded = false;
  let wrapper;
  let layer;
  let resizeObserver;
  let lanes = [];
  let nextLane = 0;
  const translation = KltraTranslation.createTranslation();

  function safeStickerUrl(value) {
    if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f]/.test(value)) return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !(host === "cbox.im" || host.endsWith(".cbox.ws")) || url.href.length > 2048) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function normalize(values) {
    const result = {
      enabled: typeof values.enabled === "boolean" ? values.enabled : DEFAULTS.enabled,
      showName: typeof values.showName === "boolean" ? values.showName : DEFAULTS.showName,
      translationEnabled: typeof values.translationEnabled === "boolean"
        ? values.translationEnabled : DEFAULTS.translationEnabled,
      translationSource: ["auto", "id", "en"].includes(values.translationSource)
        ? values.translationSource : DEFAULTS.translationSource,
      translationEngine: ["online", "local"].includes(values.translationEngine)
        ? values.translationEngine : DEFAULTS.translationEngine,
    };
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const value = values[key];
      result[key] = typeof value === "number" && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : DEFAULTS[key];
    }
    return result;
  }

  function applySettings(values) {
    settings = normalize(values);
    if (layer) {
      layer.style.setProperty("--kltra-font-size", `${settings.fontSize}px`);
      layer.style.setProperty("--kltra-opacity", String(1 - settings.transparency / 100));
      if (!settings.enabled) layer.replaceChildren();
    }
    lanes = [];
    translation.updateSettings(settings);
  }

  function loadChat() {
    const frame = document.querySelector("#chat .chat-iframe");
    if (!frame || frame.getAttribute("data-src") !== CHAT_URL) return;
    if (!frame.getAttribute("src")) frame.setAttribute("src", CHAT_URL);
  }

  function mount() {
    const target = document.getElementById("video-wrapper-container");
    if (!target || (wrapper === target && layer?.isConnected)) return;
    resizeObserver?.disconnect();
    wrapper = target;
    layer = document.createElement("div");
    layer.className = "kltra-danmaku-layer";
    layer.setAttribute("aria-hidden", "true");
    wrapper.append(layer);
    applySettings(settings);
    const updateSize = () => {
      layer.style.height = `${wrapper.getBoundingClientRect().height}px`;
    };
    updateSize();
    resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(wrapper);
    lanes = [];
  }

  function show(name, text, stickers) {
    if (!settings.enabled || !layer?.isConnected) return null;
    const height = layer.clientHeight;
    const width = layer.clientWidth;
    if (height < 80 || width < 160) return null;
    const laneHeight = Math.max(28, settings.fontSize + 10);
    const count = Math.max(1, Math.min(4, Math.floor((height - 16) / laneHeight)));
    const slots = stickers.length ? Math.min(count, Math.ceil(96 / laneHeight)) : 1;
    const bandTop = 8 + Math.max(0, height - 16 - count * laneHeight) * settings.position / 100;
    const now = performance.now();
    let chosen = -1;
    for (let offset = 0; offset < count; offset++) {
      const index = (nextLane + offset) % count;
      if (index + slots <= count &&
          Array.from({ length: slots }, (_, slot) => lanes[index + slot] || 0).every((until) => until <= now)) {
        chosen = index;
        break;
      }
    }
    if (chosen < 0) return null; // 混雑時は重なりを防ぐ
    nextLane = (chosen + slots) % count;

    const item = document.createElement("div");
    item.className = "kltra-danmaku-item";
    item.style.animationName = "none";
    item.style.setProperty("--kltra-sticker-height", `${slots * laneHeight - 8}px`);
    const textNode = document.createElement("span");
    textNode.className = "kltra-danmaku-text";
    textNode.textContent = settings.showName ? `${name}: ${text}`.trim() : text;
    if (textNode.textContent) item.append(textNode);
    for (const sticker of stickers) {
      const picture = document.createElement("img");
      picture.className = "kltra-danmaku-sticker";
      picture.alt = sticker.code;
      picture.loading = "eager";
      picture.decoding = "async";
      picture.src = sticker.url;
      item.append(picture);
    }
    item.style.top = `${bandTop + chosen * laneHeight}px`;
    layer.append(item);

    const textWidth = item.getBoundingClientRect().width;
    const travel = width + textWidth + 8;
    const duration = travel / settings.speed;
    item.style.setProperty("--kltra-distance", `-${travel}px`);
    item.style.animationDuration = `${duration}s`;
    item.style.animationName = "";
    for (let slot = 0; slot < slots; slot++) {
      lanes[chosen + slot] = now + ((textWidth + 52) / settings.speed) * 1000;
    }
    item.addEventListener("animationend", () => item.remove(), { once: true });
    return { item, lane: chosen, slots, name, textNode };
  }

  window.addEventListener("message", (event) => {
    const frame = document.querySelector("#chat .chat-iframe");
    if (event.origin !== CHAT_ORIGIN || event.source !== frame?.contentWindow) return;
    const data = event.data;
    if (
      !data || data.channel !== CHANNEL ||
      typeof data.id !== "string" || !/^\d{1,16}$/.test(data.id) ||
      typeof data.name !== "string" || data.name.length > 30 ||
      typeof data.text !== "string" || data.text.length > 240 ||
      !Array.isArray(data.stickers) || data.stickers.length > 3 ||
      data.stickers.some((sticker) => typeof sticker?.code !== "string" ||
        !/^:[\w+-]{1,32}:$/u.test(sticker.code) || !safeStickerUrl(sticker.url)) ||
      (!data.text && !data.stickers.length) ||
      seen.has(data.id)
    ) return;
    seen.add(data.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    const stickers = data.stickers;
    // 翻訳が終わるまで弾幕を作らない。ステッカーだけの投稿は即時表示する。
    Promise.resolve(settings.translationEnabled && data.text
      ? translation.translateText(data.text) : data.text)
      .then((translated) => show(data.name, translated, stickers));
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_STATUS") {
      sendResponse({ ready: Boolean(layer?.isConnected), fullscreen: document.fullscreenElement === wrapper,
        translation: translation.getStatus() });
      return;
    }
    if (message?.type === "PREPARE_TRANSLATION") {
      translation.prepareCached().then(() => sendResponse({ translation: translation.getStatus() }));
      return true;
    }
    if (message?.type !== "TOGGLE_FULLSCREEN" || !wrapper?.isConnected) return;
    const action = document.fullscreenElement === wrapper
      ? document.exitFullscreen()
      : wrapper.requestFullscreen();
    action.then(() => sendResponse({ ok: true, fullscreen: document.fullscreenElement === wrapper }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });

  chrome.storage.local.get(DEFAULTS, (values) => {
    if (!chrome.runtime.lastError) applySettings(values);
    settingsLoaded = true;
    loadChat();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const values = { ...settings };
    for (const key of Object.keys(DEFAULTS)) {
      if (key in changes) values[key] = changes[key].newValue;
    }
    applySettings(values);
  });

  mount();
  const prepareOnInteraction = () => {
    if (settings.translationEnabled && translation.getStatus() !== "ready") {
      translation.prepareFromGesture();
    }
  };
  document.addEventListener("pointerdown", prepareOnInteraction, { capture: true });
  document.addEventListener("keydown", prepareOnInteraction, { capture: true });
  new MutationObserver(() => {
    mount();
    if (settingsLoaded) loadChat();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
