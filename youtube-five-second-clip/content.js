(() => {
  "use strict";
  const { ClipError, videoId, selectionRange } = globalThis.YouTubeFiveSecondClip;
  // 拡張更新前に注入された古いUIを除去する。
  document.querySelectorAll("#youtube-five-second-clip").forEach(node => node.remove());
  const host = document.createElement("div");
  host.id = "youtube-five-second-clip";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { display:inline-flex; align-items:center; align-self:center; flex:0 0 auto; margin:0; vertical-align:middle; position:fixed !important; z-index:2147483647 !important; pointer-events:auto; }
    .panel { font:13px/1.5 Roboto,Arial,sans-serif; color:var(--yt-spec-text-primary,#f1f1f1); position:relative; }
    button { box-sizing:border-box; min-height:40px; max-width:180px; font:500 14px/20px Roboto,Arial,sans-serif;
      color:var(--yt-spec-text-primary,#f1f1f1); background:var(--yt-spec-badge-chip-background,#272727);
      border:0; border-radius:20px; padding:0 16px; cursor:pointer; white-space:nowrap; }
    button:hover { background:var(--yt-spec-10-percent-layer,#3f3f3f); }
    button:focus-visible { outline:2px solid #3ea6ff; outline-offset:2px; }
    button:disabled { opacity:.55; cursor:wait; } [hidden] { display:none !important; }
    .editor { position:fixed !important; top:8px; left:8px; width:min(760px,calc(100vw - 24px)); padding:18px; border-radius:10px; background:#212121f2; color:#fff; box-shadow:0 8px 30px #000b; z-index:2147483647; }
    .preview-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px; }
    .preview-card { position:relative; min-width:0; aspect-ratio:16/9; min-height:180px; overflow:hidden; border-radius:7px; background:#111; }
    .preview-card video, .preview-card img, .preview-card canvas { position:absolute; inset:0; width:100%; height:100%; display:block; object-fit:cover; }
    .preview-card canvas { z-index:1; }
    .preview-card::after { content:""; position:absolute; inset:0; background:linear-gradient(transparent 55%,#000b); pointer-events:none; }
    .preview-label { position:absolute; z-index:2; left:9px; right:9px; bottom:7px; display:flex; justify-content:space-between; color:#fff; font-size:12px; text-shadow:0 1px 2px #000; }
    .range-head { display:flex; justify-content:space-between; margin-bottom:10px; font-size:12px; color:#ddd; }
    .range-wrap { position:relative; height:18px; margin:0 10px 2px; }
    .range-track { position:absolute; left:0; right:0; top:6px; height:6px; border-radius:3px; background:#666; }
    .range-selected { position:absolute; top:6px; height:6px; border-radius:3px; background:#3ea6ff; pointer-events:none; }
    .sliders { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:4px 0 10px; }
    .slider-label { display:grid; gap:3px; color:#ddd; font-size:12px; }
    input[type=range] { width:100%; height:28px; margin:0; accent-color:#3ea6ff; cursor:grab; touch-action:none; }
    input[type=range]:active { cursor:grabbing; }
    .preset-row { display:flex; gap:6px; flex-wrap:wrap; margin:4px 0 2px; }
    .preset { min-height:30px; border-radius:15px; padding:0 11px; font-size:12px; background:#3a3a3a; }
    input[type=range]::-webkit-slider-runnable-track { height:4px; background:transparent; }
    input[type=range]:focus-visible::-webkit-slider-thumb { outline:2px solid #fff; outline-offset:2px; }
    .confirm { min-height:32px; border-radius:16px; padding:0 12px; margin-top:6px; background:#3ea6ff; color:#071018; }
    p { position:absolute; top:44px; right:0; width:max-content; max-width:320px; margin:0; padding:8px 10px;
      border-radius:6px; background:#212121f2; color:#fff; overflow-wrap:anywhere; box-shadow:0 2px 8px #0008; }
    .actions { display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap; }
    .clip-button { width:40px; min-width:40px; max-width:40px; padding:0; font-size:0; }
    .clip-button::before { content:"✂"; font-size:20px; line-height:1; }
  `;
  const panel = document.createElement("div");
  panel.className = "panel";
  const actions = document.createElement("div");
  actions.className = "actions";
  const button = document.createElement("button");
  button.className = "clip-button";
  button.type = "button";
  button.textContent = "範囲を指定して保存";
  button.setAttribute("aria-label", "範囲を指定して保存");
  button.title = "開始・終了時刻を指定してMP4として保存します";
  const editor = document.createElement("div");
  editor.className = "editor";
  editor.hidden = true;
  editor.innerHTML = '<div class="preview-grid"><div class="preview-card"><canvas data-role="start-preview" aria-label="開始位置のプレビュー"></canvas><img data-role="thumbnail" alt="動画サムネイル" hidden><div class="preview-label"><span>開始</span><output data-role="start">0:00</output></div></div><div class="preview-card"><canvas data-role="end-preview" aria-label="終了位置のプレビュー"></canvas><img data-role="thumbnail-end" alt="動画サムネイル" hidden><div class="preview-label"><span>終了</span><output data-role="end">0:00</output></div></div></div><div class="range-head"><span>直近20秒から切り出す範囲</span><span>選択 <output data-role="length">5.0秒</output></span></div><div class="range-wrap"><div class="range-track"></div><div class="range-selected"></div></div><div class="sliders"><label class="slider-label">開始位置<input name="start" type="range" min="0" step="0.1" value="0" aria-label="開始時刻"></label><label class="slider-label">終了位置<input name="end" type="range" min="0" step="0.1" value="0" aria-label="終了時刻"></label></div><div class="preset-row"><button class="preset" type="button" data-seconds="5">直前5秒</button><button class="preset" type="button" data-seconds="10">直前10秒</button><button class="preset" type="button" data-seconds="20">直前20秒</button></div>';
  const confirm = document.createElement("button");
  confirm.className = "confirm";
  confirm.type = "button";
  confirm.textContent = "この範囲を保存";
  editor.append(confirm);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  actions.append(button);
  panel.append(actions, editor, status);
  shadow.append(style, panel);
  const deepQuery = (selector, root = document) => {
    const direct = root.querySelector?.(selector);
    if (direct) return direct;
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) { const nested = deepQuery(selector, element.shadowRoot); if (nested) return nested; }
    }
    return null;
  };
  // プレイヤーへのイベント伝播による一時停止やショートカットを防ぐ。
  for (const event of ["click", "dblclick", "keydown", "keyup", "pointerdown"]) {
    host.addEventListener(event, e => e.stopPropagation());
  }
  let submitting = false;
  let lastJob = null;
  const startInput = editor.querySelector('[name="start"]');
  const endInput = editor.querySelector('[name="end"]');
  const startOutput = editor.querySelector('[data-role="start"]');
  const endOutput = editor.querySelector('[data-role="end"]');
  const lengthOutput = editor.querySelector('[data-role="length"]');
  const selected = editor.querySelector('.range-selected');
  const thumbnail = editor.querySelector('[data-role="thumbnail"]');
  const startPreview = editor.querySelector('[data-role="start-preview"]');
  const endPreview = editor.querySelector('[data-role="end-preview"]');
  const startContext = startPreview.getContext("2d");
  const endContext = endPreview.getContext("2d");
  const endThumbnail = editor.querySelector('[data-role="thumbnail-end"]');
  let previewSequence = 0;
  let previewTarget = "both";
  let previewBusy = false;
  let previewQueued = false;
  const previewPlayers = { start: null, end: null };
  const startPreviewPlayer = (side, decoder, url, canvas, context, center) => {
    const old = previewPlayers[side];
    if (old) { old.stopped = true; old.video.pause(); URL.revokeObjectURL(old.url); }
    const player = { video: decoder, url, stopped: false };
    previewPlayers[side] = player;
    const loopStart = Math.max(0, center - .6), loopEnd = Math.min(decoder.duration || center + 1, center + 1);
    const draw = () => {
      if (player.stopped || previewPlayers[side] !== player) return;
      if (!decoder.seeking && (decoder.currentTime >= loopEnd || decoder.ended)) decoder.currentTime = loopStart;
      if (decoder.readyState >= 2) context.drawImage(decoder, 0, 0, canvas.width, canvas.height);
      requestAnimationFrame(draw);
    };
    void decoder.play().catch(() => {}); requestAnimationFrame(draw);
  };
  const capturePreviews = async (video, start, end, sequence, target) => {
    const { id } = current();
    if (!id || !video || !Number.isFinite(video.duration)) return;
    const frames = [["start", start, startPreview, startContext, thumbnail], ["end", end, endPreview, endContext, endThumbnail]];
    for (const [side, time, canvas, context, fallback] of frames) {
      if (target !== "both" && target !== side) continue;
      const from = Math.max(0, time - 2), to = Math.min(video.duration, Math.max(time + 2, from + .2));
      let url = "";
      try {
        const tracks = await readPreviewSnapshot({ id: crypto.randomUUID(), videoId: id, start: from, end: to });
        if (sequence !== previewSequence) return;
        const track = tracks.find(item => item.mime.startsWith("video/"));
        if (!track) continue;
        url = URL.createObjectURL(new Blob([track.data], { type: track.mime }));
        const decoder = document.createElement("video"); decoder.muted = true; decoder.preload = "auto"; decoder.src = url;
        await new Promise((resolve, reject) => { decoder.onloadedmetadata = resolve; decoder.onerror = reject; decoder.load(); });
        await new Promise((resolve, reject) => {
          decoder.onseeked = resolve; decoder.onerror = reject;
          try { decoder.currentTime = Math.max(0, time - track.offset); } catch (error) { reject(error); }
        });
        if (sequence !== previewSequence) { URL.revokeObjectURL(url); return; }
        canvas.width = decoder.videoWidth; canvas.height = decoder.videoHeight;
        context.drawImage(decoder, 0, 0, canvas.width, canvas.height);
        fallback.hidden = true;
        startPreviewPlayer(side, decoder, url, canvas, context, Math.max(0, time - track.offset));
        url = "";
      } catch { fallback.hidden = false; }
      finally { if (url) URL.revokeObjectURL(url); }
    }
  };
  const updatePreviews = () => {
    if (previewBusy) { previewQueued = true; return; }
    const video = current().video;
    const sequence = ++previewSequence;
    const target = previewTarget; previewTarget = "both";
    previewBusy = true;
    void capturePreviews(video, Number(startInput.value), Number(endInput.value), sequence, target)
      .finally(() => { previewBusy = false; if (previewQueued) { previewQueued = false; schedulePreviews(40); } });
  };
  let previewTimer = 0;
  const schedulePreviews = (delay = 300) => {
    if (previewTimer) return;
    previewTimer = setTimeout(() => { previewTimer = 0; updatePreviews(); }, delay);
  };
  const formatTime = seconds => {
    seconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  };
  const updateRangeUi = event => {
    const minimum = Number(startInput.min) || 0;
    const maximum = Number(endInput.max) || minimum + 1;
    const duration = Math.max(.1, maximum - minimum);
    let start = Number(startInput.value), end = Number(endInput.value);
    if (start > end - 1) {
      if (event?.currentTarget === startInput) start = Math.max(minimum, end - 1), startInput.value = start;
      else end = Math.min(maximum, start + 1), endInput.value = end;
    }
    const left = Math.max(0, Math.min(100, (start - minimum) / duration * 100));
    const right = Math.max(left, Math.min(100, (end - minimum) / duration * 100));
    selected.style.left = `${left}%`;
    selected.style.width = `${right - left}%`;
    startOutput.textContent = formatTime(start);
    endOutput.textContent = formatTime(end);
    lengthOutput.textContent = `${Math.max(1, end - start).toFixed(1)}秒`;
    if (event?.currentTarget === startInput) previewTarget = "start";
    else if (event?.currentTarget === endInput) previewTarget = "end";
    schedulePreviews();
  };
  startInput.addEventListener("input", updateRangeUi);
  endInput.addEventListener("input", updateRangeUi);
  for (const preset of editor.querySelectorAll(".preset")) preset.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const video = current().video; const end = Math.max(0.1, video?.currentTime || 0); const seconds = Number(preset.dataset.seconds) || 5;
    endInput.value = String(Math.min(Number(endInput.max) || end, end)); startInput.value = String(Math.max(0, end - seconds)); updateRangeUi(); schedulePreviews(40);
  });
  const show = text => {
    status.hidden = !text;
    if (status.textContent !== text) status.textContent = text;
  };
  const placeEditor = () => {
    if (editor.hidden) return;
    const anchor = host.getBoundingClientRect();
    const width = editor.offsetWidth || 760;
    const height = editor.offsetHeight || 420;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const below = anchor.bottom + 8;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 8);
    editor.style.left = `${left}px`;
    editor.style.top = `${top}px`;
  };
  const isAd = player => player?.classList.contains("ad-showing") || player?.classList.contains("ad-interrupting");
  const current = () => {
    const id = videoId(location.href);
    const player = document.querySelector("#movie_player");
    const video = player?.querySelector("video.html5-main-video") || player?.querySelector("video");
    return { id, player, video };
  };
  function refresh() {
    const { id, player, video } = current();
    if (!id || !player || !video) { host.remove(); return; }
    const actions = deepQuery("#top-level-buttons-computed") || deepQuery('button[aria-label="共有"]');
    // 操作行がまだ生成されていない間は表示しない。
    if (!actions) { host.remove(); return; }
    if (host.parentNode !== document.body) document.body.append(host);
    const rect = actions.getBoundingClientRect();
    host.style.left = `${Math.min(window.innerWidth - 48, rect.right + 8)}px`;
    host.style.top = `${Math.max(0, rect.top + (rect.height - 40) / 2)}px`;
    button.disabled = submitting || isAd(player);
    confirm.disabled = submitting || isAd(player);
    if (!submitting && isAd(player)) show("広告の終了後に保存できます。");
    else if (!submitting && status.textContent === "広告の終了後に保存できます。") show("");
    placeEditor();
  }
  button.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const { id, player, video } = current();
    if (!id || !video || isAd(player)) { show("通常の動画を再生してから押してください。"); return; }
    const now = video.currentTime;
    if (!Number.isFinite(now) || now < 1) { show("1秒以上再生してから範囲を指定してください。"); return; }
    const duration = Number.isFinite(video.duration) ? Math.min(video.duration, 604800) : Math.max(1, now);
    const thumbnailUrl = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    for (const image of [thumbnail, endThumbnail]) {
      image.src = thumbnailUrl;
      image.hidden = !image.complete;
      image.onerror = () => { image.hidden = true; };
    }
    const windowStart = Math.max(0, now - 20);
    startInput.min = endInput.min = String(windowStart);
    startInput.max = endInput.max = String(Math.min(duration, Math.max(windowStart + .1, now)));
    startInput.value = String(Math.max(0, now - 5));
    endInput.value = String(Math.max(0.1, now));
    updateRangeUi();
    editor.hidden = !editor.hidden;
    if (!editor.hidden) { placeEditor(); startInput.focus(); }
  });
  confirm.addEventListener("click", async event => {
    if (!event.isTrusted || submitting) return;
    const { id, player, video } = current();
    if (!id || !video || isAd(player)) { show("通常の動画を再生してから押してください。"); return; }
    let request;
    try {
      const range = selectionRange(video, Number(startInput.value), Number(endInput.value));
      if (video.mediaKeys) throw new ClipError("保護された動画には対応していません。");
      request = { type: "clip", id: crypto.randomUUID(), videoId: id, ...range,
        title: (document.querySelector("ytd-watch-metadata h1")?.textContent || document.title.replace(/ - YouTube$/, "")).slice(0, 500) };
      submitting = true;
      button.disabled = true;
      editor.hidden = true;
      show("指定範囲のデータを準備しています…");
      const tracks = await readSnapshot(request);
      request.tracks = tracks.map(track => ({ mime: track.mime, offset: track.offset, size: track.data.byteLength }));
      const result = await send(request);
      if (!result?.ok) throw new ClipError(result?.error || "保存を開始できませんでした。");
      lastJob = result.id;
      for (let index = 0; index < tracks.length; index++) {
        const data = new Uint8Array(tracks[index].data.buffer || tracks[index].data);
        for (let offset = 0; offset < data.length; offset += 256 * 1024) {
          const bytes = data.subarray(offset, offset + 256 * 1024);
          let binary = "";
          for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
          await send({ type: "chunk", id: request.id, track: index, offset, data: btoa(binary) });
        }
      }
      await send({ type: "finish", id: request.id });
      show("保存を受け付けました。再生やタブを閉じる操作はそのまま行えます。");
    } catch (error) {
      if (request) void chrome.runtime.sendMessage({ type: "abort", id: request.id }).catch(() => {});
      show(error instanceof ClipError ? error.message : "拡張を再読み込みした場合は、このタブも再読み込みしてください。");
    } finally { submitting = false; refresh(); }
  });
  async function updateStatus() {
    if (!lastJob || submitting) return;
    try {
      const result = await chrome.runtime.sendMessage({ type: "list" });
      const job = result?.jobs?.find(item => item.id === lastJob);
      if (job) show(job.message);
      if (job && ["done", "error"].includes(job.state)) lastJob = null;
    } catch { lastJob = null; }
  }
  setInterval(updateStatus, 1500);
  document.addEventListener("yt-navigate-finish", refresh);
  window.addEventListener("scroll", refresh, { passive: true });
  window.addEventListener("resize", refresh);
  function observe() {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; refresh(); });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    refresh();
  }
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });

  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new ClipError(result?.error || "動画データを送れませんでした。");
    return result;
  }
  function readSnapshot(request) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new ClipError("動画データを取得できません。YouTubeタブを再読み込みしてください。"));
      }, 10000);
      const receive = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.type !== "youtube-clip-data" || event.data.id !== request.id) return;
        clearTimeout(timer); window.removeEventListener("message", receive);
        const tracks = event.data.tracks;
        if (!Array.isArray(tracks) || tracks.length !== 2 || tracks.some(track => !track?.data || track.data.byteLength > 65 * 1024 * 1024)) {
          reject(new ClipError("必要な動画データがありません。タブを再読み込みし、保存したい区間を再生してから押してください。")); return;
        }
        resolve(tracks);
      };
      window.addEventListener("message", receive);
      window.postMessage({ type: "youtube-clip-read", id: request.id, videoId: request.videoId, start: request.start, end: request.end }, location.origin);
    });
  }
  function readPreviewSnapshot(request) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new ClipError("プレビューを取得できません。"));
      }, 3000);
      const receive = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.type !== "youtube-clip-preview-data" || event.data.id !== request.id) return;
        clearTimeout(timer); window.removeEventListener("message", receive);
        const tracks = event.data.tracks;
        if (!Array.isArray(tracks) || tracks.length !== 1 || !tracks[0]?.data || tracks[0].data.byteLength > 65 * 1024 * 1024) {
          reject(new ClipError("プレビュー用の映像データがありません。")); return;
        }
        resolve(tracks);
      };
      window.addEventListener("message", receive);
      window.postMessage({ type: "youtube-clip-preview-read", id: request.id, videoId: request.videoId, start: request.start, end: request.end }, location.origin);
    });
  }
})();
