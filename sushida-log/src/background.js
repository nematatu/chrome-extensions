const DEFAULT_SETTINGS = {
  autoDownloadCsv: true,
  autoResultNetworkRecord: false,
  autoDownloadJson: false,
  settingsVersion: 2
};

const NETWORK_SESSION_WINDOW_MS = 15000;
const pendingDownloadTimers = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await initializeStorage();
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeStorage();
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    handleObservedRequest(details).catch((error) => {
      console.warn("Sushida Log: webRequest save failed", error);
    });
  },
  {
    urls: [
      "https://sushida.net/php/r.php*",
      "https://*.sushida.net/php/r.php*",
      "https://twitter.com/intent/tweet*",
      "https://x.com/intent/tweet*"
    ]
  },
  ["requestBody"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUSHIDA_RESULT_DETECTED") {
    saveDetectedResult(message.result, sender.tab)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SUSHIDA_SAVE_MANUAL_RESULT") {
    saveResult(message.result)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SUSHIDA_RESULT_NETWORK_DETECTED") {
    saveNetworkResult(message.payload, sender.tab)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SUSHIDA_DEBUG_EVENT") {
    saveDebugEvent(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function handleObservedRequest(details) {
  if (!details || !details.url) return;

  if (isTweetIntentUrl(details.url)) {
    const text = extractTweetText(details.url);
    const result = parseShareTextInBackground(text);
    if (result) {
      await saveDetectedResult(result, { url: details.initiator || details.documentUrl || "" });
    } else {
      await saveNetworkResult(
        {
          kind: "tweet-intent",
          reason: "webRequest",
          url: details.url
        },
        { url: details.initiator || details.documentUrl || "" }
      );
    }
    return;
  }

  if (details.url.includes("sushida.net/php/r.php")) {
    const settings = await getSettings();
    if (!settings.autoResultNetworkRecord) return;
    await saveNetworkResult(
      {
        kind: "request",
        reason: "webRequest",
        url: details.url,
        body: requestBodyToText(details.requestBody),
        download: false
      },
      { url: details.initiator || details.documentUrl || "" }
    );
  }
}

function isTweetIntentUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === "twitter.com" || url.hostname === "x.com") &&
      url.pathname.includes("/intent/tweet")
    );
  } catch (_error) {
    return false;
  }
}

function extractTweetText(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get("text") || "";
  } catch (_error) {
    return "";
  }
}

function parseShareTextInBackground(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const courseMatch = normalized.match(/^\s*(.+?コース)【(.+?)】\s*$/m);
  const resultMatch = normalized.match(
    /[★☆]\s*([0-9,]+)円分\s*(お得|損)\s*でした！(?:（|\()\s*速度：([0-9.]+)key\/秒、ミス：([0-9,]+)key\s*(?:）|\))/
  );
  if (!courseMatch || !resultMatch || !normalized.includes("sushida.net")) return null;

  return {
    id: createResultId(normalized),
    savedAt: new Date().toISOString(),
    course: courseMatch[1],
    difficulty: courseMatch[2],
    amountYen: Number(resultMatch[1].replace(/,/g, "")),
    resultType: resultMatch[2] === "お得" ? "profit" : "loss",
    speedKeyPerSec: Number(resultMatch[3]),
    missedKeys: Number(resultMatch[4].replace(/,/g, "")),
    shareText: normalized,
    source: "tweet-intent-webRequest"
  };
}

function createResultId(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `sushida-${(hash >>> 0).toString(16)}`;
}

function requestBodyToText(requestBody) {
  if (!requestBody) return "";
  if (requestBody.formData) {
    return new URLSearchParams(
      Object.entries(requestBody.formData).flatMap(([key, values]) =>
        values.map((value) => [key, value])
      )
    ).toString();
  }
  if (requestBody.raw && requestBody.raw.length) {
    return requestBody.raw
      .map((part) => {
        if (!part.bytes) return "";
        try {
          return new TextDecoder().decode(part.bytes);
        } catch (_error) {
          return `[bytes:${part.bytes.byteLength}]`;
        }
      })
      .join("");
  }
  return "";
}

