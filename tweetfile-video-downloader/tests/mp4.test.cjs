const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const context = {window:{}, Uint8Array, ArrayBuffer, DataView};
require('node:vm').runInNewContext(fs.readFileSync(__dirname+'/../vendor/mux.min.js','utf8'), context);
globalThis.muxjs = context.muxjs;
require('../mp4.js');
test('transmuxes generated H.264/AAC TS into MP4 containing both tracks',async()=>{
  const blob = new Blob([fs.readFileSync(__dirname+'/fixtures/segment0.ts'),fs.readFileSync(__dirname+'/fixtures/segment1.ts')]);
  const mp4=await TweetfileMP4.toMp4(blob);
  const data=Buffer.from(await mp4.arrayBuffer());
  assert.equal(mp4.type,'video/mp4');
  assert.equal(data.toString('ascii',4,8),'ftyp');
  for(const box of ['moov','moof','mdat','avc1','mp4a']) assert.ok(data.includes(Buffer.from(box)),box);
});
test('rejects invalid TS instead of saving a renamed file',async()=>{
  await assert.rejects(TweetfileMP4.toMp4(new Blob(['invalid TS'])));
});
