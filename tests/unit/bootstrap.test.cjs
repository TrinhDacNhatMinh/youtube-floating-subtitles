const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('overlay without i18n requests dependencies without throwing or creating a partial UI', async () => {
  let disposed = 0;
  const messages = [];
  const context = {
    SubtitleCore: {}, SubtitleRuntime: { create() { throw new Error('Do not create UI before dependencies'); } },
    __floatingSubtitleOverlay: { alive: () => true, dispose: () => disposed++ },
    chrome: { runtime: { id: 'test', sendMessage: async message => { messages.push(message); return {}; } } }
  };
  const code = fs.readFileSync('src/content/overlay.js', 'utf8');
  vm.runInNewContext(code, context);
  vm.runInNewContext(code, context);
  assert.equal(disposed, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'ENSURE_OVERLAY');
  assert.equal(context.__floatingSubtitleOverlay, undefined);
  await context.__floatingSubtitleOverlayBootstrap;
  assert.equal(context.__floatingSubtitleOverlayBootstrap, undefined);
});
test('missing dependency bootstrap catches synchronous invalidation', () => {
  const context = { chrome: { runtime: { id: 'test', sendMessage() { throw new Error('Extension context invalidated.'); } } } };
  for (const file of ['src/content/overlay.js', 'src/content/source.js']) vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
});
test('source without i18n requests the YouTube dependency chain', () => {
  const messages = [];
  const context = { chrome: { runtime: { id: 'test', sendMessage: async message => { messages.push(message); return {}; } } } };
  vm.runInNewContext(fs.readFileSync('src/content/source.js', 'utf8'), context);
  assert.equal(messages[0].type, 'ENSURE_SOURCE');
});
