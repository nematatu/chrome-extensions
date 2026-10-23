'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../collector.js'), 'utf8');
const PAGE = 'https://video.twimg.news/d/10000/';
function entry(index = 1, overrides = {}) {
  return {name: 'generated-scene-' + index + '.mp4', videy: 'Scene' + String(index).padStart(3, '0'),
    videyExt: 'mp4', srcUrl: '', vidSrc: '', target: 'https://promotion.example.test/ignored',
    thumb: 'data:image/png;base64,synthetic-preview', ...overrides};
}
function collect(data = [entry()], options = {}) {
  const scripts = options.scripts || [{textContent: options.script || '\nvar VIDEOS = ' + JSON.stringify(data) + ';\n'}];
  const rows = (options.names || data.map(item => item.name)).map(textContent => ({textContent}));
  const context = vm.createContext({URL, location: {href: options.page || PAGE}, document: {
    title: 'Synthetic generated scenes', baseURI: options.page || PAGE,
    querySelectorAll(selector) {
      if (selector === 'script:not([src])') return scripts;
      if (selector === '#fl .fm-row .file-name') return rows;
      return [];
    },
  }});
  vm.runInContext(source, context);
  const result = JSON.parse(JSON.stringify(context.collectPageMedia(options.expectedPage)));
  assert.equal(context.scriptRan, undefined, 'page code must never execute');
  return result;
}
test('埋め込み一覧142件を再生前に収集し、広告リンクとプレビュー画像を除外する', () => {
  const result = collect(Array.from({length: 142}, (_, index) => entry(index + 1)));
  assert.equal(result.ok, true); assert.equal(result.items.length, 142); assert.equal(result.unsupported, 0);
  assert.equal(new Set(result.items.map(item => item.url)).size, 142);
  assert.ok(result.items.every(item => item.kind === 'video' && item.thumbnail === null));
  assert.equal(result.items[0].url, 'https://cdn.videy.co/Scene001.mp4');
  assert.equal(result.items[141].name, 'generated-scene-142.mp4');
});
test('実装した関数は外側の状態に依存せず、単独でシリアライズできる', () => {
  const fn = require('../collector.js');
  const page = PAGE;
  const literal = '\nvar VIDEOS = ' + JSON.stringify([entry()]) + ';';
  const context = vm.createContext({URL, location: {href: page}, document: {baseURI: page, title: 'Test',
    querySelectorAll: selector => selector.startsWith('script') ? [{textContent: literal}] : [{textContent: entry().name}]}});
  const result = vm.runInContext('(' + fn.toString() + ')()', context);
  assert.equal(result.ok, true); assert.equal(result.items.length, 1);
});
test('Gofile版のキュー形式へ変換し、フォルダ情報と既知のサイズを保持する', () => {
  const result = collect([entry(1, {size: 250}), entry(2, {size: -1})]);
  assert.equal(result.pageUrl, PAGE); assert.equal(result.folderId, '10000');
  assert.equal(result.folderName, 'Synthetic generated scenes');
  assert.equal(result.scannedItems, 2); assert.equal(result.totalPages, 1);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.videos.length, 2);
  assert.equal(result.videos[0].link, result.items[0].url);
  assert.equal(result.videos[0].size, 250); assert.equal(result.videos[1].size, 0);
  assert.ok(result.videos.every(item => item.type === 'file' && item.mimetype === 'video/mp4'));
});
test('取得要求のあとでページが変わった場合は一覧を返さない', () => {
  const result = collect([entry()], {expectedPage: 'https://video.twimg.news/d/10001/'});
  assert.equal(result.error, 'PAGE_CHANGED'); assert.equal(result.items, undefined);
});
test('同じ動画URLは1件にまとめ、許可された直接URLと実ページの優先順位を扱う', () => {
  const result = collect([entry(), entry(2, {videy: entry().videy}),
    entry(3, {srcUrl: 'https://cdn.videy.co/Direct01.mp4'}), entry(4, {videy: '', vidSrc: 'https://cdn.videy.co/Direct02.mp4'})]);
  assert.equal(result.ok, true); assert.equal(result.items.length, 3);
  assert.equal(result.items[1].url, 'https://cdn.videy.co/Direct01.mp4');
  assert.equal(result.items[2].url, 'https://cdn.videy.co/Direct02.mp4');
});
test('文字列内の括弧・引用符を処理し、画面の並べ替えにも対応する', () => {
  const data = [entry(1, {name: 'scene ["] ; \\ .mp4'}), entry(2)];
  const result = collect(data, {names: data.map(v => v.name).reverse()});
  assert.equal(result.ok, true); assert.equal(result.items[0].name, data[0].name);
});
test('形式変更・重複定義・実行式は停止し、サイトのスクリプトを実行しない', () => {
  const valid = '\nvar VIDEOS = ' + JSON.stringify([entry()]) + ';';
  for (const script of ['var VIDEOS = [', 'var VIDEOS = [{name:"unquoted-key"}];',
    'var VIDEOS = [(()=>{globalThis.scriptRan=true;return {};})()];',
    valid.replace(/;$/, '.map(x => x);'), valid + valid]) {
    const result = collect([entry()], {script});
    assert.equal(result.error, 'SITE_DATA_CHANGED'); assert.equal(result.items, undefined);
  }
  assert.equal(collect([], {script: '/* no folder data */'}).error, 'SITE_DATA_MISSING');
  assert.equal(collect([], {script: 'var VIDEOS = [];'}).error, 'SITE_DATA_CHANGED');
});
test('未読込・部分一覧・名前の不一致では部分成功にしない', () => {
  assert.equal(collect([entry()], {names: []}).error, 'SITE_NOT_READY');
  assert.equal(collect([entry(), entry(2)], {names: [entry().name]}).error, 'SITE_LIST_MISMATCH');
  assert.equal(collect([entry()], {names: ['different.mp4']}).error, 'SITE_LIST_MISMATCH');
  assert.equal(collect([entry(), entry(2)], {names: [entry().name, entry().name]}).error, 'SITE_LIST_MISMATCH');
});
test('外部URL・認証URL・配信形式・不正ID・不正なデータ型を拒否する', () => {
  for (const overrides of [{srcUrl: 'https://other.example.test/Scene001.mp4'},
    {srcUrl: 'https://cdn.videy.co.evil.example.test/Scene001.mp4'},
    {srcUrl: 'https://user:secret@cdn.videy.co/Scene001.mp4'},
    {srcUrl: 'http://cdn.videy.co/Scene001.mp4'}, {srcUrl: 'https://cdn.videy.co/Scene001.mp4?token=test'},
    {srcUrl: 'https://cdn.videy.co/Scene001.m3u8'}, {videy: '../Scene001'}, {videy: ''},
    {videyExt: 'm3u8'}, {srcUrl: {}}, {videy: 1}, {vidSrc: []}]) {
    const result = collect([entry(), entry(2, overrides)]);
    assert.equal(result.error, 'SITE_FILE_UNSUPPORTED'); assert.equal(result.items, undefined);
  }
});
test('項目数・インラインデータ量を制限し、別ホストや別ページで専用処理を行わない', () => {
  assert.equal(collect(Array.from({length: 10001}, (_, index) => entry(index))).error, 'TOO_MANY_ITEMS');
  assert.equal(collect([entry()], {script: ' '.repeat(4 * 1024 * 1024 + 1)}).error, 'TOO_MUCH_DATA');
  for (const page of ['https://example.test/d/10000/', 'https://video.twimg1.com.evil.example.test/example-folder',
    'https://video.twimg.news/other-page', 'https://video.twimg.news.evil.example.test/d/10000/']) {
    const result = collect([entry()], {page});
    assert.equal(result.ok, true); assert.equal(result.items.length, 0);
  }
});
