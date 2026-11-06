(() => {
  'use strict';
  const native = globalThis.chrome;
  const client = globalThis.MyToolsClient;
  const settingsKey = 'unifiedSettingsV1';
  const migrationKey = 'my-tools:namespace-migration:v1';
  const presentationKey = 'my-tools:presentation:v1';
  const errors = [];
  const badges = new Map(), menuDefinitions = new Map(), filenameListeners = new Map();
  let config, settings, ready, startupError, boundary = Promise.resolve(), offscreenOpening;
  let presentationWrites = Promise.resolve();
  const downloadStarts = new Map();
  const downloadURL = value => { try { const url = new URL(value); url.hash = ''; return url.href; } catch { return String(value); } };
  function startDownload(module, options) {
    const url = downloadURL(options?.url);
    const previous = downloadStarts.get(url) || Promise.resolve();
    const started = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
      const finish = downloadId => {
        const error = native.runtime.lastError;
        if (error) { reject(new Error(error.message)); return; }
        resolve(downloadId);
      };
      try { native.downloads.download(options, finish); }
      catch (error) { reject(error); }
    }));
    downloadStarts.set(url, started);
    started.finally(() => { if (downloadStarts.get(url) === started) downloadStarts.delete(url); }).catch(() => {});
    return started;
  }
  const enabled = id => settings?.enabled[id] === true;
  const errorText = error => /[\u3040-\u30ff\u3400-\u9fff]/.test(error?.message || '') ? error.message : '設定または保存履歴の操作に失敗しました。拡張機能を読み込み直してください。';
  const report = text => { if (!errors.includes(text)) errors.push(text); if (errors.length > 20) errors.shift(); };
  function serialize(task) { const result = boundary.then(task); boundary = result.catch(() => {}); return result; }
  function persistPresentation() {
    const value = { badges: Object.fromEntries(badges), menus: Object.fromEntries(menuDefinitions) };
    presentationWrites = presentationWrites.catch(() => {}).then(() => native.storage.local.set({ [presentationKey]: value }));
    presentationWrites.catch(() => report('機能のバッジまたはメニューの状態を保存できませんでした。'));
    return presentationWrites;
  }
  async function restorePresentation() {
    const saved = (await native.storage.local.get(presentationKey))[presentationKey];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const module of config.modules) {
      const badge = saved.badges?.[module.id];
      if (badge && typeof badge.text === 'string') badges.set(module.id, badge);
    }
    for (const [id, definition] of Object.entries(saved.menus || {})) {
      if (config.modules.some(module => module.id === definition?.module) && id.startsWith(`my-tools:${definition.module}:`) && definition.value?.id === id) menuDefinitions.set(id, definition);
    }
  }
  function settingsFrom(value) {
    const defaults = Object.fromEntries(config.modules.map(module => [module.id, true]));
    if (value === undefined) return { version: 1, enabled: defaults };
    if (!value || value.version !== 1 || Object.keys(value).sort().join() !== 'enabled,version' || !value.enabled || Array.isArray(value.enabled) || typeof value.enabled !== 'object'
      || Object.entries(value.enabled).some(([id, state]) => (!Object.hasOwn(defaults, id) && !(id === 'instagramhq' && Object.hasOwn(defaults, 'instagram'))) || typeof state !== 'boolean')) throw new Error('保存された設定の形式が不正です。');
    const merged = { ...defaults, ...value.enabled };
    if (Object.hasOwn(merged, 'instagramhq')) {
      merged.instagram = value.enabled.instagram !== false || merged.instagramhq;
      delete merged.instagramhq;
    }
    return { version: 1, enabled: merged };
  }
  async function migrate() {
    await native.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const local = await native.storage.local.get(null);
    if (local[migrationKey]) return;
    const localCopies = {};
    for (const [name, value] of Object.entries(local)) {
      const id = ['savedMedia', 'savedHistoryMigratedV1'].includes(name) ? 'instagram' : /^gofileBulkDownload(?:IndexV2|PendingV2|V2:)/.test(name) ? 'gofile' : null;
      if (id && !Object.hasOwn(local, client.prefix(id) + name)) localCopies[client.prefix(id) + name] = value;
    }
    if (Object.keys(localCopies).length) await native.storage.local.set(localCopies);
    if (native.storage.session) {
      const session = await native.storage.session.get(null);
      if (Object.hasOwn(session, 'jobs') && !Object.hasOwn(session, client.prefix('instagram') + 'jobs')) await native.storage.session.set({ [client.prefix('instagram') + 'jobs']: session.jobs });
    }
    await native.storage.local.set({ [migrationKey]: true });
  }
  async function migrateInstagram() {
    const previous = (await native.storage.local.get(settingsKey))[settingsKey];
    const next = settingsFrom(previous);
    const oldKeys = ['enabled', 'rotateLive'].map(key => client.prefix('instagramhq') + key);
    const newKeys = ['downloadEnabled', 'enabled', 'rotateLive'].map(key => client.prefix('instagram') + key);
    const values = await native.storage.sync.get([...oldKeys, ...newKeys]);
    const legacy = Object.fromEntries(oldKeys.filter(key => Object.hasOwn(values, key)).map(key => [key.slice(client.prefix('instagramhq').length), values[key]]));
    if (!Object.hasOwn(previous?.enabled || {}, 'instagramhq') && !Object.keys(legacy).length) return next;
    const current = Object.fromEntries(newKeys.filter(key => Object.hasOwn(values, key)).map(key => [key.slice(client.prefix('instagram').length), values[key]]));
    const preferences = globalThis.MyToolsPortable.validate({ instagramhq: legacy, instagram: current }, previous?.enabled || {}).instagram;
    await native.storage.sync.set(Object.fromEntries(Object.entries(preferences).map(([key, value]) => [client.prefix('instagram') + key, value])));
    await native.storage.local.set({ [settingsKey]: next });
    await native.storage.sync.remove(oldKeys);
    return next;
  }
  async function reconcile(next) {
    const owned = new Set(config.registrations.map(script => script.id));
    const existing = await native.scripting.getRegisteredContentScripts();
    const ids = existing.filter(script => owned.has(script.id) || /^tools-instagramhq-\d+$/.test(script.id)).map(script => script.id);
    if (ids.length) await native.scripting.unregisterContentScripts({ ids });
    const wanted = config.registrations.filter(script => next.enabled[script.module]);
    const failed = [];
    let registered = 0;
    // Register one entry at a time. Chrome validates a whole registration batch
    // atomically, so one unsupported entry must not disable every page feature.
    for (const script of wanted) {
      const { module, ...registration } = script;
      try { await native.scripting.registerContentScripts([registration]); registered += 1; }
      catch { failed.push(script); }
    }
    if (failed.length) {
      const names = [...new Set(failed.map(script => config.modules.find(module => module.id === script.module)?.name || script.module))];
      const message = `一部の機能をページに登録できませんでした（${names.join('、')}）。拡張機能を読み込み直してください。`;
      if (!registered) throw new Error(message);
      report(message);
    }
  }
  async function updateBadge() {
    if (!native.action?.setBadgeText) return;
    const count = [...badges].filter(([id, value]) => enabled(id) && value.text).length;
    await native.action.setBadgeText({ text: count ? String(count) : '' });
    if (count) await native.action.setBadgeBackgroundColor({ color: '#475569' });
  }
  async function updateMenus(id) {
    for (const [physical, definition] of menuDefinitions) {
      if (definition.module !== id) continue;
      await new Promise(resolve => native.contextMenus.update(physical, { visible: enabled(id) }, () => { void native.runtime.lastError; resolve(); }));
    }
  }
  async function apply(next) {
    const previous = settings;
    try {
      await reconcile(next);
      await native.storage.local.set({ [settingsKey]: next });
      settings = next;
      await Promise.all(config.modules.map(module => updateMenus(module.id)));
      await updateBadge();
    } catch (error) { if (previous) await reconcile(previous).catch(() => {}); throw error; }
  }
  const injectionRuns = new Map();
  const injectionOrder = { document_start: 0, document_end: 1, document_idle: 2 };
  const injectionTarget = (tabId, script) => ({ tabId, ...(script.allFrames ? { allFrames: true } : {}) });
  const injectionFailure = error => new Error(/cannot access|missing host permission|extensions gallery|chrome:\/\//i.test(error?.message || '')
    ? 'このタブに機能を反映できませんでした。chrome://extensions の My Tools で「サイトへのアクセス」を「すべてのサイト」に変更してから、タブを再読み込みしてください。'
    : 'このタブに機能を反映できませんでした。タブを再読み込みしてください。');
  async function pageHasClient(tabId) {
    const [check] = await native.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: () => Boolean(globalThis.MyToolsClient)
    });
    return check?.result === true;
  }
  async function ensureTab(tab) {
    if (!Number.isInteger(tab?.id) || !tab.url || tab.status === 'loading') return { ok: true, matched: 0, injected: 0 };
    const matchesTab = script => script.matches.some(pattern => client.matches(pattern, tab.url))
      && !(script.excludeMatches || []).some(pattern => client.matches(pattern, tab.url));
    const direct = config.registrations.filter(script => settings.enabled[script.module] && matchesTab(script));
    const directIds = new Set(direct.map(script => script.id));
    const matchedModules = new Set(direct.map(script => script.module));
    // A module matched by its top-level page can own an all-frames registration
    // for an already-present embedded player/chat (KLTRA's Cbox). Inject those
    // frames too.
    const scripts = config.registrations.filter(script => settings.enabled[script.module]
      && (directIds.has(script.id) || (script.allFrames && matchedModules.has(script.module))));
    if (!scripts.length) return { ok: true, matched: 0, injected: 0 };
    if (injectionRuns.has(tab.id)) return injectionRuns.get(tab.id);
    const run = (async () => {
      if (await pageHasClient(tab.id)) return { ok: true, matched: scripts.length, injected: 0 };
      const ordered = [...scripts].sort((a, b) => (injectionOrder[a.runAt] ?? 2) - (injectionOrder[b.runAt] ?? 2)
        || (a.world === 'MAIN' ? 0 : 1) - (b.world === 'MAIN' ? 0 : 1));
      const css = new Set(), failed = [];
      let injected = 0;
      for (const script of ordered) {
        try {
          for (const file of script.css || []) {
            const key = `${script.allFrames ? 'all' : 'main'}:${file}`;
            if (css.has(key)) continue;
            css.add(key);
            await native.scripting.insertCSS({ target: injectionTarget(tab.id, script), files: [file] }).catch(() => {});
          }
          await native.scripting.executeScript({ target: injectionTarget(tab.id, script), world: script.world || 'ISOLATED', files: script.js });
          injected += 1;
        } catch (error) { failed.push({ script, error }); }
      }
      if (!injected && failed.length) throw injectionFailure(failed[0].error);
      return { ok: true, matched: scripts.length, injected, failed: failed.map(({ script }) => script.module) };
    })().finally(() => injectionRuns.delete(tab.id));
    injectionRuns.set(tab.id, run);
    return run;
  }
  async function ensureOpenTabs() {
    if (!native.tabs?.query) return;
    const tabs = await native.tabs.query({});
    const queue = tabs.filter(tab => Number.isInteger(tab.id) && tab.url && tab.status !== 'loading');
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (cursor < queue.length) await ensureTab(queue[cursor++]).catch(() => {});
    }));
  }
  const history = () => globalThis.IGMediaHistory;
  async function result() {
    return { ok: true, settings: JSON.parse(JSON.stringify(settings)), historyCount: history() ? Object.keys(await history().read()).length : 0,
      modules: config.modules, badges: Object.fromEntries(badges), errors: [...errors] };
  }
  async function portableRead() {
    const values = {};
    for (const [id, schema] of Object.entries(globalThis.MyToolsPortable?.schemas || {})) {
      const stored = await native.storage[schema.area].get(schema.keys.map(name => client.prefix(id) + name));
      const record = Object.fromEntries(Object.entries(stored).map(([name, value]) => [name.slice(client.prefix(id).length), value]));
      if (Object.keys(record).length) values[id] = record;
    }
    return globalThis.MyToolsPortable ? globalThis.MyToolsPortable.validate(values) : values;
  }
  async function manage(message) {
    if (message.type === 'my-tools:get') return result();
    if (message.type === 'my-tools:export') return { ok: true, backup: globalThis.MyToolsTransfer.makeBackup(settings, await history().read(), await portableRead()) };
    if (message.type === 'my-tools:set') {
      if (!config.modules.some(module => module.id === message.module) || typeof message.enabled !== 'boolean') throw new Error('設定の形式が不正です。');
      await apply({ version: 1, enabled: { ...settings.enabled, [message.module]: message.enabled } });
      return result();
    }
    if (message.type === 'my-tools:import') {
      const backup = globalThis.MyToolsTransfer.parseBackup(message.backup);
      await history().merge(backup.instagram.savedMedia);
      try {
        for (const [id, values] of Object.entries(backup.preferences || {})) {
          const schema = globalThis.MyToolsPortable.schemas[id];
          await native.storage[schema.area].set(Object.fromEntries(Object.entries(values).map(([name, value]) => [client.prefix(id) + name, value])));
        }
        if (backup.settings) await apply({ version: 1, enabled: { ...settings.enabled, ...backup.settings.enabled } });
      } catch { throw new Error('保存履歴は取り込みましたが、設定の反映に失敗しました。再度取り込んでください。'); }
      return result();
    }
    throw new Error('未対応の操作です。');
  }
  async function contentStorage(message, sender) {
    const module = config.modules.find(value => value.id === message.module);
    if (!module || !client.authorized(module, sender) || !sender.tab || message.area !== 'local' || !['get', 'set', 'remove'].includes(message.operation) || !Array.isArray(message.args) || message.args.length !== 1) throw new Error('保存設定へのアクセスは許可されていません。');
    const allowed = module.contentStorage?.local || [];
    const input = message.args[0];
    const keys = message.operation === 'set' ? Object.keys(input || {}) : typeof input === 'string' ? [input] : Array.isArray(input) ? input : input && typeof input === 'object' ? Object.keys(input) : [];
    if (!keys.length || keys.some(name => typeof name !== 'string' || !allowed.includes(name))) throw new Error('保存設定へのアクセスは許可されていません。');
    if (message.operation !== 'get' && !enabled(module.id)) throw new Error('この機能はオフになっています。');
    if (JSON.stringify(input).length > 2 * 1024 * 1024) throw new Error('保存設定のサイズが大きすぎます。');
    const adapter = moduleChrome(module.id);
    return { ok: true, value: await adapter.storage.local[message.operation](input) };
  }
  const offscreenModules = () => config.modules.filter(module => module.offscreen);
  async function liveOffscreen() {
    const contexts = await native.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [native.runtime.getURL('offscreen.html')] });
    if (!contexts.length) return [];
    try {
      const response = await native.runtime.sendMessage({ type: 'my-tools:offscreen-probe' });
      return response?.ready || [];
    } catch { return []; }
  }
  async function ensureOffscreen(module) {
    if (!module.offscreen) throw new Error('この機能はバックグラウンド処理に対応していません。');
    if (!offscreenOpening) offscreenOpening = (async () => {
      const contexts = await native.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [native.runtime.getURL('offscreen.html')] });
      if (!contexts.length) await native.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS', 'IFRAME_SCRIPTING'], justification: '各機能の動画処理を独立したフレームで実行するため' });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const alive = await liveOffscreen();
        if (offscreenModules().every(value => alive.includes(value.id))) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('動画処理画面を準備できませんでした。拡張機能を読み込み直してください。');
    })().finally(() => { offscreenOpening = undefined; });
    return offscreenOpening;
  }
  async function contexts(module, filter = {}) {
    if (!module.offscreen || filter.contextTypes && !filter.contextTypes.includes('OFFSCREEN_DOCUMENT') || filter.documentUrls && !filter.documentUrls.includes(native.runtime.getURL(`modules/${module.id}/${module.offscreen}`))) return [];
    return (await liveOffscreen()).includes(module.id) ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: native.runtime.getURL(`modules/${module.id}/${module.offscreen}`) }] : [];
  }
  function decorate(module, scoped, deliver) {
    const id = module.id;
    if (native.offscreen && module.offscreen) scoped.offscreen = Object.assign(Object.create(native.offscreen), {
      createDocument: value => {
        if (value?.url !== module.offscreen && value?.url !== native.runtime.getURL(`modules/${id}/${module.offscreen}`)) return Promise.reject(new Error('動画処理画面の指定が不正です。'));
        return ensureOffscreen(module);
      },
      hasDocument: async () => (await contexts(module)).length > 0,
      closeDocument: async () => undefined
    });
    if (native.downloads) {
      scoped.downloads = Object.create(native.downloads);
      scoped.downloads.download = (options, callback) => deliver(startDownload(module, options), callback);
      // Chrome dispatches onDeterminingFilename globally. Even a listener that
      // returns false or calls suggest() with no filename makes Chrome ignore
      // another extension's download filename, so My Tools must never register
      // the native event. Bundled modules pass filename to downloads.download;
      // keep their listener registrations as compatibility no-ops.
      scoped.downloads.onDeterminingFilename = {
        addListener(listener) { if (!filenameListeners.has(id)) filenameListeners.set(id, new Set()); filenameListeners.get(id).add(listener); },
        removeListener(listener) { filenameListeners.get(id)?.delete(listener); },
        hasListener(listener) { return Boolean(filenameListeners.get(id)?.has(listener)); }
      };
    }
    if (native.alarms) {
      const namespace = `my-tools:${id}:`;
      scoped.alarms = Object.create(native.alarms);
      for (const method of ['create', 'get', 'clear']) scoped.alarms[method] = (name, ...args) => native.alarms[method](namespace + name, ...args);
      scoped.alarms.onAlarm = { addListener(listener) { native.alarms.onAlarm.addListener(alarm => { if (alarm.name.startsWith(namespace)) return listener({ ...alarm, name: alarm.name.slice(namespace.length) }); }); } };
    }
    if (native.action) {
      scoped.action = Object.create(native.action);
      for (const method of ['setBadgeText', 'setBadgeBackgroundColor', 'setBadgeTextColor']) scoped.action[method] = (value, callback) => {
        badges.set(id, { ...badges.get(id), ...value });
        const promise = persistPresentation().then(updateBadge);
        return deliver(promise, callback);
      };
    }
    if (native.scripting) {
      scoped.scripting = Object.create(native.scripting);
      scoped.scripting.executeScript = (injection, callback) => {
        let value = injection;
        if (value && typeof value === 'object' && Array.isArray(value.files)) {
          const prefix = `modules/${id}/`;
          const files = value.files.map(file => typeof file === 'string' && !file.startsWith('modules/') && file !== 'config.js' && file !== 'client.js' ? prefix + file : file);
          value = { ...value, files: value.world === 'MAIN' ? files : [...new Set(['config.js', 'client.js', ...files])] };
        }
        return deliver(Promise.resolve().then(() => native.scripting.executeScript(value)), callback);
      };
    }
    if (native.contextMenus) {
      scoped.contextMenus = Object.create(native.contextMenus);
      const menuPrefix = `my-tools:${id}:`;
      scoped.contextMenus.create = (value, callback) => {
        const menuId = menuPrefix + value.id;
        const definition = { ...value, id: menuId, ...(value.parentId ? { parentId: menuPrefix + value.parentId } : {}), visible: enabled(id) };
        menuDefinitions.set(menuId, { module: id, value: definition });
        return native.contextMenus.create(definition, () => {
          if (native.runtime.lastError) menuDefinitions.delete(menuId);
          else void persistPresentation();
          callback?.();
        });
      };
      scoped.contextMenus.removeAll = callback => {
        const ids = [...menuDefinitions].filter(([, value]) => value.module === id).map(([key]) => key);
        const completion = Promise.allSettled(ids.map(menuId => new Promise((resolve, reject) => native.contextMenus.remove(menuId, () => {
          const error = native.runtime.lastError;
          if (error) reject(new Error(error.message));
          else { menuDefinitions.delete(menuId); resolve(); }
        })))).then(async results => {
          await persistPresentation();
          const failure = results.find(value => value.status === 'rejected');
          if (failure) throw failure.reason;
        });
        return deliver(completion, callback);
      };
      scoped.contextMenus.onClicked = { addListener(listener) { native.contextMenus.onClicked.addListener((info, tab) => {
        if (!enabled(id) || typeof info.menuItemId !== 'string' || !info.menuItemId.startsWith(menuPrefix)) return;
        return listener({ ...info, menuItemId: info.menuItemId.slice(menuPrefix.length), ...(info.parentMenuItemId ? { parentMenuItemId: info.parentMenuItemId.slice(menuPrefix.length) } : {}) }, tab);
      }); } };
    }
    if (native.webRequest) {
      scoped.webRequest = Object.create(native.webRequest);
      for (const name of ['onBeforeRequest', 'onHeadersReceived']) {
        const event = native.webRequest[name];
        if (!event) continue;
        scoped.webRequest[name] = { addListener(listener, ...args) { event.addListener((...eventArgs) => { if (enabled(id)) return listener(...eventArgs); }, ...args); } };
      }
    }
    for (const name of ['onInstalled', 'onStartup']) if (native.runtime[name]) scoped.runtime[name] = {
      addListener(listener) { native.runtime[name].addListener((...args) => { ready.then(() => { if (id !== 'sushida' || enabled(id)) return listener(...args); }).catch(() => report('機能の初期化に失敗しました。拡張機能を読み込み直してください。')); }); }
    };
  }
  const adapters = new Map();
  function moduleChrome(id) {
    if (!adapters.has(id)) adapters.set(id, client.create(id, { worker: true, modules: config.modules, hooks: {
      ready: () => ready,
      contexts,
      decorate,
      dispatch(module, listeners, message, sender, respond) {
        function invoke(closeUnclaimed) {
          let asynchronous = false, responded = false;
          const reply = value => { if (!responded) { responded = true; respond(value); } };
          for (const listener of listeners) {
            const returned = listener(message, sender, reply);
            if (returned === true) asynchronous = true;
            else if (returned && typeof returned.then === 'function') { asynchronous = true; returned.then(reply, error => reply({ ok: false, error: errorText(error) })); }
          }
          if (closeUnclaimed && !asynchronous && !responded) reply(undefined);
          return asynchronous || undefined;
        }
        if (!module.startTypes.includes(message?.type)) return invoke(false);
        serialize(async () => {
          if (startupError) throw startupError;
          if (!enabled(id)) { respond({ ok: false, error: 'この機能はオフになっています。設定でオンにしてください。' }); return; }
          invoke(true);
        }).catch(error => respond({ ok: false, error: errorText(error) }));
        return true;
      }
    } }));
    return adapters.get(id);
  }
  function boot(value) {
    config = value;
    globalThis.MyToolsConfig = value;
    globalThis.MyToolsTransfer?.configure?.(value.modules);
    ready = serialize(async () => {
      await migrate();
      await restorePresentation();
      await apply(await migrateInstagram());
    });
    ready.catch(error => { startupError = error; });
    const repairOpenTabs = () => ready.then(() => ensureOpenTabs()).catch(() => {});
    native.runtime.onInstalled?.addListener(repairOpenTabs);
    native.runtime.onStartup?.addListener(repairOpenTabs);
    ready.then(() => ensureOpenTabs()).catch(() => {});
    native.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type === 'my-tools:download') {
        const module = config.modules.find(value => value.id === message.module);
        let extensionPage = false;
        try {
          const senderURL = new URL(sender.url), moduleURL = new URL(native.runtime.getURL(`modules/${module?.id}/`));
          extensionPage = sender.id === native.runtime.id && senderURL.protocol === moduleURL.protocol && senderURL.host === moduleURL.host && senderURL.pathname.startsWith(moduleURL.pathname);
        } catch {}
        if (!module || !extensionPage) { respond({ ok: false, error: 'この画面からのダウンロードは許可されていません。' }); return; }
        ready.then(() => startDownload(module, message.options)).then(downloadId => respond({ ok: true, downloadId }), error => respond({ ok: false, error: error.message || 'ダウンロードを開始できませんでした。' }));
        return true;
      }
      if (message?.type === 'my-tools:storage') {
        ready.then(() => contentStorage(message, sender)).then(respond, error => respond({ ok: false, error: errorText(error) })); return true;
      }
      const management = ['my-tools:get', 'my-tools:set', 'my-tools:export', 'my-tools:import', 'my-tools:ensure-active'];
      if (typeof message?.type !== 'string' || !management.includes(message.type)) return;
      if (sender.id !== native.runtime.id || sender.url !== native.runtime.getURL('popup.html')) { respond({ ok: false, error: 'この画面からの操作は許可されていません。' }); return; }
      if (message.type === 'my-tools:ensure-active') {
        serialize(async () => {
          if (startupError) throw startupError;
          const [tab] = await native.tabs.query({ active: true, lastFocusedWindow: true });
          try { return await ensureTab(tab); }
          catch (error) { throw error?.message?.includes('このタブに機能を反映できませんでした') ? error : injectionFailure(error); }
        }).then(respond, error => respond({ ok: false, error: errorText(error) }));
        return true;
      }
      serialize(async () => {
        if (startupError) throw startupError;
        const value = await manage(message);
        if (message.type === 'my-tools:set' || message.type === 'my-tools:import') void ensureOpenTabs().catch(() => {});
        return value;
      }).then(respond, error => respond({ ok: false, error: errorText(error) }));
      return true;
    });
    native.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !native.tabs) return;
      for (const module of config.modules) {
        const subset = Object.fromEntries((module.contentStorage?.local || []).filter(name => Object.hasOwn(changes, client.prefix(module.id) + name)).map(name => [name, changes[client.prefix(module.id) + name]]));
        if (!Object.keys(subset).length) continue;
        native.tabs.query({ url: module.matches }).then(tabs => Promise.all(tabs.filter(tab => Number.isInteger(tab.id) && module.matches.some(pattern => client.matches(pattern, tab.url))).map(tab => native.tabs.sendMessage(tab.id, { type: 'my-tools:storage-changed', module: module.id, area, changes: subset }).catch(() => {})))).catch(() => {});
      }
    });
    native.commands?.onCommand.addListener(command => {
      if (command === 'birdscore-open') ready.then(() => { if (enabled('birdscore')) return native.windows.create({ url: native.runtime.getURL('modules/birdscore/popup.html?mode=window'), type: 'popup', width: 1000, height: 780 }); }).catch(() => report('Birdscoreの画面を開けませんでした。'));
    });
    return ready;
  }
  globalThis.MyToolsRuntime = { boot, moduleChrome };
})();
