"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const H = require("../lib/hls.js");
const C = require("../lib/common.js");
const { fixtures, loadMux, fixtureRequest, outputBuffer, hasBox, topLevelBoxes, trackKinds } = require("./helpers.cjs");

const hls = loadMux();
const mp4 = require("../lib/mp4.js");
const base = "http://test.local/hls-av/";

async function assembleFixture(name, request = fixtureRequest()) {
  const output = H.memoryOutput();
  const result = await H.assemble(`http://test.local/${name}`, {
    request, muxjs: hls, mp4, output, progress() {}
  });
  return { result, buffer: await outputBuffer(output) };
}

function ffprobe(buffer) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "media-saver-probe-")), "out.bin");
  fs.writeFileSync(file, buffer);
  try {
    return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

test("parseMaster follows audio groups declared after variants", () => {
  const text = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,AUDIO=\"aud\"",
    "video.m3u8",
    "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"日本語\",LANGUAGE=\"ja\",DEFAULT=YES,URI=\"audio.m3u8\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,AUDIO=\"aud\"",
    "low.m3u8"
  ].join("\n");
  const plan = H.parseMaster(text, "https://example.com/master.m3u8");
  assert.equal(plan.variants.length, 2);
  assert.equal(plan.hasSeparateAudio, true);
  assert.equal(plan.variants[0].url, "https://example.com/video.m3u8");
  assert.equal(plan.variants[0].audioUrl, "https://example.com/audio.m3u8");
  assert.equal(plan.variants[0].audioName, "日本語");
});

test("parseMaster treats an AUDIO group without a URI as muxed", () => {
  const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO=\"missing\"\nv.m3u8\n";
  const plan = H.parseMaster(text, "https://example.com/master.m3u8");
  assert.equal(plan.variants.length, 1);
  assert.equal(plan.hasSeparateAudio, false);
  assert.equal(plan.variants[0].audioUrl, "");
});

test("parseMedia accepts an explicit VOD playlist without ENDLIST", () => {
  const text = [
    "#EXTM3U", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-TARGETDURATION:4",
    "#EXTINF:3.5,", "a.ts"
  ].join("\n");
  const plan = H.parseMedia(text, "https://example.com/media.m3u8");
  assert.equal(plan.ended, true);
  assert.equal(plan.segments.length, 1);
});

test("parseMedia reads durations, byte ranges and explicit offsets", () => {
  const text = [
    "#EXTM3U", "#EXT-X-VERSION:4", "#EXT-X-TARGETDURATION:4",
    "#EXTINF:3.5,", "#EXT-X-BYTERANGE:100@0", "all.ts",
    "#EXTINF:2.25,", "#EXT-X-BYTERANGE:50", "all.ts",
    "#EXT-X-ENDLIST"
  ].join("\n");
  const plan = H.parseMedia(text, "https://example.com/path/media.m3u8");
  assert.equal(plan.ended, true);
  assert.equal(plan.segments.length, 2);
  assert.deepEqual(plan.segments[0].range, { length: 100, offset: 0 });
  assert.deepEqual(plan.segments[1].range, { length: 50, offset: 100 });
  assert.equal(plan.segments[0].url, "https://example.com/path/all.ts");
  assert.equal(plan.duration, 5.75);
  assert.equal(plan.fragmented, false);
});

test("parseMedia defaults an EXT-X-MAP byte range offset to zero", () => {
  const text = [
    "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:2",
    "#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100\"",
    "#EXTINF:2,", "segment.m4s", "#EXT-X-ENDLIST"
  ].join("\n");
  const plan = H.parseMedia(text, "https://example.com/media.m3u8");
  assert.deepEqual(plan.init.range, { length: 100, offset: 0 });
});

test("parseMedia rejects live, encrypted, discontinuous and gap playlists", () => {
  assert.throws(() => H.parseMedia("#EXTM3U\n#EXTINF:2,\na.ts\n", "https://x/"), /HLS_LIVE/);
  const encrypted = H.parseMedia("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST", "https://x/");
  assert.equal(encrypted.encrypted, true);
  assert.throws(() => H.parseMedia("#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST", "https://x/"), /HLS_UNSUPPORTED/);
  assert.throws(() => H.parseMedia("#EXTM3U\n#EXT-X-GAP\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST", "https://x/"), /HLS_UNSUPPORTED/);
  assert.throws(() => H.parseMedia("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\na.m4s\n#EXT-X-MAP:URI=\"other.mp4\"\n#EXTINF:2,\nb.m4s\n#EXT-X-ENDLIST", "https://x/"), /HLS_UNSUPPORTED/);
});

