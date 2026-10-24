'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const extension = path.join(root, 'dist/my-tools');
const output = path.join(root, 'unified-tools/test-results/all');
const config = vm.runInNewContext(fs.readFileSync(path.join(extension, 'config.js'), 'utf8') + ';MyToolsConfig');
const clip = fs.readFileSync(path.join(root, 'instagram-media-downloader/tests/fixtures/clip.mp4'));
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'all-browser-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${temp}/key.pem`, '-out', `${temp}/cert.pem`, '-days', '1', '-subj', '/CN=vid.fun800.click'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(`${temp}/key.pem`), cert: fs.readFileSync(`${temp}/cert.pem`) }, (req, res) => {
    let data, contentType;
    if (req.url.includes('/getInfo')) { data = JSON.stringify({ code: 0, data: { info: { netDiskInfo: { id: 'file', name: 'Fixture', isFolder: true }, extraInfo: {} }, rules: { status: '0' } } }); contentType = 'application/json'; }
    else if (req.url.includes('list_by_links_page')) { data = JSON.stringify({code:0,data:{list:[{id:'video',name:'fixture.mp4',isFolder:false,landingPage:'fixturecode',mp4Url:'https://vid.fun800.click/page/list.m3u8',size:100}],total:1}}); contentType='application/json'; }
    else if (req.url.endsWith('.m3u8')) { data = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST'; contentType = 'application/vnd.apple.mpegurl'; }
    else if (req.url.endsWith('.ts')) { data = fs.readFileSync(path.join(root, 'tweetfile-video-downloader/tests/fixtures', req.url.endsWith('/a.ts') ? 'segment0.ts' : 'segment1.ts')); contentType = 'video/mp2t'; }
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' }); res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',path.join(root,'instagram-media-downloader/tests/fixtures/clip.mp4'),'-map','0:v','-c','copy',path.join(temp,'video.mp4')]);
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',path.join(root,'instagram-media-downloader/tests/fixtures/clip.mp4'),'-map','0:a','-c','copy',path.join(temp,'audio.mp4')]);
  const tracks=[fs.readFileSync(path.join(temp,'video.mp4')),fs.readFileSync(path.join(temp,'audio.mp4'))];
  fs.mkdirSync(path.join(temp,'profile','Default'),{recursive:true}); fs.writeFileSync(path.join(temp,'profile','Default','Preferences'), JSON.stringify({download:{default_directory:path.join(output,'downloads'),prompt_for_download:false}}));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), { channel:'chromium', headless: true, acceptDownloads: true, downloadsPath: path.join(output, 'downloads'), viewport: { width: 1100, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP vid.fun800.click 127.0.0.1:${server.address().port}, MAP rwzugqnp.fun800.click 127.0.0.1:${server.address().port}`] });
    context.setDefaultTimeout(10000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:15000});
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); const cdp = await context.newCDPSession(manager); await cdp.send('Browser.setDownloadBehavior', {behavior:'default'}); await manager.goto(`chrome-extension://${extensionId}/popup.html`); await manager.locator('#instagram:not([disabled])').waitFor();
    const checks = [];
    await require('./all-browser.cjs')({ context, worker, manager, config, check: name => { checks.push(name); console.log('PASS ' + name); }, root, extensionId, image, clip, tracks, output });
    console.log('PASS ' + checks.length + ' all-module browser checks');
  } finally { await context?.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
