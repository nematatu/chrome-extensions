chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "badspi-download") return;
  try {
    const url = new URL(message.url);
    if (url.hostname !== "www.badspi.jp" || !url.pathname.includes("/wp-content/uploads/")) return;

    chrome.downloads.download({
      url: url.href,
      filename: `badspi/${String(message.filename || "image").replaceAll("/", "_")}`,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch {
    // 不正なURLからのダウンロード要求は無視します。
  }
});
