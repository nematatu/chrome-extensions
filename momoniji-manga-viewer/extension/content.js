(function () {
  'use strict';
  if (window.top !== window || document.getElementById('momoniji-reader')) return;
  const Extract = globalThis.MomonijiExtract;
  let host, shadow, work, viewer, job, loading = false, opened = true;
  let controller, pollTimer, viewerUiObserver, lastPage = 1, previousFocus, bodyOverflow;
  let inertSiblings = [];
  const $ = id => shadow.getElementById(id);
  const ACTIVE = new Set(['running', 'cancelling']);
  function make(tag, attrs = {}, text) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(id, label, handler) {
    const el = make('button', { id, type: 'button' }, label);
    el.addEventListener('click', handler);
    return el;
  }
  function build(initial) {
    host = make('div', { id: 'momoniji-reader' });
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = make('style');
    style.textContent = MyToolsUI.css + `
      :host {font:14px/1.5 system-ui,sans-serif;color:var(--mt-gray-11)}
      * {box-sizing:border-box} [hidden] {display:none!important}
      #shell {font:14px/1.5 system-ui,sans-serif;height:100dvh;display:flex;flex-direction:column;background:var(--mt-gray-1);color:var(--mt-gray-12)}
      #toolbar {display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;background:var(--mt-gray-2);border-bottom:0.5px solid var(--mt-gray-6);z-index:2}
      #title {font-weight:600;max-width:min(30vw,400px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      button,select {font:inherit;min-height:36px;border:0.5px solid var(--mt-gray-7);border-radius:7px;color:var(--mt-gray-12);background:var(--mt-gray-3);padding:6px 12px;cursor:pointer}
      button:disabled {opacity:.45;cursor:default} button:hover:enabled {background:var(--mt-gray-4)} #download {background:var(--mt-indigo-9);border-color:var(--mt-indigo-9);color:var(--mt-on-accent)} #download:hover:enabled {background:var(--mt-indigo-10)}
      button:focus-visible,select:focus-visible {outline:2px solid var(--mt-indigo-8);outline-offset:2px}
      #save-info {display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:6px 14px;font-size:12px;background:var(--mt-gray-1);border-bottom:0.5px solid var(--mt-gray-6)}
      #status {flex:1;min-width:140px} #folder {overflow-wrap:anywhere;max-width:45vw;color:var(--mt-gray-11)} #progress {width:130px;height:8px;accent-color:var(--mt-indigo-9)}
      #failure {width:100%;color:var(--mt-red-11);white-space:pre-wrap}
      #reader-stage {position:relative;flex:1;min-height:0;contain:layout style;background:var(--mt-gray-1);overflow:hidden}
      #error {padding:24px;white-space:pre-wrap;color:var(--mt-red-11)} #loading-message {padding:24px;color:var(--mt-gray-11)}
      #shell.closed {height:auto;width:min(720px,calc(100vw - 24px));max-height:45vh;overflow:auto;border:0.5px solid var(--mt-gray-7);border-radius:10px;box-shadow:none}
      .closed #reader-stage {display:none} .closed #title {max-width:230px} .closed #mode,.closed #direction {display:none}
      .closed #folder {max-width:100%}
      @media(max-width:600px) {#toolbar{gap:5px;padding:7px} button,select{font-size:12px;padding:5px 8px} #title{width:100%;max-width:100%} #save-info{padding:6px 8px} #folder{max-width:100%} #progress{width:90px}}
    `;
    shadow.append(style);
    const shell = make('section', { id: 'shell', role: 'dialog', 'aria-modal': 'true', 'aria-label': '漫画ビューア' });
    const toolbar = make('div', { id: 'toolbar' });
    toolbar.append(make('span', { id: 'title' }, initial.title));
    toolbar.append(button('close', '元のページ', closeViewer));
    const open = button('open', '漫画ビューアを開く', openViewer); open.hidden = true; toolbar.append(open);
    toolbar.append(button('download', '全ページを一括保存', () => downloadAction('START')));
    const cancel = button('cancel', '保存を中止', () => downloadAction('CANCEL')); cancel.hidden = true; toolbar.append(cancel);
    const retry = button('retry', '失敗・中止ページを再試行', () => downloadAction('RETRY')); retry.hidden = true; toolbar.append(retry);
    const reload = button('reload', '再取得', loadWork); reload.hidden = true; toolbar.append(reload);
    const mode = make('select', { id: 'mode', 'aria-label': '表示方法' });
    mode.append(make('option', { value: 'page' }, '横読み・見開き'), make('option', { value: 'scroll' }, '縦読み'));
    const direction = make('select', { id: 'direction', 'aria-label': '読む方向' });
    direction.append(make('option', { value: 'rtl' }, '右綴じ'), make('option', { value: 'ltr' }, '左綴じ'));
    for (const select of [mode, direction]) select.addEventListener('change', () => createViewer(viewer?.currentPage || lastPage, true));
    toolbar.append(mode, direction);
    const info = make('div', { id: 'save-info' });
    info.append(make('span', { id: 'status', role: 'status', 'aria-live': 'polite' }, '作品を確認しています…'));
    info.append(make('progress', { id: 'progress', value: '0', max: '100', 'aria-label': '保存の進捗' }));
    info.append(make('span', { id: 'folder' }));
    const failure = make('span', { id: 'failure' }); failure.hidden = true; info.append(failure);
    const stage = make('div', { id: 'reader-stage', tabindex: '0' });
    stage.append(make('p', { id: 'loading-message' }, '読み込み中…'));
    shell.append(toolbar, info, stage); shadow.append(shell);
    host.addEventListener('keydown', event => {
      if (!opened || event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation();
      const reset = $('reader-stage').shadowRoot?.querySelector('.mv-zoom-btn[title="Reset zoom"]');
      if (reset && !reset.disabled) viewer?.resetZoom(); else closeViewer();
    }, true);
    document.body.append(host);
    previousFocus = document.activeElement;
    lockPage();
    updateControls();
  }
  function lockPage() {
    if (bodyOverflow) return;
    bodyOverflow = { value: document.body.style.getPropertyValue('overflow'), priority: document.body.style.getPropertyPriority('overflow') };
    document.body.style.setProperty('overflow', 'hidden', 'important');
    inertSiblings = [...document.body.children].filter(el => el !== host).map(el => [el, el.inert]);
    for (const [el] of inertSiblings) el.inert = true;
  }
  function unlockPage() {
    if (!bodyOverflow) return;
    if (bodyOverflow.value) document.body.style.setProperty('overflow', bodyOverflow.value, bodyOverflow.priority);
    else document.body.style.removeProperty('overflow');
    bodyOverflow = null;
    for (const [el, inert] of inertSiblings) el.inert = inert;
    inertSiblings = [];
  }
  function closeViewer() {
    lastPage = viewer?.currentPage || lastPage;
    viewerUiObserver?.disconnect();
    viewer?.destroy(); viewer = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    opened = false;
    host.style.setProperty('inset', 'auto 12px 12px auto', 'important');
    $('shell').classList.add('closed'); $('shell').removeAttribute('aria-modal');
    $('close').hidden = true; $('open').hidden = false;
    unlockPage();
    (previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : $('open')).focus();
  }
  function openViewer() {
    opened = true; host.style.setProperty('inset', '0', 'important');
    $('shell').classList.remove('closed'); $('shell').setAttribute('aria-modal', 'true');
    $('open').hidden = true; $('close').hidden = false; lockPage();
    if (work) createViewer(lastPage, true); else if (!loading) loadWork();
  }
  function createViewer(page, forcePosition = false) {
    if (!work || !opened) return;
    viewerUiObserver?.disconnect();
    viewer?.destroy();
    const stage = $('reader-stage'); stage.replaceChildren();
    const instance = new globalThis.MomonijiMangaViewer.MangaViewer({
      container: stage, pages: work.pages.map(p => p.url), title: work.title,
      direction: $('direction').value, viewMode: $('mode').value,
      firstPageSingle: true, theme: 'dark', bookmarks: false,
      storageKey: 'momoniji-reader-progress-' + work.id,
      headerButtons: ['back', 'fullscreen', 'help'],
      onBack: closeViewer,
      onPageChange: current => { lastPage = current; stage.dataset.page = String(current); },
    });
    viewer = instance;
    const style = make('style'); style.textContent = MyToolsUI.css + `
      :host,:host(.mv-theme-dark),:host(.mv-theme-light) {
        --mv-font-family:system-ui,sans-serif;
        --mv-bg:var(--mt-gray-1);--mv-fg:var(--mt-gray-12);--mv-text-muted:var(--mt-gray-11);
        --mv-header-bg:var(--mt-gray-2);--mv-footer-bg:var(--mt-gray-2);
        --mv-btn-bg:var(--mt-gray-3);--mv-btn-bg-hover:var(--mt-gray-4);--mv-btn-fg:var(--mt-gray-12);
        --mv-slider-track:var(--mt-gray-6);--mv-spinner-track:var(--mt-gray-4);--mv-spinner-fg:var(--mt-indigo-9);
        --mv-accent:var(--mt-indigo-9);--mv-shadow:transparent;
      }
      .mv-container{height:100%;width:100%}.mv-main{height:100%}
      *,*::before,*::after{box-shadow:none!important;transition:none!important;animation:none!important}
      [class^="mv-"],[class*=" mv-"]{font-size:14px;border-width:0.5px!important}
      .mv-resume-dialog,.mv-help-overlay,.mv-bookmark-overlay{background:var(--mt-overlay);color:var(--mt-gray-12);backdrop-filter:none}
      .mv-resume-card,.mv-help-card,.mv-purchase-card,.mv-bookmark-panel,.mv-toast{
        background:var(--mt-gray-2);color:var(--mt-gray-12);border-radius:8px;backdrop-filter:none;
      }
      .mv-resume-title,.mv-help-title,.mv-purchase-title,.mv-bookmark-panel-title{font-size:20px;color:var(--mt-gray-12)}
      .mv-resume-subtitle,.mv-purchase-desc,.mv-purchase-back,.mv-help-desc,.mv-bookmark-empty{color:var(--mt-gray-11)}
      .mv-resume-btn,.mv-purchase-btn,.mv-bookmark-add,.mv-help-key,.mv-help-close,.mv-bookmark-panel-close{
        background:var(--mt-gray-3);color:var(--mt-gray-12);border-color:var(--mt-gray-7);border-radius:4px;
      }
      .mv-resume-btn.mv-primary,.mv-purchase-btn,.mv-bookmark-add{
        background:var(--mt-indigo-9);color:var(--mt-on-accent);
      }
      .mv-resume-btn.mv-secondary{background:var(--mt-gray-3);color:var(--mt-gray-12);border-color:var(--mt-gray-7)}
      .mv-resume-btn:hover,.mv-purchase-btn:hover{transform:none;background:var(--mt-indigo-10)}
      .mv-resume-btn.mv-secondary:hover,.mv-help-close:hover,.mv-bookmark-panel-close:hover{background:var(--mt-gray-4)}
      .mv-resume-icon,.mv-purchase-icon{background:var(--mt-indigo-3);color:var(--mt-indigo-11);border-radius:4px}
      .mv-help-section,.mv-help-header,.mv-bookmark-panel-header{border-color:var(--mt-gray-6);background:transparent}
      .mv-help-section-title,.mv-help-key,.mv-bookmark-item-page{color:var(--mt-indigo-11)}
      .mv-help-key-desc,.mv-bookmark-item-title{color:var(--mt-gray-12)}
      .mv-help-note{background:var(--mt-indigo-3);color:var(--mt-indigo-11)}
      .mv-bookmark-clear,.mv-bookmark-item-delete,.mv-bookmark-item-delete:hover{background:var(--mt-red-3);color:var(--mt-red-11)}
      .mv-bookmark-item:hover,.mv-bookmark-item.mv-active{background:var(--mt-gray-3)}
      .mv-bookmark-btn.mv-bookmark-active{color:var(--mt-indigo-11)!important}
      .mv-bookmark-btn.mv-bookmark-active svg{fill:none!important}
      .mv-header-btn svg,.mv-zoom-btn svg,.mv-help-title svg,.mv-resume-icon svg,.mv-toast svg{fill:none;stroke:currentColor}
      .mv-footer,.mv-page-info,.mv-slider-label{font-size:12px}
      .mv-page-slider::-webkit-slider-thumb{background:var(--mt-indigo-9);box-shadow:none}
      .mv-page-slider::-moz-range-thumb{background:var(--mt-indigo-9);box-shadow:none}
      .mv-zoom-btn,.mv-zoom-btn:disabled:hover{background:var(--mt-gray-3);color:var(--mt-gray-12);border-color:var(--mt-gray-7);border-radius:4px;backdrop-filter:none}
      .mv-zoom-btn:hover{background:var(--mt-gray-4);color:var(--mt-gray-12)}
      .mv-adsense-label{color:var(--mt-gray-11)}
      .mv-purchase-trigger{background:var(--mt-gray-2)}
      .mv-bookmark-toggle-btn{background:var(--mt-indigo-9);color:var(--mt-on-accent);border-radius:4px}
      .mv-bookmark-toggle-btn:hover{background:var(--mt-indigo-10);transform:none}
      .mv-bookmark-toggle-btn.mv-bookmark-remove,.mv-bookmark-toggle-btn.mv-bookmark-remove:hover{background:var(--mt-red-3);color:var(--mt-red-11)}
    `;
    stage.shadowRoot.append(style);
    const icons = [
      ['[title="Back"]','arrowLeft'],['[title="Fullscreen"]','maximize'],
      ['[title="Zoom in"]','zoomIn'],['[title="Reset zoom"]','zoomOut'],
      ['.mv-header-btn[aria-label]:not([title="Back"])','help'],
      ['.mv-help-title','help'],['.mv-help-close,.mv-bookmark-panel-close','x'],
      ['.mv-resume-icon','play'],['.mv-toast','check']
    ];
    const refreshIcons = () => {
      for (const [selector, name] of icons) {
        for (const target of stage.shadowRoot.querySelectorAll(selector)) {
          const svg = target.querySelector('svg:not([data-mt-icon])');
          if (!svg) continue;
          const wrapper = make('span'); wrapper.innerHTML = MyToolsUI.icon(name === 'maximize' && document.fullscreenElement ? 'minimize' : name);
          wrapper.firstElementChild.dataset.mtIcon = name;
          svg.replaceWith(wrapper.firstElementChild);
        }
      }
    };
    refreshIcons();
    viewerUiObserver = new MutationObserver(refreshIcons);
    viewerUiObserver.observe(stage.shadowRoot, {childList:true,subtree:true});
    if (forcePosition) stage.shadowRoot.querySelector('.mv-resume-btn.mv-secondary')?.click();
    if (forcePosition || !stage.shadowRoot.querySelector('.mv-resume-dialog')) instance.goToPage(page || 1);
    stage.focus({ preventScroll: true });
  }
  function updateControls() {
    const active = !!job && ACTIVE.has(job.state);
    $('download').disabled = loading || !work || active;
    $('download').textContent = work ? `全${work.totalPages}ページを一括保存` : '全ページを一括保存';
    $('cancel').hidden = !active; $('cancel').disabled = job?.state === 'cancelling';
    $('retry').hidden = !job || active || !(job.failed || job.cancelled);
    $('retry').disabled = loading;
    $('mode').disabled = !work || loading; $('direction').disabled = !work || loading;
  }
  function renderJob(next) {
    if (!next || (work && next.pageUrl !== work.sourceUrl)) return;
    job = next;
    const completed = job.completed || 0;
    $('progress').value = job.total ? completed * 100 / job.total : 0;
    const states = { running: '保存中', cancelling: '中止しています', complete: '保存完了', completed: '保存完了', failed: '保存に失敗したページがあります', cancelled: '保存を中止しました', partial: '保存に失敗したページがあります' };
    $('status').textContent = `${states[job.state] || '保存状況'}：${completed} / ${job.total} ページ` + (job.failed ? `（失敗 ${job.failed}）` : '');
    $('folder').textContent = '保存先：ダウンロード/' + job.folder;
    const reasons = { UNEXPECTED_CONTENT: '画像ではない応答を受け取りました。', BLOCKED_URL: '画像の移動先が対応範囲外です。', DOWNLOAD_MISMATCH: '画像の取得情報が一致しません。拡張機能とタブを再読み込みしてください。', SAVE_PATH_CHANGED: '保存先が指定した作品フォルダと異なります。Chromeの保存設定や、保存先を変更する拡張機能をご確認ください。', SERVER_FORBIDDEN: '画像へのアクセスが拒否されました。', FILE_NO_SPACE: '保存先の空き容量がありません。', FILE_ACCESS_DENIED: '保存先へのアクセスが拒否されました。' };
    const failures = job.failures || [];
    $('failure').hidden = !failures.length;
    $('failure').textContent = failures.slice(0, 3).map(f => `${f.page}ページ目：` +
      (f.reason.endsWith('_FILE_REMAINS') ? '画像ではないファイルを削除できませんでした。保存先をご確認ください。' : reasons[f.reason] || '保存に失敗しました。再試行できます。')).join('\n') +
      (failures.length > 3 ? `\nほか ${failures.length - 3} ページ` : '');
    updateControls();
    if (ACTIVE.has(job.state)) schedulePoll(); else { clearTimeout(pollTimer); pollTimer = null; }
  }
  async function send(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || '拡張機能との通信に失敗しました。');
      return response;
    } catch (error) {
      throw new Error(error.message?.includes('Extension context invalidated') ? '拡張機能を更新しました。タブを再読み込みしてください。' : error.message || '拡張機能との通信に失敗しました。');
    }
  }
  async function queryJob() {
    if (!work) return;
    try { const result = await send({ type: 'MOMONIJI_DOWNLOAD_STATUS', pageUrl: work.sourceUrl }); if (result.job) renderJob(result.job); }
    catch (error) { $('status').textContent = error.message; }
  }
  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setTimeout(async () => { pollTimer = null; await queryJob(); }, 1200);
  }
  async function downloadAction(action) {
    if (!work || loading) return;
    $('download').disabled = true;
    try {
      const message = { type: 'MOMONIJI_DOWNLOAD_' + action, pageUrl: work.sourceUrl };
      if (action === 'START') message.manga = { title: work.title, pageUrl: work.sourceUrl, images: work.pages.map(p => p.url) };
      const result = await send(message);
      if (result.job) renderJob(result.job);
    } catch (error) { $('status').textContent = error.message; }
    finally { updateControls(); }
  }
  async function loadWork() {
    if (loading) return;
    loading = true; work = null; $('reload').hidden = true; controller = new AbortController();
    updateControls();
    try {
      const result = await Extract.collectWork(document, location.href, {
        signal: controller.signal,
        onProgress: (count, total) => { $('status').textContent = `作品ページを取得中：${count} / ${total}`; },
      });
      if (!result) throw new Error('作品を確認できません。');
      work = result; lastPage = result.initialPage;
      $('status').textContent = `${work.totalPages}ページ`;
      if (opened) createViewer(lastPage);
      await queryJob();
    } catch (error) {
      $('status').textContent = '作品の取得に失敗しました。';
      $('reload').hidden = false;
      const stage = $('reader-stage');
      stage.replaceChildren(make('p', { id: 'error', role: 'alert' }, error.message || '再取得をお試しください。'));
    } finally { loading = false; updateControls(); }
  }
  function start() {
    if (!document.querySelector('#cif') || host) return false;
    try {
      const initial = Extract.extractDocument(document, location.href);
      if (!initial) return false;
      build(initial);
      chrome.runtime.onMessage.addListener(message => {
        if (message?.type === 'MOMONIJI_DOWNLOAD_PROGRESS') renderJob(message.job);
      });
      loadWork();
    } catch (error) {
      if (!host) build({ title: 'Momoniji 漫画ビューア' });
      $('status').textContent = error.message;
      $('reader-stage').replaceChildren(make('p', { id: 'error', role: 'alert' }, '作品情報を確認できません。「元のページ」で戻れます。'));
    }
    return true;
  }
  if (!start()) {
    const observer = new MutationObserver(() => { if (start()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
})();
