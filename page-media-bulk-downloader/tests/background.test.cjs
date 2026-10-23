"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const {createHarness, video, waitFor} = require("./harness.cjs");

test("1クリックで全件を登録し、4本ずつ安全に開始する", async () => {
  const harness = createHarness({
    videos: [
      video(1, { name: "../CON?.mp4" }),
      video(2),
      video(3),
      video(4),
      video(5),
      video(6),
      video(7, { link: "https://evil.example/download/video.mp4" }),
    ],
  });

  const response = await harness.send({ type: "page-media-bulk:start" });
  assert.equal(response.ok, true);
  assert.equal(response.batch.summary.total, 6);
  assert.equal(response.batch.skippedCount, 1);
  assert.equal(response.batch.summary.downloading, 4);
  assert.equal(response.batch.summary.queued, 2);
  assert.equal(harness.downloadCalls.length, 4);
  assert.equal(harness.scriptCalls.length, 1);
  assert.equal(harness.scriptCalls[0].world, "ISOLATED");
  assert.equal(harness.scriptCalls[0].target.tabId, 42);
  assert.deepEqual([...harness.scriptCalls[0].target.frameIds], [0]);

  const firstOptions = harness.downloadCalls[0];
  assert.equal(firstOptions.conflictAction, "uniquify");
  assert.equal(firstOptions.saveAs, false);
  assert.equal(firstOptions.filename, "PageMedia/Test folder/.._CON_.mp4");
  assert.ok(firstOptions.url.startsWith("https://cdn.videy.co/"));

  harness.downloads.set(1, {
    ...harness.downloads.get(1),
    state: "complete",
    bytesReceived: 100,
  });
  await harness.emitChanged(1);
  await waitFor(() => harness.downloadCalls.length === 5);

  const status = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(status.ok, true);
  assert.equal(status.batch.summary.completed, 1);
  assert.equal(status.batch.summary.downloading, 4);
  assert.equal(status.batch.summary.queued, 1);
  assert.equal("url" in status.batch.items[0], false);
});

test("動画と画像を同じ保存キューでサブフォルダへ保存し、非メディアは除外する", async () => {
  const harness = createHarness({ videos: [
    video(1),
    video(2, { name: "photo.JPG", mimetype: "image/jpeg" }),
    video(3, { name: "notes.txt", mimetype: "text/plain" }),
  ] });
  const result = await harness.send({ type: "page-media-bulk:start" });
  assert.equal(result.ok, true);
  assert.equal(result.batch.summary.total, 2);
  assert.equal(result.batch.skippedCount, 1);
  assert.deepEqual(harness.downloadCalls.map(call => call.filename), ["PageMedia/Test folder/video-1.mp4", "PageMedia/Test folder/photo.JPG"]);
  assert.ok(harness.downloadCalls.every(call => call.saveAs === false && call.conflictAction === "uniquify"));
});

test("非対応ページやサブフレームからの開始要求を拒否する", async () => {
  const harness = createHarness();
  const evilSender = {
    frameId: 0,
    url: "https://video.twimg.news.evil.example/d/10001",
    tab: { id: 9, url: "https://video.twimg.news.evil.example/d/10001" },
  };
  const evil = await harness.send({ type: "page-media-bulk:start" }, evilSender);
  assert.equal(evil.ok, false);
  assert.equal(evil.error, "UNTRUSTED_PAGE");

  const subframe = await harness.send(
    { type: "page-media-bulk:start" },
    { ...harness.sender, frameId: 3 },
  );
  assert.equal(subframe.ok, false);
  assert.equal(subframe.error, "UNTRUSTED_PAGE");
  assert.equal(harness.scriptCalls.length, 0);
  assert.equal(harness.downloadCalls.length, 0);
});

