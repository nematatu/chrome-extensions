(() => {
  async function toMp4(blob) {
    const transmuxer = new muxjs.mp4.Transmuxer({remux:true});
    const parts = [];
    let error;
    transmuxer.on('data', segment => {
      if (!parts.length) parts.push(segment.initSegment);
      parts.push(segment.data);
    });
    transmuxer.on('error', detail => { error = new Error(detail?.message || 'MP4への変換に失敗しました。'); });
    try {
      transmuxer.push(new Uint8Array(await blob.arrayBuffer()));
      transmuxer.flush();
      if (error) throw error;
      if (parts.length < 2) throw new Error('MP4に変換できる映像・音声がありません。');
      return new Blob(parts, {type:'video/mp4'});
    } finally { transmuxer.dispose(); }
  }
  globalThis.TweetfileMP4 = {toMp4};
})();
