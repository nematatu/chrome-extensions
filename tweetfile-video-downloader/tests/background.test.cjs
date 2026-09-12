const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  let listener; const calls = [];
  const context = vm.createContext({ URL, chrome: { runtime: { id: 'test', getURL: path => 'chrome-extension://test/'+path, onMessage: { addListener(fn) { listener ||= fn; } } }, downloads: { async download(options) { calls.push(options); if (options.url.includes('fail')) throw new Error('NETWORK_FAILED'); return calls.length; } } } });
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context);
  const sender = {id:'test',tab:{id:1},url:'https://cdn.tweetfile.com/y95CCs'};
  return {calls,listener,sender,send:items=>new Promise(resolve=>listener({type:'tweetfile-download',items},sender,resolve))};
}
test('selected videos download once with safe filenames; one failure does not stop batch', async()=>{
 const t=setup(); const a={url:'https://media.example/a.mp4?token=abc',name:'../bad:name.mp4'};
 const result=await t.send([a,a,{url:'https://media.example/fail.mp4',name:'bad'},{url:'https://media.example/b.webm',name:'good'}]);
 assert.equal(t.calls.length,3); assert.equal(result.results.length,3); assert.equal(result.results[1].error,'NETWORK_FAILED'); assert.equal(result.results[2].id,3);
 assert.equal(t.calls[0].url,a.url); assert.match(t.calls[0].filename,/^Tweetfile\/001_[^/]+\.mp4$/); assert.equal(t.calls[2].filename,'Tweetfile/003_good.webm');
});
test('rejects invalid protocols',async()=>{
 for(const url of ['file:///etc/passwd','javascript:alert(1)']) {const t=setup(); assert.ok((await t.send([{url}])).error); assert.equal(t.calls.length,0);}
});
test('ignores messages from other websites',()=>{const t=setup();assert.equal(t.listener({type:'tweetfile-download',items:[]},{...t.sender,url:'https://example.com'},()=>assert.fail()),undefined);assert.equal(t.calls.length,0);});
