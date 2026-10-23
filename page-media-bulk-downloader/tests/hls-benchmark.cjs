"use strict";
// An artificial 80 ms delay per segment measures concurrency, not site bandwidth.
const fs = require("node:fs"), path = require("node:path");
const hls = require("../hls.js"), mp4 = require("../mp4.js"), muxjs = require("./mux.cjs");
async function run(concurrency) {
  let active = 0, peak = 0, requests = 0;
  const started = performance.now();
  const blob = await hls.assemble("https://vid.fun800.click/offset.m3u8", {mp4, muxjs, concurrency,
    async fetch(url) {
      requests++;
      if (url.endsWith(".ts")) {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 80)); active--;
      }
      return new Response(fs.readFileSync(path.join(__dirname, "fixtures", new URL(url).pathname.split("/").pop())));
    }});
  return {concurrency, requests, peakRequests: peak, elapsedMs: Math.round(performance.now()-started), outputBytes: blob.size};
}
(async () => {console.log(JSON.stringify({sequential:await run(1),parallel:await run(4)}));})()
  .catch(() => {console.error("BENCHMARK_FAILED");process.exitCode=1;});
