"use strict";
document.querySelector("#save").addEventListener("click", async () => {
  const status = document.querySelector("#status");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Instagramのタブを開いてください。");
    await chrome.tabs.sendMessage(tab.id, { type: "ig-download-page" });
    status.textContent = "Instagram画面の右下で進捗をご確認ください。";
  } catch { status.textContent = "Instagramを開き、タブを再読み込みしてからご利用ください。"; }
});

const exportButton = document.querySelector("#export-history");
async function getHistory() {
  const response = await chrome.runtime.sendMessage({ type: "ig-download-history" });
  if (!response?.ok) throw new Error(response?.error || "保存履歴を取得できませんでした。");
  return globalThis.IGMediaCore.validateHistory(response.savedMedia);
}
getHistory().then(() => {
  exportButton.textContent = "移行用に保存履歴を書き出す";
  exportButton.disabled = false;
}).catch(error => {
  exportButton.textContent = "保存履歴を取得できません";
  document.querySelector("#status").textContent = error.message;
});
exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  let url;
  try {
    const exportHistory = await getHistory();
    const data = { format: "nematatu-tools", version: 1, instagram: { savedMedia: exportHistory } };
    url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "my-tools-instagram-history.json";
    document.body.append(anchor); anchor.click(); anchor.remove();
    document.querySelector("#status").textContent = "保存履歴を書き出しました。移行先の統合拡張で読み込んでください。";
  } catch (error) { document.querySelector("#status").textContent = error.message; }
  finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); exportButton.disabled = false; }
});
