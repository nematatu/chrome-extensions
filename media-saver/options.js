"use strict";

const C = globalThis.MediaSaverCommon;
let settings = null;

const $ = id => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message).catch(error => ({ ok: false, error: String(error?.message || error) }));
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function fill() {
  $("folder").value = settings.folder;
  $("filename-template").value = settings.filenameTemplate;
  $("subfolder").checked = settings.subfolder;
  $("detect-video").checked = settings.detectVideo;
  $("detect-audio").checked = settings.detectAudio;
  $("detect-images").checked = settings.detectImages;
  $("concurrency").value = String(settings.concurrency);
  $("min-size").value = String(settings.minSizeMB);
  $("theme").value = settings.theme;
  applyTheme(settings.theme);
  renderBlacklist();
}

function renderBlacklist() {
  const container = $("blacklist");
  container.replaceChildren();
  const entries = settings.blacklist || [];
  $("blacklist-empty").hidden = entries.length > 0;
  for (const domain of entries) {
    const chip = document.createElement("span");
    chip.className = "blacklist-chip";
    const text = document.createElement("span");
    text.textContent = domain;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.innerHTML = MyToolsUI.icon("x");
    remove.setAttribute("aria-label", `${domain} を除外リストから削除`);
    remove.addEventListener("click", async () => {
      const response = await send({ type: "ms:blacklist", domain, add: false });
      if (response?.ok) { settings = response.settings; renderBlacklist(); status("除外リストを更新しました"); }
    });
    chip.append(text, remove);
    container.append(chip);
  }
}

let statusTimer = null;
function status(text) {
  const element = $("save-status");
  element.textContent = text;
  element.classList.add("is-visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => element.classList.remove("is-visible"), 2400);
}

async function save() {
  const candidate = C.normalizeSettings({
    ...settings,
    folder: $("folder").value,
    filenameTemplate: $("filename-template").value,
    subfolder: $("subfolder").checked,
    detectVideo: $("detect-video").checked,
    detectAudio: $("detect-audio").checked,
    detectImages: $("detect-images").checked,
    concurrency: Number($("concurrency").value),
    minSizeMB: Number($("min-size").value),
    theme: $("theme").value
  });
  const response = await send({ type: "ms:set-settings", settings: candidate });
  if (!response?.ok) { status("保存できませんでした"); return; }
  settings = response.settings;
  fill();
  status("設定を保存しました");
}

async function addDomain() {
  const input = $("blacklist-input");
  const value = input.value.trim();
  if (!value) return;
  const response = await send({ type: "ms:blacklist", domain: value, add: true });
  if (!response?.ok) { status("ドメインを追加できませんでした"); return; }
  settings = response.settings;
  input.value = "";
  renderBlacklist();
  status("除外リストに追加しました");
}

async function init() {
  const response = await send({ type: "ms:settings" });
  if (!response?.ok) { status("設定を読み込めませんでした"); return; }
  settings = response.settings;
  fill();
}

$("save").addEventListener("click", save);
$("theme").addEventListener("change", () => applyTheme($("theme").value));
$("reset").addEventListener("click", async () => {
  const response = await send({ type: "ms:set-settings", settings: C.DEFAULT_SETTINGS });
  if (response?.ok) { settings = response.settings; fill(); status("初期設定に戻しました"); }
});
$("blacklist-add").addEventListener("click", addDomain);
$("blacklist-input").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void addDomain(); } });
$("clear-history").addEventListener("click", async () => {
  await send({ type: "ms:clear-jobs" });
  status("ダウンロード履歴を消去しました");
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "ms:settings-updated" && message.settings) {
    settings = message.settings;
    if (!document.activeElement || document.activeElement.tagName === "BODY") fill();
  }
});

void init();
