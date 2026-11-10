"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/common.js");

test("classify recognizes direct, HLS and DASH media", () => {
  assert.deepEqual(C.classify("https://example.com/video.mp4"), { kind: "video", ext: "mp4", contentType: null });
  assert.equal(C.classify("https://example.com/playlist.m3u8").kind, "hls");
  assert.equal(C.classify("https://example.com/manifest.mpd").kind, "dash");
  assert.equal(C.classify("https://example.com/live", "application/vnd.apple.mpegurl").kind, "hls");
  assert.equal(C.classify("https://example.com/live", "application/dash+xml").kind, "dash");
  assert.deepEqual(C.classify("https://example.com/audio", "audio/mpeg"), { kind: "audio", ext: "mp3", contentType: "audio/mpeg" });
  assert.equal(C.classify("https://example.com/picture.webp").kind, "image");
  assert.equal(C.classify("https://example.com/picture.webp", "image/webp").ext, "webp");
});

test("classify rejects segments, unsafe schemes and unknown data", () => {
  assert.equal(C.classify("https://example.com/chunk.m4s"), null);
  assert.equal(C.classify("https://example.com/chunk.ts"), null);
  assert.equal(C.classify("https://example.com/video.mp4", "video/mp2t"), null);
  assert.equal(C.classify("javascript:alert(1)"), null);
  assert.equal(C.classify("data:video/mp4;base64,AAAA"), null);
  assert.equal(C.classify("https://user:pass@example.com/video.mp4"), null);
  assert.equal(C.classify("https://example.com/page.html"), null);
  assert.equal(C.classify("https://example.com/vector.svg", "image/svg+xml"), null);
  assert.equal(C.classify("not a url"), null);
  assert.equal(C.classify("https://example.com/" + "a".repeat(17000) + ".mp4"), null);
});

test("isPrivateHost covers local and special-use addresses", () => {
  for (const url of [
    "http://localhost/", "http://app.localhost/", "http://printer.local/", "http://router.internal/",
    "http://box.home.arpa/", "http://127.0.0.1/", "http://10.2.3.4/", "http://172.16.0.1/",
    "http://172.31.255.255/", "http://192.168.1.10/", "http://169.254.1.1/", "http://100.64.1.1/",
    "http://198.18.2.3/", "http://224.0.0.1/", "http://[::1]/", "http://[fd00::1]/",
    "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/"
  ]) assert.equal(C.isPrivateHost(url), true, url);
  for (const url of ["https://example.com/", "https://8.8.8.8/", "https://172.32.0.1/", "https://[2001:4860:4860::8888]/"]) {
    assert.equal(C.isPrivateHost(url), false, url);
  }
});

test("isSafeTarget blocks public pages from reading private hosts", () => {
  assert.equal(C.isSafeTarget("http://127.0.0.1/secret.mp4", "https://example.com/watch"), false);
  assert.equal(C.isSafeTarget("https://cdn.example.com/video.mp4", "https://example.com/watch"), true);
  assert.equal(C.isSafeTarget("http://127.0.0.1/secret.mp4", "http://127.0.0.1/page"), true);
  assert.equal(C.isSafeTarget("http://localhost:8080/secret.mp4", "http://localhost:3000/page"), true);
  assert.equal(C.isSafeTarget("http://127.0.0.1/secret.mp4", "chrome-extension://abc/popup.html"), false);
  assert.equal(C.isSafeTarget("javascript:alert(1)", "https://example.com/"), false);
});

test("guardFetch checks every request before it is sent and the final URL after redirects", async () => {
  const sent = [];
  const request = async url => { sent.push(url); return { url: url.endsWith("/moved") ? "http://10.0.0.1/admin" : url, body: null }; };
  const guarded = C.guardFetch(request, "https://example.com/watch");
  assert.equal((await guarded("https://cdn.example.com/segment.ts")).url, "https://cdn.example.com/segment.ts");
  await assert.rejects(guarded("http://127.0.0.1/private.m3u8"), /^Error: UNSAFE_TARGET$/);
  assert.deepEqual(sent, ["https://cdn.example.com/segment.ts"]);
  await assert.rejects(guarded("https://cdn.example.com/moved"), /^Error: UNSAFE_TARGET$/);
  const fromPrivatePage = C.guardFetch(request, "http://127.0.0.1/page");
  assert.equal((await fromPrivatePage("http://127.0.0.1/clip.ts")).url, "http://127.0.0.1/clip.ts");
});

test("sanitizeSegment removes traversal, control and reserved characters", () => {
  assert.equal(C.sanitizeSegment("../../etc/passwd"), ".._etc_passwd");
  assert.equal(C.sanitizeSegment("a\u0000b\nc"), "abc");
  assert.equal(C.sanitizeSegment("what: is* this?"), "what_ is_ this");
  assert.equal(C.sanitizeSegment("..."), "media");
  assert.equal(C.sanitizeSegment("   "), "media");
  assert.equal(C.sanitizeSegment("CON"), "_CON");
  assert.equal(C.sanitizeSegment("normal title", "fallback"), "normal title");
  const long = C.sanitizeSegment("あ".repeat(200));
  assert.ok(new TextEncoder().encode(long).length <= 140);
  assert.equal(C.sanitizeSegment("..hello.."), "hello");
});

