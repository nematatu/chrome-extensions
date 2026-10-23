"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const core = require("../core.js"), collect = require("../hosted-collector.js");
const {createHarness, video} = require("./harness.cjs");
const ORIGINS = ["https://twfiles.com", "https://video.twimg1.com", "https://gofile.run", "https://gofile.ing",
  "https://video.twimg-film.com", "https://gofile.es", "https://cdn4.file-photo.com", "https://gofile.guru",
  "https://cdn.twimg-image.com", "https://gofile.pl", "https://video.twimg-com.com"];
const DOMAINS = ["twfiles.com", "twimg1.com", "gofile.run", "gofile.ing", "twimg-film.com", "gofile.es", "file-photo.com",
  "gofile.guru", "twimg-image.com", "gofile.pl", "twimg-com.com"];
const PROXY_ORIGINS = new Set(["https://gofile.es", "https://gofile.pl"]);
function endpoint(url) { return url.searchParams.get("endpoint") || url.pathname; }
const API = "https://rwzugqnp.fun800.click";
const source = fs.readFileSync(require.resolve("../collector.js"), "utf8");

function file(index = 1, overrides = {}) {
  return {id: String(index), name: "generated-scene-" + index + ".mp4", isFolder: false, landingPage: "Clip" + String(index).padStart(4, "0"),
    mp4Url: "https://media.example.com/generated/scene-" + index + ".mp4", size: 200, ...overrides};
}
function info(item = {id: "folder", name: "Generated scenes", isFolder: true}, status = "0") {
  return {info: {netDiskInfo: item, extraInfo: {sortOrder: 2}}, rules: {status}};
}
function response(data, status = 200) {
  return new Response(JSON.stringify({code: 0, data}), {status, headers: {"content-type": "application/json"}});
}
function snapshot(origin = ORIGINS[0], rows = [file()], overrides = {}) {
  return {ok: true, scanType: "hosted-api", pageUrl: origin + "/Folder001", title: "Generated scenes",
    visibleRows: rows.map(item => ({name: item.name, isFolder: Boolean(item.isFolder)})), playerName: "", ...overrides};
}
async function run(options = {}) {
  const entries = options.entries || [file()];
  const snap = options.snapshot || snapshot(options.origin, entries.slice(0, 2));
  const calls = [];
  const fetch = async (value, settings) => {
    const url = new URL(value); calls.push({url, settings});
    if (options.fetch) return options.fetch(url, settings, calls.length);
    if (endpoint(url).endsWith("/getInfo")) return response(options.main || info());
    const page = Number(url.searchParams.get("pageNo"));
    return response({list: entries.slice((page - 1) * 20, page * 20), total: entries.length});
  };
  return {result: await collect(snap, {core, fetch, isCurrentPage: options.isCurrentPage}), calls};
}

test("対応11ホストの共有リンクだけを許可し、公開コードと同じAPIドメインとリンクIDへ変換する", () => {
  for (const [index, origin] of ORIGINS.entries()) {
    for (const path of ["/Folder001", "/d/Folder001/", "/Folder001.html", "/?link=Folder001", "/?externalLinks=Folder001"]) {
      assert.equal(core.isSupportedPageUrl(origin + path), true);
      assert.deepEqual(core.getHostedPageInfo(origin + path), {shortLink: "Folder001", domain: DOMAINS[index]});
    }
    assert.equal(core.getHostedPageInfo(origin + "/aFolder001").shortLink, "Folder001");
    for (const path of ["/", "/assets/script.js", "/app-api/test", "/api.php", "/robots.txt", "/x/y/z", "/?link=../bad",
      "/?link=one&link=two", "/?link=one&externalLinks=two"]) {
      assert.equal(core.isSupportedPageUrl(origin + path), false);
    }
    for (const value of [origin.replace("https:", "http:") + "/Folder001", origin + ".evil.example/Folder001",
      origin + ":8443/Folder001", origin.replace("https://", "https://user:secret@") + "/Folder001"]) {
      assert.equal(core.isSupportedPageUrl(value), false);
    }
  }
});