test("parseMedia rejects malformed byte ranges and unsafe URLs", () => {
  assert.throws(() => H.parseMedia("#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:0@0\na.ts\n#EXT-X-ENDLIST", "https://x/"), /HLS_UNSUPPORTED/);
  assert.throws(() => H.parseMedia("#EXTM3U\n#EXTINF:2,\nhttps://user:pass@x/a.ts\n#EXT-X-ENDLIST", "https://x/"), /HLS_UNSUPPORTED/);
  assert.throws(() => H.parseMedia("#EXTM3U\n#EXTINF:0,\na.ts\n#EXT-X-ENDLIST", "https://x/"), /HLS_UNSUPPORTED/);
});

test("probe reports separated audio and variants", async () => {
  const result = await H.probe(`${base}master.m3u8`, { request: fixtureRequest() });
  assert.equal(result.kind, "hls");
  assert.equal(result.separateAudio, true);
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].height, 90);
  assert.equal(result.variants[0].label, "90p");
  assert.match(result.variants[0].audioUrl, /stream_1\.m3u8$/);
});

test("assemble merges separate TS audio into one playable MP4", async () => {
  const { result, buffer } = await assembleFixture("hls-av/master.m3u8");
  assert.equal(result.extension, "mp4");
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.audioOnly, false);
  assert.equal(result.separateAudio, true);
  assert.equal(result.duration, 2);
  assert.equal(buffer.subarray(4, 8).toString("ascii"), "ftyp");
  assert.ok(topLevelBoxes(buffer).some(box => box.type === "moov"));
  assert.ok(topLevelBoxes(buffer).some(box => box.type === "mdat"));
  assert.deepEqual(trackKinds(buffer).sort(), ["soun", "vide"]);
  assert.ok(hasBox(buffer, "avc1"));
  assert.ok(hasBox(buffer, "mp4a"));
  const probe = ffprobe(buffer);
  if (probe) {
    const kinds = probe.streams.map(stream => stream.codec_type).sort();
    assert.deepEqual(kinds, ["audio", "video"]);
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.2);
  }
});

test("assemble converts an audio-only HLS playlist to M4A", async () => {
  const { result, buffer } = await assembleFixture("hls-av/stream_1.m3u8");
  assert.equal(result.extension, "m4a");
  assert.equal(result.mime, "audio/mp4");
  assert.equal(result.audioOnly, true);
  assert.deepEqual(trackKinds(buffer), ["soun"]);
  assert.ok(hasBox(buffer, "mp4a"));
  const probe = ffprobe(buffer);
  if (probe) assert.deepEqual(probe.streams.map(stream => stream.codec_type), ["audio"]);
});

test("assemble concatenates fMP4 init and media segments", async () => {
  const { result, buffer } = await assembleFixture("hls-fmp4/stream.m3u8");
  assert.equal(result.extension, "mp4");
  assert.equal(result.fragmented, true);
  assert.equal(buffer.subarray(4, 8).toString("ascii"), "ftyp");
  assert.equal(buffer.subarray(8, 11).toString("ascii"), "iso");
  assert.ok(buffer.includes(Buffer.from("moof")));
  const probe = ffprobe(buffer);
  if (probe) {
    assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), ["audio", "video"]);
  }
});

