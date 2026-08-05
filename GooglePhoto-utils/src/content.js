(() => {
  "use strict";

  const STORAGE_KEY = "gpu-albums-v2";
  const COLLAPSED_KEY = "gpu-panel-collapsed-v1";
  const MAX_SHORTCUTS = 10;
  const MAX_HISTORY = 40;

  const WAIT_STEP_MS = 120;
  const WAIT_TIMEOUT_MS = 5000;
  const RPC_TIMEOUT_MS = 12000;

  const LABELS = {
    moreOptions: [
      "More options",
      "More actions",
      "Options",
      "その他のオプション",
      "その他",
      "その他の操作"
    ],
    addToAlbum: [
      "Add to album",
      "Add to Album",
      "Add to",
      "Save to album",
      "アルバムに追加",
      "アルバムまたは共有アルバムに追加",
      "アルバムに追加または作成",
      "追加先"
    ]
  };

  const ALBUM_CHOOSER_HINTS = [
    "create album",
    "new album",
    "search",
    "add to album",
    "アルバムを作成",
    "新しいアルバム",
    "検索",
    "アルバムに追加"
  ];

  const EXCLUDED_ALBUM_TEXT = [
    "add to album",
    "create album",
    "new album",
    "search",
    "done",
    "cancel",
    "close",
    "photo",
    "photos",
    "items",
    "item",
    "select",
    "searchcancel検索をクリア",
    "アルバムに追加",
    "アルバムを作成",
    "新しいアルバム",
    "アルバムリスト",
    "オーナーでアルバムをフィルタ",
    "すべてのアルバムを表示",
    "マイアルバムを表示",
    "共有されたアルバムを表示",
    "並べ替え",
    "検索",
    "完了",
    "キャンセル",
    "閉じる",
    "写真",
    "枚",
    "選択"
  ];

  const EXCLUDED_ALBUM_TEXT_PARTS = [
    "searchcancel",
    "アルバムリスト",
    "オーナーでアルバムをフィルタ",
    "すべてのアルバムを表示",
    "マイアルバムを表示",
    "共有されたアルバムを表示",
    "共有アイテム",
    "並べ替え",
    "検索をクリア",
    "撮影日時の新しい順",
    "最終更新",
    "アルバムのタイトル",
    "その他のオプション",
    "新しいアルバム",
    "アルバムに追加",
    "アルバムを作成"
  ];

  let albums = [];
  let displayAlbums = [];
  let busy = false;
  let lastAlbumName = "";
  let panel;
  let statusNode;
  let albumListNode;
  let diagnosticsNode;
  let toastTimer;
  let autoRefreshTimer;
  let lastAutoRefreshAttempt = 0;

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const lower = (value) => normalize(value).toLocaleLowerCase();

  const isEditableTarget = (target) => {
    if (!target) return false;
    const element = target instanceof Element ? target : target.parentElement;
    if (!element) return false;
    return Boolean(
      element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")
    );
  };

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const getElementText = (element) => {
    const aria = element.getAttribute("aria-label");
    const title = element.getAttribute("title");
    return normalize([aria, title, element.textContent].filter(Boolean).join(" "));
  };

  const isOwnUi = (element) => {
    return Boolean(element.closest(".gpu-panel, .gpu-toast"));
  };

  const clickableSelector = [
    "button",
    "[role='button']",
    "[role='menuitem']",
    "[role='option']",
    "[role='listitem']",
    "a",
    "[tabindex]"
  ].join(",");

  const toClickable = (element) => {
    if (!(element instanceof Element)) return null;
    return element.matches(clickableSelector) ? element : element.closest(clickableSelector);
  };

  const getPrimaryText = (element) => {
    const aria = normalize(element.getAttribute("aria-label"));
    const title = normalize(element.getAttribute("title"));
    const visibleText = normalize(element.textContent).split(/\s{2,}|\n/)[0];
    return normalize(aria || title || visibleText);
  };

  const splitCandidateText = (value) => {
    return String(value || "")
      .split(/\n|\r|\t| {2,}|·|•/)
      .map(normalize)
      .filter(Boolean);
  };

  const findClickableByLabel = (labels, root = document) => {
    return findClickableCandidatesByLabel(labels, root)[0] || null;
  };

  const findClickableCandidatesByLabel = (labels, root = document) => {
    const expected = labels.map(lower);
    const broadSelectors = `${clickableSelector}, [aria-label], [title]`;
    const candidates = [...root.querySelectorAll(broadSelectors)]
      .map(toClickable)
      .filter((candidate, index, all) => (
        candidate &&
        all.indexOf(candidate) === index &&
        isVisible(candidate) &&
        !isOwnUi(candidate)
      ));

    return candidates.filter((candidate) => {
      const text = lower(getElementText(candidate));
      return expected.some((label) => text === label || text.includes(label));
    });
  };

  const findClickableByText = (text, root = document) => {
    const expected = lower(text);
    if (!expected) return null;

    const clickable = getClickableCandidates(root).find((candidate) => {
      const candidateText = lower(getElementText(candidate));
      return candidateText === expected || candidateText.includes(expected);
    });

    return clickable || findTextAction([text], root);
  };

  const getClickableCandidates = (root = document) => {
    return [...root.querySelectorAll(clickableSelector)].filter((element) => (
      isVisible(element) && !isOwnUi(element)
    ));
  };

  const getTextCandidates = (root = document) => {
    const selectors = [
      "[aria-label]",
      "[title]",
      "[role='listitem']",
      "[role='option']",
      "[role='gridcell']",
      "li",
      "span",
      "div"
    ].join(",");

    const names = [];
    const seen = new Set();

    [...root.querySelectorAll(selectors)].forEach((element) => {
      if (!isVisible(element) || isOwnUi(element)) return;

      const rect = element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 12 || rect.height > 180) return;

      const rawValues = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent
      ];

      rawValues.flatMap(splitCandidateText).forEach((candidate) => {
        const name = cleanAlbumName(candidate);
        if (!name || seen.has(name)) return;
        seen.add(name);
        names.push(name);
      });
    });

    return names;
  };

  const getAlbumRowNames = (root = document) => {
    const selectors = [
      "[role='listitem']",
      "[role='option']",
      "[role='gridcell']",
      "[data-is-focusable='true']",
      "li",
      "button",
      "a",
      "div"
    ].join(",");
    const names = [];
    const seen = new Set();

    [...root.querySelectorAll(selectors)].forEach((element) => {
      if (!isVisible(element) || isOwnUi(element)) return;

      const rect = element.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 24 || rect.height > 120) return;

      const text = normalize(element.textContent);
      if (!/(?:\d+\s*個のファイル|ファイルなし|共有中)/.test(text)) return;

      const name = extractAlbumNameFromRowText(text);
      if (!name || seen.has(name) || !isLikelyAlbumName(name)) return;
      seen.add(name);
      names.push(name);
    });

    return names;
  };

  const extractAlbumNamesFromLongText = (text) => {
    const cleaned = normalize(text);
    const markers = [...cleaned.matchAll(/(?:\d+\s*個のファイル|ファイルなし)(?:\s*·\s*共有中)?/g)];
    const names = [];
    const seen = new Set();

    markers.forEach((marker, index) => {
      const previousEnd = index === 0 ? 0 : markers[index - 1].index + markers[index - 1][0].length;
      let rawName = cleaned.slice(previousEnd, marker.index);

      if (index === 0) {
        rawName = rawName
          .replace(/^.*?(?:新しいアルバム|new album|add)\s*/i, "")
          .replace(/^.*?(?:アルバムのタイトル|album title)\s*/i, "");
      }

      const name = extractAlbumNameFromRowText(`${rawName}${marker[0]}`);
      if (!name || seen.has(name) || !isLikelyAlbumName(name)) return;
      seen.add(name);
      names.push(name);
    });

    return names;
  };

  const waitFor = async (callback, timeout = WAIT_TIMEOUT_MS) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const result = callback();
      if (result) return result;
      await sleep(WAIT_STEP_MS);
    }
    return null;
  };

  const withTimeout = (promise, timeoutMs, label) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error(`${label} がタイムアウトしました。`)), timeoutMs);
      })
    ]);
  };

  const readGooglePhotosGlobals = async () => {
    if (window.__gpuGooglePhotosGlobals) return window.__gpuGooglePhotosGlobals;

    const globals = await withTimeout(new Promise((resolve) => {
      window.addEventListener("gpu-response-google-photos-globals", (event) => {
        resolve(event.detail || {});
      }, { once: true });
      window.dispatchEvent(new CustomEvent("gpu-request-google-photos-globals"));
    }), 2000, "Googleフォトのセッション値取得");

    const userPath = location.pathname.match(/^\/u\/\d+\//)?.[0] || "/";
    const normalized = {
      ...globals,
      path: globals.path || userPath
    };

    if (!normalized.fSid || !normalized.bl || !normalized.at) {
      throw new Error("Googleフォトの内部API用セッション値を取得できませんでした。ページ再読み込み後に再試行してください。");
    }

    window.__gpuGooglePhotosGlobals = normalized;
    return normalized;
  };

  const makeGooglePhotosRpc = async (rpcid, requestData) => {
    const globals = await readGooglePhotosGlobals();
    const wrappedData = [[[rpcid, JSON.stringify(requestData), null, "generic"]]];
    const body = `f.req=${encodeURIComponent(JSON.stringify(wrappedData))}&at=${encodeURIComponent(globals.at)}&`;
    const params = new URLSearchParams({
      rpcids: rpcid,
      "source-path": location.pathname,
      "f.sid": globals.fSid,
      bl: globals.bl,
      pageId: "none",
      rt: "c"
    });

    if (typeof globals.rapt === "string" && globals.rapt) {
      params.set("rapt", globals.rapt);
    }

    const response = await fetch(`https://photos.google.com${globals.path}data/batchexecute?${params.toString()}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body
    });

    if (!response.ok) {
      throw new Error(`Googleフォト内部API ${rpcid} が失敗しました: HTTP ${response.status}`);
    }

    const text = await response.text();
    const jsonLine = text.split("\n").find((line) => line.includes("wrb.fr"));
    if (!jsonLine) {
      throw new Error(`Googleフォト内部API ${rpcid} の応答形式を解析できませんでした。`);
    }

    const envelope = JSON.parse(jsonLine);
    const payload = envelope?.[0]?.[2];
    if (!payload) {
      throw new Error(`Googleフォト内部API ${rpcid} の応答にpayloadがありません。`);
    }

    return JSON.parse(payload);
  };

  const clickElement = (element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
  };

  const parseRpcAlbum = (itemData) => {
    const albumData = itemData?.at?.(-1)?.[72930366] || itemData?.[itemData.length - 1]?.[72930366];
    const title = albumData?.[1];
    const mediaKey = itemData?.[0];
    if (!mediaKey || !title) return null;

    return {
      id: mediaKey,
      mediaKey,
      name: title,
      title,
      itemCount: albumData?.[3],
      creationTimestamp: albumData?.[2]?.[4] || 0,
      modifiedTimestamp: albumData?.[2]?.[9] || 0,
      isShared: Boolean(albumData?.[4]),
      source: "rpc"
    };
  };

  const parseRpcAlbumsPage = (data) => ({
    items: (data?.[0] || []).map(parseRpcAlbum).filter(Boolean),
    nextPageId: data?.[1] || null
  });

  const fetchAlbumsByRpc = async () => {
    const allAlbums = [];
    let pageId = null;

    for (let page = 0; page < 8; page += 1) {
      const response = await withTimeout(
        makeGooglePhotosRpc("Z5xsfc", [pageId, null, null, null, 1, null, null, 100, [2], 5]),
        RPC_TIMEOUT_MS,
        "アルバム一覧取得"
      );
      const parsed = parseRpcAlbumsPage(response);
      allAlbums.push(...parsed.items);
      pageId = parsed.nextPageId;
      if (!pageId) break;
    }

    return sortAlbumsNewestFirst(allAlbums);
  };

  const getCurrentMediaKey = () => {
    const match = location.pathname.match(/\/photo\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  const addMediaKeyToAlbumByRpc = async (mediaKey, album) => {
    if (!album?.mediaKey) {
      throw new Error("アルバムIDが未取得です。更新ボタンでアルバム一覧を再取得してください。");
    }

    const rpcid = album.isShared ? "laUYf" : "E1Cajb";
    const requestData = album.isShared
      ? [album.mediaKey, [2, null, [[[mediaKey]]], null, null, null, [1]]]
      : [[mediaKey], album.mediaKey];

    return withTimeout(makeGooglePhotosRpc(rpcid, requestData), RPC_TIMEOUT_MS, "アルバム追加");
  };

  const scoreToolbarCandidate = (element) => {
    const rect = element.getBoundingClientRect();
    let score = 0;

    if (rect.top < 120) score += 6;
    if (rect.left > window.innerWidth * 0.55) score += 4;
    if (rect.right > window.innerWidth * 0.72) score += 3;
    if (rect.width <= 64 && rect.height <= 64) score += 2;

    const text = lower(getElementText(element));
    if (text === "more options" || text === "その他のオプション") score += 8;
    if (text === "その他") score += 4;

    return score;
  };

  const pressEscape = () => {
    const target = document.activeElement || document.body || document;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
  };

  const setStatus = (message, kind = "") => {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.dataset.kind = kind;
  };

  const showToast = (message) => {
    const existing = document.querySelector(".gpu-toast");
    if (existing) existing.remove();
    window.clearTimeout(toastTimer);

    const toast = document.createElement("div");
    toast.className = "gpu-toast";
    toast.textContent = message;
    document.documentElement.append(toast);

    toastTimer = window.setTimeout(() => toast.remove(), 2400);
  };

  const getAlbumName = (album) => album.name || album.title || "";

  const getAlbumSortTimestamp = (album) => {
    const usedAt = Number(album.usedAt || 0);
    const modified = Number(album.modifiedTimestamp || 0);
    const created = Number(album.creationTimestamp || 0);

    // Google Photos RPC timestamps are in microseconds (us),
    // while Date.now() is in milliseconds (ms).
    // Normalize everything to microseconds.
    const normUsedAt = usedAt > 1e14 ? usedAt : usedAt * 1000;
    const normModified = modified > 1e14 ? modified : modified * 1000;
    const normCreated = created > 1e14 ? created : created * 1000;

    return Math.max(normUsedAt, normModified, normCreated);
  };

  const sortAlbumsNewestFirst = (albumList) => {
    return [...albumList].sort((a, b) => (
      getAlbumSortTimestamp(b) - getAlbumSortTimestamp(a) ||
      getAlbumName(a).localeCompare(getAlbumName(b), "ja")
    ));
  };

  const saveAlbums = async () => {
    // 容量節約のため、最小限のフィールドのみ保存
    const toSave = albums.map((album) => ({
      id: album.id,
      mediaKey: album.mediaKey,
      name: album.name,
      itemCount: album.itemCount,
      creationTimestamp: album.creationTimestamp,
      modifiedTimestamp: album.modifiedTimestamp,
      isShared: album.isShared,
      usedAt: album.usedAt
    }));
    await chrome.storage.local.set({ [STORAGE_KEY]: toSave });
  };

  const mergeAlbums = async (albumInputs) => {
    const known = new Map(albums.map((album) => [getAlbumName(album), album]));
    albumInputs.forEach((input) => {
      const album = typeof input === "string"
        ? { id: crypto.randomUUID(), name: cleanAlbumName(input), usedAt: 0, source: "dom" }
        : {
          id: input.id || input.mediaKey || crypto.randomUUID(),
          name: cleanAlbumName(input.name || input.title),
          mediaKey: input.mediaKey || null,
          itemCount: input.itemCount,
          creationTimestamp: Number(input.creationTimestamp || 0),
          modifiedTimestamp: Number(input.modifiedTimestamp || 0),
          isShared: Boolean(input.isShared),
          usedAt: Number(input.usedAt || 0),
          source: input.source || "rpc"
        };

      if (!album.name || !isLikelyAlbumName(album.name)) return;

      const existing = known.get(album.name);
      if (existing) {
        known.set(album.name, { ...existing, ...album, usedAt: existing.usedAt || album.usedAt || 0 });
      } else {
        known.set(album.name, album);
      }
    });

    albums = sortAlbumsNewestFirst([...known.values()]).slice(0, MAX_HISTORY);
    updateDisplayAlbums();

    await saveAlbums();
    renderAlbums();
  };

  const updateDisplayAlbums = () => {
    displayAlbums = albums.slice(0, MAX_SHORTCUTS);
  };

  const markAlbumUsed = async (albumName) => {
    albums = albums.map((album) => (
      getAlbumName(album) === albumName ? { ...album, usedAt: Date.now() } : album
    ));
    // 内部データは並べ替えて保存するが、UIの displayAlbums は更新しない
    albums = sortAlbumsNewestFirst(albums);
    await saveAlbums();
    // UIはリビルドせず、位置を固定する
  };

  const renderAlbums = () => {
    if (!albumListNode) return;
    albumListNode.replaceChildren();

    displayAlbums.forEach((album, index) => {
      const albumName = getAlbumName(album);
      const row = document.createElement("div");
      row.className = "gpu-album-row";

      const key = document.createElement("div");
      key.className = "gpu-key";
      key.textContent = index === 9 ? "0" : String(index + 1);

      const name = document.createElement("button");
      name.className = "gpu-album-name gpu-album-button";
      name.type = "button";
      name.title = album.mediaKey ? `${albumName}${album.isShared ? " / 共有" : ""}` : albumName;
      name.textContent = albumName;
      name.addEventListener("click", () => {
        void addCurrentPhotoToAlbum(album);
      });

      row.append(key, name);
      albumListNode.append(row);
    });

    if (albums.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gpu-help";
      empty.textContent = "写真プレビューを開くとアルバム候補を自動取得します。";
      albumListNode.append(empty);
    }
  };

  const normalizeStoredAlbums = (storedAlbums) => {
    try {
      if (!Array.isArray(storedAlbums)) return [];

      const seen = new Set();
      return storedAlbums
        .map((album) => {
          if (!album || typeof album !== "object") return null;
          return {
            id: album.id || crypto.randomUUID(),
            name: cleanAlbumName(album.name || album.title || ""),
            mediaKey: album.mediaKey || null,
            itemCount: album.itemCount || 0,
            creationTimestamp: Number(album.creationTimestamp || 0),
            modifiedTimestamp: Number(album.modifiedTimestamp || 0),
            isShared: Boolean(album.isShared),
            usedAt: Number(album.usedAt || 0)
          };
        })
        .filter((album) => {
          if (!album || !isLikelyAlbumName(album.name) || seen.has(album.name)) return false;
          seen.add(album.name);
          return true;
        })
        .sort((a, b) => getAlbumSortTimestamp(b) - getAlbumSortTimestamp(a))
        .slice(0, MAX_HISTORY);
    } catch (e) {
      console.error("GPU: データ解析エラー", e);
      return [];
    }
  };

  const createPanel = async () => {
    let result = { [STORAGE_KEY]: [], [COLLAPSED_KEY]: false };
    try {
      result = await chrome.storage.local.get(result);
    } catch (e) {
      console.warn("GPU: ストレージ読み込み失敗", e);
    }

    try {
      albums = normalizeStoredAlbums(result[STORAGE_KEY]);
    } catch (e) {
      console.warn("GPU: アルバムデータ正規化失敗", e);
      albums = [];
    }

    updateDisplayAlbums();
    
    // データに変更があった場合のみ保存
    if (Array.isArray(result[STORAGE_KEY]) && albums.length !== result[STORAGE_KEY].length) {
      void saveAlbums();
    }

    // パネル要素の作成は失敗させない
    panel = document.createElement("section");
    panel.className = "gpu-panel";
    panel.dataset.collapsed = "false";

    const header = document.createElement("div");
    header.className = "gpu-header";

    const title = document.createElement("div");
    title.className = "gpu-title";
    title.textContent = "Album Sorter";

    const refresh = document.createElement("button");
    refresh.className = "gpu-icon-button";
    refresh.type = "button";
    refresh.title = "アルバム一覧を取得";
    refresh.setAttribute("aria-label", "アルバム一覧を取得");
    refresh.textContent = "↻";
    refresh.addEventListener("click", () => {
      void refreshAlbumsFromGooglePhotos();
    });

    const diagnose = document.createElement("button");
    diagnose.className = "gpu-icon-button";
    diagnose.type = "button";
    diagnose.title = "取得状態を診断";
    diagnose.setAttribute("aria-label", "取得状態を診断");
    diagnose.textContent = "?";
    diagnose.addEventListener("click", () => {
      void updateDiagnostics({ openDialog: true, show: true });
    });

    const collapse = document.createElement("button");
    collapse.className = "gpu-icon-button";
    collapse.type = "button";
    collapse.title = "パネルの表示切替";
    collapse.setAttribute("aria-label", "パネルの表示切替");
    collapse.textContent = "–";
    collapse.addEventListener("click", async () => {
      const next = panel.dataset.collapsed !== "true";
      panel.dataset.collapsed = String(next);
      await chrome.storage.local.set({ [COLLAPSED_KEY]: next });
    });

    header.append(title, refresh, diagnose, collapse);

    const body = document.createElement("div");
    body.className = "gpu-body";

    statusNode = document.createElement("div");
    statusNode.className = "gpu-status";
    statusNode.textContent = "1-9/0: 新しい順上位10件へ追加 / Q: 直前へ追加";

    albumListNode = document.createElement("div");
    albumListNode.className = "gpu-albums";

    const help = document.createElement("div");
    help.className = "gpu-help";
    help.textContent = "写真プレビュー中だけ表示します。10件目は 0 キーです。";

    diagnosticsNode = document.createElement("pre");
    diagnosticsNode.className = "gpu-diagnostics";

    body.append(statusNode, albumListNode, help, diagnosticsNode);
    panel.append(header, body);
    document.documentElement.append(panel);
    renderAlbums();
  };

  const getLayerCandidates = () => {
    return [
      ...document.querySelectorAll("[role='dialog'], [aria-modal='true'], [role='listbox']")
    ].filter((element) => isVisible(element) && !isOwnUi(element));
  };

  const scoreAlbumChooser = (element) => {
    const rect = element.getBoundingClientRect();
    const text = lower(getElementText(element));
    let score = 0;

    ALBUM_CHOOSER_HINTS.forEach((hint) => {
      if (text.includes(hint)) score += 8;
    });

    const candidateCount = collectAlbumNames(element, { includeTextNodes: true, limit: 20 }).length;
    score += Math.min(candidateCount, 10);

    if (rect.width < window.innerWidth * 0.8) score += 2;
    if (rect.height < window.innerHeight * 0.9) score += 2;

    return score;
  };

  const getActiveDialog = () => {
    const dialogs = getLayerCandidates()
      .filter((element) => scoreAlbumChooser(element) > 0);

    return dialogs
      .sort((a, b) => {
        const scoreDiff = scoreAlbumChooser(b) - scoreAlbumChooser(a);
        if (scoreDiff !== 0) return scoreDiff;
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      })[0] || null;
  };

  const cleanAlbumName = (name) => {
    const cleaned = normalize(name)
      .replace(/\b\d{1,6}\s+(photos?|items?)\b/gi, "")
      .replace(/\d{1,6}\s*個のファイル(?:\s*·\s*共有中)?/g, "")
      .replace(/ファイルなし(?:\s*·\s*共有中)?/g, "")
      .replace(/\b\d{1,6}\s+(枚|項目)\b/g, "")
      .replace(/\b(photos?|items?)\b/gi, "")
      .replace(/[·・]$/, "");

    return normalize(cleaned);
  };

  const extractAlbumNameFromRowText = (text) => {
    const cleaned = normalize(text);
    if (!cleaned) return "";

    const markers = [...cleaned.matchAll(/(?:\d+\s*個のファイル|ファイルなし)(?:\s*·\s*共有中)?/g)];
    if (markers.length !== 1) return "";

    const rawName = cleaned.slice(0, markers[0].index);
    const name = cleanAlbumName(rawName);

    if (
      /searchcancel|アルバムに追加|新しいアルバム|アルバムリスト|並べ替え|すべて|マイアルバム|共有アイテム/.test(name)
    ) {
      return "";
    }

    return name;
  };

  const isLikelyAlbumName = (name) => {
    const cleaned = cleanAlbumName(name);
    const lowered = lower(cleaned);

    if (
      cleaned.length < 1 ||
      cleaned.length > 80 ||
      /^\d+$/.test(cleaned) ||
      /^\d{4}年?$/.test(cleaned) ||
      /^\d{1,2}月?$/.test(cleaned) ||
      /^\d\/\d+$/.test(cleaned) || // "1/26" などのキーショートカット誤認
      /^\d\/その他のオプション$/.test(cleaned) ||
      /^add新しいアルバム$/.test(cleaned)
    ) {
      return false;
    }

    if (EXCLUDED_ALBUM_TEXT.some((excluded) => lowered === excluded)) return false;
    if (EXCLUDED_ALBUM_TEXT_PARTS.some((excluded) => lowered.includes(excluded))) return false;

    return true;
  };

  const collectAlbumNames = (
    root = getActiveDialog() || document,
    { includeTextNodes = true, limit = MAX_SHORTCUTS } = {}
  ) => {
    const rowNames = getAlbumRowNames(root);
    if (rowNames.length >= limit) {
      return rowNames.slice(0, limit);
    }

    const textNames = extractAlbumNamesFromLongText(root.textContent);
    const mergedStrongNames = [...rowNames, ...textNames].filter((name, index, all) => (
      all.indexOf(name) === index
    ));
    if (mergedStrongNames.length > 0) {
      return mergedStrongNames.slice(0, limit);
    }

    const names = [];
    const seen = new Set();

    const addName = (rawName) => {
      const name = cleanAlbumName(rawName);
      if (!isLikelyAlbumName(name) || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };

    getClickableCandidates(root).forEach((candidate) => {
      addName(getPrimaryText(candidate));
    });

    if (includeTextNodes) {
      getTextCandidates(root).forEach(addName);
    }

    return names.slice(0, limit);
  };

  const collectAlbumNamesFromCurrentPage = () => {
    const names = [];
    const seen = new Set();
    const albumLinks = [
      ...document.querySelectorAll("a[href*='/album/'], a[href*='/share/']")
    ].filter((element) => isVisible(element) && !isOwnUi(element));

    albumLinks.forEach((link) => {
      splitCandidateText(getElementText(link)).forEach((rawName) => {
        const name = cleanAlbumName(rawName);
        if (!isLikelyAlbumName(name) || seen.has(name)) return;
        seen.add(name);
        names.push(name);
      });
    });

    return names.slice(0, MAX_SHORTCUTS);
  };

  const learnAlbumsFromCurrentPage = async () => {
    if (busy) return;
    const names = collectAlbumNamesFromCurrentPage();
    if (names.length === 0) return;
    await mergeAlbums(names);
    setStatus(`${names.length}件のアルバム候補を表示しました。`, "success");
  };

  const summarizeCandidate = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      text: getElementText(element).slice(0, 80),
      score: scoreToolbarCandidate(element),
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  };

  const runAlbumDiagnostics = async ({ openDialog = false } = {}) => {
    const currentPageNames = collectAlbumNamesFromCurrentPage();
    const moreButtons = findClickableCandidatesByLabel(LABELS.moreOptions)
      .sort((a, b) => scoreToolbarCandidate(b) - scoreToolbarCandidate(a))
      .slice(0, 5)
      .map(summarizeCandidate);
    const directAddAction = summarizeCandidate(findAddToAlbumAction());

    const result = {
      url: location.href,
      path: location.pathname,
      likelyPhotoPreview: isLikelyPhotoPreview(),
      currentMediaKey: getCurrentMediaKey(),
      storedAlbums: albums.map((album) => album.name),
      rpc: {
        globalsAvailable: false,
        albumCount: 0,
        firstAlbums: [],
        error: ""
      },
      pageAlbumNames: currentPageNames,
      moreButtons,
      directAddAction,
      menuText: [],
      menuAddAction: null,
      dialogFound: false,
      dialogAlbumNames: [],
      dialogText: "",
      error: ""
    };

    try {
      await readGooglePhotosGlobals();
      result.rpc.globalsAvailable = true;
      const rpcAlbums = await fetchAlbumsByRpc();
      result.rpc.albumCount = rpcAlbums.length;
      result.rpc.firstAlbums = rpcAlbums.slice(0, MAX_SHORTCUTS).map((album) => ({
        name: album.name,
        mediaKey: album.mediaKey,
        isShared: album.isShared,
        itemCount: album.itemCount
      }));
    } catch (error) {
      result.rpc.error = error instanceof Error ? error.message : String(error);
    }

    if (!openDialog) return result;

    try {
      const buttons = findClickableCandidatesByLabel(LABELS.moreOptions)
        .sort((a, b) => scoreToolbarCandidate(b) - scoreToolbarCandidate(a));
      if (buttons[0]) {
        clickElement(buttons[0]);
        await waitFor(() => getVisibleMenuRoots().length > 0, 1800);
        result.menuText = getVisibleMenuText();
        const menuRoots = getVisibleMenuRoots();
        for (const root of menuRoots) {
          const found = findClickableByLabel(LABELS.addToAlbum, root) || findTextAction(LABELS.addToAlbum, root);
          if (found) {
            result.menuAddAction = summarizeCandidate(found);
            clickElement(found);
            break;
          }
        }
      }

      const dialog = await waitFor(() => getActiveDialog(), WAIT_TIMEOUT_MS);
      result.dialogFound = Boolean(dialog);
      if (dialog) {
        result.dialogAlbumNames = await waitForAlbumNames(dialog);
        result.dialogText = normalize(dialog.textContent).slice(0, 1000);
        pressEscape();
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  };

  const updateDiagnostics = async ({ openDialog = false, show = false } = {}) => {
    if (!diagnosticsNode) return;
    const result = await runAlbumDiagnostics({ openDialog });
    diagnosticsNode.textContent = JSON.stringify(result, null, 2);
    diagnosticsNode.dataset.open = String(show || result.error || result.dialogAlbumNames.length === 0);
  };

  const findAddToAlbumAction = () => {
    const menuRoots = getVisibleMenuRoots();
    for (const root of menuRoots) {
      const found = findClickableByLabel(LABELS.addToAlbum, root) || findTextAction(LABELS.addToAlbum, root);
      if (found) return found;
    }
    return null;
  };

  const getVisibleMenuRoots = () => {
    return [
      ...document.querySelectorAll("[role='menu'], [role='presentation'], [role='listbox']")
    ].filter((element) => {
      if (!isVisible(element) || isOwnUi(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 80 && rect.height > 20 && rect.width < window.innerWidth * 0.8;
    });
  };

  const getVisibleMenuText = () => {
    return getVisibleMenuRoots()
      .map((element) => normalize(element.textContent).slice(0, 400))
      .filter(Boolean);
  };

  const findTextAction = (labels, root = document) => {
    const expected = labels.map(lower);
    const textElements = [
      ...root.querySelectorAll("span, div, li, button, [role='menuitem'], [role='button']")
    ].filter((element) => isVisible(element) && !isOwnUi(element));

    for (const element of textElements) {
      const text = lower(getElementText(element));
      if (!expected.some((label) => text === label || text.includes(label))) continue;
      const clickable = toClickable(element);
      if (clickable && isVisible(clickable) && !isOwnUi(clickable)) return clickable;
    }

    return null;
  };

  const openMoreMenu = async () => {
    const buttons = findClickableCandidatesByLabel(LABELS.moreOptions)
      .sort((a, b) => scoreToolbarCandidate(b) - scoreToolbarCandidate(a));

    if (buttons.length === 0) {
      throw new Error("3点メニューが見つかりません。写真のプレビュー画面で実行してください。");
    }

    for (const button of buttons.slice(0, 5)) {
      clickElement(button);
      const addToAlbum = await waitFor(() => {
        const menuRoots = getVisibleMenuRoots();
        for (const root of menuRoots) {
          const found = findClickableByLabel(LABELS.addToAlbum, root) || findTextAction(LABELS.addToAlbum, root);
          if (found) return found;
        }
        return findAddToAlbumAction();
      }, 1800);
      if (addToAlbum) return addToAlbum;
      pressEscape();
      await sleep(120);
    }

    return null;
  };

  const openAddToAlbumDialog = async () => {
    const addToAlbum = await openMoreMenu();
    if (!addToAlbum) {
      throw new Error("Googleフォトの「アルバムに追加」操作が見つかりません。写真プレビュー画面で実行してください。");
    }

    clickElement(addToAlbum);
    return waitFor(() => {
      const dialog = getActiveDialog();
      if (!dialog) return null;
      return dialog;
    }, WAIT_TIMEOUT_MS);
  };

  const collectAlbumNamesWithScroll = async (root) => {
    const scrollTargets = [
      root,
      ...root.querySelectorAll("[role='listbox'], [role='grid'], [role='list'], div")
    ].filter((element) => {
      if (!isVisible(element)) return false;
      return element.scrollHeight > element.clientHeight + 20;
    });

    const collected = new Map();
    const addNames = () => {
      collectAlbumNames(root, { includeTextNodes: true, limit: 30 }).forEach((name) => {
        if (!collected.has(name)) collected.set(name, name);
      });
    };

    addNames();
    for (const target of scrollTargets.slice(0, 3)) {
      const originalTop = target.scrollTop;
      target.scrollTop = 0;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(160);
      addNames();

      target.scrollTop = Math.min(target.scrollHeight, target.clientHeight * 1.5);
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(200);
      addNames();

      target.scrollTop = originalTop;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
    }

    return [...collected.values()].slice(0, MAX_SHORTCUTS);
  };

  const waitForAlbumNames = async (root) => {
    const started = Date.now();
    while (Date.now() - started < WAIT_TIMEOUT_MS) {
      const names = await collectAlbumNamesWithScroll(root);
      if (names.length > 0) return names;
      await sleep(WAIT_STEP_MS);
    }
    return [];
  };

  const isLikelyPhotoPreview = () => {
    // パフォーマンス最優先: URLに /photo が含まれていればプレビューとみなす
    return location.pathname.includes("/photo");
  };

  const updatePanelVisibility = () => {
    if (!panel) return false;
    const preview = isLikelyPhotoPreview();
    panel.dataset.preview = String(preview);
    return preview;
  };

  const refreshAlbumsFromGooglePhotos = async ({ silent = false } = {}) => {
    if (busy) return;
    busy = true;
    setStatus("Googleフォトからアルバム一覧を取得中...");
    if (!silent) showToast("アルバム一覧を取得中...");

    try {
      const rpcAlbums = await fetchAlbumsByRpc();
      if (rpcAlbums.length > 0) {
        await mergeAlbums(rpcAlbums);
        setStatus(`${Math.min(rpcAlbums.length, MAX_SHORTCUTS)}件のアルバム候補を取得しました。`, "success");
        if (!silent) showToast("アルバム一覧を取得しました。");
        return;
      }

      const dialog = await openAddToAlbumDialog();
      if (!dialog) {
        throw new Error("アルバム追加ダイアログが見つかりません。");
      }
      const names = await waitForAlbumNames(dialog);
      if (names.length === 0) {
        throw new Error("アルバム候補を取得できませんでした。追加ダイアログの表示後に再度試してください。");
      }

      await mergeAlbums(names);
      pressEscape();
      setStatus(`${names.length}件のアルバム候補を取得しました。`, "success");
      if (!silent) showToast(`${names.length}件のアルバム候補を取得しました。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "アルバム一覧の取得に失敗しました。";
      void updateDiagnostics({ openDialog: false, show: !silent });
      if (silent) {
        setStatus("写真プレビューを開くとアルバム候補を自動取得します。");
      } else {
        setStatus(message, "error");
        showToast(message);
      }
    } finally {
      busy = false;
    }
  };

  const chooseAlbum = async (albumName) => {
    const dialog = getActiveDialog() || document;
    const learned = await collectAlbumNamesWithScroll(dialog);
    if (learned.length > 0) {
      await mergeAlbums(learned);
    }

    const direct = await waitFor(() => findClickableByText(albumName, getActiveDialog() || document), 1800);
    if (direct) {
      clickElement(direct);
      return true;
    }

    const searchInput = [...document.querySelectorAll("input[type='text'], input[type='search']")]
      .filter(isVisible)
      .find((input) => {
        const label = lower(getElementText(input));
        return label.includes("search") || label.includes("検索") || label === "";
      });

    if (searchInput) {
      searchInput.focus();
      searchInput.value = albumName;
      searchInput.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: albumName
      }));
      await sleep(500);
      const searched = await waitFor(() => findClickableByText(albumName, getActiveDialog() || document), 2500);
      if (searched) {
        clickElement(searched);
        return true;
      }
    }

    return false;
  };

  const addCurrentPhotoToAlbum = async (albumOrName) => {
    if (busy) return;
    const album = typeof albumOrName === "string"
      ? albums.find((item) => getAlbumName(item) === albumOrName) || { name: albumOrName }
      : albumOrName;
    const albumName = getAlbumName(album);
    busy = true;
    setStatus(`${albumName} に追加中...`);
    showToast(`${albumName} に追加中...`);

    try {
      const mediaKey = getCurrentMediaKey();
      if (mediaKey && album.mediaKey) {
        await addMediaKeyToAlbumByRpc(mediaKey, album);
      } else {
        await openAddToAlbumDialog();
        const chosen = await chooseAlbum(albumName);
        if (!chosen) {
          throw new Error(`アルバム「${albumName}」が見つかりません。更新ボタンで一覧を再取得してください。`);
        }
      }

      lastAlbumName = albumName;
      await markAlbumUsed(albumName);
      setStatus(`${albumName} に追加しました。`, "success");
      showToast(`${albumName} に追加しました。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "追加に失敗しました。";
      setStatus(message, "error");
      showToast(message);
    } finally {
      busy = false;
    }
  };

  const handleKeydown = (event) => {
    if (event.defaultPrevented || isEditableTarget(event.target)) return;

    if (event.shiftKey && event.key.toLocaleLowerCase() === "a") {
      if (panel) panel.dataset.collapsed = panel.dataset.collapsed === "true" ? "false" : "true";
      event.preventDefault();
      return;
    }

    if (!event.altKey && !event.ctrlKey && !event.metaKey && /^[0-9]$/.test(event.key)) {
      const index = event.key === "0" ? 9 : Number(event.key) - 1;
      const album = displayAlbums[index];
      if (album) {
        event.preventDefault();
        void addCurrentPhotoToAlbum(album);
      }
      return;
    }

    if (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLocaleLowerCase() === "q") {
      if (lastAlbumName) {
        event.preventDefault();
        void addCurrentPhotoToAlbum(lastAlbumName);
      }
    }
  };

  const boot = async () => {
    try {
      await createPanel();
      window.__gpuCheckAlbums = () => runAlbumDiagnostics({ openDialog: true });
      window.addEventListener("keydown", handleKeydown, true);

      // URL監視のみの超軽量タイマー
      let lastPath = "";
      window.setInterval(() => {
        if (location.pathname !== lastPath) {
          lastPath = location.pathname;
          updatePanelVisibility();
        }
      }, 500);

      // 初期状態の表示を確定
      updatePanelVisibility();

      // アルバム一覧がない場合のみ、メインスレッドを止めずに裏で取得
      const hasRpcAlbums = albums.some((album) => album.mediaKey);
      if (albums.length === 0 || !hasRpcAlbums) {
        // パネル表示を優先し、取得は遅延させる
        window.setTimeout(() => {
          refreshAlbumsFromGooglePhotos({ silent: true }).catch(() => {});
        }, 1000);
      }
    } catch (error) {
      console.error("GPU: 起動に失敗しました", error);
    }
  };

  void boot();
})();
