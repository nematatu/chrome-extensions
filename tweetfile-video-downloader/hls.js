/* HLS VOD assembly: MPEG-TS or fragmented MP4, including AES-128 segments. */
(() => {
  function attributes(line) {
    return Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, key, value]) => [key, value.replace(/^"|"$/g, '')]));
  }
  function url(value, base) {
    const parsed = new URL(value, base);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('非対応の動画URLです。');
    return parsed.href;
  }
  async function assemble(source, { fetch: request = fetch, progress = () => {} } = {}) {
    async function get(address, range) {
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await request(address, { credentials: 'omit', headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {}, signal: AbortSignal.timeout(60000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = new Uint8Array(await response.arrayBuffer());
          return { bytes: range && response.status !== 206 ? buffer.slice(range.start, range.end + 1) : buffer, finalUrl: response.url || address };
        } catch (error) { last = error; }
      }
      throw last;
    }
    let playlist, base = source;
    for (let depth = 0; depth < 5; depth++) {
      const result = await get(base); base = result.finalUrl;
      playlist = new TextDecoder().decode(result.bytes).trim().split(/\r?\n/).map(line => line.trim());
      if (playlist[0] !== '#EXTM3U') throw new Error('HLSプレイリストではありません。');
      const variants = [];
      for (let i = 0; i < playlist.length; i++) {
        if (playlist[i].startsWith('#EXT-X-STREAM-INF:')) {
          const attrs = attributes(playlist[i]);
          if (attrs.AUDIO && playlist.some(line => line.startsWith('#EXT-X-MEDIA:') && attributes(line)['GROUP-ID'] === attrs.AUDIO && attributes(line).URI)) continue;
          const path = playlist.slice(i + 1).find(line => line && !line.startsWith('#'));
          if (path) variants.push({ url: url(path, base), bandwidth: Number(attrs.BANDWIDTH) || 0 });
        }
      }
      if (!playlist.some(line => line.startsWith('#EXT-X-STREAM-INF:'))) break;
      if (!variants.length) throw new Error('音声が別配信のHLSには対応していません。');
      base = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0].url;
      playlist = null;
    }
    if (!playlist) throw new Error('HLSプレイリストの参照が深すぎます。');
    if (!playlist.includes('#EXT-X-ENDLIST')) throw new Error('ライブ配信の保存には対応していません。');
    const parts = [], keys = new Map();
    let key = null, sequence = 0, pendingRange = null, previousEnd = 0, previousUrl = '', fragmented = false, count = 0;
    const total = playlist.filter(line => line && !line.startsWith('#')).length;
    function range(spec, address) {
      if (!spec) return undefined;
      const [length, offset] = spec.split('@').map(Number);
      const start = offset ?? (previousUrl === address ? previousEnd : NaN);
      if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start) || start < 0) throw new Error('不正なHLSバイト範囲です。');
      previousEnd = start + length; previousUrl = address;
      return { start, end: previousEnd - 1 };
    }
    async function decode(bytes, index) {
      if (!key) return bytes;
      if (!keys.has(key.URI)) keys.set(key.URI, await crypto.subtle.importKey('raw', (await get(key.URI)).bytes, {name:'AES-CBC'}, false, ['decrypt']));
      let iv = new Uint8Array(16);
      if (key.IV) {
        const hex = key.IV.replace(/^0x/i, '').padStart(32, '0');
        if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error('不正な暗号化IVです。');
        iv = Uint8Array.from(hex.match(/../g).map(byte => parseInt(byte, 16)));
      } else { new DataView(iv.buffer).setBigUint64(8, BigInt(index)); }
      return new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC', iv}, keys.get(key.URI), bytes));
    }
    for (const line of playlist) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]);
      else if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = attributes(line);
        if (attrs.METHOD === 'NONE') key = null;
        else if (attrs.METHOD === 'AES-128' && (!attrs.KEYFORMAT || attrs.KEYFORMAT === 'identity')) key = {...attrs, URI:url(attrs.URI, base)};
        else throw new Error('この暗号化方式には対応していません。');
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = attributes(line), address = url(attrs.URI, base);
        if (key && !key.IV) throw new Error('初期化データのIVがありません。');
        parts.push(await decode((await get(address, range(attrs.BYTERANGE, address))).bytes, sequence)); fragmented = true;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice(17);
      else if (line && !line.startsWith('#')) {
        const address = url(line, base);
        parts.push(await decode((await get(address, range(pendingRange, address))).bytes, sequence++));
        pendingRange = null; progress(++count, total);
      }
    }
    if (!count) throw new Error('動画の分割データがありません。');
    return { blob: new Blob(parts, {type: fragmented ? 'video/mp4' : 'video/mp2t'}), extension: fragmented ? 'mp4' : 'ts' };
  }
  globalThis.TweetfileHLS = { assemble };
})();
