const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../chat.js"), "utf8");

function text(value) {
  return { nodeType: 3, textContent: value };
}

function element(selector, children = [], attributes = {}, tagName = "DIV") {
  return {
    nodeType: 1,
    tagName,
    childNodes: children,
    matches: (query) => query === selector,
    getAttribute: (name) => attributes[name] ?? null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

function message(id, name, children) {
  const body = element(".body", children);
  const nameElement = { textContent: name };
  return {
    ...element(".msg", [], { "data-id": id }),
    querySelector: (query) => query === ":scope > .nme" ? nameElement : body,
  };
}

test("履歴を流さず、新着投稿だけを一度ずつ親ページへ送る", () => {
  const history = message("100", "old", [text("history")]);
  const container = {
    ...element("#messages"),
    querySelectorAll: () => [history],
  };
  const sent = [];
  let observer;
  class MockObserver {
    constructor(callback) { observer = callback; }
    observe() {}
  }
  const frame = {
    location: { ancestorOrigins: ["https://kltratv13.blogspot.com"] },
    parent: { postMessage: (...args) => sent.push(args) },
  };
  frame.top = {};
  vm.runInNewContext(script, {
    window: frame,
    location: { origin: "https://www3.cbox.ws", href: "https://www3.cbox.ws/box/",
      search: "?boxid=3538770&boxtag=Dn3dpG" },
    document: { getElementById: () => container, documentElement: {} },
    URL,
    URLSearchParams,
    MutationObserver: MockObserver,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  });
  assert.equal(sent.length, 0);

  const fresh = message("101", "viewer", [text("hello "), element(".emote[data-alt]", [], {
    "data-alt": ":smile:", src: "https://cdn.cbox.ws/emotes/smile.png"
  })]);
  observer([{ target: container, addedNodes: [fresh] }]);
  observer([{ target: container, addedNodes: [fresh] }]);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][0])), {
    channel: "kltra-danmaku-v1", id: "101", name: "viewer", text: "hello",
    stickers: [{ code: ":smile:", url: "https://cdn.cbox.ws/emotes/smile.png" }]
  });
  assert.equal(sent[0][1], "https://kltratv13.blogspot.com");

  const plain = message("102", "viewer", [text(" :123: ")]);
  observer([{ target: container, addedNodes: [plain] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1][0])), {
    channel: "kltra-danmaku-v1", id: "102", name: "viewer", text: ":123:", stickers: []
  });
});
