"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionDir = __dirname;

test("Manifest V3と必要な権限・対象範囲だけを宣言する", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "102");
  assert.deepEqual([...manifest.permissions].sort(), ["downloads", "scripting", "storage", "unlimitedStorage"]);
  assert.deepEqual(manifest.host_permissions, ["https://gofile.io/*"]);
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://gofile.io/d/*"]);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.externally_connectable, undefined);
});

test("Manifestから参照するローカルファイルがすべて存在する", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  const files = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((script) => [...(script.js || []), ...(script.css || [])]),
  ];
  for (const file of files) assert.equal(fs.existsSync(path.join(extensionDir, file)), true, file);
});

test("拡張パッケージにリモートコードや動的コード実行を含めない", () => {
  const javascriptFiles = fs.readdirSync(extensionDir).filter((file) => file.endsWith(".js"));
  for (const file of javascriptFiles) {
    const source = fs.readFileSync(path.join(extensionDir, file), "utf8");
    assert.doesNotMatch(source, /\beval\s*\(/, file);
    assert.doesNotMatch(source, /\bnew\s+Function\s*\(/, file);
    assert.doesNotMatch(source, /<script[^>]+https?:/i, file);
  }
});
