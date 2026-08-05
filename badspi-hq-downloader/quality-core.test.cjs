const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./quality-core.js");

test("任意のWordPress縮小サイズをURLから除く", () => {
  for (const size of ["630x430", "682x430", "768x484", "305x430"]) {
    assert.equal(
      core.originalUrl(`https://www.badspi.jp/wp-content/uploads/2026/07/photo-${size}.jpg`),
      "https://www.badspi.jp/wp-content/uploads/2026/07/photo.jpg",
    );
  }
});

test("複数の対応拡張子とクエリ文字列を扱う", () => {
  for (const extension of ["jpg", "jpeg", "png", "gif", "webp", "avif"]) {
    assert.equal(
      core.originalUrl(`https://www.badspi.jp/wp-content/uploads/photo-123x456.${extension}?v=1`),
      `https://www.badspi.jp/wp-content/uploads/photo.${extension}?v=1`,
    );
  }
});

test("ファイル名中の通常の数字は除去しない", () => {
  assert.equal(
    core.originalUrl("https://www.badspi.jp/wp-content/uploads/2026/07/match-2026-07.jpg"),
    "https://www.badspi.jp/wp-content/uploads/2026/07/match-2026-07.jpg",
  );
});

test("バドスピのアップロード画像以外は変更しない", () => {
  assert.equal(core.originalUrl("https://example.com/photo-630x430.jpg"), "https://example.com/photo-630x430.jpg");
});

test("候補内に元画像があれば元画像URLを選ぶ", () => {
  assert.equal(
    core.bestUrl([
      "https://www.badspi.jp/wp-content/uploads/photo-682x430.jpg",
      "https://www.badspi.jp/wp-content/uploads/photo.jpg",
    ]),
    "https://www.badspi.jp/wp-content/uploads/photo.jpg",
  );
});

test("縮小サイズを除いた自然なファイル名を作る", () => {
  assert.equal(
    core.filenameFromUrl("https://www.badspi.jp/wp-content/uploads/2026/07/badAH1_0025-682x430.jpg"),
    "badAH1_0025.jpg",
  );
});
