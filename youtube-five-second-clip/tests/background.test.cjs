const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("バックグラウンド処理は外部補助ツールに依存しない", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json")));
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.deepEqual(manifest.permissions, ["offscreen", "downloads", "storage"]);
  assert.doesNotMatch(source, /connectNative|nativeMessaging|yt-dlp|ffmpeg|fetch\(/i);
  assert.match(source, /chrome\.offscreen\.createDocument/);
  assert.match(source, /chrome\.downloads\.download/);
});

test("コンテンツスクリプトはクリック時刻を固定して別コンテキストへ渡す", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(source, /selectionRange\(video/);
  assert.match(source, /youtube-clip-read/);
  assert.match(source, /request\.tracks/);
  assert.match(source, /data-role=\\?"start-preview/);
  assert.match(source, /capturePreviews/);
  assert.match(source, /new Blob\(\[track\.data\]/);
  assert.match(source, /decoder\.currentTime/);
  assert.match(source, /youtube-clip-preview-read/);
  assert.doesNotMatch(source, /\bvideo\.currentTime\s*=/);
  assert.doesNotMatch(source, /captureStream|MediaRecorder/);
});

test("動画下のアクション領域へUIを挿入する", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.match(source, /button\[aria-label=\\?"共有/);
  assert.match(source, /document\.body\.append\(host\)/);
  assert.doesNotMatch(source, /player\.append\(host/);
  assert.match(source, /position:fixed !important/);
  assert.match(source, /placeEditor/);
});
