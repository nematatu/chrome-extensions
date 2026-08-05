"use strict";

(() => {
  const items = () => Array.from(document.querySelectorAll(".movie002-list > li"));
  let currentIndex = 0;

  const host = document.createElement("div");
  host.id = "snt-photo-viewer";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .viewer {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        grid-template-rows: minmax(0, 1fr) auto 52px;
        box-sizing: border-box;
        width: 100vw;
        height: 100vh;
        padding: 12px;
        background: rgba(0, 0, 0, .82);
      }
      .viewer.open { display: grid; }
      .photo-area {
        display: grid;
        min-width: 0;
        min-height: 0;
        place-items: center;
      }
      .photo {
        display: block;
        width: auto;
        height: auto;
        max-width: none;
        max-height: none;
      }
      .caption {
        box-sizing: border-box;
        width: min(100%, 920px);
        margin: 0 auto;
        padding: 10px 16px 6px;
        color: #fff;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .caption[hidden] { display: none; }
      .title, .subtitle {
        overflow: hidden;
        margin: 0;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title {
        font-size: 15px;
        font-weight: 600;
        line-height: 1.45;
        letter-spacing: .01em;
      }
      .subtitle {
        margin-top: 2px;
        color: rgba(255, 255, 255, .72);
        font-size: 13px;
        line-height: 1.4;
      }
      .controls {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        min-width: 0;
        color: #fff;
        font: 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .left, .center, .right { display: flex; align-items: center; }
      .left { justify-content: flex-start; }
      .center { justify-content: center; gap: 14px; }
      .right { justify-content: flex-end; gap: 14px; }
      button {
        display: inline-grid;
        width: 34px;
        height: 34px;
        margin: 0;
        padding: 0;
        place-items: center;
        color: #fff;
        background: transparent;
        border: 0;
        cursor: pointer;
        opacity: .82;
      }
      button:hover, button:focus-visible { opacity: 1; }
      button:focus-visible { outline: 1px solid #fff; outline-offset: 1px; }
      button svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .counter { min-width: 52px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .nav { width: auto; padding: 0 6px; font-size: 14px; }
      @media (max-width: 640px) {
        .viewer { padding: 8px; grid-template-rows: minmax(0, 1fr) auto 48px; }
        .caption { padding: 8px 8px 4px; }
        .title { font-size: 14px; }
        .subtitle { font-size: 12px; }
        .right { gap: 6px; }
      }
    </style>
    <div class="viewer" role="dialog" aria-modal="true" aria-label="写真ビューアー">
      <div class="photo-area"><img class="photo" alt=""></div>
      <div class="caption" hidden>
        <p class="title"></p>
        <p class="subtitle"></p>
      </div>
      <div class="controls">
        <div class="left"><button class="nav previous" type="button" aria-label="前の写真">← return</button></div>
        <div class="center"><output class="counter"></output><button class="download" type="button" aria-label="写真をダウンロード" title="写真をダウンロード"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 19h14"/></svg></button></div>
        <div class="right"><button class="close" type="button" aria-label="閉じる"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><button class="nav next" type="button" aria-label="次の写真">next →</button></div>
      </div>
    </div>
  `;
  document.documentElement.append(host);

  const viewer = shadow.querySelector(".viewer");
  const photoArea = shadow.querySelector(".photo-area");
  const photo = shadow.querySelector(".photo");
  const caption = shadow.querySelector(".caption");
  const title = shadow.querySelector(".title");
  const subtitle = shadow.querySelector(".subtitle");
  const counter = shadow.querySelector(".counter");

  function resizePhoto() {
    if (!photo.naturalWidth || !photo.naturalHeight) return;

    const mobile = matchMedia("(max-width: 640px)").matches;
    const padding = mobile ? 8 : 12;
    const controlsHeight = mobile ? 48 : 52;
    const captionHeight = caption.hidden ? 0 : caption.getBoundingClientRect().height;
    const availableWidth = window.innerWidth - padding * 2;
    const availableHeight = window.innerHeight - padding * 2 - controlsHeight - captionHeight;
    const scale = Math.min(
      availableWidth / photo.naturalWidth,
      availableHeight / photo.naturalHeight
    );

    photo.style.width = `${Math.floor(photo.naturalWidth * scale)}px`;
    photo.style.height = `${Math.floor(photo.naturalHeight * scale)}px`;
  }

  function render() {
    const galleryItems = items();
    if (!galleryItems.length) return;
    currentIndex = (currentIndex + galleryItems.length) % galleryItems.length;
    const item = galleryItems[currentIndex];
    const source = item.querySelector(".movie002-list-item-img img, img");
    const titleText = item.querySelector(".toptitle")?.textContent.trim() || "";
    const subtitleText = item.querySelector(".msg")?.textContent.trim() || "";
    photo.src = source?.currentSrc || source?.src || "";
    photo.alt = [titleText, subtitleText].filter(Boolean).join(" ") || "写真";
    title.textContent = titleText;
    title.hidden = !titleText;
    subtitle.textContent = subtitleText;
    subtitle.hidden = !subtitleText;
    caption.hidden = !titleText && !subtitleText;
    if (photo.complete) requestAnimationFrame(resizePhoto);
    counter.value = `${currentIndex + 1} / ${galleryItems.length}`;
    counter.textContent = counter.value;
  }

  function open(index) {
    currentIndex = index;
    render();
    viewer.classList.add("open");
    document.documentElement.style.overflow = "hidden";
  }

  function close() {
    viewer.classList.remove("open");
    document.documentElement.style.overflow = "";
  }

  function move(offset) {
    currentIndex += offset;
    render();
  }

  document.addEventListener("click", (event) => {
    const item = event.target.closest?.(".movie002-list > li");
    if (!item) return;
    const galleryItems = items();
    const index = galleryItems.indexOf(item);
    if (index < 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(index);
  }, true);

  shadow.querySelector(".previous").addEventListener("click", () => move(-1));
  shadow.querySelector(".next").addEventListener("click", () => move(1));
  shadow.querySelector(".close").addEventListener("click", close);
  viewer.addEventListener("click", (event) => { if (event.target === viewer) close(); });
  photoArea.addEventListener("click", (event) => { if (event.target === photoArea) close(); });

  shadow.querySelector(".download").addEventListener("click", async () => {
    if (!photo.src) return;
    await chrome.runtime.sendMessage({ type: "download-photo", url: photo.src });
  });

  photo.addEventListener("load", resizePhoto);
  window.addEventListener("resize", resizePhoto);

  document.addEventListener("keydown", (event) => {
    if (!viewer.classList.contains("open")) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key.toLowerCase() === "d" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      shadow.querySelector(".download").click();
    }
  });
})();
