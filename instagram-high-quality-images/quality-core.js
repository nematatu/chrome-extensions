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

  function safeFilenamePart(value, fallback) {
    const safe = String(value || "")
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^[_\.]+|[_\.]+$/g, "")
      .slice(0, 60);
    return safe || fallback;
  }

  function buildFilename({ username, shortcode, index = 1 }) {
    const user = safeFilenamePart(username, "post");
    const post = safeFilenamePart(shortcode, "image");
    const number = String(Math.max(1, Number(index) || 1)).padStart(2, "0");
    return `instagram_${user}_${post}_${number}.jpg`;
  }

  function shortcodeToMediaId(shortcode) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mediaId = 0n;
    for (const character of String(shortcode || "")) {
      const value = alphabet.indexOf(character);
      if (value < 0) return null;
      mediaId = mediaId * 64n + BigInt(value);
    }
    return shortcode ? mediaId.toString() : null;
  }

  function highestMediaCandidate(data, mediaId, index = 1) {
    const post = data?.items?.[0];
    if (!post) return null;
    const items = post.carousel_media?.length ? post.carousel_media : [post];
    const selected =
      items.find((item) => String(item.pk) === String(mediaId || "")) ||
      items[Math.max(0, Number(index || 1) - 1)] ||
      items[0];
    const candidates = (selected?.image_versions2?.candidates || []).filter(
      (candidate) => candidate?.url && candidate.width > 0 && candidate.height > 0,
    );
    const originalWidth = Number(selected?.original_width);
    const originalHeight = Number(selected?.original_height);
    const originalAspect = originalWidth > 0 && originalHeight > 0 ? originalWidth / originalHeight : 0;
    const matchingAspect = originalAspect
      ? candidates.filter((candidate) => {
          const candidateAspect = candidate.width / candidate.height;
          return Math.abs(candidateAspect - originalAspect) / originalAspect <= 0.01;
        })
      : [];
    const closestAspect =
      originalAspect && !matchingAspect.length
        ? candidates.reduce((closest, candidate) => {
            if (!closest) return candidate;
            const difference = Math.abs(candidate.width / candidate.height - originalAspect);
            const closestDifference = Math.abs(closest.width / closest.height - originalAspect);
            return difference < closestDifference ? candidate : closest;
          }, null)
        : null;
    const eligible = matchingAspect.length ? matchingAspect : closestAspect ? [closestAspect] : candidates;
    return eligible.reduce((best, candidate) => {
      if (!candidate?.url) return best;
      if (!best) return candidate;
      return candidate.width * candidate.height > best.width * best.height ? candidate : best;
    }, null);
  }

  return {
    parseSrcset,
    largestCandidate,
    buildFilename,
    shortcodeToMediaId,
    highestMediaCandidate,
  };
});
