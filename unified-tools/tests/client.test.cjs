const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function event() { const listeners = new Set(); return { listeners, addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) }; }
function fixture(page = true) {
  const onMessage = event(), onChanged = event(), calls = [];
  const data = { local: {}, sync: {}, session: {} };
  const chrome = { runtime: { id: 'native', getURL: path => 'chrome-extension://native/' + path, onMessage, sendMessage: (...args) => { calls.push(args); const cb = args.at(-1); if (typeof cb === 'function') cb({ok:true,value:{safe:3}}); else return Promise.resolve({ok:true,value:{safe:3}}); } }, storage: { onChanged }, tabs: { sendMessage: (...args) => { calls.push(args); return Promise.resolve(); } } };
  for (const area of Object.keys(data)) chrome.storage[area] = {
    get(query, callback) { const keys = typeof query === 'string' ? [query] : Array.isArray(query) ? query : query && Object.keys(query); const result = query && !Array.isArray(query) && typeof query === 'object' ? {...query} : {}; for (const [key,value] of Object.entries(data[area])) if (!keys || keys.includes(key)) result[key]=value; if(callback)callback(result);else return Promise.resolve(result); },
    set(value, callback) { Object.assign(data[area], value); if(callback)callback();else return Promise.resolve(); },
    remove(keys, callback) { for(const key of Array.isArray(keys)?keys:[keys])delete data[area][key];if(callback)callback();else return Promise.resolve(); },
    getBytesInUse(keys, callback) { callback(keys.length * 10); },
    setAccessLevel: async () => undefined
  };
  const modules = [{id:'a',matches:['https://example.com/*']},{id:'b',matches:['https://other.com/*']}];
  const context = vm.createContext({ chrome, URL, Promise, location:{protocol:page?'chrome-extension:':'https:'}, MyToolsConfig:{modules} });
  vm.runInContext(fs.readFileSync(require.resolve('../client.js'),'utf8'),context);
  return {chrome,data,calls,context,modules,client:context.MyToolsClient};
}
module.exports = {fixture,event};
test('storage namespaces defaults, null, callbacks, clear, and change events', async()=>{
 const f=fixture();const a=f.client.moduleChrome('a'),b=f.client.moduleChrome('b');
 await a.storage.local.set({jobs:[1],enabled:true});await b.storage.local.set({jobs:[2],enabled:false});
 assert.deepEqual(JSON.parse(JSON.stringify(await a.storage.local.get(null))),{jobs:[1],enabled:true});
 assert.deepEqual(JSON.parse(JSON.stringify(await a.storage.local.get({jobs:[],missing:7}))),{jobs:[1],missing:7});
 assert.equal(await a.storage.local.getBytesInUse(null),20);
 await new Promise(resolve=>a.storage.local.get('enabled',value=>{assert.equal(value.enabled,true);resolve();}));
 const notifications=[];a.storage.onChanged.addListener((changes,area)=>notifications.push({changes,area}));
 for(const listener of f.chrome.storage.onChanged.listeners)listener({'my-tools:module:a:enabled':{newValue:false},'my-tools:module:b:enabled':{newValue:true}},'local');
 assert.equal(notifications.length,1);assert.deepEqual(Object.keys(notifications[0].changes),['enabled']);
 await a.storage.local.clear();assert.deepEqual(Object.keys(await a.storage.local.get(null)),[]);assert.deepEqual(JSON.parse(JSON.stringify(await b.storage.local.get('jobs'))),{jobs:[2]});
});
test('runtime envelopes preserve actual sender and callback lastError',async()=>{
 const f=fixture(),a=f.client.moduleChrome('a');let seen;
 a.runtime.onMessage.addListener((message,sender)=>{seen={message,sender};return true;});
 const wrapped=[...f.chrome.runtime.onMessage.listeners][0];
 const sender={id:'native',url:'https://example.com/path',tab:{id:4},documentId:'real'};
 assert.equal(wrapped({toolModule:'a',payload:{type:'go'}},sender,()=>{}),true);assert.equal(seen.sender,sender);
 seen=undefined;wrapped({toolModule:'a',payload:{}},{...sender,url:'https://other.com/path'},()=>{});assert.equal(seen,undefined);
 wrapped({toolModule:'b',payload:{}},sender,()=>{});assert.equal(seen,undefined);
 a.runtime.sendMessage({type:'go'},()=>{});assert.equal(f.calls[0][0].toolModule,'a');
 assert.equal(a.runtime.getURL(''),'chrome-extension://native/');assert.equal(a.runtime.getURL('file'),'chrome-extension://native/modules/a/file');
 f.chrome.runtime.lastError={message:'native error'};assert.equal(a.runtime.lastError.message,'native error');
 await assert.rejects(a.storage.local.setAccessLevel({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'}));
});
test('content local calls use privileged bridge and protected change broadcasts',async()=>{
 const f=fixture(false),a=f.client.moduleChrome('a');assert.equal((await a.storage.local.get('safe')).safe,3);
 assert.equal(f.calls[0][0].type,'my-tools:storage');assert.equal(f.calls[0][0].module,'a');
 let count=0;a.storage.onChanged.addListener(()=>count++);
 const message={type:'my-tools:storage-changed',module:'a',changes:{safe:{newValue:4}},area:'local'};
 for(const listener of f.chrome.runtime.onMessage.listeners)listener(message,{id:'native',url:'https://example.com/'},()=>{});
 assert.equal(count,0);
 for(const listener of f.chrome.runtime.onMessage.listeners)listener(message,{id:'native',url:'chrome-extension://native/worker.js'},()=>{});
 assert.equal(count,1);
});
test('storage callback failure exposes lastError only within callback',async()=>{
 const f=fixture();const adapter=f.client.create('a',{hooks:{ready:()=>Promise.reject(Error('failed read'))}});
 await new Promise(resolve=>adapter.storage.local.get('x',()=>{assert.equal(adapter.runtime.lastError.message,'failed read');resolve();}));
 assert.equal(adapter.runtime.lastError,undefined);
});
test('actual sender host matching rejects lookalikes and extension traversal',()=>{
 const f=fixture();const module=f.modules[0];
 const auth=url=>f.client.authorized(module,{id:'native',url,tab:{id:1}});
 assert.equal(auth('https://example.com/ok'),true);assert.equal(auth('https://example.com.evil/path'),false);assert.equal(auth('http://example.com/'),false);
 assert.equal(auth('chrome-extension://native/modules/a/popup.html'),true);assert.equal(auth('chrome-extension://native/modules/a/../b/popup.html'),false);
});
test('repeated client registration retains one adapter and one storage dispatcher',()=>{
 const f=fixture(false),adapter=f.client.moduleChrome('a');let changes=0;
 const listener=()=>changes++;
 adapter.storage.onChanged.addListener(listener);adapter.storage.onChanged.addListener(listener);
 const before=f.chrome.runtime.onMessage.listeners.size;
 vm.runInContext(fs.readFileSync(require.resolve('../client.js'),'utf8'),f.context);
 assert.equal(f.context.MyToolsClient,f.client);assert.equal(f.context.MyToolsClient.moduleChrome('a'),adapter);
 assert.equal(f.chrome.runtime.onMessage.listeners.size,before);assert.equal(f.chrome.storage.onChanged.listeners.size,1);
 for(const callback of f.chrome.storage.onChanged.listeners)callback({'my-tools:module:a:enabled':{newValue:true}},'sync');
 assert.equal(changes,1);adapter.storage.onChanged.removeListener(listener);assert.equal(f.chrome.storage.onChanged.listeners.size,0);
});
test('manager Instagram bulk request is accepted without opening other module messages',()=>{
 const f=fixture();f.context.MyToolsConfig.modules.push({id:'instagram',matches:['https://www.instagram.com/*']});
 const adapter=f.client.moduleChrome('instagram');const seen=[];
 adapter.runtime.onMessage.addListener(message=>seen.push(message.type));
 const sender={id:'native',url:'chrome-extension://native/popup.html'};
 for(const listener of f.chrome.runtime.onMessage.listeners){
  listener({toolModule:'instagram',payload:{type:'ig-download-page'}},sender,()=>{});
  listener({toolModule:'instagram',payload:{type:'ig-download-start'}},sender,()=>{});
  listener({toolModule:'instagram',payload:{type:'ig-download-page'}},{...sender,url:'chrome-extension://native/modules/a/popup.html'},()=>{});
 }
 assert.deepEqual(seen,['ig-download-page']);
});
test('extension pages route download names through the privileged bridge and preserve callback errors',async()=>{
 const f=fixture();f.chrome.downloads={download(){throw Error('unscoped download');}};
 const adapter=f.client.moduleChrome('a');
 f.chrome.runtime.sendMessage=async message=>{f.calls.push([message]);return {ok:true,downloadId:17};};
 assert.equal(await adapter.downloads.download({url:'blob:example',filename:'clip.mp4'}),17);
 assert.equal(f.calls[0][0].type,'my-tools:download');assert.equal(f.calls[0][0].module,'a');assert.equal(f.calls[0][0].options.filename,'clip.mp4');
 f.chrome.runtime.sendMessage=async()=>({ok:false,error:'invalid download'});
 await new Promise(resolve=>adapter.downloads.download({},()=>{assert.equal(adapter.runtime.lastError.message,'invalid download');resolve();}));assert.equal(adapter.runtime.lastError,undefined);
});
