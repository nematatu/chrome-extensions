"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
const http = require("node:http"), os = require("node:os"), path = require("node:path");
const core = require("../core.js"), hls = require("../hls.js"), collect = require("../hosted-collector.js");
const {createHarness} = require("./harness.cjs");
const {createOpfsFixture} = require("./opfs.cjs");
globalThis.muxjs = require("./mux.cjs");
globalThis.PageMediaMp4 = require("../mp4.js");
const segment1 = fs.readFileSync(path.join(__dirname, "fixtures/generated-00.ts"));
const segment2 = fs.readFileSync(path.join(__dirname, "fixtures/generated-01.ts"));
const HOST = "https://vid.fun800.click", PAGE = "https://video.twimg1.com/Fixture001";
const MASTER = HOST + "/generated/master.m3u8";
const master = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS=\"avc1.64001f,mp4a.40.2\",CLOSED-CAPTIONS=NONE\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nhigh.m3u8\n";
const media = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\npart1.ts\n#EXTINF:1.0,\npart2.ts\n#EXT-X-ENDLIST\n";
const packet = marker => {
  const result = new Uint8Array(188); result.fill(marker); result[0] = 0x47; result[1] = 0x01; result[2] = 0; result[3] = 0x10;
  return result;
};
function syntheticFetch(value) {
  const url = new URL(value);
  if (url.pathname.endsWith("master.m3u8")) return new Response(master);
  if (url.pathname.endsWith("high.m3u8")) return new Response(media);
  if (url.pathname.endsWith("part1.ts")) return new Response(segment1);
  if (url.pathname.endsWith("part2.ts")) return new Response(segment2);
  throw new Error("unexpected synthetic resource");
}
function apiResponse(value) { return new Response(JSON.stringify({code: 0, data: value}), {headers: {"content-type": "application/json"}}); }
function detail(name = "generated-scene", channelName = "Generated channel") {
  return {info: {netDiskInfo: {name, isFolder: false, fileUrl: MASTER, fileSize: 12345}, extraInfo: {channelName, externalLinks:"Channel001"}}, rules: {status: "0"}};
}
function hostedFetch(value, main = detail(), transport = syntheticFetch) {
  const url = new URL(value);
  if (url.pathname.endsWith("/getInfo")) return apiResponse(main);
  if (url.pathname.endsWith("/list_by_links_page")) return apiResponse({list:[main.info.netDiskInfo],total:1});
  return transport(value);
}
function snapshot(origin = "https://video.twimg1.com", playerName = "Generated channel-generated-scene") {
  return {ok: true, scanType: "hosted-api", pageUrl: origin + "/Fixture001", title: "Generated scene",
    visibleRows: [{name: "generated-scene", isFolder: false}], playerName};
}
async function startHls(count = 1) {
  const snap = snapshot(); const h = createHarness(snap);
  h.sender.url = snap.pageUrl; h.sender.tab.url = snap.pageUrl;
  h.setApiFetch(value => hostedFetch(value));
  if (count > 1) {
    snap.playerName = ""; h.discovery.playerName = "";
    const entries = Array.from({length: count}, (_, i) => ({name: "generated-scene-" + i, id: "id-" + i,
      isFolder: false, fileUrl: HOST + "/generated/" + i + "/master.m3u8"}));
    h.discovery.visibleRows = entries.map(({name}) => ({name, isFolder: false}));
    h.setApiFetch(value => {
      const url = new URL(value);
      if (url.pathname.endsWith("/getInfo")) return apiResponse({info: {netDiskInfo: {name: "Generated folder", isFolder: true}}});
      if (url.pathname.endsWith("/list_by_links_page")) return apiResponse({list: entries, total: entries.length});
      return syntheticFetch(value);
    });
  }
  const result = await h.send({type: "page-media-bulk:start"}); assert.equal(result.ok, true);
  const batch = Object.values(h.getCachedState().batches)[0];
  return {h, batch, item: batch.items[0], result};
}
function ready(item) { return {token: item.hls.token, phase: "ready", format:"mp4", mp4Version:2, blobUrl: "blob:chrome-extension://test-extension-id/" + crypto.randomUUID(), size: 376}; }

