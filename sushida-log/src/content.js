(function initSushidaContent() {
  const seen = new Set();

  function sendRuntimeMessage(message) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (_error) {
      // The old content script can remain alive after reloading the extension.
    }
  }

  function sendResult(result) {
    if (!result || seen.has(result.id)) return;
    seen.add(result.id);

    sendRuntimeMessage({
      type: "SUSHIDA_RESULT_DETECTED",
      result
    });
  }

  function tryShareText(text) {
    const result = window.SushidaLogParser.parseSushidaShareText(text);
    sendResult(result);
  }

  function tryShareUrl(url) {
    const text = window.SushidaLogParser.extractTweetTextFromUrl(url);
    if (text) tryShareText(text);
  }

  function scanLinks() {
    document.querySelectorAll("a[href]").forEach((anchor) => {
      tryShareUrl(anchor.href);
    });
  }

  function installWindowOpenHook() {
    const originalOpen = window.open;
    window.open = function patchedOpen(url, target, features) {
      if (url) tryShareUrl(String(url));
      return originalOpen.call(window, url, target, features);
    };
  }

  function installPageBridge() {
    if (!/^https:\/\/([^/]+\.)?sushida\.net\//.test(location.href)) return;

    const inject = () => {
      if (!document.documentElement) {
        setTimeout(inject, 0);
        return;
      }
      let bridgeUrl;
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
        bridgeUrl = chrome.runtime.getURL("src/page-bridge.js");
      } catch (_error) {
        return;
      }
      const script = document.createElement("script");
      script.src = bridgeUrl;
      script.onload = () => script.remove();
      document.documentElement.appendChild(script);
    };

    inject();
  }

  function installBridgeMessageHandler() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || message.source !== "SUSHIDA_LOG_PAGE") return;

      if (message.type === "tweet-url" && message.url) {
        tryShareUrl(message.url);
      }

      if (message.type === "unity-instance" || message.type === "debug") {
        sendRuntimeMessage({
          type: "SUSHIDA_DEBUG_EVENT",
          payload: {
            type: message.type,
            savedAt: new Date().toISOString(),
            objectName: message.objectName,
            methodName: message.methodName,
            reason: message.reason,
            pageUrl: location.href
          }
        });
      }

      if (message.type === "result-request") {
        sendRuntimeMessage({
          type: "SUSHIDA_RESULT_NETWORK_DETECTED",
          payload: {
            kind: "request",
            reason: message.reason || "result-request",
            url: message.url,
            body: message.body
          }
        });
      }

      if (message.type === "result-response") {
        sendRuntimeMessage({
          type: "SUSHIDA_RESULT_NETWORK_DETECTED",
          payload: {
            kind: "response",
            reason: message.reason || "result-response",
            url: message.url,
            responseText: message.responseText
          }
        });
      }

    });
  }

  function installClickHook() {
    document.addEventListener(
      "click",
      (event) => {
        const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
        if (anchor) tryShareUrl(anchor.href);
      },
      true
    );
  }

  function installMutationObserver() {
    if (!document.documentElement) return;

    const observer = new MutationObserver(() => {
      scanLinks();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"]
    });
  }

  installPageBridge();
  installBridgeMessageHandler();
  installWindowOpenHook();
  tryShareUrl(location.href);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      installClickHook();
      installMutationObserver();
      scanLinks();
    });
  } else {
    installClickHook();
    installMutationObserver();
    scanLinks();
  }
})();