async function saveDetectedResult(result, tab) {
  const saved = await saveResult(result);
  const settings = await getSettings();

  if (settings.autoDownloadCsv) {
    await downloadText(resultsToCsv((await chrome.storage.local.get("results")).results || []), "sushida-log.csv", "text/csv");
  }

  if (settings.autoDownloadJson !== false) {
    await downloadJson(saved, resultFileName(saved, "share"));
  }
  if (settings.autoDownloadCsv !== false) {
    const { results = [] } = await chrome.storage.local.get("results");
    await downloadText(resultsToCsv(exportableResults(collectUniqueResults([...results, saved]))), "sushida-log/sushida-results.csv", "text/csv");
  }

  await chrome.action.setBadgeText({ text: "✓" });
  await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
  return saved;
}

async function saveDebugEvent(payload) {
  const { debugEvents = [] } = await chrome.storage.local.get("debugEvents");
  await chrome.storage.local.set({
    debugEvents: [payload, ...debugEvents].slice(0, 200)
  });
}

async function saveNetworkResult(payload, tab) {
  const settings = await getSettings();
  if (!settings.autoResultNetworkRecord) {
    return null;
  }

  const parsed = parseNetworkPayload(payload);
  const now = Date.now();
  const pageUrl = (tab && tab.url) || "";
  const sessionKey = createResultId(`r.php|${Math.floor(now / NETWORK_SESSION_WINDOW_MS)}`);
  const result = {
    id: sessionKey,
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "result-network",
    pageUrl,
    parsed,
    raw: {
      requests: payload && payload.kind === "request" ? [payload] : [],
      responses: payload && payload.kind === "response" ? [payload] : [],
      events: [payload]
    }
  };

  const { networkResults = [] } = await chrome.storage.local.get("networkResults");
  const { results = [] } = await chrome.storage.local.get("results");
  const existing = [...networkResults, ...results].find((item) => {
    if (!item || item.source !== "result-network") return false;
    if (item.id === sessionKey) return true;
    const updatedAt = Date.parse(item.updatedAt || item.savedAt || "");
    return Number.isFinite(updatedAt) && Math.abs(now - updatedAt) < NETWORK_SESSION_WINDOW_MS;
  });
  const nextResult = normalizeNetworkResult(existing ? mergeNetworkResult(existing, result, payload, parsed) : result);

  await chrome.storage.local.set({
    networkResults: [nextResult, ...networkResults.filter((item) => item.id !== nextResult.id)].slice(0, 500),
    results: [nextResult, ...results.filter((item) => item.id !== nextResult.id)].slice(0, 500)
  });
  if (settings.autoDownloadJson !== false || settings.autoDownloadCsv !== false) {
    scheduleNetworkDownload(nextResult, payload);
  }
  await chrome.action.setBadgeText({ text: "✓" });
  await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
  return nextResult;
}

function scheduleNetworkDownload(result, payload) {
  const shouldDownloadNow = payload && payload.kind === "response";
  const delayMs = shouldDownloadNow ? 250 : 2500;

  if (pendingDownloadTimers.has(result.id)) {
    clearTimeout(pendingDownloadTimers.get(result.id));
  }

  const timerId = setTimeout(async () => {
    pendingDownloadTimers.delete(result.id);
    const { networkResults = [], results = [] } = await chrome.storage.local.get(["networkResults", "results"]);
    const latest =
      networkResults.find((item) => item.id === result.id) ||
      results.find((item) => item.id === result.id) ||
      result;
    const settings = await getSettings();
    if (settings.autoDownloadJson !== false) {
      await downloadJson(latest, resultFileName(latest, "network"));
    }
    if (settings.autoDownloadCsv !== false) {
      const allResults = exportableResults(collectUniqueResults([...(networkResults || []), ...(results || []), latest]));
      await downloadText(resultsToCsv(allResults), "sushida-log/sushida-results.csv", "text/csv");
    }
  }, delayMs);

  pendingDownloadTimers.set(result.id, timerId);
}

function collectUniqueResults(results) {
  const map = new Map();
  for (const result of results) {
    if (!result || !result.id) continue;
    map.set(result.id, result);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.savedAt || "") - Date.parse(b.savedAt || ""));
}

