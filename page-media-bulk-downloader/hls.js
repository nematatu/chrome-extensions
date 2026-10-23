(function (root) {
  "use strict";
  const HOST = "https://vid.fun800.click";
  const MAX_MANIFEST_BYTES = 1024 * 1024;
  const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
  const MAX_FILE_BYTES = 1024 * 1024 * 1024;
  const MAX_SEGMENTS = 5000;
  const MAX_PARALLEL_SEGMENTS = 4;
  const fail = code => { throw new Error(code); };

  function resource(value, base, extension) {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) fail("HLS_UNSUPPORTED");
    let url, path;
    try { url = new URL(value, base); path = decodeURIComponent(url.pathname); } catch { fail("HLS_UNSUPPORTED"); }
    if (url.origin !== HOST || url.username || url.password || url.hash || /[\u0000-\u001f\u007f\\]/.test(path)
      || path.split("/").some(part => part === "." || part === "..") || !path.toLowerCase().endsWith(extension)) fail("HLS_UNSUPPORTED");
    return url.href;
  }

  function attributes(value) {
    const result = {};
    let offset = 0;
    const pattern = /([A-Z0-9-]+)=("[^"\r\n]*"|[^,\s]+)(?:,|$)/gy;
    while (offset < value.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(value);
      if (!match || Object.hasOwn(result, match[1])) fail("HLS_UNSUPPORTED");
      result[match[1]] = match[2].replace(/^"|"$/g, ""); offset = pattern.lastIndex;
    }
    return result;
  }

  function parsePlaylist(text, base) {
    resource(base, base, ".m3u8");
    if (typeof text !== "string" || text.length > MAX_MANIFEST_BYTES) fail("HLS_TOO_LARGE");
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U" || lines.length > 15000) fail("HLS_UNSUPPORTED");
    const variants = [], segments = [];
    const allowed = new Set(["#EXTM3U", "#EXT-X-VERSION", "#EXT-X-TARGETDURATION", "#EXT-X-MEDIA-SEQUENCE",
      "#EXT-X-PLAYLIST-TYPE", "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-ALLOW-CACHE", "#EXT-X-PROGRAM-DATE-TIME", "#EXT-X-START"]);
    let pendingVariant = null, pendingDuration = null, ended = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        if (pendingVariant || pendingDuration != null || segments.length || ended) fail("HLS_UNSUPPORTED");
        pendingVariant = attributes(line.slice(18));
        if (pendingVariant.AUDIO || pendingVariant.VIDEO || pendingVariant.SUBTITLES
          || (pendingVariant["CLOSED-CAPTIONS"] && pendingVariant["CLOSED-CAPTIONS"] !== "NONE")) fail("HLS_UNSUPPORTED");
      } else if (line.startsWith("#EXTINF:")) {
        if (pendingVariant || pendingDuration != null || variants.length || ended) fail("HLS_UNSUPPORTED");
        const value = line.slice(8).split(",", 1)[0];
        if (!/^\d+(?:\.\d+)?$/.test(value) || !(Number(value) > 0) || Number(value) > 120) fail("HLS_UNSUPPORTED");
        pendingDuration = Number(value);
      } else if (line === "#EXT-X-ENDLIST") {
        if (ended || pendingVariant || pendingDuration != null) fail("HLS_UNSUPPORTED");
        ended = true;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        if (attributes(line.slice(11)).METHOD !== "NONE") fail("HLS_UNSUPPORTED");
      } else if (line.startsWith("#")) {
        if (line.startsWith("#EXT") && !allowed.has(line.split(":", 1)[0])) fail("HLS_UNSUPPORTED");
      } else if (pendingVariant) {
        const bandwidth = Number(pendingVariant.BANDWIDTH);
        if (!/^[1-9]\d{0,9}$/.test(pendingVariant.BANDWIDTH) || !Number.isSafeInteger(bandwidth)
          || bandwidth > 1000000000 || variants.length >= 20) fail("HLS_UNSUPPORTED");
        variants.push({ url: resource(line, base, ".m3u8"), bandwidth }); pendingVariant = null;
      } else if (pendingDuration != null && !ended) {
        segments.push({ url: resource(line, base, ".ts"), duration: pendingDuration }); pendingDuration = null;
        if (segments.length > MAX_SEGMENTS) fail("HLS_TOO_LARGE");
      } else { fail("HLS_UNSUPPORTED"); }
    }
    if (pendingVariant || pendingDuration != null) fail("HLS_UNSUPPORTED");
    if (variants.length) return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth) };
    if (!ended || !segments.length) fail("HLS_UNSUPPORTED");
    return { segments };
  }

  async function read(url, limit, dependencies, onChunk) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signal = dependencies.signal;
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 30000);
    try {
      await dependencies.check?.();
      const response = await (dependencies.fetch || root.fetch)(url, {method: "GET", credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal});
      if (response.status === 429) fail("RATE_LIMITED");
      if ([401, 403].includes(response.status)) fail("AUTH_REQUIRED");
      if ([404, 410].includes(response.status)) fail("NOT_FOUND");
      if (!response.ok) fail("HLS_FETCH_FAILED");
      if (Number(response.headers.get("content-length")) > limit) fail("HLS_TOO_LARGE");
      const reader = response.body?.getReader();
      if (!reader) fail("HLS_FETCH_FAILED");
      const chunks = []; let size = 0;
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          if (signal?.aborted) fail("HLS_CANCELED");
          size += value.byteLength;
          if (size > limit) fail("HLS_TOO_LARGE");
          dependencies.account?.(value.byteLength);
          onChunk?.(value.byteLength); chunks.push(value);
        }
      } finally { try { await reader.cancel(); } catch {} }
      await dependencies.check?.();
      const result = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } catch (error) {
      if (signal?.aborted) fail("HLS_CANCELED");
      if (ERROR_CODES.includes(error?.message)) throw error;
      fail("HLS_FETCH_FAILED");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  async function loadPlan(url, dependencies = {}) {
    const seen = new Set();
    for (let depth = 0; depth < 3; depth++) {
      url = resource(url, url, ".m3u8");
      if (seen.has(url)) fail("HLS_UNSUPPORTED");
      seen.add(url);
      const data = await read(url, MAX_MANIFEST_BYTES, dependencies);
      let text;
      try { text = new TextDecoder("utf-8", {fatal: true}).decode(data); } catch { fail("HLS_UNSUPPORTED"); }
      const plan = parsePlaylist(text, url);
      if (plan.segments) return plan;
      url = plan.variants[0].url;
    }
    fail("HLS_UNSUPPORTED");
  }

  function validateTransportStream(data) {
    if (!data.length || data.length % 188 !== 0) fail("HLS_BAD_SEGMENT");
    for (let offset = 0; offset < data.length; offset += 188) {
      if (data[offset] !== 0x47 || (data[offset + 1] & 0x80) || !(data[offset + 3] & 0x30)) fail("HLS_BAD_SEGMENT");
    }
  }

  async function assemble(url, dependencies = {}) {
    const controller = new AbortController(), parentSignal = dependencies.signal;
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, {once: true});
    if (parentSignal?.aborted) controller.abort();
    dependencies = {...dependencies, signal: controller.signal};
    const mux = dependencies.muxjs || root.muxjs;
    const mp4 = dependencies.mp4 || root.PageMediaMp4;
    let transmuxer, file, size = 0, outputSize = 0, conversionError = null, fetchError = null;
    const parts = [], slots = new Map();
    function append(next) {
      for (const part of next) {
        outputSize += part.byteLength;
        if (outputSize > MAX_FILE_BYTES) fail("HLS_TOO_LARGE");
        dependencies.reserve?.(part.byteLength);
        parts.push(part);
      }
    }
    async function writeParts() {
      if (!dependencies.output) return;
      while (parts.length) {
        if (controller.signal.aborted) fail("HLS_CANCELED");
        await dependencies.output.write(parts[0]);
        dependencies.reserve?.(-parts[0].byteLength); parts.shift();
      }
    }
    try {
      const plan = await loadPlan(url, dependencies);
      if (!mux?.mp4?.Transmuxer || !mp4?.create) fail("HLS_UNSUPPORTED");
      file = mp4.create(dependencies.reserve);
      // Emit tracks independently so a segment without audio does not hold back
      // valid video. mp4.js combines their sample tables into one standalone file.
      transmuxer = new mux.mp4.Transmuxer({remux: false, keepOriginalTimestamps: false});
      transmuxer.on("error", () => { conversionError = "HLS_BAD_SEGMENT"; });
      transmuxer.on("data", segment => {
        if (!segment.initSegment?.length || !segment.data?.length) fail("HLS_BAD_SEGMENT");
        append(file.add(segment.initSegment, segment.data));
      });
      function start(index) {
        if (index >= plan.segments.length || controller.signal.aborted) return;
        const slot = {reserved: 0}; slots.set(index, slot);
        slot.promise = read(plan.segments[index].url, MAX_SEGMENT_BYTES, dependencies, bytes => {
          size += bytes;
          if (size > MAX_FILE_BYTES) fail("HLS_TOO_LARGE");
          dependencies.reserve?.(bytes); slot.reserved += bytes;
        }).then(data => ({data}), error => {
          fetchError ||= error; controller.abort(); return {error};
        });
      }
      const concurrency = Number.isInteger(dependencies.concurrency) && dependencies.concurrency > 0
        ? Math.min(MAX_PARALLEL_SEGMENTS, dependencies.concurrency) : MAX_PARALLEL_SEGMENTS;
      for (let index = 0; index < concurrency; index++) start(index);
      for (let index = 0; index < plan.segments.length; index++) {
        const slot = slots.get(index);
        const result = await slot.promise;
        if (fetchError) throw fetchError;
        if (result.error) throw result.error;
        const data = result.data;
        try {
          validateTransportStream(data);
          const before = outputSize;
          transmuxer.push(data);
          transmuxer.flush();
          if (conversionError) fail(conversionError);
          if (outputSize === before) fail("HLS_BAD_SEGMENT");
        } finally { dependencies.reserve?.(-slot.reserved); slot.reserved = 0; }
        await writeParts();
        slots.delete(index); start(index + concurrency);
        await dependencies.progress?.({bytes: size, completed: index + 1, total: plan.segments.length});
      }
      const final = file.finish(plan.segments.reduce((sum, segment) => sum + segment.duration, 0));
      append([final.moov]); await writeParts();
      if (controller.signal.aborted) fail("HLS_CANCELED");
      if (dependencies.output) await dependencies.output.write(final.header, final.headerOffset);
      return dependencies.output ? await dependencies.output.finish() : new Blob(parts, {type: "video/mp4"});
    } catch (error) {
      if (parentSignal?.aborted) fail("HLS_CANCELED");
      if (ERROR_CODES.includes(error?.message)) throw error;
      fail("HLS_BAD_SEGMENT");
    } finally {
      controller.abort();
      await Promise.allSettled([...slots.values()].map(slot => slot.promise));
      for (const slot of slots.values()) if (slot.reserved) dependencies.reserve?.(-slot.reserved);
      if (dependencies.output) for (const part of parts) dependencies.reserve?.(-part.byteLength);
      file?.dispose(); transmuxer?.dispose();
      parentSignal?.removeEventListener("abort", abort);
    }
  }

  const ERROR_CODES = ["HLS_UNSUPPORTED", "HLS_TOO_LARGE", "HLS_BAD_SEGMENT", "HLS_FETCH_FAILED", "HLS_CANCELED",
    "HLS_INVALID_TIMELINE", "HLS_RESOURCE_LIMIT", "HLS_STORAGE_FAILED", "HLS_TIMEOUT", "PAGE_CHANGED", "SCAN_TIMEOUT", "TOO_MUCH_DATA", "RATE_LIMITED", "AUTH_REQUIRED", "NOT_FOUND"];
  const api = {parsePlaylist, loadPlan, assemble, ERROR_CODES, MAX_FILE_BYTES, MAX_PARALLEL_SEGMENTS};
  root.PageMediaHls = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
