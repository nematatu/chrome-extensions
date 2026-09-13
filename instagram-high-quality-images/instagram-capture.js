(() => {
  'use strict';
  const SOURCE = 'instagram-hq-capture';
  const history = [];
  const nativeFetch = window.fetch;
  const learnedHeaders = new Headers();
  function mediaFrom(value) {
    const found = [], seen = new WeakSet(), stack = [{value,owner:''}];
    while (stack.length) {
      const entry = stack.pop(), current = entry.value;
      if (!current || typeof current !== 'object' || seen.has(current)) continue;
      seen.add(current);
      const owner = current.user?.username || current.owner?.username || entry.owner || '';
      if ((current.pk || current.id || current.code) && (current.image_versions2 || current.video_versions || current.video_resources || current.carousel_media || current.display_url || current.video_url)) {
        found.push({...current,__instagramHqOwner:owner});
      }
      if (Array.isArray(current)) stack.push(...current.map(child => ({value:child,owner})));
      else for (const child of Object.values(current)) if (child && typeof child === 'object') stack.push({value:child,owner});
    }
    return found;
  }
  function publish(value,url = '') {
    const media = mediaFrom(value);
    const storyMedia = media.filter(item => /GraphStory(Image|Video)/i.test(item.__typename || '') || item.expiring_at || item.video_resources || item.reel_mentions || item.story_polls);
    if (media.length) {
      const storyPage = location.pathname.startsWith('/stories/');
      const storyResponse = !url
        ? storyPage
        : /reels_media|17873473675158481|\/story(?:\/|\?)/i.test(String(url)) || (storyPage && storyMedia.length > 0);
      const storyParts = location.pathname.split('/').filter(Boolean);
      const storyKey = storyResponse && storyPage ? (storyParts[1] === 'highlights' ? `highlight:${storyParts[2] || ''}` : `account:${storyParts[1] || ''}`) : '';
      const storyOwner = storyResponse && storyPage && storyParts[1] !== 'highlights' ? storyParts[1] : '';
      const message = {source:SOURCE,category:storyResponse ? 'stories' : 'posts',storyKey,storyOwner,media:storyResponse && storyMedia.length ? storyMedia : media};
      history.push(message);
      if (history.length > 100) history.shift();
      window.postMessage(message,location.origin);
    }
  }
  function shortcodeId(code) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    if (!/^[A-Za-z0-9_-]+$/.test(code || '')) throw new Error('投稿IDが不正です。');
    let value = 0n;
    for (const character of String(code || '')) {
      const digit = alphabet.indexOf(character);
      if (digit < 0) throw new Error('投稿IDを変換できませんでした。');
      value = value * 64n + BigInt(digit);
    }
    return String(value);
  }
  function apiHeaders() {
    const headers = new Headers({'X-Requested-With':'XMLHttpRequest'});
    headers.set('X-IG-App-ID',learnedHeaders.get('x-ig-app-id') || '936619743392459');
    const csrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    if (csrf) headers.set('X-CSRFToken',decodeURIComponent(csrf));
    for (const name of ['x-asbd-id','x-ig-www-claim']) if (learnedHeaders.has(name)) headers.set(name,learnedHeaders.get(name));
    return headers;
  }
  async function apiRequest(request) {
    let url, options = {credentials:'include',headers:apiHeaders()};
    if (request.kind === 'post') {
      url = `/api/v1/media/${shortcodeId(request.shortcode)}/info/`;
    } else if (request.kind === 'profile') {
      if (!/^[\w.]+$/.test(request.username || '')) throw new Error('アカウント名が不正です。');
      url = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(request.username)}`;
    } else if (request.kind === 'account-feed') {
      if (!/^\d+$/.test(request.userId || '')) throw new Error('アカウントIDが不正です。');
      const params = new URLSearchParams({count:'50'});
      if (request.maxId) params.set('max_id',request.maxId);
      url = `/api/v1/feed/user/${request.userId}/?${params}`;
    } else if (request.kind === 'account-clips') {
      if (!/^\d+$/.test(request.userId || '')) throw new Error('アカウントIDが不正です。');
      url = '/api/v1/clips/user/';
      const body = new URLSearchParams({target_user_id:request.userId,page_size:'50',include_feed_video:'true'});
      if (request.maxId) body.set('max_id',request.maxId);
      options = {...options,method:'POST',body};
    } else {
      throw new Error('許可されていない取得要求です。');
    }
    const response = await nativeFetch.call(window,url,options);
    if (!response.ok) throw new Error(`Instagram API HTTP ${response.status}`);
    const data = await response.json();
    publish(data,response.url);
    return data;
  }
  window.addEventListener('message',event => {
    if (event.source !== window) return;
    if (event.data?.source === 'instagram-hq-capture-request') {
      for (const message of history) window.postMessage(message,location.origin);
      return;
    }
    if (event.data?.source === 'instagram-hq-api-request' && typeof event.data.id === 'string') {
      apiRequest(event.data.request).then(
        data => window.postMessage({source:'instagram-hq-api-response',id:event.data.id,data},location.origin),
        error => window.postMessage({source:'instagram-hq-api-response',id:event.data.id,error:error.message},location.origin)
      );
    }
  });
  window.fetch = async function (...args) {
    try {
      const request = new Request(...args);
      for (const name of ['x-ig-app-id','x-asbd-id','x-ig-www-claim']) {
        const value = request.headers.get(name);
        if (value) learnedHeaders.set(name,value);
      }
    } catch {}
    const response = await nativeFetch.apply(this,args);
    response.clone().json().then(data => publish(data,response.url)).catch(() => {});
    return response;
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...args) { this.__instagramHqUrl = String(args[1] || ''); return nativeOpen.apply(this,args); };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load',() => {
      try { publish(JSON.parse(this.responseText),this.__instagramHqUrl); } catch {}
    },{once:true});
    return nativeSend.apply(this,args);
  };
  function scanScripts() {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try { publish(JSON.parse(script.textContent)); } catch {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',scanScripts,{once:true});
  else scanScripts();
})();
