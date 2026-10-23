const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../manifest.json");

test("MV3・日本語版の対象サイトだけを指定し、追加の権限・外部コードを要求しない", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.background, undefined);
  for (const entry of manifest.content_scripts) {
    assert.deepEqual(entry.matches, ["https://ja.stripchat.com/*"]);
    assert.equal(entry.run_at, "document_start");
    for (const file of [...entry.js, ...(entry.css || [])]) {
      assert.ok(fs.existsSync(path.join(__dirname, "..", file)), file);
      assert.equal(file.includes(".."), false);
      assert.equal(file.includes("://"), false);
    }
  }
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.notEqual(manifest.content_scripts[1].world, "MAIN");
});
