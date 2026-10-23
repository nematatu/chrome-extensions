"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createHarness}=require("./harness.cjs");
function response(data){return new Response(JSON.stringify({code:0,data}),{headers:{"content-type":"application/json"}});}
function setup(origin="https://gofile.es"){
  const entries=Array.from({length:5},(_,i)=>({id:String(i+1),name:`scene-${i+1}.mp4`,isFolder:false,
    landingPage:`Clip000${i+1}`,fileUrl:`https://media.example.com/scene-${i+1}.mp4?signature=expired`}));
  const snap={ok:true,scanType:"hosted-api",pageUrl:origin+"/d/Folder001",title:"Generated",
    visibleRows:entries.map(v=>({name:v.name,isFolder:false})),playerName:""};
  const h=createHarness(snap), counts=new Map(); let reject=false;
  h.setApiFetch(value=>{const u=new URL(value),id=u.searchParams.get("externalLinks");
    assert.equal(u.origin,origin);assert.equal(u.pathname,"/api.php");
    if(u.searchParams.get("endpoint").endsWith("list_by_links_page")) return response({list:entries,total:5});
    if(id==="Folder001") return response({info:{netDiskInfo:{id:"folder",name:"Generated",isFolder:true}},rules:{status:"0"}});
    const item=entries.find(v=>v.landingPage===id); assert.ok(item);
    counts.set(id,(counts.get(id)||0)+1);
    if(reject) return new Response("{}",{status:429,headers:{"content-type":"application/json"}});
    return response({info:{netDiskInfo:{...item,fileUrl:item.fileUrl.replace("expired","fresh-"+counts.get(id))}},rules:{status:"0"}});
  });
  return {h,counts,setReject(value){reject=value;},sender:{...h.sender,url:snap.pageUrl,tab:{id:42,url:snap.pageUrl}}};
}
test("es/plの期限切れURLを開始直前に更新し、未開始分・復元・再試行でも最新URLとサブフォルダーを使う",async()=>{
  for(const origin of ["https://gofile.es","https://gofile.pl"]){
    const {h,counts,sender}=setup(origin);
    const started=await h.send({type:"page-media-bulk:start"},sender);
    assert.equal(started.ok,true); assert.equal(h.downloadCalls.length,4);assert.equal(counts.has("Clip0005"),false);
    for(const d of h.downloadCalls){assert.match(d.url,/signature=fresh-1$/);assert.match(d.filename,/^PageMedia\/Generated\/scene-\d.mp4$/);}
    h.resetWorkerCache(); Object.assign(h.downloads.get(1),{state:"complete"});
    await h.emitChanged(1); assert.equal(h.downloadCalls.length,5);assert.equal(counts.get("Clip0005"),1);
    for(const [id,d] of h.downloads){if(id!==2) d.state="complete";else Object.assign(d,{state:"interrupted",error:"NETWORK_FAILED"});}
    await h.send({type:"page-media-bulk:status"},sender);
    await h.send({type:"page-media-bulk:retry",batchId:started.batch.id},sender);
    assert.equal(h.downloadCalls.length,6);assert.match(h.downloadCalls.at(-1).url,/signature=fresh-2$/);
    assert.equal(h.downloadCalls.at(-1).filename,"PageMedia/Generated/scene-2.mp4");
    const internal=h.getCachedState().batches[started.batch.id];assert.equal(internal.items[0].hostedFile,undefined);
  }
});
test("更新APIが失敗したら古いURLでは保存せず、再試行で更新し直す",async()=>{
  const {h,sender,setReject}=setup();setReject(true);
  const start=await h.send({type:"page-media-bulk:start"},sender);
  assert.equal(start.ok,true);assert.equal(h.downloadCalls.length,0);assert.equal(start.batch.summary.failed,5);
  assert.ok(start.batch.items.every(v=>v.error==="SIGNED_URL_REFRESH_FAILED"));
  setReject(false); await h.send({type:"page-media-bulk:retry",batchId:start.batch.id},sender);
  assert.equal(h.downloadCalls.length,4);assert.ok(h.downloadCalls.every(v=>v.url.includes("fresh-2")));
});
test("キャンセルされた未開始ファイルはURL更新も保存も行わない",async()=>{
  const {h,sender,counts}=setup();const start=await h.send({type:"page-media-bulk:start"},sender);
  await h.send({type:"page-media-bulk:cancel",batchId:start.batch.id},sender);
  assert.equal(h.downloadCalls.length,4);assert.equal(counts.has("Clip0005"),false);
});
