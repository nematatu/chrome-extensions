// Talks to yt-queue (the native messaging host), which reads and appends Auto-YTDLP's links.txt
// on this Mac. Adds run one at a time, so double clicks never queue a video twice.
importScripts('core.js');
const { MESSAGE, VIDEO_ID } = YPQCore;
const NATIVE_HOST = 'com.nematatu.yt_queue';
const YOUTUBE_TABS = 'https://www.youtube.com/*';
const STATE_TTL = 30 * 1000;
const HOST_MISSING = 'yt-queue が未設定です。README の手順で yt-queue setup を実行してください。';

class QueueError extends Error {}
let cache = null;
let loading = null;
let tail = Promise.resolve();
const serial = task => (tail = tail.catch(() => {}).then(task));
const ids = value => Array.isArray(value) ? value.filter(id => VIDEO_ID.test(id)) : [];

async function ask(request) {
  let response;
  try { response = await chrome.runtime.sendNativeMessage(NATIVE_HOST, request); }
  catch { throw new QueueError(HOST_MISSING); }
  if (!response?.ok) throw new QueueError(typeof response?.error === 'string' ? response.error.slice(0, 300) : 'yt-queue から応答がありませんでした。');
  cache = { target: String(response.target || '').slice(0, 500), queued: ids(response.queued), downloaded: ids(response.downloaded), fetchedAt: Date.now() };
  return response;
}

// Concurrent callers share one request; the answer is reused for a short while.
function current(force = false) {
  if (!force && cache && Date.now() - cache.fetchedAt < STATE_TTL) return Promise.resolve(cache);
  loading ||= ask({ type: 'state' }).then(() => cache).finally(() => { loading = null; });
  return loading;
}

// Every change tells open YouTube tabs to redraw, so all tabs agree.
async function broadcast() {
  const tabs = await chrome.tabs.query({ url: YOUTUBE_TABS });
  await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: MESSAGE.CHANGED }).catch(() => {})));
}

async function state() {
  try {
    const value = await current();
    return { queued: value.queued, downloaded: value.downloaded, error: '' };
  } catch (error) {
    // Keep the last known marks while yt-queue cannot answer (for example, the queue folder is missing).
    return { queued: cache?.queued || [], downloaded: cache?.downloaded || [], error: error.message };
  }
}

function add({ videoId }) {
  if (!VIDEO_ID.test(videoId || '')) throw new QueueError('動画 ID を判別できませんでした。');
  return serial(async () => {
    const response = await ask({ type: 'add', id: videoId });
    await broadcast();
    return { status: response.status };
  });
}

async function status() {
  const value = await current(true);
  return { target: value.target, queued: value.queued.length, downloaded: value.downloaded.length };
}

async function refresh() {
  const value = await status();
  await broadcast();
  return value;
}

const ownPage = sender => sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
const youtubeTab = sender => sender.id === chrome.runtime.id && Boolean(sender.tab) && /^https:\/\/www\.youtube\.com\//.test(sender.url || '');
const handlers = {
  [MESSAGE.STATE]: { allow: sender => youtubeTab(sender) || ownPage(sender), run: state },
  [MESSAGE.ADD]: { allow: youtubeTab, run: add },
  [MESSAGE.STATUS]: { allow: ownPage, run: status },
  [MESSAGE.REFRESH]: { allow: ownPage, run: refresh }
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message?.type];
  if (!handler || !handler.allow(sender)) return false;
  Promise.resolve().then(() => handler.run(message)).then(value => respond({ ok: true, ...value }),
    error => respond({ ok: false, error: error instanceof QueueError ? error.message : '予期しないエラーが発生しました。' }));
  return true;
});
