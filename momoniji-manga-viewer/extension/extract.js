/* Site adapter: only numbered comic pages in #cif are eligible. */
(function (root) {
  'use strict';
  const MAX_IMAGES = 1000;
  const MAX_SITE_PAGES = 100;
  const SITE_HOSTS = new Set(['momoniji.com', 'www.momoniji.com']);
  const IMAGE_HOSTS = new Set(['img.momoniji.com', ...SITE_HOSTS]);
  function canonicalWorkUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !SITE_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error('対象外のページです。');
    }
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { throw new Error('ページURLが不正です。'); }
    path = path.replace(/\/+$/, '').replace(/\/page\/[1-9]\d*$/, '');
    if (!/^\/[^/]+$/.test(path) || /[\\\u0000-\u001f]/.test(path)) throw new Error('作品ページではありません。');
    url.pathname = path + '/';
    url.search = '';
    url.hash = '';
    return url.href;
  }
  function imageUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.port || url.username || url.password ||
          !/\.(?:jpe?g|png|webp|gif|avif)$/i.test(url.pathname) || url.href.length > 2048) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }
  function pagerPageCount(doc, sourceUrl, sitePage) {
    const groups = [...doc.querySelectorAll('.singlepager .spgr')];
    if (!groups.length) return null;
    let ranges;
    for (const group of groups) {
      const entries = [...group.children];
      if (!entries.length || entries.length > MAX_SITE_PAGES) return null;
      const currentRanges = [];
      let last = 0, selected = 0;
      for (const [index, entry] of entries.entries()) {
        const match = entry.textContent.trim().match(/^([1-9]\d*)\s*-\s*([1-9]\d*)ページ$/u);
        if (!match) return null;
        const start = Number(match[1]), end = Number(match[2]);
        if (start !== last + 1 || end < start || end > MAX_IMAGES) return null;
        if (entry.tagName === 'SPAN') {
          if (index + 1 !== sitePage) return null;
          selected++;
        } else if (entry.tagName === 'A') {
          if (index + 1 === sitePage) return null;
          try {
            const url = new URL(entry.getAttribute('href'), sourceUrl);
            if (url.origin !== new URL(sourceUrl).origin || canonicalWorkUrl(url.href) !== sourceUrl) return null;
            const part = decodeURIComponent(url.pathname).replace(/\/+$/u, '').match(/\/page\/([1-9]\d*)$/u);
            if (Number(part?.[1] || 1) !== index + 1) return null;
          } catch { return null; }
        } else return null;
        currentRanges.push([start, end]);
        last = end;
      }
      if (selected !== 1 || (ranges && JSON.stringify(currentRanges) !== JSON.stringify(ranges))) return null;
      ranges = currentRanges;
    }
    // The site's count table can be blank or stale. Its numbered page-range
    // navigation is usable only when every range and same-work link agrees.
    return ranges.at(-1)[1];
  }
  function extractDocument(doc, pageUrl) {
    if (!doc.querySelector('#cif')) return null;
    const sourceUrl = canonicalWorkUrl(pageUrl);
    const marker = doc.querySelector('#content[data]');
    const id = marker?.getAttribute('data');
    const title = doc.querySelector('main h1, h1')?.textContent.trim();
    if (!id || !/^\d{1,12}$/.test(id) || !title || title.length > 500) throw new Error('作品情報を確認できません。');
    const urlPage = decodeURIComponent(new URL(pageUrl).pathname).match(/\/page\/(\d+)\/?$/)?.[1];
    const sitePage = Number(marker.getAttribute('page') || urlPage || 1);
    if (!Number.isInteger(sitePage) || sitePage < 1 || sitePage > MAX_SITE_PAGES || sitePage !== Number(urlPage || 1)) throw new Error('ページ番号が不正です。');
    const pagerTotal = pagerPageCount(doc, sourceUrl, sitePage);
    let totalPages = pagerTotal;
    let hasTotal = false;
    for (const row of doc.querySelectorAll('table.data tr')) {
      if (row.querySelector('th')?.textContent.trim() === '全ページ数') {
        hasTotal = true;
        if (pagerTotal === null) totalPages = Number(row.querySelector('td')?.textContent.replace(/[,\s]/g, '').match(/^(\d+)ページ/)?.[1]);
      }
    }
    // Older markup has no numbered ranges and includes the total only on page 1.
    if (pagerTotal === null && ((hasTotal && (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > MAX_IMAGES)) || (!hasTotal && sitePage === 1))) throw new Error('全ページ数を確認できません。');
    const pages = [];
    const seen = new Set();
    for (const img of doc.querySelectorAll('#cif .iw img')) {
      const number = Number(img.id.match(/^c([1-9]\d*)$/)?.[1]);
      if (!number) continue; // advertisements do not have comic-page IDs
      const candidate = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src');
      const url = candidate && imageUrl(candidate, pageUrl);
      if (!url || number > (totalPages || MAX_IMAGES) || seen.has(number)) throw new Error('漫画画像の情報が不正です。');
      seen.add(number);
      pages.push({ number, url });
    }
    if (!pages.length) throw new Error('漫画画像を確認できません。');
    pages.sort((a, b) => a.number - b.number);
    const links = new Set();
    for (const a of doc.querySelectorAll('.singlepager .spgr a[href], .nx a[href], a.nxl[href]')) {
      try {
        const url = new URL(a.getAttribute('href'), pageUrl);
        if (url.origin !== new URL(sourceUrl).origin || canonicalWorkUrl(url.href) !== sourceUrl) continue;
        const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
        const match = path.match(/\/page\/([1-9]\d*)$/);
        if (match && Number(match[1]) <= MAX_SITE_PAGES) {
          url.pathname = path + '/'; url.search = ''; url.hash = '';
          links.add(url.href);
        } else if (!match) links.add(sourceUrl);
      } catch { /* Ignore links outside this work. */ }
    }
    return { id, title, sourceUrl, sitePage, pages, totalPages, chapterLinks: [...links] };
  }
  async function defaultFetchPage(url, { signal }) {
    const timeout = AbortSignal.timeout(20000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, { credentials: 'same-origin', signal: combined, redirect: 'error' });
    if (!response.ok) throw new Error('作品ページの取得に失敗しました。再取得をお試しください。');
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('作品ページの形式が変わっています。');
    const html = await response.text();
    if (html.length > 4_000_000) throw new Error('作品ページが大きすぎます。');
    return html;
  }
  async function collectWork(doc, pageUrl, options = {}) {
    let first = extractDocument(doc, pageUrl);
    if (!first) return null;
    const initialPage = first.pages[0].number;
    const fetchPage = options.fetchPage || defaultFetchPage;
    const signal = options.signal;
    const numbered = new Map(first.pages.map(p => [p.number, p]));
    const visited = new Set();
    const currentUrl = new URL(pageUrl);
    currentUrl.pathname = decodeURIComponent(currentUrl.pathname).replace(/\/+$/, '') + '/';
    currentUrl.search = ''; currentUrl.hash = '';
    visited.add(first.sitePage === 1 ? first.sourceUrl : currentUrl.href);
    const pending = [first.sourceUrl, ...first.chapterLinks];
    // Starting from page 2+ needs the authoritative first-page metadata.
    if (first.totalPages === null) {
      signal?.throwIfAborted();
      const html = await fetchPage(first.sourceUrl, { signal });
      if (typeof html !== 'string' || html.length > 4_000_000) throw new Error('作品ページの形式が不正です。');
      const anchor = extractDocument(new DOMParser().parseFromString(html, 'text/html'), first.sourceUrl);
      if (!anchor || anchor.sitePage !== 1 || anchor.id !== first.id || anchor.title !== first.title || !anchor.totalPages) throw new Error('同じ作品のページを確認できません。再取得をお試しください。');
      first = { ...first, totalPages: anchor.totalPages };
      for (const page of anchor.pages) {
        if (numbered.has(page.number) && numbered.get(page.number).url !== page.url) throw new Error('ページの重複を確認しました。');
        numbered.set(page.number, page);
      }
      visited.add(first.sourceUrl);
      pending.push(...anchor.chapterLinks);
    }
    options.onProgress?.(numbered.size, first.totalPages);
    while (pending.length) {
      signal?.throwIfAborted();
      const url = pending.shift();
      if (visited.has(url)) continue;
      if (visited.size >= MAX_SITE_PAGES) throw new Error('作品ページが多すぎます。');
      visited.add(url);
      const html = await fetchPage(url, { signal });
      if (typeof html !== 'string' || html.length > 4_000_000) throw new Error('作品ページの形式が不正です。');
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const part = extractDocument(parsed, url);
      if (!part || part.id !== first.id || part.title !== first.title || (part.totalPages !== null && part.totalPages !== first.totalPages)) {
        throw new Error('同じ作品のページを確認できません。再取得をお試しください。');
      }
      for (const page of part.pages) {
        if (page.number > first.totalPages) throw new Error('漫画画像の情報が不正です。');
        if (numbered.has(page.number) && numbered.get(page.number).url !== page.url) throw new Error('ページの重複を確認しました。');
        numbered.set(page.number, page);
      }
      pending.push(...part.chapterLinks.filter(link => !visited.has(link)));
      options.onProgress?.(numbered.size, first.totalPages);
    }
    const pages = [...numbered.values()].sort((a, b) => a.number - b.number);
    if (pages.length !== first.totalPages || pages.some((p, i) => p.number !== i + 1) || new Set(pages.map(p => p.url)).size !== pages.length) {
      throw new Error('全ページを取得できませんでした。再取得をお試しください。');
    }
    return { ...first, pages, initialPage };
  }
  const api = { canonicalWorkUrl, imageUrl, extractDocument, collectWork, MAX_IMAGES, MAX_SITE_PAGES };
  root.MomonijiExtract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
