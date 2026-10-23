(() => {
  "use strict";
  const core = globalThis.IGMediaCore;
  const publish = data => {
    const groups = core.groups(data);
    if (groups.length) window.postMessage({ source: "ig-media-downloader", groups: groups.slice(0, 200) }, location.origin);
  };
  const accept = async response => {
    try {
      const url = new URL(response.url, location.href);
      if (url.origin !== location.origin || !/\/(api|graphql)\//.test(url.pathname) ||
          !/^(?:application\/(?:json|javascript|x-javascript)|text\/javascript)(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) return;
      const reader = response.clone().body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 12 * 1024 * 1024) { await reader.cancel(); return; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      publish(JSON.parse(new TextDecoder().decode(bytes).replace(/^for\s*\(;;\);\s*/, "")));
    } catch {}
  };
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    void accept(response);
    return response;
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const url = new URL(this.responseURL);
        if (url.origin !== location.origin || !/\/(api|graphql)\//.test(url.pathname)) return;
        if (this.responseType === "json") publish(this.response);
        else if ((!this.responseType || this.responseType === "text") && this.responseText.length < 12 * 1024 * 1024) publish(JSON.parse(this.responseText));
      } catch {}
    }, { once: true });
    return send.apply(this, args);
  };
})();
