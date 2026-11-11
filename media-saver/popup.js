"use strict";

const C = globalThis.MediaSaverCommon;

const ERROR_TEXT = {
  HLS_ENCRYPTED: "暗号化されたHLSは保存できません", HLS_LIVE: "ライブ配信は保存できません",
  HLS_SEPARATE_AUDIO_UNSUPPORTED: "このHLSの音声形式は非対応です",
  HLS_UNSUPPORTED: "このHLS形式は非対応です", HLS_BAD_SEGMENT: "HLSのデータが壊れています",
  HLS_TOO_LARGE: "ファイルが大きすぎます", HLS_FETCH_FAILED: "HLSの取得に失敗しました",
  HLS_TIMEOUT: "HLSの取得がタイムアウトしました", HLS_STORAGE_FAILED: "一時保存に失敗しました",
  DASH_ENCRYPTED: "DRM保護されたDASHは保存できません", DASH_LIVE: "ライブ配信は保存できません",
  DASH_UNSUPPORTED: "このDASH形式は非対応です", DASH_TOO_LARGE: "ファイルが大きすぎます",
  AUTH_REQUIRED: "ログインが必要か、アクセスが拒否されました", RATE_LIMITED: "アクセスが制限されています。時間をおいて再試行してください",
  NOT_FOUND: "配信URLが見つかりません", NOT_MEDIA: "動画データではなくHTMLが返されました",
  TOO_LARGE: "ファイルが大きすぎます", STORAGE_FAILED: "一時保存に失敗しました",
  TIMEOUT: "処理がタイムアウトしました", CANCELED: "キャンセルしました",
  DOWNLOAD_FAILED: "Chromeへの保存に失敗しました", INTERRUPTED: "拡張機能の再起動で中断されました",
  INVALID_OUTPUT: "保存データを作成できませんでした", NO_OUTPUT: "保存するデータがありません",
  PROCESSING_FAILED: "処理に失敗しました", UNSUPPORTED: "この形式は非対応です",
  UNSAFE_TARGET: "公開ページからローカルネットワークの URL は取得しません",
  PAGE_UNSUPPORTED: "このページでは保存できません", START_FAILED: "ダウンロードを開始できませんでした",
  BUSY: "同時処理の上限に達しています", TOO_MANY_ITEMS: "一度に保存できるのは300件までです"
};

const state = {
  tabId: null, pageUrl: "", pageTitle: "", items: [], filter: "all", selected: new Set(),
  jobs: [], settings: null, qualities: new Map(), qualityChoice: new Map(), probeLoading: new Set(),
  busy: new Set(), blobVideos: 0, restricted: false, openMenu: null, lastCompleted: new Set(), view: "media",
  jobsLoaded: false
};

function icon(name) {
  return MyToolsUI.icon(name === "link" ? "copy" : name === "external" ? "externalLink" : name);
}

function h(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(error => ({ ok: false, error: String(error?.message || error) }));
}

function errorLabel(code) {
  return ERROR_TEXT[code] || "処理に失敗しました";
}

function kindLabel(item) {
  if (item.kind === "hls") return "HLS";
  if (item.kind === "dash") return "DASH";
  if (item.kind === "audio") return "AUDIO";
  if (item.kind === "image") return "IMAGE";
  const ext = C.extensionOf(item.url);
  return ext ? ext.toUpperCase() : "VIDEO";
}

function typeGroup(item) {
  if (item.kind === "audio") return "audio";
  if (item.kind === "image") return "image";
  return "video";
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function toast(message, duration = 2600) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, duration);
}

function itemTitle(item) {
  return (item.title || C.titleFromUrl(item.url) || "メディア").trim();
}

function itemHost(item) {
  return C.hostOf(item.url).replace(/^www\./, "");
}

function isSelected(item) { return state.selected.has(item.id); }

function visibleItems() {
  if (state.filter === "all") return state.items;
  return state.items.filter(item => typeGroup(item) === state.filter);
}

function updateCounts() {
  document.getElementById("media-count").textContent = String(state.items.length);
  document.getElementById("detected-pill").textContent = `${state.items.length} 件`;
  const active = state.jobs.filter(job => ["queued", "preparing", "downloading"].includes(job.state)).length;
  document.getElementById("job-count").textContent = String(active);
  const selected = state.selected.size;
  const button = document.getElementById("save-selected");
  button.textContent = selected ? `${selected} 件を保存` : "選択を保存";
  button.disabled = selected === 0;
  const all = visibleItems();
  const selectAll = document.getElementById("select-all");
  selectAll.checked = all.length > 0 && all.every(item => state.selected.has(item.id));
  selectAll.indeterminate = all.some(item => state.selected.has(item.id)) && !selectAll.checked;
}

