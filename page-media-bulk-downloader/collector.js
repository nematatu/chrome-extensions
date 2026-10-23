(function (root) {
  'use strict';
  // Self contained: Chrome serializes this function into the clicked tab's isolated world.
  function collectPageMedia(expectedPageUrl) {
    if (typeof expectedPageUrl === 'string' && expectedPageUrl !== location.href) return {ok: false, error: 'PAGE_CHANGED'};
    const VIDEO = /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpeg|mpg)$/i;
    const IMAGE = /\.(jpg|jpeg|png|gif|webp|avif|bmp|heic|heif|tif|tiff|svg)$/i;
    const STREAM = /\.(m3u8|mpd)$/i;
    const items = [], seen = new Set();
    let unsupported = 0, nodes = 0;
    function url(value) {
      if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
      try {
        const parsed = new URL(value, document.baseURI);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
        parsed.hash = ''; return parsed.href;
      } catch { return null; }
    }
    function type(value) {
      const link = url(value);
      if (!link) return null;
      const pathname = new URL(link).pathname;
      return VIDEO.test(pathname) ? 'video' : IMAGE.test(pathname) ? 'image' : null;
    }
    function add(value, kind, name, thumbnail, size = 0) {
      const link = url(value);
      if (!link || STREAM.test(new URL(link).pathname)) { unsupported++; return; }
      if (seen.has(link)) return;
      seen.add(link);
      let fileName = name;
      if (!fileName) {
        try { fileName = decodeURIComponent(new URL(link).pathname.split('/').pop()); }
        catch { fileName = ''; }
      }
      const bytes = Number(size);
      items.push({url: link, kind, name: String(fileName || kind).slice(0, 512), thumbnail: url(thumbnail),
        size: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0});
    }
    function result() {
      const title = String(document.title || '').slice(0, 512);
      return {ok: true, title, pageUrl: location.href, items, unsupported,
        folderId: page.pathname.match(/^\/d\/(\d+)\/?$/)?.[1] || 'Page',
        folderName: title.replace(/^Gofile\s*[-–—]\s*/i, '') || 'Page',
        scannedItems: items.length, totalPages: 1, skipped: [],
        videos: items.map((item, index) => ({id: 'media-' + (index + 1), type: 'file',
          link: item.url, name: item.name, size: item.size, thumbnail: item.thumbnail,
          mimetype: item.kind === 'video' ? 'video/mp4' : 'image/png'}))};
    }
    const page = new URL(location.href);
    if (['https://twfiles.com', 'https://video.twimg1.com', 'https://gofile.run', 'https://gofile.ing',
      'https://video.twimg-film.com', 'https://gofile.es', 'https://cdn4.file-photo.com',
      'https://gofile.guru', 'https://cdn.twimg-image.com', 'https://gofile.pl',
      'https://video.twimg-com.com'].includes(page.origin)) {
      // Return only visible list metadata. The worker builds fixed API requests;
      // neither page globals nor credentials are read from the site's runtime.
      const content = document.querySelector('#app .app-page--content .landing-content');
      if (!content) return {ok: false, error: 'SITE_NOT_READY'};
      const rows = content.querySelectorAll('.content-list .video-row');
      if (rows.length > 10000) return {ok: false, error: 'TOO_MANY_ITEMS'};
      const visibleRows = [];
      let characters = 0;
      for (const row of rows) {
        const name = row.querySelector('.video-copy strong')?.textContent || '';
        if (!name || name.length > 512) return {ok: false, error: 'SITE_LIST_MISMATCH'};
        characters += name.length;
        if (characters > 4 * 1024 * 1024) return {ok: false, error: 'TOO_MUCH_DATA'};
        visibleRows.push({name, isFolder: Boolean(row.querySelector('.video-thumb--folder, .video-icon--folder'))});
      }
      const player = content.querySelector('.player-view');
      const playerName = player?.querySelector('.player-title h1, .player-summary__copy h1')?.textContent || '';
      if (!player && !visibleRows.length) return {ok: false, error: 'SITE_NOT_READY'};
      if (player && (!playerName || playerName.length > 512)) return {ok: false, error: 'SITE_LIST_MISMATCH'};
      return {ok: true, scanType: 'hosted-api', pageUrl: location.href,
        title: String(document.title || '').slice(0, 512), visibleRows, playerName};
    }
    if (page.origin === 'https://video.twimg.news' && /^\/d\/\d+\/?$/.test(page.pathname)) {
      // This folder renders its rows from a JSON array in an inline script.
      // Read that literal as data only; never run the site's JavaScript or follow target links.
      const scripts = document.querySelectorAll('script:not([src])');
      if (scripts.length > 1000) return {ok: false, error: 'TOO_MANY_NODES'};
      let data = null, characters = 0;
      for (const script of scripts) {
        const source = script.textContent || '';
        characters += source.length;
        if (characters > 4 * 1024 * 1024) return {ok: false, error: 'TOO_MUCH_DATA'};
        const declaration = /(?:^|\n)[ \t]*(?:var|let|const)\s+VIDEOS\s*=\s*\[/g;
        let match;
        while ((match = declaration.exec(source))) {
          if (data !== null) return {ok: false, error: 'SITE_DATA_CHANGED'};
          const start = match.index + match[0].length - 1;
          let depth = 0, quoted = false, escaped = false, end = -1;
          for (let index = start; index < source.length; index++) {
            const character = source[index];
            if (quoted) {
              if (escaped) escaped = false;
              else if (character === '\\') escaped = true;
              else if (character === '"') quoted = false;
            } else if (character === '"') quoted = true;
            else if (character === '[') depth++;
            else if (character === ']' && --depth === 0) { end = index + 1; break; }
          }
          if (end < 0 || !/^\s*;/.test(source.slice(end))) return {ok: false, error: 'SITE_DATA_CHANGED'};
          try { data = JSON.parse(source.slice(start, end)); }
          catch { return {ok: false, error: 'SITE_DATA_CHANGED'}; }
          declaration.lastIndex = end;
        }
      }
      if (data === null) return {ok: false, error: 'SITE_DATA_MISSING'};
      if (!Array.isArray(data) || !data.length) return {ok: false, error: 'SITE_DATA_CHANGED'};
      if (data.length > 10000) return {ok: false, error: 'TOO_MANY_ITEMS'};
      const rows = document.querySelectorAll('#fl .fm-row .file-name');
      if (!rows.length) return {ok: false, error: 'SITE_NOT_READY'};
      if (rows.length !== data.length) return {ok: false, error: 'SITE_LIST_MISMATCH'};
      const names = new Map();
      for (const row of rows) {
        const name = row.textContent || '';
        names.set(name, (names.get(name) || 0) + 1);
      }
      for (const entry of data) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            typeof entry.name !== 'string' || !entry.name || entry.name.length > 512 ||
            !names.get(entry.name)) return {ok: false, error: 'SITE_LIST_MISMATCH'};
        names.set(entry.name, names.get(entry.name) - 1);
        if (['srcUrl', 'vidSrc', 'videy', 'videyExt'].some(key =>
          entry[key] != null && typeof entry[key] !== 'string')) return {ok: false, error: 'SITE_FILE_UNSUPPORTED'};
        let link;
        if (entry.srcUrl) link = url(entry.srcUrl);
        else if (entry.videy) {
          if (!/^[A-Za-z0-9]{8,32}$/.test(entry.videy) || (entry.videyExt && entry.videyExt !== 'mp4')) {
            return {ok: false, error: 'SITE_FILE_UNSUPPORTED'};
          }
          link = 'https://cdn.videy.co/' + entry.videy + '.mp4';
        } else if (entry.vidSrc) link = url(entry.vidSrc);
        if (!link) return {ok: false, error: 'SITE_FILE_UNSUPPORTED'};
        const parsed = new URL(link);
        if (parsed.origin !== 'https://cdn.videy.co' || parsed.search ||
            !/^\/[A-Za-z0-9]{8,32}\.mp4$/.test(parsed.pathname)) return {ok: false, error: 'SITE_FILE_UNSUPPORTED'};
        // Embedded preview images and external promotion targets are not original files.
        add(link, 'video', entry.name, null, entry.size);
      }
      return result();
    }
    for (const element of document.querySelectorAll('video, img, a[href]')) {
      if (++nodes > 20000) return {ok: false, error: 'TOO_MANY_NODES'};
      if (element.tagName === 'VIDEO') {
        const candidates = [element.currentSrc, element.getAttribute('src'),
          ...Array.from(element.querySelectorAll('source')).map(source => source.getAttribute('src'))];
        const direct = candidates.map(url).find(link => link && !STREAM.test(new URL(link).pathname));
        if (direct) add(direct, 'video', element.getAttribute('title'), element.getAttribute('poster'));
        else unsupported++;
      } else if (element.tagName === 'A') {
        const link = element.getAttribute('href'), kind = type(link);
        if (kind) add(link, kind, element.getAttribute('download') || '',
          element.querySelector('img')?.currentSrc || element.querySelector('img')?.getAttribute('src'));
        else if (url(link) && STREAM.test(new URL(url(link)).pathname)) unsupported++;
      } else {
        // Gallery thumbnails point at originals: save the linked original once.
        const anchor = element.closest('a[href]');
        if (anchor && type(anchor.getAttribute('href'))) continue;
        const source = [element.currentSrc, element.getAttribute('src'), element.getAttribute('data-src')].find(value => url(value));
        if (source) add(source, 'image', '', source);
        else unsupported++;
      }
      if (items.length > 10000) return {ok: false, error: 'TOO_MANY_ITEMS'};
    }
    return result();
  }
  root.collectPageMedia = collectPageMedia;
  if (typeof module === 'object' && module.exports) module.exports = collectPageMedia;
})(globalThis);
