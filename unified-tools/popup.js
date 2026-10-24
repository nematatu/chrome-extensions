"use strict";
const modules = globalThis.MyToolsConfig.modules;
const moduleList = document.querySelector('#modules');
for (const module of modules) {
  const row = document.createElement('div'); row.className = 'module'; row.dataset.name = `${module.name} ${module.id}`.toLowerCase();
  const label = document.createElement('label'); label.htmlFor = module.id;
  const name = document.createElement('strong'); name.textContent = module.name;
  const detail = document.createElement('span'); detail.textContent = module.description || '';
  label.append(name, detail); row.append(label);
  const badge = document.createElement('span'); badge.className = 'module-badge'; badge.id = `badge-${module.id}`; badge.hidden = true; badge.setAttribute('aria-label', `${module.name}の通知`); row.append(badge);
  const entry = module.popup || module.options;
  if (entry) {
    const open = document.createElement('button'); open.type = 'button'; open.textContent = '開く'; open.className = 'module-open'; open.dataset.module = module.id;
    open.setAttribute('aria-label', `${module.name}の画面を開く`);
    open.addEventListener('click', () => openModule(module, entry)); row.append(open);
  }
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.id = module.id; toggle.disabled = true;
  toggle.setAttribute('aria-label', `${module.name}を有効にする`); row.append(toggle); moduleList.append(row);
}
const controls = [...document.querySelectorAll('button,input')];
function openModule(module, entry) {
  const frame = document.querySelector('#module-frame');
  document.querySelector('#module-title').textContent = module.name;
  frame.title = module.name; frame.src = chrome.runtime.getURL(`modules/${module.id}/${entry}`); frame.hidden = false;
  document.querySelector('#module-panel').hidden = false;
  document.querySelector('#features').hidden = true;
  document.querySelector('#module-back').focus();
}
document.querySelector('#module-back').addEventListener('click', () => {
  document.querySelector('#module-panel').hidden = true;
  document.querySelector('#features').hidden = false;
  const frame = document.querySelector('#module-frame'); frame.src = 'about:blank'; frame.hidden = true;
  document.querySelector('#search').focus();
});
document.querySelector('#search').addEventListener('input', event => {
  const query = event.target.value.trim().toLowerCase(); let count = 0;
  for (const row of moduleList.children) { row.hidden = !row.dataset.name.includes(query); if (!row.hidden) count++; }
  document.querySelector('#no-results').hidden = count !== 0;
});
const status = document.querySelector("#status");
let settings = null;
function show(message, error = false) { status.textContent = message; status.classList.toggle("error", error); }
function render(result) {
  if (result.settings) settings = result.settings;
  for (const { id } of modules) {
    document.getElementById(id).checked = settings?.enabled[id] === true;
    const badge = document.getElementById(`badge-${id}`); const text = result.badges?.[id]?.text || '';
    badge.textContent = text; badge.hidden = !text || !settings?.enabled[id];
  }
  document.querySelector('#module-count').textContent = `${modules.filter(module => settings?.enabled[module.id]).length} / ${modules.length} 有効`;
  const diagnostics = document.querySelector('#diagnostics');
  diagnostics.hidden = !result.errors?.length; diagnostics.textContent = (result.errors || []).join(' / ');
  document.querySelector("#history-count").textContent = `保存済み識別情報 ${result.historyCount ?? 0} 件`;
}
async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || "処理を完了できませんでした。拡張機能を読み込み直してください。");
  return result;
}
async function action(work) {
  show("処理中…");
  controls.forEach(el => { el.disabled = true; });
  try { await work(); }
  catch (error) {
    if (settings) for (const { id } of modules) document.getElementById(id).checked = settings.enabled[id];
    show(error.message, true);
  } finally {
    controls.forEach(el => { el.disabled = !settings && el.id !== "options"; });
    document.querySelector("#save").disabled = !settings?.enabled.instagram;
    for (const module of modules.filter(module => !module.worker && !module.matches?.length)) {
      const open = document.querySelector(`.module-open[data-module="${module.id}"]`);
      if (open) open.disabled = !settings?.enabled[module.id];
    }
  }
}
for (const { id } of modules) document.getElementById(id).addEventListener("change", event => {
  const enabled = event.target.checked;
  void action(async () => { render(await request("my-tools:set", { module: id, enabled })); show("設定を保存しました。対象ページを再読み込みしてください。"); });
});
document.querySelector("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#save").addEventListener("click", () => void action(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || new URL(tab.url || "about:blank").origin !== "https://www.instagram.com") throw new Error("Instagramのタブで実行してください。");
  await chrome.tabs.sendMessage(tab.id, { toolModule: "instagram", payload: { type: "ig-download-page" } });
  show("Instagram画面の右下で進捗をご確認ください。");
}));
document.querySelector("#export").addEventListener("click", () => void action(async () => {
  const { backup } = await request("my-tools:export");
  const value = MyToolsTransfer.parseBackup(backup);
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "my-tools-backup.json";
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  show("設定・履歴を書き出しました。移行先のMy Toolsで読み込んでください。");
}));
document.querySelector("#import-file").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  void action(async () => {
    if (file.size > MyToolsTransfer.MAX_BYTES) throw new Error("移行ファイルは20MiB以下にしてください。");
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { throw new Error("JSONファイルを読み込めませんでした。"); }
    const backup = MyToolsTransfer.parseBackup(parsed);
    render(await request("my-tools:import", { backup }));
    show("履歴を追加しました。設定も復元した場合は対象ページを再読み込みしてください。");
  }).finally(() => { event.target.value = ""; });
});
void action(async () => { render(await request("my-tools:get")); show("このブラウザの設定です。"); });
