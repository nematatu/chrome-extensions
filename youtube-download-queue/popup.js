(() => {
  'use strict';
  const { MESSAGE } = YPQCore;
  const $ = id => document.getElementById(id);

  async function run(type, done) {
    $('refresh').disabled = true;
    $('message').textContent = '';
    let response;
    try { response = await chrome.runtime.sendMessage({ type }); }
    catch { response = { ok: false, error: '拡張機能に接続できませんでした。拡張機能を再読み込みしてください。' }; }
    $('refresh').disabled = false;
    $('message').dataset.tone = response?.ok ? 'ok' : 'error';
    $('message').textContent = response?.ok ? done : response?.error || '状態を取得できませんでした。';
    $('target').textContent = response?.ok ? response.target : '未接続';
    $('queued').textContent = response?.ok ? `キューに登録済み: ${response.queued}件` : '';
    $('downloaded').textContent = response?.ok ? `ダウンロード済み: ${response.downloaded}件` : '';
  }

  $('refresh').addEventListener('click', () => run(MESSAGE.REFRESH, '読み込み直しました。'));
  run(MESSAGE.STATUS, '');
})();
