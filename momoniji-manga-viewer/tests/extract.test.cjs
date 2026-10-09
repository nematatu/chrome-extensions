const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ROOT, workHtml } = require('./fixtures.cjs');

const extension = fs.existsSync(path.resolve(__dirname, '../extension/extract.js')) ? path.resolve(__dirname, '../extension') : path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(extension, 'extract.js'), 'utf8');

function setup(html = workHtml(), url = ROOT) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.eval(source);
  return { dom, document: dom.window.document, api: dom.window.MomonijiExtract };
}

test('extracts only comic images in numerical order and preserves metadata', () => {
  const { dom, document, api } = setup(workHtml({ pages: [2, 1] }));
  const work = api.extractDocument(document, ROOT);
  assert.equal(work.id, '123');
  assert.equal(work.title, 'テスト漫画');
  assert.equal(work.sourceUrl, ROOT);
  assert.equal(work.sitePage, 1);
  assert.equal(work.totalPages, 6);
  assert.deepEqual(Array.from(work.pages, page => page.number), [1, 2]);
  assert.ok(work.pages.every(page => new URL(page.url).hostname === 'img.momoniji.com'));
  assert.equal(work.pages.length, 2);
  assert.ok(!work.pages.some(page => page.url.includes('advertisement') || page.url.includes('logo')));
  dom.window.close();
});

test('listing and unrelated pages are not interpreted as a work', () => {
  for (const html of ['<main><h1>ランキング</h1><img src="https://img.momoniji.com/test/001.png"></main>', '<main><div id="content" data="123" page="1"></div></main>']) {
    const { dom, document, api } = setup(html);
    assert.equal(api.extractDocument(document, ROOT), null);
    dom.window.close();
  }
});

test('chapter links cannot escape the work path or allowed host', () => {
  const { dom, document, api } = setup(workHtml({ links: [ROOT, `${ROOT}page/2/`, 'https://attacker.example/test-comic/page/3/', 'https://momoniji.com/other-comic/page/2/', `${ROOT}page/3/?x=1`] }));
  const work = api.extractDocument(document, ROOT);
  assert.ok(work.chapterLinks.every(url => new URL(url).origin === 'https://momoniji.com'));
  assert.ok(!work.chapterLinks.some(url => url.includes('attacker') || url.includes('other-comic')));
  dom.window.close();
});

test('collects the complete work starting from a middle site page', async () => {
  const { dom, document, api } = setup(workHtml({ sitePage: 2 }), `${ROOT}page/2/`);
  const fetched = [];
  const progress = [];
  const work = await api.collectWork(document, `${ROOT}page/2/`, {
    fetchPage: async (url, { signal } = {}) => {
      fetched.push(url);
      assert.ok(signal === undefined || signal instanceof dom.window.AbortSignal || signal instanceof AbortSignal);
      return workHtml({ sitePage: Number(url.match(/page\/(\d+)/)?.[1] || 1) });
    },
    onProgress: value => progress.push(value),
  });
  assert.equal(work.sourceUrl, ROOT);
  assert.deepEqual(Array.from(work.pages, page => page.number), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(work.pages.map(page => page.url)).size, 6);
  assert.equal(fetched.length, 2);
  assert.ok(progress.length >= 1);
  dom.window.close();
});

test('missing final comic pages fail instead of silently saving a partial work', async () => {
  const { dom, document, api } = setup();
  await assert.rejects(api.collectWork(document, ROOT, {
    fetchPage: async url => workHtml({ sitePage: Number(url.match(/page\/(\d+)/)?.[1] || 1), pages: url.includes('/3/') ? [5] : [3, 4] }),
  }));
  dom.window.close();
});

test('collects all 91 pages across the verified 40 / 40 / 11 site-page shape', async () => {
  const { dom, document, api } = setup(workHtml({ total: 91, perSitePage: 40 }));
  const work = await api.collectWork(document, ROOT, {
    fetchPage: async url => workHtml({ total: 91, perSitePage: 40, sitePage: Number(url.match(/page\/(\d+)/)?.[1] || 1), omitTotal: true }),
  });
  assert.equal(work.pages.length, 91);
  assert.deepEqual(Array.from(work.pages, page => page.number), Array.from({ length: 91 }, (_, index) => index + 1));
  dom.window.close();
});

test('continuation site pages can omit total-page metadata, using the first page as authority', async () => {
  const { dom, document, api } = setup();
  const work = await api.collectWork(document, ROOT, {
    fetchPage: async url => workHtml({ sitePage: Number(url.match(/page\/(\d+)/)?.[1] || 1), omitTotal: true }),
  });
  assert.equal(work.totalPages, 6);
  assert.deepEqual(Array.from(work.pages, page => page.number), [1, 2, 3, 4, 5, 6]);
  dom.window.close();
});

