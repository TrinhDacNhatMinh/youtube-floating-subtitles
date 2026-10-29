'use strict';
importScripts('../shared/core.js', '../shared/i18n.js');
const t = SubtitleI18n.t;
let session = null;
const ready = chrome.storage.session.get('session').then(data => { session = data.session || null; });
let serial = Promise.resolve();
const overlayInitializations = new Map();
async function persist() { await chrome.storage.session.set({ session }); }
async function message(tabId, data) { try { return await chrome.tabs.sendMessage(tabId, data); } catch { return null; } }
async function ensureOverlay(tabId) {
  if (overlayInitializations.has(tabId)) return overlayInitializations.get(tabId);
  const initialization = (async () => {
    const status = await message(tabId, { type: 'OVERLAY_PING' });
    if (status?.overlay && status.ready) return true;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/shared/core.js', 'src/shared/runtime.js', 'src/shared/i18n.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/overlay.js'] });
      return true;
    } catch { return false; }
  })();
  overlayInitializations.set(tabId, initialization);
  try { return await initialization; }
  finally { overlayInitializations.delete(tabId); }
}
async function ensureSource(tabId) {
  // Also covers tabs opened before installing/reloading the extension.
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['src/youtube/youtube-background.js', 'src/youtube/youtube-bridge.js'] });
  if ((await message(tabId, { type: 'SOURCE_PING' }))?.source) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/shared/core.js', 'src/shared/runtime.js', 'src/shared/i18n.js', 'src/content/overlay.js', 'src/content/source.js'] });
}
async function broadcast(type = 'STATE') {
  const tabs = await chrome.tabs.query({ active: true });
  await Promise.all(tabs.map(async tab => {
    if (session) await ensureOverlay(tab.id);
    await message(tab.id, { type, session, isSource: tab.id === session?.tabId });
  }));
}
async function stop() {
  const old = session;
  session = null; await persist();
  if (old) await message(old.tabId, { type: 'SOURCE_STOP' });
  await broadcast();
}
async function handle(m, sender) {
  await ready;
  if (m.type === 'ENSURE_OVERLAY') return { ok: sender.tab ? await ensureOverlay(sender.tab.id) : false };
  if (m.type === 'ENSURE_SOURCE') {
    if (!sender.tab?.url?.startsWith('https://www.youtube.com/')) return { ok: false };
    try { await ensureSource(sender.tab.id); return { ok: true }; }
    catch { return { ok: false }; }
  }
  if (m.type === 'GET_STATE') {
    const { settings } = await chrome.storage.local.get('settings');
    return { session, settings: SubtitleCore.settings(settings), isSource: sender.tab?.id === session?.tabId };
  }
  if (m.type === 'SYNC_SOURCE') {
    if (session?.fallback && sender.tab && sender.tab.id !== session.tabId && sender.tab.active) {
      await message(session.tabId, { type: 'SOURCE_SYNC' });
    }
    return {};
  }
  if (m.type === 'SAVE_SETTINGS') {
    const previous = (await chrome.storage.local.get('settings')).settings;
    const settings = SubtitleCore.settings({ ...previous, ...m.settings });
    await chrome.storage.local.set({ settings }); return { ok: true };
  }
  if (m.type === 'STOP') { await stop(); return { ok: true }; }
  if (m.type === 'START') {
    const tab = await chrome.tabs.get(m.tabId);
    const url = new URL(tab.url);
    if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/watch') return { error: t('invalidSource') };
    try { await ensureSource(tab.id); }
    catch { return { error: t('noSourcePermission') }; }
    await stop();
    session = { tabId: tab.id, title: '', cues: [], tracks: [], error: '', loading: true, clock: null };
    await persist();
    const response = await message(tab.id, { type: 'SOURCE_START' });
    if (!response) { await stop(); return { error: t('reloadSource') }; }
    await broadcast(); return { ok: true };
  }
  if (m.type === 'SELECT_TRACK') {
    if (!session || !session.tracks.some(track => track.id === m.trackId)) return { error: t('invalidTrack') };
    await message(session.tabId, { type: 'SOURCE_START', trackId: m.trackId }); return { ok: true };
  }
  if (m.type === 'SOURCE_READY') return { resume: sender.tab?.id === session?.tabId };
  if (!session || sender.tab?.id !== session.tabId) return {};
  if (m.type === 'SOURCE_LOADING' || m.type === 'SOURCE_ERROR') {
    session = { ...session, cues: [], domText: '', clock: null, loading: m.type === 'SOURCE_LOADING', error: m.error || '' };
  } else if (m.type === 'SOURCE_DATA') {
    session = { ...session, ...m.data, loading: false, clock: null };
  } else if (m.type === 'SOURCE_CLOCK') {
    session.clock = m.clock; session.domText = m.domText;
    await persist();
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.all(tabs.map(tab => message(tab.id, { type: 'CLOCK', clock: m.clock, domText: m.domText })));
    return {};
  } else return {};
  await persist(); await broadcast(); return {};
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  serial = serial.then(() => handle(m, sender)).then(reply, error => reply({ error: error.message }));
  return true;
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await ready;
  if (session) await ensureOverlay(tabId);
  await message(tabId, { type: 'REFRESH' });
  if (session) await message(session.tabId, { type: 'SOURCE_SYNC' });
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial = serial.then(async () => { await ready; if (session?.tabId === tabId) await stop(); });
});
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'open-controls') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const query = tab?.id ? `?sourceTabId=${tab.id}` : '';
  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/popup/popup.html${query}`) });
});
