(() => {
  "use strict";

  class ClipError extends Error {}

  function videoId(url) {
    try {
      const parsed = new URL(url);
      const id = parsed.searchParams.get("v");
      return parsed.origin === "https://www.youtube.com" && parsed.pathname === "/watch" &&
        /^[\w-]{11}$/.test(id || "") ? id : null;
    } catch { return null; }
  }

  function clipRange(video) {
    const end = video.currentTime;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new ClipError("ライブ配信または読み込み前の動画には対応していません。");
    }
    if (!Number.isFinite(end) || end <= 0.05 || end > video.duration + 0.1) {
      throw new ClipError("動画を少し再生してから押してください。");
    }
    return { start: Math.max(0, end - 5), end };
  }

  function selectionRange(video, start, end) {
    if (!Number.isFinite(video?.duration) || video.duration <= 0 ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 300 ||
        end > video.duration + 0.1) {
      throw new ClipError("開始・終了時刻を確認してください（最大5分）。");
    }
    return { start, end };
  }

  function filename(title, id, range) {
    const safe = String(title).normalize("NFKC")
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, "_")
      .replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "");
    const name = Array.from(safe).slice(0, 40).join("") || "video";
    const key = /^[\w-]{11}$/.test(id || "") ? id : "video";
    return `YouTube_${name}_${key}_${range.start.toFixed(2)}-${range.end.toFixed(2)}s.mp4`;
  }

  function validateRequest(value) {
    if (!value || !/^[a-f0-9-]{36}$/.test(value.id || "") || !/^[\w-]{11}$/.test(value.videoId || "")) {
      throw new ClipError("無効な動画リクエストです。");
    }
    const { start, end } = value;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 604800 ||
        end <= start || end - start > 300.001) {
      throw new ClipError("保存する時間範囲が無効です。");
    }
    return { id: value.id, videoId: value.videoId, start, end,
      filename: filename(typeof value.title === "string" ? value.title.slice(0, 500) : "video", value.videoId, { start, end }) };
  }

  const api = { ClipError, videoId, clipRange, selectionRange, filename, validateRequest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.YouTubeFiveSecondClip = api;
})();
