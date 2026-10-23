(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PageMediaBulkCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const GENERIC_VIDEO_EXTENSIONS = new Set([
    "3g2",
    "3gp",
    "avi",
    "flv",
    "m2ts",
    "m4v",
    "mkv",
    "mov",
    "mp4",
    "mpe",
    "mpeg",
    "mpg",
    "mts",
    "ogv",
    "ts",
    "webm",
    "wmv",
  ]);
  const GENERIC_IMAGE_EXTENSIONS = new Set([
    "avif", "bmp", "gif", "heic", "heif", "ico", "jfif", "jpeg", "jpg",
    "png", "svg", "tif", "tiff", "webp",
  ]);
  const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
  const ACTIVE_STATUSES = new Set(["queued", "starting", "downloading"]);
  const FAILURE_STATUSES = new Set(["failed", "interrupted"]);
  const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function safeUrl(value) {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url : null;
    } catch { return null; }
  }

  function isSupportedPageUrl(value) {
    const url = safeUrl(value);
    return Boolean(url && ((url.origin === "https://video.twimg.news" && /^\/d\/\d+\/?$/.test(url.pathname))
      || getHostedPageInfo(value)));
  }

  function getHostedPageInfo(value) {
    const url = safeUrl(value);
    const domains = {
      "https://twfiles.com": "twfiles.com",
      "https://video.twimg1.com": "twimg1.com",
      "https://gofile.run": "gofile.run",
      "https://gofile.ing": "gofile.ing",
      "https://video.twimg-film.com": "twimg-film.com",
      "https://gofile.es": "gofile.es",
      "https://cdn4.file-photo.com": "file-photo.com",
      "https://gofile.guru": "gofile.guru",
      "https://cdn.twimg-image.com": "twimg-image.com",
      "https://gofile.pl": "gofile.pl",
      "https://video.twimg-com.com": "twimg-com.com",
    };
    if (!url || !Object.hasOwn(domains, url.origin)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length > 2 || segments.some(segment =>
      !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]{1,8})?$/.test(segment))) return null;
    if (["api.php", "app-api", "assets", "cdn-cgi", "favicon.ico", "index.html", "robots.txt"].includes(
      String(segments[0] || "").toLowerCase())) return null;
    const link = url.searchParams.get("link"), external = url.searchParams.get("externalLinks");
    if (url.searchParams.getAll("link").length > 1 || url.searchParams.getAll("externalLinks").length > 1
      || (link && external && link !== external)) return null;
    let shortLink = link || external || String(segments.at(-1) || "").replace(/\.[^.]+$/, "");
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(shortLink)) return null;
    // The site's URL parser removes the optional leading "a" from long share links.
    if (shortLink.length > 6 && shortLink.startsWith("a")) shortLink = shortLink.slice(1);
    return { shortLink, domain: domains[url.origin] };
  }

  function isAllowedDownloadUrl(value, pageUrl = "") {
    const url = safeUrl(value);
    if (!url || url.hash) return false;
    if (getHostedPageInfo(pageUrl)) {
      // Only the fixed site API supplies these URLs. Never fetch a page-supplied URL
      // in the worker, and exclude explicit local hosts, addresses and stream manifests.
      const host = url.hostname.toLowerCase();
      if (url.port || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63}$/.test(host)
        || /(?:^|\.)(localhost|local|internal|lan|home|arpa|example|invalid|test|onion)$/.test(host)) return false;
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { return false; }
      if (/[\u0000-\u001f\u007f\\]/.test(path) || path.split("/").some(part => part === "." || part === "..")) return false;
      const extension = path.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
      if (extension === "m3u8") return isHostedHlsUrl(value, pageUrl);
      return Boolean(extension && (GENERIC_VIDEO_EXTENSIONS.has(extension) || GENERIC_IMAGE_EXTENSIONS.has(extension)));
    }
    if (url.origin !== "https://cdn.videy.co" || url.search) return false;
    const match = url.pathname.match(/^\/([A-Za-z0-9]{8,32})\.([a-z0-9]{2,5})$/i);
    return Boolean(match && (GENERIC_VIDEO_EXTENSIONS.has(match[2].toLowerCase()) || GENERIC_IMAGE_EXTENSIONS.has(match[2].toLowerCase())));
  }

  function isHostedHlsUrl(value, pageUrl) {
    const url = safeUrl(value);
    if (!url || !getHostedPageInfo(pageUrl) || url.origin !== "https://vid.fun800.click" || url.hash) return false;
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return false; }
    return !/[\u0000-\u001f\u007f\\]/.test(path) && /\.m3u8$/i.test(path)
      && !path.split("/").some(part => part === "." || part === "..");
  }

  function isAllowedThumbnailUrl(value) {
    const url = safeUrl(value);
    return Boolean(url && isAllowedDownloadUrl(value) && GENERIC_IMAGE_EXTENSIONS.has(url.pathname.split(".").pop().toLowerCase()));
  }

  function isVideoItem(item) {
    if (!item || item.type !== "file") return false;
    const mime = typeof item.mimetype === "string" ? item.mimetype.trim().toLowerCase() : "";
    if (mime.startsWith("video/")) return true;
    if (!GENERIC_MIME_TYPES.has(mime)) return false;

    const name = typeof item.name === "string" ? item.name : "";
    const match = name.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return Boolean(match && GENERIC_VIDEO_EXTENSIONS.has(match[1]));
  }

  function isMediaItem(item) {
    if (isVideoItem(item)) return true;
    if (!item || item.type !== "file") return false;
    const mime = typeof item.mimetype === "string" ? item.mimetype.trim().toLowerCase() : "";
    if (mime.startsWith("image/")) return true;
    if (!GENERIC_MIME_TYPES.has(mime)) return false;
    const match = String(item.name || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return Boolean(match && GENERIC_IMAGE_EXTENSIONS.has(match[1]));
  }

  function utf8Length(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
    return unescape(encodeURIComponent(value)).length;
  }

  function truncateUtf8(value, maximumBytes) {
    if (utf8Length(value) <= maximumBytes) return value;
    let output = "";
    for (const character of value) {
      if (utf8Length(output + character) > maximumBytes) break;
      output += character;
    }
    return output;
  }

  function cleanPathText(value) {
    let output = typeof value === "string" ? value : String(value ?? "");
    try {
      output = output.normalize("NFC");
    } catch {
      // 古い実装でnormalizeできない文字列でも、残りの安全化は続行します。
    }

    return output
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[\\/<>:\"|?*]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
  }

  function sanitizePathSegment(value, fallback = "video", maximumBytes = 180) {
    const safeMaximum = clamp(Number(maximumBytes) || 180, 32, 220);
    let output = cleanPathText(value);
    let safeFallback = cleanPathText(fallback) || "video";

    if (!output || output === "." || output === "..") output = safeFallback;
    if (RESERVED_WINDOWS_NAMES.test(output)) output = `_${output}`;

    if (utf8Length(output) > safeMaximum) {
      const lastDot = output.lastIndexOf(".");
      const extension = lastDot > 0 ? output.slice(lastDot) : "";
      if (extension && utf8Length(extension) <= 24) {
        const base = truncateUtf8(output.slice(0, lastDot), safeMaximum - utf8Length(extension));
        output = `${base}${extension}`;
      } else {
        output = truncateUtf8(output, safeMaximum);
      }
      output = output.replace(/[. ]+$/g, "");
    }

    if (!output || output === "." || output === "..") output = truncateUtf8(safeFallback, safeMaximum);
    if (RESERVED_WINDOWS_NAMES.test(output)) output = `_${output}`;
    return output;
  }

  function buildDownloadPath(folderName, fileName, itemId) {
    const fallbackId = String(itemId || "file").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "file";
    const folder = sanitizePathSegment(folderName, "PageMedia", 80);
    const file = sanitizePathSegment(fileName, `video-${fallbackId}`, 180);
    return `PageMedia/${folder}/${file}`;
  }

  function isDownloadInFolder(actualFilename, requestedFilename) {
    if (typeof actualFilename !== "string" || typeof requestedFilename !== "string") return false;
    const windows = /^[a-z]:[\\/]/i.test(actualFilename) || actualFilename.startsWith("\\\\");
    if (!windows && !actualFilename.startsWith("/")) return false;
    const actual = actualFilename.replace(/\\/g, "/").normalize("NFC").split("/").filter(Boolean);
    const requested = requestedFilename.normalize("NFC").split("/");
    if (requested.length !== 3 || requested[0] !== "PageMedia" || !requested[1] || !requested[2]
      || actual.some(part => part === "." || part === "..") || actual.length < 3) return false;
    const normalize = value => windows ? value.toLowerCase() : value;
    return normalize(actual.at(-3)) === normalize(requested[0])
      && normalize(actual.at(-2)) === normalize(requested[1]);
  }

  function normalizeHostedFileReference(value, pageUrl) {
    const page = safeUrl(pageUrl);
    if (!page || !getHostedPageInfo(pageUrl) || !["https://gofile.es", "https://gofile.pl"].includes(page.origin)
      || !value || typeof value !== "object") return null;
    const { shortLink, id, name } = value;
    if (typeof shortLink !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(shortLink)
      || typeof id !== "string" || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)
      || typeof name !== "string" || !name.trim() || name.length > 512) return null;
    return { shortLink, id, name };
  }

  function normalizeVideos(input, maximumItems = 10000, pageUrl = "") {
    if (!Array.isArray(input)) return [];
    const maximum = clamp(Number(maximumItems) || 10000, 1, 10000);
    const output = [];
    const seenIds = new Set();
    const seenUrls = new Set();

    for (const candidate of input) {
      if (output.length >= maximum) break;
      if (!candidate || typeof candidate !== "object" || !isMediaItem(candidate)) continue;

      const id = typeof candidate.id === "string" ? candidate.id.slice(0, 160) : "";
      const url = typeof candidate.link === "string" ? candidate.link : "";
      if (!id || !isAllowedDownloadUrl(url, pageUrl) || seenIds.has(id)
        || (!getHostedPageInfo(pageUrl) && seenUrls.has(url))) continue;

      const rawSize = Number(candidate.size);
      const size = Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : 0;
      const thumbnail = isAllowedThumbnailUrl(candidate.thumbnail) ? candidate.thumbnail : null;
      const name = typeof candidate.name === "string" && candidate.name ? candidate.name.slice(0, 512) : `video-${id}`;
      const mimetype = typeof candidate.mimetype === "string" ? candidate.mimetype.slice(0, 200) : "";

      const hostedFile = normalizeHostedFileReference(candidate.hostedFile, pageUrl);
      output.push({ id, link: url, mimetype, name, size, thumbnail, ...(hostedFile ? {hostedFile} : {}) });
      seenIds.add(id);
      seenUrls.add(url);
    }

    return output;
  }

  function isActiveStatus(status) {
    return ACTIVE_STATUSES.has(status);
  }

  function isFailureStatus(status) {
    return FAILURE_STATUSES.has(status);
  }

  function itemProgress(item) {
    if (!item || typeof item !== "object") return 0;
    if (item.status === "complete") return 100;
    if (item.status !== "downloading") return 0;

    if (item.hls?.token) {
      if (item.downloadId == null) return clamp(Number(item.hls.percent) || 0, 0, 90);
      const total = Number(item.totalBytes);
      return clamp(90 + (total > 0 ? Math.floor((Math.max(0, Number(item.bytesReceived) || 0) / total) * 9) : 0), 90, 99);
    }

    const expected = Number(item.totalBytes) > 0 ? Number(item.totalBytes) : Number(item.size);
    if (!(expected > 0)) return 0;
    return clamp(Math.floor((Math.max(0, Number(item.bytesReceived) || 0) / expected) * 100), 0, 99);
  }

  function summarizeItems(items) {
    const safeItems = Array.isArray(items) ? items : [];
    const summary = {
      total: safeItems.length,
      completed: 0,
      downloading: 0,
      queued: 0,
      failed: 0,
      canceled: 0,
      percent: 0,
      bytesReceived: 0,
      totalBytes: 0,
    };

    for (const item of safeItems) {
      const status = item?.status;
      if (status === "complete") summary.completed += 1;
      else if (status === "downloading" || status === "starting") summary.downloading += 1;
      else if (status === "queued") summary.queued += 1;
      else if (isFailureStatus(status)) summary.failed += 1;
      else if (status === "canceled") summary.canceled += 1;

      const expected = Number(item?.totalBytes) > 0 ? Number(item.totalBytes) : Number(item?.size);
      const received = status === "complete" && expected > 0
        ? expected
        : Math.max(0, Number(item?.bytesReceived) || 0);
      if (expected > 0) {
        summary.totalBytes += expected;
        summary.bytesReceived += Math.min(received, expected);
      }
    }

    // Received bytes can belong to failed or unfinished downloads. Only files
    // confirmed as saved contribute to the batch's completion percentage.
    summary.percent = summary.total > 0
      ? Math.floor((summary.completed / summary.total) * 100)
      : 0;

    return summary;
  }

  function deriveBatchStatus(items) {
    const summary = summarizeItems(items);
    if (summary.total === 0) return "empty";
    if (summary.downloading > 0 || summary.queued > 0) return "active";
    if (summary.completed === summary.total) return "complete";
    if (summary.failed > 0 || summary.canceled > 0) return "completed_with_errors";
    return "complete";
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!(bytes > 0)) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / 1024 ** unitIndex;
    return `${amount >= 100 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
  }

  return Object.freeze({
    buildDownloadPath,
    isDownloadInFolder,
    deriveBatchStatus,
    formatBytes,
    getHostedPageInfo,
    isActiveStatus,
    isAllowedDownloadUrl,
    isHostedHlsUrl,
    isAllowedThumbnailUrl,
    isFailureStatus,
    isSupportedPageUrl,
    isMediaItem,
    isVideoItem,
    itemProgress,
    normalizeVideos,
    normalizeHostedFileReference,
    sanitizePathSegment,
    summarizeItems,
    truncateUtf8,
    utf8Length,
  });
});
