// Headless UI regression for the experimental broadcast console (开播), with explicit fictional
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
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: false },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, events: [event(1, '虚构观众甲', '虚构测试弹幕一'), event(2, '虚构观众乙', '虚构测试弹幕二')] },
  queue: { current: null, pending: [], history: [] }, rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: null, areas: [], has_stream_key: false, busy: false, face_image: null },
  obs: { settings: { enabled: false, host: '127.0.0.1', port: 4455, auto_launch: true, executable: null }, has_password: false, status: { state: 'idle' }, detected: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', local: true },
  overlay: { settings: { enabled: true, style: 'spine', corner: 'top_left', scale: 1, vignette: .6, title: '今晚的弹幕', tagline: '', show_danmaku: true, show_gift: true, show_super_chat: true, show_guard: true, names: 'special', merge_duplicates: true, linger_seconds: 14, port: 47823, token: '0123456789abcdef0123456789abcdef' }, running: true, port: 47823, url: 'http://127.0.0.1:47823/overlay?token=0123456789abcdef0123456789abcdef', error: null, clients: [] },
};
const secret = 'fictional-private-stream-key';
const calls = [];
const checks = [];
let failUpdate = false;
let requireFace = false;
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
        state.broadcast.has_stream_key = !requireFace;
        state.broadcast.face_image = requireFace ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=' : null;
        if (!requireFace) Object.assign(state.broadcast.room, { live_status: 1, live_since: Math.floor(Date.now() / 1000) - 3725 });
        if (!requireFace && state.obs.settings.enabled) result = { obs: obsFailStart ? { error: '无法连接 OBS（连接被拒绝）：请确认 OBS 已打开，并在「工具 → WebSocket 服务器设置」中开启服务器，端口与弹幕姬一致 [DV-OB01]' } : { outcome: 'started' } };
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
        assert.equal(payload.settings.title, state.overlay.settings.title, 'other overlay settings must preserve its saved title');
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
    const openBitrate = async () => {
      await page.locator('[data-action="settings.open"]').click();
      await page.locator('[data-action="settings.tab"][data-id="live"]').click();
      await page.locator('[data-action="settings.bitrate"]').click();
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
    await page.waitForTimeout(400);

    assert.equal(await page.locator('#onair').isHidden(), true);
    assert.equal(actions().includes('bili.broadcast.refresh'), false);
    check('console hidden and nothing read while disabled');

    await page.locator('[data-action="settings.open"]').click();
    await page.locator('[data-action="settings.tab"][data-id="live"]').click();
    await page.locator('.s-onair-preview').waitFor();
    assert.match(await page.locator('[data-action="settings.tab"][data-id="live"]').textContent(), /实验/);
    assert.equal(await page.locator('[data-action="settings.tab"][data-id="room"]').evaluate(() => !!document.querySelector('[data-broadcast-section]')), false);
    assert.equal(actions().includes('bili.broadcast.refresh'), false);
    await shot('settings-disabled-zh');
    check('experimental page previews the console before it is enabled');

    await page.locator('[data-broadcast-enable]').check();
    await page.locator('.s-onair-hero').waitFor();
    assert.equal(state.preferences.broadcast_console, true);
    assert.equal(actions().filter(action => action === 'bili.broadcast.refresh').length, 1);
    assert.match(await page.locator('.s-onair-hero').textContent(), /123/);
    check('enabling saves the preference and reads the own room once');

    const title = page.locator('.s-onair-info input[name="title"]');
    await title.fill('中文 & 新标题 <script>');
    assert.equal(await page.locator('.s-onair-info [data-title-count]').textContent(), '17/40');
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.__offlineListeners['resource-mode']?.({ payload: false }); });
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.__offlineListeners['resource-mode']?.({ payload: true }); });
    assert.equal(await title.inputValue(), '中文 & 新标题 <script>');
    failUpdate = true;
    await page.locator('.s-onair-info button[type="submit"]').click();
    await page.locator('#settings-error').filter({ hasText: 'DV-B04' }).waitFor();
    assert.equal(await title.inputValue(), '中文 & 新标题 <script>');
    failUpdate = false;
    await page.locator('.s-onair-info button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('.s-onair-info[data-dirty]'));
    assert.equal(state.broadcast.room.title, '中文 & 新标题 <script>');
    check('title drafts survive focus changes and failures, then save');

    await page.locator('[data-action="settings.close"]').click();
    await page.locator('.settings-dialog.leaving').waitFor({ state: 'detached' });
    await page.locator('#onair[data-state="off"]').waitFor();
    assert.equal(await page.locator('#masthead-name').textContent(), '虚构主播');
    assert.equal(await page.locator('#masthead-suffix').textContent(), '的直播间');
    await shot('main-off-air-zh');
    check('main screen shows the off-air console with the saved title');

    await page.locator('#lake-title').click();
    await page.locator('#onair-panel form[data-form="broadcast-room"]').waitFor();
    await page.locator('#onair-panel select[name="parent_area_id"]').locator('..').locator('.select-trigger').click();
    await page.getByRole('option', { name: '手游', exact: true }).click();
    assert.equal(await page.locator('#onair-panel').isVisible(), true, 'choosing from the menu keeps the panel open');
    assert.equal(await page.locator('#onair-panel select[name="area_id"]').inputValue(), '91');
    await shot('main-info-zh');
    await page.locator('#onair-panel button[type="submit"]').click();
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    assert.equal(state.broadcast.room.area_id, 91);
    check('title and category edit from the main screen');

    assert.equal(await page.locator('#onair [data-action="onair.push"]').count(), 0);
    assert.equal(await page.locator('#onair [data-action="onair.details"]').count(), 0);
    const readsBeforeBitrate = actions().filter(action => action === 'obs.bitrate.get').length;
    await openBitrate();
    const bitrateInput = page.locator('#onair-bitrate');
    await bitrateInput.waitFor();
    await page.waitForFunction(() => document.querySelector('#onair-bitrate')?.value === '6000');
    assert.equal(actions().filter(action => action === 'obs.bitrate.get').length, readsBeforeBitrate + 1, 'OBS bitrate is read only after the explicit Settings action');
    await bitrateInput.fill('8000');
    assert.equal(await page.locator('#onair-overlay-title').count(), 0);
    await page.waitForTimeout(1300);
    assert.equal(await bitrateInput.inputValue(), '8000');
    const previousOverlay = structuredClone(state.overlay.settings);
    await page.locator('form[data-form="onair-bitrate"] button[type="submit"]').click();
    await until(() => bitrate === 8000);
    assert.deepEqual(state.overlay.settings, previousOverlay);
    assert.equal(actions().includes('overlay.title.save'), false);
    assert.equal(await page.locator('#settings-obs-bitrate [data-push-key]').count(), 0);
    await shot('settings-bitrate-zh');
    await page.keyboard.press('Escape');
    await page.locator('#settings').waitFor({ state: 'hidden' });
    check('Settings explicitly reads and saves bitrate while preserving drafts and every saved overlay setting, with overlay heading editing removed');

    bitrateMode = 'advanced';
    await openBitrate();
    await page.locator('#settings-obs-bitrate .onair-note').filter({ hasText: '高级输出模式' }).waitFor();
    assert.equal(await bitrateInput.isDisabled(), true);
    assert.equal(await page.locator('form[data-form="onair-bitrate"] button[type="submit"]').isDisabled(), true);
    await page.keyboard.press('Escape');
    bitrateMode = 'simple'; state.overlay.settings.enabled = false; state.config_revision++;
    await page.waitForTimeout(1300);
    await openBitrate();
    await page.locator('#onair-bitrate').waitFor();
    assert.equal(await page.locator('#onair-overlay-title').count(), 0);
    await page.keyboard.press('Escape');
    state.overlay.settings.enabled = true; state.config_revision++;
    check('advanced mode explains its limit and overlay heading is omitted while the overlay is off');

    bitrateActive = true;
    await openBitrate();
    await page.waitForFunction(() => document.querySelector('#onair-bitrate')?.disabled === false);
    await bitrateInput.fill('9000');
    await page.locator('form[data-form="onair-bitrate"] button[type="submit"]').click();
    await until(() => bitrate === 9000);
    assert.match(await page.locator('#settings-obs-bitrate').textContent(), /下次开播生效/);
    await page.keyboard.press('Escape');
    check('active OBS output can save next-stream bitrate without stopping');

    await page.locator('#onair [data-action="broadcast.start"]').click();
    await page.locator('#onair[data-state="live"]').waitFor();
    assert.equal(await page.locator('#onair-panel').isVisible(), false);
    assert.equal(await page.locator('#onair [data-action="onair.push"]').count(), 0);
    assert.match(await page.locator('#onair .onair-clock').textContent(), /^01:02:0\d$/);
    assert.equal(state.live.running, true);
    assert.equal(state.setup.room_id, 999);
    assert.equal(actions().includes('bili.broadcast.credentials'), false);
    check('going live never opens stream-key details in the top right and preserves chat reception');

    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal(actions().filter(action => action === 'bili.broadcast.stop').length, 1);
    assert.equal(await page.locator('#toast').textContent(), '已下播');
    assert.equal(state.live.running, true);
    check('ending the stream is one click without a confirmation and keeps chat reception');

    requireFace = true;
    await startFromPreparation();
    await page.locator('#onair-panel .onair-face-qr img').waitFor();
    assert.equal(await page.locator('#onair').getAttribute('data-state'), 'off');
    await shot('main-face-zh');
    requireFace = false;
    await page.locator('#onair-panel [data-action="broadcast.start"]').click();
    await page.locator('#onair[data-state="live"]').waitFor();
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    check('face verification shows its QR and continues on request');


    await page.locator('[data-action="settings.open"]').click();
    await page.locator('[data-action="settings.tab"][data-id="live"]').click();
    await page.locator('.s-onair-hero[data-state="live"]').waitFor();
    await page.locator('[data-action="external.open"][data-id="bili_broadcast_room"]').click();
    await shot('settings-live-zh');
    check('settings show the live room and open it in the browser');

    // Maximized settings: the column widens and centers; the default window keeps the 700 px column.
    const column = () => page.evaluate(() => {
      const nav = document.querySelector('.settings-nav').getBoundingClientRect();
      const body = document.querySelector('.s-live').getBoundingClientRect();
      return { width: Math.round(body.width), left: Math.round(body.left - nav.right), right: Math.round(innerWidth - body.right) };
    });
    const normal = await column();
    assert.equal(normal.width, 700);
    assert.equal(normal.left, 20);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(200);
    const wide = await column();
    assert.equal(wide.width, 960);
    assert.ok(Math.abs(wide.left - wide.right) <= 16, JSON.stringify(wide));
    await shot('settings-live-1600');
    await page.setViewportSize({ width: 1040, height: 740 });
    await page.waitForTimeout(200);
    assert.deepEqual(await column(), normal);
    check('settings column widens and centers when maximized, unchanged at the default size');

    const obsForm = page.locator('form[data-form="obs"]');
    await page.locator('[data-obs-more]').evaluate(details => { details.open = true; });
    await obsForm.waitFor();
    assert.equal(await page.locator('[data-obs-status-text]').textContent(), '已连接 OBS 31.0.0');
    assert.equal(actions().includes('obs.refresh'), true, 'visible OBS settings automatically read the connection');
    assert.equal(await page.locator('details[data-obs-more]').getAttribute('open'), '', 'connection fields can be opened after automatic connection');
    assert.match(await obsForm.locator('[data-path-value]').textContent(), /自动：C:\\Program Files\\obs-studio/);
    const linkForm = page.locator('form[data-form="obs-link"]');
    await linkForm.locator('input[name="enabled"]').check();
    await until(() => state.obs.settings.enabled === true);
    assert.equal(state.obs.settings.auto_launch, true);
    await linkForm.locator('input[name="auto_launch"]').uncheck();
    await until(() => state.obs.settings.auto_launch === false);
    await linkForm.locator('input[name="auto_launch"]').check();
    await until(() => state.obs.settings.auto_launch === true);
    assert.equal(state.obs.settings.port, 4455, 'each OBS form saves only its own fields');
    await obsForm.locator('input[name="port"]').fill('0');
    await page.locator('form[data-form="obs"] .autosave-status[data-state="error"], form[data-form="obs"] .autosave-status[data-state="draft"]').first().waitFor();
    assert.equal(state.obs.settings.port, 4455);
    await obsForm.locator('input[name="port"]').fill('4460');
    await until(() => state.obs.settings.port === 4460);
    await page.waitForFunction(() => document.querySelector('form[data-form="obs"] .autosave-status')?.hidden);
    const passwordInput = page.locator('form[data-form="obs-password"] input[name="password"]');
    await passwordInput.fill(obsPassword);
    await page.locator('form[data-form="obs-password"] button[type="submit"]').click();
    await page.locator('[data-action="obs.password.clear"]').waitFor();
    assert.equal(await page.locator('form[data-form="obs-password"] input[name="password"]').inputValue(), '');
    assert.equal(await page.evaluate(value => document.documentElement.outerHTML.includes(value), obsPassword), false);
    await page.locator('[data-action="obs.test"]').click();
    await page.locator('[data-obs-status-text]').filter({ hasText: '已连接 OBS 31.0.0' }).waitFor();
    assert.equal(await page.locator('[data-obs-status] .service-light').getAttribute('class'), 'service-light ready');
    assert.equal(await page.locator('[data-action="obs.launch"]').isHidden(), true, 'no start button while OBS is connected');
    state.obs.status = { state: 'error', message: '无法连接 OBS（连接被拒绝）：请确认 OBS 已打开，并在「工具 → WebSocket 服务器设置」中开启服务器，端口与弹幕姬一致 [DV-OB01]' }; state.config_revision++;
    await page.locator('[data-obs-status-text]').filter({ hasText: '没能连上 OBS' }).waitFor();
    await page.locator('[data-obs-status-detail]').filter({ hasText: 'DV-OB01' }).waitFor();
    await page.locator('[data-action="obs.launch"]').click();
    await page.locator('#toast').filter({ hasText: 'OBS 已启动并连上' }).waitFor();
    await page.locator('[data-obs-status-text]').filter({ hasText: '已连接 OBS 31.0.0' }).waitFor();
    assert.equal(await page.locator('[data-live-state="broadcast"]').textContent(), '直播中');
    await shot('settings-obs-zh');
    check('OBS connection card: separate forms save their own fields, password once, test and start OBS');

    await page.locator('[data-action="live.panel"][data-id="overlay"]').click();
    await page.locator('[data-live-panel="overlay"]').waitFor();
    assert.equal(await page.locator('[data-live-panel="broadcast"]').isHidden(), true);
    assert.equal(await page.locator('[data-action="live.panel"][data-id="overlay"]').getAttribute('aria-selected'), 'true');
    const overlayForm = page.locator('form[data-form="overlay"]');
    assert.equal(await overlayForm.locator('input[name="title"], textarea[name="title"]').count(), 0, 'OBS title editor must be absent from settings');
    const savedOverlayTitle = state.overlay.settings.title;
    await overlayForm.locator('input[name="show_gift"]').uncheck();
    await until(() => state.overlay.settings.show_gift === false);
    assert.equal(state.overlay.settings.title, savedOverlayTitle);
    await overlayForm.locator('input[name="show_gift"]').check();
    await until(() => state.overlay.settings.show_gift === true);
    assert.equal(state.overlay.settings.title, savedOverlayTitle);
    await page.locator('[data-action="overlay.obs_add"]').click();
    await page.locator('#toast').filter({ hasText: '已添加到 OBS · “游戏场景” · 2560 × 1440' }).waitFor();
    await page.locator('[data-live-state="overlay"]').filter({ hasText: 'OBS 正在显示' }).waitFor();
    await shot('settings-overlay-panel-zh');
    await page.locator('[data-action="live.panel"][data-id="broadcast"]').click();
    await page.locator('[data-live-panel="broadcast"] .s-onair-hero').waitFor();
    check('one OBS page switches between console and overlay; the overlay goes into OBS in one click');

    await page.locator('[data-action="settings.close"]').click();
    await page.locator('.settings-dialog.leaving').waitFor({ state: 'detached' });
    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    await page.locator('#toast').filter({ hasText: '已下播，OBS 已停止推流' }).waitFor();
    await startFromPreparation();
    await page.locator('#onair[data-state="live"]').waitFor();
    await page.locator('#toast').filter({ hasText: '已开播，OBS 已开始推流' }).waitFor();
    assert.equal(await page.locator('#onair-panel').isVisible(), false, 'OBS already has the key; no manual copy panel');
    await page.locator('#onair [data-action="broadcast.stop"]').click();
    await page.locator('#onair[data-state="off"]').waitFor();
    obsFailStart = true;
    await startFromPreparation();
    await page.locator('#onair[data-state="live"]').waitFor();
    assert.equal(await page.locator('#onair-panel').isVisible(), false);
    await page.locator('#toast.error').filter({ hasText: 'DV-OB01' }).waitFor();
    obsFailStart = false;
    await shot('main-obs-failed-zh');
    await page.keyboard.press('Escape');
    await page.locator('#onair-panel').waitFor({ state: 'hidden' });
    check('OBS linkage starts and stops OBS; errors point to settings without exposing a stream key');

    await page.locator('[data-action="settings.open"]').click();
    await page.locator('[data-action="settings.tab"][data-id="live"]').click();
    await page.locator('.s-onair-hero[data-state="live"]').waitFor();
    await page.locator('form[data-form="obs"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('details[data-obs-more]').getAttribute('open'), null, 'a working connection reopens folded');

    state.preferences.language = 'en'; state.config_revision++;
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.setViewportSize({ width: 560, height: 740 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#settings-content').evaluate(node => node.scrollWidth > node.clientWidth + 2), false);
    const appCopy = await page.locator('.s-live').evaluate(node => [...node.querySelectorAll('button:not([role="combobox"]), label>span, .onair-field>label, .s-label, .s-note, .s-ovl-lede, h2, .onair-steps')].map(item => item.textContent).join(' '));
    assert.doesNotMatch(appCopy, /\p{Script=Han}/u);
    await shot('settings-en-560');
    await page.locator('[data-action="settings.close"]').click();
    await page.locator('.settings-dialog.leaving').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 780, height: 580 });
    await page.waitForTimeout(300);
    const overlap = await page.evaluate(() => {
      const a = document.querySelector('.masthead-title').getBoundingClientRect();
      const name = document.querySelector('.masthead-name').getBoundingClientRect();
      const b = document.querySelector('#onair').getBoundingClientRect();
      return { overlap: Math.min(a.right, name.right) > b.left + 1 && a.top < b.bottom && b.top < a.bottom, scroll: document.documentElement.scrollWidth > innerWidth };
    });
    assert.deepEqual(overlap, { overlap: false, scroll: false });
    assert.doesNotMatch(await page.locator('#onair').evaluate(node => [...node.querySelectorAll('.onair-go span, .onair-kicker')].map(item => item.textContent).join(' ')), /\p{Script=Han}/u);
    await shot('main-en-780');
    check('English copy, 560 px settings and 780 px main layout');

    state.preferences.language = 'zh-CN'; state.preferences.broadcast_console = false; state.config_revision++;
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.locator('#onair').waitFor({ state: 'hidden' });
    check('disabling removes the console');

    assert.equal(calls.some(call => ['live.disconnect', 'live.connect', 'queue.stop', 'bili.qr.begin'].includes(call.action)), false);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, headless: true, browser: channel || 'chromium', externalNetwork: false, nativeWebView2: false, actualBroadcast: false, checks, actions: actions() }, null, 2));
    console.log(`Broadcast headless UI: PASS (${checks.length} scenarios; fictional fixtures, no credentials or real broadcast).`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
