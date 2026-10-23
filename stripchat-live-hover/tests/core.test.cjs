const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("継続再生と待機時間だけ変更し、元の設定と追加設定を保持する", () => {
  const config = Object.freeze({ duration: 60000, visibilityTimeout: 50, requestStreamTimeout: 100, watchEventTimeout: 1000 });
  const adjusted = core.configForHover(config);
  assert.equal(adjusted.duration, null);
  assert.equal(adjusted.visibilityTimeout, 400);
  assert.equal(adjusted.requestStreamTimeout, 100);
  assert.equal(adjusted.watchEventTimeout, 1000);
  assert.equal(config.duration, 60000);
  assert.equal(core.configForHover(config), adjusted);
  assert.notEqual(core.configForHover({ ...config }), adjusted);
});

test("サイトが許可しないプレビューを新たに有効化しない", () => {
  for (const config of [null, undefined, false, 0, "disabled"]) assert.equal(core.configForHover(config), config);
  const config = { isEnabled: false };
  assert.equal(core.configForHover(config).isEnabled, false);
});

test("設定セレクターだけを特定し、配信・視聴制限のセレクターは変更しない", () => {
  assert.equal(core.isConfigSelector(({ featuresConfig: state }) => state.features.liveThumbs), true);
  assert.equal(core.isConfigSelector(({ profile }) => profile.accepted), false);
  assert.equal(core.isConfigSelector(() => "featuresConfig features.liveThumbs"), false);
  assert.equal(core.isConfigSelector(null), false);
});

const link = (id, href) => ({ getAttribute: key => ({ "data-model-id": id, href })[key] });
test("実カードの形式を受け入れる", () => {
  assert.equal(core.cardIdentity(link("123456", "/demo-user_1"), "https://ja.stripchat.com/girls/asian"), "123456:/demo-user_1");
  assert.equal(core.cardIdentity(link("123456", "https://ja.stripchat.com/demo-user_1"), "https://ja.stripchat.com/"), "123456:/demo-user_1");
});

test("外部URL、認証情報、危険なスキーム、パスやIDの不正な形式を拒否する", () => {
  for (const href of ["javascript:alert(1)", "https://evil.test/demo", "//evil.test/demo", "https://ja.stripchat.com.evil.test/demo", "https://user:secret@ja.stripchat.com/demo", "/girls/asian", "/%2e%2e/demo", "/demo?token=private", "/demo#fragment", "/", "x".repeat(2049)]) {
    assert.equal(core.cardIdentity(link("123", href), "https://ja.stripchat.com/"), null);
  }
  for (const id of ["0", "-1", "1.2", "bad", "01", "1".repeat(17)]) {
    assert.equal(core.cardIdentity(link(id, "/demo"), "https://ja.stripchat.com/"), null);
  }
});

test("スクロール後や範囲外のカードは継続しない", () => {
  const rect = { left: 10, top: 20, right: 110, bottom: 80, width: 100, height: 60 };
  assert.equal(core.pointInRect({ x: 30, y: 50 }, rect), true);
  assert.equal(core.pointInRect({ x: 110, y: 50 }, rect), false);
  assert.equal(core.pointInRect({ x: 30, y: 10 }, rect), false);
  assert.equal(core.pointInRect({ x: 30, y: 50 }, { ...rect, width: 0 }), false);
});
