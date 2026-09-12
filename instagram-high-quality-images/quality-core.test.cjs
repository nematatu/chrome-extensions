const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "quality-core.js"), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const {
  buildFilename,
  highestMediaCandidate,
  isInstagramLivePath,
  isLiveArchiveMedia,
  isLiveStreamVideo,
  isPortraitVideo,
  largestCandidate,
  parseSrcset,
  shortcodeToMediaId,
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

test("投稿情報から確認不要の保存ファイル名を作る", () => {
  assert.equal(
    buildFilename({ username: "badminton_baj", shortcode: "DbUihqMGqmJ", index: 1 }),
    "instagram_badminton_baj_DbUihqMGqmJ_01.jpg",
  );
});

test("投稿ショートコードをMedia IDへ変換する", () => {
  assert.equal(shortcodeToMediaId("DbUihqMGqmJ"), "3950934619735107977");
  assert.equal(shortcodeToMediaId("invalid!"), null);
});

test("カルーセル内の対象画像から最大候補を選ぶ", () => {
  const data = {
    items: [
      {
        carousel_media: [
          {
            pk: "one",
            image_versions2: { candidates: [{ url: "one.jpg", width: 640, height: 640 }] },
          },
          {
            pk: "two",
            original_width: 3000,
            original_height: 2000,
            image_versions2: {
              candidates: [
                { url: "two-small.jpg", width: 640, height: 426 },
                { url: "two-large.jpg", width: 1440, height: 959 },
                { url: "two-cropped.jpg", width: 1800, height: 1800 },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(localValue(highestMediaCandidate(data, "two", 1)), {
    url: "two-large.jpg",
    width: 1440,
    height: 959,
  });
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

test("Liveアーカイブのメディア情報を判定する", () => {
  assert.equal(isLiveArchiveMedia({ items: [{ is_post_live: true }] }), true);
  assert.equal(isLiveArchiveMedia({ items: [{ media_product_type: "LIVE" }] }), true);
  assert.equal(isLiveArchiveMedia({ items: [{ product_type: "clips" }] }), false);
});
