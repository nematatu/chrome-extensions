(() => {
  if (document.getElementById('tweetfile-downloader')) return;
  const host = document.createElement('div');
  host.id = 'tweetfile-downloader';
  host.setAttribute('popover', 'manual');
  host.style.cssText = 'all:initial;font:14px system-ui,sans-serif;color:#f8fafc;position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;right:20px;bottom:20px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{font:14px system-ui,sans-serif;color:#f8fafc}*{box-sizing:border-box}
      button{font:inherit;cursor:pointer;color:inherit;border:1px solid #566075;background:#263248;border-radius:9px;padding:8px 12px}button:hover{background:#374863}button:focus-visible,input:focus-visible{outline:3px solid #7dd3fc;outline-offset:2px}button:disabled{opacity:.45;cursor:default}
      section{width:min(350px,calc(100vw - 40px));background:#172033;border:1px solid #526078;border-radius:16px;box-shadow:0 10px 36px #0006;overflow:hidden;margin-bottom:12px}
      header{display:flex;align-items:center;justify-content:space-between;padding:14px}h2{font-size:16px;margin:0}.tools{display:flex;gap:8px;padding:0 14px 10px}.list{max-height:min(48vh,420px);overflow:auto;padding:0 10px}
      label{display:flex;align-items:center;gap:10px;padding:9px 4px;border-top:1px solid #334155;cursor:pointer}input{width:19px;height:19px;accent-color:#38bdf8;flex-shrink:0}img,.placeholder{width:76px;height:48px;object-fit:cover;border-radius:6px;background:#334155;flex-shrink:0}.name{overflow-wrap:anywhere;font-size:12px}small{display:block;color:#fbbf24}p{padding:0 14px;font-size:12px;color:#cbd5e1;line-height:1.6}.bottom{display:flex;justify-content:flex-end;gap:8px;align-items:center}#download{background:#0284c7;border-color:#38bdf8;width:58px;height:58px;border-radius:50%;display:grid;place-items:center;box-shadow:0 4px 18px #0006}svg{width:28px;height:28px} [hidden]{display:none!important}
      .progress-box{padding:0 14px 4px}.progress-heading{display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:7px}progress{display:block;width:100%;height:9px;border:0;border-radius:9px;overflow:hidden;background:#334155;accent-color:#38bdf8}progress::-webkit-progress-bar{background:#334155;border-radius:9px}progress::-webkit-progress-value{background:#38bdf8;border-radius:9px;transition:width .2s}#progress-detail{font-size:11px;color:#cbd5e1;margin-top:7px}
    </style>
    <section aria-label="動画の選択"><header><h2>動画を選択 <span id="count"></span></h2><button id="close" aria-label="選択一覧を閉じる">×</button></header><div class="tools"><button id="all">全選択</button><button id="none">選択解除</button></div><div class="list"></div><div class="progress-box" hidden><div class="progress-heading"><span>ダウンロード全体</span><strong id="percent">0%</strong></div><progress id="progress" max="100" value="0" aria-label="ダウンロード全体の進捗"></progress><div id="progress-detail"></div></div><p id="status" role="status" aria-live="polite">ページ内の動画を確認中…</p></section>
    <div class="bottom"><button id="toggle" aria-expanded="true">動画の選択</button><button id="download" title="選択した動画を一括ダウンロード" aria-label="選択した動画を一括ダウンロード" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/></svg></button></div>`;
  document.documentElement.append(host);
  // Top layer keeps page advertising overlays from covering the controls.
  host.showPopover();
  const $ = selector => root.querySelector(selector);
  // Handle our controls before the site's capturing click / popunder handlers.
  // Native checkbox activation has already toggled checked before click capture.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
    window.addEventListener(type, event => {
      if (event.composedPath().includes(host)) event.stopImmediatePropagation();
    }, {capture:true, passive:true});
  }
  window.addEventListener('click', event => {
    const path = event.composedPath();
    if (!path.includes(host)) return;
    event.stopImmediatePropagation();
    const control = path.find(el => el instanceof Element && el.matches('button, input, label'));
    if (control?.matches('input')) { control.onchange?.(); return; }
    event.preventDefault();
    if (!control || control.disabled) return;
    if (control.matches('label')) {
      const input = control.querySelector('input');
      if (input && !input.disabled) { input.checked = !input.checked; input.onchange?.(); }
    } else control.onclick?.(event);
  }, true);
  let items = [], selected = new Set(), known = new Set(), page = location.href, signature = '', busy = false;
  function count() {
    $('#count').textContent = `${selected.size}/${items.length}`;
    $('#download').disabled = busy || !selected.size;
  }
  function render() {
    $('.list').replaceChildren();
    for (const item of items) {
      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = selected.has(item.url);
      check.setAttribute('aria-label', item.name);
      check.onchange = () => { check.checked ? selected.add(item.url) : selected.delete(item.url); count(); };
      const img = document.createElement(item.thumbnail ? 'img' : 'span');
      img.className = 'placeholder';
      if (item.thumbnail) { img.src = item.thumbnail; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; }
      const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name;
      
      label.append(check, img, name); $('.list').append(label);
    }
    count();
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'tweetfile-videos' || event.data.page !== location.href || !Array.isArray(event.data.items)) return;
    const next = event.data.items.filter(item => item && typeof item.url === 'string' && /^https?:\/\//.test(item.url) && typeof item.name === 'string');
    if (page !== location.href) { page = location.href; known.clear(); selected.clear(); signature = ''; }
    const sig = JSON.stringify(next);
    if (sig === signature) return;
    signature = sig; items = next;
    const urls = new Set(items.map(item => item.url));
    selected = new Set([...selected].filter(url => urls.has(url)));
    for (const item of items) { if (!known.has(item.url)) selected.add(item.url); }
    known = urls;
    render();
    if (!busy) $('#status').textContent = items.length ? 'チェックした動画を保存します。追加読み込みされた動画も反映されます。' : 'このページに動画が見つかりません。フォルダは対象外です。';
  });
  $('#all').onclick = () => { selected = new Set(items.map(item => item.url)); render(); };
  $('#none').onclick = () => { selected.clear(); render(); };
  function toggle() { $('section').hidden = !$('section').hidden; $('#toggle').setAttribute('aria-expanded', String(!$('section').hidden)); }
  $('#toggle').onclick = toggle; $('#close').onclick = toggle;
  let transfers = new Map(), polling = null;
  function updateProgress() {
    const values = [...transfers.values()];
    if (!values.length) return;
    const finished = values.filter(item => item.done).length;
    const failed = values.filter(item => item.error).length;
    // Each video has equal weight; HLS uses segment counts, files use bytes.
    const percent = Math.floor(values.reduce((sum, item) => sum + (item.done ? 1 : item.fraction), 0) / values.length * 100);
    $('.progress-box').hidden = false;
    $('#progress').value = percent;
    $('#percent').textContent = `${percent}%`;
    $('#progress-detail').textContent = `${finished}/${values.length}件 処理済み${failed ? `（${failed}件失敗）` : ''}`;
    if (finished === values.length) {
      busy = false;
      clearTimeout(polling);
      $('#status').textContent = `保存完了: ${finished - failed}件成功、${failed}件失敗。${failed ? ` エラー: ${values.find(item => item.error).error}` : ''}`;
    }
    count();
  }
  async function pollFiles() {
    const pending = [...transfers.values()].filter(item => item.id != null && !item.done);
    if (!pending.length) return;
    try {
      const response = await chrome.runtime.sendMessage({type:'tweetfile-file-progress', ids:pending.map(item => item.id)});
      if (response.error) throw new Error(response.error);
      for (const state of response.states) {
        const item = pending.find(item => item.id === state.id);
        if (!item) continue;
        item.done = state.state !== 'in_progress';
        item.error = item.done && state.state !== 'complete' ? state.error || '保存が中断されました。' : '';
        item.fraction = state.totalBytes > 0 ? Math.min(.99, state.bytesReceived / state.totalBytes) : 0;
      }
      updateProgress();
    } catch (error) { $('#status').textContent = `進捗を取得できませんでした: ${error.message}（再試行中）`; }
    if (busy) polling = setTimeout(pollFiles, 1000);
  }
  $('#download').onclick = async () => {
    if (busy || !selected.size) return;
    const batch = items.filter(item => selected.has(item.url));
    transfers = new Map(batch.map(item => [item.url, {fraction:0, done:false}]));
    busy = true; updateProgress();
    $('#status').textContent = `${batch.length}件のダウンロードを開始しています…`;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'tweetfile-download', items: batch });
      if (!result || result.error) throw new Error(result?.error || '拡張機能を再読み込みしてください。');
      for (const state of result.results) {
        const item = transfers.get(state.url);
        if (item) Object.assign(item, {id:state.id, error:state.error, done:!!state.error});
      }
      if (busy) $('#status').textContent = 'ダウンロード中…（HLSは分割数、通常ファイルは受信サイズから進捗を計算）';
      updateProgress();
      pollFiles();
    } catch (error) {
      busy = false; count();
      $('#status').textContent = `保存を開始できませんでした: ${error.message}`;
    }
  };
  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'tweetfile-progress' || !busy) return;
    if (message.progress) {
      const item = transfers.get(message.progress.url);
      if (!item) return;
      Object.assign(item, message.progress);
    }
    $('#status').textContent = message.text;
    updateProgress();
  });
  function scan() { window.postMessage({ type: 'tweetfile-scan' }, location.origin); }
  scan(); setInterval(scan, 1500);
})();
