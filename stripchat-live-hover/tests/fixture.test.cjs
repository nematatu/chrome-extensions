const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

test("検証HTMLのCSSとスクリプトがファイルの相対パスから解決できる", () => {
  const fixture = path.join(__dirname, "fixture.html");
  const html = fs.readFileSync(fixture, "utf8");
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.equal(assets.length, 6);
  for (const asset of assets) {
    assert.equal(asset.startsWith("/"), false, asset);
    const resolved = fileURLToPath(new URL(asset, pathToFileURL(fixture)));
    assert.ok(fs.existsSync(resolved), asset);
  }
});

test("合成動画を同梱し、一時ディレクトリやHTTPルートの動画に依存しない", () => {
  const source = fs.readFileSync(path.join(__dirname, "fixture-native.js"), "utf8");
  assert.ok(source.includes('video.src = "./demo.mp4"'));
  const mp4 = fs.readFileSync(path.join(__dirname, "demo.mp4"));
  assert.equal(mp4.subarray(4, 8).toString("ascii"), "ftyp");
  assert.ok(mp4.includes(Buffer.from("moov")));
  assert.ok(mp4.includes(Buffer.from("mdat")));
});
