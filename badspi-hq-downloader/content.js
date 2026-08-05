(function () {
  "use strict";

  const core = globalThis.BadspiImageCore;
  let scanQueued = false;
  let currentDownloadUrl = "";

  function imageCandidates(image) {
    const urls = [];
    const anchor = image.closest("a[href]");
    if (anchor) urls.push(anchor.href);
    urls.push(image.currentSrc, image.src);
    urls.push(...core.parseSrcset(image.getAttribute("srcset") || ""));
    return urls;
  }

  function preparePageImage(image) {
    if (!(image instanceof HTMLImageElement)) return;
    const original = core.bestUrl(imageCandidates(image));
    if (!original) return;

    image.dataset.badspiOriginal = original;
    const anchor = image.closest("a[href]");
    if (anchor && core.isBadspiUpload(anchor.href) && anchor.href !== original) anchor.href = original;
  }

  function ensureDownloadButton() {
    const lightbox = document.querySelector("#lightbox");
    const image = document.querySelector("#lightboxImage") || lightbox?.querySelector("img");
    if (!lightbox || !image) return;

    const original = core.originalUrl(image.currentSrc || image.src);
    if (!core.isBadspiUpload(original)) return;
    currentDownloadUrl = original;

    if (image.src !== original) image.src = original;

    let button = document.querySelector("#badspi-hq-download");
    if (button) return;

    button = document.createElement("button");
    button.id = "badspi-hq-download";
    button.type = "button";
    button.setAttribute("aria-label", "画像をダウンロード");
    button.title = "画像をダウンロード";
    button.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" />
      </svg>
    `;
    for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick"]) {
      button.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      });
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!currentDownloadUrl) return;
      chrome.runtime.sendMessage({
        type: "badspi-download",
        url: currentDownloadUrl,
        filename: core.filenameFromUrl(currentDownloadUrl),
      });
    });

    const target = document.querySelector("#imageData") || document.querySelector("#imageDataContainer") || lightbox;
    target.append(button);
  }

  function scan() {
    scanQueued = false;
    for (const image of document.images) preparePageImage(image);
    ensureDownloadButton();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  new MutationObserver(queueScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "src", "srcset", "style", "class"],
  });

  queueScan();
})();