test("新サイトのAPI由来の公開HTTPSメディアだけを許可し、従来サイトの配信先制限を維持する", () => {
  const page = ORIGINS[0] + "/Folder001";
  const url = "https://media.example.com/generated/sample.mp4?signature=fixture";
  assert.equal(core.isAllowedDownloadUrl(url, page), true);
  assert.equal(core.isAllowedDownloadUrl(url), false);
  assert.equal(core.isAllowedDownloadUrl(url, "https://video.twimg.news/d/10001/"), false);
  for (const unsafe of ["http://media.example.com/a.mp4", "https://user:secret@media.example.com/a.mp4",
    "https://localhost/a.mp4", "https://127.0.0.1/a.mp4", "https://[::1]/a.mp4", "https://media.local/a.mp4",
    "https://media.home.arpa/a.mp4", "https://media.example/a.mp4",
    "https://192.168.0.2/a.mp4", "https://media.example.com:8443/a.mp4", "https://media.example.com/a.m3u8",
    "https://media.example.com/a.mpd", "https://media.example.com/a.html", "https://media.example.com/a.mp4#fragment",
    "https://media.example.com/a%00.mp4", "https://media.example.com/a%5c.mp4", "https://media.example.com/%ZZ.mp4"]) {
    assert.equal(core.isAllowedDownloadUrl(unsafe, page), false);
  }
});

test("11ホストで画面の名前だけを収集し、プレイヤー・広告・プレビューのURLをページから取得しない", () => {
  for (const origin of ORIGINS) {
    const row = {querySelector: selector => selector === ".video-copy strong" ? {textContent: "generated-scene-1.mp4"} : null};
    const content = {querySelectorAll: () => [row], querySelector: () => null};
    const context = vm.createContext({URL, location: {href: origin + "/Folder001"}, document: {
      title: "Generated scenes", baseURI: origin + "/Folder001", querySelector: () => content,
      querySelectorAll: () => {throw new Error("generic collection must not run");},
    }});
    vm.runInContext(source, context);
    const found = JSON.parse(JSON.stringify(context.collectPageMedia()));
    assert.equal(found.scanType, "hosted-api"); assert.equal(found.pageUrl, origin + "/Folder001");
    assert.deepEqual(found.visibleRows, [{name: "generated-scene-1.mp4", isFolder: false}]);
    assert.equal(found.videos, undefined); assert.equal(found.items, undefined);
    context.document.querySelector = () => null;
    assert.equal(context.collectPageMedia().error, "SITE_NOT_READY");
  }
});

test("公開コードにある各サイトのフォルダー記号・個別タイトルの違いを扱う", () => {
  for (const origin of ORIGINS) {
    const folderSelector = ["https://gofile.run", "https://gofile.ing"].includes(origin) ? ".video-icon--folder" : ".video-thumb--folder";
    const titleSelector = ["https://gofile.run", "https://gofile.ing"].includes(origin) ? ".player-summary__copy h1" : ".player-title h1";
    let individual = false;
    const row = {querySelector: selector => selector === ".video-copy strong" ? {textContent:"Subfolder"}
      : selector.split(", ").includes(folderSelector) ? {} : null};
    const player = {querySelector: selector => selector.split(", ").includes(titleSelector) ? {textContent:file().name} : null};
    const content = {querySelectorAll: () => individual ? [] : [row], querySelector: () => individual ? player : null};
    const context = vm.createContext({URL, location:{href:origin+"/Folder001"}, document:{title:"Generated scenes",
      baseURI:origin+"/Folder001",querySelector:() => content}});
    vm.runInContext(source, context);
    const folder = context.collectPageMedia();
    assert.equal(folder.ok, true); assert.equal(folder.visibleRows[0].isFolder, true);
    individual = true;
    const found = context.collectPageMedia();
    assert.equal(found.ok, true); assert.equal(found.playerName, file().name); assert.equal(found.visibleRows.length, 0);
  }
});

