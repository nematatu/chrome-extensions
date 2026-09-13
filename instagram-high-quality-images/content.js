(function () {
  "use strict";

  const core = globalThis.InstagramHighQualityCore;
  const originals = new WeakMap();
  const upgraded = new WeakSet();
  const rotatedLiveVideos = new WeakSet();
  let enabled = true;
  let rotateLive = true;
  let upgradedCount = 0;
  let scanQueued = false;
  let clickedPostShortcode = null;

  function isPostImage(image) {
    if (!(image instanceof HTMLImageElement)) return false;
    if (image.closest("header, nav")) return false;
    if (!globalThis.InstagramDownloadCore.allowedMediaUrl(image.currentSrc || image.src)) {
      return false;
    }

    const rect = image.getBoundingClientRect();
    const largeEnough = rect.width >= 240 && rect.height >= 180;
    if (!largeEnough) return false;

    if (image.closest("article")) return true;
    if (image.closest('[role="dialog"]') && rect.width >= 320) return true;
    if (image.closest('a[href^="/p/"], a[href^="/reel/"]')) return true;

    const onPostPage = /^\/(?:p|reel)\/[^/]+\/?/.test(location.pathname);
    if (!onPostPage || !image.closest("main")) return false;

    // 投稿詳細ページでは、メイン画像がarticleや投稿リンクの外に置かれる場合がある。
    // 関連投稿のサムネイルリンクを除き、大きいメイン画像だけを対象にする。
    const relatedPostLink = image.closest('a[href*="/p/"], a[href*="/reel/"]');
    return !relatedPostLink && image.naturalWidth >= 900;
  }

  function availableSrcsets(image) {
    const srcsets = [image.getAttribute("srcset") || ""];
    const picture = image.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source[srcset]")) {
        srcsets.push(source.getAttribute("srcset") || "");
      }
    }
    return srcsets;
  }

  function postShortcode(image) {
    const routeMatch = location.pathname.match(/\/(?:p|reel)\/([^/?]+)/);
    if (routeMatch) return routeMatch[1];

    const container = image.closest('[role="dialog"]') || image.closest("article");
    const postLink = container?.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    return (
      postLink?.getAttribute("href")?.match(/\/(?:p|reel)\/([^/?]+)/)?.[1] ||
      clickedPostShortcode
    );
  }

  function imageMediaId(image) {
    try {
      const cacheKey = new URL(image.currentSrc || image.src).searchParams.get("ig_cache_key");
      if (!cacheKey) return null;
      return atob(cacheKey.split(".")[0]);
    } catch {
      return null;
    }
  }

  function upgrade(image) {
    if (!enabled || !isPostImage(image)) return;

    if (!originals.has(image)) {
      originals.set(image, {
        src: image.getAttribute("src"),
        srcset: image.getAttribute("srcset"),
        sizes: image.getAttribute("sizes"),
      });
    }

    const candidate = core.largestCandidate(
      availableSrcsets(image),
      image.currentSrc || image.src,
    );
    if (!candidate?.url) return;
    if (image.src !== candidate.url || image.hasAttribute("srcset")) {
      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
      image.src = candidate.url;
    }
    image.classList.add("instagram-hq-image");

    if (!upgraded.has(image)) {
      upgraded.add(image);
      upgradedCount += 1;
    }
  }

  function restore(image) {
    const original = originals.get(image);
    if (!original) return;
    for (const attribute of ["src", "srcset", "sizes"]) {
      const value = original[attribute];
      if (value === null) image.removeAttribute(attribute);
      else image.setAttribute(attribute, value);
    }
    image.classList.remove("instagram-hq-image");
  }

  function isPortraitVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    return core.isPortraitVideo(
      video.videoWidth || video.clientWidth,
      video.videoHeight || video.clientHeight,
    );
  }

  function mediaPageShortcode() {
    return location.pathname.match(/^\/(?:p|reel)\/([^/?]+)/)?.[1] || null;
  }

  function applyLiveVideoRotation(video) {
    video.classList.add("instagram-hq-live-video");
    rotatedLiveVideos.add(video);
  }

  function rotateLiveVideo(video) {
    const portrait = isPortraitVideo(video);
    const livePath = core.isInstagramLivePath(location.pathname);
    const liveStream = core.isLiveStreamVideo(video.duration);
    const isLiveArchive = false;

    if (rotateLive && portrait && (livePath || liveStream || isLiveArchive)) {
      applyLiveVideoRotation(video);
      return;
    }

    if ((!rotateLive || !portrait || (!livePath && !isLiveArchive)) && rotatedLiveVideos.has(video)) {
      video.classList.remove("instagram-hq-live-video");
      rotatedLiveVideos.delete(video);
    }
  }

  function scanLiveVideos() {
    for (const video of document.querySelectorAll("video")) {
      rotateLiveVideo(video);
    }
  }

  function scan() {
    scanQueued = false;
    for (const image of document.images) {
      if (enabled) upgrade(image);
      else restore(image);
    }
    scanLiveVideos();
  }

  function visibleArea(image) {
    const rect = image.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function activePostImage() {
    return Array.from(document.images)
      .filter(isPostImage)
      .map((image) => ({ image, area: visibleArea(image) }))
      .filter(({ area }) => area > 0)
      .sort((a, b) => b.area - a.area)[0]?.image || null;
  }

  globalThis.InstagramHQPage = {isPostImage, postShortcode, imageMediaId};

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.('a[href*="/p/"], a[href*="/reel/"]');
      const shortcode = link?.getAttribute("href")?.match(/\/(?:p|reel)\/([^/?]+)/)?.[1];
      if (shortcode) clickedPostShortcode = shortcode;
    },
    true,
  );

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  chrome.storage.sync.get({ enabled: true, rotateLive: true }, (settings) => {
    enabled = settings.enabled;
    rotateLive = settings.rotateLive !== false;
    queueScan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.enabled) enabled = changes.enabled.newValue;
    if (changes.rotateLive) rotateLive = changes.rotateLive.newValue !== false;
    if (!changes.enabled && !changes.rotateLive) return;
    queueScan();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "instagram-hq-status") {
      const image = activePostImage();
      sendResponse({
        enabled,
        upgradedCount,
        width: Number(image?.dataset.instagramHqWidth) || image?.naturalWidth || 0,
        height: Number(image?.dataset.instagramHqHeight) || image?.naturalHeight || 0,
      });
    }
  });

  const observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "sizes"],
  });

  document.addEventListener(
    "loadedmetadata",
    (event) => {
      if (event.target instanceof HTMLVideoElement) queueScan();
    },
    true,
  );
  document.addEventListener(
    "durationchange",
    (event) => {
      if (event.target instanceof HTMLVideoElement) queueScan();
    },
    true,
  );

  window.addEventListener("resize", queueScan, { passive: true });
  window.addEventListener("scroll", queueScan, { passive: true });
  queueScan();
})();
