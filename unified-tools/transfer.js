(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MyToolsTransfer = api;
})(globalThis, function (root) {
  "use strict";
  const MAX_BYTES = 20 * 1024 * 1024;
  function fail() { throw new Error("移行ファイルの形式が正しくありません。対応するJSONを書き出し直してください。"); }
  function record(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && (Object.getPrototypeOf(proto) !== null || proto.constructor?.name !== "Object")) fail();
    if (Object.keys(value).some(key => !keys.includes(key))) fail();
    return value;
  }
  let moduleIDs = ['instagram', 'gofile'];
  function configure(modules) {
    if (!Array.isArray(modules) || !modules.length || modules.some(value => !/^[a-z][a-z0-9-]*$/.test(value.id)) || new Set(modules.map(value => value.id)).size !== modules.length) fail();
    moduleIDs = modules.map(value => value.id);
  }
  if (root.MyToolsConfig?.modules) configure(root.MyToolsConfig.modules);
  function enabled(value) {
    record(value, moduleIDs);
    if (!Object.keys(value).length || Object.values(value).some(value => typeof value !== 'boolean')) fail();
    return Object.fromEntries(Object.entries(value));
  }
  const portable = () => root.MyToolsPortable || (typeof require === 'function' ? require('./portable.js') : null);
  function parseBackup(value) {
    let bytes;
    try { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { fail(); }
    if (bytes > MAX_BYTES) throw new Error("移行ファイルは20MiB以下にしてください。");
    record(value, ["format", "version", "settings", "instagram", "preferences"]);
    if (value.format !== "nematatu-tools" || value.version !== 1) fail();
    record(value.instagram, ["savedMedia"]);
    const core = root.IGMediaCore || (typeof require === "function" ? require("../instagram-media-downloader/core.js") : null);
    if (!core?.validateHistory) throw new Error("保存履歴の検証機能を読み込めませんでした。");
    const savedMedia = core.validateHistory(value.instagram.savedMedia);
    const result = { format: "nematatu-tools", version: 1 };
    if (value.settings !== undefined) {
      record(value.settings, ["enabled"]);
      result.settings = { enabled: enabled(value.settings.enabled) };
    }
    result.instagram = { savedMedia };
    if (value.preferences !== undefined) result.preferences = portable().validate(value.preferences);
    return result;
  }
  function makeBackup(settings, history, preferences) {
    return parseBackup({ format: "nematatu-tools", version: 1,
      settings: { enabled: enabled(settings.enabled) }, instagram: { savedMedia: history }, ...(preferences !== undefined && { preferences: portable().validate(preferences) }) });
  }
  return { MAX_BYTES, configure, parseBackup, makeBackup };
});
