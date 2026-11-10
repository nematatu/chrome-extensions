import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Tabs from '@radix-ui/react-tabs';
import * as Switch from '@radix-ui/react-switch';
import { ArrowLeft, ArrowUpRight, Check, Download, Search, SlidersHorizontal, Upload, X } from 'lucide-react';
import './popup.css';

const modules = globalThis.MyToolsConfig.modules;
const presentation = {
  instagram: ['better-ig', 'SNS'],
  xhashtags: ['X ハッシュタグ補完', 'SNS'],
  ytqueue: ['YouTube ダウンロードキュー', '動画・ファイル'],
  gofile: ['Gofile 一括保存', '動画・ファイル'],
  pagemedia: ['ページ内メディア保存', '動画・ファイル'],
  tweetfile: ['Tweetfile 動画保存', '動画・ファイル'],
  stripchat: ['Stripchat プレビュー', '動画・ファイル'],
  mediasaver: ['Media Saver', '動画・ファイル'],
  googlephotos: ['Google フォト 並べ替え', '写真'],
  r2: ['R2 画像プレビュー', '写真'],
  badspi: ['バドスピ 画像保存', 'スポーツ'],
  birdscore: ['Birdscore 試合速報', 'スポーツ'],
  inhighlinks: ['インハイTV 試合リンク', 'スポーツ'],
  inhighskip: ['インハイTV スキップ', 'スポーツ'],
  koutairen: ['高体連 写真送り', 'スポーツ'],
  smashnet: ['SMASH and NET 写真', 'スポーツ'],
  kltra: ['KLTRA 弾幕チャット', 'その他'],
  momoniji: ['Momoniji 漫画', 'その他'],
  sushida: ['寿司打 記録', 'その他'],
};
const groups = ['SNS', '動画・ファイル', '写真', 'スポーツ', 'その他'];

async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || '処理を完了できませんでした。拡張機能を読み込み直してください。');
  return result;
}

