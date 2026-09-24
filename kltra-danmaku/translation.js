(() => {
  const MAX_PENDING = 24;
  const MAX_CACHE = 200;
  const MAX_ONLINE_CONCURRENT = 3;

  function normalizeForOnline(text) {
    const trimmed = text.trim();
    // 配信チャットの「X pless kamu bisa」は依頼ではなく X への応援。
    const cheer = trimmed.match(/^([\p{L}\p{N}][\p{L}\p{N}\s.'-]{0,29}?)\s+(?:pless|pls|plz|please)\s+kamu\s+bisa[!?.\s]*$/iu);
    if (cheer) return `${cheer[1].trim()}, semangat! Kamu pasti bisa!`;
    if (/^(?:pless|pls|plz|please)\s+kamu\s+bisa[!?.\s]*$/iu.test(trimmed)) {
      return "Semangat! Kamu pasti bisa!";
    }
    return trimmed;
  }

  function createTranslation(onStatus) {
    const sessions = new Map();
    const pending = [];
    const cache = new Map();
    let detector;
    let source = "auto";
    let engine = "local";
    let enabled = true;
    let status = "checking";
    let preparation;
    let processing = false;
    let onlineRunning = 0;
    let generation = 0;

    function setStatus(value) {
      status = value;
      onStatus?.(value);
    }

    function primaryLanguage() {
      return source === "en" ? "en" : "id";
    }

    function setOperationalStatus() {
      if (engine === "online") { setStatus(enabled ? "online" : "disabled"); return; }
      if (!enabled) {
        setStatus("disabled");
      } else if (!sessions.has(primaryLanguage())) {
        setStatus("needs-action");
      } else {
        setStatus(source === "auto" && (!detector || !sessions.has("en")) ? "partial" : "ready");
        pump();
      }
    }

    function updateSettings(next) {
      const nextEngine = next.translationEngine === "online" ? "online" : "local";
      const changed = enabled !== next.translationEnabled || source !== next.translationSource || engine !== nextEngine;
      enabled = next.translationEnabled;
      source = next.translationSource;
      engine = nextEngine;
      if (changed) {
        generation++;
        pending.length = 0;
        cache.clear();
      }
      if (enabled) {
        if (engine === "online") {
          setStatus("online");
          pump();
        } else {
          if (sessions.has(primaryLanguage())) setOperationalStatus();
          prepareCached();
        }
      } else {
        setStatus("disabled");
      }
    }

    async function prepareCached() {
      if (engine === "online") { setStatus(enabled ? "online" : "disabled"); return; }
      if (!enabled || preparation) return preparation;
      if (typeof Translator === "undefined") {
        setStatus("unavailable");
        return;
      }
      preparation = (async () => {
        try {
          const primary = primaryLanguage();
          if (!sessions.has(primary)) {
            const availability = await Translator.availability({ sourceLanguage: primary, targetLanguage: "ja" });
            if (availability === "unavailable") { setStatus("unavailable"); return; }
            if (availability !== "available") { setStatus("needs-action"); return; }
            setStatus("loading");
            sessions.set(primary, await Translator.create({ sourceLanguage: primary, targetLanguage: "ja" }));
            setOperationalStatus();
          }
          if (source === "auto") {
            if (!detector && typeof LanguageDetector !== "undefined" &&
                await LanguageDetector.availability() === "available") {
              try { detector = await LanguageDetector.create(); } catch { /* 主言語の翻訳を継続 */ }
            }
            if (!sessions.has("en") && await Translator.availability({ sourceLanguage: "en", targetLanguage: "ja" }) === "available") {
              try { sessions.set("en", await Translator.create({ sourceLanguage: "en", targetLanguage: "ja" })); }
              catch { /* 主言語の翻訳を継続 */ }
            }
          }
          setOperationalStatus();
        } catch {
          if (!enabled || sessions.has(primaryLanguage())) setOperationalStatus();
          else setStatus("error");
        } finally {
          preparation = undefined;
          if (!enabled) setStatus("disabled");
        }
      })();
      return preparation;
    }

    // ダウンロードが必要な create() はユーザー操作の同期処理内で呼ぶ。
    function prepareFromGesture() {
      if (engine === "online") return Promise.resolve(true);
      if (!enabled) {
        setStatus("disabled");
        return Promise.resolve(false);
      }
      if (typeof Translator === "undefined") {
        setStatus("unavailable");
        return Promise.resolve(false);
      }
      if (preparation) return preparation;
      const primary = primaryLanguage();
      let creation;
      let kind;
      try {
        if (!sessions.has(primary)) {
          kind = primary;
          creation = Translator.create({ sourceLanguage: primary, targetLanguage: "ja" });
        } else if (source === "auto" && !sessions.has("en")) {
          kind = "en";
          creation = Translator.create({ sourceLanguage: "en", targetLanguage: "ja" });
        } else if (source === "auto" && !detector && typeof LanguageDetector !== "undefined") {
          kind = "detector";
          creation = LanguageDetector.create();
        } else {
          setOperationalStatus();
          return Promise.resolve(true);
        }
      } catch {
        setStatus("error");
        return Promise.resolve(false);
      }
      setStatus(sessions.has(primary) ? "partial" : "loading");
      preparation = (async () => {
        try {
          const created = await creation;
          if (kind === "detector") detector = created;
          else sessions.set(kind, created);
          setOperationalStatus();
          return true;
        } catch {
          if (sessions.has(primary)) setOperationalStatus();
          else setStatus("error");
          return false;
        } finally {
          preparation = undefined;
          if (!enabled) setStatus("disabled");
        }
      })();
      return preparation;
    }

    async function languageFor(text) {
      if (source !== "auto") return source;
      if (/^[\s\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{P}\p{N}]+$/u.test(text)) return "ja";
      if (!detector) return "id";
      try {
        const [best] = await detector.detect(text);
        const minimumConfidence = text.length < 12 ? 0.9 : 0.65;
        if (best?.confidence >= minimumConfidence && ["id", "en", "ja"].includes(best.detectedLanguage)) {
          return best.detectedLanguage;
        }
      } catch { /* 判定できない投稿は原文のまま流す */ }
      return null;
    }

    function enqueue(text, active, apply) {
      if (!enabled || !/[\p{L}]/u.test(text)) return;
      if (pending.length >= MAX_PENDING) pending.shift();
      pending.push({ text, active, apply, generation });
      pump();
    }

    // 翻訳完了を待ってから表示するための API。失敗時はタイムアウト後に原文を返す。
    function translateText(text) {
      if (!enabled || !text || !/[\p{L}]/u.test(text) ||
          /^[\s\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{P}\p{N}]+$/u.test(text)) {
        return Promise.resolve(text);
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(typeof value === "string" && value.trim() ? value : text);
        };
        const timer = setTimeout(() => finish(text), 3500);
        enqueue(text, () => true, finish);
      });
    }

    function pumpOnline() {
      while (onlineRunning < MAX_ONLINE_CONCURRENT && pending.length && enabled && engine === "online") {
        const job = pending.shift();
        if (job.generation !== generation || !job.active()) continue;
        if (/^[\s\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{P}\p{N}]+$/u.test(job.text)) continue;
        const input = normalizeForOnline(job.text);
        const key = `${source}\u0000${input}`;
        const cached = cache.get(key);
        if (cached) {
          job.apply(cached);
          continue;
        }
        onlineRunning++;
        chrome.runtime.sendMessage({ type: "TRANSLATE_ONLINE", source, text: input })
          .then((reply) => {
            if (!reply?.ok || typeof reply.text !== "string") {
              if (job.generation === generation) setStatus("online-error");
              return;
            }
            cache.set(key, reply.text);
            if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
            if (job.generation === generation && job.active()) {
              job.apply(reply.text);
              setStatus("online");
            }
          })
          .catch(() => { if (job.generation === generation) setStatus("online-error"); })
          .finally(() => { onlineRunning--; pumpOnline(); });
      }
    }

    async function pump() {
      if (engine === "online") { pumpOnline(); return; }
      if (processing || !["ready", "partial"].includes(status)) return;
      processing = true;
      try {
        while (pending.length && ["ready", "partial"].includes(status)) {
          const job = pending.shift();
          if (job.generation !== generation || !job.active()) continue;
          const language = await languageFor(job.text);
          if (language === "ja" || !sessions.has(language)) continue;
          const key = `${language}\u0000${job.text}`;
          let result = cache.get(key);
          if (!result) {
            try {
              result = await sessions.get(language).translate(job.text);
            } catch {
              setStatus("error");
              break;
            }
            if (typeof result !== "string" || !result.trim()) continue;
            cache.set(key, result);
            if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
          }
          if (job.generation === generation && job.active()) job.apply(result);
        }
      } finally {
        processing = false;
      }
    }

    return { updateSettings, prepareCached, prepareFromGesture, enqueue, translateText, getStatus: () => status };
  }

  globalThis.KltraTranslation = { createTranslation, normalizeForOnline };
})();
