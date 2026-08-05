const elements = {
  count: document.getElementById("count"),
  latest: document.getElementById("latest"),
  latestNetwork: document.getElementById("latestNetwork"),
  history: document.getElementById("history"),
  chart: document.getElementById("chart"),
  exportCsv: document.getElementById("exportCsv"),
  exportJson: document.getElementById("exportJson"),
  autoResultNetworkRecord: document.getElementById("autoResultNetworkRecord"),
  autoDownloadCsv: document.getElementById("autoDownloadCsv"),
  manualText: document.getElementById("manualText"),
  saveManual: document.getElementById("saveManual"),
  message: document.getElementById("message")
};

let currentResults = [];
let currentNetworkResults = [];

document.addEventListener("DOMContentLoaded", async () => {
  await render();
  installHandlers();
});

function installHandlers() {
  elements.exportCsv.addEventListener("click", exportCsv);
  elements.exportJson.addEventListener("click", exportJson);
  elements.saveManual.addEventListener("click", saveManual);
  elements.autoResultNetworkRecord.addEventListener("change", saveSettings);
  elements.autoDownloadCsv.addEventListener("change", saveSettings);
}

async function render() {
  const { results = [], networkResults = [], settings = { autoResultNetworkRecord: true, autoDownloadCsv: true } } = await chrome.storage.local.get([
    "results",
    "networkResults",
    "settings"
  ]);
  currentResults = results;
  currentNetworkResults = networkResults;
  elements.count.textContent = `${results.length + networkResults.length}件`;
  elements.autoResultNetworkRecord.checked = settings.autoResultNetworkRecord !== false;
  elements.autoDownloadCsv.checked = settings.autoDownloadCsv !== false;

  elements.latest.innerHTML = "";
  const latestShareResult = results.find((result) => result.source !== "result-network");
  if (latestShareResult) {
    elements.latest.className = "";
    elements.latest.appendChild(resultElement(latestShareResult));
  } else {
    elements.latest.className = "empty";
    elements.latest.textContent = "まだ記録がありません。";
  }

  elements.history.innerHTML = "";
  renderNetworkResult(networkResults[0]);
  renderChart([...networkResults, ...results]);

  [...networkResults, ...results].slice(0, 20).forEach((result) => {
    const item = document.createElement("li");
    item.appendChild(result.source === "result-network" ? networkResultElement(result) : resultElement(result));
    elements.history.appendChild(item);
  });
}

function resultElement(result) {
  const root = document.createElement("div");
  root.className = "result";

  const title = document.createElement("strong");
  title.textContent = `${result.course}【${result.difficulty}】`;

  const score = document.createElement("span");
  score.textContent = `${result.resultType === "profit" ? "お得" : "損"}: ${result.amountYen.toLocaleString()}円分`;

  const detail = document.createElement("span");
  detail.className = "meta";
  detail.textContent = `速度 ${result.speedKeyPerSec}key/秒 / ミス ${result.missedKeys}key`;

  const date = document.createElement("span");
  date.className = "meta";
  date.textContent = new Date(result.savedAt).toLocaleString("ja-JP");

  root.append(title, score, detail, date);
  return root;
}

async function saveSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: {
      ...settings,
      autoResultNetworkRecord: elements.autoResultNetworkRecord.checked,
      autoDownloadCsv: elements.autoDownloadCsv.checked
    }
  });
}

async function saveManual() {
  const result = window.SushidaLogParser.parseSushidaShareText(elements.manualText.value);
  if (!result) {
    setMessage("共有テキストを解析できませんでした。");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "SUSHIDA_SAVE_MANUAL_RESULT",
    result
  });

  if (!response.ok) {
    setMessage(response.error || "保存に失敗しました。");
    return;
  }

  elements.manualText.value = "";
  setMessage("保存しました。");
  await render();
}

async function exportCsv() {
  const csv = resultsToCsv(collectUniqueResults([...currentNetworkResults, ...currentResults]));
  await downloadText(csv, "sushida-log.csv", "text/csv");
}

