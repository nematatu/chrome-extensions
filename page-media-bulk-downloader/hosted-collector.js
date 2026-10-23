(function (root) {
  "use strict";

  // Fixed GET endpoints verified in the supported sites' public app bundles.
  // No page-provided API origin, passwords or tracking calls.
  const API_BASE = "https://rwzugqnp.fun800.click/app-api/flow/land-page/";
  const PROXY_ORIGINS = new Set(["https://gofile.es", "https://gofile.pl"]);
  const PAGE_SIZE = 20;
  const MAX_ITEMS = 10000;
  const MAX_PAGES = 500;
  const MAX_DETAILS = 1000;
  const MAX_RESPONSE_BYTES = 1024 * 1024;
  const MAX_SCAN_BYTES = 32 * 1024 * 1024;
  const MAX_SCAN_DURATION_MS = 4 * 60 * 1000;
  const SOURCE_FIELDS = ["mp4Url", "appMp4Url", "videoUrl", "playUrl", "m3u8Url", "fileUrl", "source", "src", "url", "downloadUrl"];

  async function collectHostedPageMedia(snapshot, dependencies = {}) {
    const core = dependencies.core || root.PageMediaBulkCore;
    const requestFetch = dependencies.fetch || root.fetch;
    const isCurrentPage = dependencies.isCurrentPage || (async () => true);
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const pageInfo = core.getHostedPageInfo(snapshot?.pageUrl);
    if (!pageInfo || snapshot?.scanType !== "hosted-api") return { ok: false, error: "UNTRUSTED_PAGE" };
    const expectedFile = dependencies.expectedFile == null ? null
      : core.normalizeHostedFileReference(dependencies.expectedFile, snapshot.pageUrl);
    if (dependencies.expectedFile != null && !expectedFile) return {ok: false, error: "UNTRUSTED_PAGE"};
    let bytesRead = 0, detailRequests = 0, pages = 0;
    const detailCache = new Map();
    const fail = code => { throw new Error(code); };

    async function ensureCurrentPage() {
      if (now() - startedAt >= MAX_SCAN_DURATION_MS) fail("SCAN_TIMEOUT");
      if (!await isCurrentPage()) fail("PAGE_CHANGED");
    }

    async function get(endpoint, params) {
      await ensureCurrentPage();
      const origin = new URL(snapshot.pageUrl).origin;
      const url = PROXY_ORIGINS.has(origin) ? new URL("/api.php", origin) : new URL(endpoint, API_BASE);
      if (PROXY_ORIGINS.has(origin)) url.searchParams.set("endpoint", "/flow/land-page/" + endpoint);
      for (const [key, value] of Object.entries({ ...params, domain: pageInfo.domain })) {
        url.searchParams.set(key, String(value));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(15000,
        MAX_SCAN_DURATION_MS - (now() - startedAt))));
      try {
        const response = await requestFetch(url.href, { method: "GET", credentials: "omit", redirect: "error",
          cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
        if (response.status === 429) fail("RATE_LIMITED");
        if ([401, 403].includes(response.status)) fail("AUTH_REQUIRED");
        if ([404, 410].includes(response.status)) fail("NOT_FOUND");
        if (!response.ok) fail("SITE_API_FAILED");
        if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
          fail("SITE_DATA_CHANGED");
        }
        if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) fail("TOO_MUCH_DATA");
        const reader = response.body?.getReader();
        if (!reader) fail("SITE_DATA_CHANGED");
        const decoder = new TextDecoder();
        let text = "", responseBytes = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            responseBytes += value.byteLength;
            bytesRead += value.byteLength;
            if (responseBytes > MAX_RESPONSE_BYTES || bytesRead > MAX_SCAN_BYTES) fail("TOO_MUCH_DATA");
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          try { await reader.cancel(); } catch { /* Stop an oversized or interrupted response. */ }
        }
        let data;
        try { data = JSON.parse(text); } catch { fail("SITE_DATA_CHANGED"); }
        if (!data || typeof data !== "object" || (data.code != null && Number(data.code) !== 0)) fail("SITE_API_FAILED");
        await ensureCurrentPage();
        return data.data?.data ?? data.data ?? data;
      } catch (error) {
        const codes = ["PAGE_CHANGED", "RATE_LIMITED", "AUTH_REQUIRED", "NOT_FOUND", "SITE_API_FAILED",
          "SITE_DATA_CHANGED", "TOO_MUCH_DATA", "SCAN_TIMEOUT"];
        fail(codes.includes(error?.message) ? error.message
          : now() - startedAt >= MAX_SCAN_DURATION_MS ? "SCAN_TIMEOUT" : "SITE_API_FAILED");
      } finally { clearTimeout(timer); }
    }

    function object(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function first(...values) {
      return values.find(value => value != null && String(value).trim() !== "");
    }

    function text(...values) {
      const value = first(...values);
      return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
    }

    function folder(value) {
      return [true, 1, "1", "true"].includes(value);
    }

    function entry(value) {
      const raw = object(value);
      const file = object(raw.netDiskInfo || raw.netdiskInfo || raw.fileInfo || raw);
      const name = text(file.name, raw.name, file.title, raw.title, file.fileName, raw.fileName);
      if (!name || name.length > 512) fail("SITE_DATA_CHANGED");
      return { raw, file, name, id: text(file.id, file.fileId, raw.id, raw.fileId),
        isFolder: folder(first(file.isFolder, raw.isFolder)),
        landingPage: text(file.landingPage, raw.landingPage, file.path, raw.path, file.shortLink, raw.shortLink,
          file.externalLinks, raw.externalLinks),
        size: Number(first(file.fileSize, raw.fileSize, file.size, raw.size)) || 0 };
    }

    function detail(value) {
      const outer = object(value), data = object(outer.data || outer);
      const info = object(data.info || outer.info || data);
      const rules = object(outer.rules || data.rules || info.rules);
      const status = String(rules.status || "0");
      if (["4", "5"].includes(status)) fail("ACCESS_REQUIRED");
      if (["1", "2", "3"].includes(status)) fail("NOT_FOUND");
      if (status !== "0") fail("SITE_DATA_CHANGED");
      return { item: entry(info), extra: object(info.extraInfo || info.extra), info };
    }

    function source(value, depth = 0, includeHls = false) {
      if (depth > 3 || value == null) return null;
      if (typeof value === "string") {
        const raw = value.trim();
        if (!raw || raw.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(raw)) return null;
        let link;
        try { link = new URL(raw, snapshot.pageUrl).href; } catch { return null; }
        return core.isAllowedDownloadUrl(link, snapshot.pageUrl)
          && (includeHls || !core.isHostedHlsUrl(link, snapshot.pageUrl)) ? link : null;
      }
      if (Array.isArray(value)) {
        if (value.length > 100) fail("SITE_DATA_CHANGED");
        for (const candidate of value) { const found = source(candidate, depth + 1, includeHls); if (found) return found; }
      } else if (typeof value === "object") {
        for (const key of SOURCE_FIELDS) { const found = source(value[key], depth + 1, includeHls); if (found) return found; }
      }
      return null;
    }

    function childLink(value) {
      if (/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
        return value.length > 6 && value.startsWith("a") ? value.slice(1) : value;
      }
      let parsed;
      try { parsed = new URL(value, snapshot.pageUrl); } catch { fail("SITE_FILE_UNSUPPORTED"); }
      if (parsed.origin !== new URL(snapshot.pageUrl).origin) fail("SITE_FILE_UNSUPPORTED");
      const info = core.getHostedPageInfo(parsed.href);
      if (!info) fail("SITE_FILE_UNSUPPORTED");
      return info.shortLink;
    }

    function hasSourceData(value, depth = 0) {
      if (depth > 3 || value == null) return false;
      if (typeof value === "string") {
        return !["", "null", "undefined", "https://vid.fun800.click/null"].includes(value.trim());
      }
      if (Array.isArray(value)) return value.some(candidate => hasSourceData(candidate, depth + 1));
      return typeof value === "object" && SOURCE_FIELDS.some(key => hasSourceData(value[key], depth + 1));
    }

    function list(value) {
      const outer = object(value), data = object(outer.data || outer), page = object(data.page);
      const rows = Array.isArray(value) ? value : [data.list, data.records, data.rows, data.data, page.list,
        page.records].find(Array.isArray);
      if (!rows || rows.length > PAGE_SIZE) fail("SITE_DATA_CHANGED");
      const count = first(data.total, data.totalCount, data.count, outer.total, outer.totalCount, outer.count);
      const total = count == null || (Number(count) === 0 && rows.length) ? null : Number(count);
      if (total != null && (!Number.isSafeInteger(total) || total < 0)) fail("SITE_DATA_CHANGED");
      if (total > MAX_ITEMS) fail("TOO_MANY_ITEMS");
      return { entries: rows.map(entry), total };
    }

    async function readList(shortLink, sortOrder) {
      const entries = [], seen = new Set();
      let expectedTotal = null;
      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        if (pages >= MAX_PAGES) fail("TOO_MANY_PAGES");
        const current = list(await get("list_by_links_page", {externalLinks: shortLink,
          pageNo, pageSize: PAGE_SIZE, sortOrder: sortOrder || 2}));
        pages++;
        if (current.total != null) {
          if (expectedTotal != null && expectedTotal !== current.total) fail("SITE_LIST_MISMATCH");
          expectedTotal = current.total;
        }
        for (const item of current.entries) {
          const identity = item.id || item.landingPage || JSON.stringify([item.name, source(item.file, 0, true), source(item.raw, 0, true)]);
          if (seen.has(identity)) fail("SITE_LIST_MISMATCH");
          seen.add(identity); entries.push(item);
          if (entries.length > MAX_ITEMS) fail("TOO_MANY_ITEMS");
        }
        if (expectedTotal != null && entries.length > expectedTotal) fail("SITE_LIST_MISMATCH");
        if (expectedTotal != null && entries.length === expectedTotal) break;
        if (current.entries.length < PAGE_SIZE) {
          if (expectedTotal != null && entries.length !== expectedTotal) fail("SITE_LIST_MISMATCH");
          break;
        }
        if (pageNo === MAX_PAGES) fail("TOO_MANY_PAGES");
      }
      return entries;
    }

    async function resolve(item) {
      let link = source(item.file) || source(item.raw) || source(item.file, 0, true) || source(item.raw, 0, true);
      let hasDeclaredSource = hasSourceData(item.file) || hasSourceData(item.raw);
      if (!link && item.landingPage) {
        const shortLink = childLink(item.landingPage);
        if (!detailCache.has(shortLink)) {
          if (++detailRequests > MAX_DETAILS) fail("TOO_MANY_PAGES");
          detailCache.set(shortLink, detail(await get("getInfo", { externalLinks: shortLink })));
        }
        const resolved = detailCache.get(shortLink).item;
        if (resolved.isFolder || resolved.name !== item.name || (resolved.id && item.id && resolved.id !== item.id)) {
          fail("SITE_LIST_MISMATCH");
        }
        link = source(resolved.file) || source(resolved.raw) || source(resolved.file, 0, true) || source(resolved.raw, 0, true);
        hasDeclaredSource ||= hasSourceData(resolved.file) || hasSourceData(resolved.raw);
        if (!item.size) item.size = resolved.size;
      }
      if (!link) fail(hasDeclaredSource ? "SITE_FILE_UNSUPPORTED" : "SITE_FILE_UNAVAILABLE");
      if (core.isHostedHlsUrl(link, snapshot.pageUrl)) {
        // Validate each playlist once, immediately before its offscreen transfer.
        // Scanning all playlists here delayed the whole queue and fetched them twice.
        const name = core.isVideoItem({type: "file", name: item.name, mimetype: ""})
          ? item.name.replace(/\.[a-z0-9]{2,5}$/i, "") + ".mp4" : item.name + ".mp4";
        return {type: "file", link, name, mimetype: "video/mp4", size: 0, thumbnail: null};
      }
      const pathname = decodeURIComponent(new URL(link).pathname);
      const extension = pathname.match(/\.([a-z0-9]{2,5})$/i)[1].toLowerCase();
      const probe = { type: "file", name: "media." + extension, mimetype: "" };
      const kind = core.isVideoItem(probe) ? "video" : "image";
      const name = core.isMediaItem({ type: "file", name: item.name, mimetype: "" })
        ? item.name : item.name + "." + extension;
      let hostedFile;
      if (PROXY_ORIGINS.has(new URL(snapshot.pageUrl).origin)) {
        hostedFile = core.normalizeHostedFileReference({shortLink: item.landingPage ? childLink(item.landingPage)
          : expectedFile?.shortLink || "", id: item.id, name: item.name}, snapshot.pageUrl);
        if (!hostedFile) fail("SITE_DATA_CHANGED");
      }
      return { type: "file", link, name, mimetype: kind + (kind === "video" ? "/mp4" : "/png"),
        ...(hostedFile ? {hostedFile} : {}),
        size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0, thumbnail: null };
    }

    try {
      const main = detail(await get("getInfo", { externalLinks: expectedFile?.shortLink || pageInfo.shortLink }));
      if (expectedFile) {
        if (main.item.isFolder || main.item.name !== expectedFile.name
          || (expectedFile.id && main.item.id && expectedFile.id !== main.item.id)) fail("SITE_LIST_MISMATCH");
        return {ok: true, video: await resolve(main.item)};
      }
      const skipped = [];
      if (main.item.isFolder) {
        if (snapshot.playerName) fail("SITE_LIST_MISMATCH");
      } else {
        const names = [main.item.name];
        const channelName = text(main.extra.channelName);
        // Some public player bundles prepend the containing channel's name.
        // Accept only the exact API-derived name, never an arbitrary page prefix.
        if (channelName && channelName.length <= 512) {
          names.push(channelName + "-" + main.item.name);
        }
        if (!snapshot.playerName || !names.includes(snapshot.playerName.trim())) fail("SITE_LIST_MISMATCH");
      }
      // Individual player pages list the containing channel, using extraInfo.externalLinks.
      const listShortLink = main.item.isFolder ? pageInfo.shortLink : text(main.extra.externalLinks) || pageInfo.shortLink;
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(listShortLink)) fail("SITE_DATA_CHANGED");
      const entries = await readList(listShortLink, main.extra.sortOrder);
      if (!Array.isArray(snapshot.visibleRows) || snapshot.visibleRows.length > MAX_ITEMS
        || (main.item.isFolder && !snapshot.visibleRows.length)) fail("SITE_NOT_READY");
      const names = new Map();
      for (const item of entries) {
        const key = JSON.stringify([item.name, item.isFolder]);
        names.set(key, (names.get(key) || 0) + 1);
      }
      for (const row of snapshot.visibleRows) {
        const key = JSON.stringify([typeof row?.name === "string" ? row.name.trim() : "", row?.isFolder === true]);
        if (!names.get(key)) fail("SITE_LIST_MISMATCH");
        names.set(key, names.get(key) - 1);
      }
      if (!main.item.isFolder && !entries.some(item => !item.isFolder &&
        ((item.landingPage && childLink(item.landingPage) === pageInfo.shortLink)
          || (item.id && item.id === main.item.id)
          || (source(main.item.file, 0, true) && source(item.file, 0, true) === source(main.item.file, 0, true))))) {
        entries.push(main.item);
      }
      if (entries.length > MAX_ITEMS) fail("TOO_MANY_ITEMS");
      const videos = [];
      // Sequential resolution keeps API load bounded and stops immediately on an error.
      for (const [index, item] of entries.entries()) {
        await ensureCurrentPage();
        if (item.isFolder) {
          skipped.push({ id: "folder-" + index, name: item.name, size: 0, thumbnail: null, reason: "subfolder" });
          continue;
        }
        let media;
        try { media = await resolve(item); }
        catch (error) {
          if (error?.message !== "SITE_FILE_UNAVAILABLE") throw error;
          skipped.push({id: "missing-" + index, name: item.name, size: item.size, thumbnail: null, reason: "missing-link"});
          continue;
        }
        videos.push({ ...media, id: "media-" + index });
      }
      await ensureCurrentPage();
      return { ok: true, pageUrl: snapshot.pageUrl, folderId: listShortLink, savingScope: "hosted-list-mp4-v2",
        folderName: main.item.isFolder ? main.item.name : text(main.extra.channelName) || snapshot.title || main.item.name,
        videos, skipped, scannedItems: entries.length, totalPages: Math.max(1, pages) };
    } catch (error) {
      const codes = ["PAGE_CHANGED", "RATE_LIMITED", "AUTH_REQUIRED", "ACCESS_REQUIRED", "NOT_FOUND", "SITE_API_FAILED",
        "SITE_DATA_CHANGED", "TOO_MUCH_DATA", "SITE_FILE_UNSUPPORTED", "SITE_LIST_MISMATCH", "SITE_NOT_READY",
        "TOO_MANY_ITEMS", "TOO_MANY_PAGES", "SCAN_TIMEOUT", "SITE_FILE_UNAVAILABLE"];
      codes.push(...(root.PageMediaHls?.ERROR_CODES || []));
      return { ok: false, error: codes.includes(error?.message) ? error.message : "SCAN_FAILED" };
    }
  }

  root.collectHostedPageMedia = collectHostedPageMedia;
  root.refreshHostedFile = (pageUrl, reference, dependencies = {}) => {
    const core = dependencies.core || root.PageMediaBulkCore;
    if (!core.normalizeHostedFileReference(reference, pageUrl)) {
      return Promise.resolve({ok: false, error: "UNTRUSTED_PAGE"});
    }
    return collectHostedPageMedia({scanType: "hosted-api", pageUrl}, {...dependencies, expectedFile: reference});
  };
  collectHostedPageMedia.refreshHostedFile = root.refreshHostedFile;
  if (typeof module === "object" && module.exports) module.exports = collectHostedPageMedia;
})(globalThis);
