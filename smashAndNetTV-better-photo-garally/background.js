"use strict";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "download-photo") {
    return undefined;
  }

  let photoUrl;
  try {
    photoUrl = new URL(message.url);
  } catch {
    sendResponse({ ok: false, error: "画像URLが不正です。" });
    return undefined;
  }

  if (
    photoUrl.protocol !== "https:" ||
    !["www.smash-net.tv", "smash-net.tv"].includes(photoUrl.hostname)
  ) {
    sendResponse({ ok: false, error: "許可されていない画像URLです。" });
    return undefined;
  }

  chrome.downloads
    .download({ url: photoUrl.href, saveAs: false })
    .then((downloadId) => sendResponse({ ok: true, downloadId }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