function mergeNetworkResult(existing, incoming, payload, parsed) {
  const raw = existing.raw || {};
  const requests = Array.isArray(raw.requests) ? raw.requests.slice() : [];
  const responses = Array.isArray(raw.responses) ? raw.responses.slice() : [];
  const events = Array.isArray(raw.events) ? raw.events.slice() : [];

  if (raw.kind === "request") requests.push(raw);
  if (raw.kind === "response") responses.push(raw);
  if (raw.kind) events.push(raw);

  if (payload && payload.kind === "request") requests.push(payload);
  if (payload && payload.kind === "response") responses.push(payload);
  if (payload) events.push(payload);

  return {
    ...existing,
    updatedAt: incoming.updatedAt,
    parsed: {
      ...(existing.parsed || {}),
      ...parsed
    },
    raw: {
      ...raw,
      requests: requests.slice(-10),
      responses: responses.slice(-10),
      events: events.slice(-20)
    }
  };
}

function normalizeNetworkResult(result) {
  const raw = result.raw || {};
  const requests = Array.isArray(raw.requests)
    ? raw.requests
    : raw.kind === "request"
      ? [raw]
      : [];
  const responses = Array.isArray(raw.responses)
    ? raw.responses
    : raw.kind === "response"
      ? [raw]
      : [];

  const parsed = {
    ...(result.parsed || {})
  };

  for (const request of requests) {
    Object.assign(parsed, parseNetworkPayload(request));
  }
  for (const response of responses) {
    Object.assign(parsed, parseNetworkPayload(response));
  }

  if (parsed.dat2 != null && parsed.submittedScoreYen == null) {
    const submittedScoreYen = Number(String(parsed.dat2).replace(/,/g, ""));
    if (Number.isFinite(submittedScoreYen)) parsed.submittedScoreYen = submittedScoreYen;
  }

  const responseScore = parseRankingResponse(parsed.responseText);
  Object.assign(parsed, responseScore);

  return {
    ...result,
    parsed,
    rankingScoreYen: parsed.rankingScoreYen,
    coursePriceYen: parsed.coursePriceYen,
    submittedScoreYen: parsed.submittedScoreYen,
    amountYen: parsed.amountYen,
    resultType: parsed.resultType,
    raw: {
      ...raw,
      requests,
      responses,
      events: Array.isArray(raw.events) ? raw.events : raw.kind ? [raw] : []
    }
  };
}

async function initializeStorage() {
  const current = await chrome.storage.local.get(["settings", "results", "networkResults"]);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(current.settings || {})
  };
  delete settings.autoScreenshot;
  if ((current.settings && current.settings.settingsVersion !== 2) || !current.settings) {
    settings.autoResultNetworkRecord = false;
    settings.autoDownloadJson = false;
    settings.autoDownloadCsv = true;
    settings.settingsVersion = 2;
  }
  if (current.settings && current.settings.autoDownloadJson === true && current.settings.autoDownloadCsv !== true) {
    settings.autoDownloadJson = false;
    settings.autoDownloadCsv = true;
  }

  const normalizedNetworkResults = normalizeStoredNetworkResults(
    Array.isArray(current.networkResults) ? current.networkResults : [],
    Array.isArray(current.results) ? current.results : []
  );
  const nonNetworkResults = (Array.isArray(current.results) ? current.results : []).filter(
    (result) => result && result.source !== "result-network"
  );

  await chrome.storage.local.set({
    settings,
    results: [...normalizedNetworkResults, ...nonNetworkResults].slice(0, 500),
    networkResults: normalizedNetworkResults.slice(0, 500)
  });
}

function normalizeStoredNetworkResults(networkResults, results) {
  const all = [...networkResults, ...results]
    .filter((result) => result && result.source === "result-network")
    .sort((a, b) => Date.parse(a.savedAt || "") - Date.parse(b.savedAt || ""));
  const merged = [];

  for (const item of all) {
    const normalized = normalizeNetworkResult(item);
    const itemTime = Date.parse(normalized.savedAt || normalized.updatedAt || "");
    const target = merged.find((candidate) => {
      const candidateTime = Date.parse(candidate.updatedAt || candidate.savedAt || "");
      return (
        Number.isFinite(itemTime) &&
        Number.isFinite(candidateTime) &&
        Math.abs(itemTime - candidateTime) < NETWORK_SESSION_WINDOW_MS
      );
    });

    if (target) {
      const rawEvent =
        item.raw && item.raw.kind
          ? item.raw
          : null;
      const payload =
        rawEvent ||
        (normalized.raw && normalized.raw.responses && normalized.raw.responses[0]) ||
        (normalized.raw && normalized.raw.requests && normalized.raw.requests[0]) ||
        null;
      const mergedTarget = normalizeNetworkResult(
        mergeNetworkResult(target, normalized, payload, normalized.parsed || {})
      );
      Object.assign(target, mergedTarget);
    } else {
      merged.push(normalized);
    }
  }

  return merged.sort((a, b) => Date.parse(b.updatedAt || b.savedAt || "") - Date.parse(a.updatedAt || a.savedAt || ""));
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    ...settings
  };
  delete nextSettings.autoScreenshot;
  if (settings.settingsVersion !== 2) {
    nextSettings.autoResultNetworkRecord = false;
    nextSettings.autoDownloadJson = false;
    nextSettings.autoDownloadCsv = true;
    nextSettings.settingsVersion = 2;
  }
  if (settings.autoDownloadJson === true && settings.autoDownloadCsv !== true) {
    nextSettings.autoDownloadJson = false;
    nextSettings.autoDownloadCsv = true;
  }
  await chrome.storage.local.set({ settings: nextSettings });
  return nextSettings;
}

