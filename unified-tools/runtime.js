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
  const pendingDownloads = new Map(), namedDownloads = new Map(), downloadStarts = new Map();
  const downloadURL = value => { try { const url = new URL(value); url.hash = ''; return url.href; } catch { return String(value); } };
  function startDownload(module, options) {
    const url = downloadURL(options?.url);
    const previous = downloadStarts.get(url) || Promise.resolve();
    const started = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
      const request = { module: module.id, options, finished: false };
      pendingDownloads.set(url, request);
      const finish = downloadId => {
        const error = native.runtime.lastError;
        if (pendingDownloads.get(url) === request) pendingDownloads.delete(url);
        if (error) { reject(new Error(error.message)); return; }
        if (!request.finished && Number.isInteger(downloadId)) namedDownloads.set(downloadId, request);
        resolve(downloadId);
      };
      try { native.downloads.download(options, finish); }
      catch (error) { pendingDownloads.delete(url); reject(error); }
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
      || Object.entries(value.enabled).some(([id, state]) => !Object.hasOwn(defaults, id) || typeof state !== 'boolean')) throw new Error('保存された設定の形式が不正です。');
    return { version: 1, enabled: { ...defaults, ...value.enabled } };
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
  async function reconcile(next) {
    const owned = new Set(config.registrations.map(script => script.id));
    const existing = await native.scripting.getRegisteredContentScripts();
    const ids = existing.filter(script => owned.has(script.id)).map(script => script.id);
    if (ids.length) await native.scripting.unregisterContentScripts({ ids });
    const wanted = config.registrations.filter(script => next.enabled[script.module]).map(({ module, ...script }) => script);
    if (wanted.length) await native.scripting.registerContentScripts(wanted);
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
  function filenameBroker(item, suggest) {
    const request = item.byExtensionId === native.runtime.id ? namedDownloads.get(item.id) || pendingDownloads.get(downloadURL(item.url)) : undefined;
    const claims = [];
    const tasks = [...filenameListeners].flatMap(([id, listeners]) => [...listeners].map(listener => new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (value !== undefined) claims.push({ id, value });
        resolve();
      };
      const timer = setTimeout(() => { report('保存名の確認が時間内に完了しませんでした。'); finish(); }, 5000);
      try { if (listener(item, finish) !== true) finish(); } catch { report('保存名の確認に失敗しました。'); finish(); }
    })));
    Promise.all(tasks).then(() => {
      const unique = [...new Map(claims.map(claim => [JSON.stringify(claim.value), claim.value])).values()];
      if (unique.length > 1) { report('複数の機能が保存名を指定したため、Chromeの既定の保存名を使用しました。'); suggest(); }
      else if (unique.length) suggest(unique[0]);
      else if (request?.options?.filename) suggest({ filename: request.options.filename, ...(request.options.conflictAction ? { conflictAction: request.options.conflictAction } : {}) });
      else suggest();
      if (request) { request.finished = true; namedDownloads.delete(item.id); }
    });
    return true;
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
    if (native.downloads?.onDeterminingFilename) {
      scoped.downloads = Object.create(native.downloads);
      scoped.downloads.download = (options, callback) => deliver(startDownload(module, options), callback);
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
      for (const method of ['setBadgeText', 'setBadgeBackgroundColor']) scoped.action[method] = (value, callback) => {
        badges.set(id, { ...badges.get(id), ...value });
        const promise = persistPresentation().then(updateBadge);
        return deliver(promise, callback);
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
      scoped.webRequest.onBeforeRequest = { addListener(listener, ...args) { native.webRequest.onBeforeRequest.addListener((...event) => { if (enabled(id)) return listener(...event); }, ...args); } };
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
      await apply(settingsFrom((await native.storage.local.get(settingsKey))[settingsKey]));
    });
    ready.catch(error => { startupError = error; });
    native.downloads?.onDeterminingFilename?.addListener(filenameBroker);
    native.downloads?.onChanged?.addListener(delta => {
      if (['complete', 'interrupted'].includes(delta.state?.current) || delta.error) namedDownloads.delete(delta.id);
    });
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
      if (typeof message?.type !== 'string' || !['my-tools:get', 'my-tools:set', 'my-tools:export', 'my-tools:import'].includes(message.type)) return;
      if (sender.id !== native.runtime.id || sender.url !== native.runtime.getURL('popup.html')) { respond({ ok: false, error: 'この画面からの操作は許可されていません。' }); return; }
      serialize(async () => { if (startupError) throw startupError; return manage(message); }).then(respond, error => respond({ ok: false, error: errorText(error) }));
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
