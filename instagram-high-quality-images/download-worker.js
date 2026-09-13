(() => {
  'use strict';
  const core = InstagramDownloadCore;
  const activeJobs = new Map();
  const GLOBAL_FILE_LIMIT = 16;
  const FILES_PER_JOB = 4;
  let availableFileSlots = GLOBAL_FILE_LIMIT;
  const fileWaiters = [];

  const delay = (ms, signal) => new Promise((resolve,reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },ms);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort',abort,{once:true});
  });
  async function message(data) {
    const reply = await chrome.runtime.sendMessage(data);
    if (!reply || reply.error) throw new Error(reply?.error || '拡張機能との通信に失敗しました。');
    return reply;
  }
  function acquireFileSlot(signal) {
    signal.throwIfAborted();
    if (availableFileSlots > 0) {
      availableFileSlots--;
      return Promise.resolve(releaseFileSlot);
    }
    return new Promise((resolve,reject) => {
      const waiter = {
        signal,
        start() {
          signal.removeEventListener('abort',waiter.abort);
          resolve(releaseFileSlot);
        },
        abort() {
          const index = fileWaiters.indexOf(waiter);
          if (index >= 0) fileWaiters.splice(index,1);
          reject(signal.reason);
        }
      };
      signal.addEventListener('abort',waiter.abort,{once:true});
      fileWaiters.push(waiter);
    });
  }
  function releaseFileSlot() {
    while (fileWaiters.length) {
      const waiter = fileWaiters.shift();
      if (!waiter.signal.aborted) { waiter.start(); return; }
    }
    availableFileSlots = Math.min(GLOBAL_FILE_LIMIT,availableFileSlots + 1);
  }

  chrome.runtime.onMessage.addListener((data,sender,reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (data.type === 'instagram-hq-worker-cancel') {
      const context = activeJobs.get(data.jobId);
      if (context) context.controller.abort(new DOMException('停止しました','AbortError'));
      reply({ok:true,found:!!context});
      return;
    }
    if (data.type !== 'instagram-hq-worker-start') return;
    const state = {
      id:crypto.randomUUID(), mode:data.job.mode, active:true, phase:'保存を開始しています…',
      total:0, processed:0, saved:0, failed:0, posts:0, discoveryDone:false, errors:[]
    };
    const context = {controller:new AbortController(),state,tabId:data.tabId};
    activeJobs.set(state.id,context);
    reply({ok:true,state});
    run(data.job,context).finally(() => { activeJobs.delete(state.id); });
  });

  async function run(job,context) {
    const {state,tabId,controller} = context, signal = controller.signal;
    const seenMedia = new Set();
    const update = () => message({type:'instagram-hq-job-update',state:{...state,errors:[...state.errors]},tabId}).catch(() => {});
    async function save(item) {
      signal.throwIfAborted();
      let downloadId, release;
      try {
        if (item.error) throw new Error(item.error);
        state.phase = availableFileSlots > 0 ? '並列で保存中' : '空き枠を待っています…';
        await update();
        release = await acquireFileSlot(signal);
        signal.throwIfAborted();
        state.phase = '並列で保存中';
        downloadId = (await message({type:'instagram-hq-save-url',url:item.url,filename:core.filename(item)})).id;
        for (;;) {
          signal.throwIfAborted();
          const result = await message({type:'instagram-hq-file-state',id:downloadId});
          if (result.state === 'complete') break;
          if (result.state !== 'in_progress') throw new Error(result.error || '保存が中断されました。');
          await delay(100,signal);
        }
        state.saved++;
      } catch (error) {
        if (signal.aborted) {
          if (downloadId != null) await message({type:'instagram-hq-file-cancel',id:downloadId}).catch(() => {});
          throw error;
        }
        state.failed++;
        state.errors.push(`${item.postId}: ${error.message}`);
        state.errors = state.errors.slice(-5);
      } finally {
        if (release) release();
      }
      state.processed++;
      state.phase = '並列で保存中';
      await update();
    }
    async function saveItems(items) {
      const fresh = items.filter(item => {
        const key = `${item.category}:${item.id}`;
        if (seenMedia.has(key)) return false;
        seenMedia.add(key);
        return true;
      });
      state.total += fresh.length;
      await update();
      let next = 0;
      const workers = Array.from({length:Math.min(FILES_PER_JOB,fresh.length)}, async () => {
        while (next < fresh.length) await save(fresh[next++]);
      });
      const results = await Promise.allSettled(workers);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    function directItems(targets,postId,category = 'posts',username = 'instagram') {
      return (targets || []).filter(target => core.allowedMediaUrl(target?.url)).map((target,index) => ({
        id:String(target.mediaId || target.id || `${postId}-${index + 1}`), postId:target.postId || postId, index:Number(target.index) || index + 1,
        username:target.username && target.username !== 'instagram' ? target.username : username, category,
        type:target.type === 'video' ? 'video' : 'image', url:target.url, error:''
      }));
    }
    try {
      await update();
      const category = job.mode === 'story' || job.mode === 'stories' ? 'stories' : 'posts';
      const postId = job.shortcode || job.storyId || job.highlightId || job.mode;
      const source = job.mode === 'single' || job.mode === 'story' ? [job.target] : job.targets;
      const items = directItems(source,postId,category,job.username || 'instagram');
      if (!items.length) throw new Error('保存対象を取得できませんでした。');
      state.discoveryDone = true;
      state.posts = new Set(items.map(item => item.postId)).size;
      await saveItems(items);
      state.phase = state.failed ? `保存終了（${state.failed}件失敗）` : '保存が完了しました';
    } catch (error) {
      state.phase = signal.aborted ? '停止しました。保存済みファイルは残っています。' : `途中で停止: ${error.message}`;
      state.stopped = true;
    } finally {
      state.active = false;
      await update();
    }
  }
})();
