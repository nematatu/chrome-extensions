"use strict";
const assert = require("node:assert/strict");

function createOpfsFixture(initial = {}) {
  const files = new Map(Object.entries(initial));
  let failWrite = false;
  const directory = {
    async *keys() { yield* [...files.keys()]; },
    async removeEntry(name) { files.delete(name); },
    async getFileHandle(name, options) {
      assert.match(name, /^[a-f0-9-]{36}\.mp4$/i); assert.equal(options.create, true);
      files.set(name, Buffer.alloc(0));
      return {
        async createWritable() {
          const chunks = []; let closed = false, position = 0, length = 0;
          return {
            async write(bytes) {
              if (closed || failWrite) throw new Error("fixture write failed");
              if (bytes.type === "write") {position = bytes.position; bytes = bytes.data;}
              chunks.push({position, bytes: Buffer.from(bytes)}); position += bytes.length; length = Math.max(length, position);
            },
            async close() {
              closed = true; const data = Buffer.alloc(length);
              for (const chunk of chunks) chunk.bytes.copy(data, chunk.position); files.set(name, data);
            },
            async abort() { closed = true; chunks.length = 0; },
          };
        },
        async getFile() { return new Blob([files.get(name)], {type: "video/mp4"}); },
      };
    },
  };
  return {files, failWrite(value) {failWrite = value;}, navigator: {storage: {async getDirectory() {
    return {async getDirectoryHandle(name, options) {
      assert.equal(name, "page-media-hls-mp4-v1"); assert.equal(options.create, true); return directory;
    }};
  }}}};
}
module.exports = {createOpfsFixture};
