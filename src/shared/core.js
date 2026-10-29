(function (root) {
  'use strict';
  const defaults = { fontSize: 28, opacity: 0.65, width: 720, x: 0.5, y: 0.85 };
  function settings(value = {}) {
    const bound = (key, min, max) => Number.isFinite(value[key]) ? Math.min(max, Math.max(min, value[key])) : defaults[key];
    return { fontSize: bound('fontSize', 16, 64), opacity: bound('opacity', 0, 1), width: bound('width', 240, 1400), x: bound('x', 0, 1), y: bound('y', 0, 1) };
  }
  function normalize(cues) {
    return cues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start && typeof c.text === 'string' && c.text.trim())
      .map(c => ({ start: c.start, end: c.end, text: c.text.trim() })).sort((a, b) => a.start - b.start);
  }
  function parseJSON3(data) {
    return normalize((data.events || []).filter(e => Array.isArray(e.segs)).map(e => ({
      start: e.tStartMs / 1000, end: (e.tStartMs + e.dDurationMs) / 1000,
      text: e.segs.map(s => s.utf8 || '').join('').replace(/\n+/g, ' ')
    })));
  }
  function cueAt(cues, time) {
    // Prefer the latest-starting cue for rolling auto-generated captions.
    let lo = 0, hi = cues.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cues[mid].start <= time) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0; i--) if (time < cues[i].end) return cues[i].text;
    return '';
  }
  function playhead(clock, now = Date.now()) {
    return clock.time + (clock.paused ? 0 : Math.max(0, now - clock.at) / 1000 * clock.rate);
  }
  const api = { defaults, settings, normalize, parseJSON3, cueAt, playhead };
  root.SubtitleCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