test("HLSは固定配信ホスト・指定サイトだけを許可し、最高帯域の音声一体型TSを選ぶ", async () => {
  assert.equal(core.isAllowedDownloadUrl(MASTER, PAGE), true);
  assert.equal(core.isAllowedDownloadUrl(MASTER), false);
  assert.equal(core.isAllowedDownloadUrl(MASTER, "https://video.twimg.news/d/10001/"), false);
  assert.equal(core.isHostedHlsUrl(MASTER.replace("vid.fun800.click", "other.example.com"), PAGE), false);
  const calls = [];
  const plan = await hls.loadPlan(MASTER, {fetch: (url, options) => {calls.push({url, options}); return syntheticFetch(url);}});
  assert.equal(plan.segments.length, 2); assert.equal(plan.segments[1].duration, 1);
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ["/generated/master.m3u8", "/generated/high.m3u8"]);
  for (const call of calls) {
    assert.equal(call.options.credentials, "omit"); assert.equal(call.options.redirect, "error");
    assert.equal(call.options.referrerPolicy, "no-referrer");
  }
});

test("HLSの暗号化・ライブ・分離音声・fMP4・バイト範囲・不連続・外部URLを拒否する", () => {
  for (const value of [media.replace("#EXT-X-ENDLIST", ""), media.replace("#EXTINF:", "#EXT-X-DISCONTINUITY\n#EXTINF:"),
    media.replace("#EXTINF:", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:'),
    media.replace("#EXTINF:", '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:'), media.replace("#EXTINF:", "#EXT-X-BYTERANGE:188@0\n#EXTINF:"),
    media.replace("part1.ts", "https://localhost/private.ts"), media.replace("part1.ts", "https://other.example.com/part1.ts"),
    media.replace("part1.ts", "https://user:secret@vid.fun800.click/part1.ts"), media.replace("part1.ts", "part1.ts#fragment"),
    media.replace("part1.ts", "part1%00.ts"), media.replace("part1.ts", "part1.m4s"), master.replace("BANDWIDTH=500000", 'BANDWIDTH=500000,AUDIO="audio"'),
    "<html>error</html>", media.replace("#EXTINF:1.0,", "#EXTINF:NaN,"), media.replace("#EXTINF:1.0,", "#EXTINF:1.0,\n#EXTINF:1.0,")]) {
    assert.throws(() => hls.parsePlaylist(value, MASTER), /HLS_UNSUPPORTED/);
  }
  assert.equal(hls.parsePlaylist(media.replace("#EXTINF:1.0,", "#EXT-X-KEY:METHOD=NONE\n#EXTINF:1.0,"), MASTER).segments.length, 2);
});

test("TS断片を映像・音声のある本物のMP4へ変換し、HTML・壊れた断片・取得失敗を保存しない", async () => {
  const events = [];
  const blob = await hls.assemble(MASTER, {fetch: syntheticFetch, progress: e => events.push(e)});
  assert.equal(blob.type, "video/mp4");
  const output = Buffer.from(await blob.arrayBuffer());
  assert.equal(output.toString("ascii",4,8),"ftyp");
  for(const box of ["moov","mdat","avc1","mp4a","stts","stsz","stco"]) assert.ok(output.includes(Buffer.from(box)),box);
  assert.ok(!output.includes(Buffer.from("moof")));
  assert.notDeepEqual(output,Buffer.concat([segment1,segment2]));
  assert.equal(muxjs.mp4.probe.videoTrackIds(output).length,1);
  assert.deepEqual(events.map(e => e.completed), [1, 2]); assert.equal(events[1].bytes, segment1.length+segment2.length);
  for (const bad of [new TextEncoder().encode("<html>expired</html>"), new Uint8Array(188), packet(0).slice(1)]) {
    await assert.rejects(hls.assemble(MASTER, {fetch: value => value.endsWith("part2.ts") ? new Response(bad) : syntheticFetch(value)}), /HLS_BAD_SEGMENT/);
  }
  await assert.rejects(hls.assemble(MASTER, {fetch: value => value.endsWith("part2.ts") ? new Response("", {status: 429}) : syntheticFetch(value)}), /RATE_LIMITED/);
  await assert.rejects(hls.assemble(MASTER, {fetch:value=>value.endsWith("part1.ts")?new Response(packet(1)):syntheticFetch(value)}), /HLS_BAD_SEGMENT/);
});

test("HLSのサイズ・分割数・取得中断・マスター循環を制限する", async () => {
  const many = "#EXTM3U\n" + "#EXTINF:4,\npart.ts\n".repeat(5001) + "#EXT-X-ENDLIST";
  assert.throws(() => hls.parsePlaylist(many, MASTER), /HLS_TOO_LARGE/);
  await assert.rejects(hls.loadPlan(MASTER, {fetch: () => new Response(master, {headers: {"content-length": 1048577}})}), /HLS_TOO_LARGE/);
  await assert.rejects(hls.loadPlan(MASTER, {fetch: () => new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmaster.m3u8")}), /HLS_UNSUPPORTED/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(hls.assemble(MASTER, {signal: controller.signal, fetch: async (_, options) => {
    assert.equal(options.signal.aborted, true); throw new Error("synthetic abort");
  }}), /HLS_CANCELED/);
  await assert.rejects(hls.assemble(MASTER, {fetch: syntheticFetch, reserve() {throw new Error("HLS_RESOURCE_LIMIT");}}), /HLS_RESOURCE_LIMIT/);
});

