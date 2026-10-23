"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const DIR = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
test("Gofile版と同じページ内UI構成で、対象サイトのISOLATED worldだけに読み込む", () => {
  assert.equal(manifest.manifest_version, 3); assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.version, "1.8.2"); assert.equal(manifest.minimum_chrome_version, "111");
  assert.deepEqual(manifest.permissions.sort(), ["downloads", "offscreen", "scripting", "storage", "unlimitedStorage"]);
  assert.deepEqual(manifest.host_permissions, ["https://video.twimg.news/*", "https://twfiles.com/*",
    "https://video.twimg1.com/*", "https://gofile.run/*", "https://gofile.ing/*",
    "https://video.twimg-film.com/*", "https://gofile.es/*", "https://cdn4.file-photo.com/*", "https://gofile.guru/*", "https://cdn.twimg-image.com/*", "https://gofile.pl/*", "https://video.twimg-com.com/*",
    "https://rwzugqnp.fun800.click/*", "https://vid.fun800.click/*"]);
  assert.deepEqual(manifest.content_scripts, [{matches: ["https://video.twimg.news/d/*", "https://twfiles.com/*",
    "https://video.twimg1.com/*", "https://gofile.run/*", "https://gofile.ing/*",
    "https://video.twimg-film.com/*", "https://gofile.es/*", "https://cdn4.file-photo.com/*", "https://gofile.guru/*", "https://cdn.twimg-image.com/*", "https://gofile.pl/*", "https://video.twimg-com.com/*"], js: ["core.js", "content.js"],
    run_at: "document_idle", all_frames: false, world: "ISOLATED"}]);
  assert.equal(manifest.action, undefined); assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
});
test("manifestのローカル参照が存在し、遠隔実行コードや履歴削除・危険判定承認を含まない", () => {
  for (const file of [manifest.background.service_worker, "collector.js", "hosted-collector.js", "mp4.js", "hls.js", "offscreen.html", "offscreen.js", "vendor/mux.min.js", "vendor/mux.js-LICENSE", ...manifest.content_scripts.flatMap(script => script.js)]) {
    assert.ok(fs.existsSync(path.join(DIR, file)), file);
  }
  const html = fs.readFileSync(path.join(DIR, "offscreen.html"), "utf8");
  assert.match(html, /src="vendor\/mux\.min\.js"[^]*src="mp4\.js"[^]*src="hls\.js"/);
  for (const file of fs.readdirSync(DIR).filter(file => file.endsWith(".js") || file.endsWith(".html"))) {
    const source = fs.readFileSync(path.join(DIR, file), "utf8");
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(|<script[^>]+https?:/i);
    assert.doesNotMatch(source, /acceptDanger|downloads\.(erase|removeFile)/);
  }
});
