"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./core.js");

test("共有ページURLを厳密に判定する", () => {
  assert.equal(core.isGofilePageUrl("https://gofile.io/d/AbC123"), true);
  assert.equal(core.isGofilePageUrl("https://gofile.io/d/AbC123?page=2"), true);
  assert.equal(core.isGofilePageUrl("http://gofile.io/d/AbC123"), false);
  assert.equal(core.isGofilePageUrl("https://gofile.io.evil.example/d/AbC123"), false);
  assert.equal(core.isGofilePageUrl("https://gofile.io/profile"), false);
});

test("ダウンロードURLはGofileのHTTPS download配下だけを許可する", () => {
  assert.equal(
    core.isAllowedDownloadUrl("https://store-eu-par-3.gofile.io/download/web/uuid/video.mp4"),
    true,
  );
  assert.equal(core.isAllowedDownloadUrl("https://store9.gofile.io/download/direct/uuid/video.webm"), true);
  assert.equal(core.isAllowedDownloadUrl("https://store9.gofile.io/preview/uuid/video.mp4"), false);
  assert.equal(core.isAllowedDownloadUrl("https://gofile.io.evil.example/download/web/a.mp4"), false);
  assert.equal(core.isAllowedDownloadUrl("https://user:pass@store9.gofile.io/download/web/a.mp4"), false);
  assert.equal(core.isAllowedDownloadUrl("javascript:alert(1)"), false);
});

test("動画MIMEを優先し、汎用MIMEでは既知拡張子を補助判定する", () => {
  assert.equal(core.isVideoItem({ type: "file", mimetype: "video/mp4", name: "clip.bin" }), true);
  assert.equal(core.isVideoItem({ type: "file", mimetype: "application/octet-stream", name: "clip.MKV" }), true);
  assert.equal(core.isVideoItem({ type: "file", mimetype: "application/zip", name: "clip.mp4" }), false);
  assert.equal(core.isVideoItem({ type: "folder", mimetype: "video/mp4", name: "folder" }), false);
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

test("保存先はDownloads配下のGofileフォルダに固定する", () => {
  assert.equal(
    core.buildDownloadPath("My/Folder", "../movie?.mp4", "abc"),
    "Gofile/My_Folder/.._movie_.mp4",
  );
  assert.equal(core.buildDownloadPath("NUL", "CON.mp4", "abc"), "Gofile/_NUL/_CON.mp4");
});

test("動画一覧を再検証し、重複・不正URL・非動画を除外する", () => {
  const valid = {
    id: "video-1",
    type: "file",
    mimetype: "video/mp4",
    name: "movie.mp4",
    size: 1234,
    link: "https://store1.gofile.io/download/web/id/movie.mp4",
    thumbnail: "https://store1.gofile.io/thumbnail/id/movie.jpg",
  };
  const result = core.normalizeVideos([
    valid,
    { ...valid },
    { ...valid, id: "video-2", link: "https://evil.example/download/movie.mp4" },
    { ...valid, id: "text", mimetype: "text/plain", link: "https://store1.gofile.io/download/web/id/a.txt" },
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

test("全ファイルのサイズが既知なら全体バイト率を計算する", () => {
  const summary = core.summarizeItems([
    { status: "complete", size: 100, bytesReceived: 100, totalBytes: 100 },
    { status: "downloading", size: 300, bytesReceived: 100, totalBytes: 300 },
    { status: "queued", size: 100, bytesReceived: 0, totalBytes: 100 },
  ]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.downloading, 1);
  assert.equal(summary.queued, 1);
  assert.equal(summary.percent, 40);
  assert.equal(summary.bytesReceived, 200);
  assert.equal(summary.totalBytes, 500);
});

test("サイズ不明を含む場合は動画単位の進捗へ安全にフォールバックする", () => {
  const summary = core.summarizeItems([
    { status: "complete", size: 0, bytesReceived: 0, totalBytes: 0 },
    { status: "downloading", size: 100, bytesReceived: 50, totalBytes: 100 },
  ]);
  assert.equal(summary.percent, 75);
});

test("完了・失敗・空のバッチ状態を判定する", () => {
  assert.equal(core.deriveBatchStatus([]), "empty");
  assert.equal(core.deriveBatchStatus([{ status: "queued", size: 1 }]), "active");
  assert.equal(core.deriveBatchStatus([{ status: "complete", size: 1 }]), "complete");
  assert.equal(core.deriveBatchStatus([{ status: "interrupted", size: 1 }]), "completed_with_errors");
});
