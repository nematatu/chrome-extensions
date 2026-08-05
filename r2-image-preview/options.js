const DEFAULTS = {
  baseUrlTemplate: "https://{bucket}.{accountId}.r2.cloudflarestorage.com/{key}",
  maxWidth: 120,
  maxHeight: 96,
  hoverOnly: false,
  showNonImages: false
};

const elements = {
  form: document.getElementById("options-form"),
  baseUrlTemplate: document.getElementById("baseUrlTemplate"),
  maxWidth: document.getElementById("maxWidth"),
  maxHeight: document.getElementById("maxHeight"),
  hoverOnly: document.getElementById("hoverOnly"),
  showNonImages: document.getElementById("showNonImages"),
  status: document.getElementById("status")
};

function setStatus(message) {
  elements.status.textContent = message;
  if (message) {
    window.setTimeout(() => {
      elements.status.textContent = "";
    }, 2000);
  }
}

function loadOptions() {
  chrome.storage.sync.get(DEFAULTS, (data) => {
    elements.baseUrlTemplate.value = data.baseUrlTemplate || "";
    elements.maxWidth.value = data.maxWidth;
    elements.maxHeight.value = data.maxHeight;
    elements.hoverOnly.checked = Boolean(data.hoverOnly);
    elements.showNonImages.checked = Boolean(data.showNonImages);
  });
}

function saveOptions(event) {
  event.preventDefault();

  const payload = {
    baseUrlTemplate: elements.baseUrlTemplate.value.trim(),
    maxWidth: Number(elements.maxWidth.value) || DEFAULTS.maxWidth,
    maxHeight: Number(elements.maxHeight.value) || DEFAULTS.maxHeight,
    hoverOnly: elements.hoverOnly.checked,
    showNonImages: elements.showNonImages.checked
  };

  chrome.storage.sync.set(payload, () => {
    setStatus("保存しました");
  });
}

elements.form.addEventListener("submit", saveOptions);
loadOptions();
