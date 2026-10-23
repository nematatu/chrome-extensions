"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const hls = require("../hls.js"), mp4 = require("../mp4.js"), muxjs = require("./mux.cjs");
const URL_BASE = "https://vid.fun800.click/", DIR = path.join(__dirname, "fixtures");
const dependencies = {mp4, muxjs};
const fixtureFetch = async url => new Response(fs.readFileSync(path.join(DIR, new URL(url).pathname.split("/").pop())));
const flatten = boxes => Array.from(boxes).flatMap(box => [box, ...flatten(box.boxes || [])]);
async function inspect(name = "generated.m3u8", extra = {}) {
  const blob = await hls.assemble(URL_BASE + name, {...dependencies, fetch: fixtureFetch, ...extra});
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {blob, bytes, boxes: muxjs.mp4.tools.inspect(bytes)};
}

test("保存用MP4に確定した時間・サンプル索引を作り、配信用の未確定時間と空の表を残さない", async () => {
  const result = await inspect(), entries = flatten(result.boxes);
  assert.deepEqual(Array.from(result.boxes, box => box.type), ["ftyp", "mdat", "moov"]);
  const movie = entries.find(box => box.type === "mvhd");
  assert.equal(movie.timescale, 1000); assert.ok(movie.duration >= 2000 && movie.duration < 2200);
  for (const box of entries.filter(box => ["mvhd", "tkhd", "mdhd"].includes(box.type))) {
    assert.ok(box.duration > 0 && box.duration !== 0xffffffff);
  }
  const sampleCounts = entries.filter(box => box.type === "stts")
    .map(box => box.timeToSamples.reduce((sum, row) => sum + row.sampleCount, 0));
  assert.deepEqual(sampleCounts.sort((a,b) => a-b), [20, 88]);
  for (const box of entries.filter(box => box.type === "stco")) {
    assert.ok(box.chunkOffsets.length > 0);
    assert.ok(box.chunkOffsets.every(offset => offset >= 32 && offset < result.boxes[1].size + 24));
  }
  const sync = entries.find(box => box.type === "stss");
  assert.ok(sync); assert.equal(sync.syncSamples[0], 1);
  assert.ok(entries.some(box => box.type === "ctts"), "B-frame presentation offsets must be retained");
});

test("20時間の開始時刻を持つ8秒のTS入力も、再生時間8秒の通常MP4へ変換する", async () => {
  const result = await inspect("offset.m3u8"), entries = flatten(result.boxes);
  const movie = entries.find(box => box.type === "mvhd");
  assert.ok(movie.duration >= 8000 && movie.duration < 8300);
  const video = entries.find(box => box.type === "mdhd" && box.timescale === 90000);
  assert.equal(video.duration, 720000);
  assert.equal(entries.find(box => box.type === "stts").timeToSamples.reduce((sum, row) => sum + row.sampleCount, 0), 80);
  assert.ok(entries.filter(box => box.type === "tkhd").every(box => box.duration < 8300));
});

test("一覧と映像の長さが違う入力や、途中で時刻が飛ぶ入力は保存完了にしない", async () => {
  let finished = false;
  const output = {async write() {}, async finish() {finished = true;}};
  await assert.rejects(hls.assemble(URL_BASE + "offset.m3u8", {...dependencies, output, fetch: async url => {
    if (url.endsWith("offset.m3u8")) return new Response(fs.readFileSync(path.join(DIR, "offset.m3u8"), "utf8")
      .replaceAll("#EXTINF:1.000000", "#EXTINF:2.000000"));
    return fixtureFetch(url);
  }}), /HLS_INVALID_TIMELINE/);
  assert.equal(finished, false);
  await assert.rejects(hls.assemble(URL_BASE + "offset.m3u8", {...dependencies, fetch: url =>
    fixtureFetch(url.replace("offset-01.ts", "offset-05.ts"))}), /HLS_INVALID_TIMELINE/);
});

test("断片を最大4件同時に読み、到着順が違っても映像の順番とサンプル数を保持する", async () => {
  let active = 0, maximum = 0;
  const arrivals = [], progress = [];
  const result = await inspect("offset.m3u8", {fetch: async (url, options) => {
    if (!url.endsWith(".ts")) return fixtureFetch(url);
    const index = Number(url.match(/offset-(\d+)\.ts$/)[1]);
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, index === 0 ? 40 : 5);
      options.signal.addEventListener("abort", () => {clearTimeout(timer); reject(new Error("fixture canceled"));}, {once:true});
    });
    active--; arrivals.push(index); return fixtureFetch(url);
  }, progress: event => progress.push(event.completed)});
  assert.equal(maximum, 4); assert.equal(active, 0); assert.notEqual(arrivals[0], 0);
  assert.deepEqual(progress, [1,2,3,4,5,6,7,8]);
  const entries = flatten(result.boxes), movie = entries.find(box => box.type === "mvhd");
  assert.ok(movie.duration >= 8000 && movie.duration < 8300);
  assert.equal(entries.find(box => box.type === "stts").timeToSamples.reduce((sum,row) => sum+row.sampleCount,0),80);
});

