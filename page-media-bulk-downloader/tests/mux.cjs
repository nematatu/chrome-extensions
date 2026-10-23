"use strict";
const fs = require("node:fs"), vm = require("node:vm");
const context = {window: {}, Uint8Array, ArrayBuffer, DataView};
vm.runInNewContext(fs.readFileSync(require.resolve("../vendor/mux.min.js"), "utf8"), context);
module.exports = context.muxjs;
