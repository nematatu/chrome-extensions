const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "quality-core.js"), "utf8");
const context = { globalThis: {}, URL };
vm.runInNewContext(source, context);
const {
  isInstagramMediaUrl,
  isInstagramLivePath,
  isLiveStreamVideo,
  isPortraitVideo,
  largestCandidate,
  parseSrcset,
} =
  context.globalThis.InstagramHighQualityCore;
const localValue = (value) => JSON.parse(JSON.stringify(value));

test("srcsetの幅指定を解析する", () => {
  assert.deepEqual(localValue(parseSrcset("small.jpg 320w, medium.jpg 640w, large.jpg 1440w")), [
    { url: "small.jpg", width: 320, density: 0 },
    { url: "medium.jpg", width: 640, density: 0 },
    { url: "large.jpg", width: 1440, density: 0 },
  ]);
});

test("複数のsrcsetから最大候補を選ぶ", () => {
  assert.deepEqual(
    localValue(largestCandidate(["small.jpg 320w, large.jpg 1080w", "largest.jpg 1440w"], "fallback.jpg")),
    { url: "largest.jpg", width: 1440, density: 0 },
  );
});

test("srcsetがなければ現在のURLを維持する", () => {
  assert.deepEqual(localValue(largestCandidate([], "current.jpg")), {
    url: "current.jpg",
    width: 0,
    density: 0,
  });
});

test("Instagram配信元の画像URLだけを対象にする", () => {
  assert.equal(isInstagramMediaUrl("https://scontent.cdninstagram.com/image.jpg"), true);
  assert.equal(isInstagramMediaUrl("https://scontent.fbcdn.net/image.jpg"), true);
  for (const value of [
    "https://example.com/image.jpg",
    "https://cdninstagram.com.example.com/image.jpg",
    "http://scontent.cdninstagram.com/image.jpg",
    "https://user:pass@scontent.cdninstagram.com/image.jpg",
  ]) {
    assert.equal(isInstagramMediaUrl(value), false);
  }
});

test("Liveページのパスだけを判定する", () => {
  assert.equal(isInstagramLivePath("/account/live/"), true);
  assert.equal(isInstagramLivePath("/account/live"), true);
  assert.equal(isInstagramLivePath("/account/live/replay/"), true);
  assert.equal(isInstagramLivePath("/reel/ABC123/"), false);
  assert.equal(isInstagramLivePath("/"), false);
});

test("縦長動画だけを判定する", () => {
  assert.equal(isPortraitVideo(1080, 1920), true);
  assert.equal(isPortraitVideo(1920, 1080), false);
  assert.equal(isPortraitVideo(0, 1920), false);
});

test("再生時間が無限大の動画をLiveストリームとして判定する", () => {
  assert.equal(isLiveStreamVideo(Infinity), true);
  assert.equal(isLiveStreamVideo(3600), false);
  assert.equal(isLiveStreamVideo(NaN), false);
});
