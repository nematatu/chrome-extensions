/* Clean-room HLS (VOD, unencrypted) parser and MP4 assembler. */
(function (root) {
  "use strict";

  const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
  const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
  const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
  const MAX_SEGMENTS = 20000;
  const MAX_VARIANTS = 60;
  const PARALLEL_SEGMENTS = 4;
  const ERROR_CODES = ["HLS_UNSUPPORTED", "HLS_TOO_LARGE", "HLS_BAD_SEGMENT", "HLS_FETCH_FAILED",
    "HLS_CANCELED", "HLS_STORAGE_FAILED", "HLS_TIMEOUT", "HLS_LIVE", "HLS_ENCRYPTED",
    "HLS_SEPARATE_AUDIO_UNSUPPORTED", "RATE_LIMITED", "AUTH_REQUIRED", "NOT_FOUND", "NOT_MEDIA", "UNSAFE_TARGET"];

  const fail = code => { throw new Error(code); };

  function decodeEntities(value) {
    return String(value).replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
  }

  function attributes(value) {
    const result = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match;
    while ((match = pattern.exec(value))) {
      const key = match[1];
      if (Object.hasOwn(result, key)) fail("HLS_UNSUPPORTED");
      result[key] = decodeEntities(match[2].replace(/^"|"$/g, "").trim());
    }
    return result;
  }

  function resolve(value, base) {
    if (typeof value !== "string" || !value || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) fail("HLS_UNSUPPORTED");
    let url;
    try { url = new URL(value, base); } catch { fail("HLS_UNSUPPORTED"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("HLS_UNSUPPORTED");
    return url.href;
  }

  function parseByteRange(value) {
    const match = /^(\d+)(?:@(\d+))?$/.exec(String(value || "").trim());
    if (!match) fail("HLS_UNSUPPORTED");
    const length = Number(match[1]), offset = match[2] == null ? null : Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0 || (offset != null && (!Number.isSafeInteger(offset) || offset < 0))) fail("HLS_UNSUPPORTED");
    return { length, offset };
  }

  function durationOf(value) {
    const number = Number(String(value || "").trim().split(",")[0]);
    if (!Number.isFinite(number) || number <= 0 || number > 86400) fail("HLS_UNSUPPORTED");
    return number;
  }

  function parseMaster(text, base) {
    if (typeof text !== "string" || text.length > MAX_MANIFEST_BYTES) fail("HLS_TOO_LARGE");
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") fail("HLS_UNSUPPORTED");
    const audio = new Map(), variants = [];
    let pending = null;
    for (const line of lines.slice(1)) {
      if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = attributes(line.slice(13));
        if (attrs.TYPE === "AUDIO" && attrs["GROUP-ID"] && attrs.URI) {
          if (!audio.has(attrs["GROUP-ID"])) audio.set(attrs["GROUP-ID"], []);
          audio.get(attrs["GROUP-ID"]).push({
            url: resolve(attrs.URI, base), name: attrs.NAME || "", language: attrs.LANGUAGE || "",
            default: attrs.DEFAULT === "YES"
          });
        }
      } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
        if (pending) fail("HLS_UNSUPPORTED");
        pending = attributes(line.slice(18));
      } else if (!line.startsWith("#") && pending) {
        const bandwidth = Number(pending.BANDWIDTH);
        if (!Number.isSafeInteger(bandwidth) || bandwidth <= 0 || bandwidth > 1000000000) fail("HLS_UNSUPPORTED");
        let width = 0, height = 0;
        if (pending.RESOLUTION) {
          const match = /^(\d{1,5})x(\d{1,5})$/.exec(pending.RESOLUTION);
          if (!match) fail("HLS_UNSUPPORTED");
          width = Number(match[1]); height = Number(match[2]);
        }
        const group = pending.AUDIO || "";
        const renditions = audio.get(group) || [];
        const chosenAudio = renditions.find(item => item.default) || renditions[0];
        variants.push({
          url: resolve(line, base), bandwidth, width, height, codecs: pending.CODECS || "",
          audioGroup: group, audioUrl: chosenAudio ? chosenAudio.url : "", audioName: chosenAudio ? chosenAudio.name : ""
        });
        if (variants.length > MAX_VARIANTS) fail("HLS_TOO_LARGE");
        pending = null;
      }
    }
    if (pending || !variants.length) fail("HLS_UNSUPPORTED");
    // Resolve audio groups after reading the whole playlist because a master
    // playlist may declare EXT-X-MEDIA after its variants.
    for (const variant of variants) {
      if (!variant.audioGroup) continue;
      const renditions = audio.get(variant.audioGroup) || [];
      const chosen = renditions.find(item => item.default) || renditions[0];
      if (!chosen) continue;
      variant.audioUrl = chosen.url;
      variant.audioName = chosen.name;
    }
    // An AUDIO group without a URI-bearing rendition is muxed into the
    // variant stream, so it must not be treated as separate audio.
    variants.sort((left, right) => right.bandwidth - left.bandwidth);
    return { variants, hasSeparateAudio: variants.some(item => item.audioUrl) };
  }

  function parseMedia(text, base) {
    if (typeof text !== "string" || text.length > MAX_MANIFEST_BYTES) fail("HLS_TOO_LARGE");
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") fail("HLS_UNSUPPORTED");
    let encrypted = false, ended = false, vod = false, init = null, pendingDuration = null, pendingRange = null;
    let previousUrl = "", previousEnd = 0, discontinuity = false, gap = false;
    const segments = [];
    for (const line of lines.slice(1)) {
      if (line === "#EXT-X-ENDLIST") { ended = true; continue; }
      if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
        const type = line.slice(line.indexOf(":") + 1).trim().toUpperCase();
        if (type === "VOD") vod = true;
        else if (type === "EVENT") continue;
        else fail("HLS_UNSUPPORTED");
        continue;
      }
      if (line === "#EXT-X-DISCONTINUITY") { discontinuity = true; continue; }
      if (line === "#EXT-X-GAP") { gap = true; continue; }
      if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
        const attrs = attributes(line.slice(line.indexOf(":") + 1));
        if (attrs.METHOD && attrs.METHOD !== "NONE") encrypted = true;
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = attributes(line.slice(11));
        if (!attrs.URI) fail("HLS_UNSUPPORTED");
        const range = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE) : null;
        if (range && range.offset == null) range.offset = 0;
        const next = { url: resolve(attrs.URI, base), range };
        if (init && (init.url !== next.url || JSON.stringify(init.range) !== JSON.stringify(next.range))) fail("HLS_UNSUPPORTED");
        if (segments.length) fail("HLS_UNSUPPORTED");
        init = next;
        continue;
      }
      if (line.startsWith("#EXT-X-BYTERANGE:")) { pendingRange = parseByteRange(line.slice(17)); continue; }
      if (line.startsWith("#EXTINF:")) { pendingDuration = durationOf(line.slice(8)); continue; }
      if (line.startsWith("#")) continue;
      if (pendingDuration == null) fail("HLS_UNSUPPORTED");
      const url = resolve(line, base);
      let range = pendingRange;
      if (range && range.offset == null) {
        if (previousUrl !== url) fail("HLS_UNSUPPORTED");
        range = { length: range.length, offset: previousEnd };
      }
      if (range) { previousEnd = range.offset + range.length; previousUrl = url; }
      segments.push({ url, duration: pendingDuration, range });
      if (segments.length > MAX_SEGMENTS) fail("HLS_TOO_LARGE");
      pendingDuration = null; pendingRange = null;
    }
    if (!segments.length) fail("HLS_UNSUPPORTED");
    // Explicit VOD playlists are complete even when a CDN omits ENDLIST.
    if (!ended && !vod) fail("HLS_LIVE");
    if (discontinuity) fail("HLS_UNSUPPORTED");
    if (gap) fail("HLS_UNSUPPORTED");
    return {
      segments, init, encrypted, ended: ended || vod, duration: segments.reduce((sum, item) => sum + item.duration, 0),
      fragmented: Boolean(init)
    };
  }

  function parsePlaylist(text, base) {
    if (typeof text !== "string" || text.length > MAX_MANIFEST_BYTES) fail("HLS_TOO_LARGE");
    const head = text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 200).join("\n");
    if (head.includes("#EXT-X-STREAM-INF:")) return parseMaster(text, base);
    return parseMedia(text, base);
  }

  function contentType(response) {
    return String(response.headers?.get?.("content-type") || "").toLowerCase();
  }

  function isHtml(response) {
    const type = contentType(response);
    return type.includes("text/html") || type.includes("application/json");
  }

  function timeoutSignal(parent, milliseconds) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent) {
      if (parent.aborted) controller.abort();
      else parent.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), milliseconds);
    return { signal: controller.signal, cleanup: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); }, abort };
  }

  async function readResponse(url, options, deps) {
    const limit = options.limit || MAX_SEGMENT_BYTES;
    // The requested window is buffered in memory, also when a server ignores Range, so it must fit the limit.
    if (options.range && options.range.length > limit) fail("HLS_TOO_LARGE");
    const request = deps.request || deps.fetch || root.fetch;
    if (typeof request !== "function") fail("HLS_FETCH_FAILED");
    const timeout = timeoutSignal(deps.signal, deps.timeoutMs || 60000);
    try {
      const headers = {};
      if (options.range) headers.Range = `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`;
      const response = await request(url, {
        method: "GET", credentials: "include", redirect: "follow", cache: "no-store",
        referrer: deps.pageUrl || undefined, referrerPolicy: "strict-origin-when-cross-origin",
        signal: timeout.signal, headers
      });
      if (response.status === 429) fail("RATE_LIMITED");
      if (response.status === 401 || response.status === 403) fail("AUTH_REQUIRED");
      if (response.status === 404 || response.status === 410) fail("NOT_FOUND");
      if (!response.ok) fail("HLS_FETCH_FAILED");
      if (response.url && !isHttpUrl(response.url)) fail("HLS_FETCH_FAILED");
      const declared = Number(response.headers?.get?.("content-length"));
      const ignoringRange = options.range && response.status !== 206;
      if (!ignoringRange && Number.isFinite(declared) && declared > limit) fail("HLS_TOO_LARGE");
      if (isHtml(response)) fail("NOT_MEDIA");
      const reader = response.body?.getReader();
      if (!reader) fail("HLS_FETCH_FAILED");
      const parts = [];
      let size = 0;
      try {
        if (ignoringRange) {
          const end = options.range.offset + options.range.length;
          let position = 0;
          while (position < end) {
            const { value, done } = await reader.read();
            if (done) break;
            if (deps.signal?.aborted) fail("HLS_CANCELED");
            const start = Math.max(0, options.range.offset - position);
            const stop = Math.min(value.byteLength, end - position);
            if (stop > start) parts.push(value.subarray(start, stop));
            position += value.byteLength;
          }
        } else {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (deps.signal?.aborted) fail("HLS_CANCELED");
            size += value.byteLength;
            if (size > limit) fail("HLS_TOO_LARGE");
            parts.push(value);
          }
        }
      } finally {
        // Stop the network transfer when a range is satisfied early or a
        // size/abort check throws before the body has been consumed.
        try { await reader.cancel(); } catch {}
      }
      let bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      if (options.range && response.status === 200 && bytes.length !== options.range.length) fail("HLS_BAD_SEGMENT");
      return { bytes, url: response.url || url };
    } catch (error) {
      if (deps.signal?.aborted) fail("HLS_CANCELED");
      if (error?.name === "AbortError") fail("HLS_TIMEOUT");
      if (ERROR_CODES.includes(error?.message)) throw error;
      fail("HLS_FETCH_FAILED");
    } finally { timeout.cleanup(); }
  }

  const readBytes = async (url, options, deps) => (await readResponse(url, options, deps)).bytes;

  // A manifest's relative references point next to where it was finally served from, after redirects.
  async function readPlaylist(url, deps) {
    const { bytes, url: served } = await readResponse(url, { limit: MAX_MANIFEST_BYTES }, deps);
    return parsePlaylist(decodeText(bytes), served);
  }

  function isHttpUrl(value) {
    try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; }
    catch { return false; }
  }

  function decodeText(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("HLS_UNSUPPORTED"); }
  }

  async function loadPlaylist(url, deps, depth = 0) {
    if (depth > 2) fail("HLS_UNSUPPORTED");
    const plan = await readPlaylist(url, deps);
    if (plan.variants) {
      let variant = plan.variants[0];
      if (deps.variantUrl) {
        const match = plan.variants.find(item => item.url === deps.variantUrl);
        if (!match) fail("HLS_UNSUPPORTED");
        variant = match;
      } else if (Number.isFinite(deps.maxHeight) && deps.maxHeight > 0) {
        const fitting = plan.variants.filter(item => !item.height || item.height <= deps.maxHeight);
        if (fitting.length) variant = fitting[0];
      }
      const media = await loadPlaylist(variant.url, { ...deps, variantUrl: "", maxHeight: 0 }, depth + 1);
      media.variant = variant;
      if (variant.audioUrl && media.init) fail("HLS_SEPARATE_AUDIO_UNSUPPORTED");
      if (variant.audioUrl) {
        const audio = await loadPlaylist(variant.audioUrl, { ...deps, variantUrl: "", maxHeight: 0 }, depth + 1);
        if (!audio.segments || audio.init || audio.encrypted) fail("HLS_SEPARATE_AUDIO_UNSUPPORTED");
        media.audioSegments = audio.segments;
        media.audioDuration = audio.duration;
      }
      return media;
    }
    return plan;
  }

  function memoryOutput() {
    let parts = [], length = 0;
    return {
      async write(data, position) {
        if (position == null || position === length) { parts.push(data); length += data.byteLength; return; }
        if (position < 0 || position > length) fail("HLS_STORAGE_FAILED");
        const merged = new Uint8Array(Math.max(length, position + data.byteLength));
        let offset = 0;
        for (const part of parts) { merged.set(part, offset); offset += part.byteLength; }
        merged.set(data, position);
        parts = [merged]; length = merged.byteLength;
      },
      async finish() { return new Blob(parts, { type: "video/mp4" }); },
      get size() { return length; }
    };
  }

  function boxList(view, bytes, offset, end, limit = 2000) {
    const result = [];
    while (offset + 8 <= end && result.length < limit) {
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) fail("HLS_BAD_SEGMENT");
        size = Number(view.getBigUint64(offset + 8));
        header = 16;
      }
      if (size < header || offset + size > end) fail("HLS_BAD_SEGMENT");
      result.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start: offset, end: offset + size, body: offset + header });
      offset += size;
    }
    if (offset < end) fail("HLS_BAD_SEGMENT");
    return result;
  }

  function trackInfo(init) {
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
    const moov = boxList(view, init, 0, init.length).find(box => box.type === "moov");
    if (!moov) fail("HLS_BAD_SEGMENT");
    const tracks = [];
    for (const track of boxList(view, init, moov.body, moov.end).filter(box => box.type === "trak")) {
      const entries = boxList(view, init, track.body, track.end);
      const tkhd = entries.find(box => box.type === "tkhd");
      const mdia = entries.find(box => box.type === "mdia");
      if (!tkhd || !mdia) fail("HLS_BAD_SEGMENT");
      const hdlr = boxList(view, init, mdia.body, mdia.end).find(box => box.type === "hdlr");
      if (!hdlr) fail("HLS_BAD_SEGMENT");
      tracks.push({ id: view.getUint32(tkhd.body + 12), kind: String.fromCharCode(...init.subarray(hdlr.body + 8, hdlr.body + 12)) });
    }
    return tracks;
  }

  function retrackInit(init, id) {
    const bytes = init.slice();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moov = boxList(view, bytes, 0, bytes.length).find(box => box.type === "moov");
    if (!moov) fail("HLS_BAD_SEGMENT");
    for (const child of boxList(view, bytes, moov.body, moov.end)) {
      if (child.type === "trak") {
        const tkhd = boxList(view, bytes, child.body, child.end).find(box => box.type === "tkhd");
        if (!tkhd) fail("HLS_BAD_SEGMENT");
        view.setUint32(tkhd.body + 12, id);
      } else if (child.type === "mvex") {
        for (const trex of boxList(view, bytes, child.body, child.end).filter(box => box.type === "trex")) {
          view.setUint32(trex.body + 4, id);
        }
      }
    }
    return bytes;
  }

  function retrackData(data, id) {
    const bytes = data.slice();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const moof of boxList(view, bytes, 0, bytes.length).filter(box => box.type === "moof")) {
      for (const traf of boxList(view, bytes, moof.body, moof.end).filter(box => box.type === "traf")) {
        const tfhd = boxList(view, bytes, traf.body, traf.end).find(box => box.type === "tfhd");
        if (!tfhd) fail("HLS_BAD_SEGMENT");
        view.setUint32(tfhd.body + 4, id);
      }
    }
    return bytes;
  }

  function looksLikeTransportStream(bytes) {
    if (!bytes || bytes.length < 188) return false;
    if (bytes[0] === 0x47) return true;
    // ID3 tag before the first packet is common in HLS.
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
      return bytes.length > size + 10 && bytes[size + 10] === 0x47;
    }
    return false;
  }

  async function assemble(url, deps = {}) {
    const output = deps.output || memoryOutput();
    const mux = deps.muxjs || root.muxjs;
    const mp4 = deps.mp4 || root.MediaSaverMp4;
    const controller = new AbortController();
    const abort = () => controller.abort();
    deps.signal?.addEventListener("abort", abort, { once: true });
    if (deps.signal?.aborted) controller.abort();
    const runtime = { ...deps, signal: controller.signal };
    let written = 0, completed = 0, total = 0, transmuxer = null, file = null;
    const write = async data => {
      written += data.byteLength;
      if (written > MAX_FILE_BYTES) fail("HLS_TOO_LARGE");
      await output.write(data);
    };
    try {
      const plan = await loadPlaylist(url, runtime);
      if (plan.encrypted) fail("HLS_ENCRYPTED");
      if (!plan.ended) fail("HLS_LIVE");
      total = plan.segments.length + (plan.audioSegments?.length || 0);
      const progress = async () => {
        await deps.progress?.({ bytes: written, completed, total });
      };
      if (plan.fragmented) {
        if (plan.audioSegments?.length) fail("HLS_SEPARATE_AUDIO_UNSUPPORTED");
        if (plan.init) await write(await readBytes(plan.init.url, { limit: MAX_SEGMENT_BYTES, range: plan.init.range }, runtime));
        for (let index = 0; index < plan.segments.length; index++) {
          const segment = plan.segments[index];
          await write(await readBytes(segment.url, { limit: MAX_SEGMENT_BYTES, range: segment.range }, runtime));
          completed++;
          await progress();
        }
        return { size: written, extension: "mp4", mime: "video/mp4", duration: plan.duration, fragmented: true };
      }
      if (!mux?.mp4?.Transmuxer || !mp4?.create) fail("HLS_UNSUPPORTED");
      transmuxer = new mux.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: false });
      let pending = [], conversionError = null;
      transmuxer.on("error", () => { conversionError = "HLS_BAD_SEGMENT"; });
      transmuxer.on("data", segment => {
        if (!segment.initSegment?.length || !segment.data?.length) return;
        pending.push(segment);
      });
      file = mp4.create();
      const first = plan.segments[0];
      const firstBytes = await readBytes(first.url, { limit: MAX_SEGMENT_BYTES, range: first.range }, runtime);
      if (!looksLikeTransportStream(firstBytes)) fail("HLS_BAD_SEGMENT");
      transmuxer.push(firstBytes); transmuxer.flush();
      if (conversionError) fail(conversionError);
      if (!pending.length) fail("HLS_BAD_SEGMENT");
      const firstTracks = trackInfo(pending[0].initSegment);
      const trackKinds = new Set(firstTracks.map(track => track.kind));
      if (!trackKinds.has("vide") && !trackKinds.has("soun")) fail("HLS_UNSUPPORTED");
      let audioSegments = plan.audioSegments || [];
      let audioTrackId = null;
      if (audioSegments.length) {
        if (trackKinds.has("soun")) audioSegments = [];
        else audioTrackId = Math.max(257, ...firstTracks.map(track => track.id + 1));
      }
      total = plan.segments.length + audioSegments.length;
      const addPart = async (part, trackId) => {
        let init = part.initSegment, data = part.data;
        if (trackId != null) {
          const tracks = trackInfo(init);
          if (tracks.length !== 1 || tracks[0].kind !== "soun") fail("HLS_SEPARATE_AUDIO_UNSUPPORTED");
          init = retrackInit(init, trackId);
          data = retrackData(data, trackId);
        }
        for (const piece of file.add(init, data)) await write(piece);
      };
      for (const part of pending) await addPart(part);
      pending = [];
      completed++; await progress();
      for (const segment of plan.segments.slice(1)) {
        const bytes = await readBytes(segment.url, { limit: MAX_SEGMENT_BYTES, range: segment.range }, runtime);
        if (!looksLikeTransportStream(bytes)) fail("HLS_BAD_SEGMENT");
        transmuxer.push(bytes); transmuxer.flush();
        if (conversionError) fail(conversionError);
        for (const part of pending) await addPart(part);
        pending = [];
        completed++; await progress();
      }
      if (audioSegments.length) {
        for (const segment of audioSegments) {
          const bytes = await readBytes(segment.url, { limit: MAX_SEGMENT_BYTES, range: segment.range }, runtime);
          if (!looksLikeTransportStream(bytes)) fail("HLS_BAD_SEGMENT");
          transmuxer.push(bytes); transmuxer.flush();
          if (conversionError) fail(conversionError);
          for (const part of pending) await addPart(part, audioTrackId);
          pending = [];
          completed++; await progress();
        }
      }
      const final = file.finish(plan.duration);
      await write(final.moov);
      await output.write(final.header, final.headerOffset);
      const audioOnly = !trackKinds.has("vide");
      return {
        size: written, extension: audioOnly ? "m4a" : "mp4",
        mime: audioOnly ? "audio/mp4" : "video/mp4", duration: plan.duration,
        audioOnly, separateAudio: Boolean(audioTrackId)
      };
    } catch (error) {
      if (deps.signal?.aborted) fail("HLS_CANCELED");
      if (ERROR_CODES.includes(error?.message)) throw error;
      fail("HLS_BAD_SEGMENT");
    } finally {
      deps.signal?.removeEventListener("abort", abort);
      transmuxer?.dispose?.();
      file?.dispose?.();
      if (deps.output && deps.abortOutputOnError && !deps.signal?.aborted) { /* caller owns cleanup */ }
    }
  }

  async function probe(url, deps = {}) {
    const plan = await readPlaylist(url, deps);
    if (!plan.variants) {
      if (plan.encrypted) fail("HLS_ENCRYPTED");
      return { kind: "hls", variants: [], separateAudio: false, duration: plan.duration, fragmented: plan.fragmented };
    }
    return {
      kind: "hls", separateAudio: plan.hasSeparateAudio,
      variants: plan.variants.map((item, index) => ({
        index, url: item.url, bandwidth: item.bandwidth, width: item.width, height: item.height,
        label: item.height ? `${item.height}p` : item.bandwidth ? `${Math.round(item.bandwidth / 1000)} kbps` : `画質 ${index + 1}`,
        audioUrl: item.audioUrl
      }))
    };
  }

  const api = { parsePlaylist, parseMaster, parseMedia, loadPlaylist, assemble, probe, memoryOutput, ERROR_CODES, MAX_FILE_BYTES };
  root.MediaSaverHls = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
