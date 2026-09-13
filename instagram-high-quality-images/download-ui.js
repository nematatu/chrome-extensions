(() => {
  'use strict';
  const core = InstagramDownloadCore;
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>';
  const bulkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v9m-3-3 3 3 3-3M3 15v3h8v-3M17 6v9m-3-3 3 3 3-3M13 18v3h8v-3"/></svg>';
  const host = document.createElement('div');
  host.id = 'instagram-hq-download-ui';
  host.setAttribute('popover','manual');
  host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;color:#fff;font:13px system-ui;';
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = `<style>
    *{box-sizing:border-box}button{font:inherit;cursor:pointer;pointer-events:auto;border:1px solid #ffffff50;border-radius:8px;background:#20222be8;color:#fff;padding:8px 12px}button:hover{background:#353947}button:focus-visible{outline:3px solid #82d7ff;outline-offset:2px}.media-button{position:fixed;display:grid;place-items:center;width:36px;height:36px;padding:8px;border-radius:50%}svg{width:20px;height:20px}.profile-bulk{display:inline-flex!important;align-items:center;gap:6px}.profile-bulk svg{width:18px;height:18px}[hidden]{display:none!important}
  </style><div class="media-buttons"></div>`;
  document.documentElement.append(host); host.showPopover();
  const $ = selector => root.querySelector(selector);
  let scheduled = false, lastRoute = location.href;
  const overlays = new Map(), toolbarButtons = new Set(), gridOverlays = new Map();
  const jobStates = new Map(), toasts = new Map();
  const capturedStories = new Map();
  let capturedStoryKey = '';
  let accountButton = null;
  window.addEventListener('message',event => {
    if (event.source !== window || event.data?.source !== 'instagram-hq-capture' || !Array.isArray(event.data.media)) return;
    const storyCapture = event.data.category === 'stories';
    if (storyCapture && event.data.storyKey && event.data.storyKey !== capturedStoryKey) {
      capturedStories.clear();
      capturedStoryKey = event.data.storyKey;
    }
    if (!storyCapture) return;
    const target = capturedStories;
    for (const post of event.data.media) {
      const key = String(post?.code || post?.pk || post?.id || '');
      if (key) target.set(key,storyCapture ? {post,owner:post.__instagramHqOwner || event.data.storyOwner || ''} : post);
    }
    host.dataset.capturedStories = String(capturedStories.size);
  });
  window.postMessage({source:'instagram-hq-capture-request'},location.origin);
  function button(label, className = '') {
    const el = document.createElement('button'); el.type = 'button'; el.className = className;
    el.innerHTML = icon; el.title = label; el.setAttribute('aria-label',label); return el;
  }
  const storyTools = document.createElement('div');
  storyTools.className = 'instagram-hq-story-tools';
  const storySingle = button('このストーリーを保存','instagram-hq-story-single');
  const storyAll = button('この相手のストーリーを一括保存','instagram-hq-story-all');
  storyAll.innerHTML = bulkIcon;
  storyTools.append(storySingle, storyAll);
  let activeStoryMedia = null;
  storySingle.onclick = event => {
    event.preventDefault(); event.stopPropagation();
    const context = storyContext();
    const current = activeStoryMedia || storyMedia();
    if (context && current) start({mode:'story',...context,target:mediaTarget(current)});
  };
  storyAll.onclick = event => {
    event.preventDefault(); event.stopPropagation();
    const context = storyContext();
    if (!context) return;
    const targets = capturedStoryTargets(context.username);
    const current = activeStoryMedia || storyMedia();
    if (current) {
      const target = mediaTarget(current);
      if (!targets.some(item => item.url === target.url || (target.mediaId && item.mediaId === target.mediaId))) targets.push(target);
    }
    start({mode:'stories',...context,targets});
  };
  function storyContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'stories' || !parts[1]) return null;
    return parts[1] === 'highlights' ? {highlightId:parts[2]} : {username:parts[1],storyId:parts[2]};
  }
  function profilePage() { return core.profileName(location.pathname); }
  function shortcode(el) {
    const link = el.closest('a[href*="/p/"],a[href*="/reel/"]');
    const container = el.closest('article') || el.closest('[role="dialog"]');
    const href = link?.getAttribute('href') || container?.querySelector('a[href*="/p/"],a[href*="/reel/"]')?.getAttribute('href') || location.pathname;
    return href.match(/\/(?:p|reel)\/([^/?]+)/)?.[1] || InstagramHQPage.postShortcode(el);
  }
  function mediaTarget(el) {
    const type = el.tagName === 'VIDEO' ? 'video' : 'image';
    const current = el.currentSrc || '';
    const source = el.src || '';
    const url = core.allowedMediaUrl(current) ? current : source;
    let mediaId = type === 'image' ? InstagramHQPage.imageMediaId(el) : null;
    const routeIndex = Number(new URLSearchParams(location.search).get('img_index'));
    const container = el.closest('article,[role="dialog"],main');
    const username = storyContext()?.username || container?.querySelector('header a[href^="/"]')?.getAttribute('href')?.match(/^\/([\w.]+)\/?/)?.[1] || 'instagram';
    const siblings = container ? [...container.querySelectorAll('img,video')].filter(candidate => eligible(candidate, false)) : [];
    const index = routeIndex || Math.max(1, siblings.indexOf(el) + 1);
    const best = type === 'image' ? InstagramHighQualityCore.largestCandidate([el.getAttribute('srcset') || ''],url)?.url : url;
    return {type,url:best,mediaId,index,username};
  }
  function targetsFromPost(post,username,category = 'posts') {
    try { return core.media(post,{username,category}).map(item => ({...item,mediaId:item.id})); }
    catch { return []; }
  }
  function capturedStoryTargets(username) {
    const targets = [], seen = new Set();
    for (const entry of capturedStories.values()) {
      const post = entry.post;
      const owner = entry.owner || username;
      if (username && owner && owner.toLowerCase() !== username.toLowerCase()) continue;
      for (const item of targetsFromPost(post,owner,'stories')) if (!seen.has(item.id)) { seen.add(item.id); targets.push(item); }
    }
    return targets;
  }
  async function accountTargets(username,onProgress) {
    const posts = await InstagramHQApi.account(username,onProgress);
    const targets = [], seen = new Set();
    for (const post of posts) {
      for (const item of targetsFromPost(post,username)) if (!seen.has(item.id)) { seen.add(item.id); targets.push(item); }
    }
    return targets;
  }
  async function postApiTargets(code) {
    const post = await InstagramHQApi.post(code);
    const targets = targetsFromPost(post,post?.user?.username || post?.owner?.username);
    if (!targets.length) throw new Error('投稿APIから保存対象を取得できませんでした。');
    return targets;
  }
  function toastTitle(mode) {
    if (mode === 'account') return 'アカウント全投稿';
    if (mode === 'stories') return 'ストーリー一括';
    if (mode === 'story') return 'ストーリー';
    if (mode === 'post') return '投稿一括';
    return 'メディア';
  }
  function makeToast(id,mode,phase = '準備中…') {
    const node = document.createElement('div');
    node.className = 'instagram-hq-toast-content';
    const top = document.createElement('div'); top.className = 'instagram-hq-toast-top';
    const title = document.createElement('strong'); title.textContent = toastTitle(mode);
    const percent = document.createElement('span'); percent.className = 'instagram-hq-toast-percent'; percent.textContent = '0%';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '停止'; cancel.setAttribute('aria-label',`${toastTitle(mode)}を停止`);
    const status = document.createElement('span'); status.className = 'instagram-hq-toast-phase'; status.setAttribute('role','status'); status.textContent = phase;
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label','保存の進捗');
    const count = document.createElement('span'); count.className = 'instagram-hq-toast-count'; count.textContent = '0 / 0';
    top.append(title,percent,cancel); node.append(top,status,progress,count);
    const instance = Toastify({node,duration:-1,gravity:'bottom',position:'right',stopOnFocus:true,className:'instagram-hq-toast-shell'});
    instance.showToast();
    const view = {id,mode,node,title,percent,cancel,status,progress,count,instance,timer:null};
    cancel.onclick = async () => {
      cancel.disabled = true; status.textContent = '停止しています…';
      try { await chrome.runtime.sendMessage({type:'instagram-hq-cancel',jobId:id}); }
      catch (error) { status.textContent = error.message; cancel.disabled = false; }
    };
    toasts.set(id,view);
    return view;
  }
  function removeToast(id,delay = 0) {
    const view = toasts.get(id);
    if (!view) return;
    clearTimeout(view.timer);
    view.timer = setTimeout(() => { view.instance.hideToast(); toasts.delete(id); },delay);
  }
  function preparation(mode) {
    const id = `preparing-${crypto.randomUUID()}`;
    const view = makeToast(id,mode,'Instagramから取得中…');
    view.progress.removeAttribute('value'); view.percent.textContent = ''; view.count.textContent = '';
    view.cancel.hidden = true;
    return {
      update(text) { view.status.textContent = text; },
      fail(error) { view.status.textContent = error.message; view.node.classList.add('is-error'); removeToast(id,8000); },
      done() { removeToast(id); }
    };
  }
  async function start(job) {
    try {
      const result = await chrome.runtime.sendMessage({type:'instagram-hq-start',job});
      if (!result || result.error) throw new Error(result?.error || '拡張機能を再読み込みしてください。');
      show(result.state);
      return result.state;
    } catch (error) {
      const pending = preparation(job.mode); pending.fail(error);
      return null;
    }
  }
  function show(state) {
    if (!state) return;
    jobStates.set(state.id,state);
    const view = toasts.get(state.id) || makeToast(state.id,state.mode,state.phase);
    clearTimeout(view.timer);
    const percent = state.total ? Math.floor(state.processed/state.total*100) : 0;
    view.progress.value = percent; view.percent.textContent = `${percent}%`;
    view.count.textContent = `${state.processed} / ${state.total}`;
    view.status.textContent = state.phase;
    view.cancel.hidden = !state.active;
    view.node.classList.toggle('is-error',!!state.failed || !!state.stopped);
    if (!state.active) removeToast(state.id,state.failed || state.stopped ? 8000 : 1600);
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 160 && r.height >= 160 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && getComputedStyle(el).visibility !== 'hidden';
  }
  function eligible(el, story) {
    if (!visible(el) || el.closest('header,nav') || el.closest('#instagram-hq-download-ui')) return false;
    if (story) return el.tagName === 'VIDEO' || el.tagName === 'IMG';
    if (el.tagName === 'IMG') return InstagramHQPage.isPostImage(el);
    return el.duration !== Infinity && !InstagramHighQualityCore.isInstagramLivePath(location.pathname) && !!shortcode(el) && !!el.closest('article,main,[role="dialog"]');
  }
  function insertPostButtons() {
    const nativeButtons = new Set();
    const shortcodes = new Set();
    const scopes = [...document.querySelectorAll('article,[role="dialog"]')].filter(scope => {
      const rect = scope.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    for (const scope of scopes) {
      const controls = [...scope.querySelectorAll('button,[role="button"]')].filter(native => {
        if (native.closest('#instagram-hq-download-ui,.instagram-hq-bulk')) return false;
        const rect = native.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) return false;
        const label = `${native.getAttribute('aria-label') || ''} ${native.getAttribute('title') || ''} ${native.textContent || ''}`;
        const iconLabel = [...native.querySelectorAll('svg[aria-label]')].map(svg => svg.getAttribute('aria-label')).join(' ');
        return /(^|\s)(save|saved|保存|保存済み|保存する|保存を削除)(\s|$)/i.test(`${label} ${iconLabel}`);
      });
      for (const native of controls) {
      const code = shortcode(native);
      if (!code || shortcodes.has(code)) continue;
      shortcodes.add(code);
      nativeButtons.add(native);
      let entry = [...toolbarButtons].find(b => b.native === native);
      if (!entry) {
        entry = button('投稿の画像・動画を一括保存','instagram-hq-bulk instagram-hq-post-bulk'); entry.native = native;
        entry.innerHTML = bulkIcon;
        if (typeof native.className === 'string') entry.className = `${native.className} instagram-hq-bulk instagram-hq-post-bulk`;
        entry.addEventListener('click',async event => {
          event.preventDefault(); event.stopPropagation();
          const code = shortcode(native);
          const loading = preparation('post');
          try {
            const targets = await postApiTargets(code);
            loading.done();
            await start({mode:'post',shortcode:code,targets});
          } catch (error) { loading.fail(error); }
        });
        let container = native.parentElement;
        for (let node = native.parentElement; node && node !== scope; node = node.parentElement) {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if ((style.display === 'flex' || style.display === 'inline-flex') && style.flexDirection !== 'column' && rect.height <= 96 && rect.width > native.getBoundingClientRect().width) {
            container = node; break;
          }
        }
        const direct = native.parentElement === container ? native : [...container.children].find(child => child.contains(native));
        container?.insertBefore(entry, direct || native);
        toolbarButtons.add(entry);
      }
      }
    }
    for (const entry of toolbarButtons) if (!entry.isConnected || !nativeButtons.has(entry.native)) { entry.remove(); toolbarButtons.delete(entry); }
  }
  function engagementText(anchor) {
    const text = anchor.getAttribute('aria-label') || anchor.textContent || '';
    const likes = text.match(/([\d,.万千]+)\s*(?:likes?|いいね)/i)?.[0] || '';
    const comments = text.match(/([\d,.万千]+)\s*(?:comments?|コメント)/i)?.[0] || '';
    return [likes, comments].filter(Boolean).join(' · ') || '投稿を一括保存';
  }
  function insertGridDownload(anchor) {
    if (gridOverlays.has(anchor)) return;
    const save = button('この投稿の画像・動画を一括保存','instagram-hq-grid-save');
    save.innerHTML = bulkIcon;
    save.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      const code = anchor.getAttribute('href')?.match(/\/(?:p|reel)\/([^/?]+)/)?.[1];
      const loading = preparation('post');
      try {
        const targets = await postApiTargets(code);
        loading.done();
        await start({mode:'post',shortcode:code,targets});
      } catch (error) { loading.fail(error); }
    });
    // Instagram already renders the black hover layer and the likes/comments
    // row. Add only our save button to the post link so it can sit directly
    // underneath that native row instead of creating a competing overlay.
    anchor.append(save); gridOverlays.set(anchor, save);
  }
  function scanGrid() {
    const keep = new Set();
    if (!profilePage()) { for (const [anchor, save] of gridOverlays) { save.remove(); gridOverlays.delete(anchor); } return; }
    for (const anchor of document.querySelectorAll('main a[href*="/p/"],main a[href*="/reel/"]')) {
      if (!anchor.querySelector('img,video') || anchor.closest('[role="dialog"]')) continue;
      keep.add(anchor); insertGridDownload(anchor);
    }
    for (const [anchor, save] of gridOverlays) if (!keep.has(anchor) || !anchor.isConnected) { save.remove(); gridOverlays.delete(anchor); }
  }
  function currentPostMedia(media) {
    if (media.length <= 1) return media;
    const routeIndex = /\/(?:p|reel)\/[^/]+/.test(location.pathname) ? Number(new URLSearchParams(location.search).get('img_index')) : 0;
    const active = media.filter(el => !el.closest('[aria-hidden="true"]'));
    if (routeIndex > 0 && active[routeIndex - 1]) return [active[routeIndex - 1]];
    media = active.length ? active : media;
    const visible = media.map(el => {
      const r = el.getBoundingClientRect();
      const width = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const height = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      let opacity = 1;
      for (let node = el; node && opacity > .05; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') opacity = 0;
        else opacity *= Number(style.opacity || 1);
      }
      return {el, area: width * height, distance: Math.abs((r.left + r.right) / 2 - innerWidth / 2), opacity};
    }).filter(item => item.area > 0 && item.opacity > 0.05).sort((a,b) => b.area - a.area || a.distance - b.distance);
    // A neighboring carousel slide can still have a small visible edge. The
    // largest visible area is the slide the user is currently viewing.
    return visible.length ? [visible[0].el] : [];
  }
  function currentMediaPerPost(media) {
    const groups = new Map();
    for (const el of media) {
      const container = el.closest('[role="dialog"],article') || el.closest('main') || document.body;
      if (!groups.has(container)) groups.set(container, []);
      groups.get(container).push(el);
    }
    return [...groups.values()].flatMap(currentPostMedia);
  }
  function storyMedia() {
    return [...document.querySelectorAll('img,video')].filter(el => eligible(el, true)).sort((a,b) => {
      const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
      const score=r => r.width*r.height-Math.abs((r.left+r.right)/2-innerWidth/2);
      return score(br)-score(ar);
    })[0] || null;
  }
  function positionStoryTools(media) {
    activeStoryMedia = media || null;
    if (!media) { storyTools.remove(); return; }
    const mediaRect = media.getBoundingClientRect();
    const visibleIcons = [...document.querySelectorAll('svg')].filter(svg => {
      if (svg.closest('.instagram-hq-story-tools,#instagram-hq-download-ui')) return false;
      const rect = svg.getBoundingClientRect();
      return rect.width >= 12 && rect.width <= 56 && rect.height >= 12 && rect.height <= 56 && rect.top >= Math.max(0,mediaRect.top - 140) && rect.top <= mediaRect.top + 160 && rect.left >= mediaRect.left + mediaRect.width * .35 && rect.right <= mediaRect.right + 180;
    });
    const iconRows = [];
    for (const svg of visibleIcons) {
      const rect = svg.getBoundingClientRect();
      let row = iconRows.find(items => Math.abs(items[0].getBoundingClientRect().top - rect.top) < 16);
      if (!row) { row = []; iconRows.push(row); }
      row.push(svg);
    }
    const bestRow = iconRows.filter(row => row.length >= 2).sort((a,b) => {
      const ar = a.map(svg => svg.getBoundingClientRect()), br = b.map(svg => svg.getBoundingClientRect());
      const aRight = Math.max(...ar.map(rect => rect.right)), bRight = Math.max(...br.map(rect => rect.right));
      const aDistance = Math.abs(mediaRect.right - aRight), bDistance = Math.abs(mediaRect.right - bRight);
      return b.length - a.length || aDistance - bDistance;
    })[0];
    let anchorLeft = mediaRect.right - 112;
    let anchorTop = Math.max(8,mediaRect.top + 16);
    let anchorHeight = 32;
    if (bestRow) {
      const rects = bestRow.map(svg => svg.getBoundingClientRect());
      anchorLeft = Math.min(...rects.map(rect => rect.left));
      anchorTop = Math.min(...rects.map(rect => rect.top));
      anchorHeight = Math.max(...rects.map(rect => rect.height));
    }
    if (storyTools.parentElement !== document.body) document.body.append(storyTools);
    storyTools.style.left = `${Math.max(8,anchorLeft - 76)}px`;
    storyTools.style.top = `${Math.max(8,anchorTop + (anchorHeight - 32) / 2)}px`;
  }
  function scan() {
    scheduled = false;
    if (lastRoute !== location.href) {
      lastRoute = location.href; accountButton?.remove(); accountButton = null;
      for (const entry of toolbarButtons) entry.remove(); toolbarButtons.clear();
    }
    const story = storyContext();
    let candidates = [...document.querySelectorAll('img,video')].filter(el => eligible(el,story));
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el => candidates.some(media => el.contains(media)));
    if (dialog) candidates = candidates.filter(el => dialog.contains(el));
    // Do not draw a second button over the poster beneath a video.
    let media = candidates.filter(el => el.tagName !== 'IMG' || !candidates.some(video => {
      if (video.tagName !== 'VIDEO') return false;
      const a = el.getBoundingClientRect(), b = video.getBoundingClientRect();
      return Math.abs(a.left-b.left)<8 && Math.abs(a.top-b.top)<8 && Math.abs(a.width-b.width)<16;
    }));
    if (story && media.length > 1) {
      // Story viewers render neighboring accounts too. Only the largest, central
      // viewer belongs to the current route and must receive save controls.
      media.sort((a,b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        const score = r => r.width*r.height - Math.abs((r.left+r.right)/2-innerWidth/2);
        return score(br)-score(ar);
      });
      media = media.slice(0,1);
    }
    if (story) media = media.slice(0, 1);
    if (!story) media = currentMediaPerPost(media);
    if (profilePage() && !story) media = [];
    for (const [el,b] of overlays) if (!media.includes(el) || story) {b.remove();overlays.delete(el);}
    for (const el of story ? [] : media) {
      let b = overlays.get(el);
      if (!b) {
        b = button(el.tagName === 'VIDEO' ? 'この動画をMP4で保存' : 'この画像を保存','media-button');
        b.onclick = async event => {
          event.preventDefault(); event.stopPropagation();
          const story = storyContext();
          if (story) { await start({mode:'story',...story,target:mediaTarget(el)}); return; }
          const code = shortcode(el), target = mediaTarget(el), loading = preparation('single');
          try {
            const targets = await postApiTargets(code);
            const selected = core.select(targets,target);
            loading.done();
            await start({mode:'single',shortcode:code,target:selected});
          } catch (error) { loading.fail(error); }
        };
        $('.media-buttons').append(b); overlays.set(el,b);
      }
      const r = el.getBoundingClientRect();
      b.style.left = `${Math.max(4,Math.min(innerWidth-44,r.right-44))}px`;
      b.style.top = `${Math.max(4,r.top+8)}px`;
    }
    positionStoryTools(story ? media[0] : null);
    scanGrid();
    insertPostButtons();
    const username = profilePage();
    const main = document.querySelector('main');
    const header = main?.querySelector('header');
    const follow = header && [...header.querySelectorAll('button,[role="button"]')].find(button => /フォロー|follow|メッセージ|message/i.test(button.textContent || button.getAttribute('aria-label') || ''));
    if (username && (header || main) && !accountButton?.isConnected) {
      accountButton = button('このアカウントの全投稿を保存','instagram-hq-bulk instagram-hq-account profile-bulk');
      accountButton.innerHTML = bulkIcon;
      const text = document.createElement('span');text.textContent = '全投稿を保存';accountButton.append(text);
      accountButton.onclick = async event => {
        event.preventDefault(); event.stopPropagation();
        const loading = preparation('account');
        try {
          const targets = await accountTargets(username,(kind,count) => loading.update(`${kind}を取得中: ${count}件`));
          loading.done();
          await start({mode:'account',username,targets});
        } catch (error) { loading.fail(error); }
      };
      const actionGroup = follow?.parentElement;
      if (actionGroup && actionGroup !== header && actionGroup.parentElement) actionGroup.parentElement.insertBefore(accountButton, actionGroup);
      else (follow?.parentElement || header || main).insertBefore(accountButton, follow || header?.firstChild || main.firstChild);
    } else if (accountButton?.isConnected && follow) {
      const actionGroup = follow.parentElement;
      if (actionGroup && actionGroup !== header && accountButton.parentElement !== actionGroup.parentElement) actionGroup.parentElement?.insertBefore(accountButton, actionGroup);
    }
    if ((!username || !header) && accountButton) { accountButton.remove(); accountButton = null; }
  }
  const schedule = () => { if (!scheduled) {scheduled = true;requestAnimationFrame(scan);} };
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset','href','aria-label']});
  window.addEventListener('scroll',schedule,{passive:true,capture:true});
  window.addEventListener('resize',schedule,{passive:true});
  document.addEventListener('loadedmetadata',schedule,true);
  chrome.runtime.onMessage.addListener((message,sender) => { if (sender.id === chrome.runtime.id && message.type === 'instagram-hq-job-update') show(message.state); });
  chrome.runtime.sendMessage({type:'instagram-hq-job-state'}).then(reply => {for (const state of reply?.states || []) if (state.active) show(state);}).catch(() => {});
  setInterval(schedule,1500); scan();
})();
