const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  let disposed = 0, calls = 0, mode = 'ok';
  const timers = new Map(), apiListeners = new Set();
  let next = 0;
  const runtime = {
    id: 'extension',
    sendMessage() {
      calls++;
      if (mode === 'throw') throw new Error('Extension context invalidated.');
      if (mode === 'reject') return Promise.reject(new Error('Extension context invalidated.'));
      if (mode === 'temporary') return Promise.reject(new Error('Receiving end does not exist.'));
      return Promise.resolve({ ok: true });
    }
  };
  const context = { chrome: { runtime }, setInterval: fn => { timers.set(++next, fn); return next; }, clearInterval: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync('src/shared/runtime.js', 'utf8'), context);
  const life = context.SubtitleRuntime.create(() => disposed++);
  return { life, runtime, timers, apiListeners, get disposed() { return disposed; }, get calls() { return calls; }, set mode(value) { mode = value; } };
}

for (const mode of ['throw', 'reject']) {
  test(`invalidated sendMessage ${mode} stops timers, releases listeners, never escapes`, async () => {
    const f = fixture();
    let events = 0;
    const target = new EventTarget();
    f.life.listen(target, 'change', () => events++);
    f.life.apiListen({ addListener: fn => f.apiListeners.add(fn), removeListener: fn => f.apiListeners.delete(fn) }, () => {});
    f.life.every(() => {}, 120);
    assert.equal((await f.life.send({ type: 'SOURCE_READY' })).ok, true);
    f.mode = mode;
    assert.equal(await f.life.send({ type: 'SOURCE_CLOCK' }), null);
    assert.equal(f.disposed, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.apiListeners.size, 0);
    target.dispatchEvent(new Event('change'));
    assert.equal(events, 0);
    const calls = f.calls;
    assert.equal(await f.life.send({}), null);
    assert.equal(f.calls, calls);
    f.life.dispose();
    assert.equal(f.disposed, 1);
  });
}
test('idle content script detects reload without messaging and disposes itself', () => {
  const f = fixture();
  f.runtime.id = undefined;
  for (const fn of [...f.timers.values()]) fn();
  assert.equal(f.disposed, 1);
  assert.equal(f.life.alive(), false);
  assert.equal(f.calls, 0);
});
test('temporary receiver failure does not stop a valid content script', async () => {
  const f = fixture();
  f.mode = 'temporary';
  assert.equal(await f.life.send({}), null);
  assert.equal(f.life.alive(), true);
  f.mode = 'ok';
  assert.equal((await f.life.send({})).ok, true);
  assert.equal(f.disposed, 0);
  f.life.dispose();
});
