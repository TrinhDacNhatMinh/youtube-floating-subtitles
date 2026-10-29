(() => {
  'use strict';
  const previous = globalThis.__floatingSubtitleOverlay;
  if (previous?.ready && previous.alive()) return;
  previous?.dispose?.();
  delete globalThis.__floatingSubtitleOverlay;
  const { SubtitleCore: core, SubtitleRuntime: runtime, SubtitleI18n: i18n } = globalThis;
  if (!core || !runtime || !i18n?.localize) {
    // A tab can contain an older injection list after an unpacked update.
    // Ask the current worker to restore dependencies before creating any UI.
    if (!globalThis.__floatingSubtitleOverlayBootstrap) {
      try {
        if (chrome.runtime.id) globalThis.__floatingSubtitleOverlayBootstrap = Promise.resolve(chrome.runtime.sendMessage({ type: 'ENSURE_OVERLAY' }))
          .catch(() => null).finally(() => { delete globalThis.__floatingSubtitleOverlayBootstrap; });
      } catch { /* The next valid injection or page reload will retry. */ }
    }
    return;
  }
  let session = null, isSource = false, settings = core.settings(), gesture = null;
  const host = document.createElement('div');
  host.setAttribute('data-floating-subtitle-overlay', '');
  let observer;
  const life = runtime.create(() => {
    session = null; gesture = null; observer?.disconnect(); host.remove();
  });
  globalThis.__floatingSubtitleOverlay = life;
  try {
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host{color-scheme:dark} *{box-sizing:border-box}
    #box{position:absolute;pointer-events:none;font-family:Arial,sans-serif;text-align:center;}
    #caption{white-space:pre-line;overflow-wrap:anywhere;color:#fff;font-weight:400;line-height:1.35;text-shadow:1px 1px 2px #000,-1px -1px 2px #000;padding:10px 18px;border-radius:8px;max-height:70vh;overflow:hidden;}
    #tools{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);display:flex;gap:4px;align-items:center;background:#20242e;border:1px solid #ffffff40;border-radius:8px;padding:4px;pointer-events:auto;opacity:0;transition:opacity .15s;white-space:nowrap;}
    #box.reveal #tools,#tools:hover,#tools:focus-within,#box.moving #tools{opacity:1}
    button{font:13px Arial,sans-serif;background:transparent;border:0;color:white;padding:7px;border-radius:4px;cursor:pointer;}
    button:hover,button:focus-visible{background:#ffffff24;outline:1px solid #ffffff80}
    #drag{cursor:move;touch-action:none} #resize{position:absolute;right:0;top:0;bottom:0;width:12px;min-height:35px;pointer-events:auto;cursor:ew-resize;touch-action:none;opacity:0;border-right:3px solid #ffffffa0;}
    #box.reveal #resize,#resize:hover,#box.moving #resize{opacity:1}
    @media(prefers-reduced-motion:reduce){#tools{transition:none}}
  </style><div id="box" hidden><div id="tools"><button id="drag" data-i18n-title="dragToMove" data-i18n-aria-label="dragToMove">⠿ <span data-i18n="move">Move</span></button><button id="smaller" data-i18n-aria-label="smallerFont">A−</button><button id="larger" data-i18n-aria-label="largerFont">A+</button><button id="close" data-i18n-title="stop" data-i18n-aria-label="stop">✕</button></div><div id="caption"></div><div id="resize" data-i18n-title="resizeTitle"></div></div>`;
  i18n.localize(shadow);
  document.documentElement.append(host);
  const box = shadow.querySelector('#box'), caption = shadow.querySelector('#caption');
  const send = life.send;
  function layout() {
    const width = Math.max(100, Math.min(settings.width, innerWidth - 16));
    box.style.width = `${width}px`;
    caption.style.fontSize = `${settings.fontSize}px`;
    caption.style.background = `rgba(0,0,0,${settings.opacity})`;
    const height = box.offsetHeight || 60;
    box.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, settings.x * innerWidth - width / 2))}px`;
    box.style.top = `${Math.max(44, Math.min(innerHeight - height - 8, settings.y * innerHeight - height / 2))}px`;
  }
  function render() {
    let text = '';
    if (!isSource && !document.hidden && session && !session.loading && !session.error && session.clock) {
      text = session.fallback ? session.domText || '' : core.cueAt(session.cues || [], core.playhead(session.clock));
    }
    if (caption.textContent !== text) caption.textContent = text;
    box.hidden = !text;
    if (text) layout();
  }
  async function refresh() {
    const state = await send({ type: 'GET_STATE' });
    if (!state) return;
    session = state.session; isSource = state.isSource; settings = state.settings;
    render();
  }
  life.apiListen(chrome.runtime.onMessage, (m, sender, reply) => {
    if (m.type === 'OVERLAY_PING') reply({ overlay: true, ready: life.ready === true });
    if (m.type === 'STATE') { session = m.session; isSource = m.isSource; render(); }
    if (m.type === 'CLOCK' && session) { session.clock = m.clock; session.domText = m.domText; render(); }
    if (m.type === 'REFRESH') refresh();
  });
  life.apiListen(chrome.storage.onChanged, (changes, area) => {
    if (area === 'local' && changes.settings) { settings = core.settings(changes.settings.newValue); render(); }
  });
  life.listen(document, 'visibilitychange', () => { if (!document.hidden) refresh(); else render(); });
  life.listen(document, 'pointermove', e => {
    if (box.hidden) return;
    const r = box.getBoundingClientRect();
    box.classList.toggle('reveal', e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 45 && e.clientY <= r.bottom);
  }, { passive: true });
  async function save(patch) {
    settings = core.settings({ ...settings, ...patch }); layout();
    await send({ type: 'SAVE_SETTINGS', settings: patch });
  }
  shadow.querySelector('#smaller').onclick = () => save({ fontSize: settings.fontSize - 2 });
  shadow.querySelector('#larger').onclick = () => save({ fontSize: settings.fontSize + 2 });
  shadow.querySelector('#close').onclick = () => send({ type: 'STOP' });
  for (const kind of ['drag', 'resize']) {
    const handle = shadow.querySelector(`#${kind}`);
    life.listen(handle, 'pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      gesture = { kind, pointerId: e.pointerId, x: e.clientX, y: e.clientY, initial: { ...settings }, width: box.getBoundingClientRect().width };
      box.classList.add('moving');
    });
  }
  // Listen at document level so dragging continues outside the controls,
  // including when pointer capture is unavailable on the click-through host.
  life.listen(document, 'pointermove', e => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    settings = core.settings({ ...settings, ...(gesture.kind === 'drag' ? { x: gesture.initial.x + dx / innerWidth, y: gesture.initial.y + dy / innerHeight } : { width: gesture.width + dx * 2 }) });
    layout();
  }, true);
  const finish = () => {
    if (!gesture) return;
    gesture = null; box.classList.remove('moving');
    save({ x: settings.x, y: settings.y, width: settings.width });
  };
  life.listen(document, 'pointerup', finish, true);
  life.listen(document, 'pointercancel', finish, true);
  life.listen(window, 'blur', finish);
  life.listen(window, 'resize', layout);
  observer = new ResizeObserver(layout); observer.observe(caption);
  life.every(render, 120);
  life.every(() => {
    if (!document.hidden && !isSource && session?.fallback && !session.loading && !session.error) send({ type: 'SYNC_SOURCE' });
  }, 750);
  life.ready = true;
  refresh();
  } catch (error) {
    life.dispose();
    delete globalThis.__floatingSubtitleOverlay;
    throw error;
  }
})();