test("assemble falls back when the server ignores byte ranges", async () => {
  const init = fs.readFileSync(path.join(fixtures, "hls-fmp4", "init.mp4"));
  const segment = fs.readFileSync(path.join(fixtures, "hls-fmp4", "seg_000.m4s"));
  const combined = Buffer.concat([init, segment]);
  const playlist = [
    "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:1",
    `#EXT-X-MAP:URI="combined.mp4",BYTERANGE="${init.length}@0"`,
    "#EXTINF:1.000000,", `#EXT-X-BYTERANGE:${segment.length}@${init.length}`, "combined.mp4",
    "#EXT-X-ENDLIST"
  ].join("\n");
  const request = async url => {
    if (url.endsWith(".m3u8")) return new Response(playlist, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    return new Response(combined, { headers: { "content-type": "video/mp4", "content-length": String(combined.length) } });
  };
  const output = H.memoryOutput();
  await H.assemble("https://cdn.example.com/list.m3u8", { request, output });
  const buffer = await outputBuffer(output);
  assert.deepEqual(buffer, combined);
});

test("range fallback cancels the response reader once the range is complete", async () => {
  const init = fs.readFileSync(path.join(fixtures, "hls-fmp4", "init.mp4"));
  const segment = fs.readFileSync(path.join(fixtures, "hls-fmp4", "seg_000.m4s"));
  const combined = Buffer.concat([init, segment]);
  const playlist = [
    "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:1",
    `#EXT-X-MAP:URI="combined.mp4",BYTERANGE="${init.length}@0"`,
    "#EXTINF:1.000000,", `#EXT-X-BYTERANGE:${segment.length}@${init.length}`, "combined.mp4",
    "#EXT-X-ENDLIST"
  ].join("\n");
  let canceled = 0;
  const request = async url => {
    if (url.endsWith(".m3u8")) return new Response(playlist, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(combined)); },
      cancel() { canceled++; }
    });
    return new Response(stream, { headers: { "content-type": "video/mp4" } });
  };
  const output = H.memoryOutput();
  await H.assemble("https://cdn.example.com/list.m3u8", { request, output });
  assert.deepEqual(await outputBuffer(output), combined);
  assert.equal(canceled, 2);
});

test("assemble reports encrypted and live playlists with stable error codes", async () => {
  const encrypted = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST";
  const request = async url => new Response(url.endsWith(".m3u8") ? encrypted : new Uint8Array(200).fill(0x47), {
    headers: { "content-type": url.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" }
  });
  await assert.rejects(
    H.assemble("https://example.com/list.m3u8", { request, muxjs: hls, mp4, output: H.memoryOutput() }),
    /HLS_ENCRYPTED/
  );
});

test("assemble never requests a private-network variant listed by a public master playlist", async () => {
  const requested = [];
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90\nhttp://127.0.0.1/private.m3u8\n";
  const request = C.guardFetch(async url => {
    requested.push(url);
    return new Response(master, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  }, "https://example.com/watch");
  await assert.rejects(H.assemble("https://media.example.com/master.m3u8", {
    request, muxjs: hls, mp4, output: H.memoryOutput(), progress() {}
  }), /^Error: UNSAFE_TARGET$/);
  assert.deepEqual(requested, ["https://media.example.com/master.m3u8"]);
});

test("relative references resolve against the URL a redirected manifest was finally served from", async () => {
  const serve = fixtureRequest();
  const requested = [];
  const request = async (url, init) => {
    requested.push(url);
    const moved = url === "http://test.local/moved/master.m3u8";
    const response = await serve(moved ? `${base}master.m3u8` : url, init);
    if (moved) Object.defineProperty(response, "url", { value: `${base}master.m3u8` });
    return response;
  };
  const probed = await H.probe("http://test.local/moved/master.m3u8", { request });
  assert.deepEqual(probed.variants.map(variant => [variant.url, variant.audioUrl]), [[`${base}stream_0.m3u8`, `${base}stream_1.m3u8`]]);
  const output = H.memoryOutput();
  await H.assemble("http://test.local/moved/master.m3u8", { request, muxjs: hls, mp4, output, progress() {} });
  assert.deepEqual(requested.filter(url => !url.startsWith(base)), ["http://test.local/moved/master.m3u8", "http://test.local/moved/master.m3u8"]);
  assert.ok((await outputBuffer(output)).length > 10000);
});

test("a byte range larger than the segment limit is refused before it is requested", async () => {
  const limit = 64 * 1024 * 1024;
  const playlist = ["#EXTM3U", "#EXT-X-VERSION:4", "#EXT-X-TARGETDURATION:1",
    "#EXTINF:1.0,", `#EXT-X-BYTERANGE:${limit + 1}@0`, "all.ts", "#EXT-X-ENDLIST"].join("\n");
  const requested = [];
  const request = async url => {
    requested.push(url);
    if (url.endsWith(".m3u8")) return new Response(playlist, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    // A server that ignores Range and keeps streaming past the limit.
    let sent = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent > limit + 4 * 1024 * 1024) return controller.close();
        controller.enqueue(new Uint8Array(1024 * 1024));
        sent += 1024 * 1024;
      }
    }), { headers: { "content-type": "video/mp2t" } });
  };
  await assert.rejects(H.assemble("https://cdn.example.com/list.m3u8", { request, muxjs: hls, mp4, output: H.memoryOutput() }), /^Error: HLS_TOO_LARGE$/);
  assert.deepEqual(requested, ["https://cdn.example.com/list.m3u8"]);
});
