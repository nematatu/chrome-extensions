/* Persistent work records, independent of the short-lived image-download queue. */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.MomonijiLibrary = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, function () {
  'use strict';
  const STORAGE_KEY = 'momonijiLibrary';
  const VERSION = 1;
  const MAX_ENTRIES = 5000;
  const MAX_STORAGE_BYTES = 4 * 1024 * 1024;
  const HOSTS = new Set(['momoniji.com', 'www.momoniji.com']);
  const RESERVED = new Set(['category', 'tag', 'page', 'search', 'wp-admin', 'wp-json', 'feed', 'robots.txt', 'sitemap.xml']);
  const ERRORS = Object.freeze({
    INVALID_URL: 'このリンクは対応する漫画の作品ページではありません。',
    INVALID_WORK: '漫画の作品情報を確認できません。',
    FORBIDDEN: 'このページからの操作は許可されていません。',
    LIBRARY_FULL: '作品の記録が5,000件に達したため、新しい作品を追加できません。',
    LIBRARY_TOO_LARGE: '作品の記録が保存容量の上限に達したため、新しい作品を追加できません。',
    NO_ENTRY: 'この作品は後で読む一覧にありません。',
    STORAGE_FAILED: '作品の記録を保存できませんでした。空き容量をご確認ください。',
    INVALID_STATE: '作品の記録を読み込めませんでした。拡張機能を再読み込みしてください。',
    INTERNAL_ERROR: '後で読むを操作できませんでした。もう一度お試しください。'
  });
  class LibraryError extends Error {
    constructor(code) { super(ERRORS[code] || ERRORS.INTERNAL_ERROR); this.code = code; }
  }
  function assert(value, code = 'INVALID_WORK') { if (!value) throw new LibraryError(code); }
  function canonicalWorkUrl(value) {
    assert(typeof value === 'string' && value.length > 0 && value.length <= 2048, 'INVALID_URL');
    let url, path;
    try { url = new URL(value); path = decodeURIComponent(url.pathname); } catch { throw new LibraryError('INVALID_URL'); }
    assert(url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password && !url.port, 'INVALID_URL');
    assert(!/[\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(path), 'INVALID_URL');
    path = path.normalize('NFC').replace(/\/+$/u, '').replace(/\/page\/[1-9][0-9]*$/u, '');
    assert(/^\/[^/]+$/u.test(path) && !RESERVED.has(path.slice(1).toLowerCase()), 'INVALID_URL');
    url.hostname = 'momoniji.com'; url.pathname = '/' + encodeURIComponent(path.slice(1)) + '/'; url.search = ''; url.hash = '';
    assert(url.href.length <= 2048, 'INVALID_URL');
    return url.href;
  }
  function normalizeWork(value) {
    assert(value && typeof value === 'object' && !Array.isArray(value));
    assert(typeof value.title === 'string' && value.title.length <= 512);
    const title = value.title.normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
    assert(title.length > 0);
    return { url: canonicalWorkUrl(value.url), title };
  }
  function validTime(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }
  function validFolder(value) {
    return typeof value === 'string' && value.length <= 240 && /^(?:momoniji|momoniji-manga-viewer)\/[^/\\\u0000-\u001f\u007f]+-[a-f0-9]{16}$/u.test(value) && !value.includes('..');
  }
  function restoreEntry(value) {
    const work = normalizeWork(value);
    assert(typeof value.readLater === 'boolean' && typeof value.read === 'boolean', 'INVALID_STATE');
    assert(validTime(value.addedAt) && validTime(value.updatedAt), 'INVALID_STATE');
    assert(value.downloadedAt === null || validTime(value.downloadedAt), 'INVALID_STATE');
    assert(Number.isInteger(value.downloadedCount) && value.downloadedCount >= 0 && value.downloadedCount <= 1000, 'INVALID_STATE');
    assert(value.downloadFolder === null || validFolder(value.downloadFolder), 'INVALID_STATE');
    assert(value.downloadedAt === null ? value.downloadedCount === 0 && value.downloadFolder === null : value.downloadedCount > 0 && value.downloadFolder !== null, 'INVALID_STATE');
    assert(value.readLater || value.downloadedAt !== null, 'INVALID_STATE');
    assert(value.downloadedRun === null || typeof value.downloadedRun === 'string' && value.downloadedRun.length <= 96, 'INVALID_STATE');
    return { ...work, readLater: value.readLater, read: value.read, addedAt: value.addedAt, updatedAt: value.updatedAt,
      downloadedAt: value.downloadedAt, downloadedCount: value.downloadedCount, downloadFolder: value.downloadFolder, downloadedRun: value.downloadedRun };
  }
  function newEntry(work, now) {
    return { ...work, readLater: false, read: false, addedAt: now, updatedAt: now, downloadedAt: null, downloadedCount: 0, downloadFolder: null, downloadedRun: null };
  }
  class Controller {
    constructor(api, options = {}) { this.api = api; this.now = options.now || Date.now; this.entries = []; this.ready = false; this.chain = Promise.resolve(); }
    enqueue(operation) { const result = this.chain.then(operation); this.chain = result.catch(() => {}); return result; }
    init() { return this.enqueue(async () => {
      if (this.ready) return;
      let stored;
      try { stored = await this.api.load(); } catch { throw new LibraryError('STORAGE_FAILED'); }
      if (stored !== undefined && stored !== null) {
        assert(stored.version === VERSION && Array.isArray(stored.entries) && stored.entries.length <= MAX_ENTRIES, 'INVALID_STATE');
        const entries = stored.entries.map(restoreEntry);
        const unique = new Map();
        for (const entry of entries) {
          const previous = unique.get(entry.url);
          if (!previous || entry.updatedAt >= previous.updatedAt) unique.set(entry.url, entry);
        }
        this.entries = [...unique.values()];
      }
      this.ready = true;
    }); }
    snapshot() {
      const entries = this.entries.map(({ downloadedRun, ...entry }) => ({ ...entry })).sort((a, b) => b.addedAt - a.addedAt || a.url.localeCompare(b.url));
      return { entries, unreadCount: entries.filter(entry => entry.readLater && !entry.read).length };
    }
    list() { return this.enqueue(() => this.snapshot()); }
    async commit(entries) {
      assert(new TextEncoder().encode(JSON.stringify({ version: VERSION, entries })).length <= MAX_STORAGE_BYTES, 'LIBRARY_TOO_LARGE');
      try { await this.api.save({ version: VERSION, entries }); } catch { throw new LibraryError('STORAGE_FAILED'); }
      this.entries = entries;
      const result = this.snapshot();
      if (this.api.changed) { try { await this.api.changed(result); } catch { /* Persisted state remains authoritative if a UI is closed. */ } }
      return result;
    }
    save(work) { return this.enqueue(async () => {
      const normalized = normalizeWork(work);
      const existing = this.entries.find(entry => entry.url === normalized.url);
      if (existing?.readLater) return this.snapshot();
      assert(existing || this.entries.length < MAX_ENTRIES, 'LIBRARY_FULL');
      const now = this.now();
      const entry = { ...(existing || newEntry(normalized, now)), ...normalized, readLater: true, read: false, addedAt: now, updatedAt: now };
      return this.commit([...this.entries.filter(item => item.url !== entry.url), entry]);
    }); }
    remove(url) { return this.enqueue(async () => {
      const canonical = canonicalWorkUrl(url);
      const existing = this.entries.find(entry => entry.url === canonical);
      if (!existing?.readLater) return this.snapshot();
      const entries = this.entries.filter(entry => entry.url !== canonical);
      if (existing.downloadedAt !== null) entries.push({ ...existing, readLater: false, read: false, updatedAt: this.now() });
      return this.commit(entries);
    }); }
    markRead(url, read) { return this.enqueue(async () => {
      const canonical = canonicalWorkUrl(url);
      assert(typeof read === 'boolean');
      const existing = this.entries.find(entry => entry.url === canonical);
      assert(existing?.readLater, 'NO_ENTRY');
      if (existing.read === read) return this.snapshot();
      return this.commit(this.entries.map(entry => entry.url === canonical ? { ...entry, read, updatedAt: this.now() } : entry));
    }); }
    recordDownload(value) { return this.enqueue(async () => {
      const work = normalizeWork(value);
      assert(Number.isInteger(value.total) && value.total > 0 && value.total <= 1000 && validFolder(value.folder));
      assert(validTime(value.completedAt) && typeof value.run === 'string' && value.run.length > 0 && value.run.length <= 96);
      const existing = this.entries.find(entry => entry.url === work.url);
      if (existing?.downloadedRun === value.run) return this.snapshot();
      assert(existing || this.entries.length < MAX_ENTRIES, 'LIBRARY_FULL');
      const now = this.now();
      const entry = { ...(existing || newEntry(work, now)), ...work, updatedAt: now, downloadedAt: value.completedAt,
        downloadedCount: value.total, downloadFolder: value.folder, downloadedRun: value.run };
      return this.commit([...this.entries.filter(item => item.url !== entry.url), entry]);
    }); }
  }
  return Object.freeze({ STORAGE_KEY, VERSION, MAX_ENTRIES, MAX_STORAGE_BYTES, HOSTS, ERRORS, LibraryError, canonicalWorkUrl, normalizeWork, Controller });
});
