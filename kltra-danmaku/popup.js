const DEFAULTS = { enabled: true, fontSize: 23, transparency: 0, position: 0, speed: 130,
  showName: true, translationEnabled: true, translationSource: "auto", translationEngine: "online" };
const RANGES = { fontSize: [14, 40], transparency: [0, 100], position: [0, 100], speed: [60, 300] };
const controls = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, document.getElementById(key)]));
const status = document.getElementById("status");
const fullscreenButton = document.getElementById("fullscreen");
const prepareButton = document.getElementById("prepareTranslation");
const translationStatus = document.getElementById("translationStatus");
let activeTabId;

const STATUS_TEXT = {
  checking: "翻訳の利用可否を確認中…",
  disabled: "日本語翻訳は OFF です。",
  ready: "翻訳の準備ができています。",
  partial: "インドネシア語翻訳は利用可能です。自動判定用モデルは配信ページをクリックして準備します。",
  "needs-action": "初回準備が必要です。下のボタンを押してください。",
  loading: "翻訳モデルを準備中…",
  unavailable: "この Chrome では端末内翻訳を利用できません。",
  error: "翻訳を準備できませんでした。再試行してください。",
  online: "オンライン翻訳を利用中です。原文をすぐ表示し、訳を後から反映します。",
  "online-error": "オンライン翻訳に接続できません。原文を表示します。",
};

function formatValue(key, value) {
  if (key === "fontSize") return `${value} px`;
  if (key === "speed") return `${value} px/秒`;
  return `${value}%`;
}

function showValue(key) {
  document.getElementById(`${key}Value`).textContent = formatValue(key, controls[key].value);
}

async function save(key) {
  const input = controls[key];
  const value = input.type === "checkbox" ? input.checked
    : input.tagName === "SELECT" ? input.value : Number(input.value);
  if (key === "translationSource" && !["auto", "id", "en"].includes(value)) return;
  if (key === "translationEngine" && !["online", "local"].includes(value)) return;
  if (typeof value === "number") {
    const [min, max] = RANGES[key];
    if (!Number.isFinite(value) || value < min || value > max) return;
  }
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch {
    status.textContent = "設定を保存できませんでした。";
  }
}

async function initialize() {
  try {
    const values = await chrome.storage.local.get(DEFAULTS);
    for (const [key, input] of Object.entries(controls)) {
      if (input.type === "checkbox") {
        input.checked = typeof values[key] === "boolean" ? values[key] : DEFAULTS[key];
      } else if (input.tagName === "SELECT") {
        const valid = key === "translationEngine" ? ["online", "local"] : ["auto", "id", "en"];
        input.value = valid.includes(values[key]) ? values[key] : DEFAULTS[key];
      } else {
        const [min, max] = RANGES[key];
        input.value = typeof values[key] === "number" && Number.isFinite(values[key])
          ? Math.min(max, Math.max(min, values[key])) : DEFAULTS[key];
        showValue(key);
      }
      input.addEventListener("change", () => save(key));
      if (input.type === "range") input.addEventListener("input", () => showValue(key));
    }
  } catch {
    status.textContent = "設定を読み込めませんでした。";
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, { frameId: 0 });
    if (!response?.ready) throw new Error("Content script unavailable");
    activeTabId = tab.id;
    status.textContent = "このタブで動作中";
    fullscreenButton.disabled = false;
    prepareButton.disabled = controls.translationEngine.value !== "local";
    translationStatus.textContent = STATUS_TEXT[response.translation] || STATUS_TEXT.checking;
    fullscreenButton.textContent = response.fullscreen ? "全画面を終了" : "弾幕付き全画面";
  } catch {
    status.textContent = "対象の配信ページを開いてください。";
    translationStatus.textContent = "対象ページを開くと翻訳を利用できます。";
  }
}

async function prepareTranslation() {
  if (controls.translationEngine.value !== "local") return;
  if (!activeTabId || typeof Translator === "undefined") {
    translationStatus.textContent = STATUS_TEXT.unavailable;
    return;
  }
  const languages = [controls.translationSource.value === "en" ? "en" : "id"];
  let creations;
  try {
    // create() をクリックの同期処理内で始め、初回モデル取得に必要なユーザー操作を渡す。
    creations = languages.map((language) => Translator.create({
      sourceLanguage: language,
      targetLanguage: "ja",
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          translationStatus.textContent = `翻訳モデルを取得中… ${Math.round(event.loaded * 100)}%`;
        });
      },
    }));
  } catch (error) {
    translationStatus.textContent = `${STATUS_TEXT.error} (${error.name || "Error"})`;
    return;
  }
  prepareButton.disabled = true;
  translationStatus.textContent = STATUS_TEXT.loading;
  try {
    const sessions = await Promise.all(creations);
    sessions.forEach((session) => session.destroy?.());
    const response = await chrome.tabs.sendMessage(activeTabId,
      { type: "PREPARE_TRANSLATION" }, { frameId: 0 });
    translationStatus.textContent = response.translation === "ready" || response.translation === "partial"
      ? STATUS_TEXT[response.translation]
      : "モデルを取得しました。配信ページを一度クリックすると翻訳が始まります。";
  } catch (error) {
    translationStatus.textContent = `${STATUS_TEXT.error} (${error.name || "Error"})`;
  } finally {
    prepareButton.disabled = false;
  }
}

prepareButton.addEventListener("click", prepareTranslation);
controls.translationEngine.addEventListener("change", () => {
  prepareButton.disabled = controls.translationEngine.value !== "local" || !activeTabId;
  translationStatus.textContent = controls.translationEngine.value === "online"
    ? STATUS_TEXT.online : STATUS_TEXT.checking;
});

fullscreenButton.addEventListener("click", async () => {
  if (!activeTabId) return;
  fullscreenButton.disabled = true;
  try {
    const response = await chrome.tabs.sendMessage(activeTabId, { type: "TOGGLE_FULLSCREEN" }, { frameId: 0 });
    if (!response?.ok) throw new Error("Fullscreen request failed");
    fullscreenButton.textContent = response.fullscreen ? "全画面を終了" : "弾幕付き全画面";
    status.textContent = response.fullscreen ? "全画面表示中" : "このタブで動作中";
  } catch {
    status.textContent = "全画面にできませんでした。";
  } finally {
    fullscreenButton.disabled = false;
  }
});

initialize();