test("並列取得のレート制限では残りも中断し、一時メモリーを解放して保存を始めない", async () => {
  let active = 0, aborted = 0, reserved = 0, finished = false;
  await assert.rejects(hls.assemble(URL_BASE + "offset.m3u8", {...dependencies,
    reserve(bytes) {reserved += bytes; assert.ok(reserved >= 0);},
    output: {async write() {}, async finish() {finished = true;}},
    fetch: async (url, options) => {
      if (!url.endsWith(".ts")) return fixtureFetch(url);
      if (url.endsWith("offset-02.ts")) return new Response("", {status:429});
      active++;
      try {
        await new Promise((resolve,reject) => {
          const timer = setTimeout(resolve, 100);
          options.signal.addEventListener("abort", () => {aborted++; clearTimeout(timer); reject(new Error("fixture canceled"));}, {once:true});
        });
        return fixtureFetch(url);
      } finally {active--;}
    }}), /RATE_LIMITED/);
  assert.equal(active,0); assert.equal(aborted,3); assert.equal(reserved,0); assert.equal(finished,false);
});

test("MP4生成で入力の箱サイズ・トラック・サンプル数が不正なら大きな配列を作らず拒否する", () => {
  const transmuxer = new muxjs.mp4.Transmuxer({remux:true}); let segment;
  transmuxer.on("data", value => {segment = value;});
  transmuxer.push(new Uint8Array(fs.readFileSync(path.join(DIR,"generated-00.ts"))));transmuxer.flush();transmuxer.dispose();
  const malformedInit = segment.initSegment.slice();new DataView(malformedInit.buffer).setUint32(0,0xffffffff);
  assert.throws(() => mp4.create().add(malformedInit,segment.data), /HLS_BAD_SEGMENT/);
  const malformedData = segment.data.slice(), trun = Buffer.from(malformedData).indexOf(Buffer.from("trun"));
  new DataView(malformedData.buffer).setUint32(trun+8,0xffffffff);
  assert.throws(() => mp4.create().add(segment.initSegment,malformedData), /HLS_BAD_SEGMENT/);
});

test("可変フレームレートの境界を次のDTSで確定し、全154フレームを通常MP4へ保持する", async () => {
  const result = await inspect("vfr/vfr.m3u8", {fetch: async url => new Response(
    fs.readFileSync(path.join(DIR, new URL(url).pathname.slice(1))))});
  const entries=flatten(result.boxes);
  const times=entries.find(box=>box.type==="stts");
  assert.equal(times.timeToSamples.reduce((sum,row)=>sum+row.sampleCount,0),154);
  assert.ok(new Set(times.timeToSamples.map(row=>row.sampleDelta)).size>1);
  assert.ok(entries.find(box=>box.type==="mvhd").duration<6200);
  assert.deepEqual(Array.from(result.boxes,box=>box.type),["ftyp","mdat","moov"]);
});

test("音声が約2秒で終わっても、残りを含む6秒・180フレームの映像を保存する", async () => {
  const result=await inspect("short-audio/test.m3u8", {fetch:async url=>new Response(
    fs.readFileSync(path.join(DIR,new URL(url).pathname.slice(1))))});
  const entries=flatten(result.boxes);
  assert.ok(entries.find(box=>box.type==="mvhd").duration>=6000 && entries.find(box=>box.type==="mvhd").duration<6050);
  assert.equal(entries.find(box=>box.type==="mdhd"&&box.timescale===90000).duration,540000);
  const counts=entries.filter(box=>box.type==="stts").map(box=>box.timeToSamples.reduce((sum,row)=>sum+row.sampleCount,0));
  assert.deepEqual(counts.sort((a,b)=>a-b),[88,180]);
});

test("別出力トラックの結合でもコーデック情報の変更と映像なしの入力は拒否する",()=>{
  const transmuxer=new muxjs.mp4.Transmuxer({remux:false}),segments=[];
  transmuxer.on("data",value=>segments.push(value));
  transmuxer.push(new Uint8Array(fs.readFileSync(path.join(DIR,"generated-00.ts"))));transmuxer.flush();transmuxer.dispose();
  const video=segments.find(s=>s.type==="video"),audio=segments.find(s=>s.type==="audio");
  const file=mp4.create();file.add(video.initSegment,video.data);file.add(audio.initSegment,audio.data);
  const changed=video.initSegment.slice();const offset=Buffer.from(changed).indexOf("avcC");assert.ok(offset>0);changed[offset+5]^=1;
  assert.throws(()=>file.add(changed,video.data),/HLS_BAD_SEGMENT/);file.dispose();
  const noVideo=mp4.create();noVideo.add(audio.initSegment,audio.data);
  assert.throws(()=>noVideo.finish(1),/HLS_BAD_SEGMENT/);noVideo.dispose();
});
