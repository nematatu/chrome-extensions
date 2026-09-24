(() => {
  "use strict";
  const MAX_UNIT = 32 * 1024 * 1024;
  const MAX_CACHE = 64 * 1024 * 1024;
  const join = parts => {
    const data = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    return data;
  };
  const text = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);

  function box(bytes, offset = 0) {
    if (bytes.length - offset < 8) return null;
    let size = u32(bytes, offset), header = 8;
    if (size === 1) {
      if (bytes.length - offset < 16) return null;
      size = u32(bytes, offset + 8) * 4294967296 + u32(bytes, offset + 12); header = 16;
    }
    if (size < header || size > MAX_UNIT) throw new Error("unsupported box");
    return { size, header, type: text(bytes, offset + 4, 4), offset };
  }
  function findBox(bytes, type, start = 0, end = bytes.length) {
    for (let offset = start; offset + 8 <= end;) {
      const item = box(bytes, offset);
      if (!item || offset + item.size > end) return null;
      if (item.type === type) return { ...item, data: offset + item.header };
      if (["moov", "trak", "mdia", "moof", "traf"].includes(item.type)) {
        const found = findBox(bytes, type, offset + item.header, offset + item.size);
        if (found) return found;
      }
      offset += item.size;
    }
    return null;
  }
  function vint(bytes, offset, id = false) {
    if (offset >= bytes.length || bytes[offset] === 0) return null;
    let length = 1, bit = 128;
    while (!(bytes[offset] & bit)) { length++; bit >>= 1; }
    if (length > (id ? 4 : 8)) throw new Error("invalid EBML");
    if (offset + length > bytes.length) return null;
    let value = id ? bytes[offset] : bytes[offset] & (bit - 1);
    let unknown = !id && value === bit - 1;
    for (let i = 1; i < length; i++) { value = value * 256 + bytes[offset + i]; unknown = unknown && bytes[offset + i] === 255; }
    return { length, value, unknown };
  }
  function element(bytes, offset = 0) {
    const id = vint(bytes, offset, true);
    if (!id) return null;
    const size = vint(bytes, offset + id.length);
    if (!size) return null;
    return { id: id.value, size: size.value, unknown: size.unknown, header: id.length + size.length };
  }
  function unsigned(bytes, start, size) {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[start + i];
    return value;
  }

  class StreamCache {
    constructor(mime) {
      this.mime = mime; this.mp4 = mime.includes("mp4"); this.pending = new Uint8Array();
      this.init = []; this.units = []; this.bytes = 0; this.scale = this.mp4 ? 1 : 1000;
      this.fragment = null; this.segment = false; this.failed = false; this.offset = 0;
    }
    append(data, offset = 0, playbackTime = 0) {
      if (this.failed) return;
      try {
        if (!Number.isFinite(offset) || Math.abs(offset) > 604800) throw new Error("invalid offset");
        if (this.units.length && offset !== this.offset) throw new Error("changed offset");
        this.offset = offset;
        if (data.byteLength + this.pending.length > MAX_UNIT) throw new Error("oversized segment");
        this.pending = join([this.pending, data]);
        this.mp4 ? this.readMp4() : this.readWebm();
        while (this.units.length > 1 && (this.units[1].time < playbackTime - offset - 20 || this.bytes > MAX_CACHE)) {
          this.bytes -= this.units.shift().data.length;
        }
        if (this.bytes > MAX_CACHE || this.init.reduce((n, b) => n + b.length, 0) > 1024 * 1024) throw new Error("oversized cache");
      } catch { this.failed = true; this.pending = new Uint8Array(); this.units = []; this.init = []; this.bytes = 0; }
    }
    addUnit(data, time) {
      if (!Number.isFinite(time)) throw new Error("invalid timestamp");
      // 後方シーク等で再受信した同一区間は新しいデータに置換する。
      const index = this.units.findIndex(unit => Math.abs(unit.time - time) < .0001);
      if (index >= 0) this.bytes -= this.units.splice(index, 1)[0].data.length;
      this.units.push({ data, time }); this.units.sort((a, b) => a.time - b.time); this.bytes += data.length;
    }
    readMp4() {
      while (this.pending.length >= 8) {
        const item = box(this.pending);
        if (!item || this.pending.length < item.size) return;
        const data = this.pending.slice(0, item.size);
        this.pending = this.pending.slice(item.size);
        if (item.type === "ftyp") { this.init = [data]; this.units = []; this.bytes = 0; this.fragment = null; }
        if (item.type === "moov") {
          this.init.push(data);
          const mdhd = findBox(data, "mdhd");
          if (!mdhd) throw new Error("missing media header");
          this.scale = u32(data, mdhd.data + (data[mdhd.data] === 1 ? 20 : 12));
          if (!this.scale) throw new Error("invalid timescale");
        }
        if (item.type === "moof") {
          const tfdt = findBox(data, "tfdt");
          if (!tfdt) throw new Error("missing decode time");
          const at = tfdt.data + 4;
          const time = data[tfdt.data] === 1 ? u32(data, at) * 4294967296 + u32(data, at + 4) : u32(data, at);
          this.fragment = { data, time: time / this.scale };
        }
        if (item.type === "mdat" && this.fragment) {
          this.addUnit(join([this.fragment.data, data]), this.fragment.time); this.fragment = null;
        }
      }
    }
    readWebm() {
      while (this.pending.length) {
        const item = element(this.pending);
        if (!item) return;
        if (item.id === 0x18538067) {
          // Segmentはコンテナ。キャッシュから再構成しても使えるようサイズをunknownにする。
          const header = this.pending.slice(0, item.header);
          const id = vint(header, 0, true);
          const length = item.header - id.length;
          header[id.length] = (1 << (9 - length)) - 1;
          header.fill(255, id.length + 1);
          this.init.push(header); this.pending = this.pending.slice(item.header); this.segment = true; continue;
        }
        if (item.unknown || item.size > MAX_UNIT) throw new Error("unsupported cluster");
        const length = item.header + item.size;
        if (this.pending.length < length) return;
        const data = this.pending.slice(0, length); this.pending = this.pending.slice(length);
        if (item.id === 0x1a45dfa3) { this.init = [data]; this.units = []; this.bytes = 0; this.segment = false; }
        else if (item.id === 0x1f43b675) {
          let time = null;
          for (let at = item.header; at < data.length;) {
            const child = element(data, at);
            if (!child || at + child.header + child.size > data.length) break;
            if (child.id === 0xe7) { time = unsigned(data, at + child.header, child.size) / this.scale; break; }
            at += child.header + child.size;
          }
          if (time === null) throw new Error("missing timestamp");
          this.addUnit(data, time);
        } else if ([0x1549a966, 0x1654ae6b].includes(item.id)) {
          this.init.push(data);
          if (item.id === 0x1549a966) {
            for (let at = item.header; at < data.length;) {
              const child = element(data, at);
              if (!child || at + child.header + child.size > data.length) break;
              if (child.id === 0x2ad7b1) this.scale = 1e9 / unsigned(data, at + child.header, child.size);
              at += child.header + child.size;
            }
          }
        }
      }
    }
    snapshot(start, end) {
      if (this.failed || !this.init.length || !this.units.length) throw new Error("missing data");
      const localStart = start - this.offset, localEnd = end - this.offset;
      const units = this.units.filter((unit, i) => unit.time <= localEnd &&
        (i === this.units.length - 1 || this.units[i + 1].time > localStart - 4));
      if (!units.length || units[0].time > localStart + .05) throw new Error("missing start");
      return { mime: this.mime, offset: this.offset, data: join([...this.init, ...units.map(unit => unit.data)]) };
    }
  }
  const api = { StreamCache, join, box, element, MAX_CACHE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.YouTubeClipStreamCache = api;
})();
