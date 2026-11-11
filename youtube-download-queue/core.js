// Pure helpers shared by the worker, content script, popup and tests.
(root => {
  'use strict';
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const YOUTUBE_HOST = /^(?:www\.|m\.)?youtube\.com$/;

  function videoId(href, base = 'https://www.youtube.com/') {
    let url;
    try { url = new URL(String(href), base); } catch { return null; }
    let id = null;
    if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
    else if (YOUTUBE_HOST.test(url.hostname)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];
    }
    return VIDEO_ID.test(id || '') ? id : null;
  }

  // Message types exchanged between extension contexts and the worker.
  const MESSAGE = Object.freeze({
    STATE: 'ypq:state',
    CHANGED: 'ypq:changed',
    ADD: 'ypq:add',
    STATUS: 'ypq:status',
    REFRESH: 'ypq:refresh'
  });

  root.YPQCore = Object.freeze({ VIDEO_ID, videoId, MESSAGE });
  if (typeof module === 'object' && module.exports) module.exports = root.YPQCore;
})(globalThis);
