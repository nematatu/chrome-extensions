const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const page = "https://kltratv13.blogspot.com/p/galaxy.html";

function setup(fetch) {
  let listener;
  vm.runInNewContext(script, {
    chrome: { runtime: { id: "test-extension", onMessage: { addListener: (value) => { listener = value; } } } },
    fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
  });
  return (message, sender) => new Promise((resolve) => {
    listener(message, sender, resolve);
  });
}

test("オンライン翻訳は固定の宛先に本文だけを送り、訳文だけを返す", async () => {
  let request;
  const send = setup(async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, headers: new Map(), text: async () => JSON.stringify([[ ["中国よ、頑張れ！できるよ！"] ]]) };
  });
  const reply = await send({ type: "TRANSLATE_ONLINE", source: "auto", text: "China, semangat! Kamu pasti bisa!" },
    { id: "test-extension", url: page, frameId: 0 });
  assert.equal(reply.ok, true);
  assert.equal(reply.text, "中国よ、頑張れ！できるよ！");
  const url = new URL(request.url);
  assert.equal(url.origin, "https://translate.googleapis.com");
  assert.equal(url.searchParams.get("q"), "China, semangat! Kamu pasti bisa!");
  assert.equal(request.options.credentials, "omit");
});

test("別ページや過長の本文は送信しない", async () => {
  let called = false;
  const send = setup(async () => { called = true; throw new Error("unexpected"); });
  assert.equal((await send({ type: "TRANSLATE_ONLINE", source: "auto", text: "hello" },
    { id: "test-extension", url: "https://other.example/", frameId: 0 })).ok, false);
  assert.equal((await send({ type: "TRANSLATE_ONLINE", source: "auto", text: "x".repeat(241) },
    { id: "test-extension", url: page, frameId: 0 })).ok, false);
  assert.equal(called, false);
});
