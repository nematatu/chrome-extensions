"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const collectGofilePageVideos = require("./collector.js");

const collectorSource = fs.readFileSync(path.join(__dirname, "collector.js"), "utf8");

function file(id, overrides = {}) {
  return {
    id,
    type: "file",
    name: `${id}.mp4`,
    size: 100,
    mimetype: "video/mp4",
    link: `https://store1.gofile.io/download/web/${id}/${id}.mp4`,
    thumbnail: `https://store1.gofile.io/thumbnail/${id}.jpg`,
    ...overrides,
  };
}

function response(children, page = 1, totalPages = 1) {
  return {
    status: "ok",
    data: {
      id: "folder-id",
      type: "folder",
      name: "Test folder",
      canAccess: true,
      children,
    },
    metadata: { page, pageSize: 1000, totalPages },
  };
}

function setupCurrent(current, contentFilter = "") {
  global.location = {
    origin: "https://gofile.io",
    pathname: "/d/TestCode",
  };
  global.appdata = {
    fileManager: {
      contentFilter,
      mainContent: current,
    },
  };
}

function setupVm(current, pathname = "/d/TestCode", contentFilter = "") {
  const appdata = {
    fileManager: {
      contentFilter,
      mainContent: current,
    },
  };
  const location = {
    origin: "https://gofile.io",
    pathname,
  };
  const context = vm.createContext({
    URL,
    location,
    setTimeout,
    clearTimeout,
    __appdata: appdata,
  });

  // MAIN world のトップレベル lexical binding と同じ条件で自己完結性を確認します。
  vm.runInContext("const appdata = globalThis.__appdata;", context);
  vm.runInContext(collectorSource, context);

  return {
    appdata,
    collect: context.collectGofilePageVideos,
    context,
    location,
  };
}

test.afterEach(() => {
  delete global.location;
  delete global.appdata;
  delete global.getContent;
});

test("現在フォルダの全ページから動画だけを収集する", async () => {
  const pageOne = response({
    first: file("first"),
    generic: file("generic", { mimetype: "application/octet-stream", name: "generic.mkv" }),
    text: file("text", { mimetype: "text/plain", name: "notes.txt" }),
    frozen: file("frozen", { isFrozen: true }),
  }, 1, 2);
  setupCurrent(pageOne);

  const calls = [];
  global.getContent = async (...args) => {
    calls.push(args);
    return response({
      duplicate: file("first"),
      second: file("second", { mimetype: "video/webm", name: "second.webm" }),
      overloaded: file("overloaded", { overloaded: true }),
    }, 2, 2);
  };

  const result = await collectGofilePageVideos("https://gofile.io/d/TestCode?page=1");
  assert.equal(result.ok, true);
  assert.equal(result.folderId, "folder-id");
  assert.equal(result.pageUrl, "https://gofile.io/d/TestCode");
  assert.equal(result.folderName, "Test folder");
  assert.equal(result.totalPages, 2);
  assert.deepEqual(result.videos.map((item) => item.id), ["first", "generic", "second"]);
  assert.deepEqual(result.skipped.map((item) => [item.id, item.reason]), [
    ["frozen", "frozen"],
    ["overloaded", "overloaded"],
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["folder-id", "", 2, 1000, "createTime", -1]);
});

test("フィルター表示中はAPIから未フィルターのページを取り直す", async () => {
  setupCurrent(response({ visible: file("visible") }), "visible");
  const calls = [];
  global.getContent = async (...args) => {
    calls.push(args);
    return response({ visible: file("visible"), hidden: file("hidden") });
  };

  const result = await collectGofilePageVideos("https://gofile.io/d/TestCode");
  assert.equal(result.ok, true);
  assert.deepEqual(result.videos.map((item) => item.id), ["visible", "hidden"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["folder-id", "", 1, 1000, "createTime", -1]);
});

test("パスワード未解除・非公開ページでは処理を開始しない", async () => {
  const current = response({});
  current.data.canAccess = false;
  setupCurrent(current);
  const result = await collectGofilePageVideos("https://gofile.io/d/TestCode");
  assert.deepEqual(result, { ok: false, error: "ACCESS_REQUIRED" });
});

test("確認中にSPA遷移した場合は安全に停止する", async () => {
  setupCurrent(response({}, 1, 2));
  global.getContent = async () => {
    global.location.pathname = "/d/OtherCode";
    return response({}, 2, 2);
  };
  const result = await collectGofilePageVideos("https://gofile.io/d/TestCode");
  assert.deepEqual(result, { ok: false, error: "PAGE_CHANGED" });
});

test("Gofile内部APIが変更され、複数ページを取得できない場合はfail-closedにする", async () => {
  setupCurrent(response({ first: file("first") }, 1, 2));
  const result = await collectGofilePageVideos("https://gofile.io/d/TestCode");
  assert.deepEqual(result, { ok: false, error: "SITE_CHANGED" });
});

test("期待した共有URLと現在URLが違う場合は何も読み出さない", async () => {
  setupCurrent(response({ first: file("first") }));
  const result = await collectGofilePageVideos("https://gofile.io/d/OtherCode");
  assert.deepEqual(result, { ok: false, error: "PAGE_CHANGED" });
});

test("MAIN worldでmainContentの準備完了を有界リトライしてから収集する", async () => {
  const fixture = setupVm(null);
  setTimeout(() => {
    fixture.appdata.fileManager.mainContent = response({ delayed: file("delayed") });
  }, 20);

  const result = await fixture.collect("https://gofile.io/d/TestCode");
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.videos, (item) => item.id), ["delayed"]);
});

