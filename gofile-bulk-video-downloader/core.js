(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GofileBulkCore = api;
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
  const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
  const ACTIVE_STATUSES = new Set(["queued", "starting", "downloading"]);
  const FAILURE_STATUSES = new Set(["failed", "interrupted"]);
  const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function isGofilePageUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "gofile.io" &&
        url.port === "" &&
        /^\/d\/[^/]+\/?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function isTrustedGofileUrl(value, options = {}) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;

    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || url.username || url.password) return false;
      if (url.port !== "" && url.port !== "443") return false;
      if (hostname !== "gofile.io" && !hostname.endsWith(".gofile.io")) return false;
      if (options.download === true && !url.pathname.startsWith("/download/")) return false;
      return true;
    } catch {
      return false;
    }
  }

  function isAllowedDownloadUrl(value) {
    return isTrustedGofileUrl(value, { download: true });
  }

  function isAllowedThumbnailUrl(value) {
    return isTrustedGofileUrl(value);
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
    const folder = sanitizePathSegment(folderName, "Gofile", 80);
    const file = sanitizePathSegment(fileName, `video-${fallbackId}`, 180);
    return `Gofile/${folder}/${file}`;
  }

  function normalizeVideos(input, maximumItems = 10000) {
    if (!Array.isArray(input)) return [];
    const maximum = clamp(Number(maximumItems) || 10000, 1, 10000);
    const output = [];
    const seenIds = new Set();
    const seenUrls = new Set();

    for (const candidate of input) {
      if (output.length >= maximum) break;
      if (!candidate || typeof candidate !== "object" || !isVideoItem(candidate)) continue;

      const id = typeof candidate.id === "string" ? candidate.id.slice(0, 160) : "";
      const url = typeof candidate.link === "string" ? candidate.link : "";
      if (!id || !isAllowedDownloadUrl(url) || seenIds.has(id) || seenUrls.has(url)) continue;

      const rawSize = Number(candidate.size);
      const size = Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : 0;
      const thumbnail = isAllowedThumbnailUrl(candidate.thumbnail) ? candidate.thumbnail : null;
      const name = typeof candidate.name === "string" && candidate.name ? candidate.name.slice(0, 512) : `video-${id}`;
      const mimetype = typeof candidate.mimetype === "string" ? candidate.mimetype.slice(0, 200) : "";

      output.push({ id, link: url, mimetype, name, size, thumbnail });
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

    let everySizeKnown = safeItems.length > 0;
    let progressSum = 0;

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
      } else {
        everySizeKnown = false;
      }
      progressSum += itemProgress(item);
    }

    if (summary.total === 0) {
      summary.percent = 0;
    } else if (summary.completed === summary.total) {
      summary.percent = 100;
    } else if (everySizeKnown && summary.totalBytes > 0) {
      summary.percent = clamp(Math.floor((summary.bytesReceived / summary.totalBytes) * 100), 0, 99);
    } else {
      summary.percent = clamp(Math.floor(progressSum / summary.total), 0, 99);
    }

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
    deriveBatchStatus,
    formatBytes,
    isActiveStatus,
    isAllowedDownloadUrl,
    isAllowedThumbnailUrl,
    isFailureStatus,
    isGofilePageUrl,
    isVideoItem,
    itemProgress,
    normalizeVideos,
    sanitizePathSegment,
    summarizeItems,
    truncateUtf8,
    utf8Length,
  });
});
