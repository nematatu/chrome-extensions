"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("manifest is a self-contained Manifest V3 build", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Media Saver");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length > 20 && manifest.description.length <= 132);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.options_ui.page, "options.html");
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'");
  assert.equal(manifest.update_url, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(Number(manifest.minimum_chrome_version) >= 109);
});

test("permissions are the documented minimum for detection and saving", () => {
  assert.deepEqual([...manifest.permissions].sort(), [
    "alarms", "downloads", "offscreen", "scripting", "storage", "tabs", "unlimitedStorage", "webRequest"
  ]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});

test("every referenced extension file exists", () => {
  const referenced = new Set([
    manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)
  ]);
  for (const file of referenced) assert.ok(fs.existsSync(path.join(root, file)), file);

  const html = ["popup.html", "options.html", "offscreen.html"].map(name => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^(https?:|data:|blob:)/.test(match[1])) continue;
    assert.ok(fs.existsSync(path.join(root, match[1])), match[1]);
  }
});

test("icons are valid PNGs with the declared dimensions", () => {
  for (const [size, file] of Object.entries(manifest.icons)) {
    const bytes = fs.readFileSync(path.join(root, file));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file);
    assert.equal(bytes.readUInt32BE(16), Number(size), file);
    assert.equal(bytes.readUInt32BE(20), Number(size), file);
  }
});

test("extension pages do not load remote code or use inline scripts", () => {
  for (const name of ["popup.html", "options.html", "offscreen.html"]) {
    const html = fs.readFileSync(path.join(root, name), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name} has inline script`);
    assert.doesNotMatch(html, /(?:src|href)="https?:/i, `${name} loads a remote resource`);
    assert.doesNotMatch(html, /\son\w+\s*=/i, `${name} uses inline handlers`);
  }
  for (const file of fs.readdirSync(root).filter(name => name.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(code, /\beval\s*\(/, file);
    assert.doesNotMatch(code, /\bnew\s+Function\s*\(/, file);
  }
});

test("the vendored mux.js license is present", () => {
  const license = fs.readFileSync(path.join(root, "vendor", "mux.js-LICENSE"), "utf8");
  assert.match(license, /Apache License/);
  assert.match(fs.readFileSync(path.join(root, "vendor", "mux.min.js"), "utf8"), /mux\.js/);
});
