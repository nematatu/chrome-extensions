"use strict";
let offscreenListener, complete, previewUrl;
const nativeFetch = window.fetch.bind(window);
window.fetch = (value, options) => {
  const url = new URL(value);
  return nativeFetch(url.origin === "https://vid.fun800.click" ? "/hls-fixtures/" + url.pathname.split("/").pop() : value, options);
};
window.chrome = {runtime: {id: "fixture-id", getURL: path => "chrome-extension://fixture-id/" + path,
  onMessage: {addListener(listener) {offscreenListener = listener;}},
  async sendMessage(message) {
    if (message.phase === "failed") complete({error:message.error});
    if (message.phase === "ready") {
      const blob = await (await nativeFetch(message.blobUrl)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const text = new TextDecoder("latin1").decode(bytes);
      complete({blob,type:blob.type,mp4:text.slice(4,8)==="ftyp",video:text.includes("avc1"),audio:text.includes("mp4a"),
        standalone:!text.includes("moof"),bytes:bytes.length});
    }
    return {ok:true,active:message.phase==="collecting"};
  },
}};
const message = value => new Promise(resolve => offscreenListener({target:"offscreen",...value},
  {id:"fixture-id",url:"chrome-extension://fixture-id/background.js"},resolve));
document.getElementById("run").addEventListener("click", async event => {
  event.target.disabled = true;
  if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
  const result = document.getElementById("result"), token = crypto.randomUUID();
  result.dataset.status = "running"; result.textContent = "変換中";
  try {
    const finished = new Promise(resolve => {complete = resolve;});
    const started = await message({action:"start",token,url:"https://vid.fun800.click/offset.m3u8",pageUrl:"https://twfiles.com/Fixture001"});
    if (!started.ok) throw new Error("START_FAILED");
    const media = await finished;
    await message({action:"cancel",token});
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle("page-media-hls-mp4-v1");
    let remaining = 0;
    for(let attempt=0;attempt<100;attempt++) {
      remaining = 0; for await(const name of directory.keys()) if(name.endsWith(".mp4")) remaining++;
      if(!remaining) break; await new Promise(resolve=>setTimeout(resolve,10));
    }
    if(media.error || !media.mp4 || !media.video || !media.audio || !media.standalone || remaining) throw new Error(media.error || "VERIFY_FAILED");
    const video=document.getElementById("playback"), url=URL.createObjectURL(media.blob);
    try {
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error("PLAYBACK_TIMEOUT")),15000);
        video.onloadeddata=()=>{clearTimeout(timeout);resolve();};
        video.onerror=()=>{clearTimeout(timeout);reject(new Error("PLAYBACK_FAILED"));};
        video.src=url;video.load();
      });
      if(!Number.isFinite(video.duration)||Math.abs(video.duration-8)>0.3||video.videoWidth!==160||video.videoHeight!==90)throw new Error("BAD_DURATION");
      const duration=video.duration;video.playbackRate=4;
      const ended=new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error("PLAYBACK_TIMEOUT")),15000);
        video.onended=()=>{clearTimeout(timeout);resolve();};
        video.onerror=()=>{clearTimeout(timeout);reject(new Error("PLAYBACK_FAILED"));};
      });
      await video.play();await ended;
      const canvas=document.createElement("canvas");canvas.width=160;canvas.height=90;
      const context=canvas.getContext("2d");context.drawImage(video,0,0);
      const pixels=context.getImageData(0,0,160,90).data;
      let visiblePixels=0;for(let index=0;index<pixels.length;index+=4)if(pixels[index]+pixels[index+1]+pixels[index+2]>60)visiblePixels++;
      if(!video.ended||visiblePixels<1000)throw new Error("BLACK_OR_INCOMPLETE_VIDEO");
      result.dataset.duration=String(duration);result.dataset.visiblePixels=String(visiblePixels);
      result.dataset.ended=String(video.ended);
    } finally {
      if(video.ended)previewUrl=url;
      else{video.removeAttribute("src");video.load();URL.revokeObjectURL(url);}
    }
    result.dataset.status="passed";
    result.textContent="成功: MP4 / H.264映像 / AAC音声 / 約8秒・最後まで再生 / "+media.bytes+"バイト / 一時ファイル0件";
  } catch(error) {result.dataset.status="failed";result.textContent="失敗: "+error.message;}
  finally {event.target.disabled=false;}
});
