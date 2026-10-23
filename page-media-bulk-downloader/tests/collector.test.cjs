'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../collector.js'), 'utf8');
function element(tagName, attrs = {}, options = {}) {
  return {tagName, currentSrc: options.currentSrc || '', getAttribute: key => attrs[key] || null,
    querySelectorAll: () => options.sources || [], querySelector: () => options.image || null,
    closest: () => options.anchor || null};
}
function collect(elements, base = 'https://example.test/gallery/') {
  const context = vm.createContext({URL, location: {href: base}, document: {title: 'Nonsexual test scenes', baseURI: base, querySelectorAll: () => elements}});
  vm.runInContext(source, context);
  return JSON.parse(JSON.stringify(context.collectPageMedia()));
}
test('標準DOMから動画・画像・直接リンクを収集し、相対URLを解決する', () => {
  const result = collect([element('VIDEO', {src: 'clip.webm', poster: 'poster.png'}), element('IMG', {src: 'photo.png'}),
    element('A', {href: 'movie.mp4', download: 'scene.mp4'}), element('A', {href: 'document.pdf'})]);
  assert.equal(result.ok, true); assert.equal(result.items.length, 3);
  assert.equal(result.items[0].url, 'https://example.test/gallery/clip.webm');
  assert.equal(result.items[0].thumbnail, 'https://example.test/gallery/poster.png');
  assert.equal(result.items[2].name, 'scene.mp4');
});
test('ギャラリーはリンク先の原本を選び、サムネイルを別ファイルとして保存しない', () => {
  const anchor = element('A', {href: 'full.png'});
  const img = element('IMG', {src: 'thumb.png'}, {anchor});
  const result = collect([anchor, img, element('A', {href: 'full.png#duplicate'})]);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].url, 'https://example.test/gallery/full.png');
});
test('video要素は使用中のソースを優先し、代替形式を重複保存しない', () => {
  const result = collect([element('VIDEO', {src: 'alternative.mp4'}, {currentSrc: 'current.webm', sources: [element('SOURCE', {src: 'other.mp4'})]})]);
  assert.equal(result.items.length, 1); assert.match(result.items[0].url, /current\.webm$/);
});
test('HLS・Blobは直接保存しない。通常ファイルの代替ソースは使用できる', () => {
  const result = collect([element('VIDEO', {src: 'stream.m3u8'}), element('VIDEO', {src: 'blob:https://example.test/id'}),
    element('VIDEO', {src: 'stream.m3u8'}, {sources: [element('SOURCE', {src: 'clip.mp4'})]})]);
  assert.equal(result.items.length, 1); assert.equal(result.unsupported, 2);
});
test('遅延画像・不正URLを扱い、巨大ページでは全体を停止する', () => {
  assert.equal(collect([element('IMG', {src: 'data:image/png;base64,x', 'data-src': 'lazy.png'})]).items.length, 1);
  assert.equal(collect([element('IMG', {src: 'https://user:secret@example.test/a.png'})]).items.length, 0);
  const tooMany = collect(Array.from({length: 10001}, (_, index) => element('IMG', {src: 'photo-' + index + '.png'})));
  assert.equal(tooMany.ok, false); assert.equal(tooMany.error, 'TOO_MANY_ITEMS'); assert.equal(tooMany.items, undefined);
  assert.equal(collect(Array(20001).fill(element('A', {href: 'other.html'}))).error, 'TOO_MANY_NODES');
});
