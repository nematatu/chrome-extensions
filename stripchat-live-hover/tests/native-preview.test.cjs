const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

function context(initialChunks) {
  const attributes = {};
  const sandbox = vm.createContext({
    document: { documentElement: { setAttribute: (key, value) => { attributes[key] = value; } }, addEventListener() {} },
    __LOADABLE_LOADED_CHUNKS__: initialChunks
  });
  for (const file of ["core.js", "native-preview.js"]) vm.runInContext(fs.readFileSync(require.resolve("../" + file), "utf8"), sandbox);
  sandbox.attributes = attributes;
  return sandbox;
}

function installRuntime(sandbox) {
  vm.runInContext(`
    var factories = {};
    var cache = {};
    function nativeRequire(id) {
      if (!cache[id]) {
        var module = { exports: {} };
        cache[id] = module;
        factories[id](module, module.exports, nativeRequire);
      }
      return cache[id].exports;
    }
    nativeRequire.d = (exports, getters) => {
      for (var name of Object.keys(getters)) Object.defineProperty(exports, name, { enumerable: true, get: getters[name] });
    };
    nativeRequire.marker = 'preserved';
    var chunks = __LOADABLE_LOADED_CHUNKS__;
    for (var chunk of chunks) Object.assign(factories, chunk[1]);
    var parentPush = chunks.push.bind(chunks);
    chunks.push = function (chunk) {
      Object.assign(factories, chunk[1]);
      return parentPush(chunk);
    };
  `, sandbox);
}

const addFeatures = `
  __LOADABLE_LOADED_CHUNKS__.push([["features"], { features: function (module, exports, req) {
    const config = ({featuresConfig: state}) => state.features.liveThumbs;
    const allowed = state => state.consent && state.status === "public";
    req.d(exports, { config: () => config, allowed: () => allowed, marker: () => req.marker });
  }}]);
`;

test("起動後と遅延ロードの双方でネイティブ設定を変更し、ランタイムのpushが再帰しない", () => {
  for (const early of [true, false]) {
    const sandbox = context();
    if (early) vm.runInContext(addFeatures, sandbox);
    installRuntime(sandbox);
    if (!early) vm.runInContext(addFeatures, sandbox);
    const result = vm.runInContext(`
      var features = nativeRequire('features');
      var state = { featuresConfig: { features: { liveThumbs: { duration: 60000, visibilityTimeout: 50, custom: 123 } } } };
      ({ selector: features.config, sameSelector: features.config === features.config,
        config: features.config(state), sameConfig: features.config(state) === features.config(state),
        originalDuration: state.featuresConfig.features.liveThumbs.duration,
        marker: features.marker, permitted: features.allowed({ consent: true, status: "public" }),
        private: features.allowed({ consent: true, status: "private" }),
        noConsent: features.allowed({ consent: false, status: "public" }) });
    `, sandbox);
    assert.equal(result.config.duration, null);
    assert.equal(result.config.visibilityTimeout, 400);
    assert.equal(result.config.custom, 123);
    assert.equal(result.originalDuration, 60000);
    assert.equal(result.marker, "preserved");
    assert.equal(result.sameSelector, true);
    assert.equal(result.sameConfig, true);
    assert.equal(result.permitted, true);
    assert.equal(result.private, false);
    assert.equal(result.noConsent, false);
    assert.equal(sandbox.attributes["data-sc-live-hover-native"], "ready");
  }
});

test("機能設定がない場合には未対応として扱い、元の制限を維持する", () => {
  const sandbox = context();
  installRuntime(sandbox);
  vm.runInContext(addFeatures, sandbox);
  assert.equal(vm.runInContext("nativeRequire('features').config({featuresConfig:{features:{liveThumbs:null}}})", sandbox), null);
  assert.equal(sandbox.attributes["data-sc-live-hover-native"], "unavailable");
});

test("無関係なチャンクの工場関数とエクスポートは変更しない", () => {
  const sandbox = context();
  installRuntime(sandbox);
  assert.equal(vm.runInContext(`
    var unrelated = (module, exports) => { exports.value = 42; };
    var chunk = [["other"], { unrelated }];
    __LOADABLE_LOADED_CHUNKS__.push(chunk);
    chunk[1].unrelated === unrelated && nativeRequire('unrelated').value === 42;
  `, sandbox), true);
});

test("サイトのランタイム形式が変わった場合にサイトを例外で停止させない", () => {
  const sandbox = context({ invalid: true });
  assert.equal(sandbox.attributes["data-sc-live-hover-native"], "unsupported");
});

test("main.jsに最初から含まれる設定モジュールを、起動コードの実行前に調整する", () => {
  const sandbox = context();
  const result = vm.runInContext(`
    (() => {
      const factories = { mainFeature: function (module, exports, req) {
        const config = ({featuresConfig: state}) => state.features.liveThumbs;
        req.d(exports, {config: () => config});
      }};
      const cache = {};
      function req(id) {
        if (!cache[id]) {
          const module = {exports:{}};
          cache[id] = module;
          factories[id](module,module.exports,req);
        }
        return cache[id].exports;
      }
      req.m = factories;
      req.d = (exports,getters) => {
        for (const name of Object.keys(getters)) Object.defineProperty(exports,name,{get:getters[name]});
      };
      const chunks = __LOADABLE_LOADED_CHUNKS__;
      const parent = chunks.push.bind(chunks);
      chunks.push = function (chunk) {
        Object.assign(factories,chunk[1]);
        if (chunk[2]) chunk[2](req);
        return parent(chunk);
      };
      // No chunk containing mainFeature is pushed: this is the real main bundle layout.
      return req('mainFeature').config({featuresConfig:{features:{liveThumbs:{duration:60000,visibilityTimeout:50}}}});
    })()
  `, sandbox);
  assert.equal(result.duration, null);
  assert.equal(result.visibilityTimeout, 400);
});
