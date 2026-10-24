(() => {
  'use strict';
  const ready = new Set();
  const modules = globalThis.MyToolsConfig.modules.filter(module => module.offscreen);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'my-tools:frame-ready') {
      const module = modules.find(value => value.id === message.module);
      if (module && sender.url === chrome.runtime.getURL(`modules/${module.id}/${module.offscreen}`)) ready.add(module.id);
      return;
    }
    if (message?.type === 'my-tools:offscreen-probe' && sender.url === chrome.runtime.getURL('worker.js')) respond({ ready: [...ready] });
  });
})();
