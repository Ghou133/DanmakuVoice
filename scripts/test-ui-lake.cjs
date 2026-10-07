// Offline regression of the production app module in headless Edge.
// Fictional IPC is installed by this test server only; all external traffic is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/lake-ui-tests'));
const checks = [];
const calls = [];
const errors = [];
const connectionTrace = [];
const auditedAssets = ['app.js', 'helpers.mjs', 'index.html', 'styles.css', 'lake.css', 'lake-drawers.css', 'fonts/DanmakuVoiceSerifSC-Medium.woff2', 'fonts/DanmakuVoiceSerifSC-Bold.woff2', 'fonts/DanmakuVoiceSerifSC-Black.woff2', 'fonts/InstrumentSerif-Regular.woff2', 'fonts/InstrumentSerif-Italic.woff2'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(auditedAssets.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
let testedAssets;
const check = name => { checks.push(name); console.log(`ok ${name}`); };
const event = number => ({
  platform_event_id: `fictional-lake-${number}`, room_id: 999, observed_at_ms: Date.now() - (9 - number) * 60000,
  kind: 'danmaku', user_id: 500 + number, user_name: `虚构观众${number}`, message: `水月弹幕第 ${number} 句`, avatar_url: null,
});
const user = (id, name) => ({ user_id: id, user_name: name, rank: id - 500, score: '20', guard_level: 3, medal_name: '虚构粉丝牌', medal_level: 7, avatar_url: null });
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: false },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, received: 40, events: Array.from({ length: 8 }, (_, i) => event(i + 1)),
    audience: { active: true, live_status: 1, loading: false, error: null, rank_count: 128, rank_count_text: '128', watched_count: 1024, updated_at_ms: Date.now(), page: 1, has_more: false,
      users: [user(501, '虚构观众1'), user(502, '虚构观众2'), user(503, '虚构观众3')] } },
  queue: { current: null, pending: [], history: [] }, rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: { room_id: 999, title: '水月 · 虚构直播间', parent_area_id: 1, area_id: 10, live_status: 0, live_since: null },
    areas: [{ id: 1, name: '娱乐', children: [{ id: 10, name: '视频唱见' }, { id: 11, name: '音乐演唱' }] }, { id: 2, name: '网游', children: [{ id: 20, name: '虚构分区' }] }], busy: false, has_stream_key: false, face_image: null, last_session: null, session_active: false },
  obs: { settings: { enabled: true, host: '127.0.0.1', port: 4455 }, has_password: false, status: { state: 'idle' }, local: true },
  overlay: { settings: { enabled: true, title: '保留的叠加层标题' }, running: true, clients: [] },
  chat_send: { busy: false, error: null, account_id: 42, room_id: 999, message_limit: 20, emoticons: [] },
  moderation: { busy: false, user_id: null, room_id: null, can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null, message: null },
};