test("3サイトのHLS個別タイトルを照合し、一覧APIからMP4の保存項目を収集する", async () => {
  for (const origin of ["https://twfiles.com", "https://video.twimg1.com", "https://gofile.run"]) {
    const snap = snapshot(origin, origin.includes("twimg1") ? "Generated channel-generated-scene" : "generated-scene");
    const calls = [];
    const result = await collect(snap, {core, hls, fetch: value => {calls.push(value);
      return hostedFetch(value);
    }});
    assert.equal(result.ok, true); assert.equal(result.videos.length, 1); assert.equal(result.videos[0].name, "generated-scene.mp4");
    assert.equal(result.videos[0].mimetype, "video/mp4"); assert.equal(result.videos[0].size, 0);
    assert.equal(calls.length, 2); assert.ok(calls.some(url => url.includes("list_by_links_page")));
    assert.ok(calls.every(url => new URL(url).origin !== HOST));
    const wrong = await collect({...snap, playerName: "Different channel-generated-scene"}, {core, hls,
      fetch: () => apiResponse(detail())});
    assert.equal(wrong.error, "SITE_LIST_MISMATCH");
  }
});

test("一覧収集ではHLSを重複取得せず、保存直前に形式を確認し、直接MP4もあるときはMP4を優先する", async () => {
  const snap = snapshot("https://twfiles.com", "generated-scene");
  const unsupported = await collect(snap, {core, hls, fetch: value => hostedFetch(value,detail(),
    () => new Response(media.replace("#EXTINF:", '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n#EXTINF:')))});
  assert.equal(unsupported.ok, true); assert.equal(unsupported.videos.length, 1);
  await assert.rejects(hls.assemble(unsupported.videos[0].link, {fetch: () =>
    new Response(media.replace("#EXTINF:", '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n#EXTINF:'))}), /HLS_UNSUPPORTED/);
  const main = detail(); main.info.netDiskInfo.downloadUrl = "https://media.example.com/generated/scene.mp4";
  const result = await collect(snap, {core, hls, fetch: value => hostedFetch(value,main)});
  assert.equal(result.ok, true); assert.equal(result.videos[0].link, main.info.netDiskInfo.downloadUrl);
});

test("HLS取得は全体4件の並列枠を使い、進捗とブラウザー保存を1件として扱う", async () => {
  const {h, batch, item, result} = await startHls(6);
  assert.equal(result.batch.summary.downloading, 4); assert.equal(result.batch.summary.queued, 2);
  assert.equal(h.hlsJobs.size, 4); assert.equal(h.downloadCalls.length, 0);
  const progress = await h.sendHls({token: item.hls.token, phase: "collecting", bytes: 188, completed: 1, total: 2});
  assert.equal(progress.active, true);
  assert.equal((await h.send({type: "page-media-bulk:status"})).batch.items.find(i => i.id === item.id).progress, 45);
  const prepared = ready(item); h.hlsJobs.set(item.hls.token, {ok: true, present: true, ...prepared});
  const native = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => {
    const id = await native(options), download = h.downloads.get(id);
    download.filename = "/Downloads/" + prepared.blobUrl.split("/").at(-1) + ".mp4";
    const suggestion = await h.determineFilename(download);
    assert.equal(suggestion.filename, "PageMedia/Generated folder/generated-scene-0.mp4");
    download.filename = "/Downloads/" + suggestion.filename;
    return id;
  };
  await h.sendHls(prepared);
  assert.equal(h.downloadCalls.length, 1); assert.equal(h.downloadCalls[0].url, prepared.blobUrl);
  assert.equal(item.size, prepared.size);
  assert.match(h.downloadCalls[0].filename, /^PageMedia\/Generated folder\/generated-scene-0\.mp4$/);
  assert.equal(h.hlsJobs.size, 4);
  Object.assign(h.downloads.get(item.downloadId), {state: "complete", mime: "video/mp4", bytesReceived: 376, totalBytes: 376});
  await h.emitChanged(item.downloadId, "complete");
  assert.equal(item.status, "complete"); assert.equal(item.url, null); assert.equal(h.hlsJobs.has(item.hls.token), false);
  assert.equal(batch.items.filter(i => ["starting", "downloading"].includes(i.status)).length, 4);
});

