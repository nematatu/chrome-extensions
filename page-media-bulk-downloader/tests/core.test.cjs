"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("動画MIMEを優先し、汎用MIMEでは既知拡張子を補助判定する", () => {
  assert.equal(core.isVideoItem({ type: "file", mimetype: "video/mp4", name: "clip.bin" }), true);
  assert.equal(core.isVideoItem({ type: "file", mimetype: "application/octet-stream", name: "clip.MKV" }), true);
  assert.equal(core.isVideoItem({ type: "file", mimetype: "application/zip", name: "clip.mp4" }), false);
  assert.equal(core.isVideoItem({ type: "folder", mimetype: "video/mp4", name: "folder" }), false);
});

test("画像も対象とし、画像・動画の拡張子に偽装した他形式を除外する", () => {
  assert.equal(core.isMediaItem({ type: "file", mimetype: "image/jpeg", name: "photo.bin" }), true);
  assert.equal(core.isMediaItem({ type: "file", mimetype: "application/octet-stream", name: "photo.JPG" }), true);
  assert.equal(core.isMediaItem({ type: "file", mimetype: "", name: "photo.HEIC" }), true);
  assert.equal(core.isMediaItem({ type: "file", mimetype: "application/zip", name: "photo.jpg" }), false);
  assert.equal(core.isMediaItem({ type: "file", mimetype: "audio/mpeg", name: "track.mp3" }), false);
  assert.equal(core.isMediaItem({ type: "folder", mimetype: "image/png", name: "folder.png" }), false);
  const image = { id: "image", type: "file", name: "photo.JPG", mimetype: "image/jpeg", link: "https://cdn.videy.co/Scene0001.mp4", size: 42 };
  assert.equal(core.normalizeVideos([image, { ...image, id: "unsafe", link: "https://evil.example/photo.jpg" }]).length, 1);
});

test("危険なパス文字、予約名、双方向制御文字を安全化する", () => {
  assert.equal(core.sanitizePathSegment("../movie?.mp4"), ".._movie_.mp4");
  assert.equal(core.sanitizePathSegment("CON.mp4"), "_CON.mp4");
  assert.equal(core.sanitizePathSegment("name.   "), "name");
  assert.equal(core.sanitizePathSegment("\u202Eevil.mp4"), "evil.mp4");
  assert.equal(core.sanitizePathSegment("..", "fallback.mp4"), "fallback.mp4");
});

test("UTF-8長を制限し、可能なら拡張子を保持する", () => {
  const result = core.sanitizePathSegment(`${"動画".repeat(150)}.mp4`, "video.mp4", 120);
  assert.ok(core.utf8Length(result) <= 120);
  assert.match(result, /\.mp4$/);
});

test("保存先はDownloads配下のPageMediaフォルダに固定する", () => {
  assert.equal(
    core.buildDownloadPath("My/Folder", "../movie?.mp4", "abc"),
    "PageMedia/My_Folder/.._movie_.mp4",
  );
  assert.equal(core.buildDownloadPath("NUL", "CON.mp4", "abc"), "PageMedia/_NUL/_CON.mp4");
});

test("動画一覧を再検証し、重複・不正URL・非動画を除外する", () => {
  const valid = {
    id: "video-1",
    type: "file",
    mimetype: "video/mp4",
    name: "movie.mp4",
    size: 1234,
    link: "https://cdn.videy.co/Scene0001.mp4",
    thumbnail: "https://cdn.videy.co/Scene0001.jpg",
  };
  const result = core.normalizeVideos([
    valid,
    { ...valid },
    { ...valid, id: "video-2", link: "https://evil.example/download/movie.mp4" },
    { ...valid, id: "text", mimetype: "text/plain", link: "https://cdn.videy.co/Scene0001.mp4" },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: "video-1",
    link: valid.link,
    mimetype: "video/mp4",
    name: "movie.mp4",
    size: 1234,
    thumbnail: valid.thumbnail,
  });
});

test("全体の保存率はサイズではなく保存成功件数で計算し、受信量は別に集計する", () => {
  const summary = core.summarizeItems([
    { status: "complete", size: 100, bytesReceived: 100, totalBytes: 100 },
    { status: "downloading", size: 300, bytesReceived: 100, totalBytes: 300 },
    { status: "queued", size: 100, bytesReceived: 0, totalBytes: 100 },
  ]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.downloading, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.percent, 33);
  assert.equal(summary.bytesReceived, 200);
  assert.equal(summary.totalBytes, 500);
});

test("サイズ不明を含んでも保存完了前の進捗を全体の保存率に含めない", () => {
  const summary = core.summarizeItems([
    { status: "complete", size: 0, bytesReceived: 0, totalBytes: 0 },
    { status: "downloading", size: 100, bytesReceived: 50, totalBytes: 100 },
  ]);
  assert.equal(summary.percent, 50);
});

test("23件保存・17件失敗は全バイト受信済みでも57%と表示する", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({
    status: index < 23 ? "complete" : "failed",
    size: index < 23 ? 1000 : 100,
    totalBytes: index < 23 ? 1000 : 100,
    bytesReceived: index < 23 ? 1000 : 100,
  }));
  const summary = core.summarizeItems(items);
  assert.equal(summary.total, 40);
  assert.equal(summary.completed, 23);
  assert.equal(summary.failed, 17);
  assert.equal(summary.bytesReceived, summary.totalBytes);
  assert.equal(summary.percent, 57);
  assert.equal(core.deriveBatchStatus(items), "completed_with_errors");
});

test("失敗・キャンセル・保存中は100%受信済みでも保存成功へ数えない", () => {
  for (const status of ["failed", "interrupted", "canceled", "queued", "starting", "downloading"]) {
    const item = { status, totalBytes: 100, bytesReceived: 100 };
    assert.equal(core.summarizeItems([item]).percent, 0, status);
  }
  assert.equal(core.itemProgress({ status: "downloading", totalBytes: 100, bytesReceived: 50 }), 50);
  assert.equal(core.summarizeItems([]).percent, 0);
  assert.equal(core.summarizeItems([{ status: "complete", size: 0 }]).percent, 100);
  assert.equal(core.summarizeItems([
    { status: "complete", size: 0 },
    { status: "failed", size: 0 },
  ]).percent, 50);
});

test("完了・失敗・空のバッチ状態を判定する", () => {
  assert.equal(core.deriveBatchStatus([]), "empty");
  assert.equal(core.deriveBatchStatus([{ status: "queued", size: 1 }]), "active");
  assert.equal(core.deriveBatchStatus([{ status: "complete", size: 1 }]), "complete");
  assert.equal(core.deriveBatchStatus([{ status: "interrupted", size: 1 }]), "completed_with_errors");
});
