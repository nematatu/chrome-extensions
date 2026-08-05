(function initSushidaPageBridge() {
  if (window.__sushidaLogPageBridgeInstalled) return;
  window.__sushidaLogPageBridgeInstalled = true;

  function notify(type, payload) {
    window.postMessage(
      {
        source: "SUSHIDA_LOG_PAGE",
        type,
        ...payload
      },
      "*"
    );
  }

  function installUnityHook() {
    const patch = () => {
      if (!window.UnityLoader || window.UnityLoader.__sushidaLogPatched) return;
      const originalInstantiate = window.UnityLoader.instantiate;
      if (typeof originalInstantiate !== "function") return;

      window.UnityLoader.__sushidaLogPatched = true;
      window.UnityLoader.instantiate = function patchedInstantiate() {
        const instance = originalInstantiate.apply(this, arguments);
        window.__sushidaLogUnityInstance = instance;
        notify("unity-instance", { reason: "instantiate" });
        return instance;
      };
    };

    patch();
    const timerId = setInterval(() => {
      patch();
      if (window.UnityLoader && window.UnityLoader.__sushidaLogPatched) {
        clearInterval(timerId);
      }
    }, 20);
    setTimeout(() => clearInterval(timerId), 10000);
  }

  function inspectUrl(rawUrl, reason, body) {
    if (!rawUrl) return;

    let url;
    try {
      url = new URL(String(rawUrl), location.href);
    } catch (_error) {
      return;
    }

    const normalized = url.href;
    if (normalized.includes("twitter.com/intent/tweet") || normalized.includes("x.com/intent/tweet")) {
      notify("tweet-url", { url: normalized, reason });
    }

    if (normalized.includes("sushida.net/php/r.php")) {
      notify("result-request", {
        url: normalized,
        reason,
        body: serializeBody(body)
      });
    }
  }

  function serializeBody(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const params = new URLSearchParams();
      for (const [key, value] of body.entries()) {
        params.append(key, typeof value === "string" ? value : "[file]");
      }
      return params.toString();
    }
    if (body instanceof ArrayBuffer) return decodeBytes(new Uint8Array(body));
    if (ArrayBuffer.isView(body)) {
      return decodeBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    }
    try {
      return JSON.stringify(body);
    } catch (_error) {
      return String(body);
    }
  }

  function decodeBytes(bytes) {
    if (!bytes || !bytes.byteLength) return "";
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch (_error) {
      return `[bytes:${bytes.byteLength}]`;
    }
  }

  const originalOpen = window.open;
  window.open = function patchedOpen(url, target, features) {
    inspectUrl(url, "window-open");
    return originalOpen.call(window, url, target, features);
  };

  function isTweetUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
      const url = new URL(String(rawUrl), location.href);
      return url.href.includes("twitter.com/intent/tweet") || url.href.includes("x.com/intent/tweet");
    } catch (_error) {
      return false;
    }
  }

  function wrapCallable(owner, key, label) {
    const original = owner && owner[key];
    if (typeof original !== "function" || original.__sushidaLogWrapped) return;

    const wrapped = function wrappedSushidaCallable() {
      for (const argument of arguments) {
        if (typeof argument === "string") {
          inspectUrl(argument, label);
        }
      }
      return original.apply(this, arguments);
    };
    wrapped.__sushidaLogWrapped = true;
    owner[key] = wrapped;
  }

  function installNamedFunctionHooks() {
    const names = [
      "openWindow",
      "OpenWindow",
      "OpenLinkJSPlugin",
      "openLink",
      "OpenLink",
      "Tweet",
      "TweetRanking"
    ];

    for (const name of names) {
      wrapCallable(window, name, `global-${name}`);
    }

    const instance = window.__sushidaLogUnityInstance;
    const module = instance && instance.Module;
    if (module) {
      for (const name of names) {
        wrapCallable(module, name, `module-${name}`);
      }
    }
  }

  function installLocationHooks() {
    const originalAssign = window.location.assign.bind(window.location);
    const originalReplace = window.location.replace.bind(window.location);

    window.location.assign = function patchedAssign(url) {
      inspectUrl(url, "location-assign");
      return originalAssign(url);
    };

    window.location.replace = function patchedReplace(url) {
      inspectUrl(url, "location-replace");
      return originalReplace(url);
    };
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      inspectUrl(url, "fetch", init && init.body);
      return originalFetch.call(this, input, init).then((response) => {
        if (url && String(url).includes("sushida.net/php/r.php")) {
          response
            .clone()
            .text()
            .then((text) => {
              notify("result-response", {
                url: new URL(String(url), location.href).href,
                reason: "fetch-response",
                responseText: text.slice(0, 5000)
              });
            })
            .catch(() => {});
        }
        return response;
      });
    };
  }

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__sushidaLogUrl = url;
    inspectUrl(url, "xhr-open");
    this.addEventListener("load", function onLoad() {
      const urlText = String(this.__sushidaLogUrl || "");
      if (!urlText.includes("sushida.net/php/r.php")) return;
      let responseText = "";
      try {
        if (!this.responseType || this.responseType === "text") {
          responseText = String(this.responseText || "");
        } else if (this.response instanceof ArrayBuffer) {
          responseText = decodeBytes(new Uint8Array(this.response));
        } else if (typeof this.response === "string") {
          responseText = this.response;
        } else if (this.response != null) {
          responseText = `[${this.responseType}]`;
        }
      } catch (error) {
        responseText = `[response-unreadable:${error && error.name ? error.name : "error"}]`;
      }
      notify("result-response", {
        url: new URL(urlText, location.href).href,
        reason: "xhr-response",
        responseText: responseText.slice(0, 5000)
      });
    });
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    inspectUrl(this.__sushidaLogUrl, "xhr-send", body);
    return originalXhrSend.apply(this, arguments);
  };

  setInterval(installNamedFunctionHooks, 1000);
  try {
    installLocationHooks();
  } catch (error) {
    notify("debug", {
      reason: "location-hook-failed",
      message: error && error.message ? error.message : String(error)
    });
  }
  installUnityHook();
})();
