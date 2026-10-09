/* Reading-list affordances follow Chrome Reading List and Raindrop's saved state. */
(function () {
  'use strict';
  if (window.top !== window || !globalThis.MomonijiLibrary || !globalThis.MomonijiExtract) return;
  const Library = globalThis.MomonijiLibrary;
  const Extract = globalThis.MomonijiExtract;
  const MAX_HTML = 4_000_000;
  const MAX_LINKS = 4000;
  const BADGES = 'momoniji-library-badges';
  let entries = new Map(), currentWork = null, lastContext = null;
  let renderTimer = null, pending = false, noticeTimer = null;
  const statusHosts = new Set();
  function canonical(value) {
    try { return Library.canonicalWorkUrl(value); } catch { return null; }
  }
  function make(tag, attributes = {}, text) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function verifiedWork(doc, pageUrl) {
    const url = canonical(pageUrl);
    const marker = doc.querySelector('#content[data]');
    const title = doc.querySelector('main h1, h1')?.textContent.trim();
    if (!url || !doc.querySelector('#cif') || !/^\d{1,12}$/u.test(marker?.getAttribute('data') || '') ||
        !title || title.length > 500 || /[\u0000-\u001f\u007f]/u.test(title)) return null;
    const comic = [...doc.querySelectorAll('#cif .iw img')].some(image => {
      if (!/^c[1-9]\d{0,3}$/u.test(image.id)) return false;
      const candidate = image.getAttribute('data-src') || image.getAttribute('data-lazy-src') || image.getAttribute('src');
      return !!(candidate && Extract.imageUrl(candidate, pageUrl));
    });
    return comic ? { url, title } : null;
  }
  function setEntries(list) {
    if (!Array.isArray(list) || list.length > 10000) return;
    const next = new Map();
    for (const entry of list) {
      const url = canonical(entry?.url);
      if (!url || typeof entry?.title !== 'string') continue;
      next.set(url, {
        readLater: entry.readLater === true,
        downloadedAt: Number.isSafeInteger(entry.downloadedAt) && entry.downloadedAt > 0 ? entry.downloadedAt : null,
        downloadedCount: Number.isSafeInteger(entry.downloadedCount) && entry.downloadedCount > 0 ? entry.downloadedCount : 0,
      });
    }
    entries = next;
    scheduleRender();
  }
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '後で読むの情報を取得できませんでした。');
    if (response.entries) setEntries(response.entries);
    return response;
  }
  function readButton() {
    const button = make('button', { type: 'button', id: 'read-later', 'aria-pressed': 'false' }, '後で読む');
    button.addEventListener('click', async () => {
      if (!currentWork || pending) return;
      pending = true;
      renderCurrent();
      try {
        const saved = entries.get(currentWork.url)?.readLater;
        await send(saved ? { type: 'MOMONIJI_LIBRARY_REMOVE', url: currentWork.url } : { type: 'MOMONIJI_LIBRARY_SAVE', work: currentWork });
      } catch (error) { showNotice(error.message); }
      finally { pending = false; renderCurrent(); }
    });
    return button;
  }
  function updateButton(button) {
    const saved = !!entries.get(currentWork?.url)?.readLater;
    const label = saved ? '✓ 後で読むに保存済み' : '後で読む';
    if (button.textContent !== label) button.textContent = label;
    const pressed = String(saved);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    button.title = saved ? '後で読むから外す' : '後で読むに保存する';
    button.disabled = !currentWork || pending;
  }
  function currentStatus(shadow) {
    const entry = entries.get(currentWork?.url);
    const download = shadow.getElementById('library-download-status');
    if (download) {
      download.hidden = !entry?.downloadedAt;
      const label = entry?.downloadedAt ? `✓ 画像ダウンロード済み（${entry.downloadedCount}ページ）` : '';
      if (download.textContent !== label) download.textContent = label;
      download.title = 'この拡張機能で画像の保存完了を記録しています。現在のファイルの存在を保証する表示ではありません。';
    }
    const button = shadow.getElementById('read-later');
    if (button) updateButton(button);
  }
  function installCurrent() {
    currentWork = verifiedWork(document, location.href);
    if (currentWork && !document.getElementById('momoniji-library-page-state')) {
      const heading = document.querySelector('main h1, h1');
      const host = make('div', { id: 'momoniji-library-page-state' });
      const shadow = host.attachShadow({ mode: 'open' });
      const style = make('style');
      style.textContent = ':host{display:block;margin:8px 0;color-scheme:light dark;font:13px/1.5 system-ui,sans-serif} [hidden]{display:none!important} .row{display:flex;align-items:center;flex-wrap:wrap;gap:8px} button{font:inherit;border:1px solid #8888;border-radius:6px;padding:5px 10px;cursor:pointer;background:Canvas;color:CanvasText} button:focus-visible{outline:2px solid Highlight;outline-offset:2px} button:disabled{opacity:.6;cursor:default} #library-download-status{padding:2px 7px;border:1px solid #8886;border-radius:12px;color:CanvasText} #library-notice{margin:4px 0;color:CanvasText}';
      const row = make('div', { class: 'row' });
      const download = make('span', { id: 'library-download-status' }); download.hidden = true;
      row.append(readButton(), download);
      const notice = make('p', { id: 'library-notice', role: 'status', 'aria-live': 'polite' }); notice.hidden = true;
      shadow.append(style, row, notice);
      heading.after(host);
      statusHosts.add(host);
    }
    const reader = document.getElementById('momoniji-reader');
    const shadow = reader?.shadowRoot;
    const toolbar = shadow?.getElementById('toolbar');
    if (toolbar && !shadow.getElementById('read-later')) {
      const button = readButton();
      const downloadButton = shadow.getElementById('download');
      if (downloadButton) downloadButton.before(button); else toolbar.append(button);
      const download = make('span', { id: 'library-download-status' }); download.hidden = true;
      download.style.cssText = 'padding:2px 7px;border:1px solid #64748b;border-radius:12px;white-space:nowrap;';
      (shadow.getElementById('save-info') || toolbar).append(download);
      statusHosts.add(reader);
    }
    if (toolbar && !shadow.getElementById('library-notice')) {
      const notice = make('span', { id: 'library-notice', role: 'status', 'aria-live': 'polite' });
      notice.hidden = true;
      notice.style.cssText = 'width:100%;overflow-wrap:anywhere;';
      (shadow.getElementById('save-info') || toolbar).append(notice);
    }
  }
  function renderCurrent() {
    for (const host of statusHosts) {
      if (!host.isConnected) { statusHosts.delete(host); continue; }
      if (host.shadowRoot) currentStatus(host.shadowRoot);
    }
  }
  function installLinkStyle() {
    if (document.getElementById('momoniji-library-style')) return;
    const style = make('style', { id: 'momoniji-library-style' });
    style.textContent = '.momoniji-library-badges{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;margin:3px 5px;font:11px/1.5 system-ui,sans-serif;color:inherit}.momoniji-library-badges>span{padding:1px 6px;border:1px solid currentColor;border-radius:12px;white-space:nowrap;background:transparent}.momoniji-library-badges[hidden]{display:none!important}';
    (document.head || document.documentElement).append(style);
  }
  function renderLinks() {
    let examined = 0;
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (++examined > MAX_LINKS) break;
      const url = canonical(anchor.href);
      const entry = url && entries.get(url);
      let badges = [...anchor.children].find(child => child.classList.contains(BADGES));
      if (!entry || (!entry.readLater && !entry.downloadedAt)) {
        if (badges) badges.remove();
        continue;
      }
      const state = `${entry.readLater ? 1 : 0}:${entry.downloadedAt ? 1 : 0}`;
      if (badges && badges.getAttribute('data-momoniji-library-url') === url && badges.dataset.state === state) continue;
      if (!badges) { badges = make('span', { class: BADGES }); anchor.append(badges); }
      badges.setAttribute('data-momoniji-library-url', url);
      badges.dataset.state = state;
      badges.replaceChildren();
      if (entry.readLater) badges.append(make('span', { class: 'momoniji-library-saved' }, '✓ 後で読むに保存済み'));
      if (entry.downloadedAt) badges.append(make('span', { class: 'momoniji-library-downloaded', title: 'この拡張機能で画像の保存完了を記録しています。' }, '✓ 画像ダウンロード済み'));
    }
  }
  function render() { installCurrent(); renderCurrent(); renderLinks(); }
  function scheduleRender() {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 60);
  }
  function showNotice(message, ok = false) {
    installCurrent();
    let notice = document.getElementById('momoniji-reader')?.shadowRoot?.getElementById('library-notice') ||
      document.getElementById('momoniji-library-page-state')?.shadowRoot?.getElementById('library-notice');
    if (!notice) {
      notice = document.getElementById('momoniji-library-notice');
      if (!notice) {
        notice = make('div', { id: 'momoniji-library-notice', role: 'status', 'aria-live': 'polite' });
        notice.style.cssText = 'position:fixed;bottom:16px;left:16px;max-width:calc(100vw - 32px);z-index:2147483647;padding:10px 14px;border:1px solid #8888;border-radius:6px;background:Canvas;color:CanvasText;font:13px/1.5 system-ui,sans-serif;';
        document.body.append(notice);
      }
    }
    notice.textContent = typeof message === 'string' ? message.slice(0, 500) : '後で読むの操作を確認してください。';
    notice.setAttribute('role', ok ? 'status' : 'alert');
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 6000);
  }
  document.addEventListener('contextmenu', event => {
    const anchor = event.composedPath().find(node => node instanceof Element && node.matches('a[href]'));
    const url = canonical(anchor?.href || currentWork?.url);
    lastContext = url ? { url, at: Date.now() } : null;
  }, true);
  async function resolveWork(value) {
    const requested = canonical(value || (lastContext && Date.now() - lastContext.at < 30000 ? lastContext.url : location.href));
    if (!requested) throw new Error('対応する漫画作品のリンクではありません。');
    const own = verifiedWork(document, location.href);
    if (own?.url === requested) return own;
    const target = new URL(requested);
    target.host = location.host;
    if (target.origin !== location.origin || canonical(target.href) !== requested) throw new Error('作品リンクを確認できません。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(target.href, { credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!response.ok || !/^text\/html(?:\s*;|$)/iu.test(response.headers.get('content-type') || '')) throw new Error('作品ページを取得できませんでした。');
      if (response.url && canonical(response.url) !== requested) throw new Error('作品ページの移動先が一致しません。');
      const size = Number(response.headers.get('content-length'));
      if (Number.isFinite(size) && size > MAX_HTML) throw new Error('作品ページが大きすぎます。');
      const html = await response.text();
      if (typeof html !== 'string' || html.length > MAX_HTML) throw new Error('作品ページが大きすぎます。');
      const work = verifiedWork(new DOMParser().parseFromString(html, 'text/html'), target.href);
      if (!work || work.url !== requested) throw new Error('漫画作品を確認できませんでした。');
      return work;
    } finally { clearTimeout(timeout); }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== chrome.runtime.id) return false;
    if (message?.type === 'MOMONIJI_LIBRARY_CHANGED') { setEntries(message.entries); return false; }
    if (message?.type === 'MOMONIJI_LIBRARY_NOTICE') { showNotice(message.message, message.ok === true); return false; }
    if (message?.type !== 'MOMONIJI_LIBRARY_RESOLVE') return false;
    resolveWork(message.url).then(work => respond({ ok: true, work }), error => respond({ ok: false, error: error.message, code: 'INVALID_WORK' }));
    return true;
  });
  installLinkStyle();
  render();
  const observer = new MutationObserver(records => {
    // Ignore our badge mutations to avoid rendering indefinitely.
    if (records.some(record => !(record.target instanceof Element) || !record.target.closest('.' + BADGES))) scheduleRender();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data', 'id'] });
  send({ type: 'MOMONIJI_LIBRARY_LIST' }).catch(error => showNotice(error.message));
})();
