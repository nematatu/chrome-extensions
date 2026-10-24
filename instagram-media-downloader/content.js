(() => {
  "use strict";
  if (document.getElementById("igmd-root")) return;
  const c = globalThis.IGMediaCore;
  const cache = new Map();
  let savedMedia = {}, historyLoaded = false, historyRevision = 0;
  const historyDigests = new Map(), storyCoverage = new Map(), historyLookups = new Set();
  const buttonIcons = new WeakMap();
  const host = document.createElement("div");
  host.id = "igmd-root";
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;z-index:2147483646!important;pointer-events:none!important";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host{color-scheme:dark;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}
    *{box-sizing:border-box;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{font:inherit;cursor:pointer;color:inherit;pointer-events:auto;touch-action:manipulation}
    button:focus-visible{outline:3px solid #fff;outline-offset:3px}button:disabled{cursor:wait;opacity:.65}
    .tools{position:fixed;display:flex;gap:10px;align-items:center;pointer-events:none}
    .round{border:1px solid #ffffff59;border-radius:50%;width:38px;height:38px;display:grid;place-items:center;background:linear-gradient(145deg,#d62470 15%,#d9234f 60%,#ff843a);box-shadow:0 2px 9px #0007,inset 0 1px 1px #ffffff30;transition:filter .15s,transform .15s}
    .round:hover{filter:brightness(1.18);transform:translateY(-1px)}svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
    .bulk{position:fixed;border:1px solid #ffffff30;border-radius:24px;padding:9px 14px;background:#181818e8;box-shadow:0 3px 15px #0004;display:flex;gap:8px;align-items:center;font-size:12px;font-weight:600;backdrop-filter:blur(12px)}
    .round.saved{background:linear-gradient(145deg,#148863,#116b60);border-color:#85e4ba}
    .bulk.saved{background:#125341f2;border-color:#85e4ba88}.bulk.saved:hover{background:#196f55}
    .bulk:hover{background:#333}.bulk svg{width:17px;height:17px}
    .panel{position:fixed;right:24px;bottom:24px;width:326px;max-width:calc(100vw - 32px);padding:18px 20px;border:1px solid #ffffff20;border-radius:17px;background:#1a1a1af5;box-shadow:0 6px 30px #0006;pointer-events:auto;backdrop-filter:blur(18px)}
    .row{display:flex;align-items:center;gap:8px}.message{flex:1;font-weight:650;font-size:13px;line-height:1.6;overflow-wrap:anywhere}.quiet{border:0;border-radius:50%;width:29px;height:29px;background:#ffffff12;display:grid;place-items:center;color:#bbb;font-size:17px}.quiet:hover{background:#ffffff25;color:#fff}.quiet svg{width:14px;height:14px}
    .track{height:5px;background:#ffffff17;border-radius:8px;overflow:hidden;margin-top:15px}.fill{height:100%;width:0;background:linear-gradient(90deg,#3296ff,#47d4ef);transition:width .2s}.detail{color:#aaa;font-size:11px;line-height:1.6;margin-top:8px}.hidden{display:none!important}
    @media(max-width:600px){.panel{right:16px;bottom:72px}.round{width:34px;height:34px}}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  `;
  shadow.append(style);
  const downloadIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/></svg>';
  const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  const bulkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V3h13M7 7h14v14H7zM14 10v8m-3-3 3 3 3-3"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>';
  function button(label, icon, className, callback) {
    const el = document.createElement("button");
    el.type = "button"; el.className = className; el.title = label; el.setAttribute("aria-label", label);
    el.innerHTML = icon;
    if (el.classList.contains("round") || el.classList.contains("bulk")) el.disabled = preparing;
    el.dataset.label = label; buttonIcons.set(el, icon);
    el.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      Promise.resolve().then(callback).catch(error => show("操作できませんでした", error.message));
    });
    return el;
  }
  const panel = document.createElement("section");
  panel.className = "panel hidden";
  panel.setAttribute("aria-label", "ダウンロードの進捗");
  panel.innerHTML = '<div class="row"><div class="message" role="status" aria-live="polite"></div></div><div class="track" role="progressbar" aria-label="保存済み件数" aria-valuemin="0"><div class="fill"></div></div><div class="detail"></div>';
  const message = panel.querySelector(".message");
  const detail = panel.querySelector(".detail");
  let activeJob = null, preparing = false, preparation = null, lastURL = location.href, frame = 0, refreshTimer;
  const pause = button("次の保存を一時停止", pauseIcon, "quiet", async () => {
    if (activeJob) await command("ig-download-pause", { id: activeJob.id });
  });
  const close = button("ダウンロードを中止", "×", "quiet", async () => {
    if (preparing) { preparation.controller.abort(); show("取得を中止しました"); }
    else if (activeJob && (activeJob.pending || activeJob.active)) await command("ig-download-cancel", { id: activeJob.id });
    else panel.classList.add("hidden");
  });
  panel.querySelector(".row").append(pause, close); shadow.append(panel);
  document.documentElement.append(host);
  function show(text, extra = "") {
    panel.classList.remove("hidden"); message.textContent = text; detail.textContent = extra;
    pause.classList.add("hidden");
  }
  function progress(job) {
    if (activeJob && activeJob.id !== job.id && (activeJob.active || activeJob.pending)) return;
    activeJob = job;
    const finished = !job.active && !job.pending;
    let text = job.canceled ? `中止しました · 保存済み ${job.complete}/${job.total}` :
      finished ? (job.failed ? `保存 ${job.complete}/${job.total} · 失敗 ${job.failed}件` : `ダウンロード完了 ${job.complete}/${job.total}`) :
      job.paused ? `一時停止中 ${job.complete}/${job.total}` : `ダウンロード中 ${job.complete}/${job.total}`;
    show(text, job.failed ? job.error : job.historyError || (job.paused ? "開始済みのファイルは保存を続けます。" : ""));
    pause.classList.toggle("hidden", finished || job.canceled);
    pause.title = job.paused ? "保存を再開" : "次の保存を一時停止";
    pause.setAttribute("aria-label", pause.title); pause.innerHTML = job.paused ? "▶" : pauseIcon;
    close.title = finished || job.canceled ? "進捗を閉じる" : "ダウンロードを中止"; close.setAttribute("aria-label", close.title);
    panel.querySelector(".fill").style.width = `${(job.complete + job.failed) / job.total * 100}%`;
    const track = panel.querySelector(".track");
    track.setAttribute("aria-valuemax", String(job.total)); track.setAttribute("aria-valuenow", String(job.complete));
  }
  async function command(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw new Error(response?.error || "拡張機能を再読み込みしてください。");
    if (response.jobs?.length) progress(response.jobs.at(-1));
    return response;
  }
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "ig-download-history-changed") { void refreshHistory(); }
    if (msg?.type === "ig-download-progress" && msg.job) progress(msg.job);
    if (msg?.type === "ig-download-page") { void start({ kind: "page" }); }
  });
  function remember(groups) {
    if (!Array.isArray(groups)) return;
    for (const group of groups.slice(0, 200)) {
      if (!group || !/^\d{1,30}$/.test(group.id) || !Array.isArray(group.media) || group.media.length > c.MAX_BATCH) continue;
      const media = group.media.filter(m => c.mediaURL(m?.url) && ["image", "video"].includes(m.kind));
      if (!media.length) continue;
      const value = { id: group.id, code: /^[A-Za-z0-9_-]{1,80}$/.test(group.code) ? group.code : "",
        username: c.safePart(group.username), ownerId: /^\d+$/.test(group.ownerId) ? group.ownerId : "", cachedAt: Date.now(),
        complete: group.complete === true && media.length === group.media.length,
        media: media.map((m, index) => ({ id: String(m.id), index, kind: m.kind, url: c.mediaURL(m.url), preview: c.mediaURL(m.preview) })) };
      const previous = cache.get(value.id) || cache.get(value.code);
      // A carousel's cover carries the parent ID, not an individual slide ID.
      const coverOnly = value.media.length === 1 && c.groupKey({ id: value.media[0].id }) === c.groupKey(value) &&
        previous?.media.length > 1 && previous.id === value.id;
      if (previous?.complete && coverOnly) continue;
      cache.set(value.id, value);
      if (value.code) cache.set(value.code, value);
    }
    while (cache.size > 400) cache.delete(cache.keys().next().value);
    schedule();
  }
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.source === "ig-media-downloader") remember(event.data.groups);
  });
  const parsed = new WeakSet();
  function embedded() {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (parsed.has(script)) continue;
      parsed.add(script);
      if (script.textContent.length > 12 * 1024 * 1024) continue;
      try { remember(c.groups(JSON.parse(script.textContent))); } catch {}
    }
  }
  const client = globalThis.IGMediaAPI.create({
    fetch: (...args) => fetch(...args),
    session: () => globalThis.IGMediaAPI.sessionFromPage(
      [...document.querySelectorAll('script')].filter(s => s.textContent.length < 12 * 1024 * 1024).map(s => s.textContent),
      document.cookie, document.querySelector('input[name="fb_dtsg"]')?.value || ""),
    onData: data => remember(c.groups(data)),
    signal: () => preparation?.controller.signal,
  });
  function codeFromURL(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return "";
      return url.pathname.match(/^\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]{1,80})\/?$/)?.[1] || "";
    } catch { return ""; }
  }
  function scopeCode(el) {
    const direct = el.closest('a[href]');
    const code = direct && codeFromURL(direct.href);
    if (code) return code;
    const article = el.closest('article,[role="dialog"]');
    if (article) {
      for (const anchor of article.querySelectorAll('a[href]')) {
        const found = codeFromURL(anchor.href); if (found) return found;
      }
    }
    return codeFromURL(location.href);
  }
  async function post(code) {
    if (!code) throw new Error("投稿の識別情報がありません。投稿を開いて保存してください。");
    const known = cache.get(code);
    if (!activeJob?.failed && known?.complete && Date.now() - known.cachedAt < 60000) return known;
    await client.post(code);
    const group = cache.get(code) || (code.length <= 20 ? cache.get(c.shortcodeID(code)) : null);
    if (!group?.complete) throw new Error("投稿の全メディアを取得できませんでした。部分的な一括保存は行いません。");
    return group;
  }
  function storyRoute() {
    const match = location.pathname.match(/^\/stories\/([A-Za-z0-9_.]+)\/(\d+)?/);
    return match ? { username: match[1], id: match[2] || "" } : null;
  }
  async function stories(route) {
    const known = [...cache.values()].find(g => g.username === route.username && g.ownerId);
    const reel = await client.stories(route, known?.ownerId);
    const all = reel.items.map((node, index) => {
      const media = c.item(node, index);
      if (!media) throw new Error("取得できないストーリーがあります。一括保存を中断しました。");
      return { id: String(node.pk || node.id).split("_")[0], code: "", username: route.username, media: [{ ...media, index: 0 }], complete: true };
    });
    storyCoverage.set(route.username === "highlights" ? `highlights:${route.id}` : route.username, { groups: all, at: Date.now() });
    remember(all); return all;
  }
  function domMedia(el) {
    const video = el.tagName === "VIDEO";
    let url = c.mediaURL(el.currentSrc || el.src);
    if (!video && el.srcset) {
      const candidates = el.srcset.split(",").map(s => { const [url, width] = s.trim().split(/\s+/); return { url, width: parseFloat(width) || 1 }; });
      url = c.best(candidates)?.url || url;
    }
    if (!url) return null;
    return { id: "visible", kind: video ? "video" : "image", url, index: 0 };
  }
  function fallbackMedia(el) {
    if (el.tagName === "IMG" && (!el.closest("article") ||
        el.closest("article").querySelector("video") || /^\/(?:reel|reels)\//.test(location.pathname) ||
        /\/(?:reel|reels)\//.test(el.closest("a[href]")?.pathname || ""))) return null;
    return domMedia(el);
  }
  function checkPreparation(request) {
    if (preparation?.controller.signal.aborted) throw new Error("取得を中止しました。");
    if (request.pageURL !== location.href) throw new Error("画面が切り替わったため保存を中断しました。");
    if (request.kind === "single" && request.source !== (request.el.currentSrc || request.el.src || request.el.poster || "")) {
      throw new Error("メディアが切り替わったため保存を中断しました。現在のボタンから再実行してください。");
    }
  }
  function matchMedia(group, el) {
    const identities = [el.currentSrc, el.src, el.poster].map(c.identity).filter(Boolean);
    return group.media.find(m => identities.includes(c.identity(m.url)) || identities.includes(c.identity(m.preview)));
  }
  function loadedCodes() {
    const codes = new Set();
    const current = codeFromURL(location.href); if (current) codes.add(current);
    for (const a of document.querySelectorAll('main a[href],article a[href],[role="dialog"] a[href]')) {
      const code = codeFromURL(a.href); if (code) codes.add(code);
    }
    return [...codes];
  }
  async function resolve(request) {
    embedded();
    if (request.kind === "page") {
      const codes = loadedCodes();
      if (!codes.length) throw new Error("投稿がありません。投稿またはプロフィールを開いてください。");
      if (codes.length > 100) throw new Error("投稿は一度に100件までです。ページを開き直して対象を絞ってください。");
      const result = [];
      for (const [index, code] of codes.entries()) {
        checkPreparation(request);
        show(`投稿を確認中 ${index + 1}/${codes.length}`, "取得が完了してから保存を開始します。");
        result.push(await post(code));
        if (result.reduce((sum, group) => sum + group.media.length, 0) > c.MAX_BATCH) throw new Error("一括保存は500ファイルまでです。");
      }
      return result;
    }
    const el = request.el;
    if (!el?.isConnected || request.pageURL !== location.href) throw new Error("画面が切り替わりました。現在のメディアのボタンを押してください。");
    const route = storyRoute();
    if (route) {
      const known = cache.get(route.id);
      if (!activeJob?.failed && request.kind === "single" && known?.complete && Date.now() - known.cachedAt < 60000) return [known];
      const all = await stories(route);
      if (request.kind === "all") return all;
      const group = (route.username !== "highlights" && all.find(g => g.id === route.id)) || all.find(g => matchMedia(g, el));
      if (group) return [group];
      const media = fallbackMedia(el);
      if (media) return [{ id: route.id || String(Date.now()), username: route.username, media: [media] }];
      throw new Error("現在のストーリーを特定できません。表示が落ち着いてから再実行してください。");
    }
    const code = scopeCode(el);
    let group;
    try { group = await post(code); }
    catch (error) {
      checkPreparation(request);
      if (request.kind !== "single") throw error;
      const media = fallbackMedia(el);
      if (!media) throw error;
      return [{ id: code || String(Date.now()), username: "instagram", media: [media] }];
    }
    if (request.kind === "all") return [group];
    const media = matchMedia(group, el) || (group.media.length === 1 ? group.media[0] : null);
    if (media) return [{ ...group, media: [media], historyGroup: group }];
    const visible = fallbackMedia(el);
    if (!visible) throw new Error("現在の動画を特定できません。投稿を開き直してください。");
    return [{ ...group, media: [visible], complete: false }];
  }
  async function start(request) {
    if (preparing) return;
    if (activeJob && !activeJob.canceled && (activeJob.pending || activeJob.active)) {
      progress(activeJob); return;
    }
    preparing = true;
    for (const el of shadow.querySelectorAll(".round,.bulk")) el.disabled = true;
    preparation = { controller: new AbortController(), pageURL: location.href };
    const operation = preparation;
    request = { ...request, pageURL: location.href, source: request.el?.currentSrc || request.el?.src || request.el?.poster || "" };
    show("メディアを確認中…");
    panel.querySelector(".fill").style.width = "0%";
    close.title = "取得を中止"; close.setAttribute("aria-label", close.title);
    try {
      const groups = await resolve(request);
      checkPreparation(request);
      const bySource = new Map(), completeGroups = [];
      for (const group of groups) {
        for (const media of group.media) {
          let outputGroup = group;
          if (media.id === "visible") {
            const sourceKey = await c.urlHistoryKey(media.url, media.kind);
            if (!sourceKey) throw new Error("保存するメディアを特定できませんでした。");
            outputGroup = { ...group, code: `${(group.code || group.id).slice(0, 30)}_visible_${sourceKey.slice(2, 34)}` };
          }
          const historyKeys = await c.historyKeys(outputGroup, media);
          const key = c.identity(media.url);
          const existing = bySource.get(key);
          if (existing) existing.historyKeys = [...new Set([...existing.historyKeys, ...historyKeys])];
          else bySource.set(key, { url: media.url, filename: c.filename(outputGroup, media), historyKeys });
        }
        const coverage = group.historyGroup || group;
        if (coverage.complete && c.groupKey(coverage)) {
          const allMembers = await Promise.all(coverage.media.map(media => c.mediaKey(coverage, media) || c.filenameHistoryKey(c.filename(coverage, media))));
          completeGroups.push({ key: c.groupKey(coverage), members: allMembers, aliases: coverage.code ? [await c.postHistoryKey(coverage.code)] : [] });
        }
      }
      const items = [...bySource.values()];
      checkPreparation(request);
      const response = await command("ig-download-start", { items, completeGroups });
      if ((operation.controller.signal.aborted || request.pageURL !== location.href) && response.jobs?.length) {
        await command("ig-download-cancel", { id: response.jobs.at(-1).id });
      }
    } catch (error) {
      show("ダウンロードできませんでした", error.message || "拡張機能とInstagramのタブを再読み込みしてください。");
    } finally {
      preparing = false; preparation = null;
      for (const el of shadow.querySelectorAll(".round,.bulk")) el.disabled = false;
      if (!activeJob?.active && !activeJob?.pending) { close.title = "進捗を閉じる"; close.setAttribute("aria-label", close.title); }
    }
  }
  function digestKey(value, create) {
    const known = historyDigests.get(value);
    if (typeof known === "string") return known;
    if (!historyDigests.has(value)) {
      historyDigests.set(value, null);
      create().then(key => { historyDigests.set(value, key || ""); schedule(); }).catch(() => historyDigests.delete(value));
    }
    return null;
  }
  function urlSaved(value, kind) {
    const path = c.identity(value);
    if (!path) return false;
    const key = digestKey(`${kind}:${path}`, () => c.urlHistoryKey(value, kind));
    return !!(key && savedMedia[key]);
  }
  function mediaSaved(group, media, coverage = false) {
    const key = c.mediaKey(group, media);
    if (key && savedMedia[key]) return true;
    const name = c.filename(group, media), fileKey = digestKey(`file:${name}`, () => c.filenameHistoryKey(name));
    const fileSaved = !!(fileKey && savedMedia[fileKey]);
    if (key || coverage) return fileSaved;
    return fileSaved || urlSaved(media.url, media.kind) || (media.kind === "image" && urlSaved(media.preview, "image"));
  }
  function codeSaved(code) {
    if (!code) return false;
    const key = digestKey(`post:${code}`, () => c.postHistoryKey(code));
    return !!(key && savedMedia[key]);
  }
  function groupSaved(group) {
    if (!group) return false;
    const key = c.groupKey(group);
    return !!(key && savedMedia[key]) || !!(group.complete && group.media.length && group.media.every(media => mediaSaved(group, media, true)));
  }
  function savedButton(el, saved) {
    if (el.dataset.saved === String(saved)) return;
    el.dataset.saved = String(saved); el.classList.toggle("saved", saved);
    const label = el.dataset.label;
    el.title = saved ? `保存済み · ${label}（再保存）` : label;
    el.setAttribute("aria-label", label);
    el.setAttribute("aria-description", saved ? "保存済みです。もう一度押すと再保存します。" : "");
    const text = el.querySelector("span");
    el.innerHTML = saved ? checkIcon : buttonIcons.get(el);
    if (text) el.append(text);
  }
  function updateSaved(el, entry, route) {
    const group = route ? cache.get(route.id) || [...new Set(cache.values())].find(g => g.username === route.username && matchMedia(g, el)) : cache.get(scopeCode(el));
    const media = group && (matchMedia(group, el) || (group.media.length === 1 ? group.media[0] : null));
    const buttons = entry.tools.querySelectorAll("button");
    const allSaved = groupSaved(group) || (!route && codeSaved(scopeCode(el)));
    const saved = entry.tools.dataset.mode === "profile" ? allSaved :
      media ? mediaSaved(group, media) : urlSaved(el.currentSrc || el.src, el.tagName === "VIDEO" ? "video" : "image");
    savedButton(buttons[0], saved);
    savedButton(entry.bulk, allSaved);
    if (route && buttons[1]) {
      const coverage = storyCoverage.get(route.username === "highlights" ? `highlights:${route.id}` : route.username);
      savedButton(buttons[1], !!(coverage?.groups.length && coverage.groups.every(groupSaved)));
    }
    if (historyLoaded && entry.tools.dataset.mode === "profile" && group && !group.complete && media && mediaSaved(group, media)) {
      const code = scopeCode(el), lookup = `post:${code}`;
      if (!historyLookups.has(lookup)) {
        historyLookups.add(lookup); void post(code).then(schedule).catch(() => {});
      }
    }
  }
  function loadStoryHistory() {
    const route = storyRoute();
    if (!route || !historyLoaded || preparing || !Object.keys(savedMedia).length) return;
    const scope = route.username === "highlights" ? `highlights:${route.id}` : route.username;
    const coverage = storyCoverage.get(scope);
    if (coverage && Date.now() - coverage.at < 60000 && (!route.id || coverage.groups.some(g => g.id === route.id))) return;
    const lookup = `story:${scope}:${route.id}`;
    if (historyLookups.has(lookup)) return;
    historyLookups.add(lookup); void stories(route).then(schedule).catch(() => {});
  }
  function readSaved(value) {
    savedMedia = Object.fromEntries(Object.entries(value || {}).filter(([key, at]) => c.validHistoryKey(key) && Number.isFinite(at) && at > 0));
    historyLoaded = true; schedule(); loadStoryHistory();
  }
  async function refreshHistory() {
    const revision = ++historyRevision;
    try {
      const result = await command("ig-download-history");
      if (revision === historyRevision) readSaved(result.savedMedia);
    } catch {}
  }
  void refreshHistory();
  const entries = new Map();
  function clippedRect(el) {
    const box = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    if (box.width < 140 || box.height < 140 || ![box.left, box.top, box.width, box.height].every(Number.isFinite) ||
        computed.visibility !== "visible" || computed.display === "none" || Number(computed.opacity) === 0 || el.closest('[aria-hidden="true"]')) return null;
    const sx = box.width / (el.offsetWidth || box.width), sy = box.height / (el.offsetHeight || box.height);
    const leftInset = (parseFloat(computed.borderLeftWidth) + parseFloat(computed.paddingLeft)) * sx;
    const topInset = (parseFloat(computed.borderTopWidth) + parseFloat(computed.paddingTop)) * sy;
    const contentBox = { left: box.left + leftInset, top: box.top + topInset,
      width: box.width - leftInset - (parseFloat(computed.borderRightWidth) + parseFloat(computed.paddingRight)) * sx,
      height: box.height - topInset - (parseFloat(computed.borderBottomWidth) + parseFloat(computed.paddingBottom)) * sy };
    const rect = c.drawnRect(contentBox, el.naturalWidth || el.videoWidth, el.naturalHeight || el.videoHeight, computed.objectFit, computed.objectPosition);
    if (![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return null;
    for (let parent = el.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0) return null;
      if (/(hidden|clip|auto|scroll)/.test(css.overflowX + css.overflowY)) {
        const clip = parent.getBoundingClientRect();
        if (css.overflowX !== "visible") { rect.left = Math.max(rect.left, clip.left); rect.right = Math.min(rect.right, clip.right); }
        if (css.overflowY !== "visible") { rect.top = Math.max(rect.top, clip.top); rect.bottom = Math.min(rect.bottom, clip.bottom); }
      }
    }
    rect.left = Math.max(0, rect.left); rect.top = Math.max(0, rect.top);
    rect.right = Math.min(innerWidth, rect.right); rect.bottom = Math.min(innerHeight, rect.bottom);
    if (rect.right - rect.left < 140 || rect.bottom - rect.top < 140) return null;
    return rect;
  }
  function layout() {
    frame = 0;
    const story = storyRoute();
    const candidates = [];
    for (const [el, entry] of entries) {
      const rect = el.isConnected ? clippedRect(el) : null;
      entry.tools.classList.add("hidden"); entry.bulk.classList.add("hidden");
      if (!rect) continue;
      candidates.push({ el, entry, rect });
    }
    if (story) candidates.sort((a, b) => Math.abs((a.rect.left + a.rect.right) / 2 - innerWidth / 2) - Math.abs((b.rect.left + b.rect.right) / 2 - innerWidth / 2));
    const occupied = [];
    for (const { el, entry, rect } of story ? candidates.slice(0, 1) : candidates) {
      const left = rect.right - (story ? 94 : 48), top = rect.top + (story ? 64 : 10);
      if (top + 38 > rect.bottom - 8 || occupied.some(r => Math.abs(r.left - left) < 50 && Math.abs(r.top - top) < 45)) continue;
      const hit = document.elementFromPoint((rect.left + rect.right) / 2, Math.min(rect.bottom - 4, rect.top + (rect.bottom - rect.top) / 2));
      if (hit && hit !== el && !hit.contains(el) && !el.parentElement?.contains(hit)) {
        // Instagram places a transparent interaction layer beside the image wrapper.
        const imageBox = el.getBoundingClientRect();
        let common = el.parentElement;
        while (common && !common.matches("main,article,body,[role=dialog]") && !common.contains(hit)) common = common.parentElement;
        const commonBox = common?.getBoundingClientRect();
        const mediaOverlay = common && !common.matches("main,article,body,[role=dialog]") && common.contains(hit) &&
          ["left", "top", "right", "bottom"].every(edge => Math.abs(imageBox[edge] - commonBox[edge]) < 2);
        if (!mediaOverlay) continue;
      }
      updateSaved(el, entry, story);
      occupied.push({ left, top });
      entry.tools.style.left = `${left}px`; entry.tools.style.top = `${top}px`; entry.tools.classList.remove("hidden");
      if (!story && entry.tools.dataset.mode !== "profile" && scopeCode(el)) {
        entry.bulk.style.left = `${Math.max(rect.left + 8, rect.right - 148)}px`;
        entry.bulk.style.top = `${rect.bottom - 43}px`;
        entry.bulk.classList.remove("hidden");
      }
    }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
  const resize = new ResizeObserver(schedule);
  function refresh() {
    embedded();
    for (const [el, entry] of entries) if (!el.isConnected) {
      resize.unobserve(el); entry.tools.remove(); entry.bulk.remove(); entries.delete(el);
    }
    const story = storyRoute();
    const profile = !story && /^\/[A-Za-z0-9_.]+\/(?:reels\/|tagged\/)?$/.test(location.pathname) &&
      !/^\/(?:explore|direct|accounts|stories|reels|reel|p)\//.test(location.pathname);
    const selector = story ? 'img,video' : 'article img,article video,main img,main video,[role="dialog"] img,[role="dialog"] video' +
      (/^\/reels?\//.test(location.pathname) ? ',video' : '');
    for (const el of document.querySelectorAll(selector)) {
      if (entries.has(el) || el.closest("header,nav,aside") || /profile picture|プロフィール写真/i.test(el.alt || "")) continue;
      if (!story && !scopeCode(el) && !el.closest("article")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 140) continue;
      const tools = document.createElement("div"); tools.className = "tools hidden";
      const request = kind => start({ kind, el, pageURL: location.href });
      const profilePost = profile && !!el.closest("a[href]") && !el.closest('article,[role="dialog"]');
      tools.dataset.mode = profilePost ? "profile" : story ? "story" : "post";
      tools.append(button(story ? "このストーリーを保存" : profilePost ? "この投稿の全画像・動画を保存" : "この画像・動画を保存",
        profilePost ? bulkIcon : downloadIcon, "round", () => request(profilePost ? "all" : "single")));
      if (story) tools.append(button("このアカウントのストーリーを一括保存", bulkIcon, "round", () => request("all")));
      const bulk = button("この投稿の全画像・動画を保存", bulkIcon, "bulk hidden", () => request("all"));
      const label = document.createElement("span"); label.textContent = "投稿を一括保存"; bulk.append(label);
      shadow.append(tools, bulk); entries.set(el, { tools, bulk }); resize.observe(el);
    }
    schedule(); loadStoryHistory();
  }
  const observer = new MutationObserver(() => {
    schedule(); clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["src", "srcset", "poster", "style", "class", "aria-hidden"] });
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  document.addEventListener("load", refresh, true);
  document.addEventListener("loadedmetadata", refresh, true);
  setInterval(() => {
    if (lastURL !== location.href) {
      if (preparation && preparation.pageURL !== location.href) preparation.controller.abort();
      lastURL = location.href;
      for (const entry of entries.values()) { entry.tools.remove(); entry.bulk.remove(); }
      entries.clear(); resize.disconnect(); refresh();
    } else schedule();
  }, 500);
  refresh();
  command("ig-download-status").catch(() => {});
})();