test("11ホストのページ分割一覧を全件取得し、画像も含めて既存キュー形式へ変換する", async () => {
  const entries = Array.from({length: 23}, (_, index) => file(index + 1));
  entries[21] = file(22, {name: "generated-geometry.png", mp4Url: "", fileUrl: "https://media.example.com/generated/geometry.png"});
  entries[22] = {id: "sub", name: "Subfolder", isFolder: true};
  for (const [index, origin] of ORIGINS.entries()) {
    const {result, calls} = await run({origin, entries});
    assert.equal(result.ok, true); assert.equal(result.videos.length, 22); assert.equal(result.totalPages, 2);
    assert.equal(result.scannedItems, 23); assert.equal(result.folderId, "Folder001");
    assert.equal(result.videos[21].mimetype, "image/png"); assert.equal(result.videos[21].thumbnail, null);
    assert.equal(result.skipped[0].reason, "subfolder"); assert.equal(calls.length, 3);
    for (const {url, settings} of calls) {
      assert.equal(url.origin, PROXY_ORIGINS.has(origin) ? origin : API);
      if (PROXY_ORIGINS.has(origin)) assert.equal(url.pathname, "/api.php");
      else assert.ok(["/app-api/flow/land-page/getInfo", "/app-api/flow/land-page/list_by_links_page"].includes(url.pathname));
      assert.equal(url.searchParams.get("domain"), DOMAINS[index]);
      assert.equal(url.searchParams.get("externalLinks"), "Folder001");
      assert.equal(settings.method, "GET"); assert.equal(settings.credentials, "omit");
      assert.equal(settings.redirect, "error"); assert.equal(settings.referrerPolicy, "no-referrer");
    }
  }
});

test("wrapper・並べ替えを扱い、配信URLが同じでも別名の一覧項目を両方保存する", async () => {
  const entries = [file(), file(2, {mp4Url: file().mp4Url})];
  const {result} = await run({snapshot: snapshot(ORIGINS[0], entries.toReversed()), fetch: url =>
    response(endpoint(url).endsWith("/getInfo") ? info() : {page: {records: entries}, totalCount: 2})});
  assert.equal(result.ok, true); assert.equal(result.videos.length, 2); assert.equal(result.scannedItems, 2);
  assert.equal(core.normalizeVideos(result.videos,10000,result.pageUrl).length,2);
});

test("直接URLがないファイルだけ固定APIで詳細を取得し、HLSよりMP4の代替URLを選ぶ", async () => {
  const item = file(1, {mp4Url: "", landingPage: "Clip0001", videoUrl: "https://media.example.com/a.m3u8"});
  const {result, calls} = await run({entries: [item], fetch: url => {
    if (endpoint(url).endsWith("/list_by_links_page")) return response({list: [item], total: 1});
    return response(url.searchParams.get("externalLinks") === "Clip0001"
      ? info(file(1, {appMp4Url: file().mp4Url, mp4Url: "", videoUrl: item.videoUrl})) : info());
  }});
  assert.equal(result.ok, true); assert.equal(result.videos[0].link, file().mp4Url);
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.url.origin === API));
});

test("11ホストの個別動画ページでもチャンネルIDで一覧全ページを取得し、広告・プレビューを保存しない", async () => {
  const entries = Array.from({length: 62}, (_, i) => file(i + 1));
  const main = info(file(1, {cover: "https://media.example.com/preview.png", target: "https://media.example.com/ad.mp4"}));
  main.info.extraInfo.externalLinks = "Channel001";
  for (const origin of ORIGINS) {
    const {result, calls} = await run({entries, main, snapshot: snapshot(origin, entries.slice(0,20), {playerName: file().name})});
    assert.equal(result.ok, true); assert.equal(result.videos.length, 62);
    assert.equal(result.folderId, "Channel001"); assert.equal(result.totalPages, 4);
    assert.equal(result.videos[0].link, file().mp4Url); assert.equal(result.videos[0].thumbnail, null);
    assert.equal(calls.length, 5); assert.equal(calls[0].url.searchParams.get("externalLinks"), "Folder001");
    for (const call of calls.slice(1)) assert.equal(call.url.searchParams.get("externalLinks"), "Channel001");
  }
});

test("表示中の動画が一覧にない場合も含め、一度だけ保存する", async () => {
  const main = info(file(99)); main.info.extraInfo.externalLinks = "Channel001";
  const {result} = await run({entries:[file(1),file(2)], main, snapshot:snapshot(ORIGINS[0],[file(1)],{playerName:file(99).name})});
  assert.equal(result.ok,true); assert.equal(result.videos.length,3);
  assert.equal(result.videos.filter(item=>item.link===file(99).mp4Url).length,1);
});

