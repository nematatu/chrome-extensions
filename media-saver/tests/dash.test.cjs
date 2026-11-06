"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const D = require("../lib/dash.js");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const base = "https://cdn.example.com/videos/manifest.mpd";

test("parseMpd reads SegmentTemplate timelines with padded numbers", () => {
  const parsed = D.parseMpd(fixture("dash-template/manifest.mpd"), "https://cdn.example.com/dash-template/manifest.mpd");
  assert.equal(parsed.duration, 2);
  assert.equal(parsed.tracks.length, 2);
  const video = parsed.tracks.find(track => track.kind === "video");
  const audio = parsed.tracks.find(track => track.kind === "audio");
  assert.equal(video.segments.length, 2);
  assert.match(video.initUrl, /init-0\.m4s$/);
  assert.match(video.segments[0].url, /chunk-0-00001\.m4s$/);
  assert.match(video.segments[1].url, /chunk-0-00002\.m4s$/);
  assert.equal(audio.segments.length, 2);
  assert.equal(video.width, 160);
  assert.equal(video.height, 90);
  const plan = D.selectPlan(parsed);
  assert.equal(plan.video, video);
  assert.equal(plan.audio, audio);
  const probe = D.probe(fixture("dash-template/manifest.mpd"), base);
  assert.equal(probe.variants.length, 1);
  assert.equal(probe.variants[0].label, "90p");
  assert.equal(probe.hasAudio, true);
});

test("parseMpd reads SegmentList bytes and single-file ranges", () => {
  const list = D.parseMpd(fixture("dash-list/manifest.mpd"), "https://cdn.example.com/dash-list/manifest.mpd");
  const video = list.tracks.find(track => track.kind === "video");
  assert.equal(video.singleUrl, null);
  assert.match(video.initUrl, /init-0\.m4s$/);
  assert.match(video.segments[0].url, /chunk-0-00001\.m4s$/);
  assert.equal(video.segments[0].range, null);

  const single = D.parseMpd(fixture("dash-single/manifest.mpd"), "https://cdn.example.com/dash-single/manifest.mpd");
  const singleVideo = single.tracks.find(track => track.kind === "video");
  assert.match(singleVideo.initUrl, /manifest-stream0\.mp4$/);
  assert.deepEqual(singleVideo.initRange, { offset: 0, length: 809 });
  assert.match(singleVideo.segments[0].url, /manifest-stream0\.mp4$/);
  assert.deepEqual(singleVideo.segments[0].range, { offset: 809, length: 4780 });
  assert.deepEqual(singleVideo.segments[1].range, { offset: 5589, length: 4121 });
});

test("SegmentTemplate expands Time and Number variables", () => {
  const mpd = `<MPD mediaPresentationDuration="PT2S"><Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="1000" width="10" height="10">
        <SegmentTemplate timescale="1000" initialization="init-$RepresentationID$-$Bandwidth$.mp4" media="seg-$Time$-$Number%05d$.m4s">
          <SegmentTimeline><S t="500" d="1000" r="1"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet></Period></MPD>`;
  const parsed = D.parseMpd(mpd, base);
  const video = parsed.tracks[0];
  assert.equal(video.initUrl, "https://cdn.example.com/videos/init-v1-1000.mp4");
  assert.deepEqual(video.segments.map(segment => segment.url), [
    "https://cdn.example.com/videos/seg-500-00001.m4s",
    "https://cdn.example.com/videos/seg-1500-00002.m4s"
  ]);
});

test("SegmentTemplate inherits attributes from Period and Representation", () => {
  const mpd = `<MPD mediaPresentationDuration="PT3S"><Period>
    <SegmentTemplate timescale="1000" duration="1000" media="chunk-$Number$.m4s" initialization="init-$RepresentationID$.mp4"/>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="1000"><SegmentTemplate startNumber="7"/></Representation>
    </AdaptationSet></Period></MPD>`;
  const parsed = D.parseMpd(mpd, base);
  const video = parsed.tracks[0];
  assert.equal(video.segments.length, 3);
  assert.equal(video.segments[0].url, "https://cdn.example.com/videos/chunk-7.m4s");
  assert.equal(video.segments[2].url, "https://cdn.example.com/videos/chunk-9.m4s");
  assert.equal(video.initUrl, "https://cdn.example.com/videos/init-v1.mp4");
});

