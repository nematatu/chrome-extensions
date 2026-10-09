(function () {
  'use strict';

  const elements = Object.fromEntries([
    'search', 'library-panel', 'result-count', 'library-list', 'empty', 'empty-title',
    'empty-description', 'load-more', 'error', 'notice', 'notice-text', 'undo', 'current-title',
    'current-save', 'current-save-icon', 'current-save-label', 'current-description'
  ].map((id) => [id, document.getElementById(id)]));
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  let entries = [];
  let currentWork = null;
  let filter = 'unread';
  let busy = false;
  let loaded = false;
  let undoEntry = null;
  let refreshTimer;
  let refreshVersion = 0;
  let noticeTimer;
  let displayLimit = 100;

  function safeWorkUrl(value) {
    try { return MomonijiLibrary.canonicalWorkUrl(value); } catch { return null; }
  }

  function error(message) {
    elements.error.textContent = message || '';
    elements.error.hidden = !message;
  }

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || !response.ok) throw new Error(response?.error || '保存情報を取得できませんでした。拡張機能を再読み込みしてください。');
    return response;
  }

  function updateEntries(response) {
    if (!Array.isArray(response.entries)) throw new Error('保存情報を取得できませんでした。');
    entries = response.entries.filter((entry) => entry && safeWorkUrl(entry.url) && typeof entry.title === 'string')
      .map((entry) => ({ ...entry, url: safeWorkUrl(entry.url) }));
    loaded = true;
    render();
  }

  function showNotice(message, restorable) {
    clearTimeout(noticeTimer);
    elements['notice-text'].textContent = message;
    elements.notice.hidden = false;
    elements.undo.hidden = !restorable;
    if (!restorable) noticeTimer = setTimeout(() => { elements.notice.hidden = true; }, 5000);
  }

  function formatDate(value) {
    if (!Number.isFinite(value) || value <= 0) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(date);
  }

  function matchesFilter(entry) {
    if (filter === 'downloaded') return Number.isFinite(entry.downloadedAt) && entry.downloadedAt > 0;
    return entry.readLater === true && (filter === 'read' ? entry.read === true : entry.read !== true);
  }

  function bookmarkIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('bookmark');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 3h12v18l-6-4-6 4V3Z');
    svg.append(path);
    return svg;
  }

  function actionButton(action, label, symbol, entry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button';
    button.dataset.action = action;
    button.setAttribute('aria-label', `${label}: ${entry.title}`);
    button.title = label;
    button.textContent = symbol;
    button.disabled = busy;
    return button;
  }

  function item(entry) {
    const article = document.createElement('article');
    article.className = 'library-item';
    article.dataset.url = entry.url;
    const icon = document.createElement('div');
    icon.className = 'item-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.append(bookmarkIcon());
    const body = document.createElement('div');
    body.className = 'item-body';
    const link = document.createElement('a');
    link.className = 'item-title';
    link.href = safeWorkUrl(entry.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = entry.title;
    link.title = entry.title;
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await chrome.tabs.create({ url: safeWorkUrl(entry.url) });
      } catch { error('作品を開けませんでした。もう一度お試しください。'); }
    });
    const meta = document.createElement('p');
    meta.className = 'item-meta';
    const date = formatDate(entry.readLater ? entry.addedAt : entry.downloadedAt);
    meta.textContent = `momoniji.com${date ? ` · ${date}` : ''}`;
    body.append(link, meta);
    if (Number.isFinite(entry.downloadedAt) && entry.downloadedAt > 0) {
      const downloaded = document.createElement('span');
      downloaded.className = 'downloaded-label';
      downloaded.textContent = '✓ ダウンロード済み';
      if (Number.isInteger(entry.downloadedCount) && entry.downloadedCount > 0) downloaded.textContent += ` · ${entry.downloadedCount}枚`;
      body.append(downloaded);
    }
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    if (entry.readLater === true) {
      const read = actionButton('toggle-read', entry.read ? '未読に戻す' : '読了にする', entry.read ? '↶' : '✓', entry);
      read.setAttribute('aria-pressed', String(entry.read === true));
      read.addEventListener('click', () => mutate({ type: 'MOMONIJI_LIBRARY_READ', url: entry.url, read: !entry.read }, () => {
        showNotice(entry.read ? '未読に戻しました' : '読了にしました', false);
        tabs.find((tab) => tab.dataset.filter === filter)?.focus();
      }));
      const remove = actionButton('remove', '後で読むから削除', '×', entry);
      remove.addEventListener('click', () => mutate({ type: 'MOMONIJI_LIBRARY_REMOVE', url: entry.url }, () => {
        undoEntry = { ...entry };
        showNotice('後で読むから削除しました', true);
        elements.undo.focus();
      }));
      actions.append(read, remove);
    }
    article.append(icon, body, actions);
    return article;
  }

  function renderCurrent() {
    const saved = currentWork && entries.find((entry) => entry.url === currentWork.url);
    const button = elements['current-save'];
    button.disabled = busy || !currentWork || !loaded || saved?.readLater === true;
    button.classList.toggle('saved', saved?.readLater === true);
    elements['current-save-icon'].textContent = saved?.readLater ? '✓' : '＋';
    elements['current-save-label'].textContent = saved?.readLater ? '後で読むに保存済み' : '現在の作品を保存';
    elements['current-title'].textContent = currentWork?.title || '';
    elements['current-description'].textContent = currentWork
      ? (Number.isFinite(saved?.downloadedAt) && saved.downloadedAt > 0 ? '✓ この作品はダウンロード済みです' : '漫画の画像・作品リンクの右クリックからも保存できます。')
      : 'momoniji.com の作品ページで追加できます。';
  }

  function render() {
    const focusedRow = document.activeElement?.closest('.library-item');
    const focusedAction = focusedRow && document.activeElement?.dataset.action;
    const focusedUrl = focusedRow?.dataset.url;
    const query = elements.search.value.trim().normalize('NFKC').toLocaleLowerCase('ja-JP');
    const visible = entries.filter(matchesFilter).filter((entry) => !query || `${entry.title} ${entry.url}`.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(query))
      .sort((a, b) => (filter === 'downloaded' ? b.downloadedAt - a.downloadedAt : b.addedAt - a.addedAt) || a.title.localeCompare(b.title, 'ja'));
    document.getElementById('count-unread').textContent = String(entries.filter((entry) => entry.readLater && !entry.read).length);
    document.getElementById('count-read').textContent = String(entries.filter((entry) => entry.readLater && entry.read).length);
    document.getElementById('count-downloaded').textContent = String(entries.filter((entry) => Number.isFinite(entry.downloadedAt) && entry.downloadedAt > 0).length);
    elements['result-count'].textContent = loaded ? `${visible.length}作品${query ? 'が見つかりました' : ''}` : '読み込み中…';
    elements['library-panel'].setAttribute('aria-busy', String(busy || !loaded));
    const scrollTop = elements['library-list'].scrollTop;
    elements['library-list'].replaceChildren(...visible.slice(0, displayLimit).map(item));
    elements['library-list'].scrollTop = scrollTop;
    elements['load-more'].hidden = visible.length <= displayLimit;
    elements['load-more'].disabled = busy;
    elements['load-more'].textContent = `さらに${Math.min(100, Math.max(0, visible.length - displayLimit))}作品を表示`;
    elements.empty.hidden = !loaded || visible.length > 0;
    elements['empty-title'].textContent = query ? '一致する作品がありません' : filter === 'read' ? '読了した作品はありません' : filter === 'downloaded' ? 'ダウンロード済みの作品はありません' : '後で読む作品はありません';
    elements['empty-description'].textContent = query ? '別の作品名で検索してください。' : filter === 'read' ? '読み終えた作品を「読了にする」で移動できます。' : filter === 'downloaded' ? '全ページのダウンロードが完了すると表示されます。' : '漫画や作品リンクを右クリックして「後で読むに保存」を選んでください。';
    elements.undo.disabled = busy;
    renderCurrent();
    if (!busy && focusedUrl && focusedAction) {
      const row = Array.from(elements['library-list'].children).find((element) => element.dataset.url === focusedUrl);
      const control = row?.querySelector(`[data-action="${focusedAction}"]`);
      if (control) control.focus();
      else if (!elements.undo.matches(':focus')) tabs.find((tab) => tab.dataset.filter === filter)?.focus();
    }
  }

  async function mutate(message, success) {
    if (busy) return false;
    busy = true;
    refreshVersion++;
    error('');
    render();
    let successful = false;
    try {
      const response = await request(message);
      updateEntries(response);
      successful = true;
    } catch (cause) {
      error(cause.message || '保存できませんでした。もう一度お試しください。');
    } finally {
      busy = false;
      render();
    }
    if (successful) success?.();
    return successful;
  }

  async function refresh() {
    if (busy) { refreshTimer = setTimeout(refresh, 150); return; }
    const version = ++refreshVersion;
    try {
      const response = await request({ type: 'MOMONIJI_LIBRARY_LIST' });
      if (version === refreshVersion) updateEntries(response);
    } catch (cause) {
      if (version === refreshVersion) {
        error(cause.message);
        elements['library-panel'].setAttribute('aria-busy', 'false');
        elements['result-count'].textContent = '保存情報を読み込めませんでした';
      }
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 100);
  }

  function selectFilter(next) {
    filter = next;
    displayLimit = 100;
    elements['library-list'].scrollTop = 0;
    for (const tab of tabs) {
      const selected = tab.dataset.filter === next;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    elements['library-panel'].setAttribute('aria-labelledby', `tab-${next}`);
    render();
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectFilter(tab.dataset.filter));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectFilter(tabs[next].dataset.filter);
      tabs[next].focus();
    });
  }
  elements.search.addEventListener('input', () => {
    displayLimit = 100;
    elements['library-list'].scrollTop = 0;
    render();
  });
  elements['load-more'].addEventListener('click', () => {
    displayLimit += 100;
    render();
  });
  elements['current-save'].addEventListener('click', () => {
    if (!currentWork) return;
    mutate({ type: 'MOMONIJI_LIBRARY_SAVE', work: currentWork }, () => {
      elements.search.value = '';
      selectFilter('unread');
      showNotice('後で読むに保存しました', false);
    });
  });
  elements.undo.addEventListener('click', async () => {
    if (!undoEntry || busy) return;
    const entry = undoEntry;
    const restored = await mutate({ type: 'MOMONIJI_LIBRARY_SAVE', work: { url: entry.url, title: entry.title } });
    if (!restored) return;
    if (entry.read === true) {
      const readRestored = await mutate({ type: 'MOMONIJI_LIBRARY_READ', url: entry.url, read: true });
      if (!readRestored) return;
    }
    undoEntry = null;
    showNotice('後で読むに戻しました', false);
    tabs.find((tab) => tab.dataset.filter === filter)?.focus();
  });
  chrome.runtime.onMessage?.addListener((message) => {
    if (message?.type === 'MOMONIJI_LIBRARY_CHANGED') scheduleRefresh();
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, 'momonijiLibrary')) scheduleRefresh();
  });

  async function resolveCurrentWork() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (Number.isInteger(tab?.id) && tab.id >= 0 && safeWorkUrl(tab.url)) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'MOMONIJI_LIBRARY_RESOLVE', url: tab.url });
        const url = safeWorkUrl(response?.work?.url);
        if (response?.ok && url && typeof response.work.title === 'string') currentWork = { url, title: response.work.title };
      }
    } catch { /* Unrelated tabs and tabs awaiting a reload have no content script. */ }
    renderCurrent();
  }
  refresh();
  resolveCurrentWork();
}());