test("HLSの取得中にキャンセルでき、完了直前の古い通知から保存を始めない", async () => {
  const {h, item, batch} = await startHls(); const prepared = ready(item);
  const result = await h.send({type: "page-media-bulk:cancel", batchId: batch.id});
  assert.equal(result.batch.summary.canceled, 1); assert.equal(h.hlsJobs.size, 0);
  assert.equal((await h.sendHls(prepared)).active, false); assert.equal(h.downloadCalls.length, 0);
});

test("1.5の1本・TSキューを再利用せず、上部ボタンから一覧全件のMP4保存へ切り替える", async () => {
  const {h,batch,item} = await startHls();
  delete batch.savingScope; item.name="generated-scene.ts"; delete item.hls.format;
  await h.persistCachedState(); h.resetWorkerCache();
  const list=[detail().info.netDiskInfo,{...detail("generated-scene-2").info.netDiskInfo,fileUrl:HOST+"/generated/second/master.m3u8"}];
  h.discovery.visibleRows=list.map(({name})=>({name,isFolder:false}));
  h.setApiFetch(value=>new URL(value).pathname.endsWith("/list_by_links_page")?apiResponse({list,total:2}):hostedFetch(value));
  const result=await h.send({type:"page-media-bulk:start"});
  assert.equal(result.ok,true); assert.equal(result.reused,false); assert.equal(result.batch.summary.total,2);
  assert.notEqual(result.batch.id,batch.id); assert.equal(h.hlsJobs.has(item.hls.token),false);
  assert.ok(result.batch.items.every(i=>i.name.endsWith(".mp4"))); assert.equal(h.downloadCalls.length,0);
});

test("1.5の失敗分再試行でも一覧を取り直し、1本だけの保存を繰り返さない", async () => {
  const {h,batch,item}=await startHls();
  await h.sendHls({token:item.hls.token,phase:"failed",error:"HLS_FETCH_FAILED"});
  delete batch.savingScope; await h.persistCachedState(); h.resetWorkerCache();
  const result=await h.send({type:"page-media-bulk:retry",batchId:batch.id});
  assert.equal(result.ok,true); assert.notEqual(result.batch.id,batch.id);
  assert.equal(result.batch.items[0].name,"generated-scene.mp4");
});

test("1.6の配信用MP4キューと完成通知を再利用せず、通常MP4の新しいキューへ切り替える", async () => {
  const {h,batch,item}=await startHls();
  batch.savingScope="hosted-list-mp4-v1";delete item.hls.mp4Version;
  assert.equal((await h.sendHls({...ready(item),mp4Version:undefined})).ok,false);
  assert.equal(h.downloadCalls.length,0);
  await h.persistCachedState();h.resetWorkerCache();
  const result=await h.send({type:"page-media-bulk:start"});
  assert.equal(result.ok,true);assert.notEqual(result.batch.id,batch.id);
  assert.equal(result.batch.summary.total,1);assert.equal(h.hlsJobs.has(item.hls.token),false);
  const current=h.getCachedState().batches[result.batch.id];
  assert.equal(current.savingScope,"hosted-list-mp4-v2");assert.equal(current.items[0].hls.mp4Version,2);
});

test("MP4を一時出力へ順番に書き、取得済み動画全体をメモリに保持しない", async () => {
  const chunks=[]; let reserved=0,peak=0,position=0;
  const blob=await hls.assemble(MASTER,{fetch:syntheticFetch,reserve(bytes){reserved+=bytes;peak=Math.max(peak,reserved);assert.ok(reserved>=0);},
    output:{async write(data,offset=position){chunks.push({offset,data:Buffer.from(data)});position=offset+data.length;},async finish(){
      const bytes=Buffer.alloc(Math.max(...chunks.map(chunk=>chunk.offset+chunk.data.length)));
      for(const chunk of chunks)chunk.data.copy(bytes,chunk.offset);return new Blob([bytes],{type:"video/mp4"});}}});
  assert.equal(reserved,0); assert.ok(peak<128*1024);
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString("ascii",4,8),"ftyp");
  await assert.rejects(hls.assemble(MASTER,{fetch:syntheticFetch,output:{async write(){throw new Error("HLS_STORAGE_FAILED");}}}),/HLS_STORAGE_FAILED/);
});