test("共有リンクがあるサブフォルダーも中身を取得せず保存対象外にする", async () => {
  const folder = {id:"sub-folder",name:"Subfolder",isFolder:true,landingPage:"Child001"};
  const children = Array.from({length:24},(_,i)=>file(i+2));
  const {result,calls} = await run({entries:[file(),folder],fetch:url=> {
    const child=url.searchParams.get("externalLinks")==="Child001";
    if(endpoint(url).endsWith("/getInfo")) return response(child?info(folder):info());
    const page=Number(url.searchParams.get("pageNo"));
    return response(child?{list:children.slice((page-1)*20,page*20),total:24}:{list:[file(),folder],total:2});
  }});
  assert.equal(result.ok,true); assert.equal(result.videos.length,1); assert.equal(result.totalPages,1);
  assert.equal(result.scannedItems,2); assert.equal(result.skipped.length,1);
  assert.equal(calls.length,2); assert.ok(calls.every(call=>call.url.searchParams.get("externalLinks")==="Folder001"));
});

test("チャンネルの不正ID・一覧の不一致では部分保存しない", async () => {
  for(const externalLinks of ["../other","https://evil.example/Channel001","bad\nID"]) {
    const main=info(file()); main.info.extraInfo.externalLinks=externalLinks;
    const {result,calls}=await run({main,snapshot:snapshot(ORIGINS[0],[file()],{playerName:file().name})});
    assert.equal(result.error,"SITE_DATA_CHANGED"); assert.equal(calls.length,1);
  }
  const main=info(file()); main.info.extraInfo.externalLinks="Channel001";
  const mismatch=await run({main,snapshot:snapshot(ORIGINS[0],[file(99)],{playerName:file().name})});
  assert.equal(mismatch.result.error,"SITE_LIST_MISMATCH"); assert.equal(mismatch.result.videos,undefined);
});

test("API配信フィールドの相対URL・空白を解決し、不正なプロトコルや制御文字は拒否する", async () => {
  for (const [raw, expected] of [[" //media.example.com/generated/scene.mp4 ", "https://media.example.com/generated/scene.mp4"],
    ["/generated/scene.mp4", ORIGINS[0]+"/generated/scene.mp4"]]) {
    const {result} = await run({entries:[file(1,{mp4Url:raw})]});
    assert.equal(result.ok, true); assert.equal(result.videos[0].link, expected);
  }
  for (const raw of ["javascript:scene.mp4", "https://media.example.com/a\nb.mp4", "\\\\media.example.com/scene.mp4"]) {
    assert.equal((await run({entries:[file(1,{mp4Url:raw,landingPage:""})]})).result.error, "SITE_FILE_UNSUPPORTED");
  }
});

test("APIのアクセス制限・期限切れ・レート制限・HTML応答・失敗コードでは保存一覧を返さない", async () => {
  for (const [status, error] of [[401,"AUTH_REQUIRED"], [403,"AUTH_REQUIRED"], [404,"NOT_FOUND"], [410,"NOT_FOUND"],
    [429,"RATE_LIMITED"], [500,"SITE_API_FAILED"]]) {
    const {result} = await run({fetch: () => response({}, status)});
    assert.equal(result.error, error); assert.equal(result.videos, undefined);
  }
  for (const status of ["1", "2", "3", "4", "5"]) {
    const {result, calls} = await run({main: info(undefined, status)});
    assert.equal(result.error, ["4", "5"].includes(status) ? "ACCESS_REQUIRED" : "NOT_FOUND");
    assert.equal(calls.length, 1);
  }
  assert.equal((await run({fetch: () => new Response("<html>expired</html>", {headers:{"content-type":"text/html"}})})).result.error, "SITE_DATA_CHANGED");
  assert.equal((await run({fetch: () => new Response(JSON.stringify({code:1,data:{}}), {headers:{"content-type":"application/json"}})})).result.error, "SITE_API_FAILED");
  assert.equal((await run({fetch: () => {throw new Error("synthetic-network-failure");}})).result.error, "SITE_API_FAILED");
});