let page;
let browser;
let server;
let failNextTitle = false;
let faceNextStart = false;
const snapshots = () => structuredClone(state);
const push = async () => { await page.evaluate(next => window.__lakePush(next), snapshots()); await page.waitForTimeout(50); };
const actionCalls = action => calls.filter(call => call.action === action);
const history = () => page.locator('#lake-history-dialog');
const editor = () => page.locator('#onair-panel[data-mode="info"]');
const outside = () => page.locator('#live-shell').click({ position: { x: 15, y: 390 } });
const isOpen = locator => locator.evaluate(node => node.open ?? !node.hidden);
async function withinViewport(locator, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} has no visible rectangle`);
  const size = page.viewportSize();
  assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `${label} overflows ${size.width} x ${size.height}: ${JSON.stringify(box)}`);
  return box;
}
async function noOverflow(label) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  assert.ok(overflow.document <= 1 && overflow.body <= 1, `${label} has horizontal overflow: ${JSON.stringify(overflow)}`);
}
async function noOverlap(selectors, label) {
  const overlap = await page.evaluate(list => {
    const boxes = list.map(selector => {
      const node = document.querySelector(selector);
      if (!node || !node.getClientRects().length) return null;
      const box = node.getBoundingClientRect();
      const visible = { selector, x: box.x, y: box.y, right: box.right, bottom: box.bottom };
      // A tall management section scrolls under its card footer. Compare the
      // actually visible clipped surfaces, not offscreen scroll content.
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent); const clip = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { visible.x = Math.max(visible.x, clip.left); visible.right = Math.min(visible.right, clip.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { visible.y = Math.max(visible.y, clip.top); visible.bottom = Math.min(visible.bottom, clip.bottom); }
      }
      return visible;
    }).filter(Boolean);
    const pairs = [];
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      if (Math.min(boxes[a].right, boxes[b].right) - Math.max(boxes[a].x, boxes[b].x) > 1 && Math.min(boxes[a].bottom, boxes[b].bottom) - Math.max(boxes[a].y, boxes[b].y) > 1) pairs.push([boxes[a].selector, boxes[b].selector]);
    }
    return pairs;
  }, selectors);
  assert.deepEqual(overlap, [], `${label}: controls overlap`);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  testedAssets = await sourceHashes();
  server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
      let source = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
      if (pathname === '/app.js') source = source.toString() + '\n// Test response instrumentation, never installed in production.\nwindow.__lakePush = acceptSnapshot;\nwindow.__lakeStopPoll = () => { clearTimeout(snapshotTimer); boot.polling = false; };';
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(source);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', executablePath: process.env.DV_BROWSER_PATH || undefined, headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__fixtureInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return snapshots();
      assert.equal(command, 'dispatch');
      const { action, payload } = args;
      calls.push(structuredClone({ action, payload }));
      if (action === 'preferences.save') { Object.assign(state.preferences, payload.preferences); state.config_revision++; }
      else if (action === 'bili.chat.emoticons.refresh') {
        state.chat_send = { busy: false, error: null, account_id: state.account.user_id, room_id: state.broadcast.room.room_id, message_limit: 20, emoticons: [] };
      }
      else if (action === 'bili.broadcast.refresh') assert.equal(state.preferences.broadcast_console, true);
      else if (action === 'bili.broadcast.update') {
        if (failNextTitle) { failNextTitle = false; throw new Error('虚构标题保存失败 [DV-B04]'); }
        assert.equal(payload.confirmed, true);
        Object.assign(state.broadcast.room, payload);
      } else if (action === 'bili.broadcast.start') {
        assert.equal(state.preferences.broadcast_console, true);
        assert.equal(payload.confirmed, true);
        if (faceNextStart) { faceNextStart = false; state.broadcast.face_image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yN+UAAAAASUVORK5CYII='; }
        else { state.broadcast.face_image = null; Object.assign(state.broadcast.room, { live_status: 1, live_since: Math.floor(Date.now() / 1000) - 1 }); }
        return { ...snapshots(), result: { obs: { outcome: state.broadcast.face_image ? 'needs_face' : 'started' } } };
      } else if (action === 'bili.broadcast.stop') {
        assert.equal(payload.confirmed, true);
        // The fixture supplies the backend ledger result. SQLite reopen/count
        // correctness is covered by the real Rust storage/session tests.
        const ended = Math.floor(Date.now() / 1000);
        state.broadcast.last_session = { started_at: ended - 8040, observed_started_at: ended - 8040, ended_observed_at: ended, messages: 151, seconds: 8040 };
        state.broadcast.session_active = false;
        Object.assign(state.broadcast.room, { live_status: 0, live_since: null });
        return { ...snapshots(), result: { obs: { outcome: 'stopped' } } };
      } else if (action === 'bili.moderation.refresh') {
        state.moderation = { busy: false, user_id: payload.user_id, room_id: 999, can_moderate: true, can_blacklist: true, can_manage_admins: true, muted: false, blacklisted: false, is_admin: false, message: null };
      } else if (action === 'rules.save') { state.rules = structuredClone(payload.rules); state.config_revision++; }
      else if (action === 'obs.bitrate.get') return { ...snapshots(), result: { bitrate_kbps: 6000, output_mode: 'simple', editable: true, outputs_active: false, applies_next_stream: false, reason: null } };
      else if (!['bili.qr.cancel', 'doubao.qr.cancel'].includes(action)) throw new Error(`Unexpected fixture action ${action}`);
      return snapshots();
    });
    await page.addInitScript(() => {
      window.__fixtureListeners = {};
      window.__TAURI__ = { core: { invoke: (command, args) => window.__fixtureInvoke(command, args) }, event: { listen: async (name, listener) => { window.__fixtureListeners[name] = listener; return () => {}; } } };
    });
    await page.goto(origin);
    await page.locator('#lake-current .lake-message').waitFor();
    await page.evaluate(() => window.__lakeStopPoll());
    assert.equal(await page.locator('#live-shell.lake-mode .lake-scenery').count(), 1);
    assert.equal(await page.locator('.lake-sky, .lake-water, .lake-horizon').count(), 3);
    assert.equal(await page.locator('.lake-ridge').count(), 2);
    assert.equal(await page.locator('.lake-wave').count(), 148);
    const horizon = await page.locator('.lake-horizon').boundingBox();
    assert.ok(Math.abs(horizon.y - 476) < 1, `reference horizon moved: ${horizon.y}`);
    assert.equal(await page.locator('#titlebar-actions button').count(), 2);
    assert.deepEqual(await page.locator('#titlebar-actions button').evaluateAll(nodes => nodes.map(node => node.dataset.action)), ['theme.toggle', 'settings.open']);
    assert.equal(await page.locator('#onair').isHidden(), true);
    assert.equal(await page.locator('#live-shell [data-action="broadcast.start"], #live-shell [data-action="broadcast.stop"]').count(), 0);
    assert.equal(actionCalls('bili.broadcast.refresh').length, 0);
    check('lake scenery and exactly two toolbar tools render; disabled broadcast has no start/stop controls or room reads');

    // A real connection often completes before the first danmaku arrives. No
    // event key, scene, account or room change should be needed to refresh it.
    const connectionCases = [
      { state: 'connecting', running: true, title: '正在连接直播间…', description: '连接成功后，新消息会自动显示。', caption: '正在连接', button: false },
      { state: 'connected', running: true, title: 'the lake is still.', description: '第一句弹幕会浮现在这里', caption: '正在接收', button: false },
      { state: 'reconnecting', running: true, title: '正在重新连接直播间…', description: '连接恢复后，新消息会自动显示。', caption: '连接中断，正在重连', button: false },
      { state: 'session_expired', running: true, title: '账号登录已失效', description: '请重新扫码登录，连接后继续接收弹幕。', caption: '登录已失效', button: false },
      { state: 'stopped', running: false, title: '尚未连接直播间', description: '连接后，这里会显示收到的弹幕。', caption: '未连接', button: true },
      { state: 'connected', running: true, title: 'the lake is still.', description: '第一句弹幕会浮现在这里', caption: '正在接收', button: false },
    ];
    const heldConnectionEvents = structuredClone(state.live.events);
    state.live.events = [];
    for (const [index, expected] of connectionCases.entries()) {
      Object.assign(state.live, { state: expected.state, running: expected.running, connecting: false });
      await push();
      const actual = await page.locator('#lake-current').evaluate(root => {
        const placeholder = root.querySelector('.lake-state');
        return { title: [...(placeholder?.childNodes || [])].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim(), description: placeholder?.querySelector('small')?.textContent, caption: document.querySelector('#room-caption')?.textContent, buttons: root.querySelectorAll('[data-action="live.toggle"]').length, messages: root.querySelectorAll('.lake-message').length, scene: document.querySelector('#live-shell').dataset.scene };
      });
      connectionTrace.push({ phase: 'empty', index, state: expected.state, running: expected.running, expected, actual });
      await page.screenshot({ path: path.join(output, `connection-empty-${index}-${expected.state}.png`) });
      assert.equal(actual.title, expected.title, `${expected.state} empty title did not follow the new connection state`);
      assert.equal(actual.description, expected.description, `${expected.state} empty description did not follow the new connection state`);
      assert.equal(actual.caption, expected.caption, `${expected.state} reception caption is stale`);
      assert.equal(actual.buttons, expected.button ? 1 : 0, `${expected.state} connection button is stale`);
      assert.equal(actual.messages, 0);
      assert.equal(actual.scene, 'empty');
      check(`empty connection ${index + 1}: ${expected.state} updates its title, description and connect control without a new message`);
    }
    state.live.events = [event(20)];
    await push();
    assert.match(await page.locator('#lake-current .lake-message-text').textContent(), /水月弹幕第 20 句/);
    await page.locator('#lake-current .lake-message').evaluate(node => { window.__connectionStableMessage = { node, text: node.querySelector('.lake-message-text'), letter: node.querySelector('.lake-letter'), key: node.dataset.key }; });
    for (const expected of connectionCases) {
      Object.assign(state.live, { state: expected.state, running: expected.running, connecting: false });
      await push();
      const actual = await page.locator('#lake-current').evaluate(root => ({ sameMessage: root.querySelector('.lake-message') === window.__connectionStableMessage.node, sameText: root.querySelector('.lake-message-text') === window.__connectionStableMessage.text, sameLetter: root.querySelector('.lake-letter') === window.__connectionStableMessage.letter, key: root.querySelector('.lake-message')?.dataset.key, text: root.querySelector('.lake-message-text')?.textContent, states: root.querySelectorAll('.lake-state').length, caption: document.querySelector('#room-caption')?.textContent }));
      connectionTrace.push({ phase: 'existing-message', state: expected.state, running: expected.running, actual });
      assert.equal(actual.sameMessage, true, `${expected.state} rebuilt an existing message node`);
      assert.equal(actual.sameText, true, `${expected.state} rebuilt the current message text`);
      assert.equal(actual.sameLetter, true, `${expected.state} restarted the existing message letter nodes`);
      assert.equal(actual.text, '水月弹幕第 20 句');
      assert.equal(actual.states, 0);
      assert.equal(actual.caption, expected.caption);
    }
    check('the first received message replaces the empty hint, while connection changes preserve that same message and letter nodes');
    state.live.events = heldConnectionEvents;
    Object.assign(state.live, { running: true, state: 'connected', connecting: false });
    await push();

    await page.locator('#titlebar-actions [data-action="theme.toggle"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(state.preferences.appearance, 'light');
    await page.locator('#titlebar-actions [data-action="settings.open"]').click();
    assert.equal(await page.locator('#settings').evaluate(node => node.open), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings').evaluate(node => node.open), false);
    check('day/night saves appearance and the second toolbar tool opens settings');

    assert.equal(await page.locator('#lake-current .lake-message').count(), 1);
    assert.match(await page.locator('#lake-current').textContent(), /水月弹幕第 8 句/);
    assert.equal(await page.locator('#lake-history .lake-message').count(), 4);
    const oldHistory = await page.locator('#lake-history').textContent();
    for (const number of [4, 5, 6, 7]) assert.match(oldHistory, new RegExp(`水月弹幕第 ${number} 句`));
    assert.doesNotMatch(oldHistory, /水月弹幕第 [1238] 句/);
    const previous = await page.locator('#lake-current .lake-message').evaluate(node => { window.__previousLakeMessage = node; return node.dataset.key; });
    state.live.events.push(event(9)); await push();
    assert.match(await page.locator('#lake-current').textContent(), /水月弹幕第 9 句/);
    assert.equal(await page.evaluate(() => document.querySelector('#lake-history').contains(window.__previousLakeMessage)), true, 'previous phrase must sink into history as the same DOM node');
    assert.equal(await page.locator('#lake-history .lake-message').count(), 4);
    await page.locator('[data-action="history.open"]').click();
    assert.equal(await isOpen(history()), true);
    const transcript = await page.locator('#chat-feed').textContent();
    for (let number = 1; number <= 9; number++) assert.match(transcript, new RegExp(`水月弹幕第 ${number} 句`));
    assert.equal(await history().locator('[data-action="history.close"]').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await isOpen(history()), false);
    await page.locator('[data-action="history.open"]').click();
    await outside();
    assert.equal(await isOpen(history()), false);
    check(`latest phrase plus four earlier phrases preserve all nine in a background/Escape-close drawer (previous key ${previous})`);

    await page.locator('.lake-orb').click();
    await page.locator('#tts-menu:not([hidden])').waitFor();
    assert.equal(await page.locator('#tts-menu #main-volume-range').count(), 1);
    await page.locator('#main-volume-range').fill('65');
    await page.locator('#main-volume-range').dispatchEvent('input');
    await page.waitForTimeout(400);
    assert.equal(state.preferences.master_volume, 0.65);
    await page.locator('#tts-menu [data-action="audio.mute"]').click();
    assert.equal(state.preferences.muted, true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tts-menu').isHidden(), true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const waveAnimation = () => page.locator('.lake-wave').first().evaluate(node => getComputedStyle(node).animationName);
    state.preferences.muted = false; state.preferences.tts_enabled = false; state.setup.tts_enabled = false; await push();
    assert.equal(await page.locator('#live-shell').evaluate(node => node.classList.contains('speech-off-state')), true);
    assert.equal(await page.locator('#live-shell').evaluate(node => node.classList.contains('speaking')), false);
    assert.equal(await waveAnimation(), 'none');
    state.preferences.tts_enabled = true; state.setup.tts_enabled = true; await push();
    assert.equal(await page.locator('#live-shell').evaluate(node => node.classList.contains('speech-off-state') || node.classList.contains('speaking')), false);
    assert.equal(await waveAnimation(), 'lake-wave-idle');
    const current = state.live.events.at(-1);
    state.queue.current = { id: 'fictional-speaking', origin: 'live', user_name: current.user_name, text: `${current.user_name}：${current.message}` };
    await push();
    assert.equal(await page.locator('#live-shell').evaluate(node => node.classList.contains('speaking')), true);
    assert.equal(await waveAnimation(), 'lake-wave-speech');
    state.queue.current = null; await push();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'calm');
    check('clicking the moon opens working volume/mute controls; speech-off, idle and speaking states are distinct');

    state.preferences.broadcast_console = true; await push();
    await page.locator('#onair [data-action="broadcast.start"]').waitFor();
    assert.equal(await page.locator('#lake-history .lake-session-line').count(), 0);
    assert.doesNotMatch(await page.locator('#lake-history').textContent(), /暂无记录|暂无上一场数据|上一场/);
    check('preparing without a saved previous session renders no unknown-statistics rows');
    await page.locator('#lake-title').click();
    await editor().waitFor();
    assert.equal(await editor().locator('input[name="title"]').count(), 1);
    assert.equal(await editor().locator('input[name="overlay_title"], #onair-overlay-title, [data-form="onair-overlay-title"]').count(), 0);
    assert.equal(await editor().locator('button[type="submit"]').count(), 1);
    assert.equal(await editor().locator('[data-action="onair.close"]').count(), 0);
    const initialTitle = state.broadcast.room.title;
    await editor().locator('input[name="title"]').fill('点击背景应放弃');
    await outside();
    assert.equal(await editor().isVisible(), false);
    assert.equal(state.broadcast.room.title, initialTitle);
    assert.equal(actionCalls('bili.broadcast.update').length, 0);
    await page.locator('#lake-title').click();
    await editor().locator('input[name="title"]').fill('Escape 应放弃');
    await page.keyboard.press('Escape');
    assert.equal(await editor().isVisible(), false);
    assert.equal(state.broadcast.room.title, initialTitle);
    await page.locator('#lake-title').click();
    await editor().locator('input[name="title"]').fill('月光下的一句歌');
    const titleWritesBeforeIme = actionCalls('bili.broadcast.update').length;
    await editor().locator('input[name="title"]').dispatchEvent('compositionstart', { data: '月光' });
    await editor().locator('input[name="title"]').press('Enter');
    await page.waitForTimeout(80);
    assert.equal(actionCalls('bili.broadcast.update').length, titleWritesBeforeIme, 'IME candidate Enter submitted a title');
    assert.equal(await editor().isVisible(), true);
    await editor().locator('input[name="title"]').dispatchEvent('compositionend', { data: '月光' });
    await editor().locator('input[name="title"]').press('Enter');
    await page.waitForFunction(() => document.querySelector('#onair-panel').hidden);
    assert.equal(state.broadcast.room.title, '月光下的一句歌');
    assert.equal(actionCalls('bili.broadcast.update').length, 1);
    assert.equal(actionCalls('overlay.title.save').length, 0);
    assert.equal(state.overlay.settings.title, '保留的叠加层标题');
    await page.locator('#lake-title').click();
    await editor().locator('input[name="title"]').fill('保留失败草稿');
    failNextTitle = true;
    await editor().locator('button[type="submit"]').click();
    await page.waitForTimeout(200);
    assert.equal(await editor().isVisible(), true);
    assert.equal(await editor().locator('input[name="title"]').inputValue(), '保留失败草稿');
    assert.equal(state.broadcast.room.title, '月光下的一句歌');
    await page.keyboard.press('Escape');
    check('sky title editing has only save, omits OBS title, discards background/Escape changes, saves Enter and preserves a failed draft');

    state.broadcast.room.live_status = 1; state.broadcast.room.live_since = Math.floor(Date.now() / 1000); await push();
    await page.locator('[data-action="history.open"]').click();
    await page.locator('#chat-feed [data-action="viewer.open"]').first().click();
    await page.locator('#viewer-drawer #viewer-alias').waitFor();
    await page.waitForFunction(() => !document.querySelector('#viewer-drawer [data-action="viewer.moderation.mute"]').disabled);
    assert.equal(await page.locator('#viewer-drawer .viewer-head [data-action="viewer.close"]').count(), 0);
    const viewer = await withinViewport(page.locator('#viewer-drawer .viewer-sheet'), 'viewer card');
    assert.ok(viewer.width <= 500, 'viewer card unexpectedly spans the entire main screen');
    assert.equal(await page.locator('#viewer-drawer .viewer-sheet').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await noOverlap(['#viewer-alias', '#viewer-voices', '#viewer-moderation', '#viewer-drawer .viewer-foot'], 'viewer sections');
    await page.locator('#viewer-alias').fill('虚构读音');
    await outside();
    await page.locator('#viewer-drawer').waitFor({ state: 'hidden' });
    assert.equal(state.rules.user_words.some(word => word.from === current.user_name && word.to === '虚构读音'), true);
    await page.locator('[data-action="history.open"]').click();
    await page.locator('#chat-feed [data-action="viewer.open"]').first().click();
    await page.locator('#viewer-alias').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#viewer-drawer').waitFor({ state: 'hidden' });
    check('viewer card integrates identity, pronunciation, voice and room management without overlap; outside/Escape closes and saves alias');

    const heldEvents = state.live.events;
    state.live.events = []; state.preferences.broadcast_console = false; state.broadcast.room.live_status = 0; await push();
    assert.match(await page.locator('#lake-transcript').textContent(), /湖面|the lake is still|仍然安静|静/);
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'empty');
    state.preferences.broadcast_console = true; await push();
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'offair');
    assert.equal(await page.locator('#onair [data-action="broadcast.start"]').isVisible(), true);
    faceNextStart = true;
    await page.locator('#onair [data-action="broadcast.start"]').click();
    await page.locator('#onair-panel[data-mode="face"]').waitFor();
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'face');
    assert.equal(await page.locator('#onair-panel[data-mode="face"] button').count(), 1);
    assert.match(await page.locator('#onair-panel[data-mode="face"] button').textContent(), /继续开播/);
    await outside();
    assert.equal(await page.locator('#onair-panel').isHidden(), true);
    await page.locator('#onair [data-action="broadcast.start"]').click();
    await page.locator('#onair [data-action="broadcast.stop"]').waitFor();
    assert.match(await page.locator('#onair').textContent(), /ON AIR/);
    assert.equal(state.live.running, true);
    state.live.received = 191;
    state.live.events = [{ ...event(99), observed_at_ms: Date.now() }];
    await push();
    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair [data-action="lake.prepare"]').waitFor();
    assert.equal(state.live.running, true, 'ending own broadcast must keep chat reception independent');
    assert.equal(state.broadcast.room.live_status, 0);
    assert.equal(actionCalls('bili.broadcast.stop').length, 1);
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'ended');
    assert.match(await page.locator('#lake-current').textContent(), /今晚辛苦/);
    assert.match(await page.locator('#lake-history').textContent(), /151 句弹幕沉进了湖里/, 'session count must use the persisted backend result beyond the bounded transcript');
    await page.locator('[data-action="lake.prepare"]').click();
    await page.waitForFunction(() => document.querySelector('#live-shell').dataset.scene === 'offair');
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'offair');
    assert.match(await page.locator('#lake-history').textContent(), /151 句弹幕/);
    check('pre-live, empty lake, face verification, on-air and ending use real state paths while chat reception remains independent');
    await page.reload();
    await page.locator('#onair [data-action="broadcast.start"]').waitFor();
    await page.evaluate(() => window.__lakeStopPoll());
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'offair');
    assert.match(await page.locator('#lake-history').textContent(), /151 句弹幕/);
    assert.match(await page.locator('#lake-history').textContent(), /2 小时 14 分/);
    assert.equal(await page.locator('#lake-history .lake-session-line').count(), 2);
    check('page recreation restores the saved prior session without constructing a fake ended scene');
    const accountSummary = structuredClone(state.broadcast.last_session);
    state.account.user_id = 43; state.setup.uid = 43; state.broadcast.last_session = null; await push();
    assert.equal(await page.locator('#lake-history .lake-session-line').count(), 0);
    assert.doesNotMatch(await page.locator('#lake-history').textContent(), /151|暂无记录/);
    state.account.user_id = 42; state.setup.uid = 42;
    state.broadcast.last_session = { ...accountSummary, seconds: null }; await push();
    assert.match(await page.locator('#lake-history').textContent(), /151 句弹幕/);
    assert.doesNotMatch(await page.locator('#lake-history').textContent(), /小时|暂无记录/);
    state.broadcast.last_session = accountSummary; await push();
    check('account changes hide the prior account summary and unknown duration contributes no placeholder');
    state.live.events = heldEvents; await push();
    await page.locator('#onair [data-action="broadcast.start"]').click();
    await page.locator('#lake-current .lake-message').waitFor();
    await page.locator('#toast').waitFor({ state: 'hidden' });

    for (const appearance of ['dark', 'light']) for (const size of [{ width: 1040, height: 740 }, { width: 1600, height: 900 }, { width: 700, height: 700 }]) {
      state.preferences.appearance = appearance; await page.setViewportSize(size); await push();
      await page.waitForTimeout(100);
      await noOverflow(`${appearance} ${size.width}`);
      await withinViewport(page.locator('#lake-title'), 'lake title');
      await withinViewport(page.locator('#lake-current'), 'current phrase');
      await noOverlap(['#lake-title', '#audience-count', '#onair', '#lake-current', '.dock'], `${appearance} ${size.width} main`);
      await page.screenshot({ path: path.join(output, `lake-${appearance}-${size.width}x${size.height}.png`) });
      await page.locator('#lake-current .lake-message-name').click();
      await page.locator('#viewer-alias').waitFor();
      await withinViewport(page.locator('#viewer-drawer .viewer-sheet'), `${appearance} ${size.width} viewer card`);
      assert.equal(await page.locator('#viewer-drawer .viewer-sheet').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      await page.screenshot({ path: path.join(output, `viewer-${appearance}-${size.width}x${size.height}.png`) });
      if (size.width !== 1600) {
        await page.locator('#viewer-drawer .viewer-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
        const durations = await page.locator('#viewer-moderation .viewer-durations').boundingBox();
        const action = await page.locator('#viewer-moderation .viewer-mute-action').boundingBox();
        const card = await page.locator('#viewer-drawer .viewer-sheet').boundingBox();
        assert.ok(durations && action && card, 'management duration/action/card missing');
        assert.ok(durations.x >= card.x && durations.x + durations.width <= card.x + card.width + 1, 'duration choices extend outside viewer card');
        assert.ok(action.y + action.height <= durations.y + 1, 'mute action must sit in the title row above duration choices without overlap');
        await noOverlap(['.viewer-durations', '.viewer-mute-action', '.viewer-block-row', '.viewer-admin-row', '#viewer-drawer .viewer-foot'], `${appearance} ${size.width} management`);
        await page.screenshot({ path: path.join(output, `viewer-moderation-${appearance}-${size.width}x${size.height}.png`) });
      }
      await page.keyboard.press('Escape');
      await page.locator('#viewer-drawer').waitFor({ state: 'hidden' });
    }
    check('day/night main screen and viewer cards fit 1040 x 740, 1600 x 900 and 700 x 700 windows');

    const long = { ...event(10), kind: 'super_chat', price_yuan: 50, user_name: '虚构观众与一个需要完整保留的很长名字', message: '带换行的醒目留言与普通 emoji 😀。\n' + '文字要留在天空里，同时能够在全部弹幕里完整阅读。'.repeat(6) };
    state.live.events.push(long);
    await push();
    assert.equal(await page.locator('#lake-current .lake-message-text').textContent(), long.message);
    await noOverflow('long highlighted phrase');
    await noOverlap(['#lake-current', '#lake-history .lake-message-text', '#tts-switch', '.lake-volume-link', '#speech-switch', '#chat-message', '#chat-compose button[type="submit"]'], 'long highlighted phrase');
    await withinViewport(page.locator('#lake-current'), 'long highlighted phrase');
    await page.screenshot({ path: path.join(output, 'lake-long-highlight-light-700x700.png') });
    await page.locator('[data-action="history.open"]').click();
    assert.ok((await page.locator('#chat-feed').textContent()).includes(long.message), 'full history lost part of the highlighted message');
    await page.keyboard.press('Escape');
    check('long names, multiline highlighted messages and emoji stay in the scene and preserve complete history text');

    const clustered = { ...event(11), message: '👩🏽‍🚀 👨‍👩‍👧‍👦 e\u0301' };
    state.live.events.push(clustered); await push();
    assert.deepEqual(await page.locator('#lake-current .lake-letter').allTextContents(), ['👩🏽‍🚀', ' ', '👨‍👩‍👧‍👦', ' ', 'e\u0301']);
    const movingSelectors = '.lake-scenery *, .lake-orb, #lake-current .lake-letter, #lake-history .lake-message';
    assert.equal(await page.locator(movingSelectors).evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none')), true, 'reduced motion must disable every lake animation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => window.__fixtureListeners['resource-mode']({ payload: false }));
    await page.waitForFunction(() => document.documentElement.dataset.inactive === 'true');
    assert.equal(await page.locator(movingSelectors).evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationPlayState === 'paused')), true, 'background state must freeze all lake animations');
    await page.evaluate(() => window.__fixtureListeners['resource-mode']({ payload: true }));
    await page.waitForFunction(() => document.documentElement.dataset.inactive === 'false');
    assert.equal(await waveAnimation(), 'lake-wave-idle');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('IME Enter waits for committed title input, session totals exceed the message buffer, grapheme clusters stay intact, and reduced/background motion pauses correctly');

    assert.deepEqual(errors, [], 'browser JavaScript errors');
    assert.equal(calls.some(call => /credentials|overlay\.title\.save|bili\.chat\.(send|emoticon\.send)|obs\.bitrate\.set|bili\.moderation\.(mute|blacklist|appoint)/.test(call.action)), false);
    assert.deepEqual(await sourceHashes(), testedAssets, 'production assets changed during browser acceptance');
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, evidence: 'headless Microsoft Edge running actual app module with fictional test-only IPC; external network blocked; no native WebView2, real account, broadcast or audio acceptance', checked_at: new Date().toISOString(), tested_assets_sha256: testedAssets, checks, connectionTrace, errors, actions: calls.map(call => call.action) }, null, 2));
    console.log(`${checks.length} lake UI checks passed`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    const hitTest = page ? await page.evaluate(() => {
      const selectors = ['#tts-menu', '#tts-menu .lake-voice-volume', '#tts-menu [data-action="audio.mute"]', '#main-volume-range', '#lake-pop-scrim'];
      return selectors.map(selector => {
        const node = document.querySelector(selector); if (!node) return { selector, missing: true };
        const box = node.getBoundingClientRect(), style = getComputedStyle(node), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { selector, hidden: node.hidden, className: node.className, parent: node.parentElement?.id || node.parentElement?.className, box: { x: box.x, y: box.y, width: box.width, height: box.height }, zIndex: style.zIndex, pointerEvents: style.pointerEvents, visibility: style.visibility, position: style.position, transform: style.transform, display: style.display, hit: hit?.id || hit?.className };
      });
    }).catch(() => null) : null;
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, checked_at: new Date().toISOString(), tested_assets_sha256: testedAssets, checks, connectionTrace, errors, actions: calls.map(call => call.action), hitTest, error: error.stack }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
