/* Minimal, strict DASH MPD reader for unencrypted VOD streams. */
(function (root) {
  "use strict";

  const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
  const MAX_SEGMENTS = 20000;
  const fail = code => { throw new Error(code); };

  function attr(source, name) {
    const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
    const match = pattern.exec(source || "");
    return match ? (match[2] != null ? match[2] : match[3]) : "";
  }

  function attrMap(source) {
    const result = {};
    for (const match of String(source || "").matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      result[match[1]] = match[3] != null ? match[3] : match[4];
    }
    return result;
  }

  function attrText(values) {
    return Object.entries(values).map(([key, value]) => `${key}="${String(value).replace(/"/g, "&quot;")}"`).join(" ");
  }

  function mergeTag(parent, child) {
    if (!parent) return child;
    if (!child) return parent;
    return {
      attrs: attrText({ ...attrMap(parent.attrs), ...attrMap(child.attrs) }),
      body: String(child.body || "").trim() ? child.body : parent.body
    };
  }

  function decode(value) {
    return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }

  function resolve(value, base) {
    if (typeof value !== "string" || !value || value.length > 8192) fail("DASH_UNSUPPORTED");
    let url;
    try { url = new URL(decode(value).trim(), base); } catch { fail("DASH_UNSUPPORTED"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("DASH_UNSUPPORTED");
    return url.href;
  }

  function duration(value) {
    if (!value) return 0;
    const match = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
    if (!match) fail("DASH_UNSUPPORTED");
    const [, years, months, days, hours, minutes, seconds] = match;
    return (Number(years) || 0) * 365 * 86400 + (Number(months) || 0) * 30 * 86400
      + (Number(days) || 0) * 86400 + (Number(hours) || 0) * 3600
      + (Number(minutes) || 0) * 60 + (Number(seconds) || 0);
  }

  function expand(template, values) {
    return String(template).replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (whole, key, width) => {
      if (!key) return "$";
      if (key === "RepresentationID") return values.RepresentationID || "";
      if (key === "Bandwidth") return String(values.Bandwidth || "");
      const number = Number(key === "Time" ? values.Time : values.Number);
      if (!Number.isSafeInteger(number) || number < 0) fail("DASH_UNSUPPORTED");
      return String(number).padStart(width ? Number(width) : 0, "0");
    }).replace(/\$\$/g, "$");
  }

  function firstTag(source, name) {
    const match = new RegExp(`<${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${name}>)`, "i").exec(source);
    return match ? { attrs: match[1], body: match[2] || "" } : null;
  }

  function withoutRepresentations(source) {
    return String(source).replace(/<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/gi, "");
  }

  function withoutAdaptationSets(source) {
    return String(source).replace(/<AdaptationSet\b[^>]*?(?:\/>|>[\s\S]*?<\/AdaptationSet>)/gi, "");
  }

  function parseTimeline(template, start, end, timescale) {
    const source = template && template.body != null ? template.body : template;
    const timeline = firstTag(source, "SegmentTimeline");
    if (!timeline) return null;
    const rows = [...timeline.body.matchAll(/<S\b([^>]*)\/?>/gi)].map(match => {
      const row = { t: attr(match[1], "t"), d: attr(match[1], "d"), r: attr(match[1], "r") };
      if (!row.d) fail("DASH_UNSUPPORTED");
      return row;
    });
    if (!rows.length) fail("DASH_UNSUPPORTED");
    const segments = [];
    let current = start;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const d = Number(row.d);
      if (!Number.isSafeInteger(d) || d <= 0) fail("DASH_UNSUPPORTED");
      if (row.t) current = Number(row.t);
      if (!Number.isSafeInteger(current) || current < 0) fail("DASH_UNSUPPORTED");
      let repeat = row.r === "" ? 0 : Number(row.r);
      if (!Number.isSafeInteger(repeat) || repeat < -1) fail("DASH_UNSUPPORTED");
      if (repeat === -1) {
        const next = rows[index + 1]?.t ? Number(rows[index + 1].t) : end;
        repeat = next > current ? Math.ceil((next - current) / d) - 1 : 0;
      }
      for (let count = 0; count <= repeat; count++) {
        if (segments.length >= MAX_SEGMENTS) fail("DASH_TOO_LARGE");
        segments.push({ time: current, number: segments.length + 1 });
        current += d;
      }
    }
    return segments;
  }

  function templateSegments(template, base, representation, periodDuration, ptoTime) {
    const source = template && template.attrs != null ? template.attrs : template;
    const media = attr(source, "media");
    const initialization = attr(source, "initialization");
    if (!media) fail("DASH_UNSUPPORTED");
    const timescale = Number(attr(source, "timescale") || 1);
    const segmentDuration = Number(attr(source, "duration") || 0);
    const startNumber = Number(attr(source, "startNumber") || 1);
    const endNumber = Number(attr(source, "endNumber") || 0);
    const pto = Number(attr(source, "presentationTimeOffset") || 0);
    if (!Number.isSafeInteger(timescale) || timescale <= 0 || !Number.isSafeInteger(pto) || pto < 0) fail("DASH_UNSUPPORTED");
    if (!Number.isSafeInteger(startNumber) || startNumber < 0) fail("DASH_UNSUPPORTED");
    let rows;
    const timeline = parseTimeline(template, pto, Math.round((periodDuration || 0) * timescale) + pto, timescale);
    if (timeline) rows = timeline.map((row, index) => ({ ...row, number: startNumber + index }));
    else {
      if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) fail("DASH_UNSUPPORTED");
      if (!Number.isFinite(periodDuration) || periodDuration <= 0) fail("DASH_UNSUPPORTED");
      let count = Math.ceil(periodDuration * timescale / segmentDuration);
      if (endNumber && endNumber >= startNumber) count = Math.min(count, endNumber - startNumber + 1);
      if (count < 1 || count > MAX_SEGMENTS) fail("DASH_TOO_LARGE");
      rows = Array.from({ length: count }, (_, index) => ({ number: startNumber + index, time: pto + index * segmentDuration }));
    }
    const values = { RepresentationID: representation.id, Bandwidth: representation.bandwidth };
    return {
      initUrl: initialization ? resolve(expand(initialization, values), base) : null,
      segments: rows.map(row => ({ url: resolve(expand(media, { ...values, Number: row.number, Time: row.time }), base) })),
      timescale, segmentDuration, pto
    };
  }

  function parseRange(value) {
    if (!value) return null;
    const match = /^(\d+)-(\d+)$/.exec(String(value).trim());
    if (!match) fail("DASH_UNSUPPORTED");
    const offset = Number(match[1]), end = Number(match[2]);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end < offset) fail("DASH_UNSUPPORTED");
    return { offset, length: end - offset + 1 };
  }

  function listSegments(list, base, representation) {
    const attrs = list.attrs || "";
    const source = attr(attrs, "sourceURL") || representation.base;
    const init = /<Initialization\b([^>]*?)\/?>/i.exec(list.body);
    let initUrl = null, initRange = null;
    if (init) {
      const initSource = attr(init[1], "sourceURL") || source;
      if (initSource) {
        initUrl = resolve(expand(initSource, { RepresentationID: representation.id, Bandwidth: representation.bandwidth }), base);
        initRange = parseRange(attr(init[1], "range"));
      }
    }
    const segments = [...list.body.matchAll(/<SegmentURL\b([^>]*?)\/?>/gi)].map(match => {
      const media = attr(match[1], "media") || source;
      if (!media) fail("DASH_UNSUPPORTED");
      return {
        url: resolve(expand(media, { RepresentationID: representation.id, Bandwidth: representation.bandwidth }), base),
        range: parseRange(attr(match[1], "mediaRange"))
      };
    });
    if (!segments.length) fail("DASH_UNSUPPORTED");
    return { initUrl, initRange, segments };
  }

  function representations(body, periodBase, inheritedTemplate, inheritedList, header) {
    const baseUrl = firstTag(header, "BaseURL");
    const localBase = baseUrl ? resolve(baseUrl.body, periodBase) : periodBase;
    const template = mergeTag(inheritedTemplate, firstTag(header, "SegmentTemplate"));
    const list = mergeTag(inheritedList, firstTag(header, "SegmentList"));
    const adaptationMime = attr(header, "mimeType");
    const contentType = attr(header, "contentType");
    const fallbackMime = adaptationMime || (contentType === "video" ? "video/mp4" : contentType === "audio" ? "audio/mp4" : "");
    return [...body.matchAll(/<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi)].map(match => {
      const attrs = match[1], inner = match[2] || "";
      const repBaseUrl = firstTag(inner, "BaseURL");
      const repBase = repBaseUrl ? resolve(repBaseUrl.body, localBase) : localBase;
      const repTemplate = mergeTag(template, firstTag(inner, "SegmentTemplate"));
      const repList = mergeTag(list, firstTag(inner, "SegmentList"));
      const segmentBase = firstTag(inner, "SegmentBase") || firstTag(header, "SegmentBase");
      const hasBase = Boolean(repBaseUrl || baseUrl);
      const mime = attr(attrs, "mimeType") || fallbackMime;
      return {
        id: attr(attrs, "id") || "", bandwidth: Number(attr(attrs, "bandwidth") || 0),
        width: Number(attr(attrs, "width") || 0), height: Number(attr(attrs, "height") || 0),
        codecs: attr(attrs, "codecs") || attr(header, "codecs") || "", mime,
        base: repBase, template: repTemplate, list: repList, segmentBase: Boolean(segmentBase),
        singleUrl: !repTemplate && !repList && hasBase && !repBase.endsWith("/") ? repBase : null
      };
    });
  }

  function parseMpd(text, baseUrl) {
    if (typeof text !== "string" || text.length > MAX_MANIFEST_BYTES) fail("DASH_TOO_LARGE");
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail("DASH_UNSUPPORTED");
    if (!/<MPD\b/i.test(text)) fail("DASH_UNSUPPORTED");
    if (/<(?:[\w.-]+:)?ContentProtection\b/i.test(text)) fail("DASH_ENCRYPTED");
    if (/\btype\s*=\s*["']dynamic["']/i.test(text)) fail("DASH_LIVE");
    const rootTag = /<MPD\b([^>]*)>/i.exec(text);
    if (!rootTag) fail("DASH_UNSUPPORTED");
    const totalDuration = duration(attr(rootTag[1], "mediaPresentationDuration"));
    const firstPeriodIndex = text.search(/<Period\b/i);
    const rootPrefix = firstPeriodIndex > rootTag.index + rootTag[0].length
      ? text.slice(rootTag.index + rootTag[0].length, firstPeriodIndex) : "";
    const rootBaseTag = firstTag(rootPrefix, "BaseURL");
    const rootBase = rootBaseTag ? resolve(rootBaseTag.body, baseUrl) : baseUrl;
    const periods = [...text.matchAll(/<Period\b([^>]*)>([\s\S]*?)<\/Period>/gi)];
    if (periods.length !== 1) fail("DASH_UNSUPPORTED");
    const periodAttrs = periods[0][1], periodBody = periods[0][2];
    if (/<(?:[\w.-]+:)?ContentProtection\b/i.test(periodBody)) fail("DASH_ENCRYPTED");
    const periodStart = duration(attr(periodAttrs, "start")) || 0;
    const periodDuration = duration(attr(periodAttrs, "duration")) || (totalDuration ? Math.max(0, totalDuration - periodStart) : 0);
    const periodHeader = withoutAdaptationSets(periodBody);
    const periodBaseUrl = firstTag(periodHeader, "BaseURL");
    const periodBase = periodBaseUrl ? resolve(periodBaseUrl.body, rootBase) : rootBase;
    const periodTemplate = firstTag(periodHeader, "SegmentTemplate");
    const periodList = firstTag(periodHeader, "SegmentList");
    const adaptations = [...periodBody.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)];
    if (!adaptations.length) fail("DASH_UNSUPPORTED");
    const tracks = [];
    for (const adaptation of adaptations) {
      if (/<(?:[\w.-]+:)?ContentProtection\b/i.test(adaptation[2])) fail("DASH_ENCRYPTED");
      const header = `<AdaptationSet ${adaptation[1]}>` + withoutRepresentations(adaptation[2]);
      const reps = representations(adaptation[2], periodBase, periodTemplate, periodList, header);
      for (const rep of reps) {
        if (!Number.isSafeInteger(rep.bandwidth) || rep.bandwidth < 0) fail("DASH_UNSUPPORTED");
        const mime = rep.mime.toLowerCase();
        const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "";
        if (!kind) continue;
        const track = { ...rep, kind, mime, duration: periodDuration };
        if (rep.template) Object.assign(track, templateSegments(rep.template, rep.base, rep, track.duration));
        else if (rep.list) Object.assign(track, listSegments(rep.list, rep.base, rep));
        if (!track.singleUrl && !track.segments?.length) fail("DASH_UNSUPPORTED");
        tracks.push(track);
      }
    }
    if (!tracks.length) fail("DASH_UNSUPPORTED");
    return { duration: periodDuration, tracks };
  }

  function selectPlan(parsed, quality) {
    const videos = parsed.tracks.filter(track => track.kind === "video").sort((a, b) => b.bandwidth - a.bandwidth);
    const audios = parsed.tracks.filter(track => track.kind === "audio").sort((a, b) => b.bandwidth - a.bandwidth);
    let video = videos[0] || null;
    if (quality && Number.isFinite(quality.bandwidth) && videos.length) {
      const match = videos.find(track => track.bandwidth === quality.bandwidth)
        || videos.find(track => track.height && track.height === quality.height);
      if (!match) fail("DASH_UNSUPPORTED");
      video = match;
    }
    const audio = audios[0] || null;
    if (!video && !audio) fail("DASH_UNSUPPORTED");
    return { duration: parsed.duration, video, audio, videoOnly: !audio, audioOnly: !video,
      extension: "mp4", audioExtension: "m4a" };
  }

  function probe(text, baseUrl) {
    const parsed = parseMpd(text, baseUrl);
    const videos = parsed.tracks.filter(track => track.kind === "video").sort((a, b) => b.bandwidth - a.bandwidth);
    const audio = parsed.tracks.filter(track => track.kind === "audio").sort((a, b) => b.bandwidth - a.bandwidth)[0];
    return {
      kind: "dash", duration: parsed.duration, hasAudio: Boolean(audio),
      variants: videos.map((track, index) => ({
        index, bandwidth: track.bandwidth, width: track.width, height: track.height,
        label: track.height ? `${track.height}p` : `${Math.round(track.bandwidth / 1000)} kbps`
      }))
    };
  }

  const api = { parseMpd, selectPlan, probe, expand, ERROR_CODES: ["DASH_UNSUPPORTED", "DASH_TOO_LARGE", "DASH_ENCRYPTED", "DASH_LIVE"] };
  root.MediaSaverDash = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