test("部分一覧・件数変更・重複ページ・画面の不一致を成功扱いにしない", async () => {
  const entries = Array.from({length: 20}, (_, index) => file(index + 1));
  for (const second of [{list:[file(21)],total:22}, {list:[file(21)],total:25}, {list:[file(1)],total:21}]) {
    const {result} = await run({fetch: url => {
      if (endpoint(url).endsWith("/getInfo")) return response(info());
      return response(Number(url.searchParams.get("pageNo")) === 1 ? {list:entries,total:25} : second);
    }});
    assert.equal(result.error, "SITE_LIST_MISMATCH"); assert.equal(result.videos, undefined);
  }
  assert.equal((await run({snapshot: snapshot(ORIGINS[0], [file(99)])})).result.error, "SITE_LIST_MISMATCH");
  assert.equal((await run({main: info(file()), snapshot: snapshot(ORIGINS[0], [], {playerName:"different.mp4"})})).result.error, "SITE_LIST_MISMATCH");
});

test("不正な詳細リンク・未対応形式・不正配信先があれば部分保存を開始しない", async () => {
  for (const unsafe of [file(2, {mp4Url: "", landingPage:"https://evil.example/Clip0002"}),
    file(2, {mp4Url:"https://localhost/private.mp4", landingPage:""}), file(2, {mp4Url:"https://media.example.com/stream.m3u8", landingPage:""})]) {
    const {result, calls} = await run({entries: [file(), unsafe]});
    assert.equal(result.error, "SITE_FILE_UNSUPPORTED"); assert.equal(result.videos, undefined);
    assert.ok(calls.every(call => call.url.origin === API));
  }
});

test("API応答・一覧のサイズを制限し、収集中のページ移動で停止する", async () => {
  const {result} = await run({fetch: () => response({padding: "x".repeat(1024 * 1024)})});
  assert.equal(result.error, "TOO_MUCH_DATA");
  const large = await run({fetch: url => response(endpoint(url).endsWith("/getInfo") ? info() : {list:[file()],total:10001})});
  assert.equal(large.result.error, "TOO_MANY_ITEMS");
  let checks = 0;
  const moved = await run({isCurrentPage: async () => ++checks < 3});
  assert.equal(moved.result.error, "PAGE_CHANGED"); assert.equal(moved.result.videos, undefined);
  const untrusted = await run({snapshot: snapshot("https://twfiles.com.evil.example")});
  assert.equal(untrusted.result.error, "UNTRUSTED_PAGE"); assert.equal(untrusted.calls.length, 0);
  let time = 0;
  const timedOut = await collect(snapshot(), {core, fetch: () => {throw new Error("must not request");}, now: () => (time += 4 * 60 * 1000)});
  assert.equal(timedOut.error, "SCAN_TIMEOUT");
});

test("11ホストの保存要求から既存ワーカーの保存・復元・再試行まで接続する", async () => {
  for (const origin of ORIGINS) {
    const item = file(1, {mp4Url:"https://media.example.com/generated/scene.mp4?signature=fixture"});
    const snap = snapshot(origin, [item]);
    const h = createHarness(snap);
    const sender = {...h.sender, url:snap.pageUrl, tab:{id:42,url:snap.pageUrl}};
    h.setApiFetch(value => { const url = new URL(value); return response(endpoint(url).endsWith("/getInfo")
      ? (url.searchParams.get("externalLinks") === item.landingPage ? info(item) : info()) : {list:[item],total:1}); });
    const result = await h.send({type:"page-media-bulk:start",url:"https://evil.example/ignored.mp4"}, sender);
    assert.equal(result.ok, true); assert.equal(result.batch.summary.total, 1);
    assert.equal(h.downloadCalls.length, 1); assert.equal(h.downloadCalls[0].url, item.mp4Url);
    assert.equal(h.downloadCalls[0].filename, "PageMedia/Generated scenes/" + item.name);
    h.resetWorkerCache();
    Object.assign(h.downloads.get(1), {state:"interrupted",error:"NETWORK_FAILED"});
    const state = await h.send({type:"page-media-bulk:status"}, sender);
    assert.equal(state.batch.summary.retryableFailures, 1);
    const retry = await h.send({type:"page-media-bulk:retry",batchId:result.batch.id}, sender);
    assert.equal(retry.ok, true); assert.equal(h.downloadCalls.length, 2);
    assert.equal(h.downloadCalls[1].url, item.mp4Url);
  }
});