function parseNetworkPayload(payload) {
  const candidates = [];
  if (payload && payload.url) candidates.push(urlQueryToObject(payload.url));
  if (payload && payload.body) candidates.push(formTextToObject(payload.body));
  if (payload && payload.responseText) candidates.push(parseResponseText(payload.responseText));
  return Object.assign({}, ...candidates.filter(Boolean));
}

function urlQueryToObject(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return paramsToObject(url.searchParams);
  } catch (_error) {
    return {};
  }
}

function formTextToObject(text) {
  if (!text || typeof text !== "string") return {};
  if (/^\[[A-Za-z0-9]+Array:\d+\]$/.test(text) || /^\[bytes:\d+\]$/.test(text)) {
    return { rawBody: text };
  }
  if (!text.includes("=")) {
    return { rawBody: text };
  }
  try {
    return paramsToObject(new URLSearchParams(text));
  } catch (_error) {
    return { rawBody: text };
  }
}

function parseResponseText(text) {
  if (!text || typeof text !== "string") return {};
  const ranking = parseRankingResponse(text);
  if (Object.keys(ranking).length) return { responseText: text, ...ranking };
  try {
    const json = JSON.parse(text);
    return { response: json };
  } catch (_error) {
    return { responseText: text };
  }
}

function parseRankingResponse(text) {
  if (!text || typeof text !== "string") return {};
  const rankingMatch = text.match(/^\s*([0-9]+)\s*:\s*([0-9]+)\s*$/);
  if (!rankingMatch) return {};
  return {
    rankingScoreYen: Number(rankingMatch[1]),
    coursePriceYen: Number(rankingMatch[2])
  };
}

function paramsToObject(params) {
  const object = {};
  for (const [key, value] of params.entries()) {
    object[key] = value;
  }
  return object;
}

async function saveResult(result) {
  if (!result || !result.id) {
    throw new Error("結果データが不正です。");
  }

  const { results = [] } = await chrome.storage.local.get("results");
  const nextResults = [result, ...results.filter((item) => item.id !== result.id)].slice(0, 500);
  await chrome.storage.local.set({ results: nextResults });
  return result;
}

async function downloadText(text, filename, mimeType) {
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`;
  return chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "overwrite"
  });
}

async function downloadJson(value, filename) {
  return downloadText(JSON.stringify(value, null, 2), filename, "application/json");
}

function resultFileName(result, kind) {
  const stamp = result.savedAt.replace(/[:.]/g, "-");
  return `sushida-log/${stamp}-${kind}-${result.id}.json`;
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
          const rawValue =
            result[key] == null && result.parsed && result.parsed[key] != null
              ? result.parsed[key]
              : result[key];
          const value = rawValue == null ? "" : String(rawValue);
          return `"${value.replace(/"/g, '""')}"`;
        })
        .join(",")
    )
  ].join("\n");
}

function exportableResults(results) {
  return results.filter((result) => {
    if (!result) return false;
    if (result.source !== "result-network") return true;
    const parsed = result.parsed || {};
    const raw = result.raw || {};
    const hasResponse = parsed.responseText || parsed.rankingScoreYen != null || (Array.isArray(raw.responses) && raw.responses.length > 0);
    const hasShareLikeResult = result.amountYen != null || result.speedKeyPerSec != null || result.missedKeys != null;
    return Boolean(hasResponse || hasShareLikeResult);
  });
}
