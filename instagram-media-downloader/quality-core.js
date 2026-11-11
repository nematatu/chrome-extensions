(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.InstagramHighQualityCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function parseSrcset(srcset) {
    if (!srcset || typeof srcset !== "string") return [];

    return srcset
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const match = entry.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
        if (!match) return null;
        const value = match[2] ? Number(match[2]) : 1;
        return {
          url: match[1],
          width: match[3] === "w" ? value : 0,
          density: match[3] === "x" ? value : 0,
        };
      })
      .filter(Boolean);
  }

  function largestCandidate(srcsets, fallbackUrl) {
    const candidates = srcsets.flatMap(parseSrcset);
    if (!candidates.length) {
      return fallbackUrl ? { url: fallbackUrl, width: 0, density: 0 } : null;
    }

    return candidates.reduce((largest, candidate) => {
      const largestScore = largest.width || largest.density;
      const candidateScore = candidate.width || candidate.density;
      return candidateScore > largestScore ? candidate : largest;
    });
  }

  function isInstagramMediaUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        ["cdninstagram.com", "fbcdn.net"].some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      );
    } catch {
      return false;
    }
  }

  function isInstagramLivePath(pathname) {
    return /(?:^|\/)live(?:\/|$)/.test(String(pathname || ""));
  }

  function isPortraitVideo(width, height) {
    const videoWidth = Number(width);
    const videoHeight = Number(height);
    return videoWidth > 0 && videoHeight > 0 && videoHeight > videoWidth;
  }

  function isLiveStreamVideo(duration) {
    return duration === Infinity;
  }

  return {
    parseSrcset,
    largestCandidate,
    isInstagramMediaUrl,
    isInstagramLivePath,
    isPortraitVideo,
    isLiveStreamVideo,
  };
});
