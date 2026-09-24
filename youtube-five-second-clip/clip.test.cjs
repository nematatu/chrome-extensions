const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { videoId, clipRange, selectionRange, filename, validateRequest } = require('./clip.js');
const request = () => ({ id: '12345678-1234-1234-1234-123456789abc', videoId: 'abcdefghijk', start: 10, end: 15, title: 'テスト' });

test('通常動画のURLだけ許可する', () => {
  assert.equal(videoId('https://www.youtube.com/watch?v=abcdefghijk&t=20'), 'abcdefghijk');
  for (const url of ['https://www.youtube.com.evil.test/watch?v=abcdefghijk', 'http://www.youtube.com/watch?v=abcdefghijk',
    'https://www.youtube.com/shorts/abcdefghijk', 'https://www.youtube.com/watch?v=../x', 'invalid']) assert.equal(videoId(url), null);
});

test('直前5秒を計算し、冒頭では0秒から保存する', () => {
  assert.deepEqual(clipRange({ currentTime: 20, duration: 60 }), { start: 15, end: 20 });
  assert.deepEqual(clipRange({ currentTime: 3, duration: 60 }), { start: 0, end: 3 });
  assert.deepEqual(clipRange({ currentTime: 60, duration: 60 }), { start: 55, end: 60 });
});

test('GUIで指定した範囲を検証する', () => {
  const video = { duration: 600 };
  assert.deepEqual(selectionRange(video, 12.3, 48.9), { start: 12.3, end: 48.9 });
  assert.deepEqual(selectionRange(video, 0, 3), { start: 0, end: 3 });
  for (const values of [[-1, 2], [4, 4], [0, 301], [0, 601], [NaN, 2]]) assert.throws(() => selectionRange(video, ...values));
});

test('再生位置を読み取るだけで動画のプロパティを変更しない', () => {
  const video = new Proxy({ currentTime: 20, duration: 60 }, { set() { throw new Error('must not modify video'); } });
  assert.deepEqual(clipRange(video), { start: 15, end: 20 });
});

test('未読み込み、ライブ、不正な時刻を拒否する', () => {
  for (const currentTime of [0, NaN, Infinity, -1, 100]) assert.throws(() => clipRange({ currentTime, duration: 60 }));
  assert.throws(() => clipRange({ currentTime: 5, duration: Infinity }));
});

test('MP4の名前はパス・制御文字を含まず長さを制限する', () => {
  const name = filename('../危険/\\:*?<>|\n\u202e' + '😀'.repeat(300), '../../evil', { start: 0, end: 3 });
  assert.ok(name.startsWith('YouTube_'));
  assert.ok(name.endsWith('_video_0.00-3.00s.mp4'));
  assert.doesNotMatch(name, /[\\/:*?<>|\n\u202e]/);
  assert.ok(Buffer.byteLength(filename('😀'.repeat(300), 'abcdefghijk', { start: 604795, end: 604800 })) < 230);
});

test('非同期リクエストはID・範囲を検証し未知のフィールドを渡さない', () => {
  const result = validateRequest({ ...request(), command: 'danger', url: 'https://evil.test' });
  assert.equal(result.command, undefined);
  assert.equal(result.url, undefined);
  assert.equal(result.start, 10);
  assert.ok(result.filename.endsWith('.mp4'));
  for (const changes of [{ videoId: '../evil' }, { id: '' }, { end: 9 }, { end: Infinity }, { end: '15' }, { start: -1 }, { end: 604801, start: 604796 }, { end: 400 }]) {
    assert.throws(() => validateRequest({ ...request(), ...changes }));
  }
});

test('manifestはブラウザー内変換の権限だけを使い録画APIを使わない', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['offscreen', 'downloads', 'storage']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.youtube.com/*']);
  for (const file of [...manifest.content_scripts.flatMap(script => script.js), manifest.background.service_worker]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(source, /MediaRecorder|captureStream/);
  }
});
