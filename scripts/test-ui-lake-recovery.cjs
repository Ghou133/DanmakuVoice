// Actual production UI, fictional IPC, no external traffic or native actions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/lake-recovery/browser-final'));
const auditedAssets = ['app.js', 'helpers.mjs', 'index.html', 'styles.css', 'lake.css', 'lake-drawers.css', 'fonts/DanmakuVoiceSerifSC-Medium.woff2', 'fonts/DanmakuVoiceSerifSC-Bold.woff2', 'fonts/DanmakuVoiceSerifSC-Black.woff2', 'fonts/InstrumentSerif-Regular.woff2', 'fonts/InstrumentSerif-Italic.woff2'];
const hash = value => createHash('sha256').update(value).digest('hex');
const checks = [], trace = [], calls = [], errors = [];
const check = name => { checks.push(name); console.log(`ok ${name}`); };
const event = (id, message = '已经展示过') => ({ platform_event_id: `fictional-recovery-${id}`, room_id: 999, observed_at_ms: 1791288000000 + id, kind: 'danmaku', user_id: 500, user_name: '虚构观众隐私名称', message, avatar_url: null });
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: false },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 }, live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, received: 1, events: [event(1)], audience: { active: false } },
  queue: { current: null, pending: [], history: [] }, rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: { user_id: 42, name: '虚构主播隐私名称' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: { room_id: 999, title: '首次准备开播标题', parent_area_id: 1, area_id: 10, live_status: 0, live_since: null }, areas: [], busy: false, has_stream_key: false, face_image: null, last_session: null, session_active: false },
  obs: { settings: { enabled: false, host: '127.0.0.1', port: 4455 }, has_password: false, status: { state: 'idle' }, local: true },
  overlay: { settings: { enabled: false, title: '' }, running: false, clients: [] },
  chat_send: { busy: false, error: null, account_id: 42, room_id: 999, message_limit: 20, emoticons: [] },
  moderation: { busy: false, user_id: null, room_id: null, can_moderate: false, can_blacklist: false, can_manage_admins: false },
};
let page, browser, server, testedAssets;
let nativeActive = true;
let nativeSession = 'fictional-native-recovery-session';
const snapshot = () => structuredClone(state);
const push = async () => { await page.evaluate(next => window.__lakePush(next), snapshot()); await page.waitForTimeout(90); };
async function phase(label) {
  const actual = await page.locator('#lake-current').evaluate(root => {
    const message = root.querySelector('.lake-message');
    const letters = [...root.querySelectorAll('.lake-letter')];
    return { text: root.querySelector('.lake-message-text')?.textContent, className: message?.className, key: message?.dataset.key, inactive: document.documentElement.dataset.inactive,
      letters: letters.map(node => { const style = getComputedStyle(node); return { name: style.animationName, opacity: style.opacity, filter: style.filter, transform: style.transform, playState: style.animationPlayState }; }) };
  });
  trace.push({ label, actual });
  return actual;
}
function staticLetters(actual, label) {
  assert.ok(actual.letters.length, `${label}: no letters`);
  assert.ok(actual.letters.every(letter => letter.name === 'none' && Number(letter.opacity) === 1 && ['none', 'blur(0px)'].includes(letter.filter) && letter.transform === 'none'), `${label}: already displayed text replayed its letter animation: ${JSON.stringify(actual)}`);
}
function animatedLetters(actual, label) {
  assert.ok(actual.letters.length && actual.letters.every(letter => /^lake-letter-[ab]$/.test(letter.name)), `${label}: first display lost its animation: ${JSON.stringify(actual)}`);
}
async function reload() {
  await page.evaluate(() => sessionStorage.setItem('fixture-native-session', window.__fixtureSession));
  await page.reload();
  await page.locator('#lake-current .lake-letter').first().waitFor();
  await page.evaluate(() => window.__lakeStopPoll());
  await page.waitForTimeout(90);
}
async function activity(value) {
  nativeActive = value;
  await page.evaluate(next => window.__fixtureListeners['resource-mode']({ payload: next }), value);
  await page.waitForTimeout(90);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  // Cache this run's exact production bytes; another agent may edit unrelated
  // OBS functions while the before-failure proof is being captured.
  const sources = new Map();
  for (const file of auditedAssets) sources.set(file, await fs.readFile(path.join(root, file)));
  testedAssets = Object.fromEntries([...sources].map(([file, bytes]) => [file, hash(bytes)]));
  server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
      const target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
      let source = sources.get(relative) || await fs.readFile(target);
      if (relative === 'app.js') source = source.toString() + '\n// Response-only QA instrumentation.\nwindow.__lakePush = acceptSnapshot; window.__lakeRebuild = renderApp; window.__lakeStopPoll = () => { clearTimeout(snapshotTimer); boot.polling = false; };';
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(source);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', executablePath: process.env.DV_BROWSER_PATH || undefined, headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'no-preference' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__fixtureNative', () => ({ active: nativeActive, session: nativeSession }));
    await page.exposeFunction('__fixtureInvoke', async (command, args) => {
      if (command === 'ui_activity') return nativeActive;
      if (command === 'snapshot') return snapshot();
      assert.equal(command, 'dispatch');
      calls.push(structuredClone(args));
      if (args.action === 'bili.chat.emoticons.refresh') state.chat_send = { ...state.chat_send, account_id: state.account.user_id, room_id: state.live.room_id, emoticons: [] };
      else if (args.action === 'bili.broadcast.refresh') assert.equal(state.preferences.broadcast_console, true);
      else if (args.action === 'preferences.save') { Object.assign(state.preferences, args.payload.preferences); state.config_revision++; }
      else throw new Error(`Unexpected fixture action ${args.action}`);
      return snapshot();
    });
    await page.addInitScript(() => {
      window.__fixtureListeners = {};
      window.__fixtureSession = sessionStorage.getItem('fixture-native-session') || 'fictional-native-recovery-session';
      window.__DANMAKUVOICE_STARTUP_THEME__ = { session: window.__fixtureSession, appearance: 'dark', language: 'zh-CN' };
      window.__TAURI__ = { core: { invoke: (command, args) => window.__fixtureInvoke(command, args) }, event: { listen: async (name, listener) => { window.__fixtureListeners[name] = listener; return () => {}; } } };
    });
    await page.goto(origin);
    await page.locator('#lake-current .lake-message').waitFor();
    await page.evaluate(() => window.__lakeStopPoll());
    animatedLetters(await phase('first-visible'), 'first visible phrase');
    await page.waitForTimeout(1900);
    assert.ok((await phase('first-animation-completed')).letters.every(letter => Number(letter.opacity) === 1));
    check('a genuinely new phrase uses the original staggered letter animation and reaches its final form');

    await reload();
    const restored = await phase('reload-already-shown');
    await page.screenshot({ path: path.join(output, 'reload-already-shown.png') });
    staticLetters(restored, 'page reload');
    assert.equal(restored.text, event(1).message);
    check('a full page reload restores an already displayed phrase fully visible without replaying lyrics');

    await page.evaluate(() => window.__lakeRebuild()); await page.waitForTimeout(90);
    staticLetters(await phase('renderApp-already-shown'), 'full main UI render');
    check('a whole main-surface render preserves the displayed state');

    state.preferences.language = 'en'; state.config_revision++; await push();
    staticLetters(await phase('language-already-shown'), 'language-driven UI rebuild');
    state.preferences.language = 'zh-CN'; state.config_revision++; await push();
    check('language changes rebuild metadata while keeping the same old phrase static');

    state.live.events.push(event(2, '全新一句仍然逐字浮现')); await push();
    animatedLetters(await phase('new-after-recovery'), 'new phrase after recovery');
    await page.locator('#lake-current .lake-message').evaluate(node => { window.__heldMessage = node; window.__heldLetter = node.querySelector('.lake-letter'); });
    await activity(false); await activity(true);
    const returned = await phase('return-after-partial-display');
    staticLetters(returned, 'return after partially displayed phrase');
    assert.equal(await page.evaluate(() => document.querySelector('#lake-current .lake-message') === window.__heldMessage && document.querySelector('#lake-current .lake-letter') === window.__heldLetter), true);
    check('returning midway through a shown phrase reveals its final form on the same message and letter nodes');

    state.live.events.push(event(3, '新的弹幕到来')); await push();
    animatedLetters(await phase('new-third-phrase'), 'new phrase after focus return');
    assert.equal(await page.evaluate(() => document.querySelector('#lake-history').contains(window.__heldMessage)), true);
    const sunk = await page.evaluate(() => ({ letters: [...window.__heldMessage.querySelectorAll('.lake-letter')].map(node => getComputedStyle(node).animationName), sink: getComputedStyle(window.__heldMessage).animationName }));
    assert.ok(sunk.letters.every(name => name === 'none')); assert.match(sunk.sink, /lake-sink-[ab]/);
    await page.locator('#lake-current .lake-message').evaluate(node => { window.__stableCurrent = node; window.__stableCurrentStart = node.querySelector('.lake-letter').getAnimations()[0]?.startTime; });
    state.live.state = 'reconnecting'; await push(); state.live.state = 'connected'; await push();
    assert.equal(await page.evaluate(() => document.querySelector('#lake-current .lake-message') === window.__stableCurrent && window.__stableCurrent.querySelector('.lake-letter').getAnimations()[0]?.startTime === window.__stableCurrentStart), true);
    check('new messages sink the original prior node; unrelated connection updates neither reparent nor restart current letters');

    await page.evaluate(() => {
      window.__lakeReparentCount = 0;
      window.__lakeReparentObserver = new MutationObserver(records => { window.__lakeReparentCount += records.filter(record => record.type === 'childList').length; });
      window.__lakeReparentObserver.observe(document.querySelector('#lake-current'), { childList: true });
      window.__lakeReparentObserver.observe(document.querySelector('#lake-history'), { childList: true });
    });
    state.setup.tts_enabled = true; state.preferences.tts_enabled = true;
    state.queue.current = { id: 'fictional-recovery-reading', origin: 'live', user_name: event(3).user_name, text: event(3, '新的弹幕到来').message };
    await push(); assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'live');
    state.queue.current = null; await push();
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'calm');
    assert.equal(await page.evaluate(() => document.querySelector('#lake-current .lake-message') === window.__stableCurrent && window.__stableCurrent.querySelector('.lake-letter').getAnimations()[0]?.startTime === window.__stableCurrentStart), true);
    assert.equal(await page.evaluate(() => { window.__lakeReparentObserver.disconnect(); return window.__lakeReparentCount; }), 0, 'reading scene rerenders unnecessarily removed or reinserted a displayed message');
    check('reading and reading-complete scene rerenders preserve node positions and the original animation timeline');

    await activity(false);
    state.live.events.push(event(4, '后台首次未显示')); await push();
    const background = await phase('background-new-unshown'); animatedLetters(background, 'background new phrase');
    assert.ok(background.letters.every(letter => letter.playState === 'paused'));
    await reload();
    const backgroundReload = await phase('background-reload-unshown'); animatedLetters(backgroundReload, 'unshown phrase after background reload');
    assert.ok(backgroundReload.letters.every(letter => letter.playState === 'paused'));
    await activity(true);
    animatedLetters(await phase('first-foreground-after-background'), 'first foreground display');
    await reload(); staticLetters(await phase('reload-after-background-first-display'), 'seen background phrase recovery');
    check('a never displayed background phrase stays unseen across background reload and animates exactly once when first foregrounded');

    // Identical platform message IDs must not inherit another account's state.
    state.account.user_id = 77; state.setup.uid = 77; await push();
    animatedLetters(await phase('different-account-same-event'), 'different account');
    await reload(); staticLetters(await phase('different-account-reload'), 'same account recovery');
    state.account.user_id = 42; state.setup.uid = 42; await push();
    staticLetters(await phase('return-original-account'), 'original account recovery');
    check('seen hashes are isolated by account and restored when returning to the original account');

    state.live.room_id = 888; state.setup.room_id = 888; await push();
    animatedLetters(await phase('different-reception-room-same-event'), 'different reception room');
    await reload(); staticLetters(await phase('different-room-reload'), 'same reception room recovery');
    state.live.room_id = 999; state.setup.room_id = 999; await push();
    staticLetters(await phase('return-original-room'), 'original room recovery');
    check('reception-room changes isolate seen status even when broadcasting remains disabled');

    const noId = { ...event(5, '没有平台ID的隐私正文'), platform_event_id: null };
    state.live.events.push(noId); await push(); animatedLetters(await phase('fallback-key-new'), 'fallback identity first display');
    await reload(); staticLetters(await phase('fallback-key-restored'), 'fallback identity restored');
    const stored = await page.evaluate(() => sessionStorage.getItem('danmakuvoice.lakePresented'));
    assert.ok(stored, 'no recovery ledger persisted');
    for (const forbidden of [noId.message, noId.user_name, state.account.name, 'fictional-recovery-', 'room_id', 'observed_at_ms']) assert.ok(!stored.includes(forbidden), `ledger leaks ${forbidden}`);
    const ledger = JSON.parse(stored);
    assert.equal(ledger.version, 1); assert.match(ledger.session, /^[a-f0-9]{64}$/);
    assert.ok(ledger.contexts.length <= 8 && ledger.contexts.every(([scope, keys]) => /^[a-f0-9]{64}$/.test(scope) && keys.length <= 512 && keys.every(key => /^[a-f0-9]{64}$/.test(key))));
    check('fallback IDs recover correctly, and persisted bounded state contains hashes rather than chat body or identities');

    state.live.running = false; state.live.state = 'stopped'; await push();
    staticLetters(await phase('stopped-carried-observation'), 'stopped carried observation');
    state.live.running = true; state.live.state = 'connected'; await push();
    staticLetters(await phase('reconnected-carried-observation'), 'reconnected carried observation');
    await reload(); staticLetters(await phase('reload-reconnected-observation'), 'reconnected page reload');
    check('stop, reconnect and reload retain the same carried observation without replaying it');

    state.live.events = [];
    await push();
    state.live.events = [{ ...event(1, '同ID但新接收场次'), observed_at_ms: event(1).observed_at_ms + 3600000 }];
    await push(); animatedLetters(await phase('reused-id-new-observation'), 'new observation with reused platform ID');
    await reload(); staticLetters(await phase('reused-id-observation-restored'), 'same reused-ID observation recovery');
    check('a reused platform ID at a new reception time starts one new animation and then recovers statically');

    state.preferences.broadcast_console = true; state.config_revision++; await push();
    const prepared = await phase('prepared-title-first'); animatedLetters(prepared, 'prepared title first display');
    assert.equal(prepared.text, state.broadcast.room.title);
    assert.equal(await page.locator('#lake-current .lake-message').count(), 0);
    await page.screenshot({ path: path.join(output, 'prepared-title-first.png') });
    state.preferences.broadcast_console = false; state.config_revision++; await push();
    staticLetters(await phase('return-from-prepared'), 'return from prepared');
    check('the first prepared title retains its original animation while returning to old chat stays static');

    await page.evaluate(() => { window.__fixtureSession = 'fictional-native-new-session'; });
    nativeSession = 'fictional-native-new-session'; await reload();
    animatedLetters(await phase('new-native-session'), 'new native session');
    check('a new native app session begins a fresh bounded presentation ledger');

    await page.evaluate(() => {
      window.__historyMutationCount = 0;
      new MutationObserver(records => window.__historyMutationCount += records.length).observe(document.querySelector('#chat-feed'), {childList:true,subtree:true,attributes:true,characterData:true});
    });
    state.live.events = Array.from({length:100}, (_, index) => event(1000 + index, `历史 ${index}`));
    await push();
    assert.equal(await page.evaluate(() => window.__historyMutationCount), 0);
    await page.locator('[data-action="history.open"]').click();
    assert.equal(await page.locator('#chat-feed .lake-history-entry').count(), 100);
    assert.match(await page.locator('#chat-feed .lake-history-entry').first().textContent(), /历史 99/);
    await page.keyboard.press('Escape');
    check('closed history has no DOM work during a 100-message refresh and opens with the complete latest transcript');

    assert.deepEqual(errors, [], 'browser JavaScript errors');
    assert.ok(calls.every(call => ['preferences.save', 'bili.chat.emoticons.refresh', 'bili.broadcast.refresh'].includes(call.action)), 'unapproved fixture action');
    const finalAssets = Object.fromEntries(await Promise.all(auditedAssets.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])));
    assert.deepEqual(finalAssets, testedAssets, 'assets changed during final acceptance; rerun on freeze');
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, checked_at: new Date().toISOString(), evidence: 'headless Edge actual production UI with fictional IPC and all external traffic blocked; reload and focus semantics verified, no native memory-reclamation or account/audio acceptance', tested_assets_sha256: testedAssets, checks, trace, calls, errors }, null, 2));
    console.log(`${checks.length} lake recovery checks passed`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, checked_at: new Date().toISOString(), tested_assets_sha256: testedAssets, checks, trace, calls, errors, error: error.stack }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