test("buildFilename creates a safe relative path and strips duplicate extensions", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 24, 12) });
  const settings = { folder: "Media Saver/Clips", subfolder: true, filenameTemplate: "{site} - {title} ({quality}) [{index}]" };
  assert.equal(
    C.buildFilename(settings, { title: "movie.mp4", site: "www.example.com", quality: "1080p", index: 2 }, "mp4"),
    "Media Saver/Clips/www.example.com/www.example.com - movie (1080p) [2].mp4"
  );
  assert.equal(
    C.buildFilename({ folder: "../../etc", subfolder: false, filenameTemplate: "{title}" }, { title: "../../escape" }, "mp4"),
    "MediaSaver/MediaSaver/etc/.._escape.mp4"
  );
  assert.equal(
    C.buildFilename({ folder: "/absolute//path/", subfolder: false, filenameTemplate: "{date}-{title}" }, { title: "Clip" }, "webm"),
    "absolute/path/20261024-Clip.webm"
  );
  assert.equal(
    C.buildFilename({ folder: "", subfolder: true, filenameTemplate: "" }, { title: "x", site: "a" }, "../../evil"),
    "MediaSaver/a/x.bin"
  );
  assert.equal(
    C.buildFilename({ folder: "M", subfolder: false, filenameTemplate: "{title}" }, { title: "clip.MP4" }, "mp4"),
    "M/clip.mp4"
  );
  assert.equal(
    C.buildFilename({ folder: "M", subfolder: false, filenameTemplate: "{title}" }, { title: "/" }, "mp4"),
    "M/media.mp4"
  );
  assert.equal(
    C.buildFilename({ folder: "M", subfolder: false, filenameTemplate: "{title}" }, { title: "\\" }, "mp4"),
    "M/media.mp4"
  );
});

test("parseContentDisposition handles plain and RFC 5987 filenames", () => {
  assert.equal(C.parseContentDisposition('attachment; filename="clip.mp4"'), "clip.mp4");
  assert.equal(C.parseContentDisposition("attachment; filename=plain.mp4; size=2"), "plain.mp4");
  assert.equal(C.parseContentDisposition("attachment; filename*=UTF-8''%E5%8B%95%E7%94%BB.mp4"), "動画.mp4");
  assert.equal(C.parseContentDisposition(""), "");
  assert.equal(C.parseContentDisposition('attachment; filename="bad%ZZ.mp4"'), "bad%ZZ.mp4");
});

test("normalizeSettings clamps ranges and filters invalid blacklist entries", () => {
  const settings = C.normalizeSettings({
    folder: "  My/Media  ", subfolder: false, filenameTemplate: "  {title}  ",
    concurrency: 99, minSizeMB: -5, detectVideo: false, detectImages: "yes", theme: "neon",
    blacklist: ["Example.COM", "https://ads.example.com/path", ".bad..domain", "ok-domain.test", "", "a".repeat(260)]
  });
  assert.equal(settings.folder, "My/Media");
  assert.equal(settings.subfolder, false);
  assert.equal(settings.concurrency, 6);
  assert.equal(settings.minSizeMB, 0);
  assert.equal(settings.detectVideo, false);
  assert.equal(settings.detectImages, true);
  assert.equal(settings.theme, "auto");
  assert.deepEqual(settings.blacklist, ["example.com", "ads.example.com", "bad..domain", "ok-domain.test"]);
});

test("blacklist matches subdomains but not lookalikes", () => {
  assert.equal(C.isBlacklisted("https://ads.example.com/a.mp4", ["example.com"]), true);
  assert.equal(C.isBlacklisted("https://example.com/a.mp4", ["example.com"]), true);
  assert.equal(C.isBlacklisted("https://notexample.com/a.mp4", ["example.com"]), false);
  assert.equal(C.isBlacklisted("https://example.com.evil.test/a.mp4", ["example.com"]), false);
  assert.equal(C.isBlacklisted("https://EXAMPLE.com/a.mp4", ["example.com"]), true);
  assert.equal(C.isBlacklisted("not a url", ["example.com"]), false);
});

test("formatting helpers produce stable labels", () => {
  assert.equal(C.formatDuration(0), "");
  assert.equal(C.formatDuration(59), "0:59");
  assert.equal(C.formatDuration(3661), "1:01:01");
  assert.equal(C.formatBytes(0), "サイズ不明");
  assert.equal(C.formatBytes(512), "512 B");
  assert.equal(C.formatBytes(1536), "1.5 KB");
  assert.equal(C.formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(C.formatBitrate(900000), "900 kbps");
  assert.equal(C.formatBitrate(2500000), "2.5 Mbps");
  assert.equal(C.titleFromUrl("https://example.com/a/great_video.mp4?x=1"), "great video");
  assert.equal(C.basenameFromUrl("https://example.com/a/%E5%8B%95%E7%94%BB.mp4"), "動画.mp4");
});

test("idFor is stable and URL-specific", () => {
  assert.equal(C.idFor("https://example.com/a.mp4"), C.idFor("https://example.com/a.mp4"));
  assert.notEqual(C.idFor("https://example.com/a.mp4"), C.idFor("https://example.com/b.mp4"));
  assert.match(C.idFor("https://example.com/a.mp4"), /^[a-z0-9]+-[a-z0-9]+$/);
});
