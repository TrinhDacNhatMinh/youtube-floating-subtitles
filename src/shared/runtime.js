(() => {
  'use strict';
  // Each content script owns its listeners/timers and releases them when an
  // extension reload invalidates the old isolated world.
  globalThis.SubtitleRuntime = {
    create(onDispose = () => {}) {
      let active = true;
      const cleanup = new Set();
      function dispose() {
        if (!active) return;
        active = false;
        for (const release of cleanup) { try { release(); } catch {} }
        cleanup.clear();
        onDispose();
      }
      function alive() {
        if (!active) return false;
        try { if (chrome.runtime.id) return true; } catch {}
        dispose(); return false;
      }
      function every(fn, ms) {
        if (!active) return;
        const timer = setInterval(() => { if (alive()) fn(); }, ms);
        cleanup.add(() => clearInterval(timer));
      }
      function listen(target, name, fn, options) {
        if (!active) return;
        target.addEventListener(name, fn, options);
        cleanup.add(() => target.removeEventListener(name, fn, options));
      }
      function apiListen(event, fn) {
        if (!alive()) return;
        try {
          event.addListener(fn);
          cleanup.add(() => event.removeListener(fn));
        } catch { dispose(); }
      }
      async function send(message) {
        if (!alive()) return null;
        try {
          // sendMessage can THROW before returning a Promise after a reload.
          return await chrome.runtime.sendMessage(message);
        } catch (error) {
          if (/extension context invalidated/i.test(error?.message || '')) dispose();
          else alive();
          return null;
        }
      }
      every(() => {}, 1000);
      return { alive, dispose, every, listen, apiListen, send };
    }
  };
})();
