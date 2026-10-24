(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyToolsPortable = api;
})(globalThis, function () {
  'use strict';
  const definitions = {
    googlephotos: { area: 'local', fields: { 'gpu-panel-collapsed-v1': 'boolean' } },
    instagramhq: { area: 'sync', fields: { enabled: 'boolean', rotateLive: 'boolean' } },
    inhighskip: { area: 'sync', fields: { skipSeconds: [1, 300, 'integer'], keyboardEnabled: 'boolean' } },
    kltra: { area: 'local', fields: { enabled: 'boolean', fontSize: [14, 40], transparency: [0, 100], position: [0, 100], speed: [60, 300], showName: 'boolean', translationEnabled: 'boolean', translationSource: ['auto', 'id', 'en'], translationEngine: ['online', 'local'] } },
    r2: { area: 'sync', fields: { baseUrlTemplate: 'template', maxWidth: [40, 320], maxHeight: [40, 320], hoverOnly: 'boolean', showNonImages: 'boolean' } },
    xhashtags: { area: 'sync', fields: { hashtags: 'text' } },
    sushida: { area: 'local', fields: { settings: 'sushida' } }
  };
  const schemas = Object.fromEntries(Object.entries(definitions).map(([id, value]) => [id, { area: value.area, keys: Object.keys(value.fields) }]));
  function fail() { throw new Error('個別機能の設定形式が不正です。設定値を確認して書き出し直してください。'); }
  function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && (Object.getPrototypeOf(proto) !== null || proto.constructor?.name !== 'Object')) fail();
    if (Object.keys(value).some(key => !keys.includes(key))) fail();
  }
  function field(value, rule) {
    if (rule === 'boolean') { if (typeof value !== 'boolean') fail(); return value; }
    if (Array.isArray(rule)) {
      if (typeof rule[0] === 'number') {
        if (!Number.isFinite(value) || value < rule[0] || value > rule[1] || rule[2] === 'integer' && !Number.isInteger(value)) fail();
      } else if (!rule.includes(value)) fail();
      return value;
    }
    if (rule === 'text') {
      if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail();
      return value;
    }
    if (rule === 'template') {
      if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) fail();
      if (value === '') return value;
      const placeholders = value.match(/\{[^}]*\}/g) || [];
      if (placeholders.some(key => !['{key}', '{bucket}', '{accountId}'].includes(key))) fail();
      let url;
      try { url = new URL(value.replace(/\{(?:key|bucket|accountId)\}/g, 'placeholder')); } catch { fail(); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) fail();
      return value;
    }
    if (rule === 'sushida') {
      const keys = ['autoDownloadCsv', 'autoResultNetworkRecord', 'autoDownloadJson', 'settingsVersion'];
      object(value, keys);
      const result = {};
      for (const key of keys.slice(0, 3)) if (Object.hasOwn(value, key)) result[key] = field(value[key], 'boolean');
      if (Object.hasOwn(value, 'settingsVersion') && value.settingsVersion !== 2) fail();
      if (value.autoDownloadJson === true && value.autoDownloadCsv !== true) fail();
      if (Object.hasOwn(value, 'settingsVersion')) result.settingsVersion = 2;
      return result;
    }
    fail();
  }
  function validate(value) {
    object(value, Object.keys(definitions));
    const result = {};
    for (const [id, preferences] of Object.entries(value)) {
      const fields = definitions[id].fields;
      object(preferences, Object.keys(fields));
      result[id] = Object.fromEntries(Object.entries(preferences).map(([key, value]) => [key, field(value, fields[key])]));
    }
    return result;
  }
  return { schemas, validate };
});