test("実行中バッチの残りをキャンセルしても完了済みファイルを削除しない", async () => {
  const harness = createHarness({ videos: [video(1), video(2), video(3), video(4), video(5)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const response = await harness.send({ type: "page-media-bulk:cancel", batchId: started.batch.id });
  assert.equal(response.ok, true);
  assert.equal(response.batch.summary.canceled, 5);
  assert.equal(response.batch.status, "completed_with_errors");
  assert.equal(typeof harness.chrome.downloads.removeFile, "undefined");
  assert.equal(typeof harness.chrome.downloads.erase, "undefined");
});

test("復元した待機キューの古い保存先を使わず、サブフォルダー内へ保存する", async () => {
  for (const storedFilename of ["video-5.mp4", "../video-5.mp4", "/Downloads/video-5.mp4"]) {
    const harness = createHarness();
    const started = await harness.send({type: "page-media-bulk:start"});
    const batch = harness.getCachedState().batches[started.batch.id];
    batch.items[4].filename = storedFilename;
    await harness.persistCachedState();
    harness.resetWorkerCache();
    Object.assign(harness.downloads.get(1), {state: "complete", bytesReceived: 100});
    const restored = await harness.send({type: "page-media-bulk:status"});
    assert.equal(restored.ok, true);
    assert.equal(harness.downloadCalls.length, 5);
    assert.equal(harness.downloadCalls[4].filename, "PageMedia/Test folder/video-5.mp4");
    assert.equal(harness.downloadCalls[4].saveAs, false);
    assert.equal(harness.getCachedState().batches[started.batch.id].items[4].filename,
      "PageMedia/Test folder/video-5.mp4");
  }
});

test("失敗分の再試行もサブフォルダー内へ保存する", async () => {
  const harness = createHarness({videos: [video(1)]});
  harness.setFailNextDownload(true);
  const started = await harness.send({type: "page-media-bulk:start"});
  harness.getCachedState().batches[started.batch.id].items[0].filename = "video-1.mp4";
  await harness.persistCachedState();
  harness.resetWorkerCache();
  const retried = await harness.send({type: "page-media-bulk:retry", batchId: started.batch.id});
  assert.equal(retried.ok, true);
  assert.equal(harness.downloadCalls.length, 2);
  assert.equal(harness.downloadCalls[1].filename, "PageMedia/Test folder/video-1.mp4");
  assert.equal(harness.downloadCalls[1].saveAs, false);
});

test("開始失敗した動画だけを再試行できる", async () => {
  const harness = createHarness({ videos: [video(1)] });
  harness.setFailNextDownload(true);
  const started = await harness.send({ type: "page-media-bulk:start" });
  assert.equal(started.batch.status, "completed_with_errors");
  assert.equal(started.batch.summary.failed, 1);

  const retried = await harness.send({ type: "page-media-bulk:retry", batchId: started.batch.id });
  assert.equal(retried.ok, true);
  assert.equal(retried.batch.status, "active");
  assert.equal(retried.batch.summary.downloading, 1);
  assert.equal(harness.downloadCalls.length, 2);
});

test("同じタブでの二重開始は既存バッチを再利用する", async () => {
  const harness = createHarness({ videos: [video(1), video(2)] });
  const first = await harness.send({ type: "page-media-bulk:start" });
  const second = await harness.send({ type: "page-media-bulk:start" });
  assert.equal(first.batch.id, second.batch.id);
  assert.equal(second.reused, true);
  assert.equal(harness.scriptCalls.length, 1);
  assert.equal(harness.downloadCalls.length, 2);
});

test("同じ共有URLを開いた別タブが状態確認しても元タブから操作できる", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const first = await harness.send({ type: "page-media-bulk:start" });
  const secondTab = {
    ...harness.sender,
    tab: { ...harness.sender.tab, id: 84 },
  };

  const viewed = await harness.send({ type: "page-media-bulk:status" }, secondTab);
  assert.equal(viewed.ok, true);
  assert.equal(viewed.batch.id, first.batch.id);

  const canceled = await harness.send({ type: "page-media-bulk:cancel", batchId: first.batch.id });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.batch.summary.canceled, 1);
});

test("同じタブで別の共有ページへ移動した場合は別バッチを開始する", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const first = await harness.send({ type: "page-media-bulk:start" });
  const nextPageSender = {
    id: harness.sender.id,
    frameId: 0,
    url: "https://video.twimg.news/d/10002",
    tab: { id: 42, url: "https://video.twimg.news/d/10002" },
  };

  const second = await harness.send({ type: "page-media-bulk:start" }, nextPageSender);
  assert.equal(second.ok, true);
  assert.notEqual(second.batch.id, first.batch.id);
  assert.equal(second.reused, false);
  assert.equal(harness.scriptCalls.length, 2);
});

