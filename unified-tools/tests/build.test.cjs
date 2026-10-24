const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname,'../..');
const rootFiles = ['build.mjs','modules.mjs','identity.json','runtime.js','client.js','portable.js','transfer.js','offscreen-host.js','popup.html','popup.js','popup.css'];
const registry = () => import(pathToFileURL(path.join(root,'unified-tools/modules.mjs')).href).then(value=>value.modules);
async function files(folder, prefix='') {
 const result=[];
 for(const entry of (await fs.readdir(path.join(folder,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  const name=path.join(prefix,entry.name);
  if(entry.isDirectory())result.push(...await files(folder,name));else result.push(name);
 }
 return result;
}
function configuration(folder) {
 const context=vm.createContext({});
 vm.runInContext(require('node:fs').readFileSync(path.join(folder,'config.js'),'utf8'),context);
 return JSON.parse(JSON.stringify(context.MyToolsConfig));
}
function run(target, workspace=root) {
 return execFileSync(process.execPath,[path.join(workspace,'unified-tools/build.mjs'),target],{stdio:'pipe'});
}
async function fixture(temp) {
 const workspace=path.join(temp,'workspace'),tool=path.join(workspace,'unified-tools');
 await fs.mkdir(tool,{recursive:true});
 for(const file of rootFiles)await fs.copyFile(path.join(root,'unified-tools',file),path.join(tool,file));
 for(const module of await registry()){
  for(const file of ['manifest.json',...module.files]) {
   const target=path.join(workspace,module.source,file);await fs.mkdir(path.dirname(target),{recursive:true});
   await fs.copyFile(path.join(root,module.source,file),target);
  }
 }
 return workspace;
}
test('all 19 modules build deterministically with valid manifest and complete resource graph',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'my-tools-build-'));
 try {
 const a=path.join(temp,'a'),b=path.join(temp,'b');run(a);run(b);
 const list=await files(a);assert.deepEqual(list,await files(b));
 for(const file of list) {
  const source=await fs.readFile(path.join(a,file));assert.deepEqual(source,await fs.readFile(path.join(b,file)),file);
  if(file.endsWith('.js'))new vm.Script(source.toString(),{filename:file});
  if(file.endsWith('.mjs'))execFileSync(process.execPath,['--check',path.join(a,file)]);
  assert.doesNotMatch(file,/(?:^|\/)(?:tests?|fixtures?|\.audit|node_modules)(?:\/|$)|README|package-lock|\.mp4$/);
  if(file.endsWith('.html'))for(const match of source.toString().matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
   if(/^(?:[a-z]+:|#)/i.test(match[1]))continue;
   assert.ok(list.includes(path.normalize(path.join(path.dirname(file),match[1].split(/[?#]/)[0]))),`${file} resource ${match[1]}`);
  }
  if(file.endsWith('.mjs'))for(const match of source.toString().matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g))assert.ok(list.includes(path.normalize(path.join(path.dirname(file),match[1]))),`${file} import ${match[1]}`);
 }
 const manifest=JSON.parse(await fs.readFile(path.join(a,'manifest.json'))),config=configuration(a);
 assert.equal(config.modules.length,19);assert.equal(manifest.manifest_version,3);assert.equal(manifest.content_scripts,undefined);assert.equal(manifest.incognito,'not_allowed');assert.equal(manifest.minimum_chrome_version,'120');
 for(const permission of ['scripting','alarms','offscreen','contextMenus','webRequest'])assert.ok(manifest.permissions.includes(permission));
 assert.ok(manifest.host_permissions.includes('https://*/*'));
 assert.equal(manifest.optional_host_permissions,undefined);
 assert.equal(manifest.permissions.includes('windows'),false);
 assert.ok(manifest.commands['birdscore-open']);assert.equal(manifest.commands._execute_action,undefined);
 for(const file of[manifest.background.service_worker,manifest.action.default_popup,manifest.options_ui.page,...manifest.web_accessible_resources.flatMap(item=>item.resources)])assert.ok(list.includes(file));
 assert.ok(crypto.createPublicKey({key:Buffer.from(manifest.key,'base64'),type:'spki',format:'der'}));
 const sourceModules=await registry();
 for(const module of sourceModules) {
  const generated=config.modules.find(item=>item.id===module.id),original=JSON.parse(await fs.readFile(path.join(root,module.source,'manifest.json')));
  assert.equal(generated.worker,module.worker);assert.equal(generated.popup,module.popup);assert.equal(generated.options,module.options);
  for(const [index,script] of (original.content_scripts||[]).entries()) {
   const registration=config.registrations.find(item=>item.id===`tools-${module.id}-${index}`);
   assert.equal(registration.world,script.world||'ISOLATED');assert.equal(registration.runAt,script.run_at||'document_idle');assert.deepEqual(registration.matches,script.matches);
   const mainFiles=new Set((original.content_scripts||[]).filter(item=>item.world==='MAIN').flatMap(item=>item.js||[]));
   assert.deepEqual(registration.js,[...(script.world==='MAIN'?[]:['config.js','client.js']),...(script.js||[]).map(file=>`modules/${module.id}/${script.world!=='MAIN'&&mainFiles.has(file)?'__isolated__/':''}${file}`)]);
   for(const file of [...registration.js,...(registration.css||[])])assert.ok(list.includes(file));
   if(script.world==='MAIN')for(const file of script.js)assert.deepEqual(await fs.readFile(path.join(a,'modules',module.id,file)),await fs.readFile(path.join(root,module.source,file)));
  }
  for(const file of module.files.filter(file=>file.endsWith('.html'))) {
   const html=await fs.readFile(path.join(a,'modules',module.id,file),'utf8');
   const scripts=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match=>path.normalize(path.join('modules',module.id,path.dirname(file),match[1])));
   assert.deepEqual(scripts.slice(0,2),['config.js','client.js']);
  }
 }
 const worker=await fs.readFile(path.join(a,'worker.js'),'utf8');
 for(const module of sourceModules.filter(module=>module.worker))assert.ok(worker.includes(`modules/${module.id}/${module.worker}`));
 const offscreen=await fs.readFile(path.join(a,'offscreen.html'),'utf8');assert.equal([...offscreen.matchAll(/<iframe /g)].length,3);assert.ok(offscreen.indexOf('offscreen-host.js')<offscreen.indexOf('<iframe'));
 run(a);assert.deepEqual(list,await files(a));
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('generated wrappers bind API to module and preserve vendor/global exports',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'my-tools-bindings-'));
 try{
 run(temp);const modules=await registry();
 for(const module of modules) {
  if(module.worker){
   const worker=await fs.readFile(path.join(temp,'modules',module.id,module.worker),'utf8');
   assert.ok(worker.includes(`moduleChrome(${JSON.stringify(module.id)})`));
   assert.ok(worker.includes(JSON.stringify(`modules/${module.id}/`)));
  }
  for(const file of module.files.filter(file=>file.startsWith('vendor/')))assert.deepEqual(await fs.readFile(path.join(temp,'modules',module.id,file)),await fs.readFile(path.join(root,module.source,file)));
 }
 const context=vm.createContext({globalThis:null,MyToolsClient:{moduleChrome:()=>({})}});context.globalThis=context;
 for(const [id,file,name] of [['instagram','core.js','IGMediaCore'],['gofile','core.js','GofileBulkCore'],['pagemedia','core.js','PageMediaBulkCore'],['badspi','quality-core.js','BadspiImageCore'],['instagramhq','quality-core.js','InstagramHighQualityCore'],['stripchat','core.js','StripchatLiveHoverCore'],['momoniji','download-core.js','MomonijiDownloads'],['momoniji','library-core.js','MomonijiLibrary'],['youtube','clip.js','YouTubeFiveSecondClip']]) {
  vm.runInContext(await fs.readFile(path.join(temp,'modules',id,file),'utf8'),context);assert.ok(context[name],name);
 }
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('build refuses to delete an unmarked existing directory',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'my-tools-protect-'));
 try{
 await fs.writeFile(path.join(temp,'keep.txt'),'keep');assert.throws(()=>run(temp),/not generated by My Tools/);assert.equal(await fs.readFile(path.join(temp,'keep.txt'),'utf8'),'keep');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('failed generation preserves previous output and source-manifest additions cannot be omitted',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'my-tools-preserve-'));
 try{
 const workspace=await fixture(temp),tool=path.join(workspace,'unified-tools'),output=path.join(temp,'output');
 const snapshot=async()=>Object.fromEntries(await Promise.all((await files(output)).map(async file=>[file,(await fs.readFile(path.join(output,file))).toString('hex')])));
 run(output,workspace);await fs.writeFile(path.join(output,'sentinel.txt'),'previous working extension');const before=await snapshot();
 const module=(await registry()).find(module=>module.id==='gofile'),missing=path.join(workspace,module.source,'content.js'),original=await fs.readFile(missing);await fs.rm(missing);
 assert.throws(()=>run(output,workspace),/ENOENT/);assert.deepEqual(await snapshot(),before);assert.deepEqual((await fs.readdir(temp)).sort(),['output','workspace']);await fs.writeFile(missing,original);
 const invalid=path.join(tool,'popup.js');await fs.writeFile(invalid,'function broken( {');assert.throws(()=>run(output,workspace),/SyntaxError/);assert.deepEqual(await snapshot(),before);await fs.copyFile(path.join(root,'unified-tools/popup.js'),invalid);
 const added=path.join(workspace,'new-extension');await fs.mkdir(added);await fs.writeFile(path.join(added,'manifest.json'),'{}');assert.throws(()=>run(output,workspace),/Source manifests and module registry differ/);assert.deepEqual(await snapshot(),before);await fs.rm(added,{recursive:true});
 run(output,workspace);assert.ok(!(await files(output)).includes('sentinel.txt'));assert.deepEqual((await fs.readdir(temp)).sort(),['output','workspace']);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
