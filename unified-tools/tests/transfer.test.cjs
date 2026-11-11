const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../transfer.js');
const history = { 'm:123:456:image': Date.now(), ['f:' + 'a'.repeat(64)]: Date.now() };
const settings = { version: 1, enabled: { instagram: true, gofile: false } };
test('portable backup retains only settings booleans and validated history', () => {
  const backup = t.makeBackup(settings, history);
  assert.deepEqual(backup.settings, { enabled: settings.enabled });
  assert.deepEqual(t.parseBackup(JSON.parse(JSON.stringify(backup))), backup);
  assert.deepEqual(t.parseBackup({ format: 'nematatu-tools', version: 1, instagram: { savedMedia: history } }).instagram.savedMedia, history);
  assert.equal('version' in backup.settings, false);
  const grown = Object.fromEntries(Array.from({ length: 100002 }, (_, i) => [`g:${i}`, 1]));
  const restored = t.parseBackup(JSON.parse(JSON.stringify(t.makeBackup(settings, grown))));
  assert.deepEqual(restored.instagram.savedMedia, grown);
});
test('rejects unsupported schema, unsafe keys, queues, URLs and invalid times', () => {
  const good = t.makeBackup(settings, history);
  for (const value of [null, [], {}, { ...good, version: 2 }, { ...good, token: 'secret' },
    { ...good, settings: { enabled: { instagram: true, gofile: 'true' } } },
    { ...good, settings: { enabled: { ...settings.enabled, other: true } } },
    { ...good, instagram: { savedMedia: {}, jobs: [] } },
    { ...good, instagram: { savedMedia: { 'https://scontent.cdninstagram.com/file.jpg': Date.now() } } },
    { ...good, instagram: { savedMedia: { 'm:1:2:video': Date.now() + 2 * 86400000 } } },
    { ...good, instagram: { savedMedia: { 'm:1:2:video': 0 } } },
    JSON.parse(JSON.stringify(good).replace('"format":', '"__proto__":{},"format":'))]) assert.throws(() => t.parseBackup(value));
});
test('bounds serialized input before handing large input to worker', () => {
  assert.throws(() => t.parseBackup({ extra: 'x'.repeat(t.MAX_BYTES + 1) }), /20MiB/);
  const circular = {}; circular.self = circular;
  assert.throws(() => t.parseBackup(circular));
});
