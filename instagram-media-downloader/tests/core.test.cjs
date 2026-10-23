const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../core.js');
const url = 'https://scontent.cdninstagram.com/photo.jpg?token=fixture';
test('URL boundary rejects credentials, suffix attacks, non-HTTPS and blob URLs', () => {
  for (const bad of ['https://cdninstagram.com.evil.test/x', 'https://user@cdninstagram.com/x', 'http://cdninstagram.com/x', 'blob:https://www.instagram.com/x', 'https://cdninstagram.com:444/x']) assert.equal(c.mediaURL(bad), null);
  assert.equal(c.mediaURL(url), url);
});
test('carousel retains order, chooses largest rendition and never replaces video with poster', () => {
  const data = { items: [{ pk: '12345678901234567890', code: 'Ab_c', user: { username: 'alice' }, carousel_media: [
    { pk: '1', media_type: 1, image_versions2: { candidates: [{ url, width: 320 }, { url: url.replace('photo', 'large'), width: 1440 }] } },
    { pk: '2', media_type: 2, video_versions: [{ url: url.replace('photo.jpg', 'clip.mp4'), width: 1080 }] },
  ] }] };
  const [group] = c.groups(data);
  assert.equal(c.groups(data).length, 1);
  assert.equal(group.id, '12345678901234567890');
  assert.equal(group.media[0].url, url.replace('photo', 'large'));
  assert.equal(group.media[1].kind, 'video');
  assert.equal(group.media[1].index, 1);
  assert.equal(group.complete, true);
  data.items[0].carousel_media.push({ media_type: 2, display_url: url });
  assert.equal(c.groups(data)[0].complete, false);
});
test('GraphQL sidecars and nested story reels are parsed', () => {
  assert.equal(c.groups({ data: { x: { id: '9', shortcode: 'AB', edge_sidecar_to_children: { edges: [{ node: { id: '10', display_url: url } }] } } } })[0].media.length, 1);
  assert.equal(c.groups({ reels: { '1': { items: [{ pk: '2', image_versions2: { candidates: [{ url }] } }] } } })[0].id, '2');
});
test('filenames and batch validation prevent traversal and bound work', () => {
  const name = c.filename({ username: '../../alice', code: 'Ab' }, { kind: 'image', url, index: 0 });
  assert.match(name, /^Instagram\/______alice\/Ab_01.jpg$/);
  assert.equal(c.validateItems([{ url, filename: name }]).length, 1);
  for (const filename of ['../x.jpg', 'Instagram/a/../a.jpg', 'Instagram/a/b.exe']) assert.throws(() => c.validateItems([{ url, filename }]));
  assert.throws(() => c.validateItems(Array(501).fill({ url, filename: name })));
});
test('shortcode conversion uses exact large integers', () => {
  assert.equal(c.shortcodeID('BA'), '64');
  assert.equal(c.shortcodeID('___________'), '73786976294838206463');
  assert.throws(() => c.shortcodeID('../a'));
});
test('drawn rectangle follows contain, cover, custom position, scale-down', () => {
  const rect = { left: 100, top: 50, width: 600, height: 400 };
  assert.deepEqual(c.drawnRect(rect, 200, 400, 'contain'), { left: 300, top: 50, right: 500, bottom: 450, width: 200, height: 400 });
  assert.equal(c.drawnRect(rect, 200, 400, 'contain', '100% 0%').right, 700);
  assert.deepEqual(c.drawnRect(rect, 200, 400, 'cover'), { left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400 });
  assert.equal(c.drawnRect(rect, 100, 100, 'scale-down').width, 100);
  const offset = c.drawnRect(rect, 100, 100, 'none', 'right 20px top 30px');
  assert.equal(offset.right, 680); assert.equal(offset.top, 80);
  assert.equal(c.drawnRect(rect, 100, 100, 'none', 'calc(100% - 20px) 30px').right, 680);
  assert.equal(c.drawnRect(rect, 100, 100, 'none', 'bottom').bottom, 450);
  assert.equal(c.drawnRect(rect, 100, 100, 'none', 'center left').left, 100);
});

test('history uses stable IDs, rejects missing IDs, and keeps URL aliases typed and unsigned', async () => {
  const media = c.item({ image_versions2: { candidates: [{ url }] } }, 7);
  assert.equal(media.id, ''); assert.equal(c.mediaKey({ id: '123' }, media), null);
  assert.equal(c.mediaKey({ id: '123_77' }, { id: '456_88', kind: 'video' }), 'm:123:456:video');
  assert.equal(c.groupKey({ id: '123_77' }), 'g:123');
  const image = await c.urlHistoryKey(url, 'image');
  assert.equal(image, await c.urlHistoryKey(url.replace('fixture', 'expired'), 'image'));
  assert.notEqual(image, await c.urlHistoryKey(url, 'video'));
  assert.equal(await c.urlHistoryKey('https://evil.test/photo.jpg', 'image'), null);
  const keys = await c.historyKeys({ id: '123', code: 'BA', username: 'alice' }, { id: '456', index: 0, kind: 'image', url, preview: url });
  assert.equal(new Set(keys).size, keys.length); assert.ok(keys.every(c.validHistoryKey));
  assert.equal(JSON.stringify(keys).includes('fixture'), false);
  assert.equal(await c.postHistoryKey('../bad'), null);
  assert.ok(c.validHistoryKey(await c.postHistoryKey('BA')));
});
