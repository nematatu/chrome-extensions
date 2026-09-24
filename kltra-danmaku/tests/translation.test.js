const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../translation.js"), "utf8");

function managerWith(api) {
  const context = { ...api };
  context.globalThis = context;
  vm.runInNewContext(script, context);
  return context.KltraTranslation.createTranslation();
}

test("取得済みモデルでは英語の投稿を日本語にして表示へ渡す", async () => {
  const translations = [];
  const manager = managerWith({
    Translator: {
      availability: async () => "available",
      create: async ({ sourceLanguage }) => ({
        translate: async (text) => {
          translations.push(`${sourceLanguage}:${text}`);
          return "試合が始まりました";
        },
      }),
    },
    LanguageDetector: {
      availability: async () => "available",
      create: async () => ({ detect: async () => [{ detectedLanguage: "en", confidence: 0.99 }] }),
    },
  });
  manager.updateSettings({ translationEnabled: true, translationSource: "auto" });
  await manager.prepareCached();
  const displayed = await new Promise((resolve) => {
    manager.enqueue("The match has started", () => true, resolve);
  });
  assert.equal(displayed, "試合が始まりました");
  assert.deepEqual(translations, ["en:The match has started"]);
});

test("翻訳中に OFF にした投稿は後から上書きしない", async () => {
  let finish;
  const manager = managerWith({
    Translator: {
      availability: async () => "available",
      create: async () => ({ translate: () => new Promise((resolve) => { finish = resolve; }) }),
    },
  });
  manager.updateSettings({ translationEnabled: true, translationSource: "id" });
  await manager.prepareCached();
  let applied = false;
  manager.enqueue("Pertandingan dimulai", () => true, () => { applied = true; });
  await new Promise((resolve) => setImmediate(resolve));
  manager.updateSettings({ translationEnabled: false, translationSource: "id" });
  finish("試合開始");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied, false);
});

test("初回準備では一操作につき一モデルだけ取得する", async () => {
  const created = [];
  const manager = managerWith({
    Translator: {
      availability: async () => "downloadable",
      create: ({ sourceLanguage }) => {
        created.push(sourceLanguage);
        return Promise.resolve({ translate: async () => "翻訳結果" });
      },
    },
    LanguageDetector: {
      availability: async () => "downloadable",
      create: () => {
        created.push("detector");
        return Promise.resolve({ detect: async () => [{ detectedLanguage: "id", confidence: 1 }] });
      },
    },
  });
  manager.updateSettings({ translationEnabled: true, translationSource: "auto" });
  await manager.prepareCached();
  await manager.prepareFromGesture();
  assert.deepEqual(created, ["id"]);
  assert.equal(manager.getStatus(), "partial");
  await manager.prepareFromGesture();
  assert.deepEqual(created, ["id", "en"]);
  await manager.prepareFromGesture();
  assert.deepEqual(created, ["id", "en", "detector"]);
  assert.equal(manager.getStatus(), "ready");
});

test("言語判定が曖昧な短文は誤訳で上書きしない", async () => {
  let translated = false;
  let applied = false;
  const manager = managerWith({
    Translator: {
      availability: async () => "available",
      create: async () => ({ translate: async () => { translated = true; return "誤訳"; } }),
    },
    LanguageDetector: {
      availability: async () => "available",
      create: async () => ({ detect: async () => [{ detectedLanguage: "en", confidence: 0.55 }] }),
    },
  });
  manager.updateSettings({ translationEnabled: true, translationSource: "auto" });
  await manager.prepareCached();
  manager.enqueue("goal", () => true, () => { applied = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(translated, false);
  assert.equal(applied, false);
});

test("励まし表現の綴り揺れを補正してオンライン翻訳へ渡す", async () => {
  const sent = [];
  const manager = managerWith({ chrome: { runtime: { sendMessage: async (message) => {
    sent.push(message);
    return { ok: true, text: "中国よ、頑張れ！できるよ！" };
  } } } });
  manager.updateSettings({ translationEnabled: true, translationSource: "auto", translationEngine: "online" });
  const translated = await new Promise((resolve) => {
    manager.enqueue("China pless kamu bisa", () => true, resolve);
  });
  assert.equal(translated, "中国よ、頑張れ！できるよ！");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: "TRANSLATE_ONLINE", source: "auto",
    text: "China, semangat! Kamu pasti bisa!" }]);
});

test("オンライン翻訳中に OFF にした投稿は上書きしない", async () => {
  let finish;
  const manager = managerWith({ chrome: { runtime: { sendMessage: () => new Promise((resolve) => { finish = resolve; }) } } });
  manager.updateSettings({ translationEnabled: true, translationSource: "auto", translationEngine: "online" });
  let applied = false;
  manager.enqueue("Pertandingan dimulai", () => true, () => { applied = true; });
  manager.updateSettings({ translationEnabled: false, translationSource: "auto", translationEngine: "online" });
  finish({ ok: true, text: "試合開始" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied, false);
});
