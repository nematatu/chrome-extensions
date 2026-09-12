const queue = [];
let running = false;
async function report(tabId, text, done = false, progress) {
  await chrome.runtime.sendMessage({type:'tweetfile-progress',tabId,text,done,progress}).catch(()=>{});
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.type !== 'tweetfile-hls-queue') return;
  queue.push(message); respond({accepted:true}); drain();
});
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const {items, tabId} = queue.shift();
      let success = 0, failed = 0, lastError = ''; 
      for (const [index, item] of items.entries()) {
        let objectUrl;
        try {
          let last = 0;
          const result = await TweetfileHLS.assemble(item.url, {progress(done,total) {
            if (Date.now() - last > 1000 || done === total) {
              last = Date.now(); report(tabId, `${index + 1}/${items.length}本目を取得中: ${done}/${total}分割`, false, {url:item.url, fraction:Math.min(.99, done/total), done:false});
            }
          }});
          await report(tabId, `${index + 1}/${items.length}本目をMP4に変換・保存中…`, false, {url:item.url, fraction:.99, done:false});
          const mp4 = result.extension === 'ts' ? await TweetfileMP4.toMp4(result.blob) : result.blob;
          objectUrl = URL.createObjectURL(mp4);
          const response = await chrome.runtime.sendMessage({type:'tweetfile-save-blob',url:objectUrl,name:item.name,index,extension:'mp4'});
          if (response.error) throw new Error(response.error);
          // Keep the blob alive until Chrome has finished consuming it.
          for (;;) {
            const state = await chrome.runtime.sendMessage({type:'tweetfile-download-state',id:response.id});
            if (state.state === 'complete') break;
            if (state.state !== 'in_progress') throw new Error(state.error || '保存が中断されました。');
            await new Promise(resolve=>setTimeout(resolve,1000));
          }
          success++;
          await report(tabId, `${index + 1}/${items.length}本目を保存しました。`, false, {url:item.url, fraction:1, done:true});
        } catch (error) { failed++; lastError = error.message; await report(tabId, `${index + 1}本目の保存に失敗: ${error.message}`, false, {url:item.url, fraction:1, done:true, error:error.message}); }
        finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
      }
      await report(tabId, `HLS保存完了: ${success}件成功、${failed}件失敗。Chromeのダウンロード履歴で確認できます。${lastError ? ` 最後のエラー: ${lastError}` : ''}`, true);
    }
  } finally { running = false; }
}
