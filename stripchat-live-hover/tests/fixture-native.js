/* A native-player adapter for browser QA. Production code is loaded unchanged. */
(() => {
  // Match the real main bundle: the feature module is already in require.m.
  const factories = { features: function (module, exports, req) {
    const config = ({ featuresConfig: state }) => state.features.liveThumbs;
    const permitted = card => !card.closest('[data-unavailable="true"]');
    req.d(exports, { config: () => config, permitted: () => permitted });
  } };
  const cache = {};
  function require(id) {
    if (!cache[id]) {
      const module = { exports: {} };
      cache[id] = module;
      factories[id](module, module.exports, require);
    }
    return cache[id].exports;
  }
  require.d = (exports, getters) => {
    for (const name of Object.keys(getters)) Object.defineProperty(exports, name, { get: getters[name] });
  };
  require.m = factories;
  const chunks = window.__LOADABLE_LOADED_CHUNKS__;
  const parentPush = chunks.push.bind(chunks);
  chunks.push = function (chunk) {
    Object.assign(factories, chunk[1]);
    if (typeof chunk[2] === "function") chunk[2](require);
    return parentPush(chunk);
  };
  const features = require("features");
  const state = { featuresConfig: { features: { liveThumbs: { visibilityTimeout: 20, duration: 500 } } } };
  let active = null;
  let delay;
  let duration;
  let generation = 0;
  let lateDelay = 0;
  function stop() {
    generation++;
    clearTimeout(delay);
    clearTimeout(duration);
    active?.querySelector("video")?.pause();
    active?.querySelector(".live-thumb")?.remove();
    active = null;
  }
  function play(card) {
    if (active === card) return;
    stop();
    if (!features.permitted(card)) return;
    active = card;
    const config = features.config(state);
    const id = generation;
    delay = setTimeout(() => {
      if (id !== generation || active !== card || !card.isConnected) return;
      const wrapper = document.createElement("div");
      wrapper.className = "live-thumb";
      const video = document.createElement("video");
      video.src = "./demo.mp4";
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      wrapper.append(video);
      card.append(wrapper);
      video.play().catch(() => {});
      if (config.duration !== null) duration = setTimeout(stop, config.duration);
    }, config.visibilityTimeout + lateDelay);
    lateDelay = 0;
  }
  document.addEventListener("mouseover", event => {
    const card = event.target.closest?.('a[data-model-list-link="true"]');
    if (card) play(card);
  });
  document.addEventListener("mouseout", event => {
    if (active && !active.contains(event.relatedTarget)) stop();
  });
  window.fixtureNative = {
    config: features.config(state),
    setLateDelay(ms) { lateDelay = ms; },
    isActive: () => Boolean(active)
  };
})();
