const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function event() {const listeners=[];return {listeners,addListener:fn=>listeners.push(fn),removeListener:fn=>listeners.splice(listeners.indexOf(fn),1)};}
const modules=[{id:'instagram',matches:['https://www.instagram.com/*'],startTypes:['ig-download-start']},{id:'gofile',matches:['https://gofile.io/*'],startTypes:['gofile-bulk:start','gofile-bulk:retry']},{id:'photos',matches:['https://photos.google.com/*'],startTypes:[],contentStorage:{local:['safe']}},{id:'sushida',matches:['https://sushida.net/*'],startTypes:['save']},{id:'youtube',matches:['https://www.youtube.com/*'],startTypes:['clip'],offscreen:'offscreen.html'},{id:'tweetfile',matches:['https://tweetfile.com/*'],startTypes:['tweetfile-download'],offscreen:'offscreen.html'},{id:'pagemedia',matches:['https://example.com/*'],startTypes:['start'],offscreen:'offscreen.html'}];
const config={modules,registrations:modules.map(module=>({id:'tools-'+module.id+'-0',module:module.id,matches:module.matches,js:['client.js'],world:'ISOLATED',runAt:'document_idle'}))};
function fixture(initial={},options={}){
 const store={local:{...initial.local},sync:{...initial.sync},session:{...initial.session}};
 const writes=[],imports=[],menuCalls=[],tabMessages=[];let scripts=[{id:'unrelated'}],fail=false,history={'m:1:2:image':1},alive=[],created=0,activeContext=false;
 const chrome={runtime:{id:'native',getURL:path=>'chrome-extension://native/'+path,onMessage:event(),onInstalled:event(),onStartup:event(),getContexts:async()=>activeContext?[{contextType:'OFFSCREEN_DOCUMENT'}]:[],sendMessage:async message=>message.type==='my-tools:offscreen-probe'?{ready:alive}:undefined},storage:{onChanged:event()},scripting:{getRegisteredContentScripts:async()=>scripts,unregisterContentScripts:async({ids})=>{scripts=scripts.filter(script=>!ids.includes(script.id));},registerContentScripts:async next=>{if(fail)throw Error('failed');scripts.push(...next);}},tabs:{query:async()=>options.tabs || [{id:1,url:'https://photos.google.com/x'}],sendMessage:async(...args)=>tabMessages.push(args)},action:{setBadgeText:async value=>menuCalls.push(['badge',value]),setBadgeBackgroundColor:async()=>{}},downloads:{onDeterminingFilename:event()},contextMenus:{create:(value,callback)=>{menuCalls.push(['create',value]);callback?.();return value.id;},remove:(id,callback)=>{menuCalls.push(['remove',id]);callback?.();},update:(id,value,callback)=>{menuCalls.push(['update',id,value]);callback?.();},onClicked:event()},alarms:{create:async(name,value)=>menuCalls.push(['alarm',name,value]),get:async name=>({name}),clear:async()=>true,onAlarm:event()},webRequest:{onBeforeRequest:event()},offscreen:{createDocument:async()=>{created++;activeContext=true;alive=modules.filter(module=>module.offscreen).map(module=>module.id);}}};
 for(const area of ['local','sync','session'])chrome.storage[area]={get:(query,callback)=>{const keys=typeof query==='string'?[query]:Array.isArray(query)?query:query&&Object.keys(query);const value=query&&!Array.isArray(query)&&typeof query==='object'?{...query}:{};for(const [key,item]of Object.entries(store[area]))if(!keys||keys.includes(key))value[key]=item;if(callback)callback(value);else return Promise.resolve(value);},set:(value,callback)=>{writes.push({area,value});Object.assign(store[area],value);if(callback)callback();else return Promise.resolve();},remove:(keys,callback)=>{for(const name of Array.isArray(keys)?keys:[keys])delete store[area][name];callback?.();return Promise.resolve();},setAccessLevel:async()=>{}};
 const context=vm.createContext({chrome,URL,setTimeout:options.setTimeout || setTimeout,clearTimeout,Promise,IGMediaHistory:{read:async()=>({...history}),merge:async map=>{imports.push(map);history={...history,...map};}},MyToolsTransfer:{configure(){},parseBackup:backup=>{if(backup.bad)throw Error('invalid backup');return backup;},makeBackup:(settings,history)=>({settings,instagram:{savedMedia:history}})}});
 for(const file of ['client.js','runtime.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),context);
 const sender={id:'native',url:chrome.runtime.getURL('popup.html')};
 function send(message,from=sender){return new Promise((resolve,reject)=>{let claimed=false;for(const listener of chrome.runtime.onMessage.listeners){const returned=listener(message,from,resolve);if(returned===true)claimed=true;}if(!claimed)reject(Error('message unclaimed'));});}
 return {chrome,context,store,writes,imports,menuCalls,tabMessages,send,boot:()=>context.MyToolsRuntime.boot(config),adapter:id=>context.MyToolsRuntime.moduleChrome(id),scripts:()=>scripts,fail:()=>{fail=true;},created:()=>created};
}
test('boot upgrades two-module settings, migrates legacy keys once without overwriting namespaced records',async()=>{
 const f=fixture({local:{unifiedSettingsV1:{version:1,enabled:{instagram:false,gofile:true}},savedMedia:{old:1},'my-tools:module:instagram:savedMedia':{new:2},gofileBulkDownloadIndexV2:[1]},session:{jobs:[{old:true}]}});
 await f.boot();const result=await f.send({type:'my-tools:get'});assert.equal(result.settings.enabled.instagram,false);assert.equal(result.settings.enabled.youtube,true);
 assert.deepEqual(f.store.local['my-tools:module:instagram:savedMedia'],{new:2});assert.deepEqual(f.store.local.savedMedia,{old:1});assert.deepEqual(f.store.local['my-tools:module:gofile:gofileBulkDownloadIndexV2'],[1]);assert.deepEqual(f.store.session['my-tools:module:instagram:jobs'],[{old:true}]);assert.equal(f.scripts()[0].id,'unrelated');assert.equal(result.modules.length,7);
});
test('enveloped starts toggle atomically, recovery stays available and void handlers close channel',async()=>{
 const f=fixture();await f.boot();let starts=0,recovery=0;
 const adapter=f.adapter('instagram');adapter.runtime.onMessage.addListener((message,sender,reply)=>{if(message.type==='ig-download-start'){starts++;return;}recovery++;reply({ok:true});});adapter.runtime.onMessage.addListener(()=>undefined);
 const sender={id:'native',url:'https://www.instagram.com/p/x/',tab:{id:1}};
 const toggle=f.send({type:'my-tools:set',module:'instagram',enabled:false});const start=f.send({toolModule:'instagram',payload:{type:'ig-download-start'}},sender);await toggle;assert.equal((await start).ok,false);assert.equal(starts,0);
 assert.equal((await f.send({toolModule:'instagram',payload:{type:'ig-download-cancel'}},sender)).ok,true);assert.equal(recovery,1);
 await f.send({type:'my-tools:set',module:'instagram',enabled:true});assert.equal(await f.send({toolModule:'instagram',payload:{type:'ig-download-start'}},sender),undefined);assert.equal(starts,1);
 await assert.rejects(f.send({toolModule:'instagram',payload:{type:'ig-download-start'}},{...sender,url:'https://evil.example/'}));
});
test('management rejects module pages and content storage only permits own keys and host',async()=>{
 const f=fixture();await f.boot();assert.equal((await f.send({type:'my-tools:get'},{id:'native',url:'chrome-extension://native/modules/instagram/popup.html'})).ok,false);
 const sender={id:'native',url:'https://photos.google.com/x',tab:{id:1}};
 const request={type:'my-tools:storage',module:'photos',area:'local',operation:'set',args:[{safe:4}]};assert.equal((await f.send(request,sender)).ok,true);assert.equal(f.store.local['my-tools:module:photos:safe'],4);
 assert.equal((await f.send({...request,args:[{savedMedia:1}]},sender)).ok,false);assert.equal((await f.send(request,{...sender,url:'https://gofile.io/'})).ok,false);assert.equal((await f.send({...request,operation:'clear',args:[]},sender)).ok,false);
});
test('corrupt settings and registration failure are visible',async()=>{
 const f=fixture({local:{unifiedSettingsV1:{version:1,enabled:{instagram:'yes'}}}});await assert.rejects(f.boot());assert.equal((await f.send({type:'my-tools:get'})).ok,false);
 const g=fixture();g.fail();await assert.rejects(g.boot());assert.equal((await g.send({type:'my-tools:get'})).ok,false);
});
test('import validates before history mutation and merges enabled subset',async()=>{
 const f=fixture();await f.boot();assert.equal((await f.send({type:'my-tools:import',backup:{bad:true}})).ok,false);assert.equal(f.imports.length,0);
 await f.send({type:'my-tools:import',backup:{instagram:{savedMedia:{'m:2:3:image':2}},settings:{enabled:{instagram:false}}}});const result=await f.send({type:'my-tools:get'});assert.equal(result.settings.enabled.instagram,false);assert.equal(result.settings.enabled.youtube,true);
});
test('filename broker owns one native listener, awaits async abstention, and reports conflicting claims',async()=>{
 const f=fixture();await f.boot();const a=f.adapter('instagram'),b=f.adapter('gofile');let first,second;
 a.downloads.onDeterminingFilename.addListener((item,suggest)=>{first=suggest;return true;});b.downloads.onDeterminingFilename.addListener((item,suggest)=>{second=suggest;return true;});
 assert.equal(f.chrome.downloads.onDeterminingFilename.listeners.length,1);let calls=0,value;
 const completion=new Promise(resolve=>{f.chrome.downloads.onDeterminingFilename.listeners[0]({id:1},result=>{calls++;value=result;resolve();});});
 first({filename:'a.mp4'});await Promise.resolve();assert.equal(calls,0);second();await completion;assert.equal(calls,1);assert.equal(value.filename,'a.mp4');
 const conflict=new Promise(resolve=>f.chrome.downloads.onDeterminingFilename.listeners[0]({id:2},result=>{assert.equal(result,undefined);resolve();}));first({filename:'a.mp4'});second({filename:'b.mp4'});await conflict;assert.equal((await f.send({type:'my-tools:get'})).errors.length,1);
});
test('menus, alarms, badges, and autonomous capture remain module scoped and honor OFF',async()=>{
 const f=fixture();await f.boot();const a=f.adapter('instagram'),b=f.adapter('sushida');a.contextMenus.create({id:'save',title:'A'});b.contextMenus.create({id:'save',title:'B'});
 await new Promise(resolve=>a.contextMenus.removeAll(resolve));assert.equal(f.menuCalls.filter(value=>value[0]==='remove').length,1);assert.equal(f.menuCalls.find(value=>value[0]==='remove')[1],'my-tools:instagram:save');
 let captured=0;b.webRequest.onBeforeRequest.addListener(()=>captured++,{});f.chrome.webRequest.onBeforeRequest.listeners[0]({});assert.equal(captured,1);await f.send({type:'my-tools:set',module:'sushida',enabled:false});f.chrome.webRequest.onBeforeRequest.listeners[0]({});assert.equal(captured,1);
 await a.alarms.create('queue',{periodInMinutes:1});assert.equal(f.menuCalls.find(value=>value[0]==='alarm')[1],'my-tools:instagram:queue');
 await a.action.setBadgeText({text:'2'});await b.action.setBadgeText({text:'7'});assert.equal(f.menuCalls.filter(value=>value[0]==='badge').at(-1)[1].text,'1');
});
test('concurrent offscreen requests create root once and expose only ready module contexts',async()=>{
 const f=fixture();await f.boot();const a=f.adapter('youtube'),b=f.adapter('tweetfile');assert.equal(await a.offscreen.hasDocument(),false);
 await Promise.all([a.offscreen.createDocument({url:'offscreen.html'}),b.offscreen.createDocument({url:'offscreen.html'})]);assert.equal(f.created(),1);assert.equal(await a.offscreen.hasDocument(),true);
 const list=await b.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[b.runtime.getURL('offscreen.html')]});assert.equal(list[0].documentUrl,b.runtime.getURL('offscreen.html'));
 await b.offscreen.closeDocument();assert.equal(await a.offscreen.hasDocument(),true);await assert.rejects(a.offscreen.createDocument({url:'evil.html'}));
});

