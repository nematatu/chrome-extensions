(() => {
  'use strict';
  if (globalThis.MyToolsClient) return;
  const native = globalThis.chrome;
  const adapters = new Map();
  let callbackError;
  const prefix = id => `my-tools:module:${id}:`;
  const own = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
  function matches(pattern, value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      if (pattern === '<all_urls>') return true;
      const parts = pattern.match(/^(\*|https?|file):\/\/([^/]+)(\/.*)$/);
      if (!parts || (parts[1] !== '*' && `${parts[1]}:` !== url.protocol)) return false;
      const host = parts[2];
      if (host !== '*' && !(host.startsWith('*.') ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.host === host)) return false;
      return new RegExp(`^${parts[3].split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(url.pathname + url.search);
    } catch { return false; }
  }
  function authorized(module, sender, allowWorker = false) {
    if (sender?.id !== native.runtime.id || typeof sender.url !== 'string') return false;
    try {
      const url = new URL(sender.url);
      const base = new URL(native.runtime.getURL(`modules/${module.id}/`));
      if (url.origin === base.origin && url.protocol === base.protocol && url.host === base.host && url.pathname.startsWith(base.pathname)) return true;
      if (allowWorker && sender.url === native.runtime.getURL('worker.js')) return true;
      return Boolean(sender.tab) && (module.matches || []).some(pattern => matches(pattern, sender.url));
    } catch { return false; }
  }
  function deliver(promise, callback, transform = value => value) {
    if (typeof callback !== 'function') return promise.then(transform);
    promise.then(value => callback(transform(value)), error => {
      callbackError = { message: error.message || '操作に失敗しました。' };
      try { callback(); } finally { callbackError = undefined; }
    });
  }
  function create(id, options = {}) {
    const module = (globalThis.MyToolsConfig?.modules || options.modules || []).find(value => value.id === id);
    if (!module) throw new Error(`Unknown module ${id}`);
    const hooks = options.hooks || {};
    const worker = Boolean(options.worker);
    const extensionPage = worker || globalThis.location?.protocol === 'chrome-extension:';
    const runtime = Object.create(native.runtime);
    Object.defineProperty(runtime, 'lastError', { get: () => callbackError || native.runtime.lastError });
    runtime.getURL = path => path === '' ? native.runtime.getURL('') : native.runtime.getURL(`modules/${id}/${path}`);
    runtime.sendMessage = (...args) => {
      const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
      if (typeof args[0] === 'string') throw new Error('外部拡張への通信には対応していません。');
      const wrapped = { toolModule: id, payload: args[0] };
      if (callback) return native.runtime.sendMessage(wrapped, ...(args[1] ? [args[1]] : []), callback);
      return native.runtime.sendMessage(wrapped, ...(args[1] ? [args[1]] : []));
    };
    const messageListeners = new Set();
    let messageInstalled = false;
    runtime.onMessage = {
      addListener(listener) {
        messageListeners.add(listener);
        if (messageInstalled) return;
        messageInstalled = true;
        native.runtime.onMessage.addListener((message, sender, respond) => {
          const managerBulkSave = !worker && id === 'instagram' && message?.payload?.type === 'ig-download-page'
            && sender?.id === native.runtime.id && sender.url === native.runtime.getURL('popup.html');
          if (message?.toolModule !== id || !managerBulkSave && !authorized(module, sender, !worker)) return;
          if (worker && hooks.dispatch) return hooks.dispatch(module, [...messageListeners], message.payload, sender, respond);
          let asynchronous = false;
          for (const callback of messageListeners) if (callback(message.payload, sender, respond) === true) asynchronous = true;
          return asynchronous || undefined;
        });
      },
      removeListener(listener) { messageListeners.delete(listener); },
      hasListener(listener) { return messageListeners.has(listener); }
    };
    if (worker && hooks.contexts) runtime.getContexts = filter => hooks.contexts(module, filter);
    const storage = Object.create(native.storage || {});
    for (const area of ['local', 'sync', 'session']) {
      const source = native.storage?.[area];
      if (!source) continue;
      const scoped = Object.create(source);
      const physical = name => prefix(id) + name;
      const names = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : null;
      function storageCall(operation, args, callback) {
        if (!extensionPage && area === 'local') {
          return deliver(native.runtime.sendMessage({ type: 'my-tools:storage', module: id, area, operation, args }).then(response => {
            if (!response?.ok) throw new Error(response?.error || '保存設定を操作できませんでした。');
            return response.value;
          }), callback);
        }
        const run = () => new Promise((resolve, reject) => {
          const finish = value => {
            const error = native.runtime.lastError;
            if (error) reject(new Error(error.message)); else resolve(value);
          };
          if (operation === 'get') {
            const query = args[0];
            let request = names(query)?.map(physical) ?? null;
            if (query && !Array.isArray(query) && typeof query === 'object') request = Object.fromEntries(Object.entries(query).map(([name, value]) => [physical(name), value]));
            source.get(request, value => {
              if (native.runtime.lastError) return finish();
              finish(Object.fromEntries(Object.entries(value || {}).filter(([name]) => name.startsWith(prefix(id))).map(([name, value]) => [name.slice(prefix(id).length), value])));
            });
          } else if (operation === 'set') source.set(Object.fromEntries(Object.entries(args[0]).map(([name, value]) => [physical(name), value])), finish);
          else if (operation === 'remove') source.remove((names(args[0]) || []).map(physical), finish);
          else if (operation === 'clear') source.get(null, value => {
            if (native.runtime.lastError) return finish();
            source.remove(Object.keys(value || {}).filter(name => name.startsWith(prefix(id))), finish);
          });
          else if (operation === 'getBytesInUse') {
            const requested = names(args[0]);
            if (requested) source.getBytesInUse(requested.map(physical), finish);
            else source.get(null, value => {
              if (native.runtime.lastError) return finish();
              source.getBytesInUse(Object.keys(value || {}).filter(name => name.startsWith(prefix(id))), finish);
            });
          }
        });
        return deliver(Promise.resolve(hooks.ready?.()).then(run), callback);
      }
      scoped.get = (query = null, callback) => typeof query === 'function' ? storageCall('get', [null], query) : storageCall('get', [query], callback);
      for (const operation of ['set', 'remove', 'getBytesInUse']) scoped[operation] = (value, callback) => storageCall(operation, [value ?? null], callback);
      scoped.clear = callback => storageCall('clear', [], callback);
      if (source.setAccessLevel) scoped.setAccessLevel = (value, callback) => {
        if (area === 'local' && value?.accessLevel !== 'TRUSTED_CONTEXTS') return deliver(Promise.reject(new Error('保存領域の公開範囲は変更できません。')), callback);
        return deliver(Promise.resolve(hooks.ready?.()).then(() => source.setAccessLevel(value)), callback);
      };
      storage[area] = scoped;
    }
    const storageListeners = new Map();
    if (!extensionPage) native.runtime.onMessage.addListener((message, sender) => {
      if (message?.type !== 'my-tools:storage-changed' || message.module !== id || sender.id !== native.runtime.id || sender.url !== native.runtime.getURL('worker.js')) return;
      for (const listener of storageListeners.keys()) listener(message.changes, message.area);
    });
    storage.onChanged = {
      addListener(listener) {
        if (storageListeners.has(listener)) return;
        const wrapped = (changes, area) => {
          const subset = Object.fromEntries(Object.entries(changes).filter(([name]) => name.startsWith(prefix(id))).map(([name, value]) => [name.slice(prefix(id).length), value]));
          if (Object.keys(subset).length) listener(subset, area);
        };
        storageListeners.set(listener, wrapped); native.storage.onChanged.addListener(wrapped);
      },
      removeListener(listener) { const wrapped = storageListeners.get(listener); if (wrapped) native.storage.onChanged.removeListener(wrapped); storageListeners.delete(listener); },
      hasListener(listener) { return storageListeners.has(listener); }
    };
    const scoped = Object.assign(Object.create(native), { runtime, storage });
    if (native.tabs) {
      scoped.tabs = Object.create(native.tabs);
      scoped.tabs.sendMessage = (tabId, message, ...rest) => native.tabs.sendMessage(tabId, { toolModule: id, payload: message }, ...rest);
    }
    if (!worker && extensionPage && native.downloads) {
      scoped.downloads = Object.create(native.downloads);
      scoped.downloads.download = (options, callback) => deliver(native.runtime.sendMessage({ type: 'my-tools:download', module: id, options }).then(response => {
        if (!response?.ok) throw new Error(response?.error || 'ダウンロードを開始できませんでした。');
        return response.downloadId;
      }), callback);
    }
    if (worker && hooks.decorate) hooks.decorate(module, scoped, deliver);
    return scoped;
  }
  globalThis.MyToolsClient = { create, prefix, matches, authorized, moduleChrome(id) { if (!adapters.has(id)) adapters.set(id, create(id)); return adapters.get(id); } };
  if (globalThis.document && globalThis.location?.pathname.startsWith('/modules/')) {
    const id = globalThis.location.pathname.split('/')[2];
    const ready = () => native.runtime.sendMessage({ type: 'my-tools:frame-ready', module: id }).catch(() => {});
    if (document.readyState === 'complete') ready(); else globalThis.addEventListener('load', ready, { once: true });
  }
})();
