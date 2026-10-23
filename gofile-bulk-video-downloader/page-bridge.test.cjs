"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "page-bridge.js"), "utf8");
function folder(overrides = {}) {
  return {
    status: "ok",
    data: { id: "folder-id", code: "TestCode", type: "folder", name: "Test folder", canAccess: true, children: {
      image: { id: "image", type: "file", name: "photo.JPG", mimetype: "image/jpeg", size: 42, link: "https://file1.gofile.io/download/web/image/photo.JPG" },
    }, password: "synthetic-password", ownerToken: "synthetic-token", ...overrides },
    metadata: { page: 1, pageSize: 100, totalPages: 1, totalCount: 1 },
  };
}

function setup(t, pathname = "/d/TestCode") {
  const calls = [];
  const responses = [];
  const timers = new Set();
  const location = { origin: "https://gofile.io", pathname, href: `https://gofile.io${pathname}` };
  const context = vm.createContext({
    URL, URLSearchParams, Request, Response, Headers, TextDecoder, Uint8Array, AbortController,
    performance: { timeOrigin: Date.now() },
    generateWT: () => "a".repeat(64),
    location,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout,
    fetch: async (input, init) => {
      calls.push({ input, init });
      return responses.shift() || new Response(JSON.stringify(folder()));
    },
  });
  vm.runInContext(source, context);
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const bridge = context.__gofileBulkPageBridge;
  async function flush() { for (let i = 0; i < 20; i++) await new Promise(setImmediate); }
  async function capture(payload = folder(), url = "https://api.gofile.io/contents/TestCode?page=1&pageSize=100", init = { headers: { Authorization: "Bearer synthetic-secret" } }) {
    responses.push(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
    const response = await context.fetch(url, init);
    assert.deepEqual(await response.json(), payload, "Gofile自身は元のレスポンスを通常どおり読める");
    await flush();
  }
  return { context, location, calls, responses, bridge, capture, flush };
}

test("ページのGETレスポンスだけを観測し、認証・パスワード・リクエスト設定を公開しない", async t => {
  const fixture = setup(t);
  await fixture.capture(folder(), undefined, { headers: { Authorization: "Bearer synthetic-secret" } });
  const snapshot = fixture.bridge.current();
  assert.equal(snapshot.response.data.id, "folder-id");
  assert.equal(snapshot.response.data.children[0].mimetype, "image/jpeg");
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic|Authorization|api\.gofile/);
  assert.equal(snapshot.filtered, false);
  assert.equal(fixture.calls.length, 1);
});

test("フィルターを除去し、同じ一覧エンドポイントの認証を保ちWebsite Tokenを新しく発行する", async t => {
  const fixture = setup(t);
  const headers = { Authorization: "Bearer synthetic-secret", "X-Website-Token": "synthetic-website" };
  const signal = new AbortController().signal;
  await fixture.capture(folder(), "https://api.gofile.io/contents/TestCode?page=2&pageSize=100&contentFilter=photo&password=synthetic-password", { headers, signal });
  assert.equal(fixture.bridge.current().filtered, true);
  const result = await fixture.bridge.getPage("folder-id", 1, 1000);
  assert.equal(result.status, "ok");
  const call = fixture.calls[1];
  const url = new URL(call.input);
  assert.equal(url.origin, "https://api.gofile.io");
  assert.equal(url.pathname, "/contents/TestCode");
  assert.equal(url.searchParams.has("contentFilter"), false);
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("pageSize"), "1000");
  assert.equal(url.searchParams.get("password"), "synthetic-password");
  assert.equal(call.init.headers.get("Authorization"), headers.Authorization);
  assert.equal(call.init.headers.get("X-Website-Token"), "a".repeat(64));
  assert.equal(headers["X-Website-Token"], "synthetic-website");
  assert.notEqual(call.init.signal, signal);
  assert.equal(call.init.redirect, "error");
});

