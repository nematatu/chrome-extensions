"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createHarness,video}=require("./harness.cjs");
const PAGE="https://twfiles.com/Fixture001";
const LINK="https://vid.fun800.click/generated/test.m3u8";
test("新版で旧変換エラーだけを手動再試行可能にし、完了分・対象外エラーは再取得しない",async()=>{
  const entries=Array.from({length:4},(_,i)=>({id:String(i+1),name:`Scene-${i+1}.mp4`,isFolder:false,fileUrl:LINK}));
  const h=createHarness({pageUrl:PAGE,scanType:"hosted-api",playerName:"",visibleRows:entries.map(v=>({name:v.name,isFolder:false}))});
  h.setApiFetch(value=>new Response(JSON.stringify({code:0,data:new URL(value).pathname.endsWith("getInfo")
    ? {info:{netDiskInfo:{id:"folder",name:"Generated",isFolder:true}},rules:{status:"0"}} : {list:entries,total:4}}),
    {headers:{"content-type":"application/json"}}));
  const sender={...h.sender,url:PAGE,tab:{id:42,url:PAGE}};
  const start=await h.send({type:"page-media-bulk:start"},sender),batch=h.getCachedState().batches[start.batch.id];
  assert.equal(h.hlsCalls.filter(c=>c.action==="start").length,4);
  batch.items.forEach((item,index)=>{delete item.hlsCompatibilityVersion;item.status=index===0?"complete":"failed";
    item.error=index===1?"HLS_INVALID_TIMELINE":index===2?"HLS_BAD_SEGMENT":index===3?"HLS_UNSUPPORTED":null;
    item.retryable=false;delete item.hls; if(index===0){item.url=null;item.downloadPathVerified=true;}});
  batch.status="completed_with_errors";
  await h.persistCachedState();h.resetWorkerCache();
  const status=await h.send({type:"page-media-bulk:status"},sender);
  assert.equal(status.batch.summary.retryableFailures,2);assert.equal(status.batch.summary.completed,1);
  assert.equal(h.hlsCalls.filter(c=>c.action==="start").length,4,"status must not start any download");
  const retry=await h.send({type:"page-media-bulk:retry",batchId:batch.id},sender);
  assert.equal(retry.ok,true);assert.equal(h.hlsCalls.filter(c=>c.action==="start").length,6);
  const active=h.getCachedState().batches[batch.id];
  assert.equal(active.items[0].status,"complete");assert.equal(active.items[3].error,"HLS_UNSUPPORTED");
  for(const item of active.items.slice(1,3)){assert.equal(item.hlsCompatibilityVersion,1);
    await h.sendHls({phase:"failed",token:item.hls.token,error:"HLS_BAD_SEGMENT"});}
  h.resetWorkerCache();
  const again=await h.send({type:"page-media-bulk:status"},sender);
  assert.equal(again.batch.summary.retryableFailures,0,"new-version format failures must not be re-enabled every restart");
});
