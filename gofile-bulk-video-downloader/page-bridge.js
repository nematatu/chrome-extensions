(function () {
  "use strict";

  // 現行GofileはES modulesのため、一覧の内部stateを直接参照できません。
  // ページ自身のGETレスポンスだけを観測し、認証値はページ外へ出さず永続化しません。
  const BRIDGE_KEY = "__gofileBulkPageBridge";
  if (location.origin !== "https://gofile.io" || globalThis[BRIDGE_KEY]) return;

  const nativeFetch = globalThis.fetch;
  const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  const REQUEST_LIFETIME_MS = 15 * 60 * 1000;
  let latest = null;
  let sequence = 0;
  let expiryTimer = null;

  function shareToken() {
    const match = location.pathname.match(/^\/d\/([^/]+)\/?$/);
    if (!match) return "";
    try { return decodeURIComponent(match[1]); } catch { return ""; }
  }

  function text(value, maximum) {
    return typeof value === "string" ? value.slice(0, maximum) : "";
  }

  function sanitizeResponse(input) {
    if (!input || typeof input !== "object") return null;
    const status = text(input.status, 80);
    if (status !== "ok") return { status };
    const data = input.data;
    if (!data || (data.type !== "folder" && data.type !== "file")) return null;
    const children = data.children && typeof data.children === "object" ? Object.values(data.children) : [];
    if (children.length > 1000) return null;
    const safeChildren = children.map((item) => ({
      id: text(item?.id, 160),
      type: text(item?.type, 20),
      name: text(item?.name, 512),
      size: Number.isSafeInteger(Number(item?.size)) && Number(item.size) >= 0 ? Number(item.size) : 0,
      mimetype: text(item?.mimetype, 200),
      link: text(item?.link, 4096),
      thumbnail: text(item?.thumbnail, 4096) || null,
      isFrozen: item?.isFrozen === true,
      overloaded: item?.overloaded === true,
    }));
    const metadata = {};
    for (const key of ["page", "pageSize", "totalPages", "totalCount"]) {
      const value = Number(input.metadata?.[key]);
      if (Number.isSafeInteger(value) && value >= 0) metadata[key] = value;
    }
    return {
      status,
      data: {
        id: text(data.id, 160),
        code: text(data.code, 160),
        type: data.type,
        name: text(data.name, 512),
        canAccess: data.canAccess === true,
        children: safeChildren,
      },
      metadata,
    };
  }

  async function readResponse(response) {
    if (response.status === 429) return { status: "error-rateLimit" };
    if (response.status === 401 || response.status === 403) return { status: "error-token" };
    if (response.status === 404) return { status: "error-notFound" };
    if (!response.ok) return { status: "error-http" };
    // サイズ不明のレスポンスも有界に読み、ページ本来のbodyには触れません。
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    try { return sanitizeResponse(JSON.parse(new TextDecoder().decode(buffer))); } catch { return null; }
  }

  function currentRecord() {
    if (!latest || Date.now() - latest.createdAt > REQUEST_LIFETIME_MS) {
      latest = null;
      return null;
    }
    const token = shareToken();
    if (!token || latest.path !== location.pathname) {
      // GofileによるUUID→共有コードのcanonical rewriteだけを許可します。
      if (!token || latest.response?.data?.code !== token || latest.identifier !== latest.response?.data?.id) return null;
    }
    return latest;
  }

  globalThis.fetch = function (...args) {
    let candidate = null;
    try {
      const input = args[0];
      const init = args[1];
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      const match = url.pathname.match(/^\/contents\/([a-zA-Z0-9_-]{1,160})$/);
      const token = shareToken();
      if (method === "GET" && url.origin === "https://api.gofile.io" && !url.username && !url.password && match && token && match[1] === token) {
        candidate = { url, input, init, path: location.pathname, identifier: match[1], sequence: ++sequence };
      }
    } catch { /* 一覧以外のリクエストは通常どおり通します。 */ }

    const pending = Reflect.apply(nativeFetch, this, args);
    if (candidate) {
      pending.then((response) => {
        const clone = response.clone();
        return readResponse(clone).then((safe) => {
          if (candidate.sequence !== sequence || !safe) return;
          if (candidate.path !== location.pathname && !(safe.data?.code === shareToken() && candidate.identifier === safe.data?.id)) return;
          latest = { ...candidate, response: safe, createdAt: Date.now(), filtered: candidate.url.searchParams.has("contentFilter") };
          if (expiryTimer) clearTimeout(expiryTimer);
          expiryTimer = setTimeout(() => { latest = null; expiryTimer = null; }, REQUEST_LIFETIME_MS);
        });
      }).catch(() => {});
    }
    return pending;
  };

  const bridge = Object.freeze({
    version: 1,
    current() {
      const record = currentRecord();
      return record ? { response: record.response, filtered: record.filtered } : null;
    },
    async getPage(folderId, page, pageSize) {
      const record = currentRecord();
      if (!record || record.response?.data?.id !== folderId || record.response.data.canAccess !== true) return { status: "error-pageChanged" };
      if (!Number.isInteger(page) || page < 1 || page > 100 || pageSize !== 1000) return { status: "error-input" };
      const url = new URL(record.url.href);
      url.searchParams.delete("contentFilter");
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(pageSize));
      url.searchParams.set("sortField", "createTime");
      url.searchParams.set("sortDirection", "-1");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        // GofileのWebsite Tokenは時間で変わるため、署名済みヘッダを
        // 再送せず、ページ自身の公開generateWT関数で新しく署名します。
        const headers = new Headers(record.init?.headers || (record.input instanceof Request ? record.input.headers : undefined));
        const auth = headers.get("Authorization")?.match(/^Bearer ([a-zA-Z0-9_-]{10,200})$/);
        const appExpired = typeof performance !== "undefined" && Date.now() - performance.timeOrigin > 6 * 60 * 60 * 1000;
        if (!auth || typeof globalThis.generateWT !== "function" || appExpired) return { status: "error-siteChanged" };
        const signed = await globalThis.generateWT(auth[1]);
        if (typeof signed !== "string" || !/^[a-f0-9]{64}$/i.test(signed)) return { status: "error-siteChanged" };
        if (currentRecord() !== record) return { status: "error-pageChanged" };
        headers.set("X-Website-Token", signed);
        const init = { ...record.init, headers, signal: controller.signal, redirect: "error" };
        const input = typeof record.input === "string" || record.input instanceof URL
          ? url.href
          : new Request(url.href, record.input);
        const response = await Reflect.apply(nativeFetch, globalThis, [input, init]);
        if (currentRecord() !== record) return { status: "error-pageChanged" };
        return await readResponse(response) || { status: "error-response" };
      } catch {
        return { status: "error-network" };
      } finally {
        clearTimeout(timer);
      }
    },
  });
  Object.defineProperty(globalThis, BRIDGE_KEY, { value: bridge, configurable: true });
})();
