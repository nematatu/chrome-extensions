(() => {
  "use strict";

  if (window.__koutairenGalleryFixInstalled) return;
  window.__koutairenGalleryFixInstalled = true;

  const THUMBNAIL_SELECTOR =
    ".game-detail-gallery-item-photos-photo img, .gallery-item-photos-photo img";

  let photos = [];
  let currentIndex = -1;
  let overlay;
  let image;
  let caption;
  let counter;
  let previousButton;
  let nextButton;
  let touchStartX = null;

  const getPhotos = () => {
    const seen = new Set();

    return [...document.querySelectorAll(THUMBNAIL_SELECTOR)]
      .filter((item) => {
        const src = item.currentSrc || item.src;
        if (!src || seen.has(src)) return false;
        seen.add(src);
        return true;
      })
      .map((item) => ({
        element: item,
        src: item.currentSrc || item.src,
        alt: item.alt || ""
      }));
  };

  const createButton = (className, label, text) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = text;
    return button;
  };

  const ensureViewer = () => {
    if (overlay) return;

    overlay = document.createElement("div");
    overlay.className = "kgf-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "写真ビューアー");
    overlay.hidden = true;

    const stage = document.createElement("div");
    stage.className = "kgf-stage";

    image = document.createElement("img");
    image.className = "kgf-image";
    image.draggable = false;

    caption = document.createElement("div");
    caption.className = "kgf-caption";

    counter = document.createElement("div");
    counter.className = "kgf-counter";
    counter.setAttribute("aria-live", "polite");

    previousButton = createButton("kgf-arrow kgf-previous", "前の写真", "‹");
    nextButton = createButton("kgf-arrow kgf-next", "次の写真", "›");
    const closeButton = createButton("kgf-close", "閉じる", "×");

    previousButton.addEventListener("click", (event) => {
      event.stopPropagation();
      show(currentIndex - 1);
    });
    nextButton.addEventListener("click", (event) => {
      event.stopPropagation();
      show(currentIndex + 1);
    });
    closeButton.addEventListener("click", close);
    stage.addEventListener("click", (event) => event.stopPropagation());
    overlay.addEventListener("click", close);

    overlay.addEventListener(
      "touchstart",
      (event) => {
        touchStartX = event.changedTouches[0]?.clientX ?? null;
      },
      { passive: true }
    );
    overlay.addEventListener(
      "touchend",
      (event) => {
        if (touchStartX === null) return;
        const endX = event.changedTouches[0]?.clientX ?? touchStartX;
        const distance = endX - touchStartX;
        touchStartX = null;
        if (Math.abs(distance) < 50) return;
        show(currentIndex + (distance < 0 ? 1 : -1));
      },
      { passive: true }
    );

    stage.append(image, caption, counter);
    overlay.append(stage, previousButton, nextButton, closeButton);
    document.documentElement.append(overlay);
  };

  const show = (requestedIndex) => {
    if (!photos.length) return;

    currentIndex = (requestedIndex + photos.length) % photos.length;
    const photo = photos[currentIndex];
    image.src = photo.src;
    image.alt = photo.alt;
    caption.textContent = photo.alt;
    caption.hidden = !photo.alt;
    counter.textContent = `${currentIndex + 1} / ${photos.length}`;

    const hasMultiple = photos.length > 1;
    previousButton.hidden = !hasMultiple;
    nextButton.hidden = !hasMultiple;
  };

  const open = (clickedImage) => {
    photos = getPhotos();
    const clickedSrc = clickedImage.currentSrc || clickedImage.src;
    const index = photos.findIndex((photo) => photo.src === clickedSrc);
    if (index < 0) return;

    ensureViewer();
    overlay.hidden = false;
    document.documentElement.classList.add("kgf-viewer-open");
    show(index);
    nextButton.focus({ preventScroll: true });
  };

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    image.removeAttribute("src");
    document.documentElement.classList.remove("kgf-viewer-open");
    photos[currentIndex]?.element?.focus?.({ preventScroll: true });
    currentIndex = -1;
  }

  window.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest(THUMBNAIL_SELECTOR)
          : null;
      if (!target) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      open(target);
    },
    true
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (!overlay || overlay.hidden) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopImmediatePropagation();
        show(currentIndex - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        show(currentIndex + 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
    },
    true
  );
})();
