(() => {
  const CHAT_ORIGIN = "https://www3.cbox.ws";
  const PAGE_ORIGIN = "https://kltratv13.blogspot.com";
  const CHANNEL = "kltra-danmaku-v1";
  const params = new URLSearchParams(location.search);

  if (
    window === window.top ||
    location.origin !== CHAT_ORIGIN ||
    params.get("boxid") !== "3538770" ||
    params.get("boxtag") !== "Dn3dpG" ||
    window.location.ancestorOrigins?.[0] !== PAGE_ORIGIN
  ) {
    return;
  }

  const seen = new Set();
  let initialized = false;

  function safeStickerUrl(value) {
    if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f]/.test(value)) return null;
    try {
      const url = new URL(value, location.href);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || url.href.includes("@") || url.port ||
          !(host === "cbox.im" || host.endsWith(".cbox.ws")) || url.href.length > 2048) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function messageContent(body) {
    const parts = [];
    const stickers = [];
    const registerSticker = (code, source) => {
      if (typeof code !== "string" || !/^:[\w+-]{1,32}:$/u.test(code) || stickers.some((item) => item.code === code)) return;
      const url = safeStickerUrl(source);
      if (url && stickers.length < 3) stickers.push({ code, url });
    };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches("script, style")) return;
      if (node.matches(".emote[data-alt]")) {
        registerSticker(node.getAttribute("data-alt"), node.getAttribute("data-url") || node.getAttribute("data-src") || node.getAttribute("src"));
        return;
      }
      if (node.tagName === "IMG") {
        if (node.matches(".emote, .emote *")) registerSticker(node.getAttribute("data-alt") || node.getAttribute("alt"), node.getAttribute("data-url") || node.getAttribute("data-src") || node.getAttribute("src"));
        return;
      }
      if (node.tagName === "BR") parts.push(" ");
      node.childNodes.forEach(walk);
    };
    walk(body);
    let text = parts.join("").replace(/\s+/g, " ").trim().slice(0, 240);
    text = text.replace(/:[\w+-]{1,32}:/gu, (code) => {
      const sources = document.querySelectorAll?.("img.emote") || [];
      for (const source of sources) {
        if (source.getAttribute("data-alt") === code || source.getAttribute("alt") === code) {
          registerSticker(code, source.getAttribute("data-url") || source.getAttribute("data-src") || source.getAttribute("src"));
          break;
        }
      }
      return stickers.some((item) => item.code === code) ? "" : code;
    }).replace(/\s+/g, " ").trim();
    return { text, stickers };
  }

  function readMessage(element, emit) {
    const id = element.getAttribute("data-id");
    if (!id || !/^\d{1,16}$/.test(id) || seen.has(id)) return;
    const name = element.querySelector(":scope > .nme")?.textContent?.trim().slice(0, 30) || "匿名";
    const body = element.querySelector(":scope > .body");
    const { text, stickers } = body ? messageContent(body) : { text: "", stickers: [] };
    if (!text && !stickers.length) return;
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    if (!emit) return;
    window.parent.postMessage({ channel: CHANNEL, id, name, text, stickers }, PAGE_ORIGIN);
  }

  function scan(root, emit) {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches(".msg")) readMessage(root, emit);
    root.querySelectorAll(".msg").forEach((element) => readMessage(element, emit));
  }

  function start() {
    const messages = document.getElementById("messages");
    if (!messages) return false;
    scan(messages, false); // ページを開く前の履歴は流さない
    initialized = true;
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const message = mutation.target.closest?.(".msg") || mutation.target.parentElement?.closest(".msg");
        if (message) readMessage(message, true);
        for (const node of mutation.addedNodes) scan(node, true);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    return true;
  }

  function replaceMessageText(message, translated, original) {
    const body = message.querySelector(":scope > .body");
    if (!body || typeof translated !== "string" || translated.length > 800) return;
    let replaced = false;
    const textNodes = [];
    const walkText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { textNodes.push(node); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(".emote, .emote *")) return;
      node.childNodes.forEach(walkText);
    };
    walkText(body);
    for (const node of textNodes) {
      if (!replaced) {
        node.textContent = original ? `${translated}\n[原文] ${original}` : translated;
        replaced = true;
      } else {
        node.remove();
      }
    }
    if (!replaced) body.insertBefore(document.createTextNode(translated), body.firstChild);
    body.querySelector(":scope > .kltra-original-toggle")?.remove();
    body.querySelector(":scope > .kltra-original-text")?.remove();
    if (original) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "kltra-original-toggle";
      button.textContent = "原文を表示";
      const originalNode = document.createElement("span");
      originalNode.className = "kltra-original-text";
      originalNode.textContent = ` [原文] ${original}`;
      originalNode.hidden = true;
      button.addEventListener("click", () => {
        originalNode.hidden = !originalNode.hidden;
        button.textContent = originalNode.hidden ? "原文を表示" : "原文を隠す";
      });
      body.append(" ", button, originalNode);
    }
  }

  window.addEventListener?.("message", (event) => {
    if (event.origin !== PAGE_ORIGIN || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.type !== "TRANSLATED" ||
        typeof data.id !== "string" || !/^\d{1,16}$/.test(data.id)) return;
    const message = document.querySelector(`.msg[data-id="${data.id}"]`);
    if (message) replaceMessageText(message, data.text, typeof data.original === "string" ? data.original : "");
  });

  if (!start()) {
    const observer = new MutationObserver(() => {
      if (!initialized && start()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