function thumbFor(item) {
  const thumb = h("div", { class: "thumb" });
  const source = item.frame || item.poster || (item.kind === "image" ? item.url : "");
  if (source && /^(https?:|data:image\/)/i.test(source)) {
    const image = h("img", { src: source, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    image.addEventListener("error", () => image.remove());
    thumb.append(image);
  }
  thumb.append(h("div", { class: "thumb-icon", html: icon(item.kind === "audio" ? "music" : item.kind === "image" ? "image" : "film") }));
  if (item.duration) thumb.append(h("span", { class: "duration" }, C.formatDuration(item.duration)));
  if (item.kind === "hls" || item.kind === "dash") {
    thumb.append(h("span", { class: "kind-mark" }, item.kind.toUpperCase()));
  }
  return thumb;
}

function qualitySelect(item) {
  const select = h("select", { class: "quality-select", "aria-label": `${itemTitle(item)} の画質` });
  select.append(h("option", { value: "auto" }, "自動（最高画質）"));
  select.value = "auto";
  const populate = () => {
    const probe = state.qualities.get(item.url);
    if (!probe || !probe.variants?.length) return;
    select.replaceChildren(h("option", { value: "auto" }, "自動（最高画質）"));
    probe.variants.forEach((variant, index) => {
      const label = `${variant.label || `画質 ${index + 1}`}${variant.bandwidth ? `  ${C.formatBitrate(variant.bandwidth)}` : ""}`;
      select.append(h("option", { value: String(index) }, label));
    });
    const saved = state.qualityChoice.get(item.url);
    if (saved && probe.variants.some(variant => variant.bandwidth === saved.bandwidth && variant.height === saved.height)) {
      const index = probe.variants.findIndex(variant => variant.bandwidth === saved.bandwidth && variant.height === saved.height);
      if (index >= 0) select.value = String(index);
    }
  };
  const load = async () => {
    if (state.qualities.has(item.url) || state.probeLoading.has(item.url)) { populate(); return; }
    state.probeLoading.add(item.url);
    select.disabled = true;
    const current = select.value;
    select.replaceChildren(h("option", { value: "auto" }, "画質を取得中…"));
    const response = await send({ type: "ms:probe", tabId: state.tabId, url: item.url, kind: item.kind });
    state.probeLoading.delete(item.url);
    select.disabled = false;
    if (response?.ok) {
      state.qualities.set(item.url, response.result);
      populate();
      if (current !== "auto") select.value = current;
      if (!response.result.variants?.length) select.title = "画質の一覧がないため、自動で保存します";
    } else {
      select.replaceChildren(h("option", { value: "auto" }, "自動（最高画質）"));
      select.title = errorLabel(response?.error);
    }
  };
  select.addEventListener("focus", load);
  select.addEventListener("mousedown", load);
  select.addEventListener("change", () => {
    const probe = state.qualities.get(item.url);
    if (!probe || select.value === "auto") { state.qualityChoice.delete(item.url); return; }
    const variant = probe.variants?.[Number(select.value)];
    if (variant) state.qualityChoice.set(item.url, variant);
  });
  populate();
  return select;
}

function withQuality(item) {
  const variant = state.qualityChoice.get(item.url);
  if (!variant) return { ...item, quality: null };
  return { ...item, quality: { url: variant.url || "", bandwidth: variant.bandwidth, height: variant.height, label: variant.label } };
}

function closeMenu() {
  if (state.openMenu) {
    state.openMenu.menu.remove();
    state.openMenu.button.setAttribute("aria-expanded", "false");
    state.openMenu = null;
    document.getElementById("menu-layer").hidden = true;
  }
}

function openMenu(card, button, item) {
  if (state.openMenu?.button === button) { closeMenu(); return; }
  closeMenu();
  const menu = h("div", { class: "card-menu", role: "menu" });
  const action = (label, iconName, handler, danger) => {
    const entry = h("button", { type: "button", role: "menuitem", class: danger ? "danger" : "" }, h("span", { html: icon(iconName) }), label);
    entry.addEventListener("click", async event => { event.stopPropagation(); closeMenu(); await handler(); });
    menu.append(entry);
  };
  action("URLをコピー", "link", async () => {
    try { await navigator.clipboard.writeText(item.url); toast("URLをコピーしました"); }
    catch { toast("コピーできませんでした"); }
  });
  action("新しいタブで開く", "external", () => chrome.tabs.create({ url: item.url }));
  action(`${itemHost(item)} を非表示`, "eyeOff", async () => {
    const response = await send({ type: "ms:blacklist", domain: itemHost(item), add: true });
    if (response?.ok) {
      state.items = state.items.filter(candidate => C.hostOf(candidate.url) !== itemHost(item));
      renderMedia();
      toast(`${itemHost(item)} を除外しました`);
    }
  });
  action("この項目を削除", "trash", async () => {
    state.items = state.items.filter(candidate => candidate.url !== item.url);
    state.selected.delete(item.id);
    state.qualities.delete(item.url);
    state.qualityChoice.delete(item.url);
    renderMedia();
    await send({ type: "ms:remove-item", tabId: state.tabId, url: item.url });
  }, true);
  card.append(menu);
  button.setAttribute("aria-expanded", "true");
  state.openMenu = { menu, button };
  const layer = document.getElementById("menu-layer");
  layer.hidden = false;
  layer.onclick = closeMenu;
}

function renderMedia() {
  closeMenu();
  const list = document.getElementById("media-list");
  const empty = document.getElementById("empty");
  list.replaceChildren();
  const items = visibleItems();
  const hasAny = state.items.length > 0;
  empty.hidden = items.length > 0;
  if (!items.length) {
    if (hasAny) {
      empty.querySelector("h2").textContent = "この種類のメディアはありません";
      empty.querySelector("#empty-refresh").hidden = true;
    } else {
      empty.querySelector("h2").textContent = "まだメディアが見つかりません";
      empty.querySelector("#empty-refresh").hidden = false;
    }
  }
  const fragment = document.createDocumentFragment();
  for (const item of items.slice(0, 160)) fragment.append(renderCard(item));
  list.append(fragment);
  if (items.length > 160) {
    list.append(h("p", { class: "list-remainder" }, `ほか ${items.length - 160} 件（絞り込みで表示）`));
  }
  updateCounts();
}

function renderCard(item) {
  const selected = isSelected(item);
  const card = h("article", { class: `media-card${selected ? " is-selected" : ""}${state.busy.has(item.url) ? " is-busy" : ""}`, dataset: { id: item.id } });
  const checkbox = h("input", { type: "checkbox", checked: selected, "aria-label": `${itemTitle(item)} を選択` });
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selected.add(item.id); else state.selected.delete(item.id);
    card.classList.toggle("is-selected", checkbox.checked);
    updateCounts();
  });
  card.append(checkbox, thumbFor(item));

  const body = h("div", { class: "media-body" });
  const titleRow = h("div", { class: "media-title-row" });
  titleRow.append(h("h3", { class: "media-title", title: itemTitle(item) }, itemTitle(item)));
  const menuButton = h("button", { class: "card-menu-button", type: "button", "aria-label": "メニュー", "aria-haspopup": "true", "aria-expanded": "false", html: icon("more") });
  menuButton.addEventListener("click", event => { event.stopPropagation(); openMenu(card, menuButton, item); });
  titleRow.append(menuButton);
  body.append(titleRow);

  const meta = h("div", { class: "media-meta" });
  meta.append(h("span", { class: `kind-badge kind-${item.kind}` }, kindLabel(item)));
  if (item.size > 0) meta.append(h("span", { class: "dot" }, C.formatBytes(item.size)));
  if (item.width && item.height) meta.append(h("span", { class: "dot" }, `${item.width}×${item.height}`));
  const host = itemHost(item);
  if (host) meta.append(h("span", { class: "dot" }, host));
  body.append(meta);

  const actions = h("div", { class: "media-actions" });
  if (item.kind === "hls" || item.kind === "dash") actions.append(qualitySelect(item));
  const download = h("button", { class: "download-button", type: "button" }, h("span", { html: icon("download") }), state.busy.has(item.url) ? "追加中" : "保存");
  download.addEventListener("click", async () => {
    if (state.busy.has(item.url)) return;
    await startItems([item]);
  });
  actions.append(download);
  body.append(actions);
  card.append(body);
  return card;
}

