'use strict';
const $ = id => document.getElementById(id);
const t = SubtitleI18n.t;
document.documentElement.lang = SubtitleI18n.locale;
SubtitleI18n.localize(document);
let currentTab, lastSignature = '', actionPending = false;
let standalone = false, sourceTabs = [];
const send = message => chrome.runtime.sendMessage(message);
function showError(text) { $('error').textContent = text || ''; $('error').hidden = !text; }
function showSettings(settings) {
  $('fontSize').value = settings.fontSize; $('fontValue').textContent = `${settings.fontSize}px`;
  $('opacity').value = Math.round(settings.opacity * 100); $('opacityValue').textContent = `${Math.round(settings.opacity * 100)}%`;
}
async function refreshSources(preferredId) {
  sourceTabs = (await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' }))
    .filter(tab => { try { return new URL(tab.url).pathname === '/watch'; } catch { return false; } })
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const select = $('sourceTab');
  const signature = JSON.stringify(sourceTabs.map(t => [t.id, t.title, t.url]));
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren();
    for (const tab of sourceTabs) {
      const option = document.createElement('option'); option.value = String(tab.id);
      option.textContent = tab.title || t('youtubeVideo'); select.append(option);
    }
    if (!sourceTabs.length) {
      const option = document.createElement('option'); option.textContent = t('openVideoFirst'); select.append(option);
    }
  }
  currentTab = sourceTabs.find(tab => tab.id === preferredId) || sourceTabs.find(tab => tab.id === currentTab?.id) || sourceTabs[0];
  select.disabled = !currentTab;
  if (currentTab) select.value = String(currentTab.id);
}
async function refresh() {
  if (actionPending) return;
  const state = await send({ type: 'GET_STATE' });
  const s = state.session;
  if (standalone) await refreshSources();
  $('stop').hidden = !s;
  const eligible = /^https:\/\/www\.youtube\.com\/watch\?/.test(currentTab?.url || '');
  $('start').disabled = !eligible;
  $('start').textContent = t(s?.tabId === currentTab?.id ? 'reloadCaptions' : 'start');
  $('status').textContent = !s ? t('idle') : s.loading ? t('loadingCaptions') : s.error || t(s.fallback ? 'fallbackStatus' : 'followingStatus', s.title);
  const signature = JSON.stringify([s?.tracks, s?.trackId]);
  if (signature !== lastSignature) {
    lastSignature = signature;
    $('track').replaceChildren();
    for (const track of s?.tracks || []) {
      const option = document.createElement('option'); option.value = track.id;
      option.textContent = `${track.name}${track.automatic ? t('automaticSuffix') : ''}`;
      $('track').append(option);
    }
    if (!s?.tracks?.length) {
      const option = document.createElement('option'); option.textContent = t('noSource'); $('track').append(option);
    }
    $('track').value = s?.trackId || '0';
  }
  $('track').disabled = !s?.tracks?.length || s.loading;
}
async function action(message) {
  if (actionPending) return;
  actionPending = true;
  showError('');
  $('start').disabled = true;
  $('status').textContent = t(message.type === 'STOP' ? 'stopping' : 'connecting');
  try { const result = await send(message); if (result?.error) showError(result.error); }
  catch (error) { showError(t('connectionError', error.message)); }
  finally { actionPending = false; await refresh().catch(() => {}); }
}
$('start').onclick = () => action({ type: 'START', tabId: currentTab.id });
$('stop').onclick = () => action({ type: 'STOP' });
$('track').onchange = () => action({ type: 'SELECT_TRACK', trackId: $('track').value });
$('sourceTab').onchange = () => { currentTab = sourceTabs.find(tab => String(tab.id) === $('sourceTab').value); refresh(); };
for (const key of ['fontSize', 'opacity']) {
  $(key).oninput = () => {
    if (key === 'fontSize') $('fontValue').textContent = `${$(key).value}px`;
    else $('opacityValue').textContent = `${$(key).value}%`;
  };
  $(key).onchange = () => send({ type: 'SAVE_SETTINGS', settings: { [key]: Number($(key).value) / (key === 'opacity' ? 100 : 1) } });
}
$('reset').onclick = async () => { await send({ type: 'SAVE_SETTINGS', settings: SubtitleCore.defaults }); showSettings(SubtitleCore.defaults); };
(async () => {
  const ownTab = await chrome.tabs.getCurrent();
  const initial = await send({ type: 'GET_STATE' });
  standalone = Boolean(ownTab);
  if (standalone) {
    document.body.classList.add('standalone'); $('sourcePicker').hidden = false;
    const requested = Number(new URLSearchParams(location.search).get('sourceTabId'));
    await refreshSources(requested || initial.session?.tabId);
  } else [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  showSettings(initial.settings);
  await refresh();
  setInterval(() => refresh().catch(error => showError(t('stateError', error.message))), 1000);
})().catch(error => {
  $('status').textContent = t('startupFailed');
  showError(t('reloadError', error.message));
});
