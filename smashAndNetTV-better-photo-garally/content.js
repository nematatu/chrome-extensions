"use strict";

const MODAL_SELECTOR = ".photomodal";
const PHOTO_SELECTOR = ".photomodal-contents-img img";
const PREVIOUS_SELECTOR = ".photo-prev";
const NEXT_SELECTOR = ".photo-next";
const CLOSE_SELECTOR = ".photo-close";
const DOWNLOAD_CLASS = "snt-gallery-download";
const PAGINATION_CLASS = "snt-pagination";
const COUNTER_CLASS = "snt-photo-counter";
const META_CLASS = "snt-gallery-meta";

function isModalOpen(modal) {
  if (!modal) return false;

  const style = getComputedStyle(modal);
  return style.display !== "none" && style.visibility !== "hidden";
}

function galleryItems() {
  return Array.from(document.querySelectorAll(".movie002-list > li"));
}

function currentPhotoIndex(modal, items) {
  const currentUrl = modal.querySelector(PHOTO_SELECTOR)?.src;
  if (!currentUrl) return 0;

  const index = items.findIndex((item) => item.querySelector("img")?.src === currentUrl);
  return index < 0 ? 0 : index;
}

function showRelativePhoto(modal, offset) {
  const items = galleryItems();
  if (items.length === 0) return;

  const currentIndex = currentPhotoIndex(modal, items);
  const nextIndex = (currentIndex + offset + items.length) % items.length;
  const nextItem = items[nextIndex];
  const sourceImage = nextItem.querySelector(".movie002-list-item-img img, img");
  const modalImage = modal.querySelector(PHOTO_SELECTOR);
  const caption = modal.querySelector(".photomodal-contents-img p");

  if (!sourceImage || !modalImage) return;

  modalImage.src = sourceImage.currentSrc || sourceImage.src;
  if (caption) {
    caption.innerHTML = nextItem.querySelector("p")?.innerHTML || "";
  }
  updatePhotoCounter(modal);
}

function closeModal(modal) {
  modal.style.display = "none";
}

function sizeModalImage(image) {
  if (!image?.naturalWidth || !image?.naturalHeight) return;

  const padding = matchMedia("(max-width: 640px)").matches ? 8 : 12;
  const availableWidth = window.innerWidth - padding * 2;
  const scale = availableWidth / image.naturalWidth;
  const displayWidth = Math.floor(image.naturalWidth * scale);
  const displayHeight = Math.floor(image.naturalHeight * scale);

  image.style.setProperty("width", `${displayWidth}px`, "important");
  image.style.setProperty("height", `${displayHeight}px`, "important");
  image.closest(".photomodal-contents")?.style.setProperty(
    "height",
    `${displayHeight + padding * 2}px`,
    "important"
  );
}

