(() => {
  "use strict";
  const core = globalThis.StripchatLiveHoverCore;
  if (!core) return;
  const patchedFactories = new WeakSet();
  let status = "pending";
  let runtimeProbe = 0;

  function publishStatus(next) {
    status = next;
    document.documentElement?.setAttribute(core.CONFIG_STATUS_ATTRIBUTE, next);
  }
  document.addEventListener("DOMContentLoaded", () => publishStatus(status), { once: true });

  function wrapFactory(factory) {
    if (typeof factory !== "function" || patchedFactories.has(factory)) return factory;
    // Only the feature-config module is changed. No player/stream/consent exports.
    if (!Function.prototype.toString.call(factory).includes(".features.liveThumbs")) return factory;
    const wrapped = function (module, exports, nativeRequire) {
      const requireProxy = new Proxy(nativeRequire, {
        get(target, property, receiver) {
          if (property !== "d") return Reflect.get(target, property, receiver);
          return function (exportTarget, definitions) {
            const next = { ...definitions };
            for (const [name, getter] of Object.entries(definitions)) {
              if (typeof getter !== "function") continue;
              let resolved = false;
              let value;
              next[name] = function () {
                if (resolved) return value;
                const selector = getter();
                value = core.isConfigSelector(selector) ? function (...args) {
                    const config = Reflect.apply(selector, this, args);
                    const result = core.configForHover(config);
                    publishStatus(result && typeof result === "object" ? "ready" : "unavailable");
                    return result;
                  } : selector;
                // Export identity is important to the page's memoized selectors.
                resolved = true;
                return value;
              };
            }
            return Reflect.apply(target.d, target, [exportTarget, next]);
          };
        }
      });
      return Reflect.apply(factory, this, [module, exports, requireProxy]);
    };
    patchedFactories.add(wrapped);
    return wrapped;
  }

  function prepareChunk(chunk) {
    const factories = Array.isArray(chunk) && chunk[1];
    if (!factories || typeof factories !== "object") return;
    for (const [id, factory] of Object.entries(factories)) {
      factories[id] = wrapFactory(factory);
    }
  }

  function wrapPush(delegate) {
    return function (...chunks) {
      for (const chunk of chunks) prepareChunk(chunk);
      return Reflect.apply(delegate, this, chunks);
    };
  }

  try {
    const chunks = globalThis.__LOADABLE_LOADED_CHUNKS__ ||= [];
    if (!Array.isArray(chunks)) { publishStatus("unsupported"); return; }
    for (const chunk of chunks) prepareChunk(chunk);
    let push = wrapPush(chunks.push);
    // Webpack captures its old push when it installs the runtime. Each wrapper
    // keeps that captured delegate, so the runtime's parent push cannot recurse.
    Object.defineProperty(chunks, "push", {
      configurable: true,
      get: () => push,
      set: delegate => {
        if (typeof delegate !== "function") return;
        push = wrapPush(delegate);
        // main.js defines its initial modules in a private table, not in a
        // pushed chunk. Webpack exposes that table to chunk runtime callbacks.
        // Run before the main entry point so its config exports are not cached.
        try {
          push.call(chunks, [[`sc-live-hover-runtime-${++runtimeProbe}`], {}, nativeRequire => {
            if (nativeRequire?.m && typeof nativeRequire.m === "object") {
              prepareChunk([[], nativeRequire.m]);
            }
          }]);
        } catch {
          publishStatus("unsupported");
        }
      }
    });
    publishStatus("pending");
  } catch {
    publishStatus("unsupported");
  }
})();