function App() {
  const [view, setView] = useState('tools');
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState(null);
  const lock = useRef(true);
  const searchRef = useRef(null);
  const backRef = useRef(null);
  const openerRef = useRef(null);
  const selected = modules.find(module => view === `module.${module.id}`);
  const settings = snapshot?.settings;
  const disabled = busy || !settings;
  const filtered = modules.filter(module => `${presentation[module.id]?.[0] || ''} ${module.name} ${module.id}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const theme = () => document.documentElement.classList.toggle('dark', media.matches);
    theme();
    media.addEventListener('change', theme);
    let active = true;
    request('my-tools:get').then(result => {
      if (!active) return;
      setSnapshot(result);
      request('my-tools:ensure-active').catch(error => {
        if (active) setNotice({ error: true, text: error.message });
      });
    }).catch(error => {
      if (active) setNotice({ error: true, text: error.message });
    }).finally(() => { if (active) { lock.current = false; setBusy(false); } });
    return () => { active = false; media.removeEventListener('change', theme); };
  }, []);

  useEffect(() => {
    if (selected) backRef.current?.focus();
  }, [selected]);

  async function action(work) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const text = await work();
      if (text) setNotice({ text });
    } catch (error) {
      setNotice({ error: true, text: error.message || '処理を完了できませんでした。' });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function changeModule(module, enabled) {
    void action(async () => {
      const previous = snapshot;
      setSnapshot({ ...snapshot, settings: { ...settings, enabled: { ...settings.enabled, [module.id]: enabled } } });
      try { setSnapshot(await request('my-tools:set', { module: module.id, enabled })); }
      catch (error) { setSnapshot(previous); throw error; }
      return '設定を保存しました。対象ページを再読み込みしてください。';
    });
  }

  function closeModule() {
    setView('tools');
    requestAnimationFrame(() => (document.querySelector(`.module-open[data-module="${openerRef.current}"]`) || searchRef.current)?.focus());
  }

  function exportBackup() {
    void action(async () => {
      const { backup } = await request('my-tools:export');
      const value = globalThis.MyToolsTransfer.parseBackup(backup);
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'my-tools-backup.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return 'バックアップを書き出しました。';
    });
  }

  function importBackup(event) {
    const input = event.currentTarget;
    const file = input.files[0];
    if (!file) return;
    void action(async () => {
      if (file.size > globalThis.MyToolsTransfer.MAX_BYTES) throw new Error('移行ファイルは20MiB以下にしてください。');
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error('JSONファイルを読み込めませんでした。'); }
      const backup = globalThis.MyToolsTransfer.parseBackup(parsed);
      setSnapshot(await request('my-tools:import', { backup }));
      return '履歴を追加しました。設定を復元した場合は対象ページを再読み込みしてください。';
    }).finally(() => { input.value = ''; });
  }

  function saveInstagram() {
    void action(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || new URL(tab.url || 'about:blank').origin !== 'https://www.instagram.com') throw new Error('Instagramのタブで実行してください。');
      await chrome.tabs.sendMessage(tab.id, { toolModule: 'instagram', payload: { type: 'ig-download-page' } });
      return 'Instagram画面の右下で進捗をご確認ください。';
    });
  }

  return <main aria-busy={busy}>
    <header className="app-header">
      <h1>My Tools</h1>
      <button id="options" className="icon-button" type="button" aria-label="設定を大きな画面で開く" title="大きな画面で開く" onClick={() => void chrome.runtime.openOptionsPage()}><ArrowUpRight aria-hidden="true" /></button>
    </header>
    {selected ? <section id="module-panel" aria-labelledby="module-title">
      <div className="panel-header"><button id="module-back" ref={backRef} className="icon-button" type="button" aria-label="機能一覧に戻る" onClick={closeModule}><ArrowLeft aria-hidden="true" /></button><h2 id="module-title">{presentation[selected.id]?.[0] || selected.name}</h2></div>
      <iframe id="module-frame" title={selected.name} src={chrome.runtime.getURL(`modules/${selected.id}/${selected.popup || selected.options}`)} />
    </section> : <Tabs.Root value={view} onValueChange={setView}>
      <Tabs.List className="tabs" aria-label="設定の種類">
        <Tabs.Trigger className="tab" value="tools">機能</Tabs.Trigger>
        <Tabs.Trigger className="tab" value="backup">バックアップ</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="tools" className="tab-content">
        <div className="search-bar"><Search aria-hidden="true" /><input id="search" ref={searchRef} type="search" placeholder="機能を探す" aria-label="機能を探す" autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button clear-search" type="button" aria-label="検索をクリア" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X aria-hidden="true" /></button>}</div>
        <div className="list-summary"><span>{query ? `${filtered.length}件` : ''}</span><span id="module-count">{modules.filter(module => settings?.enabled[module.id]).length} / {modules.length} 有効</span></div>
        <div id="modules" className="module-list">
          {groups.map(group => {
            const items = filtered.filter(module => presentation[module.id]?.[1] === group);
            if (!items.length) return null;
            return <section className="module-group" key={group} aria-label={group}><h2>{group}</h2>{items.map(module => {
              const enabled = settings?.enabled[module.id] === true;
              const badge = enabled ? snapshot?.badges?.[module.id]?.text : '';
              const entry = module.popup || module.options;
              const openDisabled = disabled || (!module.worker && !module.matches?.length && !enabled);
              return <div className="module" key={module.id} data-name={`${module.name} ${module.id}`.toLowerCase()}>
                <label className="module-name" htmlFor={module.id} title={module.name}>{presentation[module.id][0]}</label>
                <div className="module-controls">
                  {badge && <span id={`badge-${module.id}`} className="module-badge" aria-label={`${module.name}の通知`}>{badge}</span>}
                  {entry && <button className="module-open icon-button" type="button" data-module={module.id} disabled={openDisabled} aria-label={`${module.name}の画面を開く`} title="設定を開く" onClick={() => { openerRef.current = module.id; setView(`module.${module.id}`); }}><SlidersHorizontal aria-hidden="true" /></button>}
                  <Switch.Root id={module.id} className="switch" checked={enabled} onCheckedChange={value => changeModule(module, value)} disabled={disabled} aria-label={`${module.name}を有効にする`}><Switch.Thumb className="switch-thumb" /></Switch.Root>
                </div>
              </div>;
            })}</section>;
          })}
          {!filtered.length && <p id="no-results" className="empty-state">一致する機能はありません。</p>}
        </div>
        <div className="tools-footer"><button id="save" className="button primary" type="button" disabled={disabled || !settings?.enabled.instagram} onClick={saveInstagram}><Download aria-hidden="true" />Instagramの投稿を一括保存</button></div>
      </Tabs.Content>
      <Tabs.Content value="backup" className="backup tab-content">
        <h2>設定と履歴</h2>
        <p id="history-count">Instagramの保存履歴 <strong>{snapshot?.historyCount ?? 0}件</strong></p>
        <div className="backup-actions"><button id="export" className="button primary" type="button" disabled={disabled} onClick={exportBackup}><Download aria-hidden="true" />設定・履歴を書き出す</button><label className={`file-button button${disabled ? ' disabled' : ''}`}><Upload aria-hidden="true" />読み込む<input type="file" id="import-file" aria-label="バックアップを読み込む" accept="application/json,.json" disabled={disabled} onChange={importBackup} /></label></div>
        <div className="backup-notes"><p>履歴は既存分を残して追加します。元のInstagram拡張の履歴も読み込めます。</p><p>ログイン情報、保存ファイル、進行中の処理は含みません。</p></div>
      </Tabs.Content>
    </Tabs.Root>}
    {(busy || notice) && <p id="status" role={notice?.error ? 'alert' : 'status'} aria-live="polite" className={`status${notice?.error ? ' error' : ''}`}>{!busy && !notice?.error && <Check aria-hidden="true" />}{busy ? '読み込み中…' : notice.text}</p>}
    {!!snapshot?.errors?.length && <p id="diagnostics" role="alert">{snapshot.errors.join(' / ')}</p>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
