const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../hls.js');
function fixture(files) {
 const calls=[];
 return {calls,fetch:async address=>{
   calls.push(address); const body=files[address.replace('https://media.example/','')];
   return new Response(body ?? '',{status:body===undefined?404:200});
 }};
}
test('chooses highest-bandwidth variant and assembles relative TS segments in order',async()=>{
 const f=fixture({'master.m3u8':'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nhigh/list.m3u8',
 'high/list.m3u8':'#EXTM3U\n#EXTINF:2,\none.ts\n#EXTINF:2,\n../two.ts\n#EXT-X-ENDLIST','high/one.ts':new Uint8Array([71,1]),'two.ts':new Uint8Array([71,2])});
 const result=await TweetfileHLS.assemble('https://media.example/master.m3u8',f);
 assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())],[71,1,71,2]);assert.equal(result.extension,'ts');assert.ok(!f.calls.some(x=>x.endsWith('low.m3u8')));
});
test('assembles fMP4 initialization and byte ranges even when server ignores Range',async()=>{
 const f=fixture({'list.m3u8':'#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\n#EXT-X-BYTERANGE:2@1\nall.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:2\nall.mp4\n#EXT-X-ENDLIST','init.mp4':new Uint8Array([9]),'all.mp4':new Uint8Array([0,1,2,3,4,5])});
 const result=await TweetfileHLS.assemble('https://media.example/list.m3u8',f);
 assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())],[9,1,2,3,4]);assert.equal(result.extension,'mp4');
});
test('decrypts AES-128 using media sequence IV',async()=>{
 const raw=crypto.getRandomValues(new Uint8Array(16));
 const key=await crypto.subtle.importKey('raw',raw,{name:'AES-CBC'},false,['encrypt']);
 const iv=new Uint8Array(16);iv[15]=42;
 const encrypted=await crypto.subtle.encrypt({name:'AES-CBC',iv},key,new Uint8Array([71,2,3]));
 const f=fixture({'list.m3u8':'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST','key':raw,'segment.ts':encrypted});
 const result=await TweetfileHLS.assemble('https://media.example/list.m3u8',f);
 assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())],[71,2,3]);
});
test('does not save incomplete playlists or failed segments as successful videos',async()=>{
 for(const content of ['#EXTM3U\n#EXTINF:2,\nmissing.ts','#EXTM3U\n#EXTINF:2,\nmissing.ts\n#EXT-X-ENDLIST']) {
  const f=fixture({'list.m3u8':content});await assert.rejects(TweetfileHLS.assemble('https://media.example/list.m3u8',f));
 }
});
