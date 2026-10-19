// Offline interaction regression. Fictional IPC fixtures only; this proves UI
// placement, persistence envelopes and transitions, never a live OBS connection.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const uiRoot = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(__dirname, '../dist/lake-redesign-obs-tests');
const calls = [];
const errors = [];
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false },
  setup: { room_id: 123, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { gift_merge: { enabled: false } }, live: { running: false, state: 'stopped', events: [] },
  queue: { current: null, pending: [], history: [] },
  rules: { default_preset_id: null, preferred_presets: {}, user_words: [], message_words: [], sounds: [], templates: {} },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: null, qr: { status: 'idle' }, status: {},
  obs: { settings: { host: '127.0.0.1', port: 4455, executable: null, enabled: false, auto_launch: true }, status: { state: 'idle' }, has_password: false, local: true, detected: 'C:\\OBS\\bin\\64bit\\obs64.exe' },
  overlay: { settings: { enabled: false, style: 'spine', corner: 'top_left', offset_x: 0, offset_y: 0, scale: 1, title: '今晚的弹幕', tagline: '', vignette: .6, linger_seconds: 14, show_danmaku: true, show_gift: true, show_super_chat: true, show_guard: false, names: 'special', merge_duplicates: true, port: 47823, token: '0123456789abcdef0123456789abcdef' }, running: false, clients: [], obs_clients: 0, preview: { items: [], reading: null } },
};
const until = async predicate => { const end = Date.now() + 7000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for fixture state'); await new Promise(resolve => setTimeout(resolve, 40)); } };
let saveFailure = false;

(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(uiRoot, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(uiRoot + path.sep)) { response.writeHead(403).end(); return; }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(target)] || 'application/octet-stream';
      const bytes = await fs.readFile(target).catch(() => fs.readFile(path.join(uiRoot, 'fonts', path.basename(target))));
      response.writeHead(200, { 'Content-Type': mime }).end(bytes);
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
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGE:', error.message); });
    await page.exposeFunction('__offlineInvoke', async (command, args) => {
      if (command === 'snapshot') return structuredClone(state);
      if (command === 'ui_activity') return true;
      assert.equal(command, 'dispatch'); calls.push(structuredClone(args));
      let result;
      const { action, payload } = args;
      if (action === 'obs.save') Object.assign(state.obs.settings, payload.settings);
      else if (action === 'obs.password') state.obs.has_password = !!payload.password;
      else if (action === 'obs.test' || action === 'obs.launch') { state.obs.status = { state: 'ok', obs_version: 'fixture', streaming: false }; result = { streaming: false, launched: action === 'obs.launch' }; }
      else if (action === 'overlay.save') {
        if (saveFailure) throw new Error('保存设置失败 [DV-S02]');
        Object.assign(state.overlay.settings, payload.settings); state.overlay.running = state.overlay.settings.enabled;
      } else if (action === 'obs.overlay.add') {
        assert.equal(state.overlay.running, true, 'Add must enable the real feed before creating the OBS source');
        state.obs.status.overlay_sync = { state: 'ready', scene: '虚构测试场景', width: 1920, height: 1080 };
        state.overlay.obs_clients = 1;
        state.overlay.preview.items = [{ seq: 1, kind: 'danmaku', name: '', message: '来自实际预览通道的虚构测试弹幕', at: Date.now(), job_id: 5 }];
        state.overlay.preview.reading = { job_id: 5, played_ms: 2000, queued_ms: 6000 };
        result = { created: true, found: true, scene: '虚构测试场景', width: 1920, height: 1080 };
      } else if (action === 'obs.overlay.sync') result = { found: state.overlay.obs_clients > 0 };
      else if (action === 'preferences.save') Object.assign(state.preferences, payload.preferences);
      else if (!['obs.refresh', 'bili.qr.cancel', 'doubao.qr.cancel', 'bili.broadcast.refresh'].includes(action)) throw new Error(`Unexpected fixture action ${action}`);
      state.config_revision++;
      return { ...structuredClone(state), result };
    });
    await page.addInitScript(() => {
      window.__TAURI__ = { core: { invoke: (command, args) => window.__offlineInvoke(command, args) }, event: { listen: async () => () => {} } };
    });
    await page.goto(origin);
    await page.locator('[data-action="settings.open"]').click();
    if (!await page.locator('[data-action="settings.tab"][data-id="overlay"]').count()) await page.locator('[data-action="settings.tab"][data-id="home"]').click();
    await page.locator('[data-action="settings.tab"][data-id="overlay"]').click();
    await page.locator('[data-obs-view="connect"]').waitFor();
    assert.equal(Math.round((await page.locator('#settings').boundingBox()).width), 380);
    assert.equal(await page.locator('[data-action="overlay.copy"], [data-action="overlay.test"], input[name="vignette"]').count(), 0);
    await page.screenshot({ path: path.join(output, 'obs-connection-dark.png') });
    await page.locator('input[name="port"]').fill('4456');
    await page.locator('[data-obs-secret]').fill('fictional-secret-not-real');
    await page.locator('[data-action="lake.obs.connect"]').click();
    await page.locator('[data-obs-view="preview"]').waitFor();
    assert.equal(state.obs.settings.port, 4456);
    assert.equal(state.obs.has_password, true);
    assert.equal(calls.filter(call => call.action === 'obs.password').length, 1, 'blur and Connect share the same credential save');
    assert(calls.findIndex(call => call.action === 'obs.password') < calls.findIndex(call => call.action === 'obs.test'));
    assert.equal(Math.round((await page.locator('#settings').boundingBox()).width), 908);
    assert(!(await page.locator('#settings').innerText()).includes('fictional-secret-not-real'));
    assert.equal(await page.locator('[data-ovp-items]').innerText(), 'waiting for the first word…');
    await page.locator('[data-action="overlay.obs_add"]').click();
    await until(() => state.overlay.obs_clients === 1);
    await page.locator('[data-action="overlay.obs_add"]').waitFor({ state: 'hidden' });
    assert((await page.locator('[data-overlay-status-text]').innerText()).includes('虚构测试场景'));
    assert((await page.locator('[data-ovp-items]').innerText()).includes('来自实际预览通道的虚构测试弹幕'));
    assert.equal(await page.locator('.ovp-live-words.reading').count(), 1);

    const block = page.locator('[data-ovp-drag]');
    const rect = await block.boundingBox();
    const before = calls.filter(call => call.action === 'overlay.save').length;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 5); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 80, rect.y + 75, { steps: 8 });
    await until(() => calls.filter(call => call.action === 'overlay.save').length > before);
    assert(state.overlay.settings.offset_x > 100 && state.overlay.settings.offset_y > 100, 'placement is saved during dragging in source pixels');
    await page.mouse.up();
    await page.waitForTimeout(180);

    const moved = await block.boundingBox(), canvas = await page.locator('.ovp-stage').boundingBox();
    const targetX = canvas.x + canvas.width - moved.width - 72 * canvas.width / 1920;
    const targetY = canvas.y + canvas.height - moved.height - 48 * canvas.width / 1920;
    await page.mouse.move(moved.x + moved.width / 2, moved.y + 5); await page.mouse.down();
    await page.mouse.move(targetX + moved.width / 2, targetY + 5, { steps: 12 });
    assert.equal(await page.locator('.lake-obs-guide-x:not([hidden]), .lake-obs-guide-y:not([hidden])').count(), 2, 'both edge guides show while the corner holds');
    await page.mouse.up();
    await until(() => state.overlay.settings.corner === 'bottom_right');
    assert.equal(state.overlay.settings.offset_x, 0); assert.equal(state.overlay.settings.offset_y, 0);
    assert.equal(await page.locator('.lake-obs-guide-x:not([hidden]), .lake-obs-guide-y:not([hidden])').count(), 0, 'guides leave with the pointer');

    // Resize from the right bottom handle while keeping its top-left stationary.
    const handle = await page.locator('[data-ovp-resize]').boundingBox();
    await page.mouse.move(handle.x + 5, handle.y + 5); await page.mouse.down();
    await page.mouse.move(handle.x + 60, handle.y + 40, { steps: 8 }); await page.mouse.up();
    await until(() => state.overlay.settings.scale > 1.1);
    const savedPlacement = { corner: state.overlay.settings.corner, scale: state.overlay.settings.scale, offset_x: state.overlay.settings.offset_x, offset_y: state.overlay.settings.offset_y };

    await page.locator('[data-ovp-edit="title"]').dblclick();
    await page.locator('[data-ovp-edit="title"]').fill('夜里的声音');
    await page.locator('[data-ovp-edit="title"]').press('Enter');
    await until(() => state.overlay.settings.title === '夜里的声音');
    // 2026-10-19: in-place edits paint no browser selection, and an emptied title goes back without a message.
    await page.locator('[data-ovp-edit="title"]').dblclick();
    assert.equal(await page.evaluate(() => getSelection().isCollapsed && document.activeElement?.matches('[data-ovp-edit="title"]')), true, 'the preview title was selected like browser text');
    await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-ovp-edit="title"]').innerText(), '夜里的声音');
    assert.doesNotMatch(await page.locator('#toast').textContent(), /1 到 24/, 'an emptied title raised a message');
    assert.equal(state.overlay.settings.title, '夜里的声音');
    await page.locator('[data-ovp-edit="tagline"]').dblclick();
    await page.locator('[data-ovp-edit="tagline"]').fill('a word across the water.');
    await page.locator('[data-ovp-edit="tagline"]').press('Enter');
    await until(() => state.overlay.settings.tagline === 'a word across the water.');
    await page.screenshot({ path: path.join(output, 'obs-preview-dark.png') });

    await page.locator('[data-action="lake.obs.advanced"]').click();
    await page.locator('[data-obs-view="advanced"]').waitFor();
    assert.equal(Math.round((await page.locator('#settings').boundingBox()).width), 380);
    await page.locator('input[name="show_guard"]').check();
    await until(() => state.overlay.settings.show_guard === true);
    for (const [key, value] of Object.entries(savedPlacement)) assert.equal(state.overlay.settings[key], value, `advanced edit preserves ${key}`);
    assert.equal(state.overlay.settings.enabled, true);
    assert.equal(state.overlay.settings.style, 'spine'); assert.equal(state.overlay.settings.vignette, .6); assert.equal(state.overlay.settings.linger_seconds, 14);
    await page.screenshot({ path: path.join(output, 'obs-advanced-dark.png') });
    await page.locator('.lake-settings-heading [data-action="lake.obs.back"]').click();
    await page.locator('[data-obs-view="preview"]').waitFor();
    assert.equal(await page.locator('input[name="scale"]').inputValue(), String(savedPlacement.scale));
    const savedX = state.overlay.settings.offset_x;
    await block.focus(); await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(200);
    await until(() => state.overlay.settings.offset_x === savedX - 1);

    saveFailure = true;
    await page.keyboard.press('ArrowLeft');
    await page.locator('[data-action="autosave.retry"]').waitFor();
    assert.equal(await page.locator('input[name="offset_x"]').inputValue(), String(savedX - 2), 'failed save preserves placement draft');
    saveFailure = false;
    await page.locator('[data-action="autosave.retry"]').click();
    await until(() => state.overlay.settings.offset_x === savedX - 2);

    state.preferences.appearance = 'light';
    await page.reload();
    await page.locator('[data-action="settings.open"]').click();
    if (!await page.locator('[data-action="settings.tab"][data-id="overlay"]').count()) await page.locator('[data-action="settings.tab"][data-id="home"]').click();
    await page.locator('[data-action="settings.tab"][data-id="overlay"]').click();
    await page.locator('[data-obs-view="preview"]').waitFor();
    assert.equal(await page.locator('input[name="offset_x"]').inputValue(), String(savedX - 2));
    await page.screenshot({ path: path.join(output, 'obs-preview-light.png') });
    // Live OBS base canvas metadata takes precedence over an older source size.
    for (const viewport of [{ width: 1600, height: 900 }, { width: 780, height: 580 }]) {
      await page.setViewportSize(viewport);
      for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 3840, height: 1080 }]) {
        state.obs.status.canvas_width = canvas.width; state.obs.status.canvas_height = canvas.height; state.config_revision++;
        await page.locator('[data-ovp-size]').filter({ hasText: `${canvas.width} × ${canvas.height}` }).waitFor();
        const geometry = await block.evaluate(node => {
          const stage = node.closest('.ovp-stage').getBoundingClientRect();
          return { width: stage.width, height: stage.height, translation: getComputedStyle(node).translate.split(' ').map(parseFloat) };
        });
        assert.ok(Math.abs(geometry.width / geometry.height - canvas.width / canvas.height) < .002, JSON.stringify({ viewport, canvas, geometry }));
        assert.ok(Math.abs(geometry.translation[0] - state.overlay.settings.offset_x * geometry.width / canvas.width) < .05);
        assert.ok(Math.abs(geometry.translation[1] - state.overlay.settings.offset_y * geometry.height / canvas.height) < .05);
      }
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ result: 'PASS', evidence: 'offline fixture only', checks: ['380/908 connection transition', 'credential save before connection', 'explicit overlay enable/add', 'real-feed content in preview', 'source-pixel drag saved during movement', 'bottom-right snap', 'resize persistence', 'double-click title/subtitle', 'advanced partial save', 'keyboard placement', 'failed-save draft/retry', 'reload persistence', 'dark/light screenshots', 'live OBS canvas size precedence', 'portrait and ultrawide source pixels at compact and large sizes'], actionCounts: calls.reduce((all, call) => ({ ...all, [call.action]: (all[call.action] || 0) + 1 }), {}) }, null, 2));
    console.log('PASS lake OBS offline interaction regression');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
