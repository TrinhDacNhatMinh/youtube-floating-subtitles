// Runs the real overlay in headless Chrome with a deterministic extension-message fixture.
// This checks rendering and interaction, not YouTube's live caption endpoints.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
  const executable = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-smoke-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body style="margin:0"><button id="under" style="position:fixed;inset:0;width:100%;height:100%">Trang bên dưới</button></body></html>');
  });
  let browser, socket;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome debugging endpoint timed out')), 15000);
      browser.on('error', error => { clearTimeout(timer); reject(error); });
      browser.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}`)); });
      browser.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let seq = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const data = JSON.parse(event.data);
      const item = pending.get(data.id);
      if (item) { pending.delete(data.id); clearTimeout(item.timer); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); }
    };
    function cdp(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 8000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    const { targetId } = await cdp('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}` });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
      return result.result.value;
    }
    await cdp('Page.enable', {}, sessionId);
    let pageReady = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      pageReady = await evaluate(`document.readyState === 'complete' && !!document.getElementById('under')`);
      if (pageReady) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(pageReady, 'Local fixture must finish navigating before overlay injection');
    await evaluate(`
      window.messages = []; window.saved = {}; window.runtimeListeners = [];
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) { const shadow = attach.call(this, options); window.overlayShadow = shadow; return shadow; };
      window.chrome = {
        runtime: {
          id: 'test-extension',
          sendMessage: async m => { messages.push(m); if (m.type === 'GET_STATE') return {session:{ cues:[{start:0,end:10000,text:'Hôm nay trời đẹp'}], clock:{time:1,paused:true,rate:1,at:Date.now()} },isSource:false,settings:SubtitleCore.defaults}; if(m.type==='SAVE_SETTINGS') Object.assign(saved,m.settings); return {}; },
          onMessage:{addListener:fn=>runtimeListeners.push(fn)}
        },storage:{onChanged:{addListener:()=>{}}}
      };
    `);
    await evaluate(fs.readFileSync('src/shared/core.js', 'utf8'));
    await evaluate(fs.readFileSync('src/shared/runtime.js', 'utf8'));
    const messages = JSON.parse(fs.readFileSync('_locales/en/messages.json', 'utf8'));
    await evaluate(`chrome.i18n={getUILanguage:()=> 'en',getMessage:key=>(${JSON.stringify(messages)})[key]?.message||''}`);
    await evaluate(fs.readFileSync('src/shared/i18n.js', 'utf8'));
    await evaluate(fs.readFileSync('src/content/overlay.js', 'utf8'));
    const info = await evaluate(`({text:overlayShadow.querySelector('#caption').textContent,hidden:overlayShadow.querySelector('#box').hidden,weight:getComputedStyle(overlayShadow.querySelector('#caption')).fontWeight})`);
    assert.equal(info.text, 'Hôm nay trời đẹp'); assert.equal(info.hidden, false); assert.equal(info.weight, '400');
    const through = await evaluate(`(() => {const r=overlayShadow.querySelector('#caption').getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2).id;})()`);
    assert.equal(through, 'under');
    await evaluate(`overlayShadow.querySelector('#larger').click()`);
    assert.equal(await evaluate('saved.fontSize'), 30);
    await evaluate(`window.pointerLog=[]; window.addEventListener('error',e=>pointerLog.push(['error',e.message])); for(const name of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture']) { overlayShadow.addEventListener(name,e=>pointerLog.push([name,e.target.id,e.clientX,e.clientY,e.buttons]),true); document.addEventListener(name,e=>pointerLog.push(['document-'+name,e.target.id,e.clientX,e.clientY,e.buttons]),true); }`);
    const drag = await evaluate(`(() => {const r=overlayShadow.querySelector('#drag').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const [type, x, y, buttons] of [['mouseMoved', drag.x, drag.y, 0], ['mousePressed', drag.x, drag.y, 1], ['mouseMoved', drag.x - 80, drag.y - 80, 1], ['mouseReleased', drag.x - 80, drag.y - 80, 0]]) {
      await cdp('Input.dispatchMouseEvent', { type, x, y, buttons, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }, sessionId);
    }
    assert.ok(await evaluate('saved.x < .5 && saved.y < .85'), JSON.stringify(await evaluate('({saved,pointerLog,drag:overlayShadow.querySelector("#drag").getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight})')));
    const resize = await evaluate(`(() => {const r=overlayShadow.querySelector('#resize').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const [type, x, buttons] of [['mouseMoved', resize.x, 0], ['mousePressed', resize.x, 1], ['mouseMoved', resize.x - 60, 1], ['mouseReleased', resize.x - 60, 0]]) {
      await cdp('Input.dispatchMouseEvent', { type, x, y: resize.y, buttons, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }, sessionId);
    }
    assert.ok(await evaluate('saved.width < 720 && saved.width >= 240'));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    assert.ok(await evaluate(`(() => {const r=overlayShadow.querySelector('#box').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`));
    await evaluate(`runtimeListeners.forEach(fn=>fn({type:'STATE',session:{cues:[{start:0,end:10000,text:'Nguồn'}],clock:{time:1,paused:true,rate:1,at:Date.now()}},isSource:true}))`);
    assert.equal(await evaluate(`overlayShadow.querySelector('#box').hidden`), true);
    await evaluate(`runtimeListeners.forEach(fn=>fn({type:'STATE',session:null,isSource:false}))`);
    assert.equal(await evaluate(`overlayShadow.querySelector('#box').hidden`), true);
    console.log('Chrome overlay smoke passed: Vietnamese captions, regular weight, click-through, font controls, drag/resize/save, narrow viewport, source hiding, stop.');
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) {
      browser.kill();
      await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 2000).unref(); });
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Delete only the exact temporary profile created above, never a user profile.
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('subtitle-smoke-')) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Chrome may still hold a temporary file. */ }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
