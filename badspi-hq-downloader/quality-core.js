(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BadspiImageCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EXTENSIONS = "(?:jpe?g|png|gif|webp|avif)";
  const WORDPRESS_SIZE = new RegExp(`-\\d+x\\d+(?=\\.${EXTENSIONS}$)`, "i");

  function isBadspiUpload(url) {
    try {
      const parsed = new URL(url, "https://www.badspi.jp/");
      return (
        parsed.hostname === "www.badspi.jp" &&
        parsed.pathname.includes("/wp-content/uploads/") &&
        new RegExp(`\\.${EXTENSIONS}$`, "i").test(parsed.pathname)
      );
    } catch {
      return false;
    }
  }

  function originalUrl(url) {
    if (!isBadspiUpload(url)) return url || "";
    const parsed = new URL(url, "https://www.badspi.jp/");
    parsed.pathname = parsed.pathname.replace(WORDPRESS_SIZE, "");
    return parsed.href;
  }

  function parseSrcset(srcset) {
    if (!srcset || typeof srcset !== "string") return [];
    return srcset
      .split(",")
      .map((entry) => entry.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/))
      .filter(Boolean)
      .map((match) => match[1]);
  }

  function bestUrl(urls) {
    const valid = urls.filter(isBadspiUpload);
    if (!valid.length) return "";
    const alreadyOriginal = valid.find((url) => originalUrl(url) === url);
    return originalUrl(alreadyOriginal || valid[valid.length - 1]);
  }

  function filenameFromUrl(url) {
    try {
      return decodeURIComponent(new URL(originalUrl(url)).pathname.split("/").pop()) || "badspi-image";
    } catch {
      return "badspi-image";
    }
  }

  return { bestUrl, filenameFromUrl, isBadspiUpload, originalUrl, parseSrcset };
});
