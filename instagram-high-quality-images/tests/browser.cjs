const {chromium}=require('playwright');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const https=require('node:https');const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');
(async()=>{
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'instagram-hq-test-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tmp+'/key.pem','-out',tmp+'/cert.pem','-subj','/CN=media.cdninstagram.com','-days','1'],{stdio:'ignore'});
const jpeg=fs.readFileSync(__dirname+'/fixtures/image.jpg'),mp4=fs.readFileSync(__dirname+'/fixtures/video.mp4');
let mediaDelay=0;
const server=https.createServer({key:fs.readFileSync(tmp+'/key.pem'),cert:fs.readFileSync(tmp+'/cert.pem')},(req,res)=>{const video=req.url.includes('.mp4');res.setHeader('content-type',video?'video/mp4':'image/jpeg');res.setHeader('access-control-allow-origin','*');setTimeout(()=>res.end(video?mp4:jpeg),mediaDelay);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`https://media.cdninstagram.com:${server.address().port}`;
const image=(id)=>({pk:String(id),media_type:1,original_width:320,original_height:240,image_versions2:{candidates:[{url:base+'/image.jpg?ig_cache_key='+Buffer.from(String(id)).toString('base64'),width:320,height:240}]}});
const video=(id)=>({pk:String(id),media_type:2,video_versions:[{url:base+'/video.mp4',width:320,height:240}]});
const post1={pk:'1',code:'B',user:{username:'alice'},carousel_media:[image(11),video(12),image(13)]};
const post2={...image(2),code:'C',user:{username:'alice'}};const reel={...video(3),code:'D',user:{username:'alice'}};
let feedPages=[],clips=0;
const ext=path.resolve(__dirname,'..');
fs.mkdirSync(tmp+'/profile/Default',{recursive:true});
fs.writeFileSync(tmp+'/profile/Default/Preferences',JSON.stringify({download:{default_directory:tmp+'/downloads',prompt_for_download:false}}));
const context=await chromium.launchPersistentContext(tmp+'/profile',{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--ignore-certificate-errors','--host-resolver-rules=MAP media.cdninstagram.com 127.0.0.1','--no-proxy-server']});
try{
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const cdp=await context.newCDPSession(page);await cdp.send('Browser.setDownloadBehavior',{behavior:'default'});
await context.route('https://www.instagram.com/**',async route=>{
 const url=new URL(route.request().url());let data;
 if(url.pathname.startsWith('/api/') || url.pathname==='/graphql/query/'){
  if(url.pathname.includes('web_profile_info'))data={data:{user:{id:'100',username:'alice',has_clips:true}}};
  else if(url.pathname.includes('/media/1/info/'))data={items:[post1]};
  else if(url.pathname.includes('reels_media'))data={reels:{'100':{id:'100',user:{username:'alice'},items:[image(21),video(22)]},'200':{id:'200',user:{username:'bob'},items:[{...image(99),user:{username:'bob'}}]}}};
  else if(url.pathname.includes('/feed/user/100/')){
   feedPages.push(url.searchParams.get('max_id'));data=url.searchParams.has('max_id')?{items:[post1,post2],more_available:false}:{items:[post1],more_available:true,next_max_id:'page2'};
  }else if(url.pathname.includes('/clips/user/')){clips++;data={items:[{media:post1},{media:reel}],paging_info:{more_available:false}};}
  else if(url.pathname==='/graphql/query/')data={data:{reels_media:[{user:{username:'alice'},items:[{__typename:'GraphStoryImage',id:'21',display_url:image(21).image_versions2.candidates[0].url},{__typename:'GraphStoryVideo',id:'22',is_video:true,video_resources:[{src:base+'/video.mp4',width:320,height:480}]}]}]}};
  else return route.fulfill({status:404,body:'unknown API'});
  return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'ok',...data})});
 }
 const img=`<div style="position:relative;width:660px;height:240px"><img width="320" height="240" src="${post1.carousel_media[0].image_versions2.candidates[0].url}"><img aria-hidden="true" style="position:absolute;left:340px;top:0" width="320" height="240" src="${post1.carousel_media[2].image_versions2.candidates[0].url}"></div>`;
 let body;
 if(url.pathname.startsWith('/stories/'))body=(url.pathname.includes('/22/') ? `<main><div style="position:relative;width:320px;height:480px;margin:auto"><div class="story-actions" style="display:flex;position:absolute;z-index:2;top:8px;right:8px"><button aria-label="返信"><svg width="20" height="20"></svg></button><button aria-label="共有"><svg width="20" height="20"></svg></button><button aria-label="その他"><svg width="20" height="20"></svg></button></div><video width="320" height="480" src="${base}/video.mp4" controls></div></main>` : `<main><div style="position:relative;width:320px;height:480px;margin:auto"><div class="story-actions" style="display:flex;position:absolute;z-index:2;top:8px;right:8px"><button aria-label="返信"><svg width="20" height="20"></svg></button><button aria-label="共有"><svg width="20" height="20"></svg></button><button aria-label="その他"><svg width="20" height="20"></svg></button></div><img width="320" height="480" src="${image(21).image_versions2.candidates[0].url}"></div></main>`) + `<script>fetch('/api/v1/feed/user/100/?count=50');fetch('/api/v1/feed/reels_media/?reel_ids=100')</script>`;
 else if(url.pathname==='/alice/')body=`<main><header><h1>alice</h1><div class="actions"><button>フォロー</button><button>メッセージ</button></div></header><div class="grid"><a href="/p/B/" style="display:block;width:320px;height:240px"><img width="320" height="240" src="${image(11).image_versions2.candidates[0].url}"></a></div></main><script>fetch('/api/v1/feed/user/100/?count=50');fetch('/api/v1/feed/user/100/?count=50&max_id=page2');fetch('/api/v1/clips/user/',{method:'POST'})</script>`;
 else if(url.pathname.startsWith('/reel/')) body=`<main><article><a href="/reel/B/">リール</a><video width="320" height="240" src="${base}/video.mp4" controls></video></article></main>`;
 else body=`<main><article><header><a href="/alice/">alice</a></header><a href="/p/B/">投稿日時</a><div>${img}</div><div class="actions" style="display:flex"><button aria-label="Instagramで保存"><svg aria-label="Save"></svg></button><button style="display:none" aria-label="Instagramで保存"><svg aria-label="Save"></svg></button></div></article></main><script>fetch('/api/v1/media/1/info/')</script>`;
 return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`});
});
async function storedJobs(){return worker.evaluate(async()=>Object.values((await chrome.storage.session.get('downloadJobs')).downloadJobs||{}));}
async function jobDone(previousIds=[]){const previous=new Set(previousIds);for(let attempt=0;attempt<300;attempt++){const states=await storedJobs();const state=states.filter(item=>!previous.has(item.id)&&!item.active).sort((a,b)=>b.updatedAt-a.updatedAt)[0];if(state)return state;await page.waitForTimeout(100);}throw new Error('保存処理が完了しませんでした。');}
async function single(label){const previous=(await storedJobs()).map(state=>state.id);await page.getByRole('button',{name:label,exact:true}).first().click();return jobDone(previous);}
await page.goto('https://www.instagram.com/p/B/');
await page.getByRole('button',{name:'この画像を保存',exact:true}).first().waitFor();
assert.equal(await page.getByRole('button',{name:'この画像を保存',exact:true}).count(),1);
let state=await single('この画像を保存');assert.equal(state.saved,1);assert.equal(state.failed,0);
await page.waitForTimeout(2200);assert.equal(await page.locator('.toastify.instagram-hq-toast-shell').count(),0);
let downloads=await worker.evaluate(()=>chrome.downloads.search({}));console.log('SAVED',downloads[0].filename);let originalImage=fs.readFileSync(downloads[0].filename);assert.deepEqual([...originalImage.subarray(0,3)],[255,216,255]);assert.match(downloads[0].filename,/Instagram-High-Quality\/alice_B_0[1-3]\.jpg$/);
assert.equal(await page.locator('.instagram-hq-bulk').evaluate(el=>el.nextElementSibling.querySelector('svg')?.getAttribute('aria-label')),'Save');
assert.equal(await page.locator('.instagram-hq-post-bulk').count(),1);
assert.equal(await page.locator('.instagram-hq-post-bulk').evaluate(button=>button.parentElement===button.nextElementSibling.parentElement),true);
assert.equal(await page.locator('.instagram-hq-post-bulk').evaluate(button=>Math.abs(button.getBoundingClientRect().top-button.nextElementSibling.getBoundingClientRect().top)<2),true);
await page.screenshot({path:tmp+'/post-controls.png'});
await page.goto('https://www.instagram.com/reel/B/');
state=await single('この動画をMP4で保存');assert.equal(state.saved,1);
await page.goto('https://www.instagram.com/p/B/');
state=await single('投稿の画像・動画を一括保存');assert.equal(state.saved,3);assert.equal(state.failed,0);
mediaDelay=600;
const beforeParallel=(await storedJobs()).map(item=>item.id);
await page.evaluate(() => {
  document.querySelector('#instagram-hq-download-ui').shadowRoot.querySelector('.media-button').click();
  document.querySelector('.instagram-hq-post-bulk').click();
});
let parallel=[];
for(let attempt=0;attempt<100;attempt++){parallel=(await storedJobs()).filter(item=>!beforeParallel.includes(item.id));if(parallel.filter(item=>item.active).length>=2)break;await page.waitForTimeout(50);}
assert.ok(parallel.filter(item=>item.active).length>=2,'複数の投稿保存ジョブが同時に進行する');
assert.ok(await page.locator('.toastify.instagram-hq-toast-shell').count()>=2,'ジョブごとのトーストが積まれる');
for(let attempt=0;attempt<300;attempt++){parallel=(await storedJobs()).filter(item=>!beforeParallel.includes(item.id));if(parallel.length>=2&&parallel.every(item=>!item.active))break;await page.waitForTimeout(100);}
assert.ok(parallel.length>=2&&parallel.every(item=>!item.active),'並列ジョブが両方とも完了する');
mediaDelay=0;
downloads=await worker.evaluate(()=>chrome.downloads.search({}));const savedVideo=downloads.find(d=>d.filename.endsWith('.mp4'));assert.ok(savedVideo);assert.deepEqual(fs.readFileSync(savedVideo.filename),mp4);
await page.goto('https://www.instagram.com/stories/alice/21/');
await page.getByRole('button',{name:'このストーリーを保存',exact:true}).waitFor();
assert.equal(await page.locator('.instagram-hq-story-tools').evaluate(tools=>tools.parentElement===document.body),true);
assert.equal(await page.locator('.instagram-hq-story-tools').evaluate(tools=>{const a=tools.getBoundingClientRect(),b=document.querySelector('.story-actions').getBoundingClientRect();return a.right<=b.left+2&&Math.abs(a.top-b.top)<8;}),true);
await page.screenshot({path:tmp+'/story-controls.png'});
state=await single('このストーリーを保存');assert.equal(state.saved,1);
state=await single('この相手のストーリーを一括保存');assert.equal(state.saved,2);
await page.goto('https://www.instagram.com/stories/alice/22/');state=await single('このストーリーを保存');assert.equal(state.saved,1);
downloads=await worker.evaluate(()=>chrome.downloads.search({}));assert.ok(downloads.some(d=>d.filename.endsWith('/Instagram-High-Quality/alice_22_01.mp4')));
await page.goto('https://www.instagram.com/alice/');
await page.waitForSelector('.instagram-hq-account');
feedPages=[];clips=0;
assert.equal(await page.locator('.instagram-hq-account').evaluate(button => button.nextElementSibling?.className),'actions');
await page.locator('main a[href="/p/B/"]').hover();
assert.equal(await page.locator('.instagram-hq-grid-overlay').count(),0);
assert.equal(await page.locator('.instagram-hq-grid-save').count(),1);
const profileScroll=await page.evaluate(()=>scrollY);
state=await single('このアカウントの全投稿を保存');assert.equal(state.saved,5);assert.equal(state.failed,0);assert.equal(state.posts,3);assert.equal(state.discoveryDone,true);assert.deepEqual(feedPages,[null,'page2']);assert.equal(clips,1);assert.equal(await page.evaluate(()=>scrollY),profileScroll);
mediaDelay=1000;
const beforeStop=(await storedJobs()).map(item=>item.id);
await page.getByRole('button',{name:'このアカウントの全投稿を保存',exact:true}).click();
await page.getByRole('button',{name:'アカウント全投稿を停止',exact:true}).click();
state=await jobDone(beforeStop);assert.equal(state.stopped,true);assert.equal(state.active,false);assert.match(state.phase,/停止しました/);
assert.equal(await page.locator('.instagram-hq-toast-content progress').first().isVisible(),true);
assert.deepEqual(errors,[]);
await page.setViewportSize({width:390,height:844});const panel=page.locator('.toastify.instagram-hq-toast-shell').first();const box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
mediaDelay=0;
await page.screenshot({path:tmp+'/ui.png'});
console.log('PASS: original bytes, flat directory, post/account API pagination, story separation, concurrent jobs, stacked toasts, individual cancellation, mobile panel');console.log('ARTIFACTS',tmp);
}finally{await context.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