test("HLSの失敗分だけ再取得し、Worker再起動では取得中・保存中の同じ処理へ接続する", async () => {
  const {h, item, batch} = await startHls(); const token = item.hls.token;
  h.resetWorkerCache();
  assert.equal((await h.send({type: "page-media-bulk:status"})).batch.status, "active");
  assert.equal(h.hlsCalls.filter(c => c.action === "start").length, 1);
  await h.sendHls({token, phase: "failed", error: "HLS_FETCH_FAILED"});
  assert.equal((await h.send({type: "page-media-bulk:status"})).batch.summary.failed, 1);
  await h.send({type: "page-media-bulk:retry", batchId: batch.id});
  const restored = Object.values(h.getCachedState().batches)[0].items[0];
  assert.notEqual(restored.hls.token, token); assert.equal(h.downloadCalls.length, 0);
  assert.equal((await h.sendHls(ready({...item, hls: {token}}))).active, false);
  const prepared = ready(restored); h.hlsJobs.set(restored.hls.token, {ok: true, present: true, ...prepared});
  await h.sendHls(prepared); h.resetWorkerCache();
  assert.equal((await h.send({type: "page-media-bulk:status"})).batch.status, "active");
  await h.sendHls(prepared); assert.equal(h.downloadCalls.length, 1);
});

test("HLS処理が消えた場合は再試行へ移り、Blobを保存した直後のWorker停止でも二重保存しない", async () => {
  const {h, item} = await startHls(); h.loseOffscreen(); h.resetWorkerCache();
  const lost = (await h.send({type: "page-media-bulk:status"})).batch;
  assert.equal(lost.summary.failed, 1); assert.equal(lost.items[0].error, "HLS_STATE_LOST");
  const next = await startHls(); const prepared = ready(next.item);
  next.h.hlsJobs.set(next.item.hls.token, {ok: true, present: true, ...prepared});
  next.h.setStorageSetFailure(values => Object.values(values).some(v => v?.downloadId != null));
  assert.equal((await next.h.sendHls(prepared)).ok, false);
  assert.equal(next.h.downloadCalls.length, 1); next.h.resetWorkerCache();
  await next.h.send({type: "page-media-bulk:status"});
  assert.equal(next.h.downloadCalls.length, 1);
});

test("HLSのBlob通知はoffscreenだけを許可し、外部Blob・サイズ不正・ページからの通知を拒否する", async () => {
  const {h, item} = await startHls(); const prepared = ready(item);
  assert.equal((await h.sendHls(prepared, h.sender)).error, "UNTRUSTED_PAGE");
  for (const patch of [{blobUrl: "blob:https://vid.fun800.click/" + crypto.randomUUID()},
    {blobUrl: "https://media.example.com/scene.mp4"}, {blobUrl: prepared.blobUrl + "/extra"}, {size: -1}, {size: hls.MAX_FILE_BYTES + 1},
    {format:undefined}, {format:"ts"}, {mp4Version:undefined}, {mp4Version:1}]) {
    assert.equal((await h.sendHls({...prepared, ...patch})).ok, false);
  }
  assert.equal(h.downloadCalls.length, 0);
  assert.equal((await h.sendHls({...prepared,size:700*1024*1024})).ok,true);
  assert.equal(h.downloadCalls.length,1); assert.equal(item.size,700*1024*1024);
  assert.ok(h.downloadCalls[0].filename.endsWith(".mp4"));
});

