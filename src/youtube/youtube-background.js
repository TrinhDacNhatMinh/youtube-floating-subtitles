(() => {
  'use strict';
  if (window.SubtitleBackground) return;
  // Used only while the extension must read rendered CC. YouTube's caption
  // renderer may stop on hidden tabs even though the media keeps playing.
  const hiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
  const actualHidden = () => hiddenGetter.call(document);
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const frames = new Map();
  let enabled = false, next = 0, allowVisibility = false, previousHidden, previousVisibility;
  function run(id, time) {
    const frame = frames.get(id);
    if (!frame) return;
    frames.delete(id);
    Reflect.apply(frame.callback, window, [time]);
  }
  function cancel(frame) {
    if (frame.timer) clearTimeout(frame.handle);
    else nativeCancel(frame.handle);
  }
  function schedule(id, frame) {
    frame.timer = enabled && actualHidden();
    frame.handle = frame.timer ? setTimeout(() => run(id, performance.now()), 200) : nativeRequest(time => run(id, time));
  }
  function reschedule() {
    for (const [id, frame] of frames) { cancel(frame); schedule(id, frame); }
  }
  window.requestAnimationFrame = callback => {
    if (typeof callback !== 'function') return nativeRequest(callback);
    const id = --next, frame = { callback };
    frames.set(id, frame); schedule(id, frame); return id;
  };
  window.cancelAnimationFrame = id => {
    const frame = frames.get(id);
    if (!frame) { nativeCancel(id); return; }
    frames.delete(id); cancel(frame);
  };
  window.addEventListener('visibilitychange', event => {
    if (!enabled) return;
    reschedule();
    // Keep the native CC renderer running; isolated extension scripts still
    // observe the browser's real visibility state.
    if (actualHidden() && !allowVisibility) event.stopImmediatePropagation();
  }, true);
  function setEnabled(value) {
    if (enabled === Boolean(value)) return;
    if (value) {
      previousHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
      previousVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      } catch {
        if (previousHidden) Object.defineProperty(document, 'hidden', previousHidden); else delete document.hidden;
        return;
      }
      enabled = true;
    } else {
      enabled = false;
      if (previousHidden) Object.defineProperty(document, 'hidden', previousHidden); else delete document.hidden;
      if (previousVisibility) Object.defineProperty(document, 'visibilityState', previousVisibility); else delete document.visibilityState;
    }
    reschedule();
    // Reawaken a renderer which had already processed a hidden event, or
    // restore its normal background behavior when the source is stopped.
    if (actualHidden()) {
      allowVisibility = true;
      try { document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); }
      finally { allowVisibility = false; }
    }
  }
  function pump() {
    if (!enabled || !actualHidden()) return;
    // Driven by the active destination tab, so background timer throttling
    // cannot leave a pending caption frame waiting until YouTube is focused.
    const time = performance.now();
    for (const [id, frame] of [...frames]) {
      if (!frames.has(id)) continue;
      cancel(frame);
      try { run(id, time); } catch (error) { setTimeout(() => { throw error; }); }
    }
  }
  window.SubtitleBackground = { setEnabled, pump };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const m = event.data;
    if (m?.channel !== 'floating-subtitles-background') return;
    if (m.action === 'enable') setEnabled(true);
    if (m.action === 'disable') setEnabled(false);
    if (m.action === 'tick') {
      pump();
      window.postMessage({ channel: 'floating-subtitles-rendered' }, location.origin);
    }
  });
})();
