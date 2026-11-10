/* Shared helpers for the Media Saver extension and its tests. */
(function (root) {
  "use strict";

  const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "mkv", "avi", "wmv", "flv", "ogv", "3gp", "mpeg", "mpg", "ts"]);
  const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba", "mka"]);
  const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"]);
  const SEGMENT_EXTENSIONS = new Set(["m4s", "cmfv", "cmfa", "ism", "init", "key"]);
  const MIME_EXTENSIONS = {
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv",
    "video/ogg": "ogv", "video/mpeg": "mpg", "video/3gpp": "3gp", "video/x-msvideo": "avi",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
    "audio/ogg": "ogg", "audio/opus": "opus", "audio/wav": "wav", "audio/x-wav": "wav",
    "audio/flac": "flac", "audio/webm": "weba",
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp"
  };
  const DEFAULT_SETTINGS = Object.freeze({
    folder: "MediaSaver",
    subfolder: true,
    filenameTemplate: "{title}",
    concurrency: 3,
    minSizeMB: 0,
    detectVideo: true,
    detectAudio: true,
    detectImages: true,
    blacklist: [],
    theme: "auto"
  });

  function isHttpUrl(value) {
    if (typeof value !== "string" || !value || value.length > 16384) return false;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch { return false; }
  }

  function extensionOf(value) {
    try {
      const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(value).pathname);
      return match ? match[1].toLowerCase() : "";
    } catch { return ""; }
  }

  function extensionForMime(value) {
    const mime = String(value || "").toLowerCase().split(";")[0].trim();
    return MIME_EXTENSIONS[mime] || "";
  }

  function classify(value, contentType) {
    if (!isHttpUrl(value)) return null;
    const mime = String(contentType || "").toLowerCase().split(";")[0].trim();
    const ext = extensionOf(value);
    if (ext === "m3u8" || mime.includes("mpegurl") || mime === "application/x-mpegurl") {
      return { kind: "hls", ext: "mp4", contentType: mime || "application/vnd.apple.mpegurl" };
    }
    if (ext === "mpd" || mime === "application/dash+xml") {
      return { kind: "dash", ext: "mp4", contentType: mime || "application/dash+xml" };
    }
    if (SEGMENT_EXTENSIONS.has(ext) || mime === "video/mp2t") return null;
    if (mime.startsWith("video/")) return { kind: "video", ext: extensionForMime(mime) || ext || "mp4", contentType: mime };
    if (mime.startsWith("audio/")) return { kind: "audio", ext: extensionForMime(mime) || ext || "m4a", contentType: mime };
    if (mime.startsWith("image/")) {
      const imageExt = extensionForMime(mime);
      return imageExt ? { kind: "image", ext: imageExt, contentType: mime } : null;
    }
    if (VIDEO_EXTENSIONS.has(ext) && ext !== "ts") return { kind: "video", ext, contentType: mime || null };
    if (AUDIO_EXTENSIONS.has(ext)) return { kind: "audio", ext, contentType: mime || null };
    if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image", ext, contentType: mime || null };
    return null;
  }

  function hostOf(value) {
    try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
  }

  function isBlacklisted(value, blacklist) {
    const host = hostOf(value);
    if (!host || !Array.isArray(blacklist)) return false;
    return blacklist.some(entry => {
      const domain = String(entry || "").trim().toLowerCase().replace(/^\.+/, "");
      return domain && (host === domain || host.endsWith("." + domain));
    });
  }

  function sanitizeSegment(value, fallback) {
    let text = String(value == null ? "" : value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .replace(/^_+|_+$/g, "");
    if (!text) text = sanitizeSegment(fallback || "media", "media");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) text = "_" + text;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 140) {
      let output = "", count = 0;
      for (const character of text) {
        const size = new TextEncoder().encode(character).length;
        if (count + size > 140) break;
        output += character; count += size;
      }
      text = output.replace(/[.\s]+$/g, "") || sanitizeSegment(fallback || "media", "media");
    }
    return text;
  }

  function dateStamp(date) {
    const value = date instanceof Date ? date : new Date();
    const pad = number => String(number).padStart(2, "0");
    return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}`;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "サイズ不明";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes / 1024, index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
  }

  function formatDuration(value) {
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${minutes}:${String(rest).padStart(2, "0")}`;
  }

  function formatBitrate(value) {
    const bits = Number(value);
    if (!Number.isFinite(bits) || bits <= 0) return "";
    return bits >= 1000000 ? `${(bits / 1000000).toFixed(1)} Mbps` : `${Math.round(bits / 1000)} kbps`;
  }

  function basenameFromUrl(value) {
    try {
      const name = decodeURIComponent(new URL(value).pathname.split("/").filter(Boolean).pop() || "");
      return name || "media";
    } catch { return "media"; }
  }

  function titleFromUrl(value) {
    const name = basenameFromUrl(value).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim();
    return name || "media";
  }

  function parseContentDisposition(value) {
    if (typeof value !== "string" || !value) return "";
    const extended = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(value);
    if (extended) {
      try { return decodeURIComponent(extended[2].trim().replace(/^"|"$/g, "")); } catch { return ""; }
    }
    const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(value);
    return plain ? (plain[2] != null ? plain[2] : plain[3]).trim() : "";
  }

  function buildFilename(settings, tokens, extension) {
    const options = normalizeSettings(settings);
    const values = tokens || {};
    let template = String(options.filenameTemplate || "{title}");
    const titleValue = String(values.title == null ? "" : values.title)
      .replace(/\.(mp4|webm|mov|mkv|mp3|m4a|aac|ogg|wav|flac|jpg|jpeg|png|webp|gif|ts)$/i, "");
    const replacements = {
      title: titleValue, site: values.site, date: dateStamp(), quality: values.quality,
      index: values.index == null ? "" : String(values.index), host: values.site
    };
    template = template.replace(/\{(title|site|date|quality|index|host)\}/gi, (_, key) => {
      const value = replacements[key.toLowerCase()];
      return value == null ? "" : String(value);
    });
    template = template.replace(/\.(mp4|webm|mov|mkv|mp3|m4a|aac|ogg|wav|flac|jpg|jpeg|png|webp|gif|ts)$/i, "");
    const name = sanitizeSegment(template, titleValue || "media");
    let ext = sanitizeSegment(extension || "mp4", "mp4").replace(/^\.+/, "").toLowerCase();
    if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = "bin";
    const folder = String(options.folder || "MediaSaver").split("/").filter(Boolean)
      .map(part => sanitizeSegment(part, "MediaSaver")).join("/");
    const pieces = [folder || "MediaSaver"];
    if (options.subfolder && values.site) pieces.push(sanitizeSegment(values.site, "site"));
    return `${pieces.join("/")}/${name}.${ext}`;
  }

  function normalizeSettings(value) {
    const input = value && typeof value === "object" ? value : {};
    const number = (candidate, fallback, min, max) => {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
    };
    const blacklist = Array.isArray(input.blacklist) ? input.blacklist.map(entry => {
      return String(entry || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/^\.+/, "");
    }).filter(entry => entry && entry.length <= 253 && /^[a-z0-9.-]+$/.test(entry)) : [];
    return {
      folder: typeof input.folder === "string" && input.folder.trim() ? input.folder.trim().slice(0, 200) : DEFAULT_SETTINGS.folder,
      subfolder: typeof input.subfolder === "boolean" ? input.subfolder : DEFAULT_SETTINGS.subfolder,
      filenameTemplate: typeof input.filenameTemplate === "string" && input.filenameTemplate.trim()
        ? input.filenameTemplate.trim().slice(0, 160) : DEFAULT_SETTINGS.filenameTemplate,
      concurrency: number(input.concurrency, DEFAULT_SETTINGS.concurrency, 1, 6),
      minSizeMB: number(input.minSizeMB, DEFAULT_SETTINGS.minSizeMB, 0, 100000),
      detectVideo: typeof input.detectVideo === "boolean" ? input.detectVideo : true,
      detectAudio: typeof input.detectAudio === "boolean" ? input.detectAudio : true,
      detectImages: typeof input.detectImages === "boolean" ? input.detectImages : true,
      blacklist: [...new Set(blacklist)].slice(0, 500),
      theme: ["auto", "light", "dark"].includes(input.theme) ? input.theme : "auto"
    };
  }

  function shortId(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function isPrivateHost(value) {
    let host = hostOf(value);
    if (!host) return false;
    host = host.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const parts = host.split(".").map(Number);
      if (parts.some(part => part > 255)) return false;
      return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
        || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168)
        || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
        || parts[0] >= 224;
    }
    if (!host.includes(":")) return false;
    if (host === "::" || host === "::1") return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
    if (mapped) return isPrivateHost(`http://${mapped[1]}/`);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mappedHex) {
      const value = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16);
      return isPrivateHost(`http://${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}/`);
    }
    if (/^f[cd][0-9a-f]{0,2}:/i.test(host) || /^fe[89ab][0-9a-f]?:/i.test(host)) return true;
    return false;
  }

  function isSafeTarget(target, pageUrl) {
    if (!isHttpUrl(target)) return false;
    if (!isPrivateHost(target)) return true;
    return isPrivateHost(pageUrl) || hostOf(target) === hostOf(pageUrl);
  }

  // Every request a job makes, including URLs read from manifests, faces the same check as the media URL.
  // fetch follows redirects without exposing them, so the final URL is checked before the body is read.
  function guardFetch(request, pageUrl) {
    return async (url, init) => {
      if (!isSafeTarget(url, pageUrl)) throw new Error("UNSAFE_TARGET");
      const response = await request(url, init);
      if (response.url && !isSafeTarget(response.url, pageUrl)) {
        try { await response.body?.cancel(); } catch {}
        throw new Error("UNSAFE_TARGET");
      }
      return response;
    };
  }

  function idFor(value) {
    return `${shortId(value)}-${String(value).length.toString(36)}`;
  }

  const api = {
    DEFAULT_SETTINGS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS,
    classify, extensionOf, extensionForMime, hostOf, isBlacklisted, sanitizeSegment,
    dateStamp, formatBytes, formatDuration, formatBitrate, basenameFromUrl, titleFromUrl,
    parseContentDisposition, buildFilename, normalizeSettings, shortId, isHttpUrl,
    isPrivateHost, isSafeTarget, guardFetch, idFor
  };
  root.MediaSaverCommon = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
