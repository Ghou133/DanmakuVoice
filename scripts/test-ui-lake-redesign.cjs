// Offline regression of the production app module in headless Edge.
// Fictional IPC is installed by this test server only; all external traffic is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/lake-redesign-ui-tests'));
const checks = [];
const calls = [];
const errors = [];
const connectionTrace = [];
const auditedAssets = ['app.js', 'helpers.mjs', 'index.html', 'styles.css', 'lake.css', 'lake-drawers.css', 'lake-redesign-main.css', 'fonts/DanmakuVoiceSerifSC-Medium.woff2', 'fonts/DanmakuVoiceSerifSC-Bold.woff2', 'fonts/DanmakuVoiceSerifSC-Black.woff2', 'fonts/InstrumentSerif-Regular.woff2', 'fonts/InstrumentSerif-Italic.woff2'];
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
let archiveEvents = [];
let failNextHistory = false;
let failBroadcastRead = false;
const snapshots = () => structuredClone(state);
const push = async () => { await page.evaluate(next => window.__lakePush(next), snapshots()); await page.waitForTimeout(50); };
const actionCalls = action => calls.filter(call => call.action === action);
const history = () => page.locator('#lake-deep');
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
      if (pathname === '/app.js') source = source.toString() + '\n// Test response instrumentation, never installed in production.\nwindow.__lakePush = acceptSnapshot;\nwindow.__lakeRefresh = () => refreshBroadcast(true);\nwindow.__lakeStopPoll = () => { clearTimeout(snapshotTimer); boot.polling = false; };';
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
      if (action === 'live.history') {
        if (failNextHistory) { failNextHistory = false; throw new Error('虚构历史读取失败'); }
        assert.equal(payload.session_id, state.live_history.session_id);
        const all = archiveEvents.map((event, index) => ({ sequence: index + 1, event })).reverse();
        const selected = all.filter(item => (!payload.before || item.sequence < payload.before) && (!payload.viewer || `uid:${item.event.user_id}` === payload.viewer));
        const items = selected.slice(0, payload.limit || 100);
        return { ...snapshots(), result: { ...state.live_history, items, before: items.at(-1)?.sequence || null, has_more: selected.length > items.length, viewer_messages: payload.viewer ? all.filter(item => `uid:${item.event.user_id}` === payload.viewer).length : null } };
      }
      if (action === 'preferences.save') { Object.assign(state.preferences, payload.preferences); state.config_revision++; }
      else if (action === 'bili.chat.emoticons.refresh') {
        state.chat_send = { busy: false, error: null, account_id: state.account.user_id, room_id: state.broadcast.room.room_id, message_limit: 20, emoticons: [] };
      }
      else if (action === 'bili.broadcast.refresh') {
        assert.equal(state.preferences.broadcast_console, true);
        if (failBroadcastRead) throw new Error('虚构读取错误：连接超时 [DV-B01]');
      }
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
      else if (action === 'presets.default') { state.rules.default_preset_id = payload.id; state.config_revision++; }
      else if (action === 'local_services.start') state.local_services[payload.provider].state = 'starting';
      else if (action === 'audition') { /* verifies selected ID without selecting default */ }
      else if (action === 'bili.moderation.mute') { state.moderation.muted = true; }
      else if (action === 'bili.moderation.unmute') { state.moderation.muted = false; }
      else if (action === 'bili.moderation.blacklist') { state.moderation.blacklisted = true; }
      else if (action === 'bili.moderation.appoint') { state.moderation.is_admin = true; }
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

    assert.equal(await page.locator('#lake-history, #lake-history-dialog').count(), 0);
    assert.equal(await page.locator('#lake-peek .lake-peek-entry').count(), 3);
    assert.equal(await page.locator('#lake-text-reflection').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#lake-current .lake-message-text').textContent(), await page.locator('#lake-text-reflection').textContent());
    const currentBottom = (await page.locator('#lake-current .lake-message-text').boundingBox()).y + (await page.locator('#lake-current .lake-message-text').boundingBox()).height;
    assert.ok(Math.abs(currentBottom - 460) < 3, `phrase must rest 16px above the 476px horizon: ${currentBottom}`);
    await page.mouse.move(20, 200);
    assert.equal(await page.locator('#lake-peek').evaluate(node => getComputedStyle(node).opacity), '0');
    await page.mouse.move(300, 650); await page.waitForTimeout(600);
    assert.equal(await page.locator('#lake-peek').evaluate(node => getComputedStyle(node).opacity), '1');
    check('current phrase and reflected copy share text, align to horizon, recent three appear only over water');
    await page.screenshot({ path: path.join(output, 'surface-night.png') });

    state.setup.tts_enabled = true; state.preferences.tts_enabled = true;
    state.queue.current = { id: 700, origin: 'live', user_name: state.live.events[5].user_name, text: state.live.events[5].message };
    state.playback = { job_id: 700, played_ms: 1000, queued_ms: 4000 };
    await push();
    assert.equal(await page.locator('#lake-current .lake-message-text').textContent(), state.live.events[5].message);
    const unread = await page.locator('#lake-current .lake-unread').count();
    assert.ok(unread > 0);
    assert.equal(unread, await page.locator('#lake-text-reflection .lake-unread').count());
    state.playback.played_ms = 3000; await push();
    assert.ok(await page.locator('#lake-current .lake-unread').count() < unread);
    assert.equal(await page.locator('#lake-current .lake-unread').count(), await page.locator('#lake-text-reflection .lake-unread').count());
    check('measured audio progress updates matching queued phrase and reflected letters together');

    await page.mouse.move(400, 650); await page.mouse.wheel(0, 250); await page.waitForTimeout(200);
    assert.equal(await history().isVisible(), true);
    assert.equal(await page.locator('#chat-feed .lake-history-entry').count(), 8);
    assert.match(await page.locator('#chat-feed .lake-history-entry').first().getAttribute('data-id'), /fictional-lake-8/);
    assert.match(await page.locator('#lake-deep-stats').textContent(), /8 位朋友说过话/);
    assert.equal(await page.locator('#lake-deep-new').evaluate(node => node.hidden), true);
    state.live.events.push(event(9)); await push();
    assert.match(await page.locator('#lake-deep-new').textContent(), /1 句新弹幕/);
    assert.equal(await page.locator('#lake-deep-new').evaluate(node => node.hidden), false);
    await page.locator('#lake-deep-new').click();
    assert.equal(await page.locator('#lake-deep-new').textContent(), '');
    assert.equal(await page.locator('#lake-deep-new').evaluate(node => node.hidden), true);
    await page.screenshot({ path: path.join(output, 'underwater-night.png') });
    await page.locator('[data-action="lake.surface"]').click();
    assert.equal(await history().isHidden(), true);
    assert.equal(await page.evaluate(() => {
      const node = document.activeElement;
      return node !== document.body && !!node?.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    }), true, 'surfacing must retain a visible focus target');
    check('wheel enters real history, newest first, new message count can be acknowledged, surface returns');

    const eventsBeforeEmpty = state.live.events;
    await page.locator('[data-action="history.open"]').click();
    state.live.events = []; state.queue.current = null; state.playback = null; await push();
    assert.equal(await page.locator('.lake-history-open').evaluate(node => node.hidden), true);
    await page.locator('[data-action="lake.surface"]').click();
    assert.equal(await page.evaluate(() => {
      const node = document.activeElement;
      return node !== document.body && !!node?.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    }), true, 'a hidden history link must not lose focus when returning to the surface');
    state.live.events = eventsBeforeEmpty; await push();
    check('surfacing after history empties focuses a visible control');

    const compactEvents = state.live.events;
    archiveEvents = Array.from({ length: 250 }, (_, i) => ({ ...event(i), user_id: i % 17 + 1, user_name: `完整历史观众${i % 17 + 1}`, observed_at_ms: Date.now() - (250 - i) * 1000 }));
    archiveEvents[0].message += '[湖]';
    state.live_history = { session_id: 'fictional-complete-session', room_id: 999, started_at_ms: Date.now() - 300000, messages: 250, unique_viewers: 17 };
    state.live.events = archiveEvents.slice(-100); await push();
    assert.equal(await page.locator('#lake-history-total').textContent(), '250');
    await page.locator('[data-action="history.open"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#chat-feed .lake-history-entry').length === 100);
    assert.match(await page.locator('#lake-deep-stats').textContent(), /17 位朋友说过话/);
    await page.locator('#chat-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelectorAll('#chat-feed .lake-history-entry').length >= 200);
    await page.locator('#chat-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelectorAll('#chat-feed .lake-history-entry').length === 250);
    assert.match(await page.locator('#chat-feed .lake-history-entry').last().textContent(), /水月弹幕第 0 句/);
    await page.locator('#chat-scroll').evaluate(node => { node.scrollTop = 500; });
    const beforeInsert = await page.locator('#chat-scroll').evaluate(node => { const top = node.getBoundingClientRect().top; const entry = [...node.querySelectorAll('.lake-history-entry')].find(child => child.getBoundingClientRect().bottom > top); return { id: entry.dataset.id, y: entry.getBoundingClientRect().top }; });
    archiveEvents.push(...Array.from({ length: 105 }, (_, i) => ({ ...event(i + 250), user_id: 1, user_name: '完整历史观众1', message: `${event(i + 250).message}[湖]` })));
    state.live_history.messages = 355; state.live.events = archiveEvents.slice(-100); await push();
    await page.waitForFunction(() => document.querySelectorAll('#chat-feed .lake-history-entry').length === 355);
    const afterInsert = await page.locator(`[data-id="${beforeInsert.id}"]`).boundingBox();
    assert.ok(Math.abs(afterInsert.y - beforeInsert.y) < 2, 'new pages must preserve the reading anchor');
    assert.match(await page.locator('#lake-deep-new').textContent(), /105 句新弹幕/);
    archiveEvents[0].emotes = [{ text: '[湖]', url: 'https://i0.hdslb.com/bfs/emote/fictional-lake.png' }];
    archiveEvents.at(-1).emotes = archiveEvents[0].emotes;
    state.live_history.metadata_revision = 1; await push();
    await page.locator('[data-id="history:fictional-complete-session:1"] .message-emote').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#chat-feed .lake-history-entry').count(), 355);
    const afterMetadata = await page.locator(`[data-id="${beforeInsert.id}"]`).boundingBox();
    assert.ok(Math.abs(afterMetadata.y - beforeInsert.y) < 2, 'late metadata must preserve the reading anchor across already-loaded pages');
    await page.locator('[data-action="lake.surface"]').click();
    await page.locator('#lake-current [data-action="viewer.open"]').first().click();
    const count = archiveEvents.filter(event => event.user_id === 1).length;
    await page.waitForFunction(count => document.querySelector('.viewer-uid')?.textContent === `said ${count} tonight`, count);
    assert.equal(await page.locator('.viewer-said time').count(), 3);
    assert.equal(await page.locator('.viewer-said .message-emote').count(), 1);
    await page.locator('[data-action="viewer.close"]').click({ position: { x: 15, y: 15 } });
    state.live_history = { ...state.live_history, session_id: 'fictional-retry-session' }; failNextHistory = true; await push();
    await page.locator('[data-action="history.open"]').click();
    await page.locator('[data-action="lake.history.retry"]').waitFor();
    await page.locator('[data-action="lake.history.retry"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#chat-feed .lake-history-entry').length === 100);
    await page.locator('[data-action="lake.surface"]').click();
    delete state.live_history; state.live.events = compactEvents; await push();
    check('full 355-message history pages past compact 100 buffer, keeps scroll anchor through 105 new lines, refreshes late metadata on all loaded pages, returns total viewer count and recovers read failures');

    state.connections = [{ id: 'cloud', has_credential: true, settings: { provider: 'doubao' } }, { id: 'local', settings: { provider: 'gpt_sovits', endpoint: 'http://127.0.0.1:9880' } }];
    state.presets = [{ id: 'voice-a', name: '温柔桃子', provider: 'doubao', connection_id: 'cloud', voice_id: 'a', speed: 1, volume: 1 }, { id: 'voice-b', name: '软萌小桃', provider: 'gpt_sovits', connection_id: 'local', voice_id: 'b', speed: 1, volume: 1 }];
    state.local_services.gpt_sovits = { state: 'stopped', directory: 'C:\\Fictional', endpoint: 'http://127.0.0.1:9880' };
    state.rules.default_preset_id = 'voice-a'; state.preferences.master_volume = .72;
    await push();
    await page.locator('#tts-switch').hover(); await page.mouse.wheel(0, -100); await page.waitForTimeout(500);
    assert.equal(state.preferences.master_volume, .77);
    assert.equal(await history().isHidden(), true, 'voice wheel must not enter history');
    await page.locator('.lake-volume-waterline').click(); assert.equal(state.preferences.muted, true);
    await page.locator('.lake-volume-waterline').click(); assert.equal(state.preferences.muted, false); assert.equal(state.preferences.master_volume, .77);
    const waterline = page.locator('.lake-volume-waterline');
    assert.equal(await waterline.getAttribute('role'), 'slider');
    await waterline.focus();
    for (const [key, volume] of [['ArrowLeft', .72], ['ArrowDown', .67], ['ArrowRight', .72], ['ArrowUp', .77], ['Home', 0], ['ArrowLeft', 0], ['End', 1], ['ArrowRight', 1]]) {
      await waterline.press(key);
      await page.waitForTimeout(500);
      assert.equal(state.preferences.master_volume, volume, `${key} must persist the requested volume through preferences.save`);
      assert.equal(await waterline.getAttribute('aria-valuenow'), String(Math.round(volume * 100)));
      assert.match(await waterline.getAttribute('aria-valuetext'), new RegExp(`${Math.round(volume * 100)}%`));
      assert.equal(await history().isHidden(), true);
    }
    assert.equal(actionCalls('preferences.save').some(call => call.payload.preferences.master_volume === 0), true);
    assert.equal(actionCalls('preferences.save').some(call => call.payload.preferences.master_volume === 1), true);
    await waterline.press('Enter'); await page.waitForTimeout(100); assert.equal(state.preferences.muted, true);
    await waterline.press('Space'); await page.waitForTimeout(100); assert.equal(state.preferences.muted, false);
    check('keyboard waterline changes persist through IPC, clamp at endpoints and preserve Enter/Space mute');
    await page.locator('#tts-switch').click();
    assert.equal(await page.locator('#tts-menu input[type="range"]').count(), 0);
    assert.equal(await page.locator('#speech-switch').getAttribute('aria-label'), '播报');
    await page.locator('[data-action="voice.audition"][data-id="voice-a"]').click();
    assert.equal(state.rules.default_preset_id, 'voice-a');
    await page.locator('[data-action="lake.voice.wake"]').click();
    assert.equal(actionCalls('local_services.start').length, 1);
    assert.equal(state.rules.default_preset_id, 'voice-a', 'start request must not select unready service');
    state.local_services.gpt_sovits.state = 'ready'; await push(); await page.waitForTimeout(150);
    assert.equal(state.rules.default_preset_id, 'voice-b');
    await page.screenshot({ path: path.join(output, 'voice-panel.png') });
    await page.locator('#tts-switch').click();
    check('waterline wheel changes volume, mute restores saved level, audition preserves default, wake selects only after ready');

    state.preferences.broadcast_console = true;
    state.broadcast.room.live_status = 1; state.broadcast.room.live_since = Math.floor(Date.now() / 1000) - 700;
    state.live.events.push({ ...event(10), user_id: 506, user_name: '虚构观众6', message: '又说一句' }, { ...event(11), user_id: 506, user_name: '虚构观众6', message: '再说一句' }, { ...event(12), user_id: 506, user_name: '虚构观众6', message: '第四句' });
    await push();
    await page.locator('#lake-current [data-action="viewer.open"]').first().click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.viewer-uid').textContent(), 'said 4 tonight');
    assert.equal(await page.locator('.viewer-said p').count(), 3);
    assert.equal(await page.locator('.viewer-said time').count(), 3);
    assert.equal(await page.locator('#viewer-voices .lake-voice-wave').count(), 3);
    assert.doesNotMatch(await page.locator('#viewer-moderation').innerText(), /点一个时长就生效/);
    assert.equal(await page.locator('[data-action="lake.viewer.mute"][data-id="10"]').getAttribute('title'), 'B站目前只能按小时禁言');
    await page.locator('[data-action="lake.viewer.mute"][data-id="60"]').click();
    assert.equal(actionCalls('bili.moderation.mute').at(-1).payload.hours, 1);
    await page.locator('[data-action="viewer.moderation.unmute"]').click();
    await page.locator('[data-action="lake.viewer.mute"][data-id="1440"]').click();
    assert.equal(actionCalls('bili.moderation.mute').at(-1).payload.hours, 24);
    await page.locator('[data-action="viewer.moderation.blacklist"]').click();
    assert.equal(actionCalls('bili.moderation.blacklist').length, 0);
    await page.locator('[data-action="viewer.moderation.blacklist"]').click();
    assert.equal(actionCalls('bili.moderation.blacklist').length, 1);
    await page.screenshot({ path: path.join(output, 'viewer-card.png') });
    await page.locator('[data-action="viewer.close"]').click({ position: { x: 20, y: 50 } });
    check('viewer card counts all observed lines, shows latest three with times, immediate mute durations and double-click blacklist');

    state.queue.current = null; state.playback = null; state.broadcast.room.live_status = 0; state.broadcast.room.live_since = null;
    state.broadcast.last_session = null; await push();
    if (await page.locator('[data-action="lake.prepare"]').isVisible()) await page.locator('[data-action="lake.prepare"]').click();
    await page.locator('#lake-current [data-action="onair.info"]').click();
    const titleField = page.locator('#onair-panel input[name="title"]');
    await titleField.fill('按设计原地修改标题');
    await page.locator('#onair-panel .onair-save').click();
    assert.equal(state.broadcast.room.title, '按设计原地修改标题');
    assert.equal(await page.locator('#lake-text-reflection').textContent(), state.broadcast.room.title);
    check('offair title edits in place, saves to existing command, reflection refreshes');

    const knownRoom = state.broadcast.room;
    state.broadcast.room = null;
    failBroadcastRead = true;
    await push();
    await page.evaluate(() => window.__lakeRefresh());
    const failure = page.locator('#onair .onair-failure');
    assert.equal(await failure.isVisible(), true);
    assert.equal(await failure.textContent(), '没读到开播状态');
    assert.equal(await failure.getAttribute('title'), '虚构读取错误：连接超时 [DV-B01]');
    assert.match(await page.locator('#onair').innerText(), /OFF AIR/);
    assert.equal(await page.locator('#onair [data-action="broadcast.refresh"]').count(), 1);
    check('broadcast read failure exposes a short visible reason and complete diagnostic tooltip');
    state.broadcast.room = knownRoom; failBroadcastRead = false; await push();

    faceNextStart = true;
    await page.locator('#onair [data-action="broadcast.start"]').click();
    assert.match(await page.locator('#onair-panel').textContent(), /完成验证后会自动开播/);
    assert.equal(await page.locator('#onair-panel [data-action="broadcast.start"]').count(), 0);
    await page.waitForFunction(() => document.querySelector('#onair').textContent.includes('ON AIR'), { timeout: 8000 });
    assert.equal(actionCalls('bili.broadcast.start').length, 2);
    assert.equal(await page.locator('#onair-panel').isHidden(), true);
    check('explicit start enters face check and bounded verified retry continues automatically');

    state.live.events = []; await push();
    assert.equal(await page.locator('#lake-current .lake-state-title').textContent(), 'waiting for the first word…');
    await page.locator('#onair [data-action="broadcast.stop"]').click();
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'ended');
    assert.match(await page.locator('#lake-session').textContent(), /151 句弹幕沉进了湖里/);
    await page.locator('[data-action="lake.prepare"]').click();
    assert.equal(await page.locator('#live-shell').getAttribute('data-scene'), 'offair');
    check('empty live state, truthful persisted end-session total, and return to preparation');

    state.preferences.appearance = 'light'; await push();
    await page.screenshot({ path: path.join(output, 'surface-day.png') });
    for (const size of [{ width: 800, height: 600 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(size); await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    check('day palette and small/large desktop sizes retain no horizontal overflow');
    assert.deepEqual(errors, [], 'production page JavaScript errors');
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, evidence: 'offline Edge, actual production assets with isolated test-only IPC; no real broadcast/audio/moderation acceptance', checks, actions: calls, tested_assets_sha256: testedAssets }, null, 2));
    console.log(`${checks.length} Lake redesign checks passed`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, error: error.stack, calls }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