test('opening a continuation without total metadata first collects the authoritative first page', async () => {
  const { dom, document, api } = setup(workHtml({ sitePage: 2, omitTotal: true }), `${ROOT}page/2/`);
  const fetched = [];
  const work = await api.collectWork(document, `${ROOT}page/2/`, {
    fetchPage: async url => {
      fetched.push(url);
      const sitePage = Number(url.match(/page\/(\d+)/)?.[1] || 1);
      return workHtml({ sitePage, omitTotal: sitePage > 1 });
    },
  });
  assert.equal(fetched[0], ROOT);
  assert.equal(work.totalPages, 6);
  assert.equal(work.initialPage, 3);
  assert.deepEqual(Array.from(work.pages, page => page.number), [1, 2, 3, 4, 5, 6]);
  dom.window.close();
});

test('missing total metadata on the authoritative first page remains a failure', async () => {
  const { dom, document, api } = setup(workHtml({ omitTotal: true }));
  await assert.rejects(api.collectWork(document, ROOT, { fetchPage: async () => { throw new Error('Unexpected fetch'); } }));
  dom.window.close();
});

test('optional continuation totals must match the authoritative first-page total', async () => {
  const { dom, document, api } = setup();
  await assert.rejects(api.collectWork(document, ROOT, { fetchPage: async () => workHtml({ sitePage: 2, total: 7 }) }));
  dom.window.close();
});

test('continuation pages without metadata cannot introduce out-of-range page numbers', async () => {
  const { dom, document, api } = setup();
  await assert.rejects(api.collectWork(document, ROOT, { fetchPage: async () => workHtml({ sitePage: 2, omitTotal: true, pages: [3, 7] }) }));
  dom.window.close();
});

test('middle-page entry still rejects missing metadata on the fetched authoritative root', async () => {
  const { dom, document, api } = setup(workHtml({ sitePage: 2, omitTotal: true }), `${ROOT}page/2/`);
  await assert.rejects(api.collectWork(document, `${ROOT}page/2/`, { fetchPage: async () => workHtml({ omitTotal: true }) }));
  dom.window.close();
});

test('middle-page entry rejects a fetched root belonging to a different work', async () => {
  const { dom, document, api } = setup(workHtml({ sitePage: 2, omitTotal: true }), `${ROOT}page/2/`);
  await assert.rejects(api.collectWork(document, `${ROOT}page/2/`, { fetchPage: async () => workHtml({ id: '999' }) }));
  dom.window.close();
});

test('site-page marker must match the URL part number', () => {
  const { dom, document, api } = setup(workHtml({ sitePage: 3, omitTotal: true }), `${ROOT}page/2/`);
  assert.throws(() => api.extractDocument(document, `${ROOT}page/2/`));
  dom.window.close();
});

test('fetch failures and mismatched work identity are propagated', async () => {
  const { dom, document, api } = setup();
  await assert.rejects(api.collectWork(document, ROOT, { fetchPage: async () => { throw new Error('HTTP 503'); } }));
  await assert.rejects(api.collectWork(document, ROOT, { fetchPage: async () => workHtml({ sitePage: 2, id: '999' }) }));
  dom.window.close();
});

test('abort stops collection', async () => {
  const { dom, document, api } = setup();
  const controller = new dom.window.AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(api.collectWork(document, ROOT, { signal: controller.signal, fetchPage: async () => { calls++; return workHtml({ sitePage: 2 }); } }));
  assert.equal(calls, 0);
  dom.window.close();
});

test('encoded trailing slash and later site pages resolve to the same source URL', () => {
  const first = setup(workHtml(), 'https://momoniji.com/test-comic%2f');
  const second = setup(workHtml({ sitePage: 2 }), `${ROOT}page/2/`);
  assert.equal(first.api.extractDocument(first.document, 'https://momoniji.com/test-comic%2f').sourceUrl, second.api.extractDocument(second.document, `${ROOT}page/2/`).sourceUrl);
  first.dom.window.close();
  second.dom.window.close();
});

test('unsupported URLs in comic slots are rejected', () => {
  for (const imageUrl of ['https://attacker.example/image.png', 'javascript:alert(1)', 'https://img.momoniji.com.attacker.example/image.png']) {
    const { dom, document, api } = setup(workHtml().replace('https://img.momoniji.com/test/001.png', imageUrl));
    assert.throws(() => api.extractDocument(document, ROOT));
    dom.window.close();
  }
});

