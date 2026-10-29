const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../src/shared/core.js');
test('JSON3 preserves Vietnamese and merges segments without per-word styles', () => {
  assert.deepEqual(core.parseJSON3({ events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hôm nay ' }, { utf8: 'trời đẹp\nquá!' }] },
    { tStartMs: 0, dDurationMs: 10 },
    { tStartMs: 1, dDurationMs: 0, segs: [{ utf8: 'invalid' }] }
  ] }), [{ start: 1, end: 3, text: 'Hôm nay trời đẹp quá!' }]);
});
test('cue transitions, silence, overlapping captions and seeking', () => {
  const cues = core.normalize([{ start: 1, end: 3, text: 'Một' }, { start: 2, end: 4, text: 'Hai' }, { start: 5, end: 6, text: 'Ba' }]);
  assert.equal(core.cueAt(cues, 0), '');
  assert.equal(core.cueAt(cues, 1), 'Một');
  assert.equal(core.cueAt(cues, 2), 'Hai');
  assert.equal(core.cueAt(cues, 4), '');
  assert.equal(core.cueAt(cues, 5), 'Ba');
  assert.equal(core.cueAt(cues, 1.5), 'Một');
  assert.equal(core.cueAt(cues, 6), '');
});
test('clock respects pause, speed and resync after seeking', () => {
  assert.equal(core.playhead({ time: 10, paused: false, rate: 2, at: 1000 }, 2500), 13);
  assert.equal(core.playhead({ time: 10, paused: true, rate: 2, at: 1000 }, 2500), 10);
  assert.equal(core.playhead({ time: 2, paused: false, rate: 1, at: 2500 }, 3000), 2.5);
});
test('settings clamp corrupted and out-of-range persisted values', () => {
  assert.deepEqual(core.settings(), core.defaults);
  assert.deepEqual(core.settings({ fontSize: 1000, opacity: -1, width: 0, x: NaN, y: 2 }), { fontSize: 64, opacity: 0, width: 240, x: .5, y: 1 });
});
