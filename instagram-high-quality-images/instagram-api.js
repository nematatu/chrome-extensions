(() => {
  'use strict';
  const pending = new Map();
  const timeout = 30000;
  window.addEventListener('message',event => {
    if (event.source !== window || event.data?.source !== 'instagram-hq-api-response') return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    clearTimeout(request.timer);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.data);
  });
  function call(request) {
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Instagram API の応答がありません。'));
      },timeout);
      pending.set(id,{resolve,reject,timer});
      window.postMessage({source:'instagram-hq-api-request',id,request},location.origin);
    });
  }
  function pageItems(data, clips) {
    const source = data?.items || data?.data?.items || [];
    return clips ? source.map(item => item.media || item).filter(Boolean) : source;
  }
  function nextPage(data,clips) {
    const source = clips ? data?.paging_info || data?.paging || data : data;
    const more = source?.more_available ?? source?.has_more;
    const cursor = source?.next_max_id ?? source?.max_id ?? source?.next_cursor;
    if (more === false) return null;
    if (cursor) return String(cursor);
    if (more === true) throw new Error('次ページのカーソルが返されなかったため、全件取得を完了できませんでした。');
    return null;
  }
  async function allPages(kind,userId,onPage) {
    const items = [], cursors = new Set();
    let maxId = null;
    for (;;) {
      const data = await call({kind,userId,maxId});
      const batch = pageItems(data,kind === 'account-clips');
      items.push(...batch);
      onPage?.(items.length);
      const next = nextPage(data,kind === 'account-clips');
      if (!next) break;
      if (cursors.has(next)) throw new Error('同じページカーソルが繰り返されたため、全件取得を完了できませんでした。');
      cursors.add(next);
      maxId = next;
    }
    return items;
  }
  async function post(shortcode) {
    const data = await call({kind:'post',shortcode});
    return data?.items?.[0] || data?.item || data?.data?.items?.[0];
  }
  async function account(username,onPage) {
    const profile = await call({kind:'profile',username});
    const user = profile?.data?.user || profile?.user || profile?.data;
    const userId = String(user?.id || user?.pk || '');
    if (!/^\d+$/.test(userId)) throw new Error('アカウント情報を取得できませんでした。');
    const [feed,clips] = await Promise.all([
      allPages('account-feed',userId,count => onPage?.('投稿',count)),
      allPages('account-clips',userId,count => onPage?.('リール',count))
    ]);
    const unique = new Map();
    for (const item of [...feed,...clips]) unique.set(String(item.code || item.pk || item.id),item);
    return [...unique.values()];
  }
  globalThis.InstagramHQApi = {post,account};
})();
