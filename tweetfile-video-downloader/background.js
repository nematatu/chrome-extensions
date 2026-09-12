function validUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
function filename(item, index) {
  const ext = new URL(item.url).pathname.match(/\.(mp4|webm|mov|m4v)$/i)?.[1].toLowerCase() || 'mp4';
  const name = String(item.name || 'video').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/^\.+|[. ]+$/g, '').replace(/\.(mp4|webm|mov|m4v)$/i, '').slice(0, 100) || 'video';
  return `Tweetfile/${String(index + 1).padStart(3, '0')}_${name}.${ext}`;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['tweetfile-download', 'tweetfile-file-progress'].includes(message?.type)) return;
  let host;
  try { host = new URL(sender.url).hostname; } catch { return; }
  if (sender.id !== chrome.runtime.id || !sender.tab || !(host === 'tweetfile.com' || host.endsWith('.tweetfile.com'))) return;
  if (message.type === 'tweetfile-file-progress') {
    if (!Array.isArray(message.ids) || message.ids.some(id => !Number.isInteger(id))) { respond({error:'不正な進捗要求です。'}); return; }
    Promise.all(message.ids.map(async id => {
      const [item] = await chrome.downloads.search({id});
      return {id, state:item?.state, bytesReceived:item?.bytesReceived, totalBytes:item?.totalBytes, error:item?.error};
    })).then(states => respond({states}), error => respond({error:error.message}));
    return true;
  }
  if (!Array.isArray(message.items) || !message.items.length || message.items.some(item => !item || !validUrl(item.url))) {
    respond({ error: '保存できない動画URLが含まれています。' }); return;
  }
  (async () => {
    const results = [];
    const hls = message.items.filter(item => /\.m3u8(?:[?#]|$)/i.test(item.url));
    if (hls.length) {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({type:'tweetfile-hls-queue',items:[...new Map(hls.map(item=>[item.url,item])).values()],tabId:sender.tab.id});
    }
    const items = [...new Map(message.items.filter(item => !/\.m3u8(?:[?#]|$)/i.test(item.url)).map(item => [item.url, item])).values()];
    for (const [index, item] of items.entries()) {
      try {
        const id = await chrome.downloads.download({ url: item.url, filename: filename(item, index), conflictAction: 'uniquify', saveAs: false });
        results.push({ url: item.url, id });
      } catch (error) { results.push({ url: item.url, error: error.message }); }
    }
    respond({ results, queued: hls.length });
  })().catch(error => respond({ error: error.message }));
  return true;
});

let creatingOffscreen;
async function ensureOffscreen() {
  if (!creatingOffscreen) creatingOffscreen = (async()=>{
    if (!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]})).length) await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'HLS動画の分割データを結合して保存するため'});
  })().finally(()=>{creatingOffscreen = undefined;});
  return creatingOffscreen;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html')) return;
  (async()=>{
    if (message.type === 'tweetfile-save-blob') {
      if (!message.url.startsWith(`blob:${chrome.runtime.getURL('')}`) || !['mp4','ts'].includes(message.extension)) throw new Error('不正な保存要求です。');
      const name = filename({url:'https://example.com/video.mp4',name:message.name},message.index).replace(/\.mp4$/,'.'+message.extension);
      return {id:await chrome.downloads.download({url:message.url,filename:name,conflictAction:'uniquify',saveAs:false})};
    }
    if (message.type === 'tweetfile-download-state') {
      const [download] = await chrome.downloads.search({id:message.id});
      return {state:download?.state,error:download?.error};
    }
    if (message.type === 'tweetfile-progress') {
      await chrome.tabs.sendMessage(message.tabId,{type:'tweetfile-progress',text:message.text,done:message.done,progress:message.progress}).catch(()=>{});
      return {};
    }
  })().then(respond,error=>respond({error:error.message}));
  return true;
});