test("リンクIDをクエリに持つ別ページから保存結果を操作できず、API収集中の移動でも保存しない", async () => {
  const snap = snapshot(ORIGINS[0], [file()], {pageUrl:ORIGINS[0] + "/?link=Folder001"});
  const h = createHarness(snap), sender = {...h.sender,url:snap.pageUrl,tab:{id:42,url:snap.pageUrl}};
  h.setApiFetch(url => response(endpoint(new URL(url)).endsWith("/getInfo") ? info() : {list:[file()],total:1}));
  const first = await h.send({type:"page-media-bulk:start"}, sender);
  const other = {...sender, url:ORIGINS[0]+"/?link=Folder002",tab:{id:84,url:ORIGINS[0]+"/?link=Folder002"}};
  assert.equal((await h.send({type:"page-media-bulk:status"}, other)).batch, null);
  assert.equal((await h.send({type:"page-media-bulk:cancel",batchId:first.batch.id}, other)).error, "BATCH_NOT_FOUND");
  for (const path of ["/Folder002", "/Folder001?lang=en"]) {
    const moved = createHarness(snapshot());
    const hostedSender = {...moved.sender,url:snapshot().pageUrl,tab:{id:42,url:snapshot().pageUrl}};
    moved.setApiFetch(() => {
      moved.chrome.tabs.get = async () => ({id:42,url:ORIGINS[0]+path});
      return response(info());
    });
    assert.equal((await moved.send({type:"page-media-bulk:start"}, hostedSender)).error, "PAGE_CHANGED");
    assert.equal(moved.downloadCalls.length, 0);
  }
});

test("保存キューのページURLへリンクID以外のクエリや認証値を残さない", async () => {
  const snap = snapshot(ORIGINS[0], [file()], {pageUrl:ORIGINS[0] + "/?link=Folder001&password=fixture&tracking=fixture#section"});
  const h = createHarness(snap), sender = {...h.sender,url:snap.pageUrl,tab:{id:42,url:snap.pageUrl}};
  h.setApiFetch(url => response(endpoint(new URL(url)).endsWith("/getInfo") ? info() : {list:[file()],total:1}));
  const result = await h.send({type:"page-media-bulk:start"}, sender);
  assert.equal(result.ok, true); assert.equal(result.batch.pageUrl, ORIGINS[0] + "/?link=Folder001");
  assert.ok(h.apiCalls.every(call => !new URL(call.url).searchParams.has("password")));
});

test("旧版の未完了キューがある間は追加サイトで開始せず、誤ったページへ引き継がない", async () => {
  const snap = snapshot(), h = createHarness(snap);
  const sender = {...h.sender,url:snap.pageUrl,tab:{id:42,url:snap.pageUrl}};
  const legacy = {id:"generated-legacy",source:"video.twimg.news",items:[{
    name:"generated.mp4",kind:"video",url:"https://cdn.videy.co/Scene0001.mp4",status:"downloading",downloadId:9,
  }]};
  h.storageMemory.pageMediaBatchV1 = structuredClone(legacy);
  h.setApiFetch(url => response(endpoint(new URL(url)).endsWith("/getInfo") ? info() : {list:[file()],total:1}));
  assert.equal((await h.send({type:"page-media-bulk:start"}, sender)).error, "LEGACY_QUEUE");
  assert.equal(h.downloadCalls.length, 0); assert.deepEqual(h.storageMemory.pageMediaBatchV1, legacy);
});


test("全11ホストでチャンネル名付きプレーヤー見出しを照合し、無関係な接頭辞では保存しない", async () => {
  const main = info(file());
  main.info.extraInfo.channelName = "Generated channel";
  main.info.extraInfo.externalLinks = "Channel001";
  for (const origin of ORIGINS) {
    for (const playerName of [file().name, "Generated channel-" + file().name]) {
      const {result} = await run({main, snapshot:snapshot(origin, [file()], {playerName})});
      assert.equal(result.ok, true, origin);
      assert.equal(result.folderName, "Generated channel");
    }
    for (const playerName of ["Unrelated channel-" + file().name, "Generated channel-other.mp4"]) {
      const {result, calls} = await run({main, snapshot:snapshot(origin, [file()], {playerName})});
      assert.equal(result.error, "SITE_LIST_MISMATCH", origin);
      assert.equal(result.videos, undefined);
      assert.equal(calls.length, 1);
    }
  }
});

