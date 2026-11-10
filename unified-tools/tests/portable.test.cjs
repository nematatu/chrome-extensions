const test = require('node:test');
const assert = require('node:assert/strict');
const portable = require('../portable.js');
const transfer = require('../transfer.js');
test('portable preferences contain only explicit user settings and preserve exact values', () => {
  const preferences = { instagram: { downloadEnabled: true, enabled: false, rotateLive: true }, inhighskip: { skipSeconds: 7, keyboardEnabled: false }, kltra: { enabled: true, fontSize: 25, translationSource: 'id', translationEngine: 'local' }, r2: { baseUrlTemplate: 'https://images.example/{bucket}/{key}', maxWidth: 280, hoverOnly: true }, xhashtags: { hashtags: '#badminton\n#test' }, googlephotos: { 'gpu-panel-collapsed-v1': false }, sushida: { settings: { settingsVersion: 2, autoDownloadCsv: true, autoDownloadJson: true, autoResultNetworkRecord: false } } };
  assert.deepEqual(portable.validate(preferences), preferences);
  const backup = transfer.makeBackup({ enabled: { instagram: true, gofile: false } }, {}, preferences);
  assert.deepEqual(transfer.parseBackup(JSON.parse(JSON.stringify(backup))).preferences, preferences);
});
test('portable preferences reject queue data, invalid ranges, prototypes and signed templates', () => {
  for (const value of [[], null, { gofile: { jobs: [] } }, { sushida: { results: [] } }, { googlephotos: { 'gpu-albums-v2': [] } }, { instagramhq: { enabled: 'true' } }, { inhighskip: { skipSeconds: 1.5 } }, { inhighskip: { skipSeconds: 301 } }, { kltra: { translationEngine: 'external' } }, { r2: { baseUrlTemplate: 'https://example.com/{key}?token=secret' } }, { r2: { baseUrlTemplate: 'https://user:secret@example.com/{key}' } }, { r2: { baseUrlTemplate: 'javascript:alert(1)' } }, { r2: { baseUrlTemplate: 'https://example.com/{unknown}' } }, { r2: { maxWidth: Infinity } }, { xhashtags: { hashtags: 'x'.repeat(16385) } }, { sushida: { settings: { autoDownloadCsv: false, autoDownloadJson: true } } }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => portable.validate(value));
});
test('legacy two-module backup accepts registry expansion and unknown modules still reject', async () => {
  const { modules } = await import('../modules.mjs');
  transfer.configure(modules);
  const legacy = { format: 'nematatu-tools', version: 1, settings: { enabled: { instagram: false, gofile: true } }, instagram: { savedMedia: {} } };
  assert.deepEqual(transfer.parseBackup(legacy).settings.enabled, legacy.settings.enabled);
  const current = transfer.makeBackup({ enabled: Object.fromEntries(modules.map(module => [module.id, true])) }, {});
  assert.equal(Object.keys(current.settings.enabled).length, 19);
  assert.throws(() => transfer.parseBackup({ ...legacy, settings: { enabled: { unknown: true } } }));
});

test('legacy Instagram backup maps four independent module states to better-ig',()=>{
 transfer.configure([{id:'instagram'},{id:'gofile'}]);
 for(const download of [false,true])for(const high of [false,true]){
  const old={format:'nematatu-tools',version:1,settings:{enabled:{instagram:download,instagramhq:high,gofile:false}},preferences:{instagramhq:{enabled:true,rotateLive:true}},instagram:{savedMedia:{'m:1:2:image':1}}};
  const result=transfer.parseBackup(old);
  assert.deepEqual(result.settings.enabled,{instagram:download||high,gofile:false});
  assert.deepEqual(result.preferences,{instagram:{downloadEnabled:download,enabled:high,rotateLive:high}});
  assert.deepEqual(transfer.parseBackup(JSON.parse(JSON.stringify(result))),result);
 }
});
test('backups from before a module was removed still import without its flag',()=>{
 transfer.configure([{id:'instagram'},{id:'gofile'}]);
 const result=transfer.parseBackup({format:'nematatu-tools',version:1,settings:{enabled:{instagram:true,gofile:false,youtube:true}},instagram:{savedMedia:{}}});
 assert.deepEqual(result.settings.enabled,{instagram:true,gofile:false});
 assert.throws(()=>transfer.parseBackup({format:'nematatu-tools',version:1,settings:{enabled:{instagram:true,youtube:'yes'}},instagram:{savedMedia:{}}}));
});
test('legacy HQ preferences are accepted but current explicit settings win',()=>{
 assert.deepEqual(portable.validate({instagramhq:{enabled:true,rotateLive:false},instagram:{enabled:false,downloadEnabled:true}}),{instagram:{enabled:false,rotateLive:false,downloadEnabled:true}});
 assert.throws(()=>portable.validate({instagramhq:{downloadEnabled:true}}));
 assert.throws(()=>transfer.parseBackup({format:'nematatu-tools',version:1,settings:{enabled:{instagramhq:'true'}},instagram:{savedMedia:{}}}));
});
