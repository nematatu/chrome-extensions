(function () {
  "use strict";

  const core = globalThis.GofileBulkCore;
  const BUTTON_HOST_ID = "gofile-bulk-video-button-host";
  const PANEL_HOST_ID = "gofile-bulk-video-progress-host";
  const POLL_INTERVAL_MS = 1000;
  const MAX_RENDERED_ROWS = 100;

  let buttonHost = null;
  let button = null;
  let buttonLabel = null;
  let panelHost = null;
  let panel = null;
  let currentBatch = null;
  let scanning = false;
  let panelHidden = false;
  let statusRequestPending = false;
  let pollTimer = null;
  let lastLocation = location.href;
  let renderQueued = false;
  let renderedBatchId = "";
  let renderedItemKey = "";
  let locationEpoch = 0;
  let statusRequestToken = 0;
  let actionPending = false;
  const itemRows = new Map();

  const ERROR_MESSAGES = Object.freeze({
    ACCESS_REQUIRED: "先にGofile上でパスワード解除またはアクセス確認を完了してから、もう一度お試しください。",
    BATCH_ACTIVE: "現在の一括保存が進行中です。進捗パネルをご確認ください。",
    BATCH_NOT_FOUND: "保存状況を復元できませんでした。ページを再読み込みしてからお試しください。",
    DOWNLOAD_NOT_FOUND: "Chromeの保存履歴から対象を確認できませんでした。対象の動画を再試行してください。",
    FILE_NO_SPACE: "保存先の空き容量が不足しています。空き容量を確保してから再試行してください。",
    INJECTION_FAILED: "Gofileの動画情報を確認できませんでした。ページを再読み込みしてからお試しください。",
    INTERNAL_ERROR: "処理中にエラーが発生しました。少し待ってからもう一度お試しください。",
    NOT_FOUND: "このGofileページは存在しないか、すでに期限切れです。",
    NOTHING_TO_RETRY: "再試行できる動画はありません。",
    PAGE_CHANGED: "確認中にページが移動しました。現在のページでもう一度お試しください。",
    PAGE_NOT_READY: "Gofileの一覧が読み込み終わってから、もう一度お試しください。",
    SCAN_FAILED: "動画一覧の確認に失敗しました。ページを再読み込みしてからお試しください。",
    SITE_CHANGED: "Gofileのページ構成が更新されています。ページを再読み込みしてからお試しください。",
    START_STATE_LOST: "Chromeで保存開始状態を確認できませんでした。対象の動画を再試行してください。",
    TOO_MANY_PAGES: "動画数が非常に多いため、安全のため処理を停止しました。フォルダを分けてからお試しください。",
    TOO_MANY_ACTIVE_BATCHES: "同時に処理中のGofileページが多すぎます。いずれかの一括保存が終わってからお試しください。",
    TOO_MANY_VIDEOS: "動画数が10,000本を超えているため、安全のため処理を停止しました。フォルダを分けてからお試しください。",
    UNTRUSTED_PAGE: "Gofileの共有ページでのみ一括保存を開始できます。",
  });

  const ITEM_ERROR_MESSAGES = Object.freeze({
    CANCEL_PENDING: "キャンセル状態を確認しています",
    CANCEL_STATE_UNKNOWN: "キャンセル結果を確認できませんでした",
    CRASH: "Chromeの終了により中断しました",
    DOWNLOAD_ERASED: "Chromeの保存履歴から削除されました",
    DOWNLOAD_INTERRUPTED: "保存が中断されました",
    DOWNLOAD_NOT_FOUND: "Chromeの保存履歴に見つかりません",
    FILE_ACCESS_DENIED: "保存先へのアクセスが拒否されました",
    FILE_BLOCKED: "Chromeによりファイルがブロックされました",
    FILE_FAILED: "ファイルの保存に失敗しました",
    FILE_HASH_MISMATCH: "ファイルの整合性を確認できませんでした",
    FILE_NAME_TOO_LONG: "ファイル名が長すぎます",
    FILE_NO_SPACE: "保存先の空き容量が不足しています",
    FILE_SECURITY_CHECK_FAILED: "Chromeの安全確認に失敗しました",
    FILE_TOO_LARGE: "ファイルが大きすぎて保存できません",
    FILE_TOO_SHORT: "受信したファイルが不完全です",
    FILE_TRANSIENT_ERROR: "一時的なファイル保存エラーです",
    FILE_VIRUS_INFECTED: "Chromeが危険なファイルとして検出しました",
    INVALID_DOWNLOAD_URL: "安全な保存URLを確認できませんでした",
    NETWORK_DISCONNECTED: "ネットワーク接続が切れました",
    NETWORK_FAILED: "ネットワークエラーが発生しました",
    NETWORK_INVALID_REQUEST: "保存リクエストが拒否されました",
    NETWORK_SERVER_DOWN: "保存先サーバーに接続できません",
    NETWORK_TIMEOUT: "ネットワークがタイムアウトしました",
    SERVER_BAD_CONTENT: "サーバーから正しい動画を受信できませんでした",
    SERVER_CERT_PROBLEM: "サーバー証明書を確認できませんでした",
    SERVER_CONTENT_LENGTH_MISMATCH: "受信した動画サイズが一致しません",
    SERVER_CROSS_ORIGIN_REDIRECT: "安全でないリダイレクトが拒否されました",
    SERVER_FAILED: "Gofileサーバーで保存に失敗しました",
    SERVER_FORBIDDEN: "Gofileサーバーに保存を拒否されました",
    SERVER_NO_RANGE: "サーバーが分割受信に対応していません",
    SERVER_UNAUTHORIZED: "Gofileのアクセス認証が必要です",
    SERVER_UNREACHABLE: "Gofileサーバーに到達できません",
    START_FAILED: "Chromeで保存を開始できませんでした",
    START_STATE_AMBIGUOUS: "保存開始候補が複数あり、自動判定を停止しました",
    START_STATE_LOST: "保存開始状態を確認できませんでした",
    USER_CANCELED: "キャンセルしました",
    USER_SHUTDOWN: "Chromeの終了により中断しました",
  });

  function isSharePage() {
    return core.isGofilePageUrl(location.href);
  }

  function isActiveBatch(batch) {
    return batch?.status === "active";
  }

  function isElementHidden(element) {
    if (!element || !element.isConnected || element.hidden) return true;
    const style = getComputedStyle(element);
    return style.display === "none"
      || style.visibility === "hidden"
      || Number(style.opacity) === 0
      || element.getClientRects().length === 0;
  }

  function isFileManagerReady() {
    const mainContent = document.getElementById("filemanager_maincontent");
    if (!mainContent) return false;
    const loading = document.getElementById("filemanager_loading");
    return !loading || isElementHidden(loading);
  }

  function createButtonHost() {
    buttonHost = document.createElement("div");
    buttonHost.id = BUTTON_HOST_ID;
    buttonHost.style.marginLeft = "auto";
    buttonHost.style.display = "block";
    buttonHost.style.flexShrink = "0";

    const shadow = buttonHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: dark; }
        button {
          align-items: center;
          background: linear-gradient(135deg, #2563eb, #4f46e5);
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 9px;
          box-shadow: 0 6px 18px rgba(37,99,235,.25);
          color: #fff;
          cursor: pointer;
          display: inline-flex;
          font: 700 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          gap: 7px;
          min-height: 34px;
          padding: 7px 12px;
          transition: transform .15s ease, filter .15s ease, opacity .15s ease;
          white-space: nowrap;
        }
        button:hover { filter: brightness(1.08); transform: translateY(-1px); }
        button:active { transform: translateY(0); }
        button:focus-visible { outline: 3px solid rgba(96,165,250,.55); outline-offset: 2px; }
        button[aria-busy="true"] { cursor: progress; opacity: .82; }
        button:disabled { cursor: wait; filter: none; opacity: .65; transform: none; }
        svg { fill: none; height: 17px; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; width: 17px; }
        @media (max-width: 520px) {
          button { font-size: 12px; padding: 7px 9px; }
        }
      </style>
      <button type="button" aria-label="このGofileページの動画を一括保存">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2" />
        </svg>
        <span>動画を一括保存</span>
      </button>
    `;
    button = shadow.querySelector("button");
    buttonLabel = shadow.querySelector("span");
    button.addEventListener("click", handleButtonClick);
    return buttonHost;
  }

  function ensureButton() {
    const existing = document.getElementById(BUTTON_HOST_ID);
    if (existing && existing !== buttonHost) existing.remove();

    if (!isSharePage()) {
      buttonHost?.remove();
      return;
    }

    const header = document.getElementById("index_header");
    if (!header) return;
    if (!buttonHost) createButtonHost();
    if (!buttonHost.isConnected) header.append(buttonHost);
    updateButton();
  }

  function updateButton() {
    if (!button || !buttonLabel) return;
    const pageReady = isFileManagerReady();
    button.disabled = !pageReady;
    button.setAttribute("aria-busy", !pageReady || scanning ? "true" : "false");
    const setButtonText = (visibleText, accessibleName) => {
      if (buttonLabel.textContent !== visibleText) buttonLabel.textContent = visibleText;
      button.setAttribute("aria-label", accessibleName);
    };

    if (!pageReady) {
      setButtonText("一覧を準備中…", "Gofileの動画一覧を準備中");
      return;
    }

    if (scanning) {
      setButtonText("動画を確認中…", "動画を確認中です。進捗を表示");
      return;
    }
    if (isActiveBatch(currentBatch)) {
      const summary = currentBatch.summary;
      const visibleText = currentBatch.cancelRequested
        ? "キャンセルを確認中…"
        : `${summary.percent}%（${summary.completed}/${summary.total}本）`;
      const accessibleName = currentBatch.cancelRequested
        ? "キャンセル状態を確認中です。進捗を表示"
        : `保存進捗 ${summary.percent}%、${summary.completed} / ${summary.total} 本。進捗を表示`;
      setButtonText(visibleText, accessibleName);
      return;
    }
    if (currentBatch?.status === "complete") {
      setButtonText("もう一度一括保存", "保存完了。もう一度このページの動画を一括保存");
      return;
    }
    if (currentBatch?.status === "completed_with_errors" && currentBatch.summary.failed > 0) {
      setButtonText("保存結果を確認", "保存結果とエラー内容を表示");
      return;
    }
    setButtonText("動画を一括保存", "このGofileページの動画を一括保存");
  }

  function createPanelHost() {
    renderedBatchId = "";
    renderedItemKey = "";
    itemRows.clear();
    panelHost = document.createElement("div");
    panelHost.id = PANEL_HOST_ID;
    const shadow = panelHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          bottom: max(16px, env(safe-area-inset-bottom));
          color-scheme: dark;
          display: block;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          position: fixed;
          right: max(16px, env(safe-area-inset-right));
          width: min(390px, calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right)));
          z-index: 2147483647;
        }
        * { box-sizing: border-box; }
        .panel {
          background: rgba(17,24,39,.98);
          border: 1px solid rgba(148,163,184,.35);
          border-radius: 14px;
          box-shadow: 0 20px 55px rgba(0,0,0,.45);
          color: #f8fafc;
          display: flex;
          flex-direction: column;
          max-height: min(72vh, 680px);
          max-height: min(72dvh, 680px, calc(100dvh - 32px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));
          overflow: hidden;
        }
        .header { align-items: center; border-bottom: 1px solid #334155; display: flex; flex: 0 0 auto; gap: 10px; padding: 12px 13px; }
        .header-icon { align-items: center; background: #1d4ed8; border-radius: 9px; display: flex; flex: 0 0 34px; height: 34px; justify-content: center; }
        .header-icon svg { fill: none; height: 19px; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; width: 19px; }
        .heading { min-width: 0; }
        .title { font-size: 14px; font-weight: 750; line-height: 1.35; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .subtitle { color: #94a3b8; font-size: 11px; margin: 2px 0 0; }
        .icon-button { background: transparent; border: 0; border-radius: 7px; color: #cbd5e1; cursor: pointer; font-size: 20px; margin-left: auto; padding: 3px 7px; }
        .icon-button:hover { background: #334155; color: #fff; }
        .icon-button:focus-visible, .action:focus-visible { outline: 3px solid rgba(96,165,250,.65); outline-offset: 2px; }
        .body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; padding: 12px 13px 8px; }
        .progress-head { align-items: baseline; display: flex; justify-content: space-between; }
        .percent { font-size: 25px; font-variant-numeric: tabular-nums; font-weight: 800; letter-spacing: -.5px; }
        .count { color: #cbd5e1; font-size: 12px; font-weight: 650; }
        .track { background: #334155; border-radius: 999px; height: 8px; margin-top: 8px; overflow: hidden; }
        .bar { background: linear-gradient(90deg, #3b82f6, #6366f1); border-radius: inherit; height: 100%; min-width: 0; transition: width .3s ease; width: 0; }
        .summary { color: #e2e8f0; font-size: 12px; line-height: 1.45; margin: 8px 0 0; }
        .meta { color: #94a3b8; font-size: 11px; line-height: 1.45; margin: 2px 0 0; }
        .progress-head, .track, .summary, .meta { flex: 0 0 auto; }
        .list { border-top: 1px solid #334155; flex: 1 1 auto; margin-top: 10px; min-height: 0; overflow: auto; padding: 5px 0; scrollbar-color: #475569 transparent; }
        .row { align-items: center; border-radius: 9px; display: grid; gap: 9px; grid-template-columns: 62px minmax(0, 1fr); margin: 3px 0; padding: 6px; }
        .row:hover { background: rgba(51,65,85,.45); }
        .preview { align-items: center; background: #0f172a; border: 1px solid #334155; border-radius: 7px; display: flex; height: 42px; justify-content: center; overflow: hidden; position: relative; width: 62px; }
        .preview img { height: 100%; object-fit: cover; width: 100%; }
        .placeholder { color: #64748b; display: grid; inset: 0; place-items: center; position: absolute; }
        .placeholder svg { fill: currentColor; height: 20px; width: 20px; }
        .info { min-width: 0; }
        .name { color: #f8fafc; font-size: 12px; font-weight: 650; line-height: 1.35; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .item-line { align-items: center; color: #94a3b8; display: flex; font-size: 10px; gap: 6px; justify-content: space-between; margin-top: 4px; }
        .item-state { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .item-size { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
        .mini-track { background: #334155; border-radius: 999px; height: 3px; margin-top: 4px; overflow: hidden; }
        .mini-bar { background: #60a5fa; height: 100%; transition: width .3s ease; width: 0; }
        .row.complete .mini-bar { background: #22c55e; }
        .row.failed .mini-bar, .row.unavailable .mini-bar { background: #f97316; }
        .more { color: #94a3b8; font-size: 11px; padding: 9px; text-align: center; }
        .footer { align-items: center; border-top: 1px solid #334155; display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 7px; justify-content: flex-end; padding: 9px 13px max(11px, env(safe-area-inset-bottom)); }
        .action { border: 1px solid #475569; border-radius: 8px; color: #fff; cursor: pointer; font-family: inherit; font-size: 11px; font-weight: 650; line-height: 1.2; padding: 7px 10px; }
        .action.cancel { background: #7f1d1d; border-color: #991b1b; }
        .action.retry { background: #1d4ed8; border-color: #2563eb; }
        .action.dismiss { background: #334155; }
        .action:hover { filter: brightness(1.12); }
        .action:disabled { cursor: wait; filter: none; opacity: .6; }
        .action[hidden] { display: none; }
        .empty-list { color: #94a3b8; font-size: 12px; padding: 16px 8px; text-align: center; }
        @media (max-width: 520px) {
          :host {
            bottom: max(8px, env(safe-area-inset-bottom));
            left: max(8px, env(safe-area-inset-left));
            right: max(8px, env(safe-area-inset-right));
            width: auto;
          }
          .panel {
            max-height: 78vh;
            max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
          }
        }
        @media (prefers-reduced-motion: reduce) { .bar, .mini-bar { transition: none; } }
      </style>
      <section class="panel" role="region" aria-label="Gofile動画一括保存の進捗">
        <header class="header">
          <div class="header-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2" /></svg>
          </div>
          <div class="heading">
            <h2 class="title">Gofile 動画一括保存</h2>
            <p class="subtitle">準備中</p>
          </div>
          <button class="icon-button" type="button" data-action="close" aria-label="進捗を閉じる">×</button>
        </header>
        <div class="body">
          <div class="progress-head"><strong class="percent">0%</strong><span class="count">0 / 0 本</span></div>
          <div class="track" role="progressbar" aria-label="動画の一括保存進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0%、動画を確認中"><div class="bar"></div></div>
          <p class="summary" aria-live="polite">動画を確認しています…</p>
          <p class="meta"></p>
          <div class="list"><div class="empty-list">動画情報を読み込んでいます…</div></div>
        </div>
        <footer class="footer">
          <button class="action cancel" type="button" data-action="cancel" hidden>残りをキャンセル</button>
          <button class="action retry" type="button" data-action="retry" hidden>失敗分を再試行</button>
          <button class="action dismiss" type="button" data-action="dismiss" hidden>完了表示を閉じる</button>
        </footer>
      </section>
    `;

    panel = {
      root: shadow.querySelector(".panel"),
      title: shadow.querySelector(".title"),
      subtitle: shadow.querySelector(".subtitle"),
      percent: shadow.querySelector(".percent"),
      count: shadow.querySelector(".count"),
      track: shadow.querySelector(".track"),
      bar: shadow.querySelector(".bar"),
      summary: shadow.querySelector(".summary"),
      meta: shadow.querySelector(".meta"),
      list: shadow.querySelector(".list"),
      cancel: shadow.querySelector('[data-action="cancel"]'),
      retry: shadow.querySelector('[data-action="retry"]'),
      dismiss: shadow.querySelector('[data-action="dismiss"]'),
    };

    shadow.querySelector('[data-action="close"]').addEventListener("click", () => hidePanel());
    panel.cancel.addEventListener("click", () => performBatchAction("gofile-bulk:cancel"));
    panel.retry.addEventListener("click", () => performBatchAction("gofile-bulk:retry"));
    panel.dismiss.addEventListener("click", dismissBatch);
    (document.body || document.documentElement).append(panelHost);
  }

  function setPanelVisible(visible) {
    if (!panelHost) return;
    panelHost.hidden = !visible;
    panelHost.style.display = visible ? "block" : "none";
  }

  function ensurePanel() {
    if (!panelHost || !panelHost.isConnected) createPanelHost();
    panelHidden = false;
    setPanelVisible(true);
  }

  function hidePanel(restoreFocus = true) {
    if (!panelHost) return;
    panelHidden = true;
    setPanelVisible(false);
    if (restoreFocus && button?.isConnected && !button.disabled) {
      button.focus({ preventScroll: true });
    }
  }

  function showPanel() {
    ensurePanel();
    if (currentBatch) renderBatch(currentBatch);
  }

  function setProgress(percent, valueText = "") {
    const safePercent = Math.min(100, Math.max(0, Number(percent) || 0));
    panel.percent.textContent = `${safePercent}%`;
    panel.bar.style.width = `${safePercent}%`;
    panel.track.setAttribute("aria-valuenow", String(safePercent));
    panel.track.setAttribute("aria-valuetext", valueText || `${safePercent}%`);
  }

  function setTextIfChanged(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function showScanning() {
    ensurePanel();
    renderedBatchId = "";
    renderedItemKey = "";
    itemRows.clear();
    panel.title.textContent = "Gofile 動画一括保存";
    panel.subtitle.textContent = "全ページを確認中";
    panel.count.textContent = "— / — 本";
    setProgress(0, "0%、動画を確認中");
    setTextIfChanged(panel.summary, "このフォルダの動画を安全に確認しています…");
    panel.meta.textContent = "認証情報やパスワードは拡張機能に保存しません。";
    panel.list.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "empty-list";
    loading.textContent = "動画情報を読み込んでいます…";
    panel.list.append(loading);
    panel.cancel.hidden = true;
    panel.retry.hidden = true;
    panel.dismiss.hidden = true;
  }

  function showError(code) {
    scanning = false;
    ensurePanel();
    currentBatch = null;
    renderedBatchId = "";
    renderedItemKey = "";
    itemRows.clear();
    panel.title.textContent = "Gofile 動画一括保存";
    panel.subtitle.textContent = "確認が必要です";
    panel.count.textContent = "0 / 0 本";
    setProgress(0, "0%、処理を開始できませんでした");
    setTextIfChanged(
      panel.summary,
      ERROR_MESSAGES[code] || "処理を完了できませんでした。ページを再読み込みしてからお試しください。",
    );
    panel.meta.textContent = "ファイルの削除や上書きは行っていません。";
    panel.list.replaceChildren();
    const message = document.createElement("div");
    message.className = "empty-list";
    message.textContent = "ページを確認後、上部のボタンから再試行できます。";
    panel.list.append(message);
    panel.cancel.hidden = true;
    panel.retry.hidden = true;
    panel.dismiss.hidden = true;
    updateButton();
  }

  function createPreview(thumbnail) {
    const preview = document.createElement("div");
    preview.className = "preview";
    const placeholder = document.createElement("span");
    placeholder.className = "placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V9l4-2v10l-4-2v3.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 18.5z"/></svg>';
    preview.append(placeholder);

    if (thumbnail) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.src = thumbnail;
      image.addEventListener("load", () => { placeholder.hidden = true; }, { once: true });
      image.addEventListener("error", () => { image.remove(); }, { once: true });
      preview.append(image);
    }
    return preview;
  }

  function createItemRow(item, unavailableReason = "") {
    const row = document.createElement("div");
    row.className = unavailableReason ? "row unavailable" : "row";
    row.append(createPreview(item.thumbnail));

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("p");
    name.className = "name";
    name.textContent = item.name;
    name.title = item.name;
    const itemLine = document.createElement("div");
    itemLine.className = "item-line";
    const state = document.createElement("span");
    state.className = "item-state";
    const size = document.createElement("span");
    size.className = "item-size";
    size.textContent = core.formatBytes(item.size);
    itemLine.append(state, size);
    const miniTrack = document.createElement("div");
    miniTrack.className = "mini-track";
    miniTrack.setAttribute("aria-hidden", "true");
    const miniBar = document.createElement("div");
    miniBar.className = "mini-bar";
    miniTrack.append(miniBar);
    info.append(name, itemLine, miniTrack);
    row.append(info);

    return { row, state, size, bar: miniBar, unavailableReason };
  }

  function unavailableText(reason) {
    if (reason === "frozen") return "Gofile側で凍結中";
    if (reason === "overloaded") return "Gofile側で一時利用不可";
    if (reason === "unsafe-link") return "安全なGofile保存URLではないため除外";
    if (reason === "invalid-metadata") return "動画情報を安全に確認できないため除外";
    return "ダウンロードリンクなし";
  }

  function skippedReasonSummary(reasons) {
    if (!reasons || typeof reasons !== "object") return "";
    const labels = {
      frozen: "凍結",
      overloaded: "一時利用不可",
      "missing-link": "リンクなし",
      "unsafe-link": "安全URL外",
      "invalid-metadata": "情報不整合",
    };
    return Object.entries(labels)
      .filter(([reason]) => Number(reasons[reason]) > 0)
      .map(([reason, label]) => `${label} ${Number(reasons[reason])}本`)
      .join("・");
  }

  function itemErrorText(error) {
    if (!error) return "原因を確認できませんでした";
    const code = String(error).slice(0, 80);
    return ITEM_ERROR_MESSAGES[code] || `保存エラー（${code}）`;
  }

  function itemStatusText(item) {
    if (item.danger && item.danger !== "safe" && item.danger !== "accepted") return "Chromeで安全確認が必要";
    if (item.status === "queued") return "待機中";
    if (item.status === "starting") return "開始中";
    if (item.status === "downloading") return `保存中 ${item.progress}%`;
    if (item.status === "complete") return "保存済み";
    if (item.status === "canceled") return item.error ? itemErrorText(item.error) : "キャンセル済み";
    if (item.status === "failed" || item.status === "interrupted") {
      const retryText = item.retryable === false ? "再試行不可" : "再試行できます";
      return `${itemErrorText(item.error)}（${retryText}）`;
    }
    return "確認中";
  }

  function visibleEntries(batch) {
    const entries = [];
    const items = Array.isArray(batch.items) ? batch.items : [];
    const skipped = Array.isArray(batch.skipped) ? batch.skipped : [];

    for (const item of items) {
      if (entries.length >= MAX_RENDERED_ROWS) break;
      entries.push({ item, unavailableReason: "" });
    }
    for (const item of skipped) {
      if (entries.length >= MAX_RENDERED_ROWS) break;
      entries.push({ item, unavailableReason: item.reason });
    }
    return entries;
  }

  function entryKey(entry) {
    return `${entry.unavailableReason ? "skip:" : "item:"}${entry.item.id}`;
  }

  function visibleItemKey(entries) {
    return JSON.stringify(entries.map(entryKey));
  }

  function batchCounts(batch, renderedCount) {
    const visibleItemCount = Array.isArray(batch.items) ? batch.items.length : 0;
    const visibleSkippedCount = Array.isArray(batch.skipped) ? batch.skipped.length : 0;
    const itemCount = Number.isSafeInteger(batch.itemCount) && batch.itemCount >= 0
      ? batch.itemCount
      : visibleItemCount;
    const skippedCount = Number.isSafeInteger(batch.skippedCount) && batch.skippedCount >= 0
      ? batch.skippedCount
      : visibleSkippedCount;
    const totalCount = itemCount + skippedCount;
    const reportedOmitted = Number.isSafeInteger(batch.omittedCount) && batch.omittedCount >= 0
      ? batch.omittedCount
      : 0;
    return {
      itemCount,
      skippedCount,
      omittedCount: Math.max(reportedOmitted, totalCount - renderedCount),
      totalCount,
    };
  }

  function buildRows(batch, entries, itemKey, counts) {
    renderedBatchId = batch.id;
    renderedItemKey = itemKey;
    itemRows.clear();
    const fragment = document.createDocumentFragment();

    for (const entry of entries) {
      const row = createItemRow(entry.item, entry.unavailableReason);
      fragment.append(row.row);
      itemRows.set(entryKey(entry), row);
    }

    if (counts.totalCount === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "このフォルダに動画はありません（0本）。";
      fragment.append(empty);
    } else if (counts.omittedCount > 0) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = `ほか ${counts.omittedCount} 本は一覧表示を省略しています。保存処理には影響しません。`;
      fragment.append(more);
    }

    panel.list.replaceChildren(fragment);
  }

  function updateRows(batch) {
    const items = Array.isArray(batch.items) ? batch.items : [];
    const skipped = Array.isArray(batch.skipped) ? batch.skipped : [];
    for (const item of items) {
      const row = itemRows.get(`item:${item.id}`);
      if (!row) continue;
      const statusText = itemStatusText(item);
      row.state.textContent = statusText;
      row.state.title = statusText;
      row.bar.style.width = `${item.progress}%`;
      row.row.classList.toggle("complete", item.status === "complete");
      row.row.classList.toggle("failed", item.status === "failed" || item.status === "interrupted");
      const expected = item.totalBytes > 0 ? item.totalBytes : item.size;
      row.size.textContent = item.status === "downloading" && expected > 0
        ? `${core.formatBytes(item.bytesReceived)} / ${core.formatBytes(expected)}`
        : core.formatBytes(item.size);
    }

    for (const item of skipped) {
      const row = itemRows.get(`skip:${item.id}`);
      if (!row) continue;
      const statusText = unavailableText(item.reason);
      row.state.textContent = statusText;
      row.state.title = statusText;
      row.bar.style.width = "0%";
    }
  }

  function retryableFailureCount(batch) {
    const count = batch?.summary?.retryableFailures;
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  function renderBatch(batch) {
    currentBatch = batch;
    if (!panelHost || !panelHost.isConnected) createPanelHost();
    setPanelVisible(!panelHidden);
    const summary = batch.summary;
    const entries = visibleEntries(batch);
    const itemKey = visibleItemKey(entries);
    const counts = batchCounts(batch, entries.length);
    const skippedCount = counts.skippedCount;

    panel.title.textContent = batch.folderName || "Gofile 動画一括保存";
    panel.subtitle.textContent = batch.cancelRequested
      ? "キャンセル状態を確認中"
      : batch.retryRequested
        ? "再試行キューを復元中"
        : batch.status === "active"
      ? "動画をまとめて保存中"
      : batch.status === "complete"
        ? skippedCount > 0 ? "保存可能な動画を保存しました" : "すべて保存しました"
        : batch.status === "empty"
          ? "動画はありません"
          : "保存処理が終了しました";
    panel.count.textContent = `${summary.completed} / ${summary.total} 本`;
    setProgress(summary.percent, `${summary.percent}%、${summary.completed} / ${summary.total} 本保存済み`);

    let summaryText;
    if (batch.cancelRequested) {
      summaryText = "キャンセル済みかどうかをChromeの保存履歴と照合しています…";
    } else if (batch.retryRequested) {
      summaryText = "失敗した動画の再試行キューを安全に復元しています…";
    } else if (batch.status === "complete") {
      summaryText = skippedCount > 0
        ? `${summary.total} 本を保存しました。安全上またはGofile側の理由で ${skippedCount} 本は対象外です。`
        : `${summary.total} 本の動画をすべて保存しました。`;
    } else if (batch.status === "empty") {
      summaryText = skippedCount > 0
        ? `保存可能な動画は0本です（安全上またはGofile側の理由で対象外: ${skippedCount}本）。`
        : "このフォルダに動画はありません（0本）。";
    } else if (batch.status === "completed_with_errors") {
      summaryText = `${summary.completed} / ${summary.total} 本を保存しました。失敗 ${summary.failed} 本、キャンセル ${summary.canceled} 本です。`;
    } else {
      summaryText = `${summary.completed} / ${summary.total} 本保存済み・保存中 ${summary.downloading} 本・待機中 ${summary.queued} 本`;
    }
    setTextIfChanged(panel.summary, summaryText);

    const byteText = summary.totalBytes > 0
      ? `${core.formatBytes(summary.bytesReceived)} / ${core.formatBytes(summary.totalBytes)}`
      : "サイズを確認中";
    const reasonText = skippedReasonSummary(batch.skippedReasons);
    panel.meta.textContent = skippedCount > 0
      ? `${byteText}・対象外 ${skippedCount} 本${reasonText ? `（${reasonText}）` : ""}`
      : byteText;

    if (renderedBatchId !== batch.id || renderedItemKey !== itemKey) {
      buildRows(batch, entries, itemKey, counts);
    }
    updateRows(batch);

    panel.cancel.hidden = batch.status !== "active" || batch.cancelRequested || batch.retryRequested;
    panel.retry.hidden = !(batch.status === "completed_with_errors" && retryableFailureCount(batch) > 0);
    panel.dismiss.hidden = batch.status === "active";
    updateButton();
    updatePolling();
  }

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  }

  async function handleButtonClick() {
    if (!isFileManagerReady()) return;
    if (scanning) {
      showPanel();
      return;
    }
    if (isActiveBatch(currentBatch) || (currentBatch?.status === "completed_with_errors" && currentBatch.summary.failed > 0)) {
      showPanel();
      return;
    }

    const startEpoch = locationEpoch;
    const startUrl = location.href;
    scanning = true;
    currentBatch = null;
    updateButton();
    showScanning();
    const response = await sendMessage({ type: "gofile-bulk:start" });
    if (startEpoch !== locationEpoch || startUrl !== location.href) return;
    scanning = false;

    if (!response?.ok || !response.batch) {
      showError(response?.error || "INTERNAL_ERROR");
      return;
    }
    renderBatch(response.batch);
  }

  async function requestStatus() {
    if (statusRequestPending) return;
    const requestToken = ++statusRequestToken;
    const requestEpoch = locationEpoch;
    const requestUrl = location.href;
    statusRequestPending = true;
    const response = await sendMessage({ type: "gofile-bulk:status" });
    if (requestToken === statusRequestToken) statusRequestPending = false;
    if (requestToken !== statusRequestToken || requestEpoch !== locationEpoch || requestUrl !== location.href) return;
    if (response?.ok && response.batch) {
      renderBatch(response.batch);
    } else if (response?.ok && !response.batch) {
      currentBatch = null;
      updateButton();
      updatePolling();
    }
  }

  async function performBatchAction(type) {
    if (!currentBatch?.id || actionPending) return;
    const batchId = currentBatch.id;
    const actionEpoch = locationEpoch;
    setActionPending(true);
    const response = await sendMessage({ type, batchId });
    if (actionEpoch !== locationEpoch || batchId !== currentBatch?.id) {
      setActionPending(false);
      return;
    }
    setActionPending(false);
    if (!response?.ok) {
      showError(response?.error || "INTERNAL_ERROR");
      return;
    }
    if (response.batch) renderBatch(response.batch);
  }

  async function dismissBatch() {
    if (actionPending) return;
    if (!currentBatch?.id) {
      hidePanel();
      return;
    }
    const batchId = currentBatch.id;
    const dismissEpoch = locationEpoch;
    setActionPending(true);
    const response = await sendMessage({ type: "gofile-bulk:dismiss", batchId });
    if (dismissEpoch !== locationEpoch || batchId !== currentBatch?.id) {
      setActionPending(false);
      return;
    }
    setActionPending(false);
    if (!response?.ok) {
      showError(response?.error || "INTERNAL_ERROR");
      return;
    }
    currentBatch = null;
    renderedBatchId = "";
    renderedItemKey = "";
    itemRows.clear();
    hidePanel();
    updateButton();
    updatePolling();
  }

  function updatePolling() {
    if (isActiveBatch(currentBatch)) {
      if (!pollTimer) pollTimer = setInterval(requestStatus, POLL_INTERVAL_MS);
    } else {
      stopPolling();
    }
  }

  function setActionPending(value) {
    actionPending = value;
    if (!panel) return;
    panel.cancel.disabled = value;
    panel.retry.disabled = value;
    panel.dismiss.disabled = value;
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function detachPageState() {
    locationEpoch += 1;
    statusRequestToken += 1;
    statusRequestPending = false;
    scanning = false;
    actionPending = false;
    setActionPending(false);
    currentBatch = null;
    renderedBatchId = "";
    renderedItemKey = "";
    itemRows.clear();
    panelHidden = true;
    setPanelVisible(false);
    stopPolling();
  }

  function queuePageCheck() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (location.href !== lastLocation) {
        lastLocation = location.href;
        detachPageState();
        ensureButton();
        void requestStatus();
        return;
      }
      ensureButton();
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "gofile-bulk:updated") void requestStatus();
  });

  new MutationObserver(queuePageCheck).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("popstate", queuePageCheck);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void requestStatus();
  });
  setInterval(queuePageCheck, 750);

  ensureButton();
  void requestStatus();
})();