test("開始IDの保存直前に停止しても既存ダウンロードへ再接続し、消えたIDだけ枠を解放する", async () => {
  const harness = createHarness({ videos: [video(1), video(2), video(3), video(4), video(5), video(6)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const state = harness.getCachedState();
  const batch = state.batches[started.batch.id];

  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  harness.downloads.delete(batch.items[1].downloadId);

  const status = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(status.ok, true);
  assert.equal(status.batch.summary.failed, 1);
  assert.equal(status.batch.summary.downloading, 4);
  assert.equal(status.batch.summary.queued, 1);
  assert.equal(harness.downloadCalls.length, 5);
  assert.equal(batch.items[0].downloadId, 1);
});

test("キャンセルと完了が競合した場合は完了を優先する", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  harness.downloads.set(1, {
    ...harness.downloads.get(1),
    state: "complete",
    bytesReceived: 100,
  });

  const canceled = await harness.send({ type: "page-media-bulk:cancel", batchId: started.batch.id });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.batch.status, "complete");
  assert.equal(canceled.batch.summary.completed, 1);
  assert.equal(canceled.batch.summary.canceled, 0);
});

test("複数ページを同時に開始しても拡張全体で4本までに制限する", async () => {
  const harness = createHarness({ videos: Array.from({ length: 6 }, (_, index) => video(index + 1)) });
  await harness.send({ type: "page-media-bulk:start" });
  const nextPageSender = {
    id: harness.sender.id,
    frameId: 0,
    url: "https://video.twimg.news/d/10003",
    tab: { id: 84, url: "https://video.twimg.news/d/10003" },
  };
  const second = await harness.send({ type: "page-media-bulk:start" }, nextPageSender);
  assert.equal(harness.downloadCalls.length, 4);
  assert.equal(second.batch.summary.downloading, 0);
  assert.equal(second.batch.summary.queued, 6);

  harness.downloads.set(1, { ...harness.downloads.get(1), state: "complete", bytesReceived: 100 });
  await harness.emitChanged(1);
  await waitFor(() => harness.downloadCalls.length === 5);
  assert.equal(harness.downloadCalls[4].url, video(1).link);
});

test("大規模一覧は全件を分割保存し、UIへは優先100件だけ返す", async () => {
  const harness = createHarness({ videos: Array.from({ length: 150 }, (_, index) => video(index + 1)) });
  const started = await harness.send({ type: "page-media-bulk:start" });

  assert.equal(started.ok, true);
  assert.equal(started.batch.summary.total, 150);
  assert.equal(started.batch.itemCount, 150);
  assert.equal(started.batch.items.length, 100);
  assert.equal(started.batch.omittedCount, 50);
  assert.equal(
    Object.keys(harness.storageMemory).filter((key) => key.startsWith("pageMediaBulkDownloadV2:item:")).length,
    150,
  );
  assert.equal("pageMediaBulkDownloadStateV1" in harness.storageMemory, false);
});

test("上限10,000本を全件キュー化し、初動を4本に保つ", async () => {
  const harness = createHarness({ videos: Array.from({ length: 10000 }, (_, index) => video(index + 1)) });
  const started = await harness.send({ type: "page-media-bulk:start" });

  assert.equal(started.ok, true);
  assert.equal(started.batch.summary.total, 10000);
  assert.equal(started.batch.summary.downloading, 4);
  assert.equal(started.batch.summary.queued, 9996);
  assert.equal(started.batch.items.length, 100);
  assert.equal(started.batch.omittedCount, 9900);
  assert.equal(harness.downloadCalls.length, 4);
  assert.equal(
    Object.keys(harness.storageMemory).filter((key) => key.startsWith("pageMediaBulkDownloadV2:item:")).length,
    10000,
  );
});

test("Service Workerのメモリ消失後も分割レコードからキューを復元する", async () => {
  const harness = createHarness({ videos: [video(1), video(2)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  harness.resetWorkerCache();

  const status = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(status.ok, true);
  assert.equal(status.batch.id, started.batch.id);
  assert.equal(status.batch.summary.downloading, 2);
});

test("downloads.searchの一時失敗を履歴消失と誤判定しない", async () => {
  const harness = createHarness({ videos: [video(1), video(2), video(3), video(4), video(5)] });
  await harness.send({ type: "page-media-bulk:start" });
  harness.setSearchFailure(true);

  const status = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(status.ok, true);
  assert.equal(status.batch.summary.downloading, 4);
  assert.equal(status.batch.summary.failed, 0);
  assert.equal(harness.downloadCalls.length, 4);
});

test("search失敗中は保存先不明の完了通知を成功にせず、照合復旧後にキューを進める", async () => {
  const harness = createHarness({ videos: [video(1), video(2), video(3), video(4), video(5)] });
  await harness.send({ type: "page-media-bulk:start" });
  harness.setSearchFailure(true);

  harness.downloads.set(1, { ...harness.downloads.get(1), state: "complete", bytesReceived: 100 });
  await harness.emitChanged(1);
  assert.equal(harness.downloadCalls.length, 4);
  assert.equal(Object.values(harness.getCachedState().batches)[0].items[0].status, "downloading");
  harness.setSearchFailure(false);
  await harness.send({type: "page-media-bulk:status"});
  await waitFor(() => harness.downloadCalls.length === 5);
  for (const id of [2, 3, 4, 5]) {
    harness.downloads.set(id, { ...harness.downloads.get(id), state: "complete", bytesReceived: 100 });
    await harness.emitChanged(id);
  }
  await waitFor(() => harness.getCachedState() && Object.values(harness.getCachedState().batches)[0]?.status === "complete");

  const batch = Object.values(harness.getCachedState().batches)[0];
  assert.equal(batch.items.filter((item) => item.status === "complete").length, 5);
  assert.equal(harness.downloadCalls.length, 5);
});

test("復旧候補が複数ある場合は新規開始せず、キャンセル時に候補をすべて止める", async () => {
  const harness = createHarness({ videos: [video(1), video(2), video(3), video(4), video(5)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const state = harness.getCachedState();
  const batch = state.batches[started.batch.id];
  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  harness.downloads.set(99, { ...harness.downloads.get(1), id: 99 });

  const status = await harness.send({ type: "page-media-bulk:status" });
  const ambiguous = status.batch.items.find((item) => item.id === "video-1");
  assert.equal(ambiguous.error, "START_STATE_AMBIGUOUS");
  assert.equal(ambiguous.retryable, false);
  assert.equal(harness.downloadCalls.length, 4);

  const canceled = await harness.send({ type: "page-media-bulk:cancel", batchId: started.batch.id });
  assert.equal(canceled.ok, true);
  assert.equal(harness.downloads.get(1).error, "USER_CANCELED");
  assert.equal(harness.downloads.get(99).error, "USER_CANCELED");
});

test("複数の復旧候補がタブを閉じた後に完了してもonChangedだけで収束する", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  harness.downloads.set(99, { ...harness.downloads.get(1), id: 99 });

  await harness.send({ type: "page-media-bulk:status" });
  assert.deepEqual([...batch.items[0].ambiguousDownloadIds], [1, 99]);

  harness.downloads.set(1, { ...harness.downloads.get(1), state: "complete", bytesReceived: 100 });
  await harness.emitChanged(1);
  assert.equal(batch.items[0].status, "starting");

  harness.downloads.set(99, { ...harness.downloads.get(99), state: "complete", bytesReceived: 100 });
  await harness.emitChanged(99);
  assert.equal(batch.items[0].status, "complete");
  assert.equal(batch.status, "complete");
  assert.deepEqual([...batch.items[0].ambiguousDownloadIds], []);
});

test("複数候補の終端通知を失わず、search復旧後の保存先照合で収束する", async () => {
  const harness = createHarness({ videos: [video(1), video(2), video(3), video(4), video(5)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  harness.downloads.set(99, { ...harness.downloads.get(1), id: 99 });

  await harness.send({ type: "page-media-bulk:status" });
  harness.setSearchFailure(true);
  harness.downloads.set(1, { ...harness.downloads.get(1), state: "complete", bytesReceived: 100 });
  await harness.emitChanged(1);
  assert.equal(batch.items[0].status, "starting");
  assert.equal(harness.downloadCalls.length, 4);

  harness.downloads.set(99, { ...harness.downloads.get(99), state: "complete", bytesReceived: 100 });
  await harness.emitChanged(99);
  assert.equal(batch.items[0].status, "starting");
  assert.equal(harness.downloadCalls.length, 4);
  harness.setSearchFailure(false);
  await harness.send({type: "page-media-bulk:status"});

  assert.equal(batch.items[0].status, "complete");
  assert.equal(batch.status, "active");
  assert.equal(harness.downloadCalls.length, 5);
  assert.deepEqual([...batch.items[0].ambiguousDownloadIds], []);
  assert.deepEqual([...batch.items[0].ambiguousTerminalDownloads], []);
});

test("複数候補の終端通知がsearch結果より先行しても通知済み状態を失わない", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  harness.downloads.set(99, { ...harness.downloads.get(1), id: 99 });
  await harness.send({ type: "page-media-bulk:status" });

  // onChanged直後のdownloads.searchがまだin_progressを返す状況を再現します。
  await harness.emitChanged(1, "complete");
  assert.equal(batch.items[0].status, "starting");
  assert.equal(
    JSON.stringify(batch.items[0].ambiguousTerminalDownloads.map((entry) => [entry.id, entry.state])),
    JSON.stringify([[1, "complete"]]),
  );
  harness.downloads.set(1, { ...harness.downloads.get(1), state: "complete", bytesReceived: 100 });

  await harness.emitChanged(99, "complete");
  harness.downloads.set(99, { ...harness.downloads.get(99), state: "complete", bytesReceived: 100 });
  assert.equal(batch.items[0].status, "complete");
  assert.equal(batch.status, "complete");
});

test("複数の復旧候補の一方が履歴から消えてもonErasedだけで残りへ接続する", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  harness.downloads.set(99, { ...harness.downloads.get(1), id: 99 });

  await harness.send({ type: "page-media-bulk:status" });
  harness.downloads.delete(99);
  await harness.emitErased(99);

  assert.equal(batch.items[0].status, "downloading");
  assert.equal(batch.items[0].downloadId, 1);
  assert.deepEqual([...batch.items[0].ambiguousDownloadIds], []);
});

test("復旧候補が複数でも完了済みが1件あれば保存完了を優先する", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  harness.downloads.set(1, { ...harness.downloads.get(1), state: "interrupted", error: "NETWORK_FAILED" });
  harness.downloads.set(99, { ...harness.downloads.get(1), id: 99, state: "complete", error: undefined, bytesReceived: 100 });

  const status = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(status.batch.status, "complete");
  assert.equal(status.batch.summary.completed, 1);
  assert.equal(status.batch.summary.failed, 0);
});

test("今回の開始時刻より古い同一URL履歴へfilename一致だけで誤接続しない", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  const current = harness.downloads.get(1);
  batch.items[0].status = "starting";
  batch.items[0].downloadId = null;
  current.filename = "/Downloads/PageMedia/Test folder/video-1 (1).mp4";
  harness.downloads.set(99, {
    ...current,
    id: 99,
    state: "complete",
    bytesReceived: 100,
    filename: "/Downloads/PageMedia/Test folder/video-1.mp4",
    startTime: new Date(batch.items[0].startingAt - 30000).toISOString(),
  });

  const status = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(status.batch.summary.downloading, 1);
  assert.equal(status.batch.summary.completed, 0);
  assert.equal(batch.items[0].downloadId, 1);
});

test("大量キャンセルの途中でstorage書込が失敗してもtombstoneから完遂し、新規開始しない", async () => {
  const harness = createHarness({ videos: Array.from({ length: 500 }, (_, index) => video(index + 1)) });
  const started = await harness.send({ type: "page-media-bulk:start" });
  harness.setStorageSetFailure((values) =>
    Object.keys(values).some((key) => key.startsWith("pageMediaBulkDownloadV2:item:") && key.endsWith(":250")),
  );

  const failedCancel = await harness.send({ type: "page-media-bulk:cancel", batchId: started.batch.id });
  assert.equal(failedCancel.ok, false);
  assert.equal(failedCancel.error, "INTERNAL_ERROR");
  assert.equal(harness.downloadCalls.length, 4);

  harness.resetWorkerCache();
  const recovered = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.batch.summary.canceled, 500);
  assert.equal(recovered.batch.summary.queued, 0);
  assert.equal(recovered.batch.summary.downloading, 0);
  assert.equal(harness.downloadCalls.length, 4);
});

test("キャンセル後のsearch一時失敗中は再試行させず、照合復旧後にキャンセル確定する", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  harness.setSearchFailure(true);

  const pending = await harness.send({ type: "page-media-bulk:cancel", batchId: started.batch.id });
  assert.equal(pending.ok, true);
  assert.equal(pending.batch.cancelRequested, true);
  assert.equal(pending.batch.summary.downloading, 1);
  assert.equal(pending.batch.summary.retryableFailures, 0);

  // interrupted deltaにerrorが含まれない場合も、search照合前にcancel intentを解除しません。
  await harness.emitChanged(1);
  const stillPending = harness.getCachedState().batches[started.batch.id];
  assert.equal(stillPending.cancelRequested, true);
  assert.equal(stillPending.items[0].retryable, false);

  const retry = await harness.send({ type: "page-media-bulk:retry", batchId: started.batch.id });
  assert.equal(retry.ok, false);
  assert.equal(retry.error, "BATCH_ACTIVE");
  harness.setSearchFailure(false);

  const completed = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(completed.batch.cancelRequested, false);
  assert.equal(completed.batch.summary.canceled, 1);
  assert.equal(harness.downloadCalls.length, 1);
});

test("cancel intent中に既に失敗していた項目はURLを破棄して再試行不可にする", async () => {
  const harness = createHarness({ videos: [video(1)] });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  batch.items[0].status = "interrupted";
  batch.items[0].error = "NETWORK_FAILED";
  batch.items[0].retryable = true;

  const canceled = await harness.send({ type: "page-media-bulk:cancel", batchId: started.batch.id });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.batch.cancelRequested, false);
  assert.equal(canceled.batch.summary.failed, 1);
  assert.equal(canceled.batch.summary.retryableFailures, 0);
  assert.equal(batch.items[0].url, null);
  assert.equal(batch.items[0].retryable, false);

  const retried = await harness.send({ type: "page-media-bulk:retry", batchId: started.batch.id });
  assert.equal(retried.ok, false);
  assert.equal(retried.error, "NOTHING_TO_RETRY");
  assert.equal(harness.downloadCalls.length, 1);
});

test("index確定失敗で残った新規batchレコードをpending journalから消去する", async () => {
  const harness = createHarness({ videos: [video(1)] });
  await harness.send({ type: "page-media-bulk:status" });
  harness.setStorageSetFailure((values) => "pageMediaBulkDownloadIndexV2" in values);

  const failedStart = await harness.send({ type: "page-media-bulk:start" });
  assert.equal(failedStart.ok, false);
  assert.equal(failedStart.error, "INTERNAL_ERROR");
  assert.equal(harness.downloadCalls.length, 0);
  assert.equal("pageMediaBulkDownloadPendingV2" in harness.storageMemory, true);
  assert.equal(Object.keys(harness.storageMemory).some((key) => key.startsWith("pageMediaBulkDownloadV2:item:")), true);

  harness.resetWorkerCache();
  const status = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(status.ok, true);
  assert.equal(status.batch, null);
  assert.equal("pageMediaBulkDownloadPendingV2" in harness.storageMemory, false);
  assert.equal(Object.keys(harness.storageMemory).some((key) => key.startsWith("pageMediaBulkDownloadV2:")), false);
});

test("大量再試行の途中でstorage書込が失敗してもintentから全件を復元してから開始する", async () => {
  const harness = createHarness({ videos: Array.from({ length: 500 }, (_, index) => video(index + 1)) });
  const started = await harness.send({ type: "page-media-bulk:start" });
  const batch = harness.getCachedState().batches[started.batch.id];
  for (const item of batch.items) {
    item.status = "failed";
    item.downloadId = null;
    item.error = "START_FAILED";
    item.retryable = true;
  }
  batch.status = "completed_with_errors";
  harness.downloads.clear();
  await harness.persistCachedState();
  harness.setStorageSetFailure((values) =>
    Object.keys(values).some((key) => key.startsWith("pageMediaBulkDownloadV2:item:") && key.endsWith(":250")),
  );

  const failedRetry = await harness.send({ type: "page-media-bulk:retry", batchId: started.batch.id });
  assert.equal(failedRetry.ok, false);
  assert.equal(failedRetry.error, "INTERNAL_ERROR");
  assert.equal(harness.downloadCalls.length, 4);

  harness.resetWorkerCache();
  const recovered = await harness.send({ type: "page-media-bulk:status" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.batch.retryRequested, false);
  assert.equal(recovered.batch.summary.downloading, 4);
  assert.equal(recovered.batch.summary.queued, 496);
  assert.equal(recovered.batch.summary.failed, 0);
  assert.equal(harness.downloadCalls.length, 8);
});
