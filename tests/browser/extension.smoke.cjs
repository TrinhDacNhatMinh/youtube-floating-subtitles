// Full unpacked-extension test in a separate temporary Chrome profile.
// YouTube responses are intercepted fixtures; Chrome extension APIs are real.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');

(async () => {
  const liveUrl = process.argv[2] === '--live' ? (process.argv[3] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw') : null;
  const nativeOnly = process.argv.includes('--native-caption');
  const uiLanguage = process.argv.find(arg => arg.startsWith('--ui-language='))?.split('=')[1];
  const replaceOnly = process.argv.includes('--replace-caption');
  const backgroundOnly = process.argv.includes('--background-caption');
  const domOnly = process.argv.includes('--dom-caption') || backgroundOnly || replaceOnly;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-extension-'));
  const server = http.createServer((req, res) => res.end('<!doctype html><html><body>Destination</body></html>'));
  let browser;
  const pending = new Map();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...(uiLanguage ? [`--lang=${uiLanguage}`] : []),
      '--enable-unsafe-extension-debugging', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let seq = 0, buffer = '';
    const events = new Set();
    browser.stdio[4].on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const data = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const item = pending.get(data.id);
        if (item) { pending.delete(data.id); clearTimeout(item.timer); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); }
        else for (const listener of events) listener(data);
      }
    });
    browser.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
    const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
    const errors = [];
    events.add(e => { if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text); });
    const evaluate = async (sessionId, expression) => {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const open = async url => {
      const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
      await cdp('Runtime.enable', {}, sessionId);
      await cdp('Page.enable', {}, sessionId);
      if (url) await cdp('Page.navigate', { url }, sessionId);
      return { targetId, sessionId };
    };
    const waitFor = async (sessionId, expression) => {
      const start = Date.now();
      while (Date.now() - start < 14000) {
        if (await evaluate(sessionId, expression)) return;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new Error(`Wait failed: ${expression}\n${JSON.stringify(errors)}`);
    };
    const source = await open();
    if (liveUrl) {
      await cdp('Network.enable', {}, source.sessionId);
      const captions = new Map();
      events.add(e => {
        if (e.sessionId !== source.sessionId) return;
        if (e.method === 'Network.responseReceived' && e.params.response.url.includes('/api/timedtext')) {
          captions.set(e.params.requestId, new URL(e.params.response.url));
          console.log('Caption response:', e.params.response.status, [...new URL(e.params.response.url).searchParams.keys()].join(','));
        }
        if (e.method === 'Network.loadingFinished' && captions.has(e.params.requestId)) {
          cdp('Network.getResponseBody', { requestId: e.params.requestId }, source.sessionId).then(r => console.log('Caption body:', r.body.length, r.body.slice(0, 100))).catch(() => {});
        }
      });
    }
    events.add(e => {
      if (e.method !== 'Fetch.requestPaused' || e.sessionId !== source.sessionId) return;
      const isCaption = e.params.request.url.includes('/api/timedtext');
      const fixture = isCaption ? (domOnly || (nativeOnly && !e.params.request.url.includes('native=1')) ? '' : nativeOnly ? '<timedtext><body><p t="0" d="300000"><s>Phụ đề kiểm tra tiếng Việt</s></p></body></timedtext>' : JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 300000, segs: [{ utf8: 'Phụ đề kiểm tra tiếng Việt' }] }] })) : `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="movie_player"><video></video><div class="ytp-caption-window-container"><div class="caption-window" id="initial-caption"><span class="ytp-caption-segment">Phụ đề dự phòng</span></div></div></div><script>
        const video=document.querySelector('video');
        Object.defineProperties(video,{currentTime:{get:()=>10},paused:{get:()=>false},readyState:{get:()=>4}});
        const player=document.querySelector('#movie_player');
        player.getPlayerResponse=()=>({videoDetails:{videoId:'fixture',title:'Video kiểm tra'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:'https://www.youtube.com/api/timedtext?v=fixture',languageCode:'vi',vssId:'.vi',name:{simpleText:'Tiếng Việt'}}]}}});
        player.getOption=()=>({vss_id:'.vi'});player.setOption=()=>{};player.loadModule=()=>{${nativeOnly ? "setTimeout(()=>fetch('https://www.youtube.com/api/timedtext?v=fixture&lang=vi&native=1'),300);" : ''}};
        ${backgroundOnly ? "function captionFrame(){if(!document.hidden)document.querySelector('.ytp-caption-segment').textContent='Câu nền '+Math.floor(performance.now()/1000);requestAnimationFrame(captionFrame);}requestAnimationFrame(captionFrame);" : ''}
      </script></body></html>`;
      cdp('Fetch.fulfillRequest', { requestId: e.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: isCaption ? 'application/json' : 'text/html; charset=utf-8' }], body: Buffer.from(fixture).toString('base64') }, source.sessionId).catch(error => errors.push(error.message));
    });
    if (!liveUrl) await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://www.youtube.com/*' }] }, source.sessionId);
    await cdp('Page.navigate', { url: liveUrl || 'https://www.youtube.com/watch?v=fixture' }, source.sessionId);
    await waitFor(source.sessionId, '!!document.querySelector("video")');
    if (liveUrl) {
      await cdp('Runtime.evaluate', { expression: `(async()=>{const v=document.querySelector('video');v.currentTime=1;try{await v.play();}catch{}const b=document.querySelector('.ytp-subtitles-button');if(b?.getAttribute('aria-pressed')!=='true')b?.click();})()`, awaitPromise: true, userGesture: true }, source.sessionId);
      await new Promise(resolve => setTimeout(resolve, 4000));
      console.log('Native YouTube before extension install:', await evaluate(source.sessionId, `({time:document.querySelector('video')?.currentTime,cc:document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),text:[...document.querySelectorAll('.ytp-caption-segment')].map(e=>e.textContent).join(' ')})`));
    }
    const destination = await open(`http://127.0.0.1:${server.address().port}`);
    await waitFor(destination.sessionId, 'document.readyState === "complete"');
    const { id } = await cdp('Extensions.loadUnpacked', { path: path.resolve('.') });
    console.log('Unpacked extension loaded after both test tabs were already open:', id);
    if (backgroundOnly) {
      await cdp('Page.navigate', { url: 'https://www.youtube.com/watch?v=fixture' }, source.sessionId);
      await waitFor(source.sessionId, '!!document.querySelector("video")');
    }
    if (process.argv.includes('--action-popup')) {
      console.log('Browser:', JSON.stringify(await cdp('Browser.getVersion')));
      await cdp('Target.activateTarget', { targetId: source.targetId });
      const tabs = (await cdp('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })).targetInfos;
      const tab = tabs.find(t => t.url.startsWith('https://www.youtube.com/watch?'));
      assert.ok(tab, JSON.stringify(tabs));
      await cdp('Extensions.triggerAction', { id, targetId: tab.targetId });
      const deadline = Date.now() + 6000;
      let target;
      while (Date.now() < deadline) {
        target = (await cdp('Target.getTargets')).targetInfos.find(t => t.url.startsWith(`chrome-extension://${id}/src/popup/popup.html`));
        if (target) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.ok(target, 'Toolbar action did not create a popup target');
      const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await waitFor(sessionId, '!!document.querySelector("#status")');
      await waitFor(sessionId, 'typeof SubtitleI18n!=="undefined" && document.querySelector("#status").textContent !== SubtitleI18n.t("checking")');
      assert.equal(await evaluate(sessionId, 'document.querySelector("#start").disabled'), false);
      await evaluate(sessionId, 'document.querySelector("#start").click()');
      await waitFor(sessionId, `(async()=>{const s=(await chrome.runtime.sendMessage({type:'GET_STATE'})).session;return !!s&&!s.loading&&s.cues.length>0;})()`);
      console.log('Toolbar popup:', await evaluate(sessionId, 'document.querySelector("#status").textContent'));
      return;
    }
    const popup = await open(`chrome-extension://${id}/src/popup/popup.html`);
    await waitFor(popup.sessionId, '!!document.querySelector("#status")');
    await waitFor(popup.sessionId, 'typeof SubtitleI18n!=="undefined" && document.querySelector("#status").textContent !== SubtitleI18n.t("checking")');
    const localeInfo = await evaluate(popup.sessionId, `({ui:chrome.i18n.getUILanguage(),lang:document.documentElement.lang,title:document.querySelector('h1').textContent,start:document.querySelector('#start').textContent,name:chrome.runtime.getManifest().name})`);
    console.log('UI locale:', JSON.stringify(localeInfo));
    const expectedLanguage = /^vi(?:[-_]|$)/i.test(uiLanguage || localeInfo.ui) ? 'vi' : 'en';
    assert.equal(localeInfo.lang, expectedLanguage);
    const catalog = JSON.parse(fs.readFileSync('_locales/' + expectedLanguage + '/messages.json', 'utf8'));
    assert.equal(localeInfo.title, catalog.appTitle.message);
    assert.equal(localeInfo.start, catalog.start.message);
    assert.equal(localeInfo.name, catalog.extName.message);
    console.log('Popup initial status:', await evaluate(popup.sessionId, 'document.querySelector("#status").textContent'));
    if (!liveUrl) {
      await evaluate(popup.sessionId, `action({type:'START',tabId:2147483647})`);
      await new Promise(resolve => setTimeout(resolve, 1250));
      assert.equal(await evaluate(popup.sessionId, `!document.querySelector('#error').hidden && !!document.querySelector('#error').textContent`), true, 'Action errors must survive status polling');
      await evaluate(popup.sessionId, `(async()=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.startsWith('http://127.0.0.1:'));await action({type:'START',tabId:tab.id});})()`);
      assert.equal(await evaluate(popup.sessionId, `document.querySelector('#error').textContent`), catalog.invalidSource.message);
    }
    assert.equal(await evaluate(popup.sessionId, 'document.querySelector("#sourcePicker").hidden'), false);
    assert.equal(await evaluate(popup.sessionId, 'document.querySelector("#start").disabled'), false);
    await evaluate(popup.sessionId, `document.querySelector('#start').click()`);
    await waitFor(popup.sessionId, `(async()=>{const s=(await chrome.runtime.sendMessage({type:'GET_STATE'})).session;return !!s&&!s.loading${nativeOnly ? '&&s.cues.length>0' : ''};})()`);
    const state = await evaluate(popup.sessionId, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
    console.log('Source result:', JSON.stringify({ ...state.session, cues: `${state.session.cues.length} cues`, sample: state.session.cues.slice(0, 2) }));
    assert.equal(state.session.error, '');
    if (liveUrl) {
      await cdp('Target.activateTarget', { targetId: source.targetId });
      const play = await cdp('Runtime.evaluate', { expression: `(async()=>{const b=document.querySelector('.ytp-subtitles-button');if(b?.getAttribute('aria-pressed')!=='true')b?.click();const v=document.querySelector('video');v.currentTime=3;try{await Promise.race([v.play(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('play timeout')),6000))]);return 'playing';}catch(e){return e.message;}})()`, awaitPromise: true, returnByValue: true, userGesture: true }, source.sessionId);
      console.log('Playback:', play.result?.value);
      await new Promise(resolve => setTimeout(resolve, 2500));
      console.log('Visible source:', await evaluate(source.sessionId, `({time:document.querySelector('video')?.currentTime,paused:document.querySelector('video')?.paused,cc:document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),text:[...document.querySelectorAll('.ytp-caption-segment')].map(e=>e.textContent).join(' ')})`));
      await cdp('Target.activateTarget', { targetId: destination.targetId });
      await new Promise(resolve => setTimeout(resolve, 2500));
      const latest = await evaluate(popup.sessionId, `chrome.runtime.sendMessage({type:'GET_STATE'})`);
      console.log('Background source:', JSON.stringify({ clock: latest.session.clock, text: latest.session.domText, count: latest.session.cues.length }));
      assert.ok(latest.session.cues.length > 0 || latest.session.domText, 'No usable subtitles received during live playback');
      console.log('Live YouTube playback produced subtitles.');
      return;
    }
    if (domOnly) assert.equal(state.session.fallback, true);
    else assert.equal(state.session.cues[0]?.text, 'Phụ đề kiểm tra tiếng Việt');
    await cdp('Target.activateTarget', { targetId: destination.targetId });
    // CDP can inspect closed shadow roots without changing extension code.
    let caption = '';
    let moveTitle = '';
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const tree = await cdp('DOM.getDocument', { depth: -1, pierce: true }, destination.sessionId);
      const walk = node => {
        if (node.attributes?.includes('caption')) caption = (node.children || []).map(c => c.nodeValue || '').join('');
        if (node.attributes?.includes('drag')) {
          const titleIndex = node.attributes.indexOf('title');
          moveTitle = titleIndex < 0 ? '' : node.attributes[titleIndex + 1];
        }
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
      };
      walk(tree.root);
      if (caption) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(moveTitle, catalog.dragToMove.message);
    if (backgroundOnly) {
      const first = caption;
      await new Promise(resolve => setTimeout(resolve, 3200));
      const tree = await cdp('DOM.getDocument', { depth: -1, pierce: true }, destination.sessionId);
      let later = '';
      const find = node => {
        if (node.attributes?.includes('caption')) later = (node.children || []).map(c => c.nodeValue || '').join('');
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) find(child);
      };
      find(tree.root);
      assert.ok(later.startsWith('Câu nền '), later);
      assert.notEqual(later, first, 'CC must change without focusing the hidden YouTube tab');
      assert.equal(await evaluate(source.sessionId, `Object.getOwnPropertyDescriptor(Document.prototype,'hidden').get.call(document)`), true);
      await evaluate(popup.sessionId, `chrome.runtime.sendMessage({type:'STOP'})`);
      await waitFor(source.sessionId, 'document.hidden===true');
      console.log('Background CC regression passed:', first, '→', later, '; normal page visibility restored on stop.');
    } else assert.equal(caption, domOnly ? 'Phụ đề dự phòng' : 'Phụ đề kiểm tra tiếng Việt', JSON.stringify(errors));
    if (replaceOnly) {
      const waitText = async expected => {
        await waitFor(popup.sessionId, `(async()=>{const s=(await chrome.runtime.sendMessage({type:'GET_STATE'})).session;return s?.domText===${JSON.stringify(expected)};})()`);
        await new Promise(resolve => setTimeout(resolve, 100));
        const tree = await cdp('DOM.getDocument', { depth: -1, pierce: true }, destination.sessionId);
        let text = '';
        const find = node => {
          if (node.attributes?.includes('caption')) text = (node.children || []).map(c => c.nodeValue || '').join('');
          for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) find(child);
        };
        find(tree.root); assert.equal(text, expected);
      };
      await evaluate(source.sessionId, `document.querySelector('.ytp-caption-window-container').insertAdjacentHTML('beforeend','<div class="caption-window" id="current-caption"><div class="caption-visual-line"><span class="ytp-caption-segment">Câu mới</span><span class="ytp-caption-segment">tiếng Việt</span></div><div class="caption-visual-line"><span class="ytp-caption-segment">dòng thứ hai.</span></div></div>')`);
      await waitText('Câu mới tiếng Việt\ndòng thứ hai.');
      await evaluate(source.sessionId, `document.querySelector('#current-caption').textContent='';`);
      await waitText('');
      await evaluate(source.sessionId, `document.querySelector('#current-caption').remove();`);
      await waitText('');
      await evaluate(source.sessionId, `document.querySelector('.ytp-caption-window-container').insertAdjacentHTML('beforeend','<div class="caption-window" style="display:none"><span class="ytp-caption-segment">Không được hiện chữ ẩn</span></div><div class="caption-window" id="rolling-caption"><div class="caption-visual-line"><span class="ytp-caption-segment">Lịch sử cũ</span></div><div class="caption-visual-line"><span class="ytp-caption-segment">Hai dòng</span></div><div class="caption-visual-line"><span class="ytp-caption-segment">hiện tại</span></div></div>')`);
      await waitText('Hai dòng\nhiện tại');
      await evaluate(source.sessionId, `document.querySelector('#rolling-caption').style.display='none';document.querySelector('#initial-caption').querySelector('span').textContent='Câu sau khi tua lại';`);
      await waitText('Câu sau khi tua lại');
      console.log('Caption replacement passed: retained old windows, multi-segment/two-line cues, empty gaps, removed cues, hidden history, rolling rows and seeking.');
    }
    if (process.argv.includes('--missing-i18n')) {
      const tabId = await evaluate(popup.sessionId, `(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url?.startsWith('http://127.0.0.1:')).id;})()`);
      await evaluate(popup.sessionId, `(async()=>{
        await chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{
          globalThis.__floatingSubtitleOverlay?.dispose();
          delete globalThis.SubtitleI18n;
          globalThis.__floatingSubtitleOverlay={alive:()=>true,dispose:()=>{globalThis.partialOverlayDisposed=true;}};
        }});
        await chrome.scripting.executeScript({target:{tabId:${tabId}},files:['src/content/overlay.js']});
      })()`);
      await waitFor(popup.sessionId, `(async()=>{const [r]=await chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>Boolean(globalThis.SubtitleI18n&&globalThis.__floatingSubtitleOverlay?.ready&&globalThis.partialOverlayDisposed)});return r.result;})()`);
      assert.equal(await evaluate(destination.sessionId, `document.querySelectorAll('[data-floating-subtitle-overlay]').length`), 1);
      const sourceId = (await evaluate(popup.sessionId, `chrome.runtime.sendMessage({type:'GET_STATE'})`)).session.tabId;
      await evaluate(popup.sessionId, `(async()=>{
        await chrome.scripting.executeScript({target:{tabId:${sourceId}},func:()=>{
          globalThis.__floatingSubtitleSource?.dispose();delete globalThis.SubtitleI18n;
        }});
        await chrome.scripting.executeScript({target:{tabId:${sourceId}},files:['src/content/source.js']});
      })()`);
      await waitFor(popup.sessionId, `(async()=>{const [r]=await chrome.scripting.executeScript({target:{tabId:${sourceId}},func:()=>Boolean(globalThis.SubtitleI18n&&globalThis.__floatingSubtitleSource?.alive())});return r.result;})()`);
      await waitFor(popup.sessionId, `(async()=>{const s=(await chrome.runtime.sendMessage({type:'GET_STATE'})).session;return s&&!s.loading&&s.clock;})()`);
      const tree = await cdp('DOM.getDocument', { depth: -1, pierce: true }, destination.sessionId);
      let recoveredCaption = '', recoveredTitle = '';
      const find = node => {
        if (node.attributes?.includes('caption')) recoveredCaption = (node.children || []).map(c => c.nodeValue || '').join('');
        if (node.attributes?.includes('drag')) { const i=node.attributes.indexOf('title'); recoveredTitle=i<0?'':node.attributes[i+1]; }
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) find(child);
      };
      find(tree.root);
      assert.equal(recoveredCaption, 'Phụ đề kiểm tra tiếng Việt');
      assert.equal(recoveredTitle, catalog.dragToMove.message);
      console.log('Missing-i18n regression passed: partial overlay disposed, overlay/source dependencies restored, one translated overlay, no ReferenceError.');
    }
    if (process.argv.includes('--reload-extension')) {
      await cdp('Extensions.uninstall', { id });
      // Keep both existing documents alive while invalidating their extension context.
      await evaluate(source.sessionId, `document.querySelector('video').dispatchEvent(new Event('timeupdate',{bubbles:true}));document.dispatchEvent(new Event('yt-navigate-start'));`);
      await cdp('Target.activateTarget', { targetId: source.targetId });
      await cdp('Target.activateTarget', { targetId: destination.targetId });
      await waitFor(destination.sessionId, `document.querySelectorAll('[data-floating-subtitle-overlay]').length===0`);
      assert.equal(errors.length, 0, JSON.stringify(errors));
      const reinstalled = await cdp('Extensions.loadUnpacked', { path: path.resolve('.') });
      assert.equal(reinstalled.id, id);
      const controls = await open(`chrome-extension://${id}/src/popup/popup.html`);
      await waitFor(controls.sessionId, `!!document.querySelector('#start')&&!document.querySelector('#start').disabled`);
      await evaluate(controls.sessionId, `document.querySelector('#start').click()`);
      await waitFor(controls.sessionId, `(async()=>{const s=(await chrome.runtime.sendMessage({type:'GET_STATE'})).session;return !!s&&!s.loading&&!!s.clock;})()`);
      await cdp('Target.activateTarget', { targetId: destination.targetId });
      await waitFor(destination.sessionId, `document.querySelectorAll('[data-floating-subtitle-overlay]').length===1`);
      const tree = await cdp('DOM.getDocument', { depth: -1, pierce: true }, destination.sessionId);
      let restoredText = '';
      const find = node => {
        if (node.attributes?.includes('caption')) restoredText = (node.children || []).map(c => c.nodeValue || '').join('');
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) find(child);
      };
      find(tree.root);
      assert.equal(restoredText, 'Phụ đề kiểm tra tiếng Việt');
      console.log('Reload regression passed: old source/overlay disposed without errors; existing tabs work after reinstall with one overlay.');
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log('Full extension smoke passed: real popup, service worker, YouTube adapter and destination overlay.');
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser closed')); }
    pending.clear();
    if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 2000).unref(); }); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('subtitle-extension-')) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