async function exportJson() {
  await downloadText(JSON.stringify([...currentNetworkResults, ...currentResults], null, 2), "sushida-log.json", "application/json");
}

async function downloadText(text, filename, mimeType) {
  const url = `data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`;
  await chrome.downloads.download({ url, filename, saveAs: true });
}

function resultsToCsv(results) {
  const header = [
    "savedAt",
    "updatedAt",
    "source",
    "course",
    "difficulty",
    "resultType",
    "amountYen",
    "rankingScoreYen",
    "coursePriceYen",
    "submittedScoreYen",
    "speedKeyPerSec",
    "missedKeys",
    "shareText"
  ];
  return [
    header.join(","),
    ...results.map((result) =>
      header
        .map((key) => {
          const value =
            result[key] == null
              ? result.parsed && result.parsed[key] != null
                ? result.parsed[key]
                : ""
              : result[key];
          return `"${String(value).replace(/"/g, '""')}"`;
        })
        .join(",")
    )
  ].join("\n");
}

function setMessage(message) {
  elements.message.textContent = message;
}

function collectUniqueResults(results) {
  const map = new Map();
  for (const result of results) {
    if (!result || !result.id) continue;
    map.set(result.id, result);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.savedAt || "") - Date.parse(b.savedAt || ""));
}

function renderNetworkResult(result) {
  elements.latestNetwork.innerHTML = "";
  if (!result) {
    elements.latestNetwork.className = "empty";
    elements.latestNetwork.textContent = "まだ記録がありません。";
    return;
  }
  elements.latestNetwork.className = "";
  elements.latestNetwork.appendChild(networkResultElement(result));
}

function networkResultElement(result) {
  const root = document.createElement("div");
  root.className = "result";

  const title = document.createElement("strong");
  title.textContent = "結果通信";

  const date = document.createElement("span");
  date.className = "meta";
  date.textContent = new Date(result.savedAt).toLocaleString("ja-JP");

  const parsed = document.createElement("span");
  parsed.className = "meta";
  const parsedText = result.parsed && Object.keys(result.parsed).length
    ? JSON.stringify(result.parsed)
    : "解析できる項目は未確認です。";
  parsed.textContent = parsedText;

  root.append(title, date, parsed);
  return root;
}

function renderChart(results) {
  const canvas = elements.chart;
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);

  const points = collectUniqueResults(results)
    .map((result) => {
      const parsed = result.parsed || {};
      const value =
        result.amountYen ??
        parsed.amountYen ??
        result.rankingScoreYen ??
        parsed.rankingScoreYen ??
        result.submittedScoreYen ??
        parsed.submittedScoreYen;
      return Number(value);
    })
    .filter((value) => Number.isFinite(value));

  context.strokeStyle = "#cbd5e1";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(32, 12);
  context.lineTo(32, height - 24);
  context.lineTo(width - 12, height - 24);
  context.stroke();

  if (!points.length) {
    context.fillStyle = "#64748b";
    context.font = "12px system-ui, sans-serif";
    context.fillText("記録がありません", 104, 84);
    return;
  }

  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = Math.max(max - min, 1);
  const plotWidth = width - 48;
  const plotHeight = height - 40;

  context.strokeStyle = "#0f766e";
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((value, index) => {
    const x = 32 + (points.length === 1 ? plotWidth : (plotWidth * index) / (points.length - 1));
    const y = 12 + plotHeight - ((value - min) / range) * plotHeight;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();

  context.fillStyle = "#0f766e";
  points.forEach((value, index) => {
    const x = 32 + (points.length === 1 ? plotWidth : (plotWidth * index) / (points.length - 1));
    const y = 12 + plotHeight - ((value - min) / range) * plotHeight;
    context.beginPath();
    context.arc(x, y, 3, 0, Math.PI * 2);
    context.fill();
  });

  context.fillStyle = "#475569";
  context.font = "11px system-ui, sans-serif";
  context.fillText(String(max), 4, 18);
  context.fillText(String(min), 4, height - 24);
}
