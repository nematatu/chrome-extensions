const checkbox = document.querySelector("#enabled");
const status = document.querySelector("#status");

function setStatus(text, active = true) {
  status.textContent = text;
  status.style.color = active ? "#159447" : "#737373";
}

chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
  checkbox.checked = enabled;
});

checkbox.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: checkbox.checked });
  setStatus(checkbox.checked ? "高画質表示を有効にしました" : "高画質表示を停止しました", checkbox.checked);
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id || !tab.url?.startsWith("https://www.instagram.com/")) {
    setStatus("Instagramのページで使用できます", false);
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "instagram-hq-status" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus("ページを再読み込みしてください", false);
      return;
    }
    checkbox.checked = response.enabled;
    setStatus(
      response.enabled
        ? response.width && response.height
          ? `${response.width} × ${response.height} で表示中`
          : `${response.upgradedCount}枚を高画質表示しました`
        : "高画質表示は停止中です",
      response.enabled,
    );
  });
});