test("BaseURL resolution does not apply relative paths twice", () => {
  const mpd = `<MPD mediaPresentationDuration="PT2S"><Period>
    <BaseURL>media/</BaseURL>
    <AdaptationSet mimeType="video/mp4">
      <BaseURL>video/</BaseURL>
      <Representation id="v" bandwidth="1">
        <BaseURL>clip.mp4</BaseURL>
        <SegmentBase><Initialization range="0-9"/></SegmentBase>
      </Representation>
    </AdaptationSet></Period></MPD>`;
  const parsed = D.parseMpd(mpd, "https://cdn.example.com/root/manifest.mpd");
  const track = parsed.tracks[0];
  assert.equal(track.base, "https://cdn.example.com/root/media/video/clip.mp4");
  assert.equal(track.singleUrl, "https://cdn.example.com/root/media/video/clip.mp4");
  assert.equal(track.segmentBase, true);
});

test("SegmentBase with an adaptation BaseURL is treated as a single file", () => {
  const mpd = `<MPD mediaPresentationDuration="PT2S"><Period>
    <AdaptationSet mimeType="audio/mp4"><BaseURL>audio.mp4</BaseURL>
      <Representation id="a" bandwidth="128000"><SegmentBase indexRange="0-99"><Initialization range="0-49"/></SegmentBase></Representation>
    </AdaptationSet></Period></MPD>`;
  const parsed = D.parseMpd(mpd, base);
  assert.equal(parsed.tracks[0].singleUrl, "https://cdn.example.com/videos/audio.mp4");
  const plan = D.selectPlan(parsed);
  assert.equal(plan.audioOnly, true);
  assert.equal(plan.videoOnly, false);
});

test("MPD-level BaseURL is inherited by periods and segments", () => {
  const mpd = `<MPD mediaPresentationDuration="PT2S">
    <BaseURL>https://media.example.com/root/</BaseURL>
    <Period><AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="1" duration="1" startNumber="1"
        initialization="init-$RepresentationID$.mp4" media="seg-$Number$.m4s"/>
      <Representation id="v" bandwidth="1000"/>
    </AdaptationSet></Period></MPD>`;
  const parsed = D.parseMpd(mpd, "https://cdn.example.com/manifest.mpd");
  const track = parsed.tracks[0];
  assert.equal(track.initUrl, "https://media.example.com/root/init-v.mp4");
  assert.deepEqual(track.segments.map(item => item.url), [
    "https://media.example.com/root/seg-1.m4s",
    "https://media.example.com/root/seg-2.m4s"
  ]);
});

test("selectPlan honors bandwidth and rejects unknown qualities", () => {
  const mpd = `<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4">
    <Representation id="low" bandwidth="500" height="360"><BaseURL>low.mp4</BaseURL></Representation>
    <Representation id="high" bandwidth="2000" height="1080"><BaseURL>high.mp4</BaseURL></Representation>
  </AdaptationSet></Period></MPD>`;
  const parsed = D.parseMpd(mpd, base);
  assert.match(D.selectPlan(parsed).video.base, /high\.mp4$/);
  assert.match(D.selectPlan(parsed, { bandwidth: 500, height: 360 }).video.base, /low\.mp4$/);
  assert.throws(() => D.selectPlan(parsed, { bandwidth: 999, height: 720 }), /DASH_UNSUPPORTED/);
});

test("parseMpd rejects DRM, live, multi-period and unsafe XML", () => {
  const video = `<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>`;
  const protectedSet = `<AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></AdaptationSet>`;
  assert.throws(() => D.parseMpd(`<MPD mediaPresentationDuration="PT1S"><Period>${protectedSet}${video}</Period></MPD>`, base), /DASH_ENCRYPTED/);
  assert.throws(() => D.parseMpd(`<MPD type="dynamic"><Period>${video}</Period></MPD>`, base), /DASH_LIVE/);
  assert.throws(() => D.parseMpd(`<MPD mediaPresentationDuration="PT2S"><Period>${video}</Period><Period>${video}</Period></MPD>`, base), /DASH_UNSUPPORTED/);
  assert.throws(() => D.parseMpd(`<!DOCTYPE x [<!ENTITY y "z">]><MPD><Period>${video}</Period></MPD>`, base), /DASH_UNSUPPORTED/);
  assert.throws(() => D.parseMpd(`<MPD><Period></Period></MPD>`, base), /DASH_UNSUPPORTED/);
});

test("parseMpd rejects empty or malformed templates", () => {
  assert.throws(() => D.parseMpd(`<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`, base), /DASH_UNSUPPORTED/);
  assert.throws(() => D.parseMpd(`<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentTemplate media="x-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`, base), /DASH_UNSUPPORTED/);
  assert.throws(() => D.parseMpd(`<MPD mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentTemplate media="x.m4s" duration="0"/></Representation></AdaptationSet></Period></MPD>`, base), /DASH_UNSUPPORTED/);
});
