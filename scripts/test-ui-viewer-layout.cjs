// Actual production HTML/CSS in headless Edge with fictional IPC only.
// Every external request is blocked; no account API, native window, chat or TTS.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/viewer-lower-redesign'));
const assets = ['app.js', 'helpers.mjs', 'index.html', 'styles.css', 'lake.css', 'lake-drawers.css', 'fonts/DanmakuVoiceSerifSC-Medium.woff2', 'fonts/DanmakuVoiceSerifSC-Bold.woff2', 'fonts/DanmakuVoiceSerifSC-Black.woff2', 'fonts/InstrumentSerif-Regular.woff2', 'fonts/InstrumentSerif-Italic.woff2'];
const hashes = async () => Object.fromEntries(await Promise.all(assets.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
const checks = [], calls = [], layouts = [];
const check = name => { checks.push(name); console.log(`ok ${name}`); };
const until = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fictional viewer IPC');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
let revision = 1, state, holdAlias = null, holdModeration = null;
const viewerName = '虚构观众的很长很长名字用于检查卡片排版与完整原名保存 🌙 Long viewer name';
const makeState = ({ count = 7, width = 1040, height = 740, theme = 'dark', language = 'zh-CN', variant = 'ready', userName = viewerName, presetNames } = {}) => {
  const noIdentity = variant === 'disabled';
  const viewer = { room_id: 999, platform_event_id: `fictional-layout-${revision}`, observed_at_ms: Date.now(), kind: 'danmaku', user_id: noIdentity ? null : 501, user_name: noIdentity ? '' : userName, message: '本地布局测试：声音与称呼设置保留在同一张观众卡片里。', avatar_url: null };
  const presets = Array.from({ length: count }, (_, index) => ({ id: `voice-${index}`, connection_id: 'fictional-dots', provider: 'dots', name: presetNames?.[index] || `声音 ${index + 1} · 超长名字用于检查两列选项完整布局 ${'柔和的湖面与星光 '.repeat(index % 3 + 1)}Long voice name ${index + 1}`, voice_id: 'fixture.wav', speed: 1, volume: 1 }));
  const ready = { busy: false, user_id: noIdentity ? null : '501', room_id: 999, can_moderate: true, can_blacklist: true, can_manage_admins: true, muted: false, blacklisted: false, is_admin: false, message: null };
  if (variant === 'unknown' || variant === 'busy') Object.assign(ready, { busy: variant === 'busy', can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null });
  if (variant === 'muted') ready.muted = true;
  if (variant === 'blocked') ready.blacklisted = true;
  if (variant === 'admin') ready.is_admin = true;
  return {
    config_revision: ++revision, onboarding_done: true, network_disabled: false,
    preferences: { language, appearance: theme, scale: 1, master_volume: 1, muted: false, tts_enabled: false, broadcast_console: true },
    setup: { room_id: 999, uid: 42, mode: 'account', tts_enabled: false }, live_settings: { room_id: 999, gift_merge: { enabled: false } },
    live: { room_id: 999, running: true, state: 'connected', events: [viewer] }, queue: { current: null, pending: [], history: [] },
    rules: { default_preset_id: presets[0]?.id || null, preferred_presets: {}, user_words: [{ from: '另一个观众', to: '其它已保存称呼' }], message_words: [], sounds: [] },
    connections: [{ id: 'fictional-dots', name: '虚构本地声音', settings: { provider: 'dots', endpoint: 'http://127.0.0.1:9881', timeout_secs: 30 } }],
    presets, bindings: [], assets: [], devices: [], local_services: {},
    account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
    broadcast: { room: { room_id: 999, title: '虚构直播间', live_status: 1, parent_area_id: 2, area_id: 86 }, areas: [], busy: false },
    obs: { settings: { enabled: false }, status: { state: 'idle' } }, overlay: { settings: { enabled: false }, running: false },
    chat_send: { busy: false, error: null, warnings: [], account_id: 42, room_id: 999, message_limit: 40, emoticons: [] },
    moderation: ready, fixture: { count, width, height, theme, language, variant, namedPresets: !!presetNames },
  };
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const testedAssets = await hashes();
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
      let bytes = await fs.readFile(file).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(file))));
      if (pathname === '/app.js') bytes = Buffer.concat([bytes, Buffer.from(`\nwindow.__viewerLayoutPush = next => acceptSnapshot(next);\nwindow.__viewerLayoutBusy = () => viewerModerationBusy;\n`)]);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', executablePath: process.env.DV_BROWSER_PATH || undefined, headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'reduce' });
    const blockedRequests = [];
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      blockedRequests.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__viewerInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch');
      const { action, payload } = args;
      calls.push(structuredClone({ action, payload }));
      if (action === 'bili.moderation.refresh') {
        assert.deepEqual(payload, { user_id: '501' });
      } else if (action === 'bili.chat.emoticons.refresh') {
        assert.deepEqual(payload, {});
      } else if (action === 'rules.save') {
        if (holdAlias) { holdAlias.started = true; await new Promise(resolve => { holdAlias.resolve = resolve; }); }
        state.rules = structuredClone(payload.rules);
        state.config_revision = ++revision;
      } else if (action === 'bindings.save') {
        assert.deepEqual(payload.binding, { platform: 'bilibili', user_id: 501, user_name: null, legacy_user_name: null, preset_id: payload.binding.preset_id, enabled: true });
        assert.ok(state.presets.some(preset => preset.id === payload.binding.preset_id));
        const id = payload.id || 'fictional-viewer-binding';
        const record = { id, binding: structuredClone(payload.binding) };
        const index = state.bindings.findIndex(item => item.id === id);
        if (index < 0) state.bindings.push(record); else state.bindings[index] = record;
        state.config_revision = ++revision;
      } else if (action === 'bindings.delete') {
        assert.deepEqual(payload, { id: 'fictional-viewer-binding', confirmed: true });
        state.bindings = state.bindings.filter(item => item.id !== payload.id);
        state.config_revision = ++revision;
      } else if (/^bili\.moderation\.(mute|unmute|blacklist|unblacklist|appoint|dismiss)$/.test(action)) {
        assert.equal(payload.confirmed, true);
        assert.equal(payload.user_id, '501');
        assert.equal(payload.room_id, 999);
        if (holdModeration) { holdModeration.started = true; await new Promise(resolve => { holdModeration.resolve = resolve; }); }
        if (action.endsWith('.mute')) state.moderation.muted = true;
        if (action.endsWith('.unmute')) state.moderation.muted = false;
        if (action.endsWith('.blacklist')) state.moderation.blacklisted = true;
        if (action.endsWith('.unblacklist')) state.moderation.blacklisted = false;
        if (action.endsWith('.appoint')) state.moderation.is_admin = true;
        if (action.endsWith('.dismiss')) state.moderation.is_admin = false;
      } else if (!['bili.broadcast.refresh', 'bili.qr.cancel', 'doubao.qr.cancel'].includes(action)) throw new Error(`Unexpected fictional viewer action ${action}`);
      return structuredClone(state);
    });
    await page.addInitScript(() => {
      window.__TAURI__ = { core: { invoke: (command, args) => window.__viewerInvoke(command, args) }, event: { listen: async () => () => {} } };
    });
    const drawer = page.locator('#viewer-drawer'), sheet = drawer.locator('.viewer-sheet');
    const alias = drawer.locator('#viewer-alias'), voices = drawer.locator('#viewer-voices'), moderation = drawer.locator('#viewer-moderation');
    const voice = id => voices.locator(`[data-action="viewer.bind"][data-id="${id}"]`);
    const action = name => moderation.locator(`[data-action="viewer.moderation.${name}"]`);
    const push = () => page.evaluate(next => window.__viewerLayoutPush(next), structuredClone(state));
    const boot = async options => {
      state = makeState(options);
      await page.setViewportSize({ width: options?.width || 1040, height: options?.height || 740 });
      await page.goto(origin);
      await page.locator('#lake-current .lake-avatar-button').click();
      await alias.waitFor();
      await page.waitForFunction(() => !window.__viewerLayoutBusy());
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('html').getAttribute('data-theme'), state.preferences.appearance);
    };
    const measure = async name => {
      const result = await sheet.evaluate((node, fixture) => {
        const bounds = node.getBoundingClientRect(), body = node.querySelector('.viewer-body'), grid = node.querySelector('#viewer-voices');
        const gridStyle = getComputedStyle(grid);
        const bound = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
        const visible = element => !element.closest('[hidden]') && element.getClientRects().length;
        const controls = [...node.querySelectorAll('#viewer-voices button, #viewer-moderation button, #viewer-moderation fieldset, #viewer-alias')].filter(visible);
        const presetControls = [...grid.querySelectorAll('[data-action="viewer.bind"]')];
        return { fixture, bounds: bound(node), body: { ...bound(body), clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight }, sheetScroll: { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }, grid: { ...bound(grid), display: gridStyle.display, wrap: gridStyle.flexWrap, rowGap: parseFloat(gridStyle.rowGap), columnGap: parseFloat(gridStyle.columnGap), clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth, clientHeight: grid.clientHeight, scrollHeight: grid.scrollHeight, contentWidth: grid.clientWidth - parseFloat(gridStyle.paddingLeft) - parseFloat(gridStyle.paddingRight) }, voiceButtons: presetControls.map(button => ({ id: button.dataset.id, pressed: button.getAttribute('aria-pressed'), radius: parseFloat(getComputedStyle(button).borderTopLeftRadius), background: getComputedStyle(button).backgroundImage, ...bound(button) })), escaped: controls.filter(control => { const box = control.getBoundingClientRect(); return box.x < bounds.x - 1 || box.right > bounds.right + 1; }).map(control => control.outerHTML.slice(0, 160)), document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }, rowBounds: [...node.querySelectorAll('.viewer-moderation-row')].filter(visible).map(row => ({ ...bound(row), action: bound(row.querySelector('button')) })) };
      }, state.fixture);
      assert.ok(result.body.scrollWidth <= result.body.clientWidth + 1, `${name} body overflow ${JSON.stringify(result)}`);
      assert.ok(result.sheetScroll.scrollWidth <= result.sheetScroll.clientWidth + 1, `${name} sheet overflow ${JSON.stringify(result)}`);
      assert.ok(result.grid.scrollWidth <= result.grid.clientWidth + 1, `${name} voice overflow ${JSON.stringify(result)}`);
      assert.ok(result.document.scrollWidth <= result.document.clientWidth + 1, `${name} document overflow`);
      assert.deepEqual(result.escaped, [], `${name} controls escape card`);
      assert.equal(result.voiceButtons.length, state.fixture.count + 1);
      const defaultVoice = result.voiceButtons.find(item => item.id === '');
      assert.equal(result.grid.display, 'flex', `${name} voices must retain their natural pill layout`);
      assert.equal(result.grid.wrap, 'wrap', `${name} pills must wrap naturally inside the card`);
      assert.ok(result.grid.scrollHeight <= result.grid.clientHeight + 1, `${name} the original voice list must not introduce its own clipped scrolling area`);
      assert.ok(defaultVoice.width < result.grid.contentWidth - 2, `${name} default voice must retain its natural pill width`);
      assert.ok(result.voiceButtons.every(button => button.radius >= button.height / 2), `${name} voice buttons must retain their capsule shape`);
      assert.ok(result.voiceButtons.every(button => Math.abs(button.height - 30) <= 1 && Math.abs(button.radius - 15) <= .5), `${name} voice buttons must retain their original 30px height and 15px radius`);
      assert.equal(result.grid.rowGap, 6, `${name} voice rows must retain their original spacing`);
      assert.equal(result.grid.columnGap, 6, `${name} voice pills must retain their original spacing`);
      assert.ok(result.voiceButtons.filter(button => button.pressed === 'true').every(button => button.background.includes('linear-gradient')), `${name} selected pills must retain their original gradient`);
      assert.equal(await voices.locator('.viewer-voice-check, .viewer-settings-label').count(), 0, `${name} added checkmarks and voice heading must be absent`);
      const presetVoices = result.voiceButtons.filter(item => item.id !== '');
      if (state.fixture.namedPresets) assert.ok(new Set(presetVoices.map(button => Math.round(button.width))).size > 1, `${name} names must retain their natural pill widths rather than fixed columns`);
      for (const row of result.rowBounds) {
        assert.ok(Math.abs(row.action.right - row.right) <= 1, `${name} moderation actions must align on the same right edge`);
        assert.ok(Math.abs(row.action.y + row.action.height / 2 - row.y - row.height / 2) <= 1, `${name} moderation action must center in its row`);
        assert.ok(row.action.height <= 36, `${name} moderation controls must remain compact`);
      }
      layouts.push({ name, ...result });
      await page.screenshot({ path: path.join(output, `${name}.png`) });
      const body = drawer.locator('.viewer-body');
      const scrollTop = await body.evaluate(node => node.scrollTop);
      await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await body.screenshot({ path: path.join(output, `${name}-lower.png`) });
      await body.evaluate((node, previous) => { node.scrollTop = previous; }, scrollTop);
      return result;
    };

    for (const theme of ['dark', 'light']) for (const language of ['zh-CN', 'en']) for (const width of [1040, 700]) for (const count of [0, 1, 7, 25]) {
      const name = `${theme}-${language}-${width}-voices${count}`;
      await boot({ theme, language, width, count });
      await measure(name);
      assert.equal(await voice('').getAttribute('aria-pressed'), 'true');
      assert.equal(await voices.locator('[aria-pressed="true"]').count(), 1);
      check(`${name}: original capsule buttons wrap naturally and long names and moderation controls remain inside the card`);
    }

    for (const theme of ['dark', 'light']) {
      await boot({ count: 6, width: 1040, height: 900, theme, language: 'zh-CN', userName: '观众小雨', presetNames: ['流萤', '井芹仁菜', '莫提斯', '温柔桃子（升级版）', '赛马娘（曼波欧耶版）', '高松灯（企鹅）'] });
      const name = `hero-${theme}-zh-CN-1040-presets6`;
      const naturalList = await voices.evaluate(node => {
        const outer = node.getBoundingClientRect();
        return { clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, clipped: [...node.querySelectorAll('button')].filter(button => { const box = button.getBoundingClientRect(); return box.top < outer.top - 1 || box.bottom > outer.bottom + 1; }).map(button => button.dataset.id) };
      });
      assert.ok(naturalList.scrollHeight <= naturalList.clientHeight, `${theme} the six named presets and default must fit without scrolling: ${JSON.stringify(naturalList)}`);
      assert.equal(naturalList.scrollTop, 0);
      assert.deepEqual(naturalList.clipped, [], `${theme} every natural preset must be fully visible`);
      await measure(name);
      const completeLower = drawer.locator('.viewer-body');
      await completeLower.evaluate(node => { node.scrollTop = node.scrollHeight; });
      const lowerVisibility = await completeLower.evaluate(node => {
        const outer = node.getBoundingClientRect();
        return [...node.querySelectorAll('.viewer-alias-field, #viewer-voices, .viewer-moderation-row')].map(item => { const box = item.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, outerTop: outer.top, outerBottom: outer.bottom }; });
      });
      assert.ok(lowerVisibility.every(item => item.top >= item.outerTop - 1 && item.bottom <= item.outerBottom + 1), `the tall hero must show alias, default voice and every management row together: ${JSON.stringify(lowerVisibility)}`);
      await completeLower.screenshot({ path: path.join(output, `${name}-complete-lower.png`) });
      await sheet.screenshot({ path: path.join(output, `${name}-card.png`) });
      check(`${theme} short-name hero: the complete card and its compact lower controls remain aligned`);
    }

    for (const variant of ['disabled', 'unknown', 'busy', 'muted', 'blocked', 'admin']) {
      await boot({ count: 25, width: 700, theme: variant === 'muted' || variant === 'admin' ? 'light' : 'dark', language: variant === 'busy' || variant === 'blocked' ? 'en' : 'zh-CN', variant });
      if (variant === 'disabled') {
        assert.equal(await alias.isDisabled(), true);
        assert.equal(await voices.locator('button').evaluateAll(nodes => nodes.every(node => node.disabled)), true);
      }
      if (['disabled', 'unknown', 'busy'].includes(variant)) assert.equal(await moderation.locator('button[data-action]').evaluateAll(nodes => nodes.every(node => node.disabled)), true);
      if (variant === 'muted') { assert.equal(await action('unmute').count(), 1); assert.equal(await moderation.locator('.viewer-durations').isHidden(), true); }
      if (variant === 'blocked') assert.equal(await action('unblacklist').count(), 1);
      if (variant === 'admin') assert.equal(await action('dismiss').getAttribute('aria-checked'), 'true');
      await measure(`state-${variant}-700-voices25`);
      check(`${variant}: the narrow long-name card retains usable layout and the correct enabled and selected controls`);
    }

    await boot({ count: 25, width: 700, language: 'en', theme: 'light' });
    const scrollingBody = drawer.locator('.viewer-body');
    await scrollingBody.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const originalScroll = await scrollingBody.evaluate(node => node.scrollTop);
    assert.ok(originalScroll > 0);
    await push();
    assert.equal(await scrollingBody.evaluate(node => node.scrollTop), originalScroll);
    await voice('voice-24').click();
    await until(() => state.bindings.some(record => record.binding.preset_id === 'voice-24'));
    await page.waitForFunction(() => document.querySelector('[data-action="viewer.bind"][data-id="voice-24"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await voice('voice-24').evaluate(node => node === document.activeElement), true);
    assert.equal(await scrollingBody.evaluate(node => node.scrollTop), originalScroll);
    check('a long natural-wrap voice list preserves body scroll across snapshots and selection changes while retaining keyboard focus on the chosen pill');

    await boot({ count: 7, width: 700, language: 'en', theme: 'light' });
    const mutationCount = () => calls.filter(call => /^bili\.moderation\.(?:mute|unmute|blacklist|unblacklist|appoint|dismiss)$/.test(call.action)).length;
    const beforeArm = mutationCount();
    await action('blacklist').click();
    assert.equal(mutationCount(), beforeArm);
    assert.equal(await action('blacklist').evaluate(node => node.classList.contains('armed')), true);
    await measure('state-blacklist-armed-en-light-700');
    check('blacklist confirmation keeps the same compact row and requires a deliberate second click without dispatching on the first');

    const first = drawer.locator('.viewer-quick button:enabled').first();
    const last = action('appoint');
    await last.focus();
    await page.keyboard.press('Tab');
    assert.equal(await first.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await last.evaluate(node => node === document.activeElement), true);
    await voice('voice-0').focus();
    await page.keyboard.press('Enter');
    await until(() => state.bindings.some(record => record.binding.preset_id === 'voice-0'));
    await page.waitForFunction(() => document.querySelector('[data-action="viewer.bind"][data-id="voice-0"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await voices.locator('[aria-pressed="true"]').count(), 1);
    check('keyboard focus stays inside the card, wraps in both directions and activates the selected voice with Enter');

    holdAlias = {};
    await alias.fill('这份称呼草稿在选择声音时保留');
    await until(() => holdAlias.started);
    await push();
    assert.equal(await alias.inputValue(), '这份称呼草稿在选择声音时保留');
    await voice('voice-6').click();
    await until(() => state.bindings.some(record => record.binding.preset_id === 'voice-6'));
    await page.waitForFunction(() => document.querySelector('[data-action="viewer.bind"][data-id="voice-6"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await alias.inputValue(), '这份称呼草稿在选择声音时保留');
    assert.equal(await voices.locator('[aria-pressed="true"]').count(), 1);
    holdAlias.resolve();
    await until(() => state.rules.user_words.some(item => item.from === viewerName && item.to === '这份称呼草稿在选择声音时保留'));
    holdAlias = null;
    assert.equal(await alias.inputValue(), '这份称呼草稿在选择声音时保留');
    assert.ok(state.rules.user_words.some(item => item.from === '另一个观众' && item.to === '其它已保存称呼'));
    await voice('').click();
    await until(() => state.bindings.length === 0);
    assert.equal(await alias.inputValue(), '这份称呼草稿在选择声音时保留');
    await page.waitForFunction(() => document.querySelector('[data-action="viewer.bind"][data-id=""]')?.getAttribute('aria-pressed') === 'true');
    check('an in-flight alias save survives snapshots and a voice change, preserves the full original viewer name and other aliases, and follow-default removes only its binding');

    const radio = moderation.locator('input[type="radio"][value="168"]');
    await radio.check();
    assert.equal(await moderation.locator('#viewer-mute-hours').inputValue(), '168');
    holdModeration = {};
    await action('mute').click();
    await until(() => holdModeration.started);
    assert.equal(await moderation.locator('button[data-action]').evaluateAll(nodes => nodes.every(node => node.disabled)), true);
    assert.equal(await alias.inputValue(), '这份称呼草稿在选择声音时保留');
    await measure('state-inflight-mute-en-light-700');
    const sentMute = calls.filter(call => call.action === 'bili.moderation.mute').at(-1);
    assert.deepEqual(sentMute.payload, { user_id: '501', room_id: 999, confirmed: true, hours: 168 });
    holdModeration.resolve();
    await page.waitForFunction(() => !window.__viewerLayoutBusy());
    holdModeration = null;
    await action('unmute').waitFor();
    assert.equal(await alias.inputValue(), '这份称呼草稿在选择声音时保留');
    check('duration selection sends the canonical value once, an in-flight moderation action disables duplicate controls, and completion preserves the alias draft');

    await alias.fill('关闭观众卡片之前的最后草稿');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    assert.ok(state.rules.user_words.some(item => item.from === viewerName && item.to === '关闭观众卡片之前的最后草稿'));
    await page.locator('#lake-current .lake-avatar-button').click();
    await alias.waitFor();
    assert.equal(await alias.inputValue(), '关闭观众卡片之前的最后草稿');
    check('closing flushes the current alias and reopening restores it without changing the selected default voice');

    assert.deepEqual(errors, []);
    assert.deepEqual(blockedRequests, [], 'fixtures must not trigger any external traffic');
    assert.deepEqual(await hashes(), testedAssets, 'production assets must stay frozen during layout acceptance');
    assert.equal(calls.some(call => /^(?:audition|bili\.chat\.(?:send|emoticon\.send)|obs\.)/.test(call.action)), false);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ evidence: 'actual production UI in headless Edge with fictional local IPC; all external requests blocked; no real account, chat, OBS, native-window or TTS operation', checked_at: new Date().toISOString(), tested_assets_sha256: testedAssets, checks, layouts, dispatches: calls }, null, 2));
    console.log(`${checks.length} viewer layout checks passed`);
  } finally {
    holdAlias?.resolve?.();
    holdModeration?.resolve?.();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
