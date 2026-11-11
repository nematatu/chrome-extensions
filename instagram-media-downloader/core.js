(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IGMediaCore = api;
})(globalThis, function () {
  "use strict";
  const MAX_BATCH = 500;
  function mediaURL(value) {
    if (typeof value !== "string" || value.length > 8192) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      if (!/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  }
  function identity(value) {
    const url = mediaURL(value);
    return url ? new URL(url).pathname : "";
  }
  function best(candidates) {
    return (Array.isArray(candidates) ? candidates : []).filter(c => mediaURL(c?.url || c?.src))
      .sort((a, b) => (Number(b.width) || 0) * (Number(b.height) || 1) - (Number(a.width) || 0) * (Number(a.height) || 1))[0];
  }
  function item(node, index = 0) {
    const video = best(node.video_versions) || (node.video_url ? { url: node.video_url } : null);
    const photo = best(node.image_versions2?.candidates) || best(node.display_resources) ||
      (node.display_url ? { url: node.display_url } : null);
    const isVideo = node.media_type === 2 || node.is_video === true || !!video;
    const url = mediaURL((isVideo ? video : photo)?.url || (!isVideo ? photo?.src : ""));
    if (!url) return null;
    return { id: String(node.pk || node.id || ""), kind: isVideo ? "video" : "image", url,
      preview: mediaURL(photo?.url || photo?.src), index };
  }
  function groups(data) {
    const result = new Map();
    const stack = [data];
    const seen = new Set();
    let count = 0;
    while (stack.length && count++ < 30000) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const id = node.pk || node.id;
      const children = node.carousel_media || node.edge_sidecar_to_children?.edges?.map(e => e.node);
      const hasMedia = children || node.image_versions2 || node.display_url || node.video_versions || node.video_url;
      if (id && hasMedia) {
        const media = (Array.isArray(children) ? children : [node]).map(item).filter(Boolean);
        if (media.length) {
          const group = { id: String(id).split("_")[0], code: String(node.code || node.shortcode || ""),
            username: String(node.user?.username || node.owner?.username || "instagram"),
            ownerId: String(node.user?.pk || node.user?.id || node.owner?.id || ""), media,
            complete: (!children || media.length === children.length) &&
              !((node.carousel_media_count || node.edge_sidecar_to_children?.count) > media.length) &&
              node.edge_sidecar_to_children?.page_info?.has_next_page !== true };
          result.set(group.code || group.id, group);
        }
        for (const [key, value] of Object.entries(node)) {
          if (key !== "carousel_media" && key !== "edge_sidecar_to_children" && value && typeof value === "object") stack.push(value);
        }
      } else {
        for (const value of Object.values(node)) if (value && typeof value === "object") stack.push(value);
      }
    }
    return [...result.values()];
  }
  function shortcodeID(code) {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) throw new Error("投稿IDが不正です。");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const ch of code) id = id * 64n + BigInt(alphabet.indexOf(ch));
    return String(id);
  }
  function safePart(value) {
    return String(value || "instagram").normalize("NFKC").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "instagram";
  }
  function filename(group, media) {
    let extension = media.kind === "video" ? "mp4" : "jpg";
    if (media.kind === "image") {
      const match = new URL(media.url).pathname.match(/\.(jpe?g|png|webp|avif)$/i);
      if (match) extension = match[1].toLowerCase().replace("jpeg", "jpg");
    }
    return `Instagram/${safePart(group.username)}/${safePart(group.code || group.id)}_${String(media.index + 1).padStart(2, "0")}.${extension}`;
  }
  function numericID(value) {
    const id = String(value || "").split("_")[0];
    return /^\d{1,30}$/.test(id) ? id : null;
  }
  function groupKey(group) {
    const id = numericID(group?.id);
    return id ? `g:${id}` : null;
  }
  function mediaKey(group, media) {
    const parent = numericID(group?.id), id = numericID(media?.id);
    return parent && id && ["image", "video"].includes(media?.kind) ? `m:${parent}:${id}:${media.kind}` : null;
  }
  async function digest(value) {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  async function postHistoryKey(code) {
    return typeof code === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(code) ? `p:${await digest(code)}` : null;
  }
  async function filenameHistoryKey(value) { return `f:${await digest(value)}`; }
  async function urlHistoryKey(value, kind) {
    const path = identity(value);
    return path && ["image", "video"].includes(kind) ? `u:${await digest(`${kind}:${path}`)}` : null;
  }
  async function historyKeys(group, media) {
    const keys = await Promise.all([mediaKey(group, media), filenameHistoryKey(filename(group, media)),
      urlHistoryKey(media.url, media.kind), urlHistoryKey(media.preview, media.kind)]);
    return [...new Set(keys.filter(Boolean))];
  }
  function validHistoryKey(value) {
    return typeof value === "string" && /^(?:m:\d{1,30}:\d{1,30}:(?:image|video)|g:\d{1,30}|[fup]:[a-f0-9]{64})$/.test(value);
  }
  function validateHistory(records) {
    if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("保存履歴の形式が不正です。");
    const prototype = Object.getPrototypeOf(records);
    if (prototype !== null && (Object.getPrototypeOf(prototype) !== null ||
        !Object.hasOwn(prototype, "constructor") || Function.prototype.toString.call(prototype.constructor) !== Function.prototype.toString.call(Object))) {
      throw new Error("保存履歴の形式が不正です。");
    }
    const entries = Object.entries(records), latest = Date.now() + 24 * 60 * 60 * 1000;
    if (entries.some(([key, time]) => !validHistoryKey(key) ||
        !Number.isFinite(time) || time <= 0 || time > latest)) throw new Error("保存履歴の内容が不正です。");
    return Object.fromEntries(entries);
  }
  function validateItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > MAX_BATCH) throw new Error("保存件数は1〜500件です。");
    return items.map(value => {
      const url = mediaURL(value?.url);
      if (!url || typeof value.filename !== "string" || value.filename.length > 240 ||
          !/^Instagram\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.(jpg|png|webp|avif|mp4)$/.test(value.filename) || value.filename.includes("..")) {
        throw new Error("保存先またはメディアURLが不正です。");
      }
      return { url, filename: value.filename };
    });
  }
  function positionPart(value, free) {
    if (value === "left" || value === "top") return 0;
    if (value === "right" || value === "bottom") return free;
    if (value === "center") return free / 2;
    if (/^-?[\d.]+%$/.test(value)) return free * parseFloat(value) / 100;
    if (/^-?[\d.]+px$/.test(value)) return parseFloat(value);
    const calc = value.match(/^calc\((-?[\d.]+)%\s*([+-])\s*([\d.]+)px\)$/);
    if (calc) return free * Number(calc[1]) / 100 + (calc[2] === "+" ? 1 : -1) * Number(calc[3]);
    return free / 2;
  }
  function offsets(position, freeX, freeY) {
    const parts = position.trim().match(/calc\([^)]*\)|[^\s]+/g) || ["center"];
    if (parts.length >= 3) {
      let x = freeX / 2, y = freeY / 2;
      for (let i = 0; i < parts.length; i++) {
        const edge = parts[i];
        const horizontal = edge === "left" || edge === "right";
        const vertical = edge === "top" || edge === "bottom";
        if (!horizontal && !vertical) continue;
        const free = horizontal ? freeX : freeY;
        let value = positionPart(edge, free);
        if (parts[i + 1] && !/^(left|right|top|bottom|center)$/.test(parts[i + 1])) {
          const delta = positionPart(parts[++i], free);
          value += edge === "right" || edge === "bottom" ? -delta : delta;
        }
        if (horizontal) x = value; else y = value;
      }
      return [x, y];
    }
    let [x, y = "center"] = parts;
    if (x === "top" || x === "bottom" || (parts.length === 2 && (y === "left" || y === "right"))) [x, y] = [y, x];
    return [positionPart(x, freeX), positionPart(y, freeY)];
  }
  function drawnRect(rect, width, height, fit = "fill", position = "50% 50%") {
    let w = rect.width, h = rect.height;
    if (width > 0 && height > 0 && fit !== "fill") {
      let scale = fit === "cover" ? Math.max(w / width, h / height) : Math.min(w / width, h / height);
      if (fit === "none") scale = 1;
      if (fit === "scale-down") scale = Math.min(1, scale);
      w = width * scale; h = height * scale;
    }
    const [x, y] = offsets(position, rect.width - w, rect.height - h);
    const left = rect.left + x;
    const top = rect.top + y;
    const right = Math.min(rect.left + rect.width, left + w);
    const bottom = Math.min(rect.top + rect.height, top + h);
    return { left: Math.max(rect.left, left), top: Math.max(rect.top, top), right, bottom,
      width: Math.max(0, right - Math.max(rect.left, left)), height: Math.max(0, bottom - Math.max(rect.top, top)) };
  }
  return { MAX_BATCH, mediaURL, identity, best, item, groups, shortcodeID, safePart, filename, validateItems, drawnRect, mediaKey, groupKey, filenameHistoryKey, urlHistoryKey, postHistoryKey, historyKeys, validHistoryKey, validateHistory };
});
