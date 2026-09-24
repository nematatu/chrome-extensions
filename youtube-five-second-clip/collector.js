(() => {
  "use strict";
  const { StreamCache } = globalThis.YouTubeClipStreamCache;
  const sources = new WeakMap();
  const urls = new Map();
  const sourceBuffers = new WeakMap();
  const create = URL.createObjectURL;
  const add = MediaSource.prototype.addSourceBuffer;
  const append = SourceBuffer.prototype.appendBuffer;
  let generation = 0;
  const currentVideo = () => document.querySelector("#movie_player video.html5-main-video, #movie_player video");
  URL.createObjectURL = function (object) {
    const url = Reflect.apply(create, this, [object]);
    if (object instanceof MediaSource) {
      if (!sources.has(object)) sources.set(object, []);
      urls.set(url, object);
      while (urls.size > 8) urls.delete(urls.keys().next().value);
    }
    return url;
  };
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const buffer = Reflect.apply(add, this, [mime]);
    if (/^(video|audio)\/(mp4|webm)\b/i.test(mime)) {
      const entry = { buffer, cache: new StreamCache(mime), generation };
      sourceBuffers.set(buffer, entry);
      if (!sources.has(this)) sources.set(this, []);
      sources.get(this).push(entry);
    }
    return buffer;
  };
  SourceBuffer.prototype.appendBuffer = function (data) {
    const entry = sourceBuffers.get(this);
    // 元のappendBufferが例外になるときは、受理されなかったデータを保存しない。
    const copy = entry && data.byteLength <= 32 * 1024 * 1024 ? new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength).slice() : null;
    const result = Reflect.apply(append, this, [data]);
    if (entry && copy) {
      try {
        if (entry.generation !== generation) { entry.cache = new StreamCache(entry.cache.mime); entry.generation = generation; }
        entry.cache.append(copy, this.timestampOffset, currentVideo()?.currentTime || 0);
      } catch { /* 再生側に拡張の失敗を伝播しない。 */ }
    }
    return result;
  };
  document.addEventListener("yt-navigate-start", () => { generation++; });
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const request = event.data;
    const preview = request?.type === "youtube-clip-preview-read";
    if ((!preview && request?.type !== "youtube-clip-read") || !/^[a-f0-9-]{36}$/.test(request.id || "")) return;
    const reply = value => window.postMessage({ type: preview ? "youtube-clip-preview-data" : "youtube-clip-data", id: request.id, ...value }, location.origin,
      value.tracks?.map(track => track.data.buffer) || []);
    try {
      const video = currentVideo();
      if (!video || video.mediaKeys || document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting")) throw new Error();
      if (new URL(location.href).searchParams.get("v") !== request.videoId || !Number.isFinite(request.start) ||
          !Number.isFinite(request.end) || request.start < 0 || request.end <= request.start || request.end - request.start > 300.001) throw new Error();
      const source = urls.get(video.currentSrc || video.src);
      const entries = (sources.get(source) || []).filter(entry => entry.generation === generation);
      const tracks = [];
      for (const kind of preview ? ["video/"] : ["video/", "audio/"]) {
        const candidates = entries.filter(entry => entry.cache.mime.startsWith(kind));
        let track;
        for (const entry of candidates.reverse()) {
          try { track = entry.cache.snapshot(request.start, request.end); break; } catch {}
        }
        if (!track) throw new Error();
        tracks.push(track);
      }
      reply({ tracks });
    } catch { reply({ error: "必要な映像・音声データがまだありません。タブを再読み込みして、保存したい区間を再生してから押してください。" }); }
  });
})();
