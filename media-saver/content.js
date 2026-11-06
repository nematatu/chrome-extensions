"use strict";

(() => {
  if (globalThis.__mediaSaverContentLoaded) return;
  globalThis.__mediaSaverContentLoaded = true;

  const MAX_ITEMS = 300;
  const IMAGE_LIMIT = 220;

  function absolute(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, location.href);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
      url.hash = "";
      return url.href;
    } catch { return ""; }
  }

  function largestFromSrcset(value) {
    if (!value) return "";
    let best = "", bestScore = -1;
    for (const candidate of String(value).split(",")) {
      const [url, descriptor] = candidate.trim().split(/\s+/);
      if (!url) continue;
      const score = descriptor && descriptor.endsWith("w") ? Number(descriptor.slice(0, -1))
        : descriptor && descriptor.endsWith("x") ? Number(descriptor.slice(0, -1)) * 1000 : 1;
      if (Number.isFinite(score) && score > bestScore) { best = url; bestScore = score; }
    }
    return best;
  }

  function metaContent(names) {
    for (const name of names) {
      const element = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      if (element?.content) {
        const url = absolute(element.content);
        if (url) return url;
      }
    }
    return "";
  }

  function pageTitle() {
    const candidate = document.querySelector('meta[property="og:title"]')?.content || document.title || "";
    return String(candidate).replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function visible(element) {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  }

  function captureFrame(video) {
    try {
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return "";
      const width = 240, height = Math.max(1, Math.round(video.videoHeight / video.videoWidth * width));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.68);
    } catch { return ""; }
  }

  function scan() {
    const items = [], seen = new Set();
    let blobVideos = 0;
    const add = (url, item) => {
      if (!url || seen.has(url) || items.length >= MAX_ITEMS) return;
      seen.add(url);
      items.push({ url, source: "dom", ...item });
    };
    const title = pageTitle();

    for (const element of document.querySelectorAll("video")) {
      const source = absolute(element.currentSrc || element.src)
        || absolute(element.querySelector("source[src]")?.src);
      const poster = absolute(element.poster) || metaContent(["og:image", "twitter:image"]);
      if (!source) {
        if ((element.currentSrc || element.src || "").startsWith("blob:")) blobVideos++;
        continue;
      }
      add(source, {
        kind: "video", title: element.title || element.getAttribute("aria-label") || "",
        poster, duration: Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0,
        width: element.videoWidth || element.clientWidth || 0, height: element.videoHeight || element.clientHeight || 0,
        frame: visible(element) ? captureFrame(element) : ""
      });
    }

    for (const element of document.querySelectorAll("audio")) {
      const source = absolute(element.currentSrc || element.src)
        || absolute(element.querySelector("source[src]")?.src);
      if (!source) continue;
      add(source, {
        kind: "audio", title: element.title || element.getAttribute("aria-label") || "",
        duration: Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0
      });
    }

    for (const name of ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"]) {
      const source = metaContent([name]);
      if (source) add(source, { kind: "video", title, poster: metaContent(["og:image", "twitter:image"]) });
    }

    const ogImage = metaContent(["og:image", "og:image:secure_url", "twitter:image"]);
    if (ogImage) add(ogImage, { kind: "image", title, poster: ogImage });

    let images = 0;
    for (const element of document.querySelectorAll("img")) {
      if (images >= IMAGE_LIMIT) break;
      const source = absolute(element.currentSrc || element.src) || absolute(largestFromSrcset(element.srcset));
      if (!source || /\.svg$/i.test(new URL(source).pathname)) continue;
      const naturalWidth = element.naturalWidth || 0, naturalHeight = element.naturalHeight || 0;
      const width = Math.max(naturalWidth, element.clientWidth || 0), height = Math.max(naturalHeight, element.clientHeight || 0);
      if (width && height && (width < 96 || height < 96)) continue;
      if (!visible(element) && !naturalWidth) continue;
      if (/\b(pixel|spacer|tracking|transparent)\b/i.test(new URL(source).pathname)) continue;
      add(source, { kind: "image", title: element.alt || element.title || "", poster: source,
        width: naturalWidth || width, height: naturalHeight || height });
      images++;
    }

    for (const element of document.querySelectorAll('a[href]')) {
      if (images >= IMAGE_LIMIT) break;
      const source = absolute(element.href);
      if (!source || !/\.(jpe?g|png|webp|gif|avif|bmp)(?:$|\?)/i.test(source)) continue;
      if (element.querySelector("img")) continue;
      add(source, { kind: "image", title: element.getAttribute("title") || "", poster: source });
      images++;
    }

    return { ok: true, pageUrl: location.href, pageTitle: title, items, blobVideos };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "ms:scan" || sender?.id !== chrome.runtime.id) return undefined;
    try { sendResponse(scan()); } catch { sendResponse({ ok: false, error: "SCAN_FAILED" }); }
    return undefined;
  });
})();
