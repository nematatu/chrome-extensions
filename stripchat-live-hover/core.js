(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.StripchatLiveHoverCore = core;
})(globalThis, function () {
  "use strict";

  const CARD_SELECTOR = 'a[data-model-list-link="true"][data-model-id]';
  const VIDEO_SELECTOR = ".live-thumb video";
  const HOVER_DELAY = 400;
  const LOAD_TIMEOUT = 12000;
  const CONFIG_STATUS_ATTRIBUTE = "data-sc-live-hover-native";
  const modifiedConfigs = new WeakMap();

  function configForHover(config) {
    // Missing configuration is a native eligibility decision, not an opt-in.
    if (!config || typeof config !== "object" || Array.isArray(config)) return config;
    if (modifiedConfigs.has(config)) return modifiedConfigs.get(config);
    const next = { ...config, visibilityTimeout: HOVER_DELAY, duration: null };
    modifiedConfigs.set(config, next);
    return next;
  }

  function isConfigSelector(selector) {
    if (typeof selector !== "function") return false;
    const source = Function.prototype.toString.call(selector);
    return source.includes("featuresConfig") && source.includes(".features.liveThumbs");
  }

  function cardIdentity(link, baseUrl) {
    const id = link?.getAttribute("data-model-id");
    const href = link?.getAttribute("href");
    if (!/^[1-9]\d{0,15}$/.test(id || "") || !href || href.length > 2048) return null;
    // Validate the original spelling before URL normalizes traversal segments.
    if (!/^(?:https:\/\/ja\.stripchat\.com)?\/[a-zA-Z0-9_-]{1,100}$/.test(href)) return null;
    try {
      const url = new URL(href, baseUrl);
      if (url.origin !== "https://ja.stripchat.com" || url.username || url.password) return null;
      if (url.search || url.hash || !/^\/[a-zA-Z0-9_-]{1,100}$/.test(url.pathname)) return null;
      return `${id}:${url.pathname}`;
    } catch {
      return null;
    }
  }

  function pointInRect(point, rect) {
    return point && rect.width > 0 && rect.height > 0 &&
      point.x >= rect.left && point.x < rect.right &&
      point.y >= rect.top && point.y < rect.bottom;
  }

  return Object.freeze({
    CARD_SELECTOR, VIDEO_SELECTOR, HOVER_DELAY, LOAD_TIMEOUT,
    CONFIG_STATUS_ATTRIBUTE, configForHover, isConfigSelector, cardIdentity, pointInRect
  });
});
