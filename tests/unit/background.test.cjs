const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../../src/shared/core.js');

function worker(previousSession = null) {
  let listener, removed;
  const sent = [];
  const saved = { session: previousSession };
  const local = {};
  const tabs = [{ id: 1, url: 'https://www.youtube.com/watch?v=abc' }, { id: 2, url: 'https://example.com' }];
  const context = {
    URL, SubtitleCore: core, SubtitleI18n: { t: key => key }, importScripts() {},
    chrome: {
      scripting: { executeScript: async () => [] },
      commands: { onCommand: { addListener() {} } },
      storage: {
        session: { get: async () => saved, set: async value => Object.assign(saved, structuredClone(value)) },
        local: { get: async () => local, set: async value => Object.assign(local, value) }
      },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      tabs: {
        query: async () => tabs,
        get: async id => tabs.find(t => t.id === id),
        sendMessage: async (id, message) => { sent.push({ id, message: structuredClone(message) }); return { ok: true }; },
        onActivated: { addListener() {} },
        onRemoved: { addListener(fn) { removed = fn; } }
      }
    }
  };
  vm.runInNewContext(fs.readFileSync('src/background/background.js', 'utf8'), context);
  return { sent, saved, request: (message, tabId, active = true) => new Promise(resolve => listener(message, tabId == null ? {} : { tab: { id: tabId, active } }, resolve)), remove: id => removed(id) };
}

test('source selection, source-tab hiding, synchronization and stopping', async () => {
  const w = worker();
  assert.ok((await w.request({ type: 'START', tabId: 2 })).error);
  assert.equal((await w.request({ type: 'START', tabId: 1 })).ok, true);
  const data = { title: 'Thử nghiệm', tracks: [{ id: '0', name: 'Tiếng Việt' }], trackId: '0', cues: [{ start: 1, end: 3, text: 'Xin chào' }], fallback: false, error: '' };
  await w.request({ type: 'SOURCE_DATA', data }, 1);
  assert.equal(w.sent.filter(e => e.id === 1 && e.message.type === 'STATE').at(-1).message.isSource, true);
  assert.equal(w.sent.filter(e => e.id === 2 && e.message.type === 'STATE').at(-1).message.isSource, false);
  await w.request({ type: 'SOURCE_CLOCK', clock: { time: 1, at: 100, paused: true, rate: 1 }, domText: '' }, 1);
  assert.equal((await w.request({ type: 'GET_STATE' }, 2)).session.clock.paused, true);
  await w.request({ type: 'SOURCE_DATA', data: { title: 'untrusted' } }, 2);
  assert.equal((await w.request({ type: 'GET_STATE' })).session.title, 'Thử nghiệm');
  assert.ok((await w.request({ type: 'SELECT_TRACK', trackId: '99' })).error);
  await w.request({ type: 'STOP' });
  assert.equal((await w.request({ type: 'GET_STATE' })).session, null);
  assert.equal(w.saved.session, null);
});

test('worker restart restores source and source reload clears old cues', async () => {
  const w = worker({ tabId: 1, title: 'Old', cues: [{ start: 0, end: 4, text: 'Old' }], clock: { time: 1 } });
  assert.equal((await w.request({ type: 'SOURCE_READY' }, 1)).resume, true);
  assert.equal((await w.request({ type: 'SOURCE_READY' }, 2)).resume, false);
  await w.request({ type: 'SOURCE_LOADING' }, 1);
  const state = await w.request({ type: 'GET_STATE' });
  assert.equal(state.session.cues.length, 0);
  assert.equal(state.session.clock, null);
  assert.equal(state.session.loading, true);
  w.remove(1);
  assert.equal((await w.request({ type: 'GET_STATE' })).session, null);
});

test('saving one setting preserves position and clamps invalid input', async () => {
  const w = worker();
  await w.request({ type: 'SAVE_SETTINGS', settings: { x: .2, width: 500 } });
  await w.request({ type: 'SAVE_SETTINGS', settings: { fontSize: 900 } });
  const { settings } = await w.request({ type: 'GET_STATE' });
  assert.equal(settings.x, .2); assert.equal(settings.width, 500); assert.equal(settings.fontSize, 64);
});
test('only an active destination can drive synchronization for rendered CC', async () => {
  const w = worker({ tabId: 1, fallback: true, cues: [] });
  await w.request({ type: 'SYNC_SOURCE' }, 2);
  assert.equal(w.sent.filter(e => e.id === 1 && e.message.type === 'SOURCE_SYNC').length, 1);
  await w.request({ type: 'SYNC_SOURCE' }, 2, false);
  await w.request({ type: 'SYNC_SOURCE' }, 1);
  await w.request({ type: 'SYNC_SOURCE' });
  assert.equal(w.sent.filter(e => e.message.type === 'SOURCE_SYNC').length, 1);
  await w.request({ type: 'SOURCE_DATA', data: { fallback: false, cues: [{ start: 0, end: 1, text: 'Hi' }] } }, 1);
  await w.request({ type: 'SYNC_SOURCE' }, 2);
  assert.equal(w.sent.filter(e => e.message.type === 'SOURCE_SYNC').length, 1);
});
