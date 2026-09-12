(() => {
  // Vue's rendered component props contain the URL even before a row is played.
  // Only inspect components attached to this page, never follow folder links.
  function collect() {
    const items = [];
    const visited = new Set();
    function visit(vnode) {
      if (!vnode || typeof vnode !== 'object' || visited.has(vnode)) return;
      visited.add(vnode);
      const component = vnode.component;
      const type = component?.type?.__name || vnode.type?.__name;
      if (type === 'VideoRow' || type === 'VideoPlayer') {
        const item = component?.props?.item || component?.props?.video || vnode.props?.item || vnode.props?.video;
        if (item && !item.isFolder) items.push({url: item.url || '', name: item.name || '動画', thumbnail: item.coverImage || item.cover || ''});
      }
      if (component?.subTree) visit(component.subTree);
      if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
      if (vnode.suspense?.activeBranch) visit(vnode.suspense.activeBranch);
    }
    // The root vnode exists in Vue production builds, unlike __vueParentComponent.
    visit(document.querySelector('#app')?._vnode);
    // Also support ordinary video elements and direct video links on older pages.
    for (const el of document.querySelectorAll('video, a[href]')) {
      if (el.closest('.video-row, .player-view')) continue;
      const url = el.tagName === 'VIDEO' ? el.currentSrc || el.src || el.querySelector('source')?.src : el.href;
      if (!url || (el.tagName === 'A' && !/\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url))) continue;
      items.push({ url, name: el.getAttribute('title') || el.textContent.trim().slice(0, 100) || '動画', thumbnail: el.poster || el.querySelector('img')?.src || '' });
    }
    const unique = new Map();
    for (const item of items) {
      try {
        const url = new URL(item.url, location.href);
        if (!item.url || !['https:', 'http:'].includes(url.protocol)) continue;
        unique.set(url.href, { ...item, url: url.href });
      } catch { /* Not a downloadable URL. */ }
    }
    window.postMessage({ type: 'tweetfile-videos', page: location.href, items: [...unique.values()] }, location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.data?.type === 'tweetfile-scan') collect();
  });
})();