test("es・pl の一覧と不足URLの補完は同一サイトの固定PHP APIを使い、ページ指定の接続先は採用しない", async () => {
  for (const origin of PROXY_ORIGINS) {
    const item = file(1, {mp4Url:"", landingPage:"Clip0001"});
    const folder = {id:"child", name:"Child folder", isFolder:true, landingPage:"Child001"};
    const snap = snapshot(origin, [item, folder], {
      pageUrl:origin + "/d/Folder001?endpoint=https%3A%2F%2Fevil.example%2Fapi&domain=evil.example&password=fixture",
    });
    const {result,calls} = await run({snapshot:snap, entries:[item,folder], fetch:url=> {
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, "/api.php");
      assert.ok(["/flow/land-page/getInfo", "/flow/land-page/list_by_links_page"].includes(url.searchParams.get("endpoint")));
      assert.equal(url.searchParams.get("domain"), new URL(origin).hostname);
      assert.equal(url.searchParams.has("password"), false);
      assert.notEqual(url.searchParams.get("externalLinks"), "Child001");
      return response(endpoint(url).endsWith("/list_by_links_page") ? {list:[item,folder],total:2}
        : url.searchParams.get("externalLinks") === "Clip0001" ? info(file()) : info());
    }});
    assert.equal(result.ok, true);
    assert.equal(result.videos.length, 1);
    assert.equal(result.skipped[0].reason, "subfolder");
    assert.equal(calls.length, 3);
  }
});

test("詳細にも配信URLがない1件をリンクなしとして表示し、残る99件を収集する", async () => {
  for (const absent of ["", "null", "undefined", "https://vid.fun800.click/null"]) {
    const entries = Array.from({length:100}, (_,i)=>file(i+1));
    entries[50] = file(51,{mp4Url:""});
    const {result,calls} = await run({snapshot:snapshot("https://gofile.guru",entries.slice(0,20)), fetch:url=> {
      if(endpoint(url).endsWith("getInfo")) return response(url.searchParams.get("externalLinks")==="Clip0051"
        ? info(file(51,{id:undefined,mp4Url:"",fileUrl:absent,cover:"https://media.example.com/preview.jpg"})) : info());
      const p=Number(url.searchParams.get("pageNo")); return response({list:entries.slice((p-1)*20,p*20),total:100});
    }});
    assert.equal(result.ok,true); assert.equal(result.videos.length,99); assert.equal(result.scannedItems,100);
    assert.equal(result.skipped.length,1); assert.equal(result.skipped[0].reason,"missing-link");
    assert.equal(calls.length,7);
  }
});

test("期限付きリンク更新は同じファイルだけを再取得し、変更・認証・許可外URLを拒否する", async () => {
  for (const origin of PROXY_ORIGINS) {
    const ref={shortLink:"Clip0001",id:"1",name:file().name};
    const calls=[];
    const refresh = item => collect.refreshHostedFile(origin+"/d/Folder001",ref,{core,fetch:async value=> {
      const u=new URL(value); calls.push(u);
      assert.equal(u.origin,origin); assert.equal(u.pathname,"/api.php");
      assert.equal(u.searchParams.get("endpoint"),"/flow/land-page/getInfo");
      assert.equal(u.searchParams.get("externalLinks"),ref.shortLink);
      return response(info(item));
    }});
    const good=await refresh(file(1,{mp4Url:"https://media.example.com/scene.mp4?signature=new"}));
    assert.equal(good.ok,true); assert.match(good.video.link,/signature=new$/); assert.equal(calls.length,1);
    assert.equal((await refresh(file(2))).error,"SITE_LIST_MISMATCH");
    assert.equal((await refresh(file(1,{name:"different.mp4"}))).error,"SITE_LIST_MISMATCH");
    assert.equal((await refresh(file(1,{isFolder:true}))).error,"SITE_LIST_MISMATCH");
    assert.equal((await refresh(file(1,{mp4Url:"https://vid.fun800.click/null",landingPage:""}))).error,"SITE_FILE_UNAVAILABLE");
    for (const invalid of [null,{...ref,shortLink:"https://evil.example/Clip0001"},{...ref,name:""}]) {
      assert.equal((await collect.refreshHostedFile(origin+"/d/Folder001",invalid,{core})).error,"UNTRUSTED_PAGE");
    }
    assert.equal((await collect.refreshHostedFile("https://evil.example/d/Folder001",ref,{core})).error,"UNTRUSTED_PAGE");
  }
});