test('the explicit 1-11 pager range supports a single-page work with a blank count table', async () => {
  const html = workHtml({ total: 11, perSitePage: 40, metadataTotal: null, pagerRanges: true });
  const { dom, document, api } = setup(html);
  document.querySelector('main').append(document.querySelector('.singlepager').cloneNode(true));
  const work = await api.collectWork(document, ROOT, { fetchPage: async () => assert.fail('single-page work needs no extra fetch') });
  assert.equal(work.totalPages, 11); assert.equal(work.pages.length, 11);
  dom.window.close();
});

for (const [metadataTotal, total] of [[42, 43], [82, 84], [53, 56], [148, 77]]) {
  test(`verified pager ranges collect ${total} images despite the stale table count ${metadataTotal}`, async () => {
    const options = { total, perSitePage: 40, metadataTotal, pagerRanges: true };
    const { dom, document, api } = setup(workHtml(options));
    const work = await api.collectWork(document, ROOT, {
      fetchPage: async url => workHtml({ ...options, sitePage: Number(url.match(/page\/(\d+)/)?.[1] || 1) }),
    });
    assert.equal(work.totalPages, total);
    assert.deepEqual(Array.from(work.pages, page => page.number), Array.from({ length: total }, (_, index) => index + 1));
    dom.window.close();
  });
}

test('all 433 images are collected from a middle page when table counts are blank', async () => {
  const options = { total: 433, perSitePage: 40, metadataTotal: null, pagerRanges: true };
  const pageUrl = `${ROOT}page/6/`;
  const { dom, document, api } = setup(workHtml({ ...options, sitePage: 6 }), pageUrl);
  const fetched = [];
  const work = await api.collectWork(document, pageUrl, {
    fetchPage: async url => {
      fetched.push(url);
      return workHtml({ ...options, sitePage: Number(url.match(/page\/(\d+)/)?.[1] || 1) });
    },
  });
  assert.equal(work.totalPages, 433); assert.equal(work.pages.length, 433);
  assert.equal(work.initialPage, 201); assert.equal(fetched.length, 10);
  assert.deepEqual(Array.from(work.pages, page => page.number), Array.from({ length: 433 }, (_, index) => index + 1));
  dom.window.close();
});

test('incomplete or unsafe pager ranges cannot supply a missing total', () => {
  const base = workHtml({ metadataTotal: null, pagerRanges: true });
  const invalid = [
    base.replace('3-4ページ', '4-4ページ'),
    base.replace('3-4ページ', '3-2ページ'),
    base.replace('5-6ページ', '5-1001ページ'),
    base.replace(`${ROOT}page/2/`, 'https://attacker.example/test-comic/page/2/'),
    base.replace(`${ROOT}page/2/`, 'https://momoniji.com/other-comic/page/2/'),
    base.replace(`${ROOT}page/2/`, `${ROOT}page/3/`),
    base.replace('<span>1-2ページ</span>', `<a href="${ROOT}">1-2ページ</a>`),
    base.replace('<span>1-2ページ</span>', '<span>1-2ページ</span><span>3-4ページ</span>'),
  ];
  for (const html of invalid) {
    const { dom, document, api } = setup(html);
    assert.throws(() => api.extractDocument(document, ROOT), /全ページ数を確認できません/);
    dom.window.close();
  }
});

test('top and bottom pager ranges must agree before replacing missing metadata', () => {
  const { dom, document, api } = setup(workHtml({ metadataTotal: null, pagerRanges: true }));
  const second = document.querySelector('.singlepager').cloneNode(true);
  second.querySelector('.spgr').lastElementChild.textContent = '5-7ページ';
  document.querySelector('main').append(second);
  assert.throws(() => api.extractDocument(document, ROOT), /全ページ数を確認できません/);
  dom.window.close();
});

test('a valid pager never permits missing or repeated comic images', async () => {
  const options = { metadataTotal: null, pagerRanges: true };
  const { dom, document, api } = setup(workHtml(options));
  await assert.rejects(api.collectWork(document, ROOT, {
    fetchPage: async url => workHtml({ ...options, sitePage: Number(url.match(/page\/(\d+)/)?.[1] || 1), pages: url.includes('/3/') ? [5] : [3, 4] }),
  }), /全ページを取得できません/);
  const repeated = workHtml(options).replace('id="c2"', 'id="c1"');
  assert.throws(() => api.extractDocument(new dom.window.DOMParser().parseFromString(repeated, 'text/html'), ROOT), /漫画画像の情報が不正/);
  dom.window.close();
});