async function startItems(items) {
  if (!items.length) return;
  const payload = items.map(item => {
    const chosen = withQuality(item);
    const stream = chosen.kind === "hls" || chosen.kind === "dash";
    return {
      url: chosen.url, kind: chosen.kind,
      title: stream ? (state.pageTitle || itemTitle(chosen)) : itemTitle(chosen),
      quality: chosen.quality
    };
  });
  for (const item of items) state.busy.add(item.url);
  renderMedia();
  const response = await send({ type: "ms:start", tabId: state.tabId, items: payload });
  for (const item of items) state.busy.delete(item.url);
  if (!response?.ok) {
    renderMedia();
    toast(errorLabel(response?.error));
    return;
  }
  state.selected.clear();
  renderMedia();
  toast(`${response.jobs.length} 件を保存キューに追加しました`);
  await refreshJobs();
}

function jobState(job) {
  if (job.state === "queued") return { label: "待機中", className: "" };
  if (job.state === "preparing") return { label: "準備中", className: "is-active" };
  if (job.state === "downloading") return { label: "保存中", className: "is-active" };
  if (job.state === "completed") return { label: "完了", className: "is-done" };
  if (job.state === "failed") return { label: "失敗", className: "is-failed" };
  return { label: "キャンセル", className: "" };
}