test("別フォルダ、他ホスト、GET以外、上限外のページから認証付き通信を開始しない", async t => {
  const fixture = setup(t);
  for (const [url, init] of [
    ["https://api.gofile.io/contents/OtherCode", {}],
    ["https://api.gofile.io.evil.example/contents/TestCode", {}],
    ["https://api.gofile.io/contents/TestCode", { method: "POST" }],
    ["https://user:pass@api.gofile.io/contents/TestCode", {}],
  ]) {
    await fixture.capture(folder(), url, init);
    assert.equal(fixture.bridge.current(), null);
  }
  await fixture.capture();
  const count = fixture.calls.length;
  for (const args of [["OtherCode", 1, 1000], ["folder-id", 101, 1000], ["folder-id", 1, 100]]) {
    const result = await fixture.bridge.getPage(...args);
    assert.notEqual(result.status, "ok");
  }
  fixture.location.pathname = "/d/OtherCode";
  assert.equal(fixture.bridge.current(), null);
  assert.notEqual((await fixture.bridge.getPage("folder-id", 1, 1000)).status, "ok");
  assert.equal(fixture.calls.length, count);
});

test("RequestオブジェクトのGETもheadersを保ったままページングできる", async t => {
  const fixture = setup(t);
  const request = new Request("https://api.gofile.io/contents/TestCode", { headers: { "X-Test": "fixture", Authorization: "Bearer synthetic-secret" } });
  await fixture.capture(folder(), request, {});
  await fixture.bridge.getPage("folder-id", 1, 1000);
  assert.ok(fixture.calls[1].input instanceof Request);
  assert.equal(fixture.calls[1].input.headers.get("X-Test"), "fixture");
  assert.equal(fixture.calls[1].init.headers.get("X-Test"), "fixture");
});

test("Gofileの署名関数が消失・変更した場合と6時間以上前に開いたページでは通信しない", async t => {
  const fixture = setup(t);
  await fixture.capture();
  const count = fixture.calls.length;
  fixture.context.generateWT = undefined;
  assert.equal((await fixture.bridge.getPage("folder-id", 1, 1000)).status, "error-siteChanged");
  fixture.context.generateWT = () => "invalid-signature";
  assert.equal((await fixture.bridge.getPage("folder-id", 1, 1000)).status, "error-siteChanged");
  fixture.context.generateWT = () => "a".repeat(64);
  fixture.context.performance.timeOrigin = Date.now() - 6 * 60 * 60 * 1000 - 1;
  assert.equal((await fixture.bridge.getPage("folder-id", 1, 1000)).status, "error-siteChanged");
  assert.equal(fixture.calls.length, count);
});

test("UUIDから共有コードへのcanonical rewriteを許可し、別共有への遷移は拒否する", async t => {
  const fixture = setup(t, "/d/folder-id");
  await fixture.capture(folder(), "https://api.gofile.io/contents/folder-id");
  fixture.location.pathname = "/d/TestCode";
  assert.equal(fixture.bridge.current().response.data.id, "folder-id");
  fixture.location.pathname = "/d/OtherCode";
  assert.equal(fixture.bridge.current(), null);
});

test("HTTPレート制限・認証切れ・アクセス不可を成功として扱わない", async t => {
  const fixture = setup(t);
  await fixture.capture();
  for (const [httpStatus, expected] of [[429, "error-rateLimit"], [401, "error-token"], [403, "error-token"], [404, "error-notFound"], [503, "error-http"]]) {
    fixture.responses.push(new Response("{}", { status: httpStatus }));
    assert.equal((await fixture.bridge.getPage("folder-id", 1, 1000)).status, expected);
  }
  await fixture.capture(folder({ canAccess: false }));
  const count = fixture.calls.length;
  assert.notEqual((await fixture.bridge.getPage("folder-id", 1, 1000)).status, "ok");
  assert.equal(fixture.calls.length, count);
});

test("巨大レスポンスを採用せず、元のページレスポンスは壊さない", async t => {
  const fixture = setup(t);
  const payload = { ...folder(), padding: "x".repeat(16 * 1024 * 1024) };
  await fixture.capture(payload);
  assert.equal(fixture.bridge.current(), null);
});

test("期限切れのリクエストと、取得中に移動したページを再利用しない", async t => {
  const fixture = setup(t);
  let now = 1000;
  fixture.context.Date = { now: () => now };
  await fixture.capture();
  now += 15 * 60 * 1000 + 1;
  assert.equal(fixture.bridge.current(), null);
  await fixture.capture();
  const pending = fixture.bridge.getPage("folder-id", 1, 1000);
  fixture.location.pathname = "/d/OtherCode";
  assert.equal((await pending).status, "error-pageChanged");
});
