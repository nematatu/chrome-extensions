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
