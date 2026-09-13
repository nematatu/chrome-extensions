(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./quality-core.js') : root.InstagramHighQualityCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InstagramDownloadCore = api;
})(globalThis, function (quality) {
  'use strict';
  const reserved = new Set(['p','reel','reels','stories','explore','accounts','direct','about','developer','legal','privacy','web','api']);
  function profileName(pathname) {
    const match = pathname.match(/^\/([\w.]+)\/(?:reels\/?)?$/) || pathname.match(/^\/([\w.]+)\/?$/);
    return match && !reserved.has(match[1].toLowerCase()) ? match[1] : null;
  }
  function allowedMediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && ['cdninstagram.com','fbcdn.net'].some(host => url.hostname === host || url.hostname.endsWith('.'+host));
    } catch { return false; }
  }
  const idOf = item => String(item?.pk || item?.id || '').split('_')[0];
  function media(post, {username, category = 'posts'} = {}) {
    if (!post || typeof post !== 'object') throw new Error('投稿の情報がありません。');
    const children = post.carousel_media || post.edge_sidecar_to_children?.edges?.map(edge => edge.node) || [post];
    return children.map((item, index) => {
      const isVideo = item.media_type === 2 || item.is_video === true || item.__typename === 'GraphVideo' || !!item.video_versions?.length;
      let candidate;
      if (isVideo) {
        candidate = (item.video_versions || item.video_resources || []).map(v => ({...v,url:v.url || v.src})).filter(v => v.url).sort((a,b) => (b.width*b.height || 0) - (a.width*a.height || 0))[0];
        candidate ||= item.video_url ? {url:item.video_url} : null;
      } else {
        candidate = quality.highestMediaCandidate({items:[item]}, idOf(item));
        candidate ||= (item.display_resources || []).map(v => ({url:v.src, width:v.config_width, height:v.config_height})).sort((a,b) => b.width*b.height - a.width*a.height)[0];
        candidate ||= item.display_url ? {url:item.display_url} : null;
      }
      return { id:idOf(item) || `${post.code || idOf(post)}-${index}`, postId:post.code || post.shortcode || idOf(post), index:index+1,
        username:username || post.user?.username || post.owner?.username || 'instagram', category,
        type:isVideo ? 'video' : 'image', url:candidate?.url || '',
        error:allowedMediaUrl(candidate?.url) ? '' : '保存できる元ファイルが取得できませんでした。' };
    });
  }
  function safe(value, fallback) {
    return String(value || '').normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g,'_').replace(/^[._]+|[._]+$/g,'').slice(0,100) || fallback;
  }
  function filename(item) {
    let extension = 'jpg';
    if (item.type === 'video') extension = 'mp4';
    else {
      try {
        const match = new URL(item.url).pathname.match(/\.([a-zA-Z0-9]+)$/);
        const source = match?.[1]?.toLowerCase();
        if (['jpg','jpeg','png','webp','avif','gif'].includes(source)) extension = source;
      } catch {}
    }
    const name = `${safe(item.username,'instagram')}_${safe(item.postId || item.id,'media')}_${String(item.index || 1).padStart(2,'0')}`;
    return `Instagram-High-Quality/${name}.${extension}`;
  }
  function select(items, target = {}) {
    const id = String(target.mediaId || '').split('_')[0];
    const match = items.find(item => item.id === id || item.url === target.url);
    if (match) return match;
    if (target.index > 0 && items[target.index - 1]) return items[target.index - 1];
    if (items.length === 1) return items[0];
    // An image can always be saved from its visible source without guessing a carousel index.
    if (target.type === 'image' && allowedMediaUrl(target.url)) return {...items[0],url:target.url,type:'image',id:id || 'visible',postId:`${items[0].postId}_${id || 'visible'}`,index:1,error:''};
    throw new Error('表示中の動画を特定できません。投稿の一括保存をご利用ください。');
  }
  function nextCursor(data, seen) {
    const more = data.more_available ?? data.paging_info?.more_available;
    const cursor = data.next_max_id ?? data.paging_info?.max_id;
    if (more === false) return null;
    if (cursor && !seen.has(String(cursor))) { seen.add(String(cursor)); return String(cursor); }
    if (more === true || cursor) throw new Error('投稿一覧の続きが取得できませんでした。ここまでの保存は残っています。');
    // Absence of both continuation fields is not proof that all posts were fetched.
    throw new Error('投稿一覧の終了を確認できませんでした。Instagramの応答形式を確認してください。');
  }
  return {profileName, allowedMediaUrl, media, filename, select, nextCursor, idOf};
});
