(function initSushidaParser(global) {
  const COURSE_RE = /^\s*(.+?コース)【(.+?)】\s*$/m;
  const RESULT_RE =
    /[★☆]\s*([0-9,]+)円分\s*(お得|損)\s*でした！(?:（|\()\s*速度：([0-9.]+)key\/秒、ミス：([0-9,]+)key\s*(?:）|\))/;

  function normalizeText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  function extractTweetTextFromUrl(rawUrl) {
    let url;
    try {
      const base = typeof location === "undefined" ? "https://sushida.net/" : location.href;
      url = new URL(rawUrl, base);
    } catch (_error) {
      return null;
    }

    const host = url.hostname.replace(/^www\./, "");
    if (!["twitter.com", "x.com"].includes(host)) return null;
    if (!url.pathname.includes("/intent/tweet")) return null;

    return url.searchParams.get("text") || null;
  }

  function parseSushidaShareText(text) {
    const normalized = normalizeText(text);
    const courseMatch = normalized.match(COURSE_RE);
    const resultMatch = normalized.match(RESULT_RE);

    if (!courseMatch || !resultMatch || !normalized.includes("sushida.net")) {
      return null;
    }

    const amount = Number(resultMatch[1].replace(/,/g, ""));
    const missedKeys = Number(resultMatch[4].replace(/,/g, ""));
    const speed = Number(resultMatch[3]);

    if (!Number.isFinite(amount) || !Number.isFinite(missedKeys) || !Number.isFinite(speed)) {
      return null;
    }

    return {
      id: createResultId(normalized),
      savedAt: new Date().toISOString(),
      course: courseMatch[1],
      difficulty: courseMatch[2],
      amountYen: amount,
      resultType: resultMatch[2] === "お得" ? "profit" : "loss",
      speedKeyPerSec: speed,
      missedKeys,
      shareText: normalized
    };
  }

  function createResultId(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `sushida-${(hash >>> 0).toString(16)}`;
  }

  global.SushidaLogParser = {
    extractTweetTextFromUrl,
    parseSushidaShareText
  };

  if (typeof module !== "undefined") {
    module.exports = global.SushidaLogParser;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