test("offscreen本体がMP4のBlobを通知し、キャンセル時にBlobと一時領域を解放する", async () => {
  const tasks = new Map(), blobs = new Map(), messages = [], timers = [];
  const stale = crypto.randomUUID() + ".mp4", opfs = createOpfsFixture({[stale]:Buffer.from("stale"),"keep.dat":Buffer.from("keep")});
  class FixtureURL extends URL {
    static createObjectURL(blob) {const url = "blob:chrome-extension://test-extension-id/" + crypto.randomUUID(); blobs.set(url, blob); return url;}
    static revokeObjectURL(url) {blobs.delete(url);}
  }
  const context = vm.createContext({window:{}, navigator:opfs.navigator, URL: FixtureURL, Blob, TextDecoder, Uint8Array, AbortController, fetch: syntheticFetch,
    setTimeout, clearTimeout, setInterval(fn) {timers.push(fn); return 1;}, clearInterval() {}, chrome: {runtime: {
      id: "test-extension-id", getURL: file => "chrome-extension://test-extension-id/" + file,
      onMessage: {addListener: fn => tasks.set("listener", fn)},
      async sendMessage(message) {messages.push(message); return {ok: true, active: true};},
    }}});
  for (const file of ["core.js", "vendor/mux.min.js", "mp4.js", "hls.js", "offscreen.js"]) vm.runInContext(fs.readFileSync(require.resolve("../" + file), "utf8"), context);
  const token = crypto.randomUUID(), sender = {id: "test-extension-id", url: "chrome-extension://test-extension-id/background.js"};
  const send = (action, customSender = sender) => new Promise(resolve => tasks.get("listener")({target: "offscreen", action, token, url: MASTER, pageUrl: PAGE}, customSender, resolve));
  try {
    assert.equal((await send("start", {...sender, tab: {id: 42}})).ok, false);
    assert.equal((await send("start")).ok, true);
    for (let i = 0; i < 100 && !messages.some(m => m.phase === "ready"); i++) await new Promise(resolve => setTimeout(resolve, 2));
    const completed = messages.find(m => m.phase === "ready"); assert.ok(completed);
    assert.equal(completed.format,"mp4"); assert.equal(blobs.get(completed.blobUrl).type,"video/mp4");
    assert.equal(Buffer.from(await blobs.get(completed.blobUrl).arrayBuffer()).toString("ascii",4,8),"ftyp");
    assert.equal(vm.runInContext("bufferedBytes",context),0); assert.equal(opfs.files.has(stale),false);
    assert.equal(opfs.files.has(token+".mp4"),true);
    assert.equal((await send("query")).phase, "ready");
    assert.equal((await send("cancel")).ok, true); assert.equal(blobs.size, 0);
    assert.equal(vm.runInContext("bufferedBytes", context), 0); assert.equal((await send("query")).present, false);
    assert.deepEqual([...opfs.files.keys()],["keep.dat"]);
    messages.length=0; opfs.failWrite(true);
    await send("start");
    for(let i=0;i<100&&!messages.some(m=>m.phase==="failed");i++) await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(messages.find(m=>m.phase==="failed")?.error,"HLS_STORAGE_FAILED");
    assert.equal(vm.runInContext("bufferedBytes",context),0); assert.deepEqual([...opfs.files.keys()],["keep.dat"]);
    await send("cancel"); opfs.failWrite(false);
    let readStarted;
    const reading=new Promise(resolve=>{readStarted=resolve;});
    context.fetch=async(value,options)=>value.endsWith("part1.ts")?new Response(new ReadableStream({start(controller){
      options.signal.addEventListener("abort",()=>controller.error(new Error("fixture canceled")),{once:true});
      controller.enqueue(segment1.subarray(0,188)); readStarted();
    }})):syntheticFetch(value);
    messages.length=0; await send("start"); await reading;
    await send("cancel");
    assert.equal(vm.runInContext("bufferedBytes",context),0); assert.equal(blobs.size,0);
    assert.deepEqual([...opfs.files.keys()],["keep.dat"]);
    assert.ok(!messages.some(m=>m.phase==="ready"));
  } finally { await send("cancel"); }
});

