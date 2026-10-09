/* Durable, URL-restricted download queue. Chrome API access lives in background.js. */
(function (root, factory) {
  'use strict';
  const core = factory();
  root.MomonijiDownloads = core;
  if (typeof module === 'object' && module.exports) module.exports = core;
})(globalThis, function () {
  'use strict';

  const STORAGE_KEY = 'momonijiDownloadState';
  const VERSION = 1;
  const CONCURRENCY = 2;
  const MAX_IMAGES = 1000;
  const MAX_URL_LENGTH = 2048;
  const MAX_URL_BYTES = 300000;
  const MAX_JOBS = 8;
  const MAX_ACTIVE_JOBS = 3;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5000;
  const DOWNLOAD_ROOT = 'momoniji-manga-viewer';
  const IMAGE_HOSTS = new Set(['img.momoniji.com', 'momoniji.com', 'www.momoniji.com']);
  const SITE_HOSTS = new Set(['momoniji.com', 'www.momoniji.com']);
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
  const PAGE_STATES = new Set(['pending', 'starting', 'in_progress', 'complete', 'failed', 'cancelled']);
  const RETRYABLE = new Set(['NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN', 'SERVER_FAILED', 'SERVER_UNREACHABLE', 'FILE_TRANSIENT_ERROR', 'USER_SHUTDOWN', 'CRASH', 'START_FAILED', 'DOWNLOAD_MISSING']);
  const ERRORS = Object.freeze({
    INVALID_REQUEST: 'ダウンロードの指定が正しくありません。',
    INVALID_URL: '対応していない画像 URL が含まれています。',
    TOO_MANY_IMAGES: '一度に保存できる画像は 1,000 枚までです。',
    PAYLOAD_TOO_LARGE: 'ダウンロードの指定が大きすぎます。',
    TOO_MANY_JOBS: '別の作品の保存が終わってから開始してください。',
    FORBIDDEN: 'このページからの操作は許可されていません。',
    NO_JOB: 'この作品のダウンロードは開始されていません。',
    STORAGE_FAILED: '保存状況を記録できませんでした。空き容量を確認してください。',
    INTERNAL_ERROR: 'ダウンロードを処理できませんでした。もう一度お試しください。'
  });

  class DownloadError extends Error {
    constructor(code) { super(ERRORS[code] || ERRORS.INTERNAL_ERROR); this.code = code; }
  }
  function assert(condition, code = 'INVALID_REQUEST') { if (!condition) throw new DownloadError(code); }
  function parseUrl(value) {
    assert(typeof value === 'string' && value.length > 0 && value.length <= MAX_URL_LENGTH, 'INVALID_URL');
    let url;
    try { url = new URL(value); } catch { throw new DownloadError('INVALID_URL'); }
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.port, 'INVALID_URL');
    return url;
  }
  function canonicalPageUrl(value) {
    const url = parseUrl(value);
    assert(SITE_HOSTS.has(url.hostname), 'INVALID_URL');
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { throw new DownloadError('INVALID_URL'); }
    assert(!/[\u0000-\u001f\u007f\\]/u.test(path), 'INVALID_URL');
    path = path.replace(/\/+$/u, '').replace(/\/page\/[1-9][0-9]*$/u, '');
    assert(path !== '', 'INVALID_URL');
    url.pathname = `${path}/`;
    url.hash = '';
    url.search = '';
    return url.href;
  }
  function imageUrl(value) {
    const url = parseUrl(value);
    assert(IMAGE_HOSTS.has(url.hostname), 'INVALID_URL');
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { throw new DownloadError('INVALID_URL'); }
    assert(!/[\u0000-\u001f\u007f\\]/u.test(path) && /\.(?:jpe?g|png|webp|gif|avif)$/iu.test(path), 'INVALID_URL');
    url.hash = '';
    return url.href;
  }
  function stableId(value) {
    let first = 2166136261; let second = 2246822507;
    for (const character of value) {
      const point = character.codePointAt(0);
      first = Math.imul(first ^ point, 16777619);
      second = Math.imul(second ^ point, 3266489909);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
  }
  function safeTitle(value) {
    let title = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, '_').replace(/\.{2,}/gu, '_').replace(/\s+/gu, ' ').replace(/^[ .]+|[ .]+$/gu, '');
    let result = ''; let bytes = 0;
    for (const character of title) {
      const length = new TextEncoder().encode(character).length;
      if (bytes + length > 96) break;
      result += character; bytes += length;
    }
    title = result.replace(/[ .]+$/gu, '') || '漫画';
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(title)) title = `_${title}`;
    return title;
  }
  function normalizeManga(manga) {
    assert(manga && typeof manga === 'object' && !Array.isArray(manga));
    assert(typeof manga.title === 'string' && manga.title.trim().length > 0 && manga.title.length <= 512);
    assert(Array.isArray(manga.images) && manga.images.length > 0);
    assert(manga.images.length <= MAX_IMAGES, 'TOO_MANY_IMAGES');
    const pageUrl = canonicalPageUrl(manga.pageUrl);
    let length = 0;
    const images = manga.images.map(value => {
      length += typeof value === 'string' ? value.length : 0;
      assert(length <= MAX_URL_BYTES, 'PAYLOAD_TOO_LARGE');
      return imageUrl(value);
    });
    assert(new Set(images).size === images.length);
    const id = stableId(pageUrl);
    const title = manga.title.trim();
    return { id, title, pageUrl, folder: `${DOWNLOAD_ROOT}/${safeTitle(title)}-${id}`, images };
  }
  function extensionFor(url) {
    const extension = decodeURIComponent(new URL(url).pathname).match(/\.([a-z]+)$/iu)[1].toLowerCase();
    return extension === 'jpeg' ? 'jpg' : extension;
  }
  function filenameFor(job, page, index) { return `${job.folder}/${String(index + 1).padStart(4, '0')}.${extensionFor(page.url)}`; }
  function matchesOwnedDownload(item, page, extensionId) {
    if (!item || item.byExtensionId !== extensionId) return false;
    try { return imageUrl(item.url) === page.url; } catch { return false; }
  }
  function matchesOwnedFile(item, job, page, extensionId) {
    if (!matchesOwnedDownload(item, page, extensionId) || typeof item.filename !== 'string') return false;
    const index = job.pages.indexOf(page);
    if (index < 0) return false;
    const expected = filenameFor(job, page, index).normalize('NFC');
    const extension = extensionFor(page.url);
    const base = expected.slice(0, -extension.length - 1).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`/${base}(?: \\([1-9][0-9]*\\))?\\.${extension}$`, 'u').test(item.filename.replace(/\\/gu, '/').normalize('NFC'));
  }
  function active(page) { return page.state === 'starting' || page.state === 'in_progress'; }
  function summary(job) {
    if (!job) return null;
    const counts = { completed: 0, failed: 0, cancelled: 0, active: 0, pending: 0 };
    const failures = [];
    job.pages.forEach((page, index) => {
      if (page.state === 'complete') counts.completed += 1;
      else if (page.state === 'failed') { counts.failed += 1; failures.push({ page: index + 1, reason: page.error || 'DOWNLOAD_FAILED' }); }
      else if (page.state === 'cancelled') counts.cancelled += 1;
      else if (active(page)) counts.active += 1;
      else counts.pending += 1;
    });
    return { id: job.id, title: job.title, pageUrl: job.pageUrl, folder: job.folder, total: job.pages.length, ...counts, state: job.state, failures, updatedAt: job.updatedAt };
  }
  function makeJob(manga, tabId, now) {
    return { id: manga.id, title: manga.title, pageUrl: manga.pageUrl, folder: manga.folder, tabId, createdAt: now, updatedAt: now, state: 'running', cancelRequested: false, pages: manga.images.map(url => ({ url, state: 'pending', downloadId: null, attempts: 0, startedAt: 0, nextAttemptAt: 0, error: null })) };
  }
  function restoreJob(value, now) {
    assert(value && Array.isArray(value.pages));
    const manga = normalizeManga({ title: value.title, pageUrl: value.pageUrl, images: value.pages.map(page => page.url) });
    const legacyFolder = `momoniji/${safeTitle(manga.title)}-${manga.id}`;
    assert(value.id === manga.id && (value.folder === manga.folder || value.folder === legacyFolder));
    const job = makeJob(manga, Number.isInteger(value.tabId) && value.tabId >= 0 ? value.tabId : null, now);
    // Existing transfers keep their recorded destination; fresh starts use DOWNLOAD_ROOT.
    job.folder = value.folder;
    job.createdAt = Number.isFinite(value.createdAt) ? value.createdAt : now;
    job.updatedAt = Number.isFinite(value.updatedAt) ? value.updatedAt : now;
    job.cancelRequested = value.cancelRequested === true;
    job.pages = value.pages.map((page, index) => {
      assert(PAGE_STATES.has(page.state));
      assert(page.downloadId === null || (Number.isInteger(page.downloadId) && page.downloadId >= 0));
      assert(!['in_progress', 'complete'].includes(page.state) || page.downloadId !== null);
      assert(Number.isInteger(page.attempts) && page.attempts >= 0 && page.attempts <= MAX_ATTEMPTS);
      return { url: manga.images[index], state: page.state, downloadId: page.downloadId, attempts: page.attempts, startedAt: Number.isFinite(page.startedAt) ? page.startedAt : 0, nextAttemptAt: Number.isFinite(page.nextAttemptAt) ? page.nextAttemptAt : 0, error: typeof page.error === 'string' && /^[A-Z_]{1,64}$/u.test(page.error) ? page.error : null };
    });
    return job;
  }

  function filenameSuggestion(jobs, item, extensionId) {
    for (const job of jobs) {
      const index = job.pages.findIndex(page => active(page) && page.downloadId !== null && page.downloadId === item?.id && matchesOwnedDownload(item, page, extensionId));
      if (index >= 0) return filenameFor(job, job.pages[index], index);
    }
    for (const job of jobs) {
      const index = job.pages.findIndex(page => page.state === 'starting' && page.downloadId === null && matchesOwnedDownload(item, page, extensionId));
      if (index >= 0) return filenameFor(job, job.pages[index], index);
    }
    return null;
  }

  class Controller {
    constructor(api, options = {}) {
      this.api = api;
      this.now = options.now || Date.now;
      this.jobs = [];
      this.chain = Promise.resolve();
      this.ready = false;
    }
    enqueue(operation) {
      const promise = this.chain.then(operation);
      this.chain = promise.catch(() => {});
      return promise;
    }
    init() { return this.enqueue(async () => {
      if (this.ready) return;
      const stored = await this.api.load();
      if (stored && stored.version === VERSION && Array.isArray(stored.jobs) && stored.jobs.length <= MAX_JOBS) {
        this.jobs = stored.jobs.flatMap(value => { try { return [restoreJob(value, this.now())]; } catch { return []; } });
      }
      await this._reconcile();
      await this._persist();
      await this._pump();
      this.ready = true;
    }); }
    start(manga, tabId) { return this.enqueue(async () => {
      const normalized = normalizeManga(manga);
      assert(Number.isInteger(tabId) && tabId >= 0);
      let job = this.jobs.find(value => value.pageUrl === normalized.pageUrl);
      if (job && ['running', 'cancelling'].includes(job.state)) {
        job.tabId = tabId;
        await this._persist();
        return summary(job);
      }
      assert(this.jobs.filter(value => ['running', 'cancelling'].includes(value.state)).length < MAX_ACTIVE_JOBS, 'TOO_MANY_JOBS');
      this.jobs = this.jobs.filter(value => value.pageUrl !== normalized.pageUrl);
      while (this.jobs.length >= MAX_JOBS) {
        const index = this.jobs.findIndex(value => !['running', 'cancelling'].includes(value.state));
        assert(index !== -1, 'TOO_MANY_JOBS'); this.jobs.splice(index, 1);
      }
      job = makeJob(normalized, tabId, this.now());
      this.jobs.push(job);
      await this._persist();
      await this._pump();
      return summary(job);
    }); }
    status(pageUrl, tabId) { return this.enqueue(async () => {
      const job = this.jobs.find(value => value.pageUrl === canonicalPageUrl(pageUrl));
      if (job && Number.isInteger(tabId) && job.tabId !== tabId) { job.tabId = tabId; await this._persist(); }
      return summary(job);
    }); }
    retry(pageUrl, tabId) { return this.enqueue(async () => {
      const job = this._job(pageUrl);
      assert(Number.isInteger(tabId) && tabId >= 0);
      if (job.state === 'running' || job.state === 'cancelling') { job.tabId = tabId; await this._persist(); return summary(job); }
      if (job.pages.some(page => page.state === 'failed' || page.state === 'cancelled')) {
        assert(this.jobs.filter(value => ['running', 'cancelling'].includes(value.state)).length < MAX_ACTIVE_JOBS, 'TOO_MANY_JOBS');
      }
      job.tabId = tabId;
      job.cancelRequested = false;
      // A pre-fix path comparison may have marked an already saved NFD filename as failed.
      for (const page of job.pages) {
        if (page.state === 'failed' && page.error === 'DOWNLOAD_MISMATCH' && page.downloadId !== null) await this._refreshPage(job, page);
      }
      job.pages.forEach(page => {
        // Reconciliation can put a missing old file back into pending; a manual retry starts it now.
        if (page.state === 'failed' || page.state === 'cancelled' || page.state === 'pending') Object.assign(page, { state: 'pending', downloadId: null, attempts: 0, startedAt: 0, nextAttemptAt: 0, error: null });
      });
      this._settle(job);
      await this._persist(); await this._pump();
      return summary(job);
    }); }
    cancel(pageUrl) { return this.enqueue(async () => {
      const job = this._job(pageUrl);
      job.cancelRequested = true;
      job.pages.forEach(page => { if (page.state === 'pending') page.state = 'cancelled'; });
      this._settle(job); await this._persist();
      for (const page of job.pages.filter(active)) {
        if (page.downloadId === null) { page.state = 'cancelled'; continue; }
        await this._cancelOwned(job, page);
        await this._refreshPage(job, page);
      }
      this._settle(job); await this._persist(); await this._pump();
      return summary(job);
    }); }
    changed(delta) { return this.enqueue(async () => {
      const pair = this._findDownload(delta && delta.id);
      if (!pair || !active(pair.page)) return;
      const { job, page } = pair;
      if (delta.finalUrl && delta.finalUrl.current) {
        try { imageUrl(delta.finalUrl.current); } catch { await this._block(job, page, 'BLOCKED_URL'); }
      }
      if (active(page) && delta.mime && delta.mime.current && !IMAGE_TYPES.has(delta.mime.current.toLowerCase().split(';')[0].trim())) await this._block(job, page, 'UNEXPECTED_CONTENT');
      if (active(page) && delta.state && ['complete', 'interrupted'].includes(delta.state.current)) await this._refreshPage(job, page);
      this._settle(job); await this._persist(); await this._pump();
    }); }
    erased(id) { return this.enqueue(async () => {
      const pair = this._findDownload(id);
      if (!pair || !active(pair.page)) return;
      this._fail(pair.job, pair.page, 'DOWNLOAD_MISSING');
      this._settle(pair.job); await this._persist(); await this._pump();
    }); }
    reconcile() { return this.enqueue(async () => { await this._reconcile(); await this._persist(); await this._pump(); }); }
    _job(pageUrl) {
      const job = this.jobs.find(value => value.pageUrl === canonicalPageUrl(pageUrl));
      assert(job, 'NO_JOB'); return job;
    }
    _findDownload(id) {
      if (!Number.isInteger(id) || id < 0) return null;
      for (const job of this.jobs) {
        const page = job.pages.find(value => value.downloadId === id);
        if (page) return { job, page };
      }
      return null;
    }
    determineFilename(item) {
      // This event can precede downloads.download() resolving, so never await the queue here.
      return filenameSuggestion(this.jobs, item, this.api.extensionId);
    }
    async recoverFilename(item) {
      if (!item || item.byExtensionId !== this.api.extensionId) return null;
      // A filename event can wake a new worker before its queue has loaded. Read the
      // journal without init()/enqueue(), which could wait on this same download.
      const stored = await this.api.load();
      if (!stored || stored.version !== VERSION || !Array.isArray(stored.jobs) || stored.jobs.length > MAX_JOBS) return null;
      const jobs = stored.jobs.flatMap(value => { try { return [restoreJob(value, this.now())]; } catch { return []; } });
      return filenameSuggestion(jobs, item, this.api.extensionId);
    }
    _settle(job) {
      if (job.pages.some(active) || job.pages.some(page => page.state === 'pending')) job.state = job.cancelRequested ? 'cancelling' : 'running';
      else if (job.pages.some(page => page.state === 'cancelled')) job.state = 'cancelled';
      else if (job.pages.some(page => page.state === 'failed')) job.state = 'failed';
      else job.state = 'completed';
      job.updatedAt = this.now();
    }
    async _persist() {
      try { await this.api.save({ version: VERSION, jobs: this.jobs }); } catch { throw new DownloadError('STORAGE_FAILED'); }
      const pending = this.jobs.some(job => job.pages.some(page => active(page) || page.state === 'pending'));
      let nextAttemptAt = null;
      for (const job of this.jobs) for (const page of job.pages) {
        if (page.state === 'pending' && page.nextAttemptAt > this.now() && (nextAttemptAt === null || page.nextAttemptAt < nextAttemptAt)) nextAttemptAt = page.nextAttemptAt;
      }
      if (this.api.schedule) await this.api.schedule(pending, nextAttemptAt);
      if (this.api.notify) for (const job of this.jobs) {
        if (job.tabId !== null) { try { await this.api.notify(job.tabId, summary(job)); } catch { /* Closed tabs do not stop downloads. */ } }
      }
    }
    _fail(job, page, reason) {
      page.error = /^[A-Z_]{1,64}$/u.test(reason || '') ? reason : 'DOWNLOAD_FAILED';
      if (job.cancelRequested || reason === 'USER_CANCELED') { page.state = 'cancelled'; page.nextAttemptAt = 0; return; }
      if (RETRYABLE.has(reason) && page.attempts < MAX_ATTEMPTS) {
        page.state = 'pending'; page.downloadId = null; page.nextAttemptAt = this.now() + RETRY_DELAY_MS;
      } else { page.state = 'failed'; page.nextAttemptAt = 0; }
    }
    async _block(job, page, reason) {
      page.state = 'failed'; page.error = reason; page.nextAttemptAt = 0;
      if (reason === 'SAVE_PATH_CHANGED') { this._settle(job); return; }
      if (page.downloadId !== null) await this._cancelOwned(job, page);
      // If the response finished before cancellation, remove only the file tied to this exact journal entry.
      if (page.downloadId !== null && this.api.removeFile) {
        try {
          const items = await this.api.search({ id: page.downloadId });
          const item = items.find(value => value.id === page.downloadId);
          if (item && item.state === 'complete' && matchesOwnedFile(item, job, page, this.api.extensionId)) await this.api.removeFile(page.downloadId);
          else if (item && item.state === 'complete' && matchesOwnedDownload(item, page, this.api.extensionId) && reason !== 'DOWNLOAD_MISMATCH') page.error = `${reason}_FILE_REMAINS`;
        } catch { page.error = `${reason}_FILE_REMAINS`; }
      }
      this._settle(job);
    }
    async _cancelOwned(job, page) {
      try {
        const items = await this.api.search({ id: page.downloadId });
        const item = items.find(value => value.id === page.downloadId);
        if (item && item.state === 'in_progress' && matchesOwnedFile(item, job, page, this.api.extensionId)) await this.api.cancel(page.downloadId);
      } catch { /* Keep the journal until reconciliation can confirm Chrome's state. */ }
    }
    async _refreshPage(job, page) {
      let items;
      try { items = await this.api.search({ id: page.downloadId }); } catch { return; }
      const item = items.find(value => value.id === page.downloadId);
      if (!item) { this._fail(job, page, 'DOWNLOAD_MISSING'); return; }
      if (!matchesOwnedDownload(item, page, this.api.extensionId)) { await this._block(job, page, 'DOWNLOAD_MISMATCH'); return; }
      if (item.finalUrl) { try { imageUrl(item.finalUrl); } catch { await this._block(job, page, 'BLOCKED_URL'); return; } }
      if (item.state === 'complete') {
        if (!matchesOwnedFile(item, job, page, this.api.extensionId)) { await this._block(job, page, 'SAVE_PATH_CHANGED'); return; }
        if (item.exists === false) { this._fail(job, page, 'DOWNLOAD_MISSING'); return; }
        if (!IMAGE_TYPES.has((item.mime || '').toLowerCase().split(';')[0].trim())) { await this._block(job, page, 'UNEXPECTED_CONTENT'); return; }
        page.state = 'complete'; page.error = null; page.nextAttemptAt = 0;
      } else if (item.state === 'interrupted') this._fail(job, page, item.error || 'DOWNLOAD_FAILED');
      else if (item.state === 'in_progress') page.state = 'in_progress';
    }
    async _reconcile() {
      for (const job of this.jobs) {
        for (let index = 0; index < job.pages.length; index += 1) {
          const page = job.pages[index];
          if (!active(page)) continue;
          if (page.downloadId === null) {
            // The worker can stop after Chrome starts a transfer but before its ID is journalled.
            let items;
            try { items = await this.api.search({ url: page.url, startedAfter: new Date(Math.max(0, page.startedAt - 1000)).toISOString(), limit: 100 }); } catch { continue; }
            const matches = items.filter(item => matchesOwnedFile(item, job, page, this.api.extensionId)).sort((a, b) => b.id - a.id);
            if (matches.length) { page.downloadId = matches[0].id; page.state = 'in_progress'; }
            else if (job.cancelRequested) { page.state = 'cancelled'; continue; }
            else { this._fail(job, page, 'DOWNLOAD_MISSING'); continue; }
          }
          if (job.cancelRequested) await this._cancelOwned(job, page);
          await this._refreshPage(job, page);
        }
        this._settle(job);
      }
    }
    async _pump() {
      let count = this.jobs.reduce((total, job) => total + job.pages.filter(active).length, 0);
      for (const job of this.jobs) {
        if (job.cancelRequested) continue;
        for (let index = 0; index < job.pages.length; index += 1) {
          const page = job.pages[index];
          if (count >= CONCURRENCY) break;
          if (page.state !== 'pending' || page.nextAttemptAt > this.now()) continue;
          Object.assign(page, { state: 'starting', attempts: page.attempts + 1, startedAt: this.now(), nextAttemptAt: 0, downloadId: null });
          this._settle(job);
          await this._persist();
          try {
            const id = await this.api.download({ url: page.url, filename: filenameFor(job, page, index), conflictAction: 'uniquify', saveAs: false });
            assert(Number.isInteger(id) && id >= 0);
            page.downloadId = id; page.state = 'in_progress'; count += 1;
          } catch { this._fail(job, page, 'START_FAILED'); }
          this._settle(job); await this._persist();
        }
      }
    }
  }

  function authorizedSender(sender, extensionId, pageUrl) {
    try {
      return Boolean(sender && sender.id === extensionId && sender.tab && Number.isInteger(sender.tab.id) && sender.tab.id >= 0 && sender.frameId === 0 && canonicalPageUrl(sender.url) === canonicalPageUrl(pageUrl));
    } catch { return false; }
  }
  return Object.freeze({ STORAGE_KEY, VERSION, DOWNLOAD_ROOT, CONCURRENCY, MAX_IMAGES, MAX_ATTEMPTS, RETRY_DELAY_MS, DownloadError, ERRORS, canonicalPageUrl, imageUrl, stableId, safeTitle, normalizeManga, filenameFor, summary, authorizedSender, Controller });
});
