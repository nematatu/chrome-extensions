"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {createHarness, video} = require("./harness.cjs");

function legacyItem(index, overrides = {}) {
  const item = video(index);
  return {id: "item-" + index, name: item.name, kind: "video", url: item.link,
    status: "queued", downloadId: null, startedAt: null, bytesReceived: 0,
    totalBytes: 100, error: null, retryable: true, ...overrides};
}

function legacyBatch(h, items, overrides = {}) {
  h.storageMemory.pageMediaBatchV1 = {id: "old-queue", folder: "ExistingFolder",
    source: "video.twimg.news", cancelRequested: false, items, ...overrides};
}

async function nativeDownload(h, index, overrides = {}) {
  const id = await h.chrome.downloads.download({url: video(index).link,
    filename: "PageMedia/ExistingFolder/" + video(index).name});
  Object.assign(h.downloads.get(id), overrides);
  return id;
}

test("旧版の開始済み保存を引き継ぎ、未開始分だけを開始する", async () => {
  const h = createHarness({videos: [video(1), video(2)]});
  const id = await nativeDownload(h, 1, {bytesReceived: 25});
  legacyBatch(h, [legacyItem(1, {status: "downloading", downloadId: id}), legacyItem(2)]);
  const result = await h.send({type: "page-media-bulk:start"});
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.batch.folderName, "ExistingFolder");
  assert.equal(result.batch.summary.downloading, 2);
  assert.equal(h.downloadCalls.length, 2);
  assert.equal(h.storageMemory.pageMediaBatchV1, undefined);
  assert.equal(h.getCachedState().batches[result.batch.id].items[0].downloadId, id);
  h.resetWorkerCache();
  const restored = await h.send({type: "page-media-bulk:status"});
  assert.equal(restored.batch.id, result.batch.id);
  assert.equal(restored.batch.summary.bytesReceived, 25);
  assert.equal(h.downloadCalls.length, 2);
});

test("旧版の保存IDが未記録でも、開始日時とURLを照合して重複保存を防ぐ", async () => {
  const h = createHarness({videos: [video(1)]});
  const id = await nativeDownload(h, 1);
  legacyBatch(h, [legacyItem(1, {status: "starting", startedAt: Date.now()})]);
  const result = await h.send({type: "page-media-bulk:start"});
  assert.equal(result.ok, true);
  assert.equal(h.getCachedState().batches[result.batch.id].items[0].downloadId, id);
  assert.equal(h.downloadCalls.length, 1);
});

test("旧版のキャンセル意思を保持し、待機中の保存を新たに開始しない", async () => {
  const h = createHarness({videos: [video(1), video(2)]});
  const id = await nativeDownload(h, 1);
  legacyBatch(h, [legacyItem(1, {status: "downloading", downloadId: id}), legacyItem(2)],
    {cancelRequested: true});
  const result = await h.send({type: "page-media-bulk:start"});
  assert.equal(result.ok, true);
  assert.equal(result.batch.summary.canceled, 2);
  assert.equal(result.batch.cancelRequested, false);
  assert.equal(h.downloadCalls.length, 1);
  assert.equal(h.downloads.get(id).error, "USER_CANCELED");
  assert.ok(h.getCachedState().batches[result.batch.id].items.every(item => item.url === null));
  h.resetWorkerCache();
  const restored = await h.send({type: "page-media-bulk:status"});
  assert.equal(restored.batch.summary.canceled, 2);
});

test("元ページを照合できない旧版キューは変更・開始しない", async () => {
  for (const overrides of [{source: "other.example.test"},
    {items: [legacyItem(2)]}, {items: [legacyItem(1, {url: "https://other.example.test/media.mp4"})]}]) {
    const h = createHarness({videos: [video(1)]});
    legacyBatch(h, [legacyItem(1)], overrides);
    const original = structuredClone(h.storageMemory.pageMediaBatchV1);
    const result = await h.send({type: "page-media-bulk:start"});
    assert.equal(result.error, "LEGACY_QUEUE");
    assert.equal(h.downloadCalls.length, 0);
    assert.deepEqual(h.storageMemory.pageMediaBatchV1, original);
  }
});

test("新版レコードの保存が失敗しても旧版キューを残し、次の操作で復旧する", async () => {
  const h = createHarness({videos: [video(1)]});
  await h.send({type: "page-media-bulk:status"});
  legacyBatch(h, [legacyItem(1)]);
  h.setStorageSetFailure(values => "pageMediaBulkDownloadIndexV2" in values);
  const failed = await h.send({type: "page-media-bulk:start"});
  assert.equal(failed.ok, false);
  assert.ok(h.storageMemory.pageMediaBatchV1);
  assert.equal(h.downloadCalls.length, 0);
  const recovered = await h.send({type: "page-media-bulk:start"});
  assert.equal(recovered.ok, true);
  assert.equal(h.storageMemory.pageMediaBatchV1, undefined);
  assert.equal(h.downloadCalls.length, 1);
});

test("引き継ぎ時点で完了していた保存を永続化し、再起動後も再保存しない", async () => {
  const h = createHarness({videos: [video(1)]});
  const id = await nativeDownload(h, 1, {state: "complete", bytesReceived: 100, mime: "video/mp4"});
  legacyBatch(h, [legacyItem(1, {status: "downloading", downloadId: id})]);
  const result = await h.send({type: "page-media-bulk:start"});
  assert.equal(result.batch.status, "complete");
  h.resetWorkerCache();
  const restored = await h.send({type: "page-media-bulk:status"});
  assert.equal(restored.batch.summary.completed, 1);
  assert.equal(h.downloadCalls.length, 1);
  assert.equal(h.getCachedState().batches[result.batch.id].items[0].url, null);
});
