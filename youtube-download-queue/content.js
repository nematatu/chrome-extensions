// Draws the queue mark on YouTube thumbnails and the watch-page title.
// The mark is a one-click add button until the video is queued in links.txt or downloaded.
(() => {
  'use strict';
  const { MESSAGE, videoId } = YPQCore;
  // Every YouTube DOM dependency lives here. `holder` returns the element that carries the mark.
  const THUMBNAILS = [
    { links: 'a#thumbnail, a.ytLockupViewModelContentImage, a.shortsLockupViewModelHostEndpoint', holder: link => link },
    // The hover preview player covers the thumbnail; its wrapper occupies the same box.
    { links: 'ytd-video-preview a.ytdVideoPreviewMediaContainerLink', holder: link => link.querySelector('.ytdVideoPreviewPlayerContainerWrapper') }
  ];
  const WATCH_TITLE = 'ytd-watch-metadata #title h1';
  const WATCH_TITLE_TEXT = ':scope > yt-formatted-string';
  const LABEL = { add: 'ダウンロードキューに追加', pending: '追加中', queued: 'キューに登録済み', downloaded: 'ダウンロード済み' };

  const known = { queued: new Set(), downloaded: new Set() };
  const pending = new Set();
  const marks = new Set();
  let scheduled = 0;

  const statusOf = id => known.downloaded.has(id) ? 'downloaded' : known.queued.has(id) ? 'queued' : pending.has(id) ? 'pending' : 'add';

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { ok: false, error: '拡張機能が更新されました。ページを再読み込みしてください。' }; }
  }

  let toast, toastTimer = 0;
  function notify(text) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'ypq-toast';
      toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function paint(mark) {
    const status = statusOf(mark.dataset.videoId);
    if (mark.dataset.status === status) return;
    mark.dataset.status = status;
    mark.disabled = status !== 'add';
    mark.title = LABEL[status];
    mark.setAttribute('aria-label', LABEL[status]);
    mark.innerHTML = MyToolsUI.icon(status === 'add' ? 'plus' : status === 'pending' ? 'loader' : 'check');
  }

  function createMark(kind) {
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = `ypq-mark ypq-mark--${kind}`;
    mark.addEventListener('click', add, true);
    marks.add(mark);
    return mark;
  }

  // One mark per host element; re-keyed when YouTube recycles the element for another video.
  // `place` runs on every scan and moves the mark only when it is not where it belongs.
  function attach(host, id, kind, place) {
    let mark = host.querySelector(':scope > .ypq-mark');
    if (!id) { if (mark) { marks.delete(mark); mark.remove(); } return; }
    mark ||= createMark(kind);
    place(mark);
    if (mark.dataset.videoId !== id) { mark.dataset.videoId = id; delete mark.dataset.status; }
    paint(mark);
  }

  function scan() {
    scheduled = 0;
    for (const { links, holder } of THUMBNAILS) {
      for (const link of document.querySelectorAll(links)) {
        const host = holder(link);
        if (host) attach(host, videoId(link.href), 'thumbnail', mark => { if (mark.parentElement !== host) host.append(mark); });
      }
    }
    const title = document.querySelector(WATCH_TITLE);
    // Directly before the text, so the h1's leading whitespace does not widen the gap.
    if (title) attach(title, location.pathname === '/watch' ? videoId(location.href) : null, 'title', mark => {
      const text = title.querySelector(WATCH_TITLE_TEXT);
      if (text && mark.nextElementSibling !== text) text.before(mark);
      else if (!text && mark.parentElement !== title) title.prepend(mark);
    });
    for (const mark of marks) if (!mark.isConnected) marks.delete(mark);
  }

  const schedule = () => { if (!scheduled) scheduled = setTimeout(scan, 150); };
  const repaint = () => marks.forEach(paint);

  async function add(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = event.currentTarget.dataset.videoId;
    if (statusOf(id) !== 'add') return;
    pending.add(id);
    repaint();
    const response = await send({ type: MESSAGE.ADD, videoId: id });
    pending.delete(id);
    if (!response?.ok) notify(response?.error || 'links.txt に追加できませんでした。');
    else if (response.status === 'downloaded') known.downloaded.add(id);
    else {
      known.queued.add(id);
      if (response.status === 'queued') notify('この動画は既に links.txt にあります。');
    }
    repaint();
  }

  async function refresh() {
    const response = await send({ type: MESSAGE.STATE });
    if (!response?.ok) return;
    known.queued = new Set(response.queued);
    known.downloaded = new Set(response.downloaded);
    repaint();
  }

  // The selectors above match on id and class, and YouTube may set them after inserting a link.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'id', 'class'] });
  document.addEventListener('yt-navigate-finish', schedule);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  chrome.runtime.onMessage.addListener(message => { if (message?.type === MESSAGE.CHANGED) refresh(); });
  scan();
  refresh();
})();
