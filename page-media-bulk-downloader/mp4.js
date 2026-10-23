(function (root) {
  "use strict";
  // mux.js produces streaming fragments with unknown movie/track durations.
  // Rebuild sample tables for a standalone MP4; media bytes are not re-encoded.
  const MAX_SAMPLES = 1000000;
  const fail = () => { throw new Error("HLS_BAD_SEGMENT"); };
  const timeline = () => { throw new Error("HLS_INVALID_TIMELINE"); };
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const u32 = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail();
    const bytes = new Uint8Array(4); view(bytes).setUint32(0, value); return bytes;
  };
  function join(parts) {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  }
  const box = (name, ...parts) => join([u32(8 + parts.reduce((sum, part) => sum + part.length, 0)),
    new Uint8Array([...name].map(c => c.charCodeAt(0))), ...parts]);
  const full = (name, version, ...parts) => box(name, new Uint8Array([version, 0, 0, 0]), ...parts);
  function boxes(bytes, start = 0, end = bytes.length) {
    const result = [], data = view(bytes);
    for (let offset = start; offset < end;) {
      if (offset + 8 > end || result.length >= 10000) fail();
      const size = data.getUint32(offset);
      if (size < 8 || offset + size > end) fail();
      result.push({type: type(bytes, offset + 4), start: offset, end: offset + size,
        bytes: bytes.subarray(offset, offset + size)});
      offset += size;
    }
    return result;
  }
  function one(entries, name) {
    const matches = entries.filter(entry => entry.type === name);
    if (matches.length !== 1) fail(); return matches[0].bytes;
  }
  const children = bytes => boxes(bytes, 8);
  function runs(values) {
    const result = [];
    for (const value of values) {
      const last = result.at(-1);
      if (last && last[1] === value) last[0]++; else result.push([1, value]);
    }
    return result;
  }
  function table(name, rows, version = 0) {
    const bytes = new Uint8Array(rows.reduce((sum, row) => sum + row.length * 4, 0));
    const data = view(bytes); let offset = 0;
    for (const row of rows) for (const value of row) {
      if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0xffffffff) fail();
      data.setUint32(offset, value); offset += 4;
    }
    return full(name, version, u32(rows.length), bytes);
  }
  function mediaHeader(original, duration) {
    const bytes = original.slice(), data = view(bytes);
    if (bytes[8] !== 0 || bytes.length !== 32) fail();
    if (duration <= 0xffffffff) { data.setUint32(24, duration); return bytes; }
    const payload = new Uint8Array(36), target = view(payload);
    payload[0] = 1; target.setUint32(8, data.getUint32(12)); target.setUint32(16, data.getUint32(16));
    target.setUint32(20, data.getUint32(20)); target.setBigUint64(24, BigInt(duration));
    payload.set(bytes.subarray(28), 32); return box("mdhd", payload);
  }

  function create(reserve = () => {}) {
    let init, ftyp, mvhd, position = 0, sampleCount = 0, metadataBytes = 0, finished = false;
    const tracks = new Map(), mdatHeader = box("mdat");
    function start(bytes) {
      const first = !init, top = boxes(bytes);
      const nextFtyp = one(top, "ftyp"), movie = children(one(top, "moov"));
      const nextMvhd = one(movie, "mvhd");
      if (nextMvhd[8] !== 0 || nextMvhd.length !== 108) fail();
      if (first) { init = true; ftyp = nextFtyp.slice(); mvhd = nextMvhd.slice(); }
      else if (ftyp.length !== nextFtyp.length || ftyp.some((byte, index) => byte !== nextFtyp[index])) fail();
      const declared = new Set();
      for (const entry of movie.filter(item => item.type === "trak")) {
        const entries = children(entry.bytes), tkhd = one(entries, "tkhd").slice();
        const mdia = children(one(entries, "mdia")), mdhd = one(mdia, "mdhd");
        const hdlr = one(mdia, "hdlr"), kind = type(hdlr, 16);
        if (tkhd[8] !== 0 || tkhd.length !== 92 || mdhd[8] !== 0 || mdhd.length !== 32) fail();
        const id = view(tkhd).getUint32(20), timescale = view(mdhd).getUint32(20);
        const minf = children(one(mdia, "minf")), stsd = one(children(one(minf, "stbl")), "stsd");
        if (!id || declared.has(id) || !timescale || timescale > 192000 || !["vide", "soun"].includes(kind)
          || view(stsd).getUint32(12) !== 1 || type(stsd, 20) !== (kind === "vide" ? "avc1" : "mp4a")) fail();
        declared.add(id);
        const previous = tracks.get(id);
        if (previous) {
          if (previous.definition.length !== entry.bytes.length
            || previous.definition.some((byte, index) => byte !== entry.bytes[index])) fail();
          continue;
        }
        if ([...tracks.values()].some(track => track.kind === kind)) fail();
        tracks.set(id, {id, kind, timescale, tkhd, mdhd, hdlr, stsd, minf, samples: [], chunks: [],
          definition: entry.bytes.slice(), minSampleDuration: Infinity, maxSampleDuration: 0,
          firstDts: null, nextDts: null, minPts: Infinity, maxPts: -Infinity});
      }
      if (!declared.size || tracks.size > 2) fail();
      if (first) position = ftyp.length + mdatHeader.length;
      return first ? [ftyp, mdatHeader] : [];
    }
    function add(initSegment, bytes) {
      if (finished) fail();
      const output = start(initSegment);
      const top = boxes(bytes), data = view(bytes), used = [];
      for (const movie of top.filter(entry => entry.type === "moof")) {
        for (const entry of children(movie.bytes).filter(item => item.type === "traf")) {
          const parts = children(entry.bytes), tfhd = one(parts, "tfhd"), tfdt = one(parts, "tfdt");
          const header = view(tfhd), flags = header.getUint32(8) & 0xffffff;
          if (tfhd[8] !== 0 || (flags & ~0x02003a)) fail();
          const track = tracks.get(header.getUint32(12)); if (!track) fail();
          let offset = 16, duration = 0, size = 0, sampleFlags = 0;
          if (flags & 2) { if (header.getUint32(offset) !== 1) fail(); offset += 4; }
          if (flags & 8) { duration = header.getUint32(offset); offset += 4; }
          if (flags & 16) { size = header.getUint32(offset); offset += 4; }
          if (flags & 32) { sampleFlags = header.getUint32(offset); offset += 4; }
          if (offset !== tfhd.length || ![0, 1].includes(tfdt[8]) || tfdt.length !== (tfdt[8] ? 20 : 16)) fail();
          let dts = tfdt[8] ? Number(view(tfdt).getBigUint64(12)) : view(tfdt).getUint32(12);
          if (!Number.isSafeInteger(dts) || dts < 0) timeline();
          if (track.firstDts == null) track.firstDts = dts;
          else {
            const gap = dts - track.nextDts;
            // mux.js estimates the last video frame from the preceding frame.
            // At a VFR boundary use the next actual DTS, only within an already
            // observed frame interval (capped at 0.5s). AAC keeps its 2-tick limit.
            const last = track.samples.at(-1);
            const corrected = last ? last.duration + gap : 0;
            if (Math.abs(gap) > 2 && (track.kind !== "vide" || corrected <= 0
              || corrected < track.minSampleDuration - 2
              || corrected > Math.min(track.maxSampleDuration, track.timescale / 2) + 2)) timeline();
            if (gap) {
              if (!last || corrected <= 0) timeline();
              last.duration += gap;
            }
          }
          const truns = parts.filter(part => part.type === "trun"); if (truns.length !== 1) fail();
          const trun = truns[0].bytes, run = view(trun), runFlags = run.getUint32(8) & 0xffffff;
          const count = run.getUint32(12);
          if (![0, 1].includes(trun[8]) || (runFlags & ~0x000f05) || !(runFlags & 1) || !count
            || count > MAX_SAMPLES - sampleCount || ((runFlags & 4) && (runFlags & 0x400))) fail();
          const perSample = [0x100, 0x200, 0x400, 0x800].filter(flag => runFlags & flag).length * 4;
          let cursor = 20; let firstFlags = sampleFlags;
          if (runFlags & 4) { firstFlags = run.getUint32(cursor); cursor += 4; }
          if (trun.length !== cursor + count * perSample) fail();
          let mediaOffset = movie.start + run.getInt32(16), mediaEnd = mediaOffset;
          const region = top.find(part => part.type === "mdat" && mediaOffset >= part.start + 8 && mediaOffset < part.end);
          if (!region) fail();
          // Account for sample records before allocating them. The shared offscreen
          // budget includes metadata as well as in-flight media buffers.
          reserve(count * 96); metadataBytes += count * 96; sampleCount += count;
          const samples = [];
          for (let index = 0; index < count; index++) {
            const sample = {duration, size, flags: index === 0 ? firstFlags : sampleFlags, cts: 0};
            if (runFlags & 0x100) { sample.duration = run.getUint32(cursor); cursor += 4; }
            if (runFlags & 0x200) { sample.size = run.getUint32(cursor); cursor += 4; }
            if (runFlags & 0x400) { sample.flags = run.getUint32(cursor); cursor += 4; }
            if (runFlags & 0x800) { sample.cts = trun[8] ? run.getInt32(cursor) : run.getUint32(cursor); cursor += 4; }
            if (!sample.duration || sample.duration > track.timescale * 120 || !sample.size
              || Math.abs(sample.cts) > track.timescale * 120 || mediaEnd + sample.size > region.end) fail();
            track.maxSampleDuration = Math.max(track.maxSampleDuration, sample.duration);
            track.minSampleDuration = Math.min(track.minSampleDuration, sample.duration);
            track.minPts = Math.min(track.minPts, (dts + sample.cts) / track.timescale);
            track.maxPts = Math.max(track.maxPts, (dts + sample.cts + sample.duration) / track.timescale);
            samples.push(sample); dts += sample.duration; mediaEnd += sample.size;
          }
          if (used.some(([start, end]) => mediaOffset < end && mediaEnd > start)) fail();
          used.push([mediaOffset, mediaEnd]);
          for (const sample of samples) track.samples.push(sample);
          track.nextDts = dts;
          track.chunks.push({offset: position, count});
          output.push(bytes.subarray(mediaOffset, mediaEnd)); position += mediaEnd - mediaOffset;
        }
      }
      if (!used.length || used.reduce((sum, [start, end]) => sum + end - start, 0)
        !== top.filter(part => part.type === "mdat").reduce((sum, part) => sum + part.bytes.length - 8, 0)) fail();
      return output;
    }
    function finish(expectedSeconds) {
      if (!init || finished) fail(); finished = true;
      const active = [...tracks.values()]; if (active.some(track => !track.samples.length)) fail();
      if (active.filter(track => track.kind === "vide").length !== 1) fail();
      // Recompute presentation bounds after resolving fragment-boundary durations.
      for (const track of active) {
        let dts = track.firstDts;
        track.minPts = Infinity; track.maxPts = -Infinity;
        for (const sample of track.samples) {
          track.minPts = Math.min(track.minPts, (dts + sample.cts) / track.timescale);
          track.maxPts = Math.max(track.maxPts, (dts + sample.cts + sample.duration) / track.timescale);
          dts += sample.duration;
        }
      }
      const origin = Math.min(...active.map(track => track.minPts));
      const video = active.find(track => track.kind === "vide");
      const videoSeconds = video.maxPts - video.minPts, tolerance = Math.max(0.5, expectedSeconds * 0.002);
      if (!Number.isFinite(expectedSeconds) || expectedSeconds <= 0 || Math.abs(videoSeconds - expectedSeconds) > tolerance) timeline();
      const movieSeconds = Math.max(...active.map(track => track.maxPts)) - origin;
      if (!Number.isFinite(movieSeconds) || movieSeconds <= 0 || movieSeconds > expectedSeconds + tolerance) timeline();
      const movieHeader = mvhd.slice(), movieView = view(movieHeader);
      movieView.setUint32(20, 1000); movieView.setUint32(24, Math.ceil(movieSeconds * 1000));
      movieView.setUint32(movieHeader.length - 4, Math.max(...tracks.keys()) + 1);
      const trackBoxes = active.map(track => {
        const duration = Math.ceil((track.maxPts - origin) * 1000), tkhd = track.tkhd.slice();
        view(tkhd).setUint32(28, duration);
        const delta = Math.round(origin * track.timescale - track.firstDts);
        const edits = delta < 0 ? [[Math.round(-delta / track.timescale * 1000), -1, 0x10000],
          [Math.max(1, duration - Math.round(-delta / track.timescale * 1000)), 0, 0x10000]] : [[duration, delta, 0x10000]];
        const stts = table("stts", runs(track.samples.map(sample => sample.duration)));
        const offsets = track.samples.map(sample => sample.cts);
        const ctts = offsets.some(value => value) ? [table("ctts", runs(offsets), offsets.some(value => value < 0) ? 1 : 0)] : [];
        const stsc = [];
        track.chunks.forEach((chunk, index) => {
          if (!index || chunk.count !== track.chunks[index - 1].count) stsc.push([index + 1, chunk.count, 1]);
        });
        const sizes = new Uint8Array(track.samples.length * 4), sizeView = view(sizes);
        track.samples.forEach((sample, index) => sizeView.setUint32(index * 4, sample.size));
        const keys = track.kind === "vide" ? track.samples.flatMap((sample, index) => sample.flags & 0x10000 ? [] : [[index + 1]]) : [];
        if (track.kind === "vide" && (!keys.length || keys[0][0] !== 1)) fail();
        const stbl = box("stbl", track.stsd, stts, ...ctts, table("stsc", stsc),
          full("stsz", 0, u32(0), u32(track.samples.length), sizes),
          table("stco", track.chunks.map(chunk => [chunk.offset])), ...(keys.length ? [table("stss", keys)] : []));
        const minf = box("minf", ...track.minf.map(part => part.type === "stbl" ? stbl : part.bytes));
        return box("trak", tkhd, box("edts", table("elst", edits)), box("mdia",
          mediaHeader(track.mdhd, track.nextDts - track.firstDts), track.hdlr, minf));
      });
      view(mdatHeader).setUint32(0, position - ftyp.length);
      return {moov: box("moov", movieHeader, ...trackBoxes), header: mdatHeader, headerOffset: ftyp.length,
        duration: movieSeconds};
    }
    function dispose() { if (metadataBytes) { reserve(-metadataBytes); metadataBytes = 0; } tracks.clear(); }
    return {add, finish, dispose};
  }
  const api = {create}; root.PageMediaMp4 = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
