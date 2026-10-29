(() => {
  'use strict';
  if (window.__floatingSubtitleBridge) return;
  window.__floatingSubtitleBridge = true;
  const captured = new Map();
  function captionURL(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === 'https://www.youtube.com' && url.pathname === '/api/timedtext' ? url : null;
    } catch { return null; }
  }
  function decode(text) {
    if (!text?.trim()) return null;
    try { const json = JSON.parse(text); if (Array.isArray(json.events)) return json; } catch {}
    const xml = new DOMParser().parseFromString(text, 'text/xml');
    if (xml.querySelector('parsererror')) return null;
    const events = [...xml.querySelectorAll('text, body > p')].map(node => {
      const old = node.tagName === 'text';
      const start = node.getAttribute(old ? 'start' : 't');
      const duration = node.getAttribute(old ? 'dur' : 'd');
      return { tStartMs: Number(start) * (old ? 1000 : 1), dDurationMs: Number(duration) * (old ? 1000 : 1), segs: [{ utf8: node.textContent }] };
    });
    return events.length ? { events } : null;
  }
  function remember(url, text) {
    const data = decode(text);
    if (!data?.events?.some(e => e.segs?.length)) return;
    const entry = { videoId: url.searchParams.get('v'), language: url.searchParams.get('lang'), automatic: url.searchParams.get('kind') === 'asr', data };
    const key = `${entry.videoId}|${entry.language}|${entry.automatic}`;
    captured.set(key, entry);
    if (captured.size > 6) captured.delete(captured.keys().next().value);
    window.postMessage({ channel: 'floating-subtitles-captions', ...entry }, location.origin);
  }
  // Observe successful requests made by YouTube itself, including requests
  // carrying its current caption tokens. Never send their URLs to another tab.
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = Reflect.apply(originalFetch, this, args);
    const url = captionURL(typeof args[0] === 'string' ? args[0] : args[0]?.url);
    if (url) promise.then(response => {
      if (response.ok) response.clone().text().then(text => remember(url, text)).catch(() => {});
    }).catch(() => {});
    return promise;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    requests.set(this, captionURL(url));
    return Reflect.apply(open, this, [method, url, ...args]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = requests.get(this);
    if (url) this.addEventListener('load', () => {
      try {
        if (this.status === 200) remember(url, this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText);
      } catch {}
    }, { once: true });
    return Reflect.apply(send, this, args);
  };
  // Only this small adapter runs in the page world. It has no extension privileges.
  window.addEventListener('message', async event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== 'floating-subtitles-request' || typeof m.id !== 'string') return;
    const result = { channel: 'floating-subtitles-response', id: m.id };
    try {
      const player = document.querySelector('#movie_player');
      const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      if (!response?.videoDetails || !document.querySelector('video')) { result.errorKey = 'regularVideo'; throw new Error('Open a regular YouTube video.'); }
      if (response.videoDetails.isLiveContent) { result.errorKey = 'liveUnsupported'; throw new Error('Livestreams are not supported.'); }
      const raw = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const current = player.getOption?.('captions', 'track');
      result.videoId = response.videoDetails.videoId;
      result.title = response.videoDetails.title;
      result.tracks = raw.map((t, index) => ({ id: String(index), language: t.languageCode, name: t.name?.simpleText || t.name?.runs?.map(r => r.text).join('') || t.languageCode, automatic: t.kind === 'asr' }));
      let index = m.trackId == null ? raw.findIndex(t => t.vssId === current?.vss_id || t.vssId === current?.vssId) : Number(m.trackId);
      if (!Number.isInteger(index) || index < 0 || index >= raw.length) index = 0;
      result.trackId = raw.length ? String(index) : null;
      result.cues = [];
      if (raw[index]) {
        // Enabling the selected track also makes the visible-caption fallback available.
        const track = raw[index];
        player.loadModule?.('captions');
        // Do not reset an already-selected native track when activating the extension.
        if (current?.vss_id !== track.vssId && current?.vssId !== track.vssId) {
          player.setOption?.('captions', 'track', { languageCode: track.languageCode, kind: track.kind, vss_id: track.vssId });
        }
        const button = document.querySelector('.ytp-subtitles-button');
        if (button?.getAttribute('aria-pressed') === 'false') button.click();
        try {
          const key = `${result.videoId}|${track.languageCode}|${track.kind === 'asr'}`;
          result.data = captured.get(key)?.data;
          if (!result.data) {
            // An already-open tab may have loaded CC before this adapter existed.
            // Reuse the most recent matching native URL without rewriting its format.
            const recent = performance.getEntriesByType('resource').map(e => captionURL(e.name)).filter(url => url && url.searchParams.get('v') === result.videoId && url.searchParams.get('lang') === track.languageCode && (url.searchParams.get('kind') === 'asr') === (track.kind === 'asr')).at(-1);
            const url = recent || captionURL(track.baseUrl);
            if (!url) throw new Error('Invalid caption URL');
            const response = await originalFetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error('Caption fetch failed');
            result.data = decode(await response.text()) || captured.get(key)?.data;
          }
          if (!result.data) result.fallback = true;
        } catch { result.fallback = true; }
      } else {
        result.errorKey = 'noCaptions';
      }
    } catch (error) { result.error = error.message; }
    window.postMessage(result, location.origin);
  });
})();
