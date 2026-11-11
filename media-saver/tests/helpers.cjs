"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const fixtures = path.join(__dirname, "fixtures");

function loadMux() {
  const context = {
    window: {}, self: {}, Uint8Array, Uint8ClampedArray, Uint16Array, Int16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array, ArrayBuffer, SharedArrayBuffer,
    DataView, TextDecoder, TextEncoder, Math, Date, Number, String, Object, Array,
    Map, Set, WeakMap, WeakSet, JSON, Promise, Error, RegExp, isFinite, isNaN,
    parseInt, parseFloat, setTimeout, clearTimeout, console
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "vendor", "mux.min.js"), "utf8"), context);
  if (!context.muxjs) throw new Error("mux.js did not initialize");
  return context.muxjs;
}

function contentType(name) {
  if (name.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (name.endsWith(".mpd")) return "application/dash+xml";
  if (name.endsWith(".ts")) return "video/mp2t";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".m4s") || name.endsWith(".mp4") || name.endsWith(".cmfv") || name.endsWith(".cmfa")) return "video/mp4";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function fixtureRequest(root = fixtures, options = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new TypeError("unsupported");
    const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const file = path.join(root, relative);
    if (!file.startsWith(root + path.sep)) return new Response("", { status: 404 });
    let body;
    try { body = fs.readFileSync(file); } catch { return new Response("not found", { status: 404 }); }
    const headers = new Map([["content-type", contentType(file)]]);
    let status = 200;
    const range = init.headers?.Range || init.headers?.range;
    if (range && !options.ignoreRange) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return new Response("", { status: 416 });
      const start = Number(match[1]), end = Math.min(Number(match[2]), body.length - 1);
      if (start > end || start >= body.length) return new Response("", { status: 416 });
      const full = body.length;
      body = body.subarray(start, end + 1);
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${full}`);
    }
    headers.set("content-length", String(body.length));
    return new Response(body, { status, headers });
  };
}

function outputBuffer(output) {
  return output.finish().then(blob => blob.arrayBuffer()).then(buffer => Buffer.from(buffer));
}

function hasBox(buffer, name) {
  return buffer.includes(Buffer.from(name, "ascii"));
}

function topLevelBoxes(buffer) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
    }
    if (size < 8 || offset + size > buffer.length) break;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

function childBoxes(buffer, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    }
    if (size < header || offset + size > end) break;
    boxes.push({ type, start: offset, body: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function trackKinds(buffer) {
  const moov = topLevelBoxes(buffer).find(box => box.type === "moov");
  if (!moov) return [];
  return childBoxes(buffer, moov.offset + 8, moov.offset + moov.size)
    .filter(box => box.type === "trak")
    .map(track => {
      const mdia = childBoxes(buffer, track.start + 8, track.end).find(box => box.type === "mdia");
      if (!mdia) return "";
      const hdlr = childBoxes(buffer, mdia.start + 8, mdia.end).find(box => box.type === "hdlr");
      return hdlr ? buffer.toString("ascii", hdlr.body + 8, hdlr.body + 12) : "";
    })
    .filter(Boolean);
}

module.exports = {
  fixtures, loadMux, fixtureRequest, contentType, outputBuffer, hasBox, topLevelBoxes, childBoxes, trackKinds
};
