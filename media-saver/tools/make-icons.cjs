"use strict";
// Dependency-free PNG icon generator for the extension.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 0.23;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const px = x + 0.5, py = y + 0.5;
      const cx = Math.min(Math.max(px, radius), size - radius);
      const cy = Math.min(Math.max(py, radius), size - radius);
      const distance = Math.hypot(px - cx, py - cy);
      const inside = distance <= radius;
      const edge = Math.min(1, Math.max(0, radius - distance + 0.5));
      const t = (px + py) / (size * 2);
      let r = Math.round(79 + (32 - 79) * t);
      let g = Math.round(110 + (196 - 110) * t);
      let b = Math.round(247 + (176 - 247) * t);
      // Download arrow: stem, head, and tray.
      const inTray = py > size * 0.735 && py < size * 0.805 && px > size * 0.265 && px < size * 0.735;
      const inStem = px > size * 0.455 && px < size * 0.545 && py > size * 0.245 && py < size * 0.60;
      const headTop = size * 0.50, headBottom = size * 0.70;
      const headWidth = (py - headTop) / (headBottom - headTop) * size * 0.26;
      const inHead = py >= headTop && py <= headBottom && Math.abs(px - size * 0.5) < size * 0.26 - headWidth;
      if (inTray || inStem || inHead) { r = 255; g = 255; b = 255; }
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = Math.round(255 * edge);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, {level: 9})), chunk("IEND", Buffer.alloc(0))]);
}

const dir = path.join(__dirname, "..", "icons");
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), png(size));
}
console.log("icons written");