test('protected local broadcasts reach only matching host tabs and contain only allowed module keys',async()=>{
 const f=fixture({}, {tabs:[{id:1,url:'https://photos.google.com/x'},{id:2,url:'https://gofile.io/'},{id:3,url:'https://photos.google.com.evil/'},{id:4}]});await f.boot();
 for(const listener of f.chrome.storage.onChanged.listeners)listener({'my-tools:module:photos:safe':{newValue:{album:'visible'}},'my-tools:module:photos:journal':{newValue:'private'},'my-tools:module:instagram:savedMedia':{newValue:'private'}},'local');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.tabMessages.length,1);assert.equal(f.tabMessages[0][0],1);
 assert.deepEqual(Object.keys(f.tabMessages[0][1].changes),['safe']);assert.equal(f.tabMessages[0][1].module,'photos');
});
test('filename timeouts settle once and never hold the settings boundary',async()=>{
 let timeout,late;
 const f=fixture({}, {setTimeout:(callback,delay)=>{if(delay===5000){timeout=callback;return 1;}return setTimeout(callback,delay);}});await f.boot();
 f.adapter('instagram').downloads.onDeterminingFilename.addListener((item,suggest)=>{late=suggest;return true;});
 let calls=0,value='pending';const finished=new Promise(resolve=>f.chrome.downloads.onDeterminingFilename.listeners[0]({id:4},result=>{calls++;value=result;resolve();}));
 assert.equal((await f.send({type:'my-tools:set',module:'instagram',enabled:false})).ok,true);assert.equal(calls,0);
 timeout();await finished;assert.equal(calls,1);assert.equal(value,undefined);
 late({filename:'too-late.mp4'});await Promise.resolve();assert.equal(calls,1);
 assert.equal((await f.send({type:'my-tools:get'})).errors.length,1);
});
test('worker restart restores owned menus for OFF and removeAll and preserves badges',async()=>{
 const f=fixture();await f.boot();const a=f.adapter('instagram'),b=f.adapter('sushida');
 await new Promise(resolve=>a.contextMenus.create({id:'save',title:'A'},resolve));
 await new Promise(resolve=>b.contextMenus.create({id:'save',title:'B'},resolve));
 await a.action.setBadgeText({text:'3'});await b.action.setBadgeText({text:'7'});
 await f.send({type:'my-tools:set',module:'instagram',enabled:false});
 const restarted=fixture({local:f.store.local,session:f.store.session});await restarted.boot();
 const visibility=restarted.menuCalls.filter(call=>call[0]==='update');
 assert.equal(visibility.find(call=>call[1]==='my-tools:instagram:save')[2].visible,false);
 assert.equal(visibility.find(call=>call[1]==='my-tools:sushida:save')[2].visible,true);
 assert.equal(restarted.menuCalls.filter(call=>call[0]==='badge').at(-1)[1].text,'1');
 assert.equal((await restarted.send({type:'my-tools:get'})).badges.sushida.text,'7');
 await new Promise(resolve=>restarted.adapter('instagram').contextMenus.removeAll(resolve));
 assert.deepEqual(restarted.menuCalls.filter(call=>call[0]==='remove').map(call=>call[1]),['my-tools:instagram:save']);
 assert.deepEqual(Object.keys(restarted.store.local['my-tools:presentation:v1'].menus),['my-tools:sushida:save']);
});
test('scoped menu and badge callbacks expose native failures without deleting failed ownership',async()=>{
 const f=fixture();await f.boot();const adapter=f.adapter('instagram');
 await new Promise(resolve=>adapter.contextMenus.create({id:'save',title:'A'},resolve));
 f.chrome.contextMenus.remove=(id,callback)=>{f.chrome.runtime.lastError={message:'remove failed'};callback();delete f.chrome.runtime.lastError;};
 await new Promise(resolve=>adapter.contextMenus.removeAll(()=>{assert.equal(adapter.runtime.lastError.message,'remove failed');resolve();}));
 assert.equal(adapter.runtime.lastError,undefined);
 assert.ok(f.store.local['my-tools:presentation:v1'].menus['my-tools:instagram:save']);
 f.chrome.action.setBadgeText=async()=>{throw Error('badge failed');};
 await new Promise(resolve=>adapter.action.setBadgeText({text:'1'},()=>{assert.equal(adapter.runtime.lastError.message,'badge failed');resolve();}));
 assert.equal(adapter.runtime.lastError,undefined);
});
test('startup module initialization waits for menu restoration while disabled recovery still runs',async()=>{
 const owned='my-tools:instagram:save';
 const f=fixture({local:{unifiedSettingsV1:{version:1,enabled:{instagram:false}},'my-tools:presentation:v1':{menus:{[owned]:{module:'instagram',value:{id:owned,title:'A'}}},badges:{}}}});
 const boot=f.boot();const adapter=f.adapter('instagram');let completed;
 const finished=new Promise(resolve=>{completed=resolve;});
 adapter.runtime.onStartup.addListener(()=>adapter.contextMenus.removeAll(completed));
 for(const listener of f.chrome.runtime.onStartup.listeners)listener();
 assert.equal(f.menuCalls.filter(call=>call[0]==='remove').length,0);
 await boot;await finished;
 assert.deepEqual(f.menuCalls.filter(call=>call[0]==='remove').map(call=>call[1]),[owned]);
 assert.deepEqual(Object.keys(f.store.local['my-tools:presentation:v1'].menus),[]);
});
test('download filenames survive filename events before the native callback and same URL starts serialize',async()=>{
 const f=fixture();await f.boot();const pending=[];
 f.chrome.downloads.download=(options,callback)=>pending.push({options,callback});
 const adapter=f.adapter('youtube');
 const first=adapter.downloads.download({url:'blob:https://www.youtube.com/same',filename:'first.mp4',conflictAction:'uniquify'});
 const second=adapter.downloads.download({url:'blob:https://www.youtube.com/same',filename:'second.mp4'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(pending.length,1);
 const determine=(id,url,owner='native')=>new Promise(resolve=>f.chrome.downloads.onDeterminingFilename.listeners[0]({id,url,byExtensionId:owner},resolve));
 assert.equal((await determine(10,pending[0].options.url)).filename,'first.mp4');
 pending[0].callback(10);assert.equal(await first,10);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(pending.length,2);
 pending[1].callback(11);assert.equal(await second,11);
 assert.equal((await determine(11,pending[1].options.url)).filename,'second.mp4');
 assert.equal(await determine(12,pending[0].options.url,'another-extension'),undefined);
});
test('native filename claims override the requested filename, and callback failures release pending starts',async()=>{
 const f=fixture();await f.boot();const pending=[];
 f.chrome.downloads.download=(options,callback)=>pending.push({options,callback});
 const adapter=f.adapter('youtube');
 adapter.downloads.onDeterminingFilename.addListener((item,suggest)=>suggest({filename:'source-claim.mp4'}));
 const started=adapter.downloads.download({url:'https://example.com/video',filename:'requested.mp4'});
 await new Promise(resolve=>setImmediate(resolve));pending[0].callback(20);await started;
 const name=await new Promise(resolve=>f.chrome.downloads.onDeterminingFilename.listeners[0]({id:20,url:pending[0].options.url,byExtensionId:'native'},resolve));
 assert.equal(name.filename,'source-claim.mp4');
 await new Promise(resolve=>{
   adapter.downloads.download({url:'https://example.com/failure',filename:'failed.mp4'},()=>{assert.equal(adapter.runtime.lastError.message,'download failed');resolve();});
   setImmediate(()=>{f.chrome.runtime.lastError={message:'download failed'};pending[1].callback();delete f.chrome.runtime.lastError;});
 });
 assert.equal(adapter.runtime.lastError,undefined);
 const retry=adapter.downloads.download({url:'https://example.com/failure',filename:'retry.mp4'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(pending.length,3);pending[2].callback(21);assert.equal(await retry,21);
});
test('module page download bridge rejects content and foreign modules while allowing accepted work after OFF',async()=>{
 const f=fixture();await f.boot();f.chrome.downloads.download=(options,callback)=>callback(30);
 const message={type:'my-tools:download',module:'sushida',options:{url:'https://example.com/video',filename:'video.mp4'}};
 for(const sender of [{id:'native',url:'https://sushida.net/',tab:{id:1}},{id:'other',url:'chrome-extension://native/modules/sushida/popup.html'},{id:'native',url:'chrome-extension://native/modules/youtube/offscreen.html'},{id:'native',url:'chrome-extension://native/modules/sushida/../youtube/offscreen.html'}])assert.equal((await f.send(message,sender)).ok,false);
 await f.send({type:'my-tools:set',module:'sushida',enabled:false});
 const result=await f.send(message,{id:'native',url:'chrome-extension://native/modules/sushida/popup.html'});assert.equal(result.ok,true);assert.equal(result.downloadId,30);
 f.chrome.downloads.download=()=>{throw Error('Invalid URL');};
 const invalid=await f.send({...message,options:{}},{id:'native',url:'chrome-extension://native/modules/sushida/popup.html'});assert.equal(invalid.ok,false);assert.equal(invalid.error,'Invalid URL');
});