test("個別ページの一覧3本をHTTP取得し、offscreen・保存ワーカー経由で3本すべてをMP4で保存する", async () => {
  const fixtures = path.join(__dirname, "fixtures");
  const server = http.createServer((request, response) => {
    const name = path.basename(new URL(request.url, "http://127.0.0.1").pathname);
    if (!["generated.m3u8", "generated-00.ts", "generated-01.ts"].includes(name)) {response.writeHead(404); response.end(); return;}
    response.writeHead(200, {"content-type": name.endsWith(".ts") ? "video/mp2t" : "application/vnd.apple.mpegurl"});
    response.end(fs.readFileSync(path.join(fixtures, name)));
  });
  await new Promise((resolve, reject) => {server.once("error", reject); server.listen(0, "127.0.0.1", resolve);});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-media-hls-")), blobs = new Map();
  const snap = snapshot(); snap.title = "TestSamples"; snap.playerName = "TestSamples-generated-scene";
  const entries = Array.from({length:3},(_,i)=>({id:"generated-"+i,name:"generated-scene"+(i?"-"+i:""),isFolder:false,
    fileUrl:HOST+"/generated-"+i+"/generated.m3u8"}));
  snap.visibleRows = entries.map(({name})=>({name,isFolder:false}));
  const h = createHarness(snap); h.sender.url = snap.pageUrl; h.sender.tab.url = snap.pageUrl;
  const main = detail("generated-scene","TestSamples"); main.info.netDiskInfo.fileUrl = entries[0].fileUrl;
  const transportFetch = (value, options) => fetch("http://127.0.0.1:" + server.address().port + new URL(value).pathname, options);
  h.setApiFetch((value, options) => {
    const url=new URL(value);
    if(url.pathname.endsWith("/getInfo")) return apiResponse(main);
    if(url.pathname.endsWith("/list_by_links_page")) return apiResponse({list:entries,total:3});
    return transportFetch(value,options);
  });
  class FixtureURL extends URL {
    static createObjectURL(blob) {const url = h.chrome.runtime.getURL(""); const value = "blob:" + url + crypto.randomUUID(); blobs.set(value, blob); return value;}
    static revokeObjectURL(value) {blobs.delete(value);}
  }
  let listener; const saved=[], opfs=createOpfsFixture();
  const context = vm.createContext({window:{}, navigator:opfs.navigator, URL: FixtureURL, Blob, TextDecoder, Uint8Array, AbortController, fetch: transportFetch,
    setTimeout, clearTimeout, setInterval, clearInterval, chrome: {runtime: {
      id: h.chrome.runtime.id, getURL: h.chrome.runtime.getURL,
      onMessage: {addListener: fn => {listener = fn;}}, sendMessage: message => h.sendHls(message),
    }}});
  for (const file of ["core.js", "vendor/mux.min.js", "mp4.js", "hls.js", "offscreen.js"]) vm.runInContext(fs.readFileSync(require.resolve("../" + file), "utf8"), context);
  h.chrome.runtime.sendMessage = message => new Promise(resolve => listener(message,
    {id: h.chrome.runtime.id, url: h.chrome.runtime.getURL("background.js")}, resolve));
  const nativeDownload = h.chrome.downloads.download;
  h.chrome.downloads.download = async options => {
    const blob = blobs.get(options.url); assert.ok(blob);
    const id = await nativeDownload(options), data = Buffer.from(await blob.arrayBuffer());
    const target = path.join(root, options.filename); fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, data, {flag: "wx"}); saved.push(target);
    Object.assign(h.downloads.get(id), {state: "complete", mime: blob.type, bytesReceived: data.length, totalBytes: data.length});
    return id;
  };
  try {
    assert.equal((await h.send({type: "page-media-bulk:start"})).ok, true);
    for (let i = 0; i < 200 && saved.length<3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(saved.length,3,"all list entries must reach the download adapter");
    const completed = (await h.send({type: "page-media-bulk:status"})).batch;
    assert.equal(completed.status, "complete"); assert.equal(completed.summary.percent, 100);
    assert.equal(completed.summary.completed,3);
    assert.deepEqual(saved.map(f=>path.basename(f)).sort(),["generated-scene-1.mp4","generated-scene-2.mp4","generated-scene.mp4"]);
    for(const target of saved) {
      assert.equal(path.dirname(target),path.join(root,"PageMedia","TestSamples"));
      const output=fs.readFileSync(target);
      assert.equal(output.toString("ascii",4,8),"ftyp");
      for(const box of ["moov","mdat","avc1","mp4a","stts","stsz","stco"]) assert.ok(output.includes(Buffer.from(box)),box);
      assert.ok(!output.includes(Buffer.from("moof")));
      assert.equal(completed.items.find(i=>i.name===path.basename(target)).size,output.length);
    }
    assert.equal(blobs.size,0); assert.equal(opfs.files.size,0);
  } finally {
    const tokens = vm.runInContext("[...hlsJobs.keys()]", context);
    for (const token of tokens) await h.chrome.runtime.sendMessage({target: "offscreen", action: "cancel", token});
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true});
  }
});
