// Offline Edge regression: IPC fixtures only; all external requests are blocked.
// Distinguishes a document navigation from replacement of existing broadcast DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../dist/broadcast-focus-tests'));
const channel = process.env.DV_BROWSER_CHANNEL ?? 'msedge';
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, authenticated: true, broadcast_console: true },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, events: [] },
  queue: { current: null, pending: [], history: [] }, rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: { user_id: 42, name: '虚构主播甲' }, qr: { status: 'idle' }, status: {},
  broadcast: {
    room: { room_id: 123, title: '保留的直播间', parent_area_id: 2, area_id: 86, live_status: 1, live_since: Math.floor(Date.now() / 1000) - 600 },
    areas: [{ id: 2, name: '网游', children: [{ id: 86, name: '测试分区' }] }],
    has_stream_key: false, busy: false, face_image: null,
  },
  obs: { settings: { enabled: true, host: '127.0.0.1', port: 4455 }, has_password: false, status: { state: 'idle' }, local: true },
  overlay: { settings: { enabled: true, title: '原来的主标题' }, running: true, clients: [] },
};
const calls = [];
const errors = [];
const checks = [];
let holdNext = false;
let rejectNext = false;
let held = null;
const until = async predicate => {
  const expires = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > expires) throw new Error('Timed out waiting for fixture IPC');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      let bytes = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
      if (pathname === '/app.js') bytes = bytes.toString() + '\n// Offline regression inspection only.\nwindow.__focusInspect = () => structuredClone(snapshot);';
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--disable-features=msWindowTabManagerPublic'], ...(channel && channel !== 'chromium' ? { channel } : {}) });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__offlineInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch');
      calls.push(structuredClone(args));
      if (args.action === 'bili.broadcast.refresh') {
        const result = structuredClone(state);
        if (holdNext) {
          holdNext = false;
          await new Promise(resolve => { held = { resolve, result }; });
          return result;
        }
        if (rejectNext) { rejectNext = false; throw new Error('虚构网络读取失败 [DV-B04]'); }
        return result;
      }
      if (args.action === 'obs.bitrate.get') return { ...structuredClone(state), result: { bitrate_kbps: 6000, output_mode: 'simple', editable: true, outputs_active: true, applies_next_stream: true, reason: null } };
      if (args.action === 'bili.chat.emoticons.refresh') {
        state.chat_send = { busy: false, error: null, account_id: state.account.user_id, room_id: state.broadcast.room.room_id, message_limit: 20, emoticons: [] };
        return structuredClone(state);
      }
      if (args.action === 'bili.broadcast.start') {
        assert.equal(args.payload.confirmed, true);
        assert.equal(args.payload.area_id, state.broadcast.room.area_id);
        Object.assign(state.broadcast.room, { live_status: 1, live_since: Math.floor(Date.now() / 1000) });
        // Runtime broadcast changes do not advance configuration revision.
        return { ...structuredClone(state), result: { obs: { outcome: 'started' } } };
      }
      if (['bili.qr.cancel', 'doubao.qr.cancel'].includes(args.action)) return structuredClone(state);
      throw new Error('Unexpected fixture action ' + args.action);
    });
    await page.addInitScript(() => {
      window.__offlineListeners = {};
      window.__documentIdentity = crypto.randomUUID();
      window.__clockShift = 0;
      window.__fixtureHidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__fixtureHidden });
      const now = Date.now.bind(Date);
      Date.now = () => now() + window.__clockShift;
      window.__TAURI__ = { core: { invoke: (command, args) => window.__offlineInvoke(command, args) }, event: { listen: async (name, listener) => { window.__offlineListeners[name] = listener; return () => {}; } } };
    });
    await page.goto(origin);
    await page.locator('#live-shell').waitFor();
    await page.screenshot({ path: path.join(output, 'initial-main.png') });
    await fs.writeFile(path.join(output, 'initial-layout.json'), JSON.stringify(await page.evaluate(() =>
      Object.fromEntries(['#lake-title', '.lake-room-row', '.masthead-title', '#masthead-name', '#live-shell'].map(selector => {
        const node = document.querySelector(selector); const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        return [selector, { text: node.textContent, hidden: node.hidden, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: style.display, visibility: style.visibility, opacity: style.opacity, maxWidth: style.maxWidth }];
      }))), null, 2));
    await page.locator('#lake-title').waitFor();
    await until(() => calls.filter(call => call.action === 'bili.broadcast.refresh').length === 1);
    await page.waitForTimeout(120);
    await page.locator('#chat-message').fill('未发送的弹幕草稿');
    await page.locator('#lake-title').click();
    await page.locator('#onair-panel input[name="title"]').fill('未保存的直播标题');
    await page.locator('#chat-message').evaluate(input => { input.focus(); input.setSelectionRange(1, 4); });
    const identity = await page.evaluate(() => {
      const selectors = ['#live-shell', '#chat-feed', '#chat-scroll', '#chat-compose', '#chat-compose form[data-form="chat-send"]', '#chat-message', '#lake-title', '#onair .onair-go', '#onair-panel', '#onair-panel input[name="title"]'];
      window.__retained = Object.fromEntries(selectors.map(selector => [selector, document.querySelector(selector)]));
      window.__entryAnimations = [];
      document.addEventListener('animationstart', event => { if (event.target.matches('.live-shell, .onair, .onair-panel')) window.__entryAnimations.push(event.animationName); });
      const input = document.querySelector('#chat-message');
      input.focus(); input.setSelectionRange(1, 4);
      return window.__documentIdentity;
    });
    const retained = async label => {
      assert.equal(await page.evaluate(() => window.__documentIdentity), identity, `${label}: document navigated`);
      const changed = await page.evaluate(() => Object.entries(window.__retained).filter(([selector, node]) => document.querySelector(selector) !== node || !node.isConnected).map(([selector]) => selector));
      assert.deepEqual(changed, [], `${label}: existing UI nodes replaced`);
      assert.equal(await page.locator('#onair-panel input[name="title"]').inputValue(), '未保存的直播标题');
      assert.equal(await page.locator('#onair-overlay-title').count(), 0, 'removed overlay title editing returned');
      assert.equal(state.overlay.settings.title, '原来的主标题');
      assert.equal(await page.locator('#chat-message').inputValue(), '未发送的弹幕草稿');
      assert.deepEqual(await page.evaluate(() => [document.querySelector('#chat-message').selectionStart, document.querySelector('#chat-message').selectionEnd]), [1, 4]);
      assert.equal(await page.locator('#onair .loading').count(), 0, 'existing room became a loading placeholder');
    };
    const changeFocus = async (active, due = false) => page.evaluate(({ active, due }) => {
      if (due) window.__clockShift += 60001;
      window.__fixtureHidden = !active;
      window.dispatchEvent(new Event(active ? 'focus' : 'blur'));
      window.__offlineListeners['resource-mode']({ payload: active });
      document.dispatchEvent(new Event('visibilitychange'));
    }, { active, due });
    for (let cycle = 0; cycle < 3; cycle++) {
      await changeFocus(false); await page.waitForTimeout(35);
      await changeFocus(true); await page.waitForTimeout(80);
      await retained('ordinary focus return');
    }
    assert.equal(calls.filter(call => call.action === 'bili.broadcast.refresh').length, 1);
    checks.push('focus and visibility cycles preserve document, main controls, title/chat drafts and selection');

    holdNext = true;
    await page.locator('#chat-message').evaluate(input => {
      input.focus(); input.setSelectionRange(1, 4);
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '草稿' }));
    });
    await changeFocus(false);
    await changeFocus(true, true);
    await until(() => held !== null);
    state.broadcast.busy = true;
    await changeFocus(false); await changeFocus(true);
    await page.waitForFunction(() => document.querySelector('#onair .onair-go').disabled);
    await retained('pending periodic refresh');
    for (let cycle = 0; cycle < 2; cycle++) { await changeFocus(false); await changeFocus(true); }
    assert.equal(calls.filter(call => call.action === 'bili.broadcast.refresh').length, 2);
    state.broadcast.busy = false;
    held.resolve(); held = null;
    await page.waitForTimeout(220);
    await changeFocus(false); await changeFocus(true);
    await page.waitForFunction(() => !document.querySelector('#onair .onair-go').disabled);
    await retained('completed periodic refresh');
    await page.locator('#chat-message').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '草稿' })));
    assert.equal(calls.filter(call => call.action === 'obs.bitrate.get').length, 0, 'the source title editor does not request OBS bitrate details');
    checks.push('periodic refresh and busy snapshots preserve existing room and controls without duplicate requests');

    rejectNext = true;
    await changeFocus(false); await changeFocus(true, true);
    await until(() => calls.filter(call => call.action === 'bili.broadcast.refresh').length === 3);
    await page.waitForTimeout(180);
    await retained('failed periodic refresh');
    assert.deepEqual(await page.evaluate(() => window.__entryAnimations), []);
    checks.push('failed background read preserves the last visible room and completed entry animations');

    holdNext = true;
    await changeFocus(false); await changeFocus(true, true);
    await until(() => held !== null);
    const oldRead = held; held = null;
    state.account = { user_id: 99, name: '虚构主播乙' };
    state.setup.uid = 99;
    state.broadcast.room = { ...state.broadcast.room, room_id: 456, title: '新账号的直播间' };
    state.config_revision++;
    await changeFocus(false); await changeFocus(true);
    await page.locator('#lake-title').filter({ hasText: '虚构主播乙的直播间' }).waitFor();
    await until(() => calls.filter(call => call.action === 'bili.broadcast.refresh').length === 5);
    oldRead.resolve();
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#lake-title').textContent(), '虚构主播乙的直播间');
    assert.equal(await page.locator('#onair-panel').isHidden(), true, 'old account details/drafts remain open');
    assert.equal(await page.evaluate(() => window.__documentIdentity), identity);
    checks.push('a late previous-account read cannot restore its account, room or details');

    const endedObservedAt = Math.floor(Date.now() / 1000);
    state.broadcast.last_session = { started_at: endedObservedAt - 600, observed_started_at: endedObservedAt - 600, ended_observed_at: endedObservedAt, messages: 0, seconds: 600 };
    Object.assign(state.broadcast.room, { live_status: 0, live_since: null });
    await changeFocus(false); await changeFocus(true, true);
    await page.waitForTimeout(120);
    await fs.writeFile(path.join(output, 'off-air-layout.json'), JSON.stringify(await page.evaluate(() => ({
      state: window.__focusInspect(), onair: document.querySelector('#onair').outerHTML,
    })), null, 2));
    // A ended stream returns to the source's preparation scene before the
    // next explicit start. This transition is local and issues no start IPC.
    const startsBeforePrepare = calls.filter(call => call.action === 'bili.broadcast.start').length;
    await page.locator('#onair [data-action="lake.prepare"]').click();
    assert.equal(calls.filter(call => call.action === 'bili.broadcast.start').length, startsBeforePrepare);
    await page.locator('#onair [data-action="broadcast.start"]').waitFor();
    const revisionBeforeStart = state.config_revision;
    holdNext = true;
    await changeFocus(false); await changeFocus(true, true);
    await until(() => held !== null);
    const oldOffRead = held; held = null;
    await page.locator('#onair [data-action="broadcast.start"]').click();
    await page.locator('#onair [data-action="broadcast.stop"]:not([disabled])').waitFor();
    assert.equal(state.config_revision, revisionBeforeStart, 'fixture must exercise equal-revision runtime replies');
    await page.evaluate(() => { window.__startedControl = document.querySelector('#onair .onair-go'); });
    holdNext = true;
    await changeFocus(false); await changeFocus(true, true);
    await until(() => held !== null);
    const newLiveRead = held; held = null;
    const readsWhileNewPending = calls.filter(call => call.action === 'bili.broadcast.refresh').length;
    oldOffRead.resolve();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#onair .onair-go').getAttribute('data-action'), 'broadcast.stop', 'old off-air reply rolled back the explicit start');
    assert.equal(await page.evaluate(() => document.querySelector('#onair .onair-go') === window.__startedControl), true, 'old off-air reply replaced the newly started control');
    // If the old finally releases the newer read's flag, another due focus
    // snapshot would issue a third concurrent refresh.
    await changeFocus(false); await changeFocus(true, true);
    await page.waitForTimeout(100);
    assert.equal(calls.filter(call => call.action === 'bili.broadcast.refresh').length, readsWhileNewPending);
    newLiveRead.resolve();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#onair .onair-go').getAttribute('data-action'), 'broadcast.stop');
    assert.equal(await page.evaluate(() => document.querySelector('#onair .onair-go') === window.__startedControl), true);
    assert.equal(calls.filter(call => call.action === 'bili.broadcast.start').length, 1);
    checks.push('a late off-air read cannot roll back an explicit start or release a newer pending read');
    assert.equal(calls.some(call => /bili\.broadcast\.(stop|update)|obs\.bitrate\.set|overlay\.title\.save|bili\.chat\.(send|emoticon\.send)/.test(call.action)), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'retained-main.png') });
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, headless: true, browser: channel || 'chromium', externalNetwork: false, nativeWebView2: false, actualBroadcast: false, checks, actions: calls.map(call => call.action) }, null, 2));
    console.log(`Broadcast focus regression passed (${checks.length} scenarios, no document navigation or existing UI replacement).`);
  } finally {
    held?.resolve();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
