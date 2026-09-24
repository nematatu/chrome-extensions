// 無料の Google 翻訳ウェブ用経路。公式 API ではないため、失敗時は原文を残す。
const PAGE_URL = "https://kltratv13.blogspot.com/p/galaxy.html";
const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_TEXT = 240;
const MAX_RESPONSE = 16000;
let inFlight = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "TRANSLATE_ONLINE") return;
  if (sender.id !== chrome.runtime.id || sender.url !== PAGE_URL || sender.frameId !== 0 ||
      typeof message.text !== "string" || !message.text.trim() ||
      message.text.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message.text) ||
      !["auto", "id", "en"].includes(message.source) || inFlight >= 4) {
    sendResponse({ ok: false });
    return;
  }
  inFlight++;
  (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({ client: "gtx", sl: message.source, tl: "ja", dt: "t", q: message.text });
      const response = await fetch(url, {
        signal: controller.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      });
      if (!response.ok || Number(response.headers.get("content-length") || 0) > MAX_RESPONSE) throw new Error("Bad response");
      const body = await response.text();
      if (body.length > MAX_RESPONSE) throw new Error("Oversized response");
      const data = JSON.parse(body);
      const translated = Array.isArray(data?.[0])
        ? data[0].map((part) => Array.isArray(part) ? part[0] : "").join("") : "";
      if (typeof translated !== "string" || !translated.trim() || translated.length > 500) throw new Error("Bad translation");
      sendResponse({ ok: true, text: translated.trim() });
    } catch {
      sendResponse({ ok: false });
    } finally {
      clearTimeout(timeout);
      inFlight--;
    }
  })();
  return true;
});
