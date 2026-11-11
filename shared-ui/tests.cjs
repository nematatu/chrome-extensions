'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
test('all 19 standalone and bundled modules load the same licensed UI assets before feature code',async()=>{
 const {modules}=await import('../unified-tools/modules.mjs');
 assert.equal(modules.length,19);
 const reference=fs.readFileSync(path.join(root,modules[0].source,'ui-kit.js'),'utf8');
 const scope={};vm.runInNewContext(reference,scope);
 assert.equal(typeof scope.MyToolsUI.icon('download'),'string');
 assert.ok(Object.isFrozen(scope.MyToolsUI));
 for(const name of ['download','downloads','check','x','film','music','inbox','alert'])assert.match(scope.MyToolsUI.icon(name),/^<svg /);
 assert.match(scope.MyToolsUI.css,/:root\[data-theme="dark"\]/);
 assert.doesNotMatch(scope.MyToolsUI.css,/(?<!where\()\.mt-ui[\s>]/);
 for(const m of modules){
  const folder=path.join(root,m.source),manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));
  assert.equal(fs.readFileSync(path.join(folder,'ui-kit.js'),'utf8'),reference,m.id);
  for(const file of ['ui-kit.js','ui-tokens.css','UI-LICENSES.txt'])assert.ok(m.files.includes(file),`${m.id}/${file}`);
  for(const entry of manifest.content_scripts||[]){
   if(entry.world==='MAIN'){assert.ok(!entry.js.includes('ui-kit.js'),m.id);continue;}
   if(entry.js?.length)assert.equal(entry.js[0],'ui-kit.js',m.id);
   assert.equal(entry.css[0],'ui-tokens.css',m.id);
  }
  for(const file of new Set([m.popup,m.options].filter(Boolean))){
   const html=fs.readFileSync(path.join(folder,file),'utf8');
   assert.match(html,/<body[^>]+class="[^"]*mt-ui/);
   assert.ok(html.indexOf('ui-kit.js')<html.lastIndexOf('<script'),m.id);
   assert.ok(html.indexOf('ui-tokens.css')<html.indexOf('<style')||!html.includes('<style'),m.id);
  }
 }
});
