"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.resolve(__dirname, "..");

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

function video(index, overrides = {}) {
  return {
    id: `video-${index}`,
    type: "file",
    name: `video-${index}.mp4`,
    size: 100,
    mimetype: "video/mp4",
    link: `https://cdn.videy.co/Scene${String(index).padStart(5, "0")}.mp4`,
    thumbnail: `https://cdn.videy.co/Scene${String(index).padStart(5, "0")}.jpg`,
    ...overrides,
  };
}

function createHarness(discoveryOverrides = {}) {
  const runtimeOnMessage = makeEvent();
  const runtimeOnInstalled = makeEvent();
  const runtimeOnStartup = makeEvent();
  const downloadsOnChanged = makeEvent();
  const downloadsOnErased = makeEvent();
  const downloadsOnDeterminingFilename = makeEvent();
  const storageMemory = {};
  const downloads = new Map();
  const downloadCalls = [];
  const storageSetCalls = [];
  const scriptCalls = [];
  const tabMessages = [];
  const apiCalls = [];
  const hlsCalls = [], hlsJobs = new Map();
  let offscreenExists = false;
  let apiFetch = async () => { throw new Error("no synthetic API response configured"); };
  let lastSender = null;
  let nextDownloadId = 1;
  let failNextDownload = false;
  let failSearch = false;
  let storageSetFailure = null;

  const discovery = {
    ok: true,
    folderId: "folder-id",
    folderName: "Test folder",
    scannedItems: 6,
    totalPages: 1,
    videos: Array.from({ length: 6 }, (_, index) => video(index + 1)),
    skipped: [],
    ...discoveryOverrides,
  };

  const chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: runtimeOnMessage,
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
      getURL(file) { return "chrome-extension://test-extension-id/" + file; },
      async getContexts() { return offscreenExists ? [{contextType: "OFFSCREEN_DOCUMENT"}] : []; },
      async sendMessage(message) {
        hlsCalls.push(structuredClone(message));
        if (!offscreenExists) throw new Error("no synthetic offscreen document");
        if (message.action === "start") hlsJobs.set(message.token, {ok: true, present: true, phase: "collecting"});
        if (message.action === "cancel") hlsJobs.delete(message.token);
        if (message.action === "query") return hlsJobs.get(message.token) || {ok: true, present: false};
        return {ok: true};
      },
    },
    offscreen: {async createDocument() {offscreenExists = true;}},
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key) => key in storageMemory)
              .map((key) => [key, structuredClone(storageMemory[key])]),
          );
        },
        async set(values) {
          storageSetCalls.push(Object.keys(values));
          if (storageSetFailure?.(values)) {
            storageSetFailure = null;
            throw new Error("simulated storage set failure");
          }
          Object.assign(storageMemory, structuredClone(values));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageMemory[key];
        },
        async setAccessLevel() {},
      },
    },
    scripting: {
      async executeScript(options) {
        scriptCalls.push(options);
        return [{ frameId: 0, result: structuredClone({...discovery, pageUrl: discovery.pageUrl || options.args[0]}) }];
      },
    },
    downloads: {
      onChanged: downloadsOnChanged,
      onErased: downloadsOnErased,
      onDeterminingFilename: downloadsOnDeterminingFilename,
      async download(options) {
        downloadCalls.push(structuredClone(options));
        if (failNextDownload) {
          failNextDownload = false;
          throw new Error("simulated start failure");
        }
        const id = nextDownloadId++;
        downloads.set(id, {
          id,
          state: "in_progress",
          bytesReceived: 0,
          totalBytes: 100,
          danger: "safe",
          error: undefined,
          url: options.url,
          filename: `/Downloads/${options.filename}`,
          startTime: new Date().toISOString(),
          byExtensionId: "test-extension-id",
          incognito: false,
        });
        return id;
      },
      async search(query) {
        if (failSearch) throw new Error("simulated search failure");
        if (Number.isInteger(query.id)) {
          const item = downloads.get(query.id);
          return item ? [structuredClone(item)] : [];
        }
        return [...downloads.values()]
          .filter((item) => !query.url || item.url === query.url)
          .filter((item) => !query.startedAfter || Date.parse(item.startTime) >= Date.parse(query.startedAfter))
          .filter((item) => !query.startedBefore || Date.parse(item.startTime) <= Date.parse(query.startedBefore))
          .slice(0, query.limit || Infinity)
          .map((item) => structuredClone(item));
      },
      async cancel(id) {
        const item = downloads.get(id);
        if (!item) throw new Error("missing download");
        if (item.state === "complete") return;
        item.state = "interrupted";
        item.error = "USER_CANCELED";
      },
    },
    tabs: {
      async get(id) { return {...lastSender.tab, id, url: lastSender.url}; },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message: structuredClone(message) });
      },
    },
  };

  const context = vm.createContext({
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => { apiCalls.push({url, options}); return apiFetch(url, options); },
    chrome,
    console,
    crypto: { randomUUID: crypto.randomUUID },
    structuredClone,
  });
  context.globalThis = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(extensionDir, file), "utf8");
      vm.runInContext(source, context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(extensionDir, "background.js"), "utf8"), context, {
    filename: "background.js",
  });

  const sender = {
    id: chrome.runtime.id,
    frameId: 0,
    url: "https://video.twimg.news/d/10001",
    tab: { id: 42, url: "https://video.twimg.news/d/10001" },
  };

  async function send(message, customSender = sender) {
    lastSender = customSender;
    const listener = runtimeOnMessage.listeners[0];
    assert.equal(typeof listener, "function");
    return new Promise((resolve) => {
      const keepAlive = listener(message, customSender, resolve);
      assert.equal(keepAlive, true);
    });
  }

  async function emitChanged(id, state = downloads.get(id)?.state) {
    const messageCount = tabMessages.length;
    for (const listener of downloadsOnChanged.listeners) listener({ id, state: { current: state } });
    await waitFor(() => tabMessages.length > messageCount);
  }

  async function emitErased(id) {
    const messageCount = tabMessages.length;
    for (const listener of downloadsOnErased.listeners) listener(id);
    await waitFor(() => tabMessages.length > messageCount);
  }

  return {
    chrome,
    discovery,
    downloadCalls,
    downloads,
    async determineFilename(download) {
      assert.equal(downloadsOnDeterminingFilename.listeners.length, 1);
      let calls = 0;
      return new Promise(resolve => {
        const keepAlive = downloadsOnDeterminingFilename.listeners[0](structuredClone(download), suggestion => {
          assert.equal(++calls, 1, "suggest must be called exactly once");
          resolve(suggestion);
        });
        if (calls === 0) assert.equal(keepAlive, true);
      });
    },
    emitChanged,
    emitErased,
    scriptCalls,
    apiCalls,
    hlsCalls,
    hlsJobs,
    sendHls(message, customSender) {
      return send({type: "page-media-bulk:hls-update", ...message}, customSender || {
        id: chrome.runtime.id, url: chrome.runtime.getURL("offscreen.html"),
      });
    },
    loseOffscreen() {offscreenExists = false; hlsJobs.clear();},
    setApiFetch(handler) { apiFetch = handler; },
    send,
    sender,
    getCachedState() {
      return vm.runInContext("stateCache", context);
    },
    setFailNextDownload(value) {
      failNextDownload = value;
    },
    setSearchFailure(value) {
      failSearch = value;
    },
    setStorageSetFailure(predicate) {
      storageSetFailure = predicate;
    },
    resetWorkerCache() {
      vm.runInContext(
        "stateCache = null; persistedBatchIds = new Set(); persistedCounts = new Map(); persistedSignatures = new Map();",
        context,
      );
    },
    async persistCachedState() {
      await vm.runInContext("writeState(stateCache)", context);
    },
    storageMemory,
    storageSetCalls,
    tabMessages,
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not met in time");
}


module.exports = {createHarness, video, waitFor};
