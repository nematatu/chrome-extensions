(() => {
  const DEFAULTS = {
    baseUrlTemplate: "https://{bucket}.{accountId}.r2.cloudflarestorage.com/{key}",
    maxWidth: 120,
    maxHeight: 96,
    hoverOnly: false,
    showNonImages: false
  };
  const FALLBACK_CUSTOM_DOMAIN = "https://assets.blog.amatatu.com/{key}";
  const BUILD_ID = "2026-01-21-01";

  const IMAGE_EXTENSIONS = [
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "avif",
    "svg",
    "bmp"
  ];

  const state = {
    options: { ...DEFAULTS },
    observer: null,
    scheduled: false,
    isRendering: false,
    loggedSignatures: new Set(),
    clipboardBusy: false
  };
  const previewStatus = new Map();
  let clipboardToastTimer = null;

  function getAccountId() {
    const match = window.location.pathname.match(/^\/([a-f0-9]{32})\/r2\//i);
    return match ? match[1] : "";
  }

  function getBucketName() {
    const match = window.location.pathname.match(/\/r2\/[^/]+\/buckets\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function getPrefixParam() {
    const params = new URLSearchParams(window.location.search);
    const prefix = params.get("prefix");
    if (!prefix) {
      return "";
    }
    return prefix;
  }

  function decodeKey(raw) {
    if (!raw) {
      return "";
    }
    let value = raw;
    for (let i = 0; i < 3; i += 1) {
      try {
        const next = decodeURIComponent(value);
        if (next === value) {
          break;
        }
        value = next;
      } catch {
        break;
      }
    }
    return value;
  }

  function normalizeKey(raw) {
    const decoded = decodeKey(raw).replace(/^\/+/, "");
    const prefixRaw = decodeKey(getPrefixParam()).replace(/^\/+/, "");
    if (!prefixRaw) {
      return decoded;
    }
    const prefix = prefixRaw.endsWith("/") ? prefixRaw : `${prefixRaw}/`;
    let value = decoded;
    if (value.startsWith(prefix)) {
      let rest = value.slice(prefix.length);
      while (rest.startsWith(prefix)) {
        rest = rest.slice(prefix.length);
      }
      return `${prefix}${rest}`;
    }
    return `${prefix}${value}`.replace(/\/{2,}/g, "/");
  }

  function encodeKey(key) {
    return key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  function getMaxWidth() {
    return Number(state.options.maxWidth) || DEFAULTS.maxWidth;
  }

  function getMaxHeight() {
    return Number(state.options.maxHeight) || DEFAULTS.maxHeight;
  }

  function applyCellSizing(cell) {
    const maxWidth = getMaxWidth();
    cell.style.width = `${maxWidth}px`;
    cell.style.maxWidth = `${maxWidth}px`;
    cell.style.flex = "0 0 auto";
    cell.style.minWidth = "0";
  }

  function isImageKey(key) {
    const clean = key.split("?")[0].split("#")[0];
    const parts = clean.toLowerCase().split(".");
    if (parts.length < 2) {
      return false;
    }
    const ext = parts.pop();
    return IMAGE_EXTENSIONS.includes(ext);
  }

  function buildUrl(key) {
    let template = state.options.baseUrlTemplate || "";
    if (!template) {
      return "";
    }
    if (template === DEFAULTS.baseUrlTemplate) {
      const bucket = getBucketName();
      if (bucket === "blog-images") {
        template = FALLBACK_CUSTOM_DOMAIN;
      }
    }
    if (getBucketName() === "blog-images" && !template.includes("assets.blog.amatatu.com")) {
      const normalizedTemplate = template.replace(/^https?:\/\//, "");
      if (normalizedTemplate.includes("r2.cloudflarestorage.com")) {
        template = FALLBACK_CUSTOM_DOMAIN;
      }
    }
    const accountId = getAccountId();
    const bucket = getBucketName();
    const normalizedKey = normalizeKey(key);
    const encodedKey = encodeKey(normalizedKey);
    const base = template
      .replace(/\{accountId\}/g, accountId)
      .replace(/\{bucket\}/g, bucket)
      .replace(/\{key\}/g, encodedKey);
    if (base === template && !/\{key\}/.test(template)) {
      return `${template.replace(/\/+$/g, "")}/${encodedKey}`;
    }
    return base;
  }

  function parseKeyFromHref(href) {
    if (!href) {
      return "";
    }
    const marker = href.match(/\/objects?\//i);
    if (!marker) {
      return "";
    }
    const start = href.indexOf(marker[0]) + marker[0].length;
    let rest = href.slice(start);
    rest = rest.split("?")[0].split("#")[0];
    if (rest.endsWith("/details")) {
      rest = rest.slice(0, -"/details".length);
    }
    if (!rest) {
      return "";
    }
    return normalizeKey(rest);
  }

  function extractKeyFromRow(row) {
    const attr = row.getAttribute("data-object-key") || row.dataset.objectKey;
    if (attr) {
      return normalizeKey(attr.trim());
    }

    const keyCell = row.querySelector('[data-testid="object-key"], [data-testid="directory-key"]');
    if (keyCell) {
      const link = keyCell.querySelector("a");
      const href = link ? link.getAttribute("href") : "";
      const fromHref = parseKeyFromHref(href);
      if (fromHref) {
        return normalizeKey(fromHref.trim());
      }
      const text = (link ? link.textContent : keyCell.textContent) || "";
      if (text.trim()) {
        return normalizeKey(text.trim());
      }
    }

    const link = row.querySelector('a[href*="/r2/"][href*="objects"], a[href*="/r2/"][href*="object"], a[href*="/objects/"]');
    if (link) {
      const fromHref = parseKeyFromHref(link.getAttribute("href"));
      if (fromHref) {
        return normalizeKey(fromHref.trim());
      }
      if (link.textContent) {
        return normalizeKey(link.textContent.trim());
      }
    }

    const firstCell = row.querySelector("td");
    if (!firstCell) {
      return "";
    }
    const text = (firstCell.innerText || firstCell.textContent || "").trim();
    if (!text) {
      return "";
    }
    return normalizeKey(text.split("\n")[0].trim());
  }

  function getHeaderRow(table) {
    if (table.tagName === "TABLE") {
      return table.querySelector("thead tr");
    }
    const rows = Array.from(table.querySelectorAll('[role="row"], tr'));
    return rows.find((row) => row.querySelector('[role="columnheader"], th'));
  }

  function getBodyRows(table) {
    if (table.tagName === "TABLE") {
      return Array.from(table.querySelectorAll("tbody tr"));
    }
    const rows = Array.from(table.querySelectorAll('[role="row"]'));
    return rows.filter(
      (row) => row.querySelector('[role="cell"], td') && !row.querySelector('[role="columnheader"], th')
    );
  }

  function createHeaderCell(headerRow) {
    const isTableRow = headerRow.tagName === "TR";
    const cell = document.createElement(isTableRow ? "th" : "div");
    if (!isTableRow) {
      cell.setAttribute("role", "columnheader");
    }
    cell.textContent = "Preview";
    cell.className = "r2-preview-header";
    applyCellSizing(cell);
    return cell;
  }

  function ensureHeader(table) {
    const headerRow = getHeaderRow(table);
    if (!headerRow) {
      return;
    }
    const existing = headerRow.querySelector(".r2-preview-header");
    if (existing) {
      applyCellSizing(existing);
      return;
    }
    headerRow.appendChild(createHeaderCell(headerRow));
  }

  function applyHoverMode(row) {
    if (state.options.hoverOnly) {
      row.classList.add("r2-preview-hover");
    } else {
      row.classList.remove("r2-preview-hover");
    }
  }

  function renderFallback(wrapper, message, stateLabel) {
    wrapper.classList.remove("r2-preview-hidden");
    wrapper.innerHTML = "";
    const span = document.createElement("div");
    span.className = "r2-preview-fallback";
    span.textContent = message;
    wrapper.appendChild(span);
    wrapper.dataset.previewState = stateLabel || "";
  }

  function isNodeInPreview(node) {
    if (!node) {
      return false;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      return Boolean(node.closest(".r2-preview-cell"));
    }
    if (node.parentElement) {
      return Boolean(node.parentElement.closest(".r2-preview-cell"));
    }
    return false;
  }

  function shouldIgnoreMutations(mutations) {
    return mutations.every((mutation) => {
      if (!isNodeInPreview(mutation.target)) {
        return false;
      }
      for (const node of mutation.addedNodes) {
        if (!isNodeInPreview(node)) {
          return false;
        }
      }
      for (const node of mutation.removedNodes) {
        if (!isNodeInPreview(node)) {
          return false;
        }
      }
      return true;
    });
  }

  function ensureCell(row) {
    const existing = row.querySelector(".r2-preview-cell");
    if (existing) {
      applyCellSizing(existing);
      applyHoverMode(row);
      return;
    }
    const isTableRow = row.tagName === "TR";
    const cell = document.createElement(isTableRow ? "td" : "div");
    if (!isTableRow) {
      cell.setAttribute("role", "cell");
    }
    cell.className = "r2-preview-cell";
    applyCellSizing(cell);

    const wrapper = document.createElement("div");
    wrapper.className = "r2-preview-wrapper";

    cell.appendChild(wrapper);
    row.appendChild(cell);
    applyHoverMode(row);
  }

  function updateRow(row) {
    ensureCell(row);
    const cell = row.querySelector(".r2-preview-cell");
    const wrapper = cell ? cell.querySelector(".r2-preview-wrapper") : null;
    if (!wrapper) {
      return;
    }

    const rawKey = extractKeyFromRow(row);
    const key = normalizeKey(rawKey);
    if (!key || key.endsWith("/")) {
      wrapper.classList.remove("r2-preview-hidden");
      wrapper.dataset.previewSignature = "";
      wrapper.dataset.previewState = "";
      wrapper.innerHTML = "";
      return;
    }

    const isImage = isImageKey(key);
    const url = buildUrl(key);
    const maxWidth = getMaxWidth();
    const maxHeight = getMaxHeight();
    const signature = `${key}|${url}|${isImage ? "img" : "non"}|${state.options.showNonImages ? "show" : "hide"}|${maxWidth}x${maxHeight}`;

    if (wrapper.dataset.previewSignature === signature) {
      applyCellSizing(cell);
      return;
    }

    wrapper.dataset.previewSignature = signature;
    wrapper.dataset.previewState = "";

    if (!state.loggedSignatures.has(signature)) {
      state.loggedSignatures.add(signature);
      if (url) {
        console.debug("[r2-preview] url", url, "key", key);
      } else {
        console.debug("[r2-preview] url missing for key", key);
      }
    }

    if (previewStatus.get(signature) === "error") {
      renderFallback(wrapper, "表示できません", "error");
      return;
    }

    wrapper.innerHTML = "";

    if (!isImage) {
      if (state.options.showNonImages) {
        renderFallback(wrapper, "画像ではありません", "non-image");
      } else {
        wrapper.classList.add("r2-preview-hidden");
      }
      return;
    }

    wrapper.classList.remove("r2-preview-hidden");

    if (!url) {
      renderFallback(wrapper, "URL未設定", "empty");
      return;
    }

    const img = document.createElement("img");
    img.className = "r2-preview-img";
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = key;
    img.referrerPolicy = "no-referrer";
    img.src = url;
    img.style.maxWidth = `${maxWidth}px`;
    img.style.maxHeight = `${maxHeight}px`;

    img.onload = () => {
      previewStatus.set(signature, "ok");
      wrapper.dataset.previewState = "ok";
    };

    img.onerror = () => {
      previewStatus.set(signature, "error");
      wrapper.dataset.previewState = "error";
      renderFallback(wrapper, "表示できません", "error");
    };

    wrapper.appendChild(img);
  }

  function findTargetTables() {
    const explicit = Array.from(document.querySelectorAll('[data-testid="objects-table"]'));
    if (explicit.length > 0) {
      return explicit;
    }

    const tables = Array.from(
      new Set([...document.querySelectorAll("table"), ...document.querySelectorAll('[role="table"]')])
    );
    if (tables.length === 0) {
      return [];
    }

    const scored = tables.map((table) => {
      const headers = Array.from(table.querySelectorAll("thead th, [role='columnheader'], th")).map((th) =>
        (th.textContent || "").trim().toLowerCase()
      );
      const score = headers.some((h) => h === "name" || h === "key" || h === "object" || h === "file")
        ? 2
        : headers.length > 0
        ? 1
        : 0;
      return { table, score };
    });

    const maxScore = Math.max(...scored.map((s) => s.score));
    return scored.filter((s) => s.score === maxScore).map((s) => s.table);
  }

  function render() {
    state.scheduled = false;
    state.isRendering = true;
    try {
      const tables = findTargetTables();
      if (tables.length === 0) {
        return;
      }

      tables.forEach((table) => {
        ensureHeader(table);
        const rows = getBodyRows(table);
        rows.forEach((row) => updateRow(row));
      });
    } finally {
      state.isRendering = false;
    }
  }

  function scheduleRender() {
    if (state.scheduled) {
      return;
    }
    state.scheduled = true;
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(render, { timeout: 300 });
    } else {
      window.setTimeout(render, 120);
    }
  }

  function startObserver() {
    if (state.observer) {
      state.observer.disconnect();
    }
    state.observer = new MutationObserver((mutations) => {
      if (state.isRendering) {
        return;
      }
      if (shouldIgnoreMutations(mutations)) {
        return;
      }
      scheduleRender();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function loadOptions() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        state.options = { ...DEFAULTS, ...data };
        resolve();
      });
    });
  }

  function isEditableElement(element) {
    if (!element) {
      return false;
    }
    if (element.isContentEditable) {
      return true;
    }
    const tag = element.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function extractClipboardImage(event) {
    const data = event.clipboardData;
    if (!data || !data.items) {
      return null;
    }
    const items = Array.from(data.items);
    const imageItem = items.find((item) => item.kind === "file" && item.type && item.type.startsWith("image/"));
    if (!imageItem) {
      return null;
    }
    return imageItem.getAsFile();
  }

  function inferExtension(mime) {
    const type = (mime || "").toLowerCase();
    if (type.includes("png")) {
      return "png";
    }
    if (type.includes("jpeg") || type.includes("jpg")) {
      return "jpg";
    }
    if (type.includes("webp")) {
      return "webp";
    }
    if (type.includes("gif")) {
      return "gif";
    }
    if (type.includes("avif")) {
      return "avif";
    }
    if (type.includes("bmp")) {
      return "bmp";
    }
    if (type.includes("svg")) {
      return "svg";
    }
    return "png";
  }

  function normalizeClipboardFile(file) {
    if (!file) {
      return null;
    }
    const name = (file.name || "").trim();
    if (name) {
      return file;
    }
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const ext = inferExtension(file.type);
    const filename = `clipboard-${stamp}.${ext}`;
    return new File([file], filename, { type: file.type || "image/png" });
  }

  function ensureClipboardToast() {
    let toast = document.getElementById("r2-clipboard-toast");
    if (toast) {
      return toast;
    }
    toast = document.createElement("div");
    toast.id = "r2-clipboard-toast";
    toast.className = "r2-clipboard-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
    return toast;
  }

  function showClipboardToast(message, status, duration) {
    const toast = ensureClipboardToast();
    toast.textContent = message;
    toast.dataset.status = status || "info";
    toast.classList.add("is-visible");
    if (clipboardToastTimer) {
      window.clearTimeout(clipboardToastTimer);
    }
    const timeout = Number.isFinite(duration) ? duration : 2200;
    clipboardToastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, timeout);
  }

  function isElementVisible(element) {
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function pickFileInput(container) {
    const inputs = Array.from(container.querySelectorAll("input[type='file']"));
    if (inputs.length === 0) {
      return null;
    }
    const enabled = inputs.filter((input) => !input.disabled);
    const visible = enabled.filter((input) => isElementVisible(input));
    const imagePreferred = visible.filter((input) => (input.accept || "").toLowerCase().includes("image"));
    return imagePreferred[0] || visible[0] || enabled[0] || inputs[0];
  }

  function findFileInput() {
    const modal =
      document.querySelector('[role="dialog"], [aria-modal="true"]') ||
      document.querySelector('[data-testid*="modal"], .modal, .dialog');
    if (modal) {
      const input = pickFileInput(modal);
      if (input) {
        return input;
      }
    }
    return pickFileInput(document);
  }

  function setFilesOnInput(input, file) {
    if (!input || !file) {
      return false;
    }
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (error) {
      console.warn("[r2-preview] setFilesOnInput failed", error);
      return false;
    }
  }

  function findUploadButton() {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    const patterns = ["upload", "アップロード", "add files", "ファイルを追加", "追加"];
    return buttons.find((button) => {
      const label = (
        button.getAttribute("aria-label") ||
        button.getAttribute("title") ||
        button.textContent ||
        ""
      )
        .trim()
        .toLowerCase();
      return patterns.some((pattern) => label.includes(pattern));
    });
  }

  function tryOpenUploadDialog() {
    const button = findUploadButton();
    if (!button) {
      return false;
    }
    button.click();
    return true;
  }

  function waitForFileInput(timeoutMs) {
    const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 3000;
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = window.setInterval(() => {
        const input = findFileInput();
        if (input) {
          window.clearInterval(timer);
          resolve(input);
          return;
        }
        if (Date.now() - start > timeout) {
          window.clearInterval(timer);
          resolve(null);
        }
      }, 120);
    });
  }

  function findDropTarget() {
    return (
      document.querySelector('[data-testid="objects-table"]') ||
      document.querySelector('[role="table"]') ||
      document.querySelector("table") ||
      document.body
    );
  }

  function dispatchDrop(target, file) {
    if (!target || !file) {
      return false;
    }
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const events = ["dragenter", "dragover", "drop"];
      events.forEach((type) => {
        let event;
        try {
          event = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer
          });
        } catch {
          event = new Event(type, { bubbles: true, cancelable: true });
          event.dataTransfer = dataTransfer;
        }
        target.dispatchEvent(event);
      });
      return true;
    } catch (error) {
      console.warn("[r2-preview] dispatchDrop failed", error);
      return false;
    }
  }

  async function handleClipboardUpload(file) {
    if (state.clipboardBusy) {
      return;
    }
    state.clipboardBusy = true;
    try {
      const normalizedFile = normalizeClipboardFile(file);
      if (!normalizedFile) {
        return;
      }
      showClipboardToast("クリップボード画像をアップロード中...");

      let input = findFileInput();
      if (!input && tryOpenUploadDialog()) {
        input = await waitForFileInput(3500);
      }
      if (input && setFilesOnInput(input, normalizedFile)) {
        showClipboardToast("アップロードを開始しました", "ok");
        return;
      }

      const dropTarget = findDropTarget();
      if (dispatchDrop(dropTarget, normalizedFile)) {
        showClipboardToast("アップロードを開始しました", "ok");
        return;
      }

      showClipboardToast(
        "アップロード先が見つかりません。アップロード画面を開いてから貼り付けてください。",
        "error",
        3600
      );
    } finally {
      state.clipboardBusy = false;
    }
  }

  function handlePaste(event) {
    if (state.clipboardBusy) {
      return;
    }
    if (isEditableElement(document.activeElement)) {
      return;
    }
    const file = extractClipboardImage(event);
    if (!file) {
      return;
    }
    event.preventDefault();
    handleClipboardUpload(file);
  }

  function init() {
    console.debug("[r2-preview] build", BUILD_ID);
    loadOptions().then(() => {
      render();
      startObserver();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") {
        return;
      }
      Object.keys(changes).forEach((key) => {
        state.options[key] = changes[key].newValue;
      });
      scheduleRender();
    });

    document.addEventListener("paste", handlePaste, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
