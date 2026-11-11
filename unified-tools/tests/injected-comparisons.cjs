'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'unified-tools/test-results/ui/comparisons');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const modules = [
  { id: 'gofile', source: 'gofile-bulk-video-downloader', url: 'https://gofile.io/d/TestCode', host: '#gofile-bulk-video-progress-host' },
  { id: 'pagemedia', source: 'page-media-bulk-downloader', url: 'https://twfiles.com/fixturecode', host: '#page-media-bulk-progress-host' },
  { id: 'tweetfile', source: 'tweetfile-video-downloader', url: 'https://cdn.tweetfile.com/test-extension', host: '#tweetfile-downloader' },
];
const fixtureHTML = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#e8eaed;color:#333;font:14px system-ui}#index_header,.list-heading{display:flex;align-items:center;gap:12px;padding:20px}#filemanager_maincontent{padding:20px}h1{font-size:18px;margin:0}.file{padding:14px 20px;border-bottom:1px solid #d5d7da}#app{position:absolute;inset:0}</style></head><body><div id="index_header"><h1>Files</h1></div><div id="filemanager_maincontent"><div class="file">practice.mp4</div><div class="file">match.mp4</div><div class="file">photo.jpg</div></div><div id="app"><div class="app-page--content"><div class="landing-content"><div class="content-list"><div class="list-heading"><h1>Files</h1></div></div></div></div></div></body></html>';
const fixtureBatch = {
  id: 'fixture', status: 'active', folderName: '練習動画',
  items: [
    { id: '1', name: 'practice.mp4', size: 12000000, status: 'complete', progress: 100, bytesReceived: 12000000, totalBytes: 12000000 },
    { id: '2', name: 'match.mp4', size: 18000000, status: 'downloading', progress: 50, bytesReceived: 9000000, totalBytes: 18000000 },
    { id: '3', name: 'photo.jpg', size: 2000000, status: 'queued', progress: 0, bytesReceived: 0, totalBytes: 2000000 },
  ],
  skipped: [], summary: { completed: 1, total: 3, downloading: 1, queued: 1, failed: 0, canceled: 0, percent: 50, totalBytes: 32000000, bytesReceived: 21000000 },
};
const read = (file, before) => before ? execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, file), 'utf8');
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 500, height: 620 }, colorScheme: 'light' });
    const evidence = [];
    for (const module of modules) {
      for (const before of [true, false]) {
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixtureHTML }));
        await page.goto(module.url);
        await page.evaluate(id => {
          if (id === "gofile") document.querySelector("#app").remove();
          else if (id === "pagemedia") { document.querySelector("#index_header").remove(); document.querySelector("#filemanager_maincontent").remove(); for (const name of ["practice.mp4", "match.mp4", "photo.jpg"]) { const row = document.createElement("div"); row.className = "file video-row"; row.textContent = name; document.querySelector(".content-list").append(row); } }
          else document.querySelector("#app").remove();
        }, module.id);
        await page.evaluate(batch => {
          globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true, batch }), onMessage: { addListener() {} } } };
        }, fixtureBatch);
        if (!before) await page.addScriptTag({ content: fs.readFileSync(path.join(root, module.source, 'ui-kit.js'), 'utf8') });
        if (module.id !== 'tweetfile') await page.addScriptTag({ content: read(`${module.source}/core.js`, before) });
        await page.addScriptTag({ content: read(`${module.source}/content.js`, before) });
        await page.locator(module.host).waitFor({ state: 'visible' });
        if (module.id === 'tweetfile') {
          await page.evaluate(() => window.postMessage({ type: 'tweetfile-videos', page: location.href, items: [
            { url: 'https://cdn.tweetfile.com/practice.mp4', name: 'practice.mp4' },
            { url: 'https://cdn.tweetfile.com/match.mp4', name: 'match.mp4' },
            { url: 'https://cdn.tweetfile.com/highlights.mp4', name: 'highlights.mp4' },
          ] }, location.origin));
          await page.getByRole('button', { name: '選択した動画を一括ダウンロード', exact: true }).waitFor();
          await page.waitForFunction(() => document.querySelector('#tweetfile-downloader').shadowRoot.querySelector('#count').textContent === '3/3');
        }
        assert.deepEqual(errors, [], `${module.id} ${before ? 'before' : 'after'} actual content script renders`);
        await page.screenshot({ path: path.join(output, `${module.id}-${before ? 'before' : 'after'}.png`) });
        await page.close();
      }
      const compare = await context.newPage();
      await compare.setViewportSize({ width: 1000, height: 664 });
      const images = ['before', 'after'].map(side => fs.readFileSync(path.join(output, `${module.id}-${side}.png`)).toString('base64'));
      await compare.setContent('<!doctype html><html><head><style>body{margin:0;background:white;font:600 14px system-ui}.labels{height:44px;display:grid;grid-template-columns:1fr 1fr;align-items:center}.labels span{padding-left:20px}.images{display:flex}img{display:block;width:500px;height:620px}</style></head><body><div class="labels"><span>Before</span><span>After</span></div><div class="images">' + images.map(image => `<img src="data:image/png;base64,${image}">`).join('') + '</div></body></html>');
      await compare.screenshot({ path: path.join(output, `${module.id}-injected.png`) });
      await compare.close();
      evidence.push({ id: module.id, before: `${revision}:${module.source}/content.js`, after: `${module.source}/content.js working tree`, state: module.id === 'tweetfile' ? 'three selected synthetic files' : 'same synthetic three-file batch at 50 percent', rendering: 'actual content script and core executed; chrome.runtime.sendMessage returns identical synthetic fixture batch; site page is a fixture; no real download' });
      console.log(`PASS ${module.id} actual before/after injected UI comparison`);
    }
    fs.writeFileSync(path.join(output, 'injected-provenance.json'), JSON.stringify(evidence, null, 2));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