function paginationUrl(page, sampleUrl) {
  const url = new URL(sampleUrl, location.href);
  const pagePattern = /\/page\/\d+\/?$/;

  if (page === 1) {
    url.pathname = url.pathname.replace(pagePattern, "/");
  } else if (pagePattern.test(url.pathname)) {
    url.pathname = url.pathname.replace(pagePattern, `/page/${page}/`);
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/page/${page}/`;
  }

  return url.href;
}

function paginationPages(current, total) {
  const pages = new Set([
    1,
    Math.round(total * 0.25),
    Math.round(total * 0.5),
    Math.round(total * 0.75),
    total
  ]);
  for (let page = current - 3; page <= current + 3; page += 1) {
    if (page >= 1 && page <= total) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

function updatePhotoCounter(modal) {
  if (!modal) return;
  const counter = modal.querySelector(`.${COUNTER_CLASS}`);
  if (!counter) return;

  const items = galleryItems();
  const localIndex = currentPhotoIndex(modal, items);
  const currentIndex = localIndex + 1;
  const maxIndex = items.length;
  counter.textContent = `${currentIndex} / ${maxIndex}`;
  counter.setAttribute("aria-label", `このページの写真 ${maxIndex} 枚中 ${currentIndex} 番目`);
}

function enhancePagination() {
  const pager = document.querySelector(".movie002 .pager");
  if (!pager || pager.classList.contains(PAGINATION_CLASS)) return;

  const match = pager.querySelector("p")?.textContent.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return;

  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(current) || !Number.isInteger(total) || total < 2) return;

  const sampleUrl = pager.querySelector("a")?.href || location.href;
  const fragment = document.createDocumentFragment();
  const landmarks = new Set([
    Math.round(total * 0.25),
    Math.round(total * 0.5),
    Math.round(total * 0.75)
  ]);

  const addLink = (page, label, className = "") => {
    const link = document.createElement("a");
    link.href = paginationUrl(page, sampleUrl);
    link.textContent = label;
    link.className = [className, landmarks.has(page) ? "snt-pagination-landmark" : ""]
      .filter(Boolean)
      .join(" ");
    link.setAttribute("aria-label", `${page}ページ目へ`);
    fragment.append(link);
  };

  if (current > 1) addLink(current - 1, "‹", "snt-pagination-nav");

  const pages = paginationPages(current, total);
  pages.forEach((page, index) => {
    if (index > 0 && page - pages[index - 1] > 1) {
      const ellipsis = document.createElement("span");
      ellipsis.textContent = "…";
      ellipsis.className = "snt-pagination-ellipsis";
      ellipsis.setAttribute("aria-hidden", "true");
      fragment.append(ellipsis);
    }

    if (page === current) {
      const active = document.createElement("span");
      active.textContent = String(page);
      active.className = "snt-pagination-current";
      active.setAttribute("aria-current", "page");
      fragment.append(active);
    } else {
      addLink(page, String(page));
    }
  });

  if (current < total) addLink(current + 1, "›", "snt-pagination-nav");

  const jump = document.createElement("label");
  jump.className = "snt-pagination-jump";

  const jumpLabel = document.createElement("span");
  jumpLabel.textContent = "ページ";

  const select = document.createElement("select");
  select.setAttribute("aria-label", "移動先のページを選択");
  for (let page = 1; page <= total; page += 1) {
    const option = document.createElement("option");
    option.value = String(page);
    option.textContent = String(page);
    option.selected = page === current;
    select.append(option);
  }
  select.addEventListener("change", () => {
    location.href = paginationUrl(Number(select.value), sampleUrl);
  });

  jump.append(jumpLabel, select);
  fragment.append(jump);

  pager.replaceChildren(fragment);
  pager.classList.add(PAGINATION_CLASS);
  pager.setAttribute("aria-label", "写真一覧のページネーション");
}

function getMetaBar(modal) {
  let meta = modal.querySelector(`.${META_CLASS}`);
  if (meta) return meta;

  meta = document.createElement("div");
  meta.className = META_CLASS;
  modal.querySelector(".photomodal-contents")?.append(meta);
  return meta;
}

function createDownloadButton(modal) {
  if (modal.querySelector(`.${DOWNLOAD_CLASS}`)) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = DOWNLOAD_CLASS;
  button.setAttribute("aria-label", "写真をダウンロード");
  button.title = "写真をダウンロード";
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 19h14" />
    </svg>
  `;

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const imageUrl = modal.querySelector(PHOTO_SELECTOR)?.currentSrc ||
      modal.querySelector(PHOTO_SELECTOR)?.src;
    if (!imageUrl || button.disabled) return;

    button.disabled = true;
    button.classList.remove("is-error");
    button.classList.add("is-downloading");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "download-photo",
        url: imageUrl
      });

      if (!response?.ok) {
        throw new Error(response?.error || "ダウンロードを開始できませんでした。");
      }

      button.classList.add("is-success");
      window.setTimeout(() => button.classList.remove("is-success"), 900);
    } catch (error) {
      console.error("[Photo Gallery Plus]", error);
      button.classList.add("is-error");
      window.setTimeout(() => button.classList.remove("is-error"), 1600);
    } finally {
      button.disabled = false;
      button.classList.remove("is-downloading");
    }
  });

  getMetaBar(modal).append(button);
}

function createPhotoCounter(modal) {
  if (modal.querySelector(`.${COUNTER_CLASS}`)) return;
  const counter = document.createElement("output");
  counter.className = COUNTER_CLASS;
  counter.setAttribute("aria-live", "polite");
  getMetaBar(modal).prepend(counter);

  const image = modal.querySelector(PHOTO_SELECTOR);
  if (image) {
    new MutationObserver(() => updatePhotoCounter(modal)).observe(image, {
      attributes: true,
      attributeFilter: ["src"]
    });
  }
  updatePhotoCounter(modal);
}

function handleKeydown(event) {
  const modal = document.querySelector(MODAL_SELECTOR);
  if (!isModalOpen(modal)) return;

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    showRelativePhoto(modal, -1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    showRelativePhoto(modal, 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeModal(modal);
  } else if (event.key.toLowerCase() === "d" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    modal.querySelector(`.${DOWNLOAD_CLASS}`)?.click();
  }
}

function handleModalClick(event) {
  const modal = event.currentTarget;
  if (!(event.target instanceof Element)) return;
  const target = event.target;

  if (target.closest(`.${DOWNLOAD_CLASS}, ${PHOTO_SELECTOR}`)) return;

  if (target.closest(PREVIOUS_SELECTOR)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showRelativePhoto(modal, -1);
    return;
  }

  if (target.closest(NEXT_SELECTOR)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showRelativePhoto(modal, 1);
    return;
  }

  if (isModalOpen(modal)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeModal(modal);
  }
}

let initializedModal = null;

function initialize(modal = document.querySelector(MODAL_SELECTOR)) {
  if (!modal || modal === initializedModal) return false;

  initializedModal = modal;
  createDownloadButton(modal);
  createPhotoCounter(modal);
  const image = modal.querySelector(PHOTO_SELECTOR);
  if (image) {
    image.addEventListener("load", () => sizeModalImage(image));
    sizeModalImage(image);
    window.addEventListener("resize", () => sizeModalImage(image));
  }
  modal.addEventListener("click", handleModalClick, true);
  return true;
}

enhancePagination();
