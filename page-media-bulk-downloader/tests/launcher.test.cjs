"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const {createHarness, video} = require("./harness.cjs");
const core = require("../core.js");
const content = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
const gofile = fs.readFileSync(path.join(__dirname, "../../gofile-bulk-video-downloader/content.js"), "utf8");
test("Gofile版のボタンと進捗パネルのCSSをそのまま維持する", () => {
  const styles = source => [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]);
  assert.equal(styles(content).length, 2); assert.deepEqual(styles(content), styles(gofile));
  assert.doesNotMatch(content, /openPopup|選択したファイル|popup\.html/);
});
test("ページと配信先を厳密に検証し、偽装ホスト・資格情報・配信形式を拒否する", () => {
  assert.equal(core.isSupportedPageUrl("https://video.twimg.news/d/10001/"), true);
  for (const url of ["https://example.test/d/10001/", "http://video.twimg.news/d/10001/",
    "https://video.twimg.news.evil.example/d/10001/", "https://video.twimg.news:8443/d/10001/",
    "https://user:secret@video.twimg.news/d/10001/", "https://video.twimg.news/d/name/"]) {
    assert.equal(core.isSupportedPageUrl(url), false);
  }
  assert.equal(core.isAllowedDownloadUrl("https://cdn.videy.co/Scene0001.mp4"), true);
  for (const url of ["https://other.example.test/Scene0001.mp4", "http://cdn.videy.co/Scene0001.mp4",
    "https://cdn.videy.co.evil.example/Scene0001.mp4", "https://user:secret@cdn.videy.co/Scene0001.mp4",
    "https://cdn.videy.co/Scene0001.mp4?token=test", "https://cdn.videy.co/Scene0001.m3u8",
    "https://cdn.videy.co/Scene0001.mp4#fragment", "https://cdn.videy.co/a\\nScene0001.mp4"]) {
    assert.equal(core.isAllowedDownloadUrl(url), false);
  }
});
test("許可していないホスト・iframe・別拡張・シークレット・古い文書からの要求を拒否する", async () => {
  const h = createHarness();
  for (const changes of [{id: "another-extension"}, {frameId: 1}, {documentLifecycle: "cached"},
    {url: "https://example.test/d/10001/"}, {tab: {...h.sender.tab, incognito: true}}]) {
    const result = await h.send({type: "page-media-bulk:start"}, {...h.sender, ...changes});
    assert.equal(result.error, "UNTRUSTED_PAGE");
  }
  assert.equal(h.scriptCalls.length, 0); assert.equal(h.downloadCalls.length, 0);
});
test("一覧確認前後のページ移動・古い文書では保存を開始しない", async () => {
  for (const phase of ["before", "after"]) {
    const h = createHarness(); let calls = 0;
    h.chrome.tabs.get = async () => ({id: 42, url: phase === "before" || ++calls > 1 ? "https://video.twimg.news/d/10002/" : h.sender.url});
    const result = await h.send({type: "page-media-bulk:start"});
    assert.equal(result.error, "PAGE_CHANGED"); assert.equal(h.downloadCalls.length, 0);
  }
  const stale = createHarness({pageUrl: "https://video.twimg.news/d/10002/"});
  assert.equal((await stale.send({type: "page-media-bulk:start"})).error, "PAGE_CHANGED");
  assert.equal(stale.downloadCalls.length, 0);
});
test("別ページの保存結果を表示・キャンセル・再試行・消去できない", async () => {
  const h = createHarness({videos:[video(1)]}), first = await h.send({type: "page-media-bulk:start"});
  const elsewhere = {...h.sender, url: "https://video.twimg.news/d/10002/", tab:{id:84,url:"https://video.twimg.news/d/10002/"}};
  assert.equal((await h.send({type: "page-media-bulk:status"}, elsewhere)).batch, null);
  for (const type of ["cancel", "retry"]) assert.equal((await h.send({type:"page-media-bulk:"+type,batchId:first.batch.id}, elsewhere)).error, "BATCH_NOT_FOUND");
  await h.send({type:"page-media-bulk:dismiss",batchId:first.batch.id}, elsewhere);
  assert.ok(h.getCachedState().batches[first.batch.id]); assert.equal(h.downloads.get(1).state, "in_progress");
});
test("HTML応答を保存成功にせず、再試行可能なURLや詳細な例外を残さない", async () => {
  const h = createHarness({videos:[video(1)]}), result = await h.send({type:"page-media-bulk:start"});
  Object.assign(h.downloads.get(1), {state:"complete", mime:"text/html", bytesReceived:100});
  const done = (await h.send({type:"page-media-bulk:status"})).batch;
  assert.equal(done.summary.completed, 0); assert.equal(done.summary.failed, 1);
  assert.equal(done.items[0].error, "UNEXPECTED_CONTENT"); assert.equal(done.items[0].retryable, false);
  assert.equal(h.getCachedState().batches[result.batch.id].items[0].url, null);
});
test("別の拡張機能が所有するIDを完了扱いにしたりキャンセルしたりしない", async () => {
  const h = createHarness({videos:[video(1)]}), result = await h.send({type:"page-media-bulk:start"});
  h.downloads.get(1).byExtensionId = "another-extension";
  await h.send({type:"page-media-bulk:cancel",batchId:result.batch.id});
  assert.equal(h.downloads.get(1).state, "in_progress");
});
test("複数の復旧候補を並列枠へ数え、実際の接続数を4件以内に保つ", async () => {
  const h = createHarness(), result = await h.send({type:"page-media-bulk:start"});
  const state = h.getCachedState().batches[result.batch.id], original = h.downloads.get(1);
  state.items[0].status = "starting"; state.items[0].downloadId = null;
  h.downloads.set(99, {...original, id:99});
  h.downloads.get(2).state = "complete";
  await h.send({type:"page-media-bulk:status"});
  assert.equal([...h.downloads.values()].filter(item => item.state === "in_progress").length, 4);
  assert.equal(h.downloadCalls.length, 4);
});