test("SPA遷移直後の旧mainContentはローダーが消えて安定するまで採用しない", async () => {
  const fixture = setupVm(response({ old: file("old") }));
  const loading = { hidden: false };
  fixture.context.document = {
    getElementById(id) {
      if (id === "filemanager_maincontent") return {};
      if (id === "filemanager_loading") return loading;
      return null;
    },
  };
  fixture.context.getComputedStyle = () => ({ display: loading.hidden ? "none" : "block", visibility: "visible", opacity: "1" });
  setTimeout(() => {
    fixture.appdata.fileManager.mainContent = response({ fresh: file("fresh") });
    loading.hidden = true;
  }, 20);

  const result = await fixture.collect("https://gofile.io/d/TestCode");
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.videos, (item) => item.id), ["fresh"]);
});

test("同じfolderIdのUUID URLからshort-codeへのcanonical rewriteだけを許可する", async () => {
  const loading = {
    status: "loading",
    data: {
      id: "folder-id",
      type: "folder",
    },
  };
  const fixture = setupVm(loading, "/d/folder-id");
  setTimeout(() => {
    fixture.location.pathname = "/d/ShortCode";
    fixture.appdata.fileManager.mainContent = response({ canonical: file("canonical") });
  }, 20);

  const result = await fixture.collect("https://gofile.io/d/folder-id");
  assert.equal(result.ok, true);
  assert.equal(result.folderId, "folder-id");
  assert.equal(result.pageUrl, "https://gofile.io/d/ShortCode");
  assert.deepEqual(Array.from(result.videos, (item) => item.id), ["canonical"]);
});

test("canonical rewrite中にfolderIdが変わった場合は別共有ページとして停止する", async () => {
  const loading = {
    status: "loading",
    data: {
      id: "folder-before",
      type: "folder",
    },
  };
  const fixture = setupVm(loading, "/d/OriginalCode");
  setTimeout(() => {
    fixture.location.pathname = "/d/OtherCode";
    const otherFolder = response({ wrong: file("wrong") });
    otherFolder.data.id = "folder-after";
    fixture.appdata.fileManager.mainContent = otherFolder;
  }, 20);

  const result = await fixture.collect("https://gofile.io/d/OriginalCode");
  assert.equal(result.ok, false);
  assert.equal(result.error, "PAGE_CHANGED");
});

test("注入前にcanonical rewrite済みでも旧pathnameがfolderIdなら許可する", async () => {
  const fixture = setupVm(response({ ready: file("ready") }), "/d/ShortCode");
  const result = await fixture.collect("https://gofile.io/d/folder-id");
  assert.equal(result.ok, true);
  assert.equal(result.folderId, "folder-id");
  assert.deepEqual(Array.from(result.videos, (item) => item.id), ["ready"]);
});

test("MAIN worldから返す動画メタデータをフィールド別の上限内に収める", async () => {
  const oversized = file("x".repeat(200), {
    name: `${"n".repeat(600)}.mp4`,
    mimetype: `video/${"m".repeat(250)}`,
    link: `https://store1.gofile.io/download/${"l".repeat(5000)}`,
    thumbnail: `https://store1.gofile.io/${"t".repeat(5000)}`,
  });
  setupCurrent(response({ oversized }));

  const result = await collectGofilePageVideos("https://gofile.io/d/TestCode");
  assert.equal(result.ok, true);
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].id.length, 160);
  assert.equal(result.videos[0].name.length, 512);
  assert.equal(result.videos[0].mimetype.length, 200);
  assert.equal(result.videos[0].link.length, 4096);
  assert.equal(result.videos[0].thumbnail.length, 4096);
});
