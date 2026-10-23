const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, sessionFromPage } = require('../instagram-api.js');
test('session reads existing tokens without persisting or logging them', () => {
  const session = sessionFromPage(['["DTSGInitialData",[],{"token":"fixture-token"}]'], 'other=x; csrftoken=fixture-csrf');
  assert.deepEqual(session, { dtsg: 'fixture-token', csrf: 'fixture-csrf' });
  assert.equal(sessionFromPage([], '').dtsg, '');
});
function client(responses, options = {}) {
  const calls = [];
  return { calls, api: create({
    fetch: async (url, init) => { calls.push({ url, init }); const response = responses.shift(); return new Response(JSON.stringify(response.body), { status: response.status || 200, headers: { 'Content-Type': 'application/json' } }); },
    session: () => ({}), onData() {}, ...options,
  }) };
}
test('post performs only the read-only Polaris query on Instagram', async () => {
  const h = client([{ body: { data: { items: [] } } }]); await h.api.post('BA');
  assert.equal(h.calls[0].url, 'https://www.instagram.com/graphql/query');
  const body = new URLSearchParams(h.calls[0].init.body);
  assert.equal(body.get('fb_api_req_friendly_name'), 'PolarisPostRootQuery');
  assert.equal(JSON.parse(body.get('variables')).shortcode, 'BA');
});
test('429 is surfaced without retrying', async () => {
  const h = client([{ status: 429, body: {} }]);
  await assert.rejects(h.api.post('BA'), /取得制限/); assert.equal(h.calls.length, 1);
});
test('story account must be exact match, never first similar result', async () => {
  const h = client([{ body: { data: { xdt_api__v1__fbsearch__topsearch_connection: { users: [{ user: { username: 'alice_other', id: '1' } }] } } } }]);
  await assert.rejects(h.api.stories({ username: 'alice' }), /特定できません/);
  assert.equal(h.calls.length, 1);
});
test('story finds requested reel among neighbors and rejects partial result', async () => {
  const reel = { id: '11', items: [{ pk: '101' }] };
  const h = client([{ body: { data: { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { id: '12', items: [] } }, { node: reel }] } } } }]);
  assert.deepEqual(await h.api.stories({ username: 'alice' }, '11'), reel);
  const partial = client([{ body: { data: { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { ...reel, has_more: true } }] } } } }]);
  await assert.rejects(partial.api.stories({ username: 'alice' }, '11'), /全件取得できません/);
});
test('aborted operation makes no request', async () => {
  const controller = new AbortController(); controller.abort();
  const h = client([], { signal: () => controller.signal });
  await assert.rejects(h.api.post('BA'), /中止しました/); assert.equal(h.calls.length, 0);
});

test('Instagram text/javascript response is parsed as JSON without execution', async () => {
  let received;
  const api = create({ fetch: async () => new Response('for (;;);{"data":{"items":[]}}', { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }), session: () => ({}), onData: data => received = data });
  await api.post('BA'); assert.deepEqual(received, { data: { items: [] } });
});
