'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { videoId } = require('../core.js');

test('videoId reads every supported YouTube URL form', () => {
  assert.equal(videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0123456789AB&t=3'), 'dQw4w9WgXcQ');
  assert.equal(videoId('/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
  assert.equal(videoId('/shorts/abcDEF_-123'), 'abcDEF_-123');
  assert.equal(videoId('https://m.youtube.com/live/abcDEF_-123'), 'abcDEF_-123');
});

test('videoId rejects other hosts, paths and malformed IDs', () => {
  for (const value of ['https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', '/watch?v=dQw4w9WgXcQX',
    '/playlist?list=PL0123456789AB', '/@channel', 'https://youtu.be/', 'javascript:alert(1)', '', null]) {
    assert.equal(videoId(value), null, String(value));
  }
});
