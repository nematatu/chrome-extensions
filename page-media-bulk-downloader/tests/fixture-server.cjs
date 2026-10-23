'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const {createHarness, video} = require('./harness.cjs');
const DIR = path.resolve(__dirname, '..');
const files = new Map([
  ['/opfs/', ['tests/opfs-fixture.html', 'text/html; charset=utf-8']],
  ['/opfs-fixture.js', ['tests/opfs-fixture.js', 'text/javascript']],
  ['/opfs-core.js', ['core.js', 'text/javascript']],
  ['/opfs-mux.js', ['vendor/mux.min.js', 'text/javascript']],
  ['/opfs-mp4.js', ['mp4.js', 'text/javascript']],
  ['/opfs-hls.js', ['hls.js', 'text/javascript']],
  ['/opfs-offscreen.js', ['offscreen.js', 'text/javascript']],
  ['/hls-fixtures/generated.m3u8', ['tests/fixtures/generated.m3u8', 'application/vnd.apple.mpegurl']],
  ['/hls-fixtures/generated-00.ts', ['tests/fixtures/generated-00.ts', 'video/mp2t']],
  ['/hls-fixtures/generated-01.ts', ['tests/fixtures/generated-01.ts', 'video/mp2t']],
  ['/gallery', ['tests/fixture.html', 'text/html; charset=utf-8']],
  ['/d/10001/', ['tests/fixture.html', 'text/html; charset=utf-8']],
  ['/hosted/10001/', ['tests/hosted-fixture.html', 'text/html; charset=utf-8']],
  ['/mock-chrome.js', ['tests/mock-chrome.js', 'text/javascript']],
  ['/fixtures/sample.webm', ['tests/fixtures/sample.webm', 'video/webm']],
  ['/fixtures/geometry.png', ['tests/fixtures/geometry.png', 'image/png']],
  ['/fixtures/colors.jpg', ['tests/fixtures/colors.jpg', 'image/jpeg']],
]);
for (const name of ['offset.m3u8', ...Array.from({length: 8}, (_, index) => 'offset-0' + index + '.ts')]) {
  files.set('/hls-fixtures/' + name, ['tests/fixtures/' + name,
    name.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl']);
}
function createServer() {
  const h = createHarness({folderId: '10001', folderName: 'TestSamples', videos: [
    video(1, {name: 'sample.webm', mimetype: 'video/webm', thumbnail: null}),
    video(2, {name: 'geometry.png', mimetype: 'image/png', link: 'https://cdn.videy.co/Scene00002.png', thumbnail: null}),
    video(3, {name: 'colors.jpg', mimetype: 'image/jpeg', link: 'https://cdn.videy.co/Scene00003.jpg', thumbnail: null}),
  ]});
  const hlsEntries = Array.from({length:3}, (_,i)=>({id:'scene-'+i,name:'generated-scene'+(i?'-'+i:''),isFolder:false,
    fileUrl:'https://vid.fun800.click/scene-'+i+'/generated.m3u8'}));
  const hls = createHarness({scanType: 'hosted-api', pageUrl: 'https://video.twimg1.com/Fixture001',
    title: 'TestSamples', playerName: 'TestSamples-generated-scene', visibleRows:hlsEntries.map(({name})=>({name,isFolder:false}))});
  hls.sender.url = hls.discovery.pageUrl; hls.sender.tab.url = hls.discovery.pageUrl;
  hls.setApiFetch(value => {
    if (new URL(value).pathname.endsWith('/getInfo')) return new Response(JSON.stringify({code: 0, data: {
      info: {netDiskInfo: hlsEntries[0],
        extraInfo: {channelName: 'TestSamples', externalLinks:'Channel001'}}, rules: {status: '0'},
    }}), {headers: {'content-type': 'application/json'}});
    if(new URL(value).pathname.endsWith('/list_by_links_page')) return new Response(JSON.stringify({code:0,data:{list:hlsEntries,total:3}}),
      {headers:{'content-type':'application/json'}});
    return new Response('#EXTM3U\n#EXTINF:1,\ngenerated-00.ts\n#EXTINF:1,\ngenerated-01.ts\n#EXT-X-ENDLIST\n');
  });
  let scanError = false;
  const nativeScript = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async options => {
    if (scanError) {scanError = false; return [{result:{ok:false,error:'SITE_LIST_MISMATCH'}}];}
    return nativeScript(options);
  };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const isHls = requestUrl.searchParams.get('hls') === '1';
    const selected = isHls ? hls : h;
    if (request.method === 'POST' && ['/api/message', '/api/demo'].includes(pathname)) {
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 2048) throw new Error('TOO_MUCH_DATA'); }
        const message = JSON.parse(body);
        let result;
        if (pathname === '/api/message') {
          if (!['start','status','cancel','retry','dismiss'].some(type => message.type === 'page-media-bulk:' + type)) throw new Error('BAD_MESSAGE');
          result = await selected.send(message);
        } else {
          if (isHls && message.action !== 'scan-error') {
            const items = Object.values(hls.getCachedState()?.batches || {}).at(-1)?.items || [];
            for(const [index,item] of items.entries()) {
              if(!item.hls?.token || !['starting','downloading'].includes(item.status)) continue;
              if (message.action === 'progress') await hls.sendHls({token: item.hls.token, phase: 'collecting', bytes: 188, completed: 1, total: 2});
              else if (message.action === 'fail' && index===0) await hls.sendHls({token: item.hls.token, phase: 'failed', error: 'HLS_FETCH_FAILED'});
              else if (['complete','fail'].includes(message.action)) {
                await hls.sendHls({token: item.hls.token, phase: 'ready', format:'mp4', mp4Version:2, size: 376,
                  blobUrl: 'blob:chrome-extension://test-extension-id/'+require('node:crypto').randomUUID()});
                Object.assign(hls.downloads.get(item.downloadId), {state: 'complete', mime: 'video/mp4', bytesReceived: 376, totalBytes: 376});
              }
            }
          } else if (message.action === 'scan-error') scanError = true;
          else {
            const batch = Object.values(h.getCachedState()?.batches || {}).at(-1);
            if (batch) {
              batch.items.forEach((item, index) => {
                const download = h.downloads.get(item.downloadId);
                if (!download) return;
                if (message.action === 'progress') Object.assign(download, {state:index === 0 ? 'complete' : 'in_progress', bytesReceived:index === 0 ? 100 : index === 1 ? 50 : 0});
                else if (message.action === 'fail') Object.assign(download, {state:index === 1 ? 'interrupted' : 'complete', bytesReceived:index === 1 ? 30 : 100, error:index === 1 ? 'NETWORK_FAILED' : undefined});
                else if (message.action === 'complete') Object.assign(download, {state:'complete',bytesReceived:100,error:undefined});
              });
            }
          }
          result = {ok:true};
        }
        response.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, {'Content-Type':'application/json'}); response.end('{"ok":false,"error":"BAD_REQUEST"}');
      }
      return;
    }
    if (request.method !== 'GET') {response.writeHead(405); response.end(); return;}
    let body, type;
    if (pathname === '/fixture-core.js') {
      body = Buffer.from(fs.readFileSync(path.join(DIR, 'core.js'), 'utf8')
        .replace(/function isSupportedPageUrl\(value\) \{[\s\S]*?\n  \}/,
          'function isSupportedPageUrl(value) {\n' +
          '    try { const url = new URL(value); return url.origin === "http://127.0.0.1:' + server.address().port +
          '" && /^\\/(?:d|hosted)\\/\\d+\\/?$/.test(url.pathname); } catch { return false; }\n  }')
        .replace(/function getHostedPageInfo\(value\) \{[\s\S]*?\n  \}/,
          'function getHostedPageInfo(value) {\n' +
          '    try { const url = new URL(value); return url.origin === "http://127.0.0.1:' + server.address().port +
          '" && /^\\/hosted\\/\\d+\\/?$/.test(url.pathname) ? {shortLink: "10001", domain: "fixture"} : null; } catch { return null; }\n  }'));
      type = 'text/javascript';
    } else if (pathname === '/fixture-content.js') {
      // Only the test document opens Shadow DOM for browser automation.
      body = Buffer.from(fs.readFileSync(path.join(DIR, 'content.js'), 'utf8').replaceAll('mode: "closed"', 'mode: "open"'));
      type = 'text/javascript';
    } else {
      const file = files.get(pathname);
      if (!file) {response.writeHead(404); response.end(); return;}
      body = fs.readFileSync(path.join(DIR, file[0])); type = file[1];
      if (pathname === '/hosted/10001/' && requestUrl.searchParams.get('heading') === '1') {
        body = Buffer.from(body.toString('utf8').replace('<!-- list-heading -->', '<div class="list-heading"><h2>動画・画像一覧</h2><span>3件</span></div>'));
      }
      if (pathname === '/hosted/10001/' && isHls) {
        body = Buffer.from(body.toString('utf8').replace('<main class="landing-content">',
          '<main class="landing-content"><section class="player-view"><div class="player-title"><h1>TestSamples-generated-scene</h1></div><p>合成HLS・取得処理はテストアダプターです</p></section>')
          .replace('<strong>sample.webm</strong>','<strong>generated-scene</strong>')
          .replace('<strong>geometry.png</strong>','<strong>generated-scene-1</strong>')
          .replace('<strong>colors.jpg</strong>','<strong>generated-scene-2</strong>'));
      }
    }
    response.writeHead(200, {'Content-Type':type,'Content-Length':body.length,'Cache-Control':'no-store'}); response.end(body);
  });
  return server;
}
if (require.main === module) {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => process.stdout.write('http://127.0.0.1:' + server.address().port + '/d/10001/\n'));
}
module.exports = {createServer};
