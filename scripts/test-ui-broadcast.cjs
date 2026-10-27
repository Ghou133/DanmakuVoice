// Headless UI regression for the lake broadcast controls (开播), with explicit fictional
// IPC fixtures: no account, network, credentials or real broadcast. External requests are aborted.
// Browser: Edge by default (as on Windows CI); set DV_BROWSER_CHANNEL=chromium to use Playwright's Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../dist/broadcast-tests'));
const channel = process.env.DV_BROWSER_CHANNEL ?? 'msedge';
const areas = [
  { id: 2, name: '网游', children: [{ id: 86, name: '英雄联盟' }, { id: 87, name: '其他网游' }] },
  { id: 3, name: '手游', children: [{ id: 91, name: '测试手游' }] },
];
const event = (id, name, message) => ({ room_id: 999, platform_event_id: `fixture-${id}`, observed_at_ms: Date.now() - (9 - id) * 8000, kind: 'danmaku', user_id: 500 + id, user_name: name, message, gift_name: '', quantity: 1, price_yuan: 0, guard_name: '' });
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: true },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, events: [event(1, '虚构观众甲', '虚构测试弹幕一'), event(2, '虚构观众乙', '虚构测试弹幕二')] },
  queue: { current: null, pending: [], history: [] }, rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: null, areas: [], has_stream_key: false, busy: false, face_image: null, face_kind: null },
  obs: { settings: { enabled: false, host: '127.0.0.1', port: 4455, auto_launch: true, executable: null }, has_password: false, status: { state: 'idle' }, detected: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', local: true },
  overlay: { settings: { enabled: true, style: 'spine', corner: 'top_left', scale: 1, vignette: .6, title: '今晚的弹幕', tagline: '', show_danmaku: true, show_gift: true, show_super_chat: true, show_guard: true, names: 'special', merge_duplicates: true, linger_seconds: 14, port: 47823, token: '0123456789abcdef0123456789abcdef' }, running: true, port: 47823, url: 'http://127.0.0.1:47823/overlay?token=0123456789abcdef0123456789abcdef', error: null, clients: [] },
};
const secret = 'fictional-private-stream-key';
const calls = [];
const checks = [];
let failUpdate = false;
let requireFace = false;
let faceVerified = false;
let faceKind = 60024;
let failNextStart = false;
let obsFailStart = false;
let bitrate = 6000;
let bitrateMode = "simple";
let bitrateActive = false;
const obsPassword = 'fictional-obs-password';
const check = name => { checks.push(name); console.log(`  ok  ${name}`); };
// Wait for the fixture (Node-side) state, e.g. an autosave reaching the fake IPC.
const until = async (predicate, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for fixture state'); await new Promise(resolve => setTimeout(resolve, 50)); }
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)];
      const bytes = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__offlineInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch');
      calls.push(structuredClone(args));
      const { action, payload } = args;
      let result;
      if (action === 'bili.broadcast.refresh') {
        assert.equal(state.preferences.broadcast_console, true, 'refresh only after the console is enabled');
        state.broadcast.room ||= { room_id: 123, title: '虚构直播间', parent_area_id: 2, area_id: 86, live_status: 0, live_since: null };
        state.broadcast.areas = structuredClone(areas);
      } else if (action === 'bili.broadcast.update') {
        assert.equal(payload.confirmed, true);
        if (failUpdate) throw new Error('B站接口返回错误码 -400 [DV-B04]');
        Object.assign(state.broadcast.room, { title: payload.title, area_id: payload.area_id, parent_area_id: areas.find(item => item.children.some(child => child.id === payload.area_id)).id });
      } else if (action === 'bili.broadcast.start') {
        assert.equal(payload.confirmed, true);
        assert.equal(payload.area_id, state.broadcast.room.area_id);
        if (failNextStart) {
          failNextStart = false;
          state.broadcast.has_stream_key = false; state.broadcast.face_image = null; state.broadcast.face_kind = null;
          throw new Error('虚构开播连接失败 [DV-B01]');
        }
        state.broadcast.has_stream_key = !requireFace;
        state.broadcast.face_image = requireFace ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=' : null;
        state.broadcast.face_kind = requireFace ? faceKind : null;
        if (!requireFace) Object.assign(state.broadcast.room, { live_status: 1, live_since: Math.floor(Date.now() / 1000) - 3725 });
        if (!requireFace && state.obs.settings.enabled) result = { obs: obsFailStart ? { error: '无法连接 OBS（连接被拒绝）：请确认 OBS 已打开，并在「工具 → WebSocket 服务器设置」中开启服务器，端口与弹幕姬一致 [DV-OB01]' } : { outcome: 'started' } };
      } else if (action === 'bili.broadcast.face.check') {
        assert.equal(state.broadcast.face_kind, 60024);
        result = { verified: faceVerified };
      } else if (action === 'bili.broadcast.credentials') {
        assert.equal(payload.confirmed, true);
        assert.equal(state.broadcast.has_stream_key, true);
        return { ...structuredClone(state), result: { address: 'rtmp://live-push.bilivideo.com/live/', stream_key: secret } };
      } else if (action === 'bili.broadcast.stop') {
        assert.equal(payload.confirmed, true);
        Object.assign(state.broadcast.room, { live_status: 0, live_since: null });
        state.broadcast.has_stream_key = false; state.broadcast.face_image = null;
        if (state.obs.settings.enabled) result = { obs: { outcome: 'stopped' } };
      } else if (action === 'obs.bitrate.get' || action === 'obs.bitrate.set') {
        if (action === 'obs.bitrate.set') { assert.equal(bitrateMode, 'simple'); bitrate = payload.bitrate_kbps; }
        result = { bitrate_kbps: bitrateMode === 'simple' ? bitrate : null, output_mode: bitrateMode, editable: bitrateMode === 'simple', outputs_active: bitrateActive, reason: bitrateMode === 'advanced' ? 'OBS 当前使用高级输出模式，请在 OBS 的「设置 → 输出 → 推流」中配置码率' : null };
      } else if (action === 'overlay.title.save') {
        assert.equal(state.overlay.settings.enabled, true);
        state.overlay.settings.title = payload.title; state.config_revision++;
      } else if (action === 'overlay.save') {
        Object.assign(state.overlay.settings, payload.settings); state.config_revision++;
      } else if (action === 'obs.save') {
        Object.assign(state.obs.settings, payload.settings);
      } else if (action === 'obs.password') {
        assert.ok([obsPassword, ''].includes(payload.password));
        state.obs.has_password = !!payload.password; state.obs.status = { state: 'idle' };
      } else if (action === 'obs.test' || action === 'obs.launch' || action === 'obs.refresh') {
        state.obs.status = { state: 'ok', streaming: false, obs_version: '31.0.0', websocket_version: '5.5.2' };
        result = { obs_version: '31.0.0', websocket_version: '5.5.2', streaming: false, ...(action === 'obs.launch' ? { launched: true } : {}) };
      } else if (action === 'obs.overlay.sync') {
        state.obs.status.overlay_sync = { state: 'ready' };
        result = { found: true, created: false, added_to_scene: false, scene: '游戏场景', width: 2560, height: 1440 };
      } else if (action === 'obs.overlay.add') {
        assert.equal(state.overlay.running, true);
        state.overlay.clients = [{ width: 2560, height: 1440 }];
        result = { created: true, added_to_scene: true, found: true, scene: '游戏场景', width: 2560, height: 1440 };
      } else if (action === 'bili.broadcast.forget') {
        state.broadcast.has_stream_key = false; state.broadcast.face_image = null;
      } else if (action === 'preferences.save') {
        Object.assign(state.preferences, payload.preferences); state.config_revision++;
      } else if (action === 'external.open') {
        assert.equal(payload.page, 'bili_broadcast_room');
      } else if (!['bili.qr.cancel', 'doubao.qr.cancel'].includes(action)) throw new Error('Unexpected fixture action ' + action);
      return result === undefined ? structuredClone(state) : { ...structuredClone(state), result };
    });
    await page.addInitScript(() => {
      window.__offlineListeners = {};
      window.__TAURI__ = { core: { invoke: (command, args) => window.__offlineInvoke(command, args) }, event: { listen: async (name, listener) => { window.__offlineListeners[name] = listener; return () => {}; } } };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copiedText = text; } } });
    });
    const shot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
    const actions = () => calls.map(call => call.action);
    const openObs = async () => {
      await page.locator('[data-action="settings.open"]').click();
      if (!await page.locator('[data-action="settings.tab"][data-id="overlay"]').count()) await page.locator('[data-action="settings.tab"][data-id="home"]').click();
      await page.locator('[data-action="settings.tab"][data-id="overlay"]').click();
      if (await page.locator('[data-obs-view="advanced"]').count()) await page.locator('.lake-settings-heading [data-action="lake.obs.back"]').click();
      await page.locator('[data-obs-view="preview"]').waitFor();
    };
    const closeSettings = async () => {
      await page.locator('[data-action="settings.close"]').click();
      await page.locator('#settings').waitFor({ state: 'hidden' });
    };
    const startFromPreparation = async () => {
      const prepare = page.locator('#onair [data-action="lake.prepare"]');
      if (await prepare.count()) {
        const starts = actions().filter(action => action === 'bili.broadcast.start').length;
        await prepare.click();
        assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, starts);
      }
      await page.locator('#onair [data-action="broadcast.start"]').click();
    };
    await page.goto(origin);
    await page.locator('#lake-transcript').waitFor();
    await page.locator('#onair[data-state="off"]').waitFor();
    assert.equal(actions().filter(action => action === 'bili.broadcast.refresh').length, 1);
    assert.match(await page.locator('#onair').textContent(), /OFF AIR/);
    assert.equal(await page.locator('#masthead-name').textContent(), '虚构主播');
    await page.locator('.lake-state-title').filter({ hasText: '虚构直播间' }).waitFor();
    await shot('main-off-air-zh');
    check('the signed-in main view reads its own room and shows OFF AIR');

    await page.locator('#lake-title').click();
    const title = page.locator('#onair-panel input[name="title"]');
    await title.fill('中文 & 新标题 <script>');
    assert.match(await page.locator('#onair-panel [data-title-count]').textContent(), /17\s*\/\s*40/);
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.__offlineListeners['resource-mode']?.({ payload: false }); });
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.__offlineListeners['resource-mode']?.({ payload: true }); });
    assert.equal(await title.inputValue(), '中文 & 新标题 <script>');
    failUpdate = true;
    await page.locator('#onair-panel button[type="submit"]').click();
    await page.locator('#toast.error').filter({ hasText: 'DV-B04' }).waitFor();
    assert.equal(await title.inputValue(), '中文 & 新标题 <script>');
    failUpdate = false;
    await page.locator('#onair-panel button[type="submit"]').click();
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    assert.equal(state.broadcast.room.title, '中文 & 新标题 <script>');
    assert.equal(await page.locator('#lake-title script').count(), 0);
    check('title drafts survive focus changes and failures, then save as text');

    await page.locator('#lake-title').click();
    await page.locator('#onair-panel select[name="parent_area_id"]').locator('..').locator('.select-trigger').click();
    await page.getByRole('option', { name: '手游', exact: true }).click();
    assert.equal(await page.locator('#onair-panel').isVisible(), true);
    assert.equal(await page.locator('#onair-panel select[name="area_id"]').inputValue(), '91');
    await shot('main-info-zh');
    await page.locator('#onair-panel button[type="submit"]').click();
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    assert.equal(state.broadcast.room.area_id, 91);
    check('title and category edit inline in the sky');

    await startFromPreparation();
    await page.locator('#onair[data-state="live"]').waitFor();
    assert.equal(await page.locator('#onair-panel').isVisible(), false);
    assert.equal(await page.locator('[data-push-key], [data-action="onair.push"], [data-action="onair.details"]').count(), 0);
    assert.match(await page.locator('#onair .onair-clock').textContent(), /^01:02:0\d$/);
    assert.equal(state.live.running, true);
    assert.equal(state.setup.room_id, 999);
    assert.equal(actions().includes('bili.broadcast.credentials'), false);
    await shot('main-live-zh');
    check('going live preserves reception and never retrieves or displays the stream key');

    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal(actions().filter(action => action === 'bili.broadcast.stop').length, 1);
    assert.equal(await page.locator('#toast').textContent(), '已下播');
    assert.match(await page.locator('#onair').textContent(), /WRAPPED/);
    assert.equal(state.live.running, true);
    check('one click ends the broadcast, shows WRAPPED, and keeps reception');

    requireFace = true;
    await startFromPreparation();
    await page.locator('#onair-panel .onair-face-qr img').waitFor();
    assert.match(await page.locator('#onair').textContent(), /GOING LIVE/);
    assert.equal(await page.locator('#onair-panel [data-action="broadcast.start"]').count(), 0);
    assert.equal(await page.locator('#onair .onair-go').isDisabled(), true);
    await shot('main-face-zh');
    const startsBeforeCancel = actions().filter(action => action === 'bili.broadcast.start').length;
    await page.keyboard.press('Escape');
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    await page.waitForTimeout(5500);
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeCancel);
    assert.doesNotMatch(await page.locator('#onair').textContent(), /GOING LIVE/);
    check('closing face verification cancels its pending automatic continuation');

    faceVerified = false;
    await startFromPreparation();
    await page.locator('#onair-panel .onair-face-qr img').waitFor();
    const startsBeforeLanguageChange = actions().filter(action => action === 'bili.broadcast.start').length;
    state.preferences.language = 'en'; state.config_revision++;
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    faceVerified = true;
    await page.waitForTimeout(5500);
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeLanguageChange, 'rendering a new language cancels the old automatic start');
    assert.equal(state.broadcast.room.live_status, 0);
    state.preferences.language = 'zh-CN'; state.config_revision++;
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    check('changing language while a face challenge is open cancels the pending automatic start');

    faceVerified = false;
    await startFromPreparation();
    await page.locator('#onair-panel .onair-face-qr img').waitFor();
    const startsBeforeFailedRetry = actions().filter(action => action === 'bili.broadcast.start').length;
    requireFace = false; failNextStart = true; faceVerified = true;
    await page.locator('#toast.error').filter({ hasText: 'DV-B01' }).waitFor({ timeout: 10000 });
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#onair-panel .onair-face-qr img').count(), 0, 'old QR must be removed after a failed retry');
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeFailedRetry + 1);
    await page.waitForTimeout(5500);
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeFailedRetry + 1, 'failed retry must not restart automatically');
    assert.equal(state.broadcast.room.live_status, 0);
    check('failed automatic retry clears its old QR, displays the error and does not keep retrying');

    requireFace = true; faceVerified = false;
    await startFromPreparation();
    await page.locator('#onair-panel .onair-face-qr img').waitFor();
    const startsBeforeVerification = actions().filter(action => action === 'bili.broadcast.start').length;
    const checksBeforeVerification = actions().filter(action => action === 'bili.broadcast.face.check').length;
    const qrBeforeVerification = await page.locator('#onair-panel .onair-face-qr img').getAttribute('src');
    await until(() => actions().filter(action => action === 'bili.broadcast.face.check').length > checksBeforeVerification, 8000);
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeVerification);
    assert.equal(await page.locator('#onair-panel .onair-face-qr img').getAttribute('src'), qrBeforeVerification);
    requireFace = false;
    faceVerified = true;
    await page.locator('#onair[data-state="live"]').waitFor({ timeout: 10000 });
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeVerification + 1);
    check('face verification keeps its QR, checks status without restarting and continues after completion');

    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    requireFace = true; faceVerified = true; faceKind = 60024;
    await startFromPreparation();
    await page.locator('#onair-panel .onair-face-qr img').waitFor();
    const startsBeforeRepeatedChallenge = actions().filter(action => action === 'bili.broadcast.start').length;
    await page.locator('#onair-panel [role="alert"]').filter({ hasText: '仍需确认' }).waitFor({ timeout: 10000 });
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeRepeatedChallenge + 1);
    await page.waitForTimeout(5500);
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeRepeatedChallenge + 1);
    requireFace = false;
    await page.locator('#onair-panel [data-action="broadcast.start"]').click();
    await page.locator('#onair[data-state="live"]').waitFor();
    check('a renewed challenge after verification requires an explicit retry');

    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    requireFace = true; faceKind = 60043;
    await startFromPreparation();
    await page.locator('#onair-panel .onair-face-qr img').waitFor();
    const checksBeforeManual = actions().filter(action => action === 'bili.broadcast.face.check').length;
    const startsBeforeManual = actions().filter(action => action === 'bili.broadcast.start').length;
    await page.waitForTimeout(5500);
    assert.equal(actions().filter(action => action === 'bili.broadcast.face.check').length, checksBeforeManual);
    assert.equal(actions().filter(action => action === 'bili.broadcast.start').length, startsBeforeManual);
    requireFace = false;
    await page.locator('#onair-panel [data-action="broadcast.start"]').click();
    await page.locator('#onair[data-state="live"]').waitFor();
    check('60043 waits for a user retry without using the 60024 status endpoint');

    await openObs();
    assert.equal(Math.round((await page.locator('#settings').boundingBox()).width), 908);
    assert.equal(await page.locator('[data-broadcast-enable], [data-action="settings.bitrate"], [data-push-key]').count(), 0);
    await page.locator('[data-action="lake.obs.advanced"]').click();
    await page.locator('[data-obs-view="advanced"]').waitFor();
    assert.equal(Math.round((await page.locator('#settings').boundingBox()).width), 380);
    const linkForm = page.locator('form[data-form="obs-link"]');
    await linkForm.locator('input[name="enabled"]').check();
    await until(() => state.obs.settings.enabled === true);
    await linkForm.locator('input[name="auto_launch"]').uncheck();
    await until(() => state.obs.settings.auto_launch === false);
    await linkForm.locator('input[name="auto_launch"]').check();
    await until(() => state.obs.settings.auto_launch === true);
    assert.equal(state.obs.settings.port, 4455);
    await shot('settings-obs-link-zh');
    await closeSettings();
    check('OBS advanced settings save linkage independently of the connection fields');

    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    await page.locator('#toast').filter({ hasText: '已下播，OBS 已停止推流' }).waitFor();
    await startFromPreparation();
    await page.locator('#onair[data-state="live"]').waitFor();
    await page.locator('#toast').filter({ hasText: '已开播，OBS 已开始推流' }).waitFor();
    assert.equal(await page.locator('#onair-panel').isVisible(), false);
    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    obsFailStart = true;
    await startFromPreparation();
    await page.locator('#onair[data-state="live"]').waitFor();
    await page.locator('#toast.error').filter({ hasText: 'DV-OB01' }).waitFor();
    assert.match(await page.locator('#toast.error').innerText(), /设置 → OBS/);
    assert.doesNotMatch(await page.locator('#toast.error').innerText(), /OBS 与开播/);
    assert.equal(await page.locator('#onair-panel').isVisible(), false);
    obsFailStart = false;
    await shot('main-obs-failed-zh');
    check('OBS linkage starts and stops streaming; an OBS failure keeps the room open and reports the cause');

    state.preferences.language = 'en'; state.config_revision++;
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.setViewportSize({ width: 780, height: 580 });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.doesNotMatch(await page.locator('#onair').evaluate(node => [...node.querySelectorAll('.onair-go span, .onair-kicker')].map(item => item.textContent).join(' ')), /\p{Script=Han}/u);
    await shot('main-en-780');
    await openObs();
    await page.locator('[data-action="lake.obs.advanced"]').click();
    await page.setViewportSize({ width: 560, height: 740 });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#settings-content').evaluate(node => node.scrollWidth > node.clientWidth + 2), false);
    const appCopy = await page.locator('[data-obs-root]').evaluate(node => [...node.querySelectorAll('button, label>span, h3')].map(item => item.textContent).join(' '));
    assert.doesNotMatch(appCopy, /\p{Script=Han}/u);
    await shot('settings-en-560');
    await closeSettings();
    check('English copy and compact main/settings layouts remain usable');

    state.preferences.language = 'zh-CN'; state.preferences.broadcast_console = false; state.config_revision++;
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.locator('#onair').waitFor({ state: 'hidden' });
    check('a disabled legacy configuration still suppresses broadcast controls');
    assert.equal(actions().some(action => ['obs.bitrate.get', 'obs.bitrate.set', 'bili.broadcast.credentials'].includes(action)), false);

    assert.equal(calls.some(call => ['live.disconnect', 'live.connect', 'queue.stop', 'bili.qr.begin'].includes(call.action)), false);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, headless: true, browser: channel || 'chromium', externalNetwork: false, nativeWebView2: false, actualBroadcast: false, checks, actions: actions() }, null, 2));
    console.log(`Broadcast headless UI: PASS (${checks.length} scenarios; fictional fixtures, no credentials or real broadcast).`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
