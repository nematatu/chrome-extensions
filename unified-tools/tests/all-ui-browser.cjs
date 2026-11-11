'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
(async()=>{
 const {modules}=await import('../modules.mjs');
 const root=path.resolve(__dirname,'../..');
 const output=path.resolve(__dirname,'../test-results/ui');fs.mkdirSync(output,{recursive:true});
 let checked=0;
 for(const m of modules){
  const folder=path.resolve(root,m.source), manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));
  const screens=[...new Set([manifest.action?.default_popup,manifest.options_ui?.page,manifest.options_page].filter(Boolean))];
  if(!screens.length)continue;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'standalone-ui-'));let context;
  try{
   context=await chromium.launchPersistentContext(temp,{channel:'chromium',headless:true,viewport:{width:420,height:640},args:[`--disable-extensions-except=${folder}`,`--load-extension=${folder}`]});
   const id=crypto.createHash('sha256').update(folder).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
   for(const screen of screens){
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const popup=screen===manifest.action?.default_popup;
    await page.setViewportSize({width:popup?420:960,height:popup?640:900});
    const backgrounds=[];
    for(const theme of ['light','dark']){
     await page.emulateMedia({colorScheme:theme});
     await page.goto(`chrome-extension://${id}/${screen}`);await page.locator('body').waitFor();
     await page.waitForTimeout(300);
     assert.equal(await page.evaluate(()=>chrome.runtime.getManifest().name),manifest.name,m.id);
     assert.equal(await page.evaluate(()=>typeof MyToolsUI?.icon('download')),'string',m.id);
     const layout=await page.evaluate(()=>{
      const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const text=[...document.querySelectorAll('body *')].filter(e=>visible(e)&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,small:text.filter(e=>parseFloat(getComputedStyle(e).fontSize)<12).map(e=>({tag:e.tagName,size:getComputedStyle(e).fontSize})),fonts:[...new Set(text.map(e=>getComputedStyle(e).fontSize))],bg:getComputedStyle(document.body).backgroundColor};
     });
     assert.ok(layout.scroll<=layout.width,`${m.id}/${screen}/${theme}: horizontal overflow ${JSON.stringify(layout)}`);
     backgrounds.push(layout.bg);
     assert.ok(layout.fonts.length<=4,`${m.id}/${screen}: too many font sizes ${layout.fonts}`);
     assert.deepEqual(layout.small,[],`${m.id}/${screen}/${theme}: text below12px`);
     assert.deepEqual(errors,[],`${m.id}/${screen}/${theme}`);
     await page.screenshot({path:path.join(output,`${m.id}-${path.basename(screen,'.html')}-${theme}.png`),fullPage:true});checked++;
     console.log(`PASS standalone ${m.id}/${screen} ${theme}`);
    }
    assert.notEqual(backgrounds[0],backgrounds[1],`${m.id}/${screen}: theme follows system`);
    await page.close();
   }
  }finally{await context?.close();fs.rmSync(temp,{recursive:true,force:true});}
 }
 console.log(`PASS ${checked} standalone UI screen/theme checks`);
})().catch(e=>{console.error(e);process.exitCode=1;});
