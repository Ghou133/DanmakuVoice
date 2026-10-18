// Production UI in offline Edge. Fictional IPC only; no OBS, accounts or network writes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/obs-resume-fix/browser-obs'));
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: false },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, events: [] },
  queue: { current: null, pending: [], history: [] }, rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: null, areas: [], busy: false, has_stream_key: false },
  obs: { settings: { host: '127.0.0.1', port: 4455, enabled: false, auto_launch: true }, has_password: false, local: true, status: { state: 'idle' } },
  overlay: { settings: { enabled: true, port: 47823, token: 'fictional-overlay-token', title: '虚构标题', tagline: '', style: 'spine', corner: 'top_left', offset_x: 0, offset_y: 0, scale: 1, vignette: .6, linger_seconds: 14, show_danmaku: true, show_gift: true, show_super_chat: true, show_guard: true, names: 'special', merge_duplicates: true }, running: true, clients: [], url: 'http://127.0.0.1:47823/overlay?token=fictional-overlay-token' },
};
const calls = [], errors = [], checks = [];
let probeError = false, sourceMode = 'ready', holdProbe = false, held;
const until = async predicate => {
  const limit = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > limit) throw new Error('IPC wait timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
      let bytes = await fs.readFile(file).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(file))));
      if (pathname === '/app.js') bytes = bytes.toString() + '\nwindow.__obsFixture = { accept: acceptSnapshot, inspect: () => structuredClone(snapshot), browserCount: overlayObsClientCount, update: updateObsSettings, refresh: () => { obsRefreshAt = 0; return refreshObsStatus(); } };';
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.DV_BROWSER_CHANNEL || 'msedge', args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__offlineInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch');
      calls.push(structuredClone(args));
      let result;
      if (args.action === 'obs.refresh') {
        const next = structuredClone(state);
        next.obs.status = probeError ? { ...next.obs.status, state: 'error', message: '无法连接 OBS，请确认 WebSocket 服务器已开启 [DV-OB01]' } : { ...next.obs.status, state: 'ok', message: undefined, streaming: false, obs_version: next.obs.settings.port === 4455 ? '31.0.0' : 'new-config' };
        if (holdProbe) { holdProbe = false; await new Promise(resolve => { held = resolve; }); }
        if (next.obs.settings.host === state.obs.settings.host && next.obs.settings.port === state.obs.settings.port) state.obs.status = next.obs.status;
        if (probeError) throw new Error(next.obs.status.message);
        return next;
      } else if (args.action === 'obs.overlay.sync') {
        state.obs.status.overlay_sync = { state: sourceMode, scene: '虚构场景', width: 1920, height: 1080, ...(sourceMode === 'error' ? { message: '同名来源并非弹幕姬的浏览器来源 [DV-OB12]' } : {}) };
        result = { found: sourceMode !== 'missing', created: false, added_to_scene: false, width: 1920, height: 1080, scene: '虚构场景' };
      } else if (args.action === 'obs.save') {
        Object.assign(state.obs.settings, args.payload.settings); state.config_revision++;
        state.obs.status = { state: 'idle' }; state.obs.status.overlay_sync = { state: 'idle' };
      } else if (args.action === 'preferences.save') {
        Object.assign(state.preferences, args.payload.preferences); state.config_revision++;
      } else if (args.action === 'bili.chat.emoticons.refresh') {
        state.chat_send = { busy: false, error: null, account_id: state.account.user_id, room_id: 123, message_limit: 20, emoticons: [] };
      } else if (!['bili.qr.cancel', 'doubao.qr.cancel'].includes(args.action)) throw new Error('Unexpected fixture action ' + args.action);
      return { ...structuredClone(state), ...(result ? { result } : {}) };
    });
    await page.addInitScript(() => {
      window.__offlineListeners = {};
      window.__TAURI__ = { core: { invoke: (command, args) => window.__offlineInvoke(command, args) }, event: { listen: async (name, callback) => { window.__offlineListeners[name] = callback; return () => {}; } } };
    });
    const push = async () => page.evaluate(next => window.__obsFixture.accept(next), structuredClone(state));
    const refresh = async () => page.evaluate(() => window.__obsFixture.refresh());
    const count = action => calls.filter(call => call.action === action).length;
    await page.goto(origin); await page.locator('#live-shell').waitFor();
    assert.equal(count('obs.refresh'), 0); checks.push('no OBS polling while main page is shown');
    holdProbe = true;
    await page.locator('[data-action="settings.open"]').click();
    if (!await page.locator('[data-action="settings.tab"][data-id="overlay"]').count()) await page.locator('[data-action="settings.tab"][data-id="home"]').click();
    await page.locator('[data-action="settings.tab"][data-id="overlay"]').click();
    await until(() => held);
    // The overlay was added before, so the page opens on the stage while it looks for OBS.
    assert.match(await page.locator('[data-overlay-status-text]').textContent(), /正在检测/);
    held(); held = null;
    await page.locator('[data-obs-view="preview"]').waitFor();
    assert.equal(await page.evaluate(() => window.__obsFixture.inspect().obs.status.obs_version), '31.0.0');
    await until(() => count('obs.overlay.sync') === 1);
    assert.equal(count('obs.test'), 0); assert.equal(count('obs.overlay.add'), 0); assert.equal(count('obs.save'), 0);
    assert.equal(calls.find(call => call.action === 'obs.overlay.sync').payload.automatic, true);
    checks.push('opening OBS settings checks its actual status and repairs only an existing source');
    const firstReads = count('obs.refresh');
    await page.evaluate(() => { window.__obsFixture.update(); window.__obsFixture.update(); });
    assert.equal(count('obs.refresh'), firstReads);
    checks.push('repeated snapshots do not bypass the 15 second observation limit');
    await page.locator('[data-overlay-status-text]').filter({ hasText: '已放进场景「虚构场景」' }).waitFor();
    assert.equal(await page.locator('[data-obs-root]').getAttribute('data-tone'), 'ready');
    assert.doesNotMatch(await page.locator('[data-overlay-status-text]').textContent(), /正在显示/);
    assert.equal(await page.evaluate(() => window.__obsFixture.inspect().overlay.clients.length), 0);
    checks.push('connected WebSocket and repaired source do not claim a browser page is displaying');
    await page.locator('[data-action="lake.obs.advanced"]').click();
    const password = page.locator('[data-obs-secret]');
    await password.fill('fictional-unsaved-password');
    await password.evaluate(input => { input.focus(); input.setSelectionRange(2, 7); window.__passwordNode = input; });
    const oldSaves = count('obs.save');
    await refresh();
    assert.equal(await password.inputValue(), 'fictional-unsaved-password');
    assert.equal(await page.evaluate(() => window.__passwordNode === document.querySelector('[data-obs-secret]') && document.activeElement === window.__passwordNode && window.__passwordNode.selectionStart === 2 && window.__passwordNode.selectionEnd === 7), true);
    assert.equal(count('obs.save'), oldSaves); checks.push('automatic observations retain form node, password draft, focus and selection without saving');
    assert.equal(count('obs.password'), 0);
    probeError = true;
    await refresh();
    await page.locator('[data-obs-status-text]').filter({ hasText: 'OBS 没打开' }).waitFor();
    assert.match(await page.locator('[data-obs-status-text]').getAttribute('title'), /DV-OB01/);
    assert.equal(await page.locator('#settings-error').isHidden(), true);
    assert.equal(await password.inputValue(), 'fictional-unsaved-password');
    checks.push('automatic failure shows the actual reason without modal, toast or draft loss');
    // Discard this deliberately unsaved fixture draft before changing pages.
    await password.evaluate(input => { input.value = ''; delete input.dataset.changed; });
    probeError = false; sourceMode = 'error'; state.obs.status.overlay_sync = { state: 'idle' }; await push(); await refresh();
    await page.locator('.lake-settings-heading [data-action="lake.obs.back"]').click();
    await page.locator('[data-obs-view="preview"]').waitFor();
    await page.locator('[data-overlay-binding-detail]').filter({ hasText: 'DV-OB12' }).waitFor();
    assert.match(await page.locator('[data-overlay-status-text]').textContent(), /已连接 OBS/);
    assert.equal(await page.locator('[data-obs-root]').getAttribute('data-tone'), 'ready');
    assert.equal(count('obs.overlay.add'), 0); checks.push('conflicting source error stays separate from successful WebSocket connection and never creates a source');
    sourceMode = 'missing'; state.obs.status.overlay_sync = { state: 'idle' }; await push(); await refresh();
    await page.locator('[data-overlay-binding-detail]').filter({ hasText: '叠加层还没放进场景' }).waitFor();
    assert.equal(await page.locator('[data-action="overlay.obs_add"]').isVisible(), true);
    checks.push('missing source gives the explicit Add to OBS action');
    state.overlay.clients = [{ width: 1920, height: 1080 }]; state.obs.status = { state: 'error', message: '无法连接 OBS [DV-OB01]' }; await push();
    // A configured OBS that stops answering keeps the stage and says it is not open.
    await page.locator('[data-obs-view="offline"]').waitFor();
    assert.match(await page.locator('[data-overlay-status-text]').textContent(), /OBS 还没打开/);
    assert.equal(await page.locator('.lake-obs-binding [data-action="lake.obs.launch"]').isVisible(), true);
    assert.equal(await page.evaluate(() => window.__obsFixture.inspect().overlay.clients.length), 1);
    checks.push('a browser rendering connection cannot mask a failed WebSocket connection');
    state.overlay.obs_clients = 0;
    state.obs.status = { state: 'ok', overlay_sync: { state: 'ready', scene: '虚构场景', page_connected: false } };
    await push();
    await page.locator('[data-obs-view="preview"]').waitFor();
    assert.equal(await page.evaluate(() => window.__obsFixture.browserCount()), 0);
    assert.doesNotMatch(await page.locator('[data-overlay-status-text]').textContent(), /正在显示/);
    assert.match(await page.locator('[data-overlay-status-text]').textContent(), /已放进场景/);
    checks.push('a preview browser alone never claims the OBS page is displaying');
    state.overlay.obs_clients = 1;
    state.obs.status.overlay_sync.page_connected = true;
    await push();
    assert.equal(await page.evaluate(() => window.__obsFixture.browserCount()), 1);
    assert.equal(await page.evaluate(() => window.__obsFixture.inspect().obs.status.overlay_sync.page_connected), true);
    assert.match(await page.locator('[data-overlay-status-text]').textContent(), /已放进场景/);
    checks.push('the actual OBS page connection is retained separately from source placement');
    delete state.overlay.obs_clients;
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.__offlineListeners['resource-mode']({ payload: false }); });
    const readsBefore = count('obs.refresh'); await refresh(); assert.equal(count('obs.refresh'), readsBefore);
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.__offlineListeners['resource-mode']({ payload: true }); });
    await refresh(); assert.ok(count('obs.refresh') > readsBefore);
    checks.push('OBS checks stop while inactive and recover on focus');
    await page.locator('[data-action="lake.obs.advanced"]').click();
    state.overlay.clients = []; sourceMode = 'ready'; state.obs.status = { state: 'idle' }; state.obs.status.overlay_sync = { state: 'idle' }; await push();
    await page.locator('[data-obs-view="advanced"]').waitFor();
    assert.equal(await page.locator('[data-action="overlay.token.reset"]').count(), 0);
    assert.equal(await page.locator('.lake-obs-advanced-foot').count(), 0);
    assert.equal(count('overlay.token.reset'), 0);
    assert.equal(count('obs.overlay.add'), 0); checks.push('OBS advanced has no credential regeneration action or empty footer and never resets credentials');
    holdProbe = true;
    await page.evaluate(() => { void window.__obsFixture.refresh(); });
    await until(() => held);
    state.obs.settings.port = 4456; state.config_revision++; state.obs.status = { state: 'idle' };
    await push(); held(); held = null;
    await page.waitForFunction(() => document.querySelector('[data-obs-status-text]')?.textContent.includes('new-config'));
    assert.match(await page.locator('[data-obs-status-detail]').textContent(), /4456/);
    checks.push('a delayed old-configuration probe cannot replace the new connection status');
    state.preferences.language = 'en'; await push();
    await page.locator('.lake-settings-heading [data-action="lake.obs.back"]').click();
    await page.locator('[data-obs-view="preview"]').waitFor();
    assert.match(await page.locator('[data-overlay-status-text]').textContent(), /Added to scene/);
    checks.push('new connection/source guidance is translated');
    await page.screenshot({ path: path.join(output, 'obs-recovery-en.png') });
    await page.locator('[data-action="settings.close"]').click();
    const closedReads = count('obs.refresh'); await refresh(); assert.equal(count('obs.refresh'), closedReads);
    checks.push('closing the OBS page stops automatic checks');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ offline: true, passed: checks.length, checks, calls: calls.map(call => call.action), errors }, null, 2));
    console.log(`OBS UI recovery: ${checks.length} checks passed (offline fixtures)`);
  } catch (error) {
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error.stack || error), checks, calls: calls.map(call => call.action), errors }, null, 2));
    throw error;
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
