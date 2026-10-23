(() => {
  "use strict";
  const core = globalThis.StripchatLiveHoverCore;
  if (!core) return;
  let active = null;
  let suppressedLink = null;
  let pointer = null;

  function findLink(target) {
    if (!(target instanceof Element)) return null;
    const link = target.closest(core.CARD_SELECTOR) ||
      target.closest('[data-model-list-root="item"]')?.querySelector(core.CARD_SELECTOR);
    return link && core.cardIdentity(link, location.href) ? link : null;
  }

  function pointerInside(link) {
    return link?.isConnected && core.pointInRect(pointer, link.parentElement.getBoundingClientRect());
  }

  function updateSuppression() {
    // Removing the video under a stationary cursor can emit pointerout with a
    // null relatedTarget. Only a real move beyond the card ends Esc suppression.
    if (suppressedLink && !pointerInside(suppressedLink)) suppressedLink = null;
  }

  function setState(session, state) {
    if (active !== session) return;
    session.state = state;
    const labels = {
      loading: "読み込み中…",
      playing: "LIVE · 無音",
      waiting: "再接続中…",
      error: "プレビューできません"
    };
    session.badge.textContent = labels[state];
    session.badge.dataset.state = state;
  }

  function stop({ notifyNative = false, suppress = false } = {}) {
    const session = active;
    if (!session) return;
    active = null;
    if (suppress) suppressedLink = session.link;
    clearTimeout(session.delay);
    clearInterval(session.check);
    session.observer.disconnect();
    session.detachVideo?.();
    session.badge.remove();
    session.link.classList.remove("sc-live-hover-target");
    // The page owns its shared player and source. Let its unmount stop transport.
    if (notifyNative && session.link.isConnected) {
      session.link.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    }
    session.video?.pause();
  }

  function attachVideo(session) {
    if (active !== session || session.failed || !session.link.isConnected) return;
    if (!session.badge.isConnected) session.link.append(session.badge);
    const video = session.link.querySelector(core.VIDEO_SELECTOR);
    if (!video || video === session.video) return;
    session.detachVideo?.();
    session.video = video;
    video.muted = true;
    const playing = () => {
      if (active !== session || session.failed || video.readyState < 2 || video.paused) return;
      session.lastProgress = performance.now();
      session.hasPlayed = true;
      setState(session, "playing");
    };
    const waiting = () => setState(session, session.hasPlayed ? "waiting" : "loading");
    const error = () => fail(session);
    const listeners = { playing, timeupdate: playing, waiting, stalled: waiting, error };
    for (const [event, listener] of Object.entries(listeners)) video.addEventListener(event, listener);
    session.detachVideo = () => {
      for (const [event, listener] of Object.entries(listeners)) video.removeEventListener(event, listener);
    };
    playing();
  }

  function fail(session) {
    if (active !== session || session.failed) return;
    session.failed = true;
    suppressedLink = session.link;
    setState(session, "error");
    session.detachVideo?.();
    session.video?.pause();
    session.link.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  }

  function start(link) {
    stop();
    const badge = document.createElement("span");
    badge.className = "sc-live-hover-badge";
    badge.setAttribute("aria-live", "polite");
    badge.setAttribute("role", "status");
    badge.hidden = true;
    const session = {
      link, badge, surface: link.parentElement, identity: core.cardIdentity(link, location.href),
      lastProgress: performance.now(),
      hasPlayed: false, failed: false, video: null,
      observer: new MutationObserver(() => attachVideo(session))
    };
    active = session;
    link.classList.add("sc-live-hover-target");
    link.append(badge);
    setState(session, "loading");
    session.observer.observe(link, { childList: true, subtree: true });
    attachVideo(session);
    session.delay = setTimeout(() => {
      if (active === session) badge.hidden = false;
    }, core.HOVER_DELAY);
    session.check = setInterval(() => {
      if (!link.isConnected || core.cardIdentity(link, location.href) !== session.identity ||
          document.hidden || !core.pointInRect(pointer, session.surface.getBoundingClientRect())) {
        stop({ notifyNative: true });
        return;
      }
      attachVideo(session);
      const now = performance.now();
      if (!session.failed && now - session.lastProgress > core.LOAD_TIMEOUT) {
        fail(session);
      }
    }, 250);
  }

  document.addEventListener("pointerover", event => {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    updateSuppression();
    const link = findLink(event.target);
    if (!link || !pointerInside(link) || link === suppressedLink || active?.link === link) return;
    start(link);
  }, true);

  document.addEventListener("pointermove", event => {
    if (event.pointerType !== "touch") {
      pointer = { x: event.clientX, y: event.clientY };
      updateSuppression();
    }
  }, { passive: true });

  document.addEventListener("pointerout", event => {
    const nextLink = findLink(event.relatedTarget);
    updateSuppression();
    if (active && nextLink !== active.link) stop({ notifyNative: true });
  }, true);

  // The site also listens for mouseover. Prevent its player from restarting
  // when the unmounted video reveals the same card beneath the cursor.
  document.addEventListener("mouseover", event => {
    if (suppressedLink && pointerInside(suppressedLink) && findLink(event.target) === suppressedLink) {
      event.stopPropagation();
    }
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") stop({ notifyNative: true, suppress: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop({ notifyNative: true });
  });
  window.addEventListener("blur", () => stop({ notifyNative: true }));
  window.addEventListener("pagehide", () => stop());
  window.addEventListener("popstate", () => stop({ notifyNative: true }));
})();
