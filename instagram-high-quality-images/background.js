let creating;
let storageMutation = Promise.resolve();
function storeJob(state,tabId) {
  storageMutation = storageMutation.then(async () => {
    const stored = await chrome.storage.session.get('downloadJobs');
    const jobs = stored.downloadJobs || {};
    jobs[state.id] = {...state,tabId,updatedAt:Date.now()};
    const recent = Object.fromEntries(Object.entries(jobs).sort((a,b) => b[1].updatedAt-a[1].updatedAt).slice(0,50));
    await chrome.storage.session.set({downloadJobs:recent});
  });
  return storageMutation;
}
async function ensureOffscreen() {
  if (!creating) creating = (async () => {
    const contexts = await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
    if (!contexts.length) await chrome.offscreen.createDocument({url:'offscreen.html', reasons:['BLOBS'], justification:'複数の画像と動画をバックグラウンドで並列保存するため'});
  })().finally(() => { creating = null; });
  return creating;
}
function instagramSender(sender) {
  try { return sender.id === chrome.runtime.id && sender.tab && new URL(sender.url).origin === 'https://www.instagram.com'; } catch { return false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const internal = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('offscreen.html');
  if (!message?.type?.startsWith('instagram-hq-')) return;
  if (internal) {
    const handle = async () => {
      if (message.type === 'instagram-hq-job-update') {
        await storeJob(message.state,message.tabId);
        await chrome.tabs.sendMessage(message.tabId,{type:'instagram-hq-job-update',state:message.state}).catch(() => {});
        return {ok:true};
      }
      if (message.type === 'instagram-hq-save-url') {
        const url = new URL(message.url);
        const allowedHost = ['cdninstagram.com','fbcdn.net'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
        if (url.protocol !== 'https:' || !allowedHost || !/^Instagram-High-Quality\/[\w.-]+\.(?:jpe?g|png|webp|avif|gif|mp4)$/.test(message.filename)) throw new Error('不正なメディア保存要求です。');
        return {id:await chrome.downloads.download({url:url.href,filename:message.filename,conflictAction:'uniquify',saveAs:false})};
      }
      if (message.type === 'instagram-hq-file-state') {
        const [item] = await chrome.downloads.search({id:message.id});
        return {state:item?.state,error:item?.error};
      }
      if (message.type === 'instagram-hq-file-cancel') { await chrome.downloads.cancel(message.id); return {ok:true}; }
    };
    handle().then(reply,error => reply({error:error.message}));
    return true;
  }
  if (!instagramSender(sender)) return;
  if (!['instagram-hq-start','instagram-hq-cancel','instagram-hq-job-state'].includes(message.type)) return;
  (async () => {
    if (message.type === 'instagram-hq-job-state') {
      const jobs = (await chrome.storage.session.get('downloadJobs')).downloadJobs || {};
      return {states:Object.values(jobs).filter(state => state.tabId === sender.tab.id).map(({tabId,updatedAt,...state}) => state)};
    }
    await ensureOffscreen();
    if (message.type === 'instagram-hq-cancel') return chrome.runtime.sendMessage({type:'instagram-hq-worker-cancel',jobId:message.jobId});
    if (!['single','post','story','stories','account'].includes(message.job?.mode)) throw new Error('保存対象を確認してください。');
    return chrome.runtime.sendMessage({type:'instagram-hq-worker-start',job:message.job,tabId:sender.tab.id});
  })().then(reply,error => reply({error:error.message}));
  return true;
});