function renderJobs() {
  const list = document.getElementById("job-list");
  const empty = document.getElementById("job-empty");
  list.replaceChildren();
  const jobs = [...state.jobs].sort((left, right) => {
    const active = value => ["queued", "preparing", "downloading"].includes(value) ? 0 : 1;
    return active(left.state) - active(right.state) || (right.createdAt || 0) - (left.createdAt || 0);
  }).slice(0, 25);
  empty.hidden = jobs.length > 0;
  for (const job of jobs) {
    const info = jobState(job);
    const card = h("article", { class: "job-card" });
    const head = h("div", { class: "job-head" });
    head.append(h("h3", { class: "job-title", title: job.title }, job.title || "メディア"));
    head.append(h("span", { class: `job-state ${info.className}` }, info.label));
    card.append(head);
    const sub = h("p", { class: "job-sub" });
    if (job.state === "failed") sub.textContent = errorLabel(job.error);
    else if (job.state === "completed") {
      sub.textContent = job.downloads?.length ? (job.downloads.length > 1 ? `${job.downloads.length} ファイルを保存しました` : "保存しました") : "保存しました";
    } else if (job.total > 0) {
      sub.textContent = `${C.formatBytes(job.received)} / ${C.formatBytes(job.total)}`;
    } else if (job.segments > 0) {
      sub.textContent = `${job.completedSegments || 0} / ${job.segments} セグメント`;
    } else {
      sub.textContent = job.quality ? `画質: ${job.quality}` : "処理しています…";
    }
    card.append(sub);
    const track = h("div", { class: "progress-track" });
    const bar = h("div", { class: `progress-bar${["queued", "preparing"].includes(job.state) && !job.progress ? " is-indeterminate" : ""}` });
    const percent = Math.max(0, Math.min(100, Math.round((job.progress || 0) * 100)));
    bar.style.width = `${job.state === "completed" ? 100 : percent}%`;
    track.append(bar);
    card.append(track);
    const actions = h("div", { class: "job-actions" });
    if (["queued", "preparing", "downloading"].includes(job.state)) {
      const cancel = h("button", { class: "text-button danger", type: "button" }, "キャンセル");
      cancel.addEventListener("click", async () => { await send({ type: "ms:cancel", jobId: job.id }); await refreshJobs(); });
      actions.append(cancel);
    } else if (job.state === "completed" && job.downloads?.[0]?.id != null) {
      const open = h("button", { class: "text-button", type: "button" }, "フォルダを開く");
      open.addEventListener("click", () => send({ type: "ms:show", downloadId: job.downloads[0].id }));
      actions.append(open);
    }
    if (actions.childNodes.length) card.append(actions);
    list.append(card);
  }
  updateCounts();
}

async function refreshJobs(notify = true) {
  const response = await send({ type: "ms:jobs" });
  if (!response?.ok) return;
  const before = new Set(state.jobs.filter(job => job.state === "completed").map(job => job.id));
  state.jobs = response.jobs || [];
  if (!state.jobsLoaded) {
    state.jobsLoaded = true;
    for (const job of state.jobs) if (job.state === "completed") state.lastCompleted.add(job.id);
  }
  if (notify) {
    for (const job of state.jobs) {
      if (job.state === "completed" && !before.has(job.id) && !state.lastCompleted.has(job.id)) {
        state.lastCompleted.add(job.id);
        toast(`保存が完了しました: ${job.title || "メディア"}`);
      }
    }
  }
  if (state.view === "downloads") renderJobs();
  updateCounts();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("is-active", tab.dataset.view === view));
  document.getElementById("view-media").hidden = view !== "media";
  document.getElementById("view-downloads").hidden = view !== "downloads";
  document.getElementById("media-footer").hidden = view !== "media";
  document.querySelector(".main").scrollTop = 0;
  if (view === "downloads") { renderJobs(); void refreshJobs(false); }
  else updateCounts();
}

