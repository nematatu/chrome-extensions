"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const {createHarness, video} = require("./harness.cjs");
const core = require("../core.js");

test("最終保存先はサブフォルダーを含む絶対パスで確認し、連番・Unicode・Windowsを扱う", () => {
  const path = "PageMedia/一覧/動画.mp4";
  for (const actual of ["/Downloads/PageMedia/一覧/動画 (1).mp4", "C:\\Downloads\\PageMedia\\一覧\\動画.mp4",
    "\\\\server\\share\\PageMedia\\一覧\\動画.mp4"]) assert.equal(core.isDownloadInFolder(actual, path), true);
  assert.equal(core.isDownloadInFolder("/Downloads/PageMedia/cafe\u0301/a.mp4", "PageMedia/café/a.mp4"), true);
  for (const actual of ["/Downloads/動画.mp4", "PageMedia/一覧/動画.mp4", "/Downloads/Other/一覧/動画.mp4",
    "/Downloads/PageMedia/別の一覧/動画.mp4", "/Downloads/PageMedia/一覧/nested/動画.mp4",
    "/Downloads/../PageMedia/一覧/動画.mp4"]) assert.equal(core.isDownloadInFolder(actual, path), false);
});

test("downloadの返り値より先のファイル名確定でも、動画・画像を同じサブフォルダーへ指定する", async () => {
  const h = createHarness({videos: [video(1), video(2, {name: "photo.jpg", mimetype: "image/jpeg"})]});
  const native = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => {
    const id = await native(options);
    const actual = h.downloads.get(id);
    actual.filename = "/Downloads/" + options.filename.split("/").at(-1);
    const suggestion = await h.determineFilename(actual);
    assert.equal(suggestion.filename, options.filename);
    assert.equal(suggestion.conflictAction, "uniquify");
    actual.filename = "/Downloads/" + suggestion.filename;
    return id;
  };
  const started = await h.send({type: "page-media-bulk:start"});
  assert.equal(started.ok, true);
  assert.equal(h.downloadCalls.length, 2);
  for (const id of [1, 2]) {h.downloads.get(id).state = "complete"; await h.emitChanged(id);}
  const result = (await h.send({type: "page-media-bulk:status"})).batch;
  assert.equal(result.summary.completed, 2);
  assert.equal(result.status, "complete");
  assert.ok([...h.downloads.values()].every(file => core.isDownloadInFolder(file.filename, "PageMedia/Test folder/file")));
});

test("Worker再起動中のファイル名確定も保存済みのキューから復元する", async () => {
  const h = createHarness({videos: [video(1)]});
  await h.send({type: "page-media-bulk:start"});
  h.resetWorkerCache();
  const suggestion = await h.determineFilename({...h.downloads.get(1), filename: "/Downloads/server-name.mp4"});
  assert.equal(suggestion.filename, "PageMedia/Test folder/video-1.mp4");
});

test("他の拡張機能・未登録の保存にはファイル名を提案しない", async () => {
  const h = createHarness({videos: [video(1)]});
  await h.send({type: "page-media-bulk:start"});
  for (const changes of [{byExtensionId: "another-extension"}, {id: 99, url: "https://cdn.videy.co/Unknown01.mp4"},
    {incognito: true}, {url: "https://cdn.videy.co/Other001.mp4"}]) {
    assert.equal(await h.determineFilename({...h.downloads.get(1), ...changes}), undefined);
  }
});

test("サブフォルダー指定が確定後に失われた実保存を成功にせず、未開始分を停止する", async () => {
  const h = createHarness();
  const started = await h.send({type: "page-media-bulk:start"});
  Object.assign(h.downloads.get(1), {state: "complete", filename: "/Downloads/video-1.mp4"});
  await h.emitChanged(1);
  const result = (await h.send({type: "page-media-bulk:status"})).batch;
  assert.equal(result.summary.completed, 0);
  assert.equal(result.items.find(item => item.id === "video-1").error, "DOWNLOAD_PATH_CHANGED");
  assert.equal(h.downloadCalls.length, 4);
  const items = h.getCachedState().batches[started.batch.id].items;
  assert.equal(items.filter(item => item.error === "DOWNLOAD_PATH_BLOCKED").length, 2);
  assert.ok(items.filter(item => item.error).every(item => !item.retryable && item.url === null));
});

test("旧版が誤って完了とした直下への保存も復元時に照合する", async () => {
  const h = createHarness({videos: [video(1)]});
  const started = await h.send({type: "page-media-bulk:start"});
  const item = h.getCachedState().batches[started.batch.id].items[0];
  Object.assign(item, {status: "complete", url: null});
  delete item.downloadPathVerified;
  Object.assign(h.downloads.get(1), {state: "complete", filename: "/Downloads/video-1.mp4"});
  await h.persistCachedState(); h.resetWorkerCache();
  const result = (await h.send({type: "page-media-bulk:status"})).batch;
  assert.equal(result.summary.completed, 0);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.items[0].error, "DOWNLOAD_PATH_CHANGED");
  assert.equal(h.downloadCalls.length, 1);
});

test("複数の復旧候補にサブフォルダー外への保存があっても完了にしない", async () => {
  const h = createHarness({videos: [video(1)]});
  const started = await h.send({type: "page-media-bulk:start"});
  const item = h.getCachedState().batches[started.batch.id].items[0];
  item.status = "starting"; item.downloadId = null;
  h.downloads.set(99, {...h.downloads.get(1), id: 99});
  await h.send({type: "page-media-bulk:status"});
  Object.assign(h.downloads.get(1), {state: "complete", filename: "/Downloads/video-1.mp4"});
  await h.emitChanged(1);
  h.downloads.get(99).state = "complete"; await h.emitChanged(99);
  assert.equal(item.status, "failed");
  assert.equal(item.error, "DOWNLOAD_PATH_CHANGED");
  assert.equal((await h.send({type: "page-media-bulk:status"})).batch.summary.completed, 0);
});
