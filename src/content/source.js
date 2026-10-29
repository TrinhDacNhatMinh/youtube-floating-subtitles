(() => {
  'use strict';
  if (globalThis.__floatingSubtitleSource?.alive?.()) return;
  if (!globalThis.SubtitleCore || !globalThis.SubtitleRuntime || !globalThis.SubtitleI18n?.t) {
    try { if (chrome.runtime.id) Promise.resolve(chrome.runtime.sendMessage({ type: 'ENSURE_SOURCE' })).catch(() => null); } catch {}
    return;
  }
  const core = SubtitleCore;
  const t = SubtitleI18n.t;
  let enabled = false, generation = 0, videoId = '', selected = null, tracks = [], cues = [], fallback = false;
  let lastSent = 0, lastText = '', loading = false;
  let captionSnapshots = new WeakMap(), captionRevision = 0, activeCaptionRevision = 0;
  function visible(element) {
    if (!element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  function readCaptions() {
    const player = document.querySelector('#movie_player') || document;
    const windows = [...player.querySelectorAll('.caption-window')];
    // Older renderer variants do not expose a caption-window wrapper.
    const containers = windows.length ? windows : [player.querySelector('.ytp-caption-window-container') || player];
    let newest = null;
    for (const container of containers) {
      const shown = container === document || visible(container);
      const lines = [...container.querySelectorAll('.caption-visual-line')];
      let text;
      if (lines.length) {
        // Rolling captions may retain offscreen/history rows in the DOM.
        text = lines.filter(visible).slice(-2).map(line => [...line.querySelectorAll('.ytp-caption-segment')].filter(visible).map(e => e.textContent).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
      } else {
        text = [...container.querySelectorAll('.ytp-caption-segment')].filter(visible).map(e => e.textContent).join(' ').replace(/\s+/g, ' ').trim();
      }
      const signature = `${shown}:${text}`;
      let snapshot = captionSnapshots.get(container);
      if (!snapshot || snapshot.signature !== signature) {
        snapshot = { signature, revision: ++captionRevision };
        captionSnapshots.set(container, snapshot);
      }
      if (shown && (!newest || snapshot.revision > newest.revision)) newest = { revision: snapshot.revision, text };
    }
    // A cleared/removed current window must not resurrect a cached old sentence.
    if (!newest || newest.revision < activeCaptionRevision) return '';
    activeCaptionRevision = newest.revision;
    return newest.text;
  }
  const pending = new Map();
  const background = action => window.postMessage({ channel: 'floating-subtitles-background', action }, location.origin);
  const life = SubtitleRuntime.create(() => {
    background('disable');
    enabled = false; generation++; loading = false;
    for (const resolve of pending.values()) resolve({ error: 'Extension context invalidated.' });
    pending.clear(); cues = []; tracks = [];
  });
  globalThis.__floatingSubtitleSource = life;
  const send = life.send;
  life.listen(window, 'message', event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin) return;
    if (m?.channel === 'floating-subtitles-rendered') { if (enabled && fallback && !loading) tick(true); return; }
    if (m?.channel === 'floating-subtitles-captions') {
      const track = tracks.find(t => t.id === selected);
      if (!enabled || loading || m.videoId !== videoId || !track || m.language !== track.language || m.automatic !== track.automatic) return;
      if (!Array.isArray(m.data?.events)) return;
      const received = core.parseJSON3(m.data);
      if (!received.length) return;
      cues = received; fallback = false;
      background('disable');
      send({ type: 'SOURCE_DATA', data: { cues, fallback: false, error: '', domText: '' } }).then(() => tick(true));
      return;
    }
    if (m?.channel !== 'floating-subtitles-response') return;
    const resolve = pending.get(m.id);
    if (resolve) { pending.delete(m.id); resolve(m); }
  });
  function request(trackId) {
    return new Promise(resolve => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => { pending.delete(id); resolve({ error: t('captionReadFailed') }); }, 11000);
      pending.set(id, data => { clearTimeout(timeout); resolve(data); });
      window.postMessage({ channel: 'floating-subtitles-request', id, trackId }, location.origin);
    });
  }
  async function load(trackId) {
    enabled = true;
    background('disable');
    const current = ++generation;
    loading = true; cues = []; lastText = '';
    captionSnapshots = new WeakMap(); captionRevision = 0; activeCaptionRevision = 0;
    await send({ type: 'SOURCE_LOADING' });
    if (!life.alive() || !enabled || current !== generation) return;
    const result = await request(trackId);
    if (result.errorKey) result.error = t(result.errorKey);
    if (!enabled || current !== generation) return;
    loading = false;
    const actualId = new URL(location.href).searchParams.get('v');
    if (result.videoId && result.videoId !== actualId) { await send({ type: 'SOURCE_ERROR', error: t('videoChanging') }); return; }
    videoId = result.videoId || actualId;
    selected = result.trackId;
    tracks = result.tracks || [];
    cues = result.data ? core.parseJSON3(result.data) : [];
    fallback = !cues.length && !result.error;
    background(fallback ? 'enable' : 'disable');
    await send({ type: 'SOURCE_DATA', data: { videoId, title: result.title || '', tracks: result.tracks || [], trackId: selected, cues, fallback, error: result.error || '', domText: '' } });
    tick(true);
  }
  function tick(force = false) {
    if (!enabled || loading) return;
    const video = document.querySelector('video');
    if (!video) return;
    const now = Date.now();
    const text = fallback ? readCaptions() : '';
    if (!force && now - lastSent < 750 && text === lastText) return;
    lastSent = now; lastText = text;
    send({ type: 'SOURCE_CLOCK', clock: { time: video.currentTime, paused: video.paused || video.ended || video.readyState < 3, rate: video.playbackRate, at: now }, domText: text });
  }
  life.apiListen(chrome.runtime.onMessage, (m, sender, reply) => {
    if (m.type === 'SOURCE_PING') reply({ source: true });
    if (m.type === 'SOURCE_START') { load(m.trackId); reply({ ok: true }); }
    if (m.type === 'SOURCE_STOP') { enabled = false; generation++; background('disable'); reply({ ok: true }); }
    if (m.type === 'SOURCE_SYNC') {
      if (enabled && fallback && !loading) background('tick');
      else tick(true);
      reply({ ok: true });
    }
  });
  life.listen(document, 'timeupdate', () => tick(), true);
  for (const name of ['seeking', 'seeked', 'play', 'pause', 'ratechange', 'waiting', 'playing', 'ended']) {
    life.listen(document, name, () => tick(true), true);
  }
  life.every(() => tick(), 1000);
  life.listen(document, 'yt-navigate-start', () => {
    if (!enabled) return;
    generation++; loading = true; cues = []; lastText = '';
    background('disable');
    send({ type: 'SOURCE_LOADING' });
  });
  life.listen(document, 'yt-navigate-finish', () => {
    if (!enabled) return;
    if (location.pathname !== '/watch') { send({ type: 'SOURCE_ERROR', error: t('regularVideo') }); return; }
    load(null);
  });
  life.listen(window, 'pagehide', () => { if (enabled) send({ type: 'SOURCE_LOADING' }); });
  life.listen(window, 'pageshow', event => { if (event.persisted && enabled) load(null); });
  send({ type: 'SOURCE_READY' }).then(response => { if (response?.resume && !enabled) load(null); });
})();
