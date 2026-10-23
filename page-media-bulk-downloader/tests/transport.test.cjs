'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {createServer} = require('./fixture-server.cjs');
const {createHarness, video} = require('./harness.cjs');
const FIXTURES = path.join(__dirname, 'fixtures');
test('合成動画・画像をHTTPで取得し、保存パスとバイト列を検証する（Chrome APIはアダプター）', async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const root = process.env.PAGE_MEDIA_SAMPLE_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'page-media-test-'));
  const preserve = Boolean(process.env.PAGE_MEDIA_SAMPLE_OUTPUT);
  const names = ['sample.webm', 'geometry.png', 'colors.jpg'];
  const origin = 'http://127.0.0.1:' + server.address().port;
  const urls = new Map(names.map((name,index) => ['https://cdn.videy.co/Scene' + String(index+1).padStart(5,'0') + (index === 0 ? '.webm' : index === 1 ? '.png' : '.jpg'), origin + '/fixtures/' + name]));
  const h = createHarness({folderName:'TestSamples', videos:names.map((name,index) => video(index+1, {name,
    link:[...urls.keys()][index], mimetype:index === 0 ? 'video/webm' : index === 1 ? 'image/png' : 'image/jpeg', thumbnail:null}))});
  const native = h.chrome.downloads.download;
  const tasks = [], saved = new Map();
  h.chrome.downloads.download = async options => {
    const id = await native(options);
    tasks.push((async () => {
      const response = await fetch(urls.get(options.url));
      assert.equal(response.status, 200);
      const data = Buffer.from(await response.arrayBuffer());
      assert.equal(data.length, Number(response.headers.get('content-length')));
      const requested = path.resolve(root, options.filename);
      assert.ok(requested.startsWith(path.resolve(root) + path.sep));
      await fs.mkdir(path.dirname(requested), {recursive: true});
      let file = requested, counter = 0;
      while (true) {
        try {await fs.writeFile(file, data, {flag: 'wx'}); break;}
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const parsed = path.parse(requested); file = path.join(parsed.dir, parsed.name + ' (' + ++counter + ')' + parsed.ext);
        }
      }
      saved.set(path.basename(options.filename), file);
      Object.assign(h.downloads.get(id), {state:'complete', mime:response.headers.get('content-type'), bytesReceived:data.length, totalBytes:data.length});
    })());
    return id;
  };
  try {
    const result = await h.send({type:'page-media-bulk:start'}); assert.equal(result.ok, true);
    await Promise.all(tasks);
    const completed = (await h.send({type:'page-media-bulk:status'})).batch;
    assert.equal(completed.status, 'complete'); assert.equal(completed.summary.completed, 3);
    for (const name of names) assert.deepEqual(await fs.readFile(saved.get(name)), await fs.readFile(path.join(FIXTURES, name)));
    for (const file of saved.values()) assert.equal(path.dirname(file), path.join(root, 'PageMedia', 'TestSamples'));
    if (!preserve) {
      const entries = await fs.readdir(root, {withFileTypes: true});
      assert.deepEqual(entries.map(entry => entry.name), ['PageMedia']);
      assert.ok(entries.every(entry => entry.isDirectory()), 'download root must contain no loose files');
    }
    if (preserve) {
      const files = await Promise.all(names.map(async name => {const file = saved.get(name), data = await fs.readFile(file);
        return {name: path.basename(file), bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex')};}));
      const folder = path.join(root, 'PageMedia', 'TestSamples');
      await fs.writeFile(path.join(folder, '.sample-verification.json'), JSON.stringify({version: 1, files}, null, 2) + '\n');
      process.stdout.write('Verified sample output: ' + folder + '\n');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (!preserve) await fs.rm(root, {recursive: true, force: true});
  }
});
