const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const extension = path.join(__dirname, '..', 'extension');

test('MV3 package contains every declared script and restricts permissions to required hosts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '120');
  assert.deepEqual(manifest.permissions, ['downloads', 'storage', 'alarms', 'contextMenus']);
  assert.deepEqual(manifest.host_permissions, ['https://momoniji.com/*', 'https://www.momoniji.com/*']);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  for (const entry of manifest.content_scripts) {
    assert.deepEqual(entry.matches, manifest.host_permissions);
    assert.equal(entry.run_at, 'document_idle');
    for (const file of entry.js) assert.ok(fs.statSync(path.join(extension, file)).isFile());
  }
  assert.ok(fs.statSync(path.join(extension, manifest.background.service_worker)).isFile());
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.ok(fs.statSync(path.join(extension, 'popup.html')).isFile());
});

test('bundled OSS and original source match their recorded SHA256 and include MIT attribution', () => {
  const vendor = path.join(extension, 'vendor');
  const metadata = JSON.parse(fs.readFileSync(path.join(vendor, 'provenance.json')));
  const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, file))).digest('hex');
  assert.equal(sha256('manga-viewer.original.js'), metadata.upstream_source_sha256);
  assert.equal(sha256('manga-viewer.js'), metadata.classic_bundle_sha256);
  assert.equal(metadata.license, 'MIT');
  assert.match(fs.readFileSync(path.join(vendor, 'LICENSE.manga-viewer'), 'utf8'), /MIT License/);
  assert.match(metadata.commit, /^[a-f0-9]{40}$/);
  const bundle = fs.readFileSync(path.join(vendor, 'manga-viewer.js'), 'utf8');
  assert.ok(!/\beval\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(/.test(bundle));
});