function updatePageInfo() {
  document.getElementById("page-title").textContent = state.pageTitle || "タイトルなし";
  document.getElementById("page-title").title = state.pageUrl || "";
  document.getElementById("blob-hint").hidden = !state.blobVideos;
  document.getElementById("restricted-hint").hidden = !state.restricted;
}

async function scan(showSpinner = false) {
  const button = document.getElementById("refresh");
  if (showSpinner) button.classList.add("is-spinning");
  const response = await send({ type: "ms:scan", tabId: state.tabId });
  button.classList.remove("is-spinning");
  if (!response?.ok) { toast(errorLabel(response?.error)); return; }
  state.pageUrl = response.pageUrl || state.pageUrl;
  state.pageTitle = response.pageTitle || state.pageTitle;
  state.items = response.items || [];
  state.blobVideos = response.blobVideos || 0;
  state.restricted = Boolean(response.restricted);
  const ids = new Set(state.items.map(item => item.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  updatePageInfo();
  document.querySelector(".main").scrollTop = 0;
  renderMedia();
}

async function init() {
  const forced = Number(new URLSearchParams(location.search).get("tabId"));
  let tab;
  if (Number.isInteger(forced) && forced > 0) {
    tab = await chrome.tabs.get(forced).catch(() => null);
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab) { toast("タブを取得できません"); return; }
  state.tabId = tab.id;
  state.pageUrl = tab.url || "";
  state.pageTitle = tab.title || "";
  const settingsResponse = await send({ type: "ms:settings" });
  if (settingsResponse?.ok) {
    state.settings = settingsResponse.settings;
    applyTheme(state.settings.theme);
  }
  const list = await send({ type: "ms:list", tabId: state.tabId });
  if (list?.ok) {
    state.items = list.items || [];
    state.pageUrl = list.pageUrl || state.pageUrl;
    state.pageTitle = list.pageTitle || state.pageTitle;
  }
  updatePageInfo();
  renderMedia();
  await refreshJobs(false);
  void scan();
}

function bind() {
  document.getElementById("refresh").innerHTML = icon("refresh");
  document.getElementById("settings").innerHTML = icon("settings");

  document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => setView(tab.dataset.view)));
  document.getElementById("refresh").addEventListener("click", () => scan(true));
  document.getElementById("empty-refresh").addEventListener("click", () => scan(true));
  document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("filters").addEventListener("click", event => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    document.querySelectorAll(".chip").forEach(candidate => candidate.classList.toggle("is-active", candidate === chip));
    document.querySelector(".main").scrollTop = 0;
    renderMedia();
  });
  document.getElementById("select-all").addEventListener("change", event => {
    const items = visibleItems();
    if (event.target.checked) for (const item of items) state.selected.add(item.id);
    else for (const item of items) state.selected.delete(item.id);
    renderMedia();
  });
  document.getElementById("save-selected").addEventListener("click", async () => {
    const items = state.items.filter(item => state.selected.has(item.id));
    if (items.length) await startItems(items);
  });
  document.getElementById("clear-jobs").addEventListener("click", async () => {
    await send({ type: "ms:clear-jobs" });
    await refreshJobs(false);
    toast("ダウンロード履歴を消去しました");
  });
  document.addEventListener("click", event => {
    if (state.openMenu && !state.openMenu.menu.contains(event.target) && event.target !== state.openMenu.button) closeMenu();
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "ms:jobs-updated") {
      const before = new Set(state.jobs.filter(job => job.state === "completed").map(job => job.id));
      state.jobs = message.jobs || [];
      for (const job of state.jobs) {
        if (job.state === "completed" && !before.has(job.id) && !state.lastCompleted.has(job.id)) {
          state.lastCompleted.add(job.id);
          toast(`保存が完了しました: ${job.title || "メディア"}`);
        }
      }
      if (state.view === "downloads") renderJobs();
      updateCounts();
    } else if (message?.type === "ms:settings-updated") {
      state.settings = message.settings;
      applyTheme(message.settings?.theme);
    }
  });
  setInterval(() => { if (state.view === "downloads") void refreshJobs(false); }, 1200);
}

bind();
void init();
