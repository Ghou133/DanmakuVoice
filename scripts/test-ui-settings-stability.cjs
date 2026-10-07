// Offline browser regression: no native app, real credentials or TTS requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(__dirname, '../dist/settings-stability-tests');
const providers = ['gpt_sovits', 'dots', 'fish_audio', 'doubao'];
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: true,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: true },
  setup: { room_id: 123, tts_enabled: true, mode: 'account', uid: 42 },
  live_settings: { gift_merge: { enabled: false } }, live: { running: false, state: 'stopped', events: [] },
  queue: { current: null, pending: [], history: [] },
  rules: { default_preset_id: 'gpt_sovits-1', preferred_presets: {}, user_words: [] },
  connections: providers.map(provider => ({ id: provider, name: provider, settings: { provider }, has_credential: true })),
  presets: providers.flatMap(provider => [1, 2].map(index => ({ id: `${provider}-${index}`, name: `${provider} voice ${index}`, connection_id: provider, provider, voice_id: `voice-${index}`, speed: 1, volume: 1 }))),
  local_services: { gpt_sovits: { state: 'ready', owned: true }, dots: { state: 'ready' } },
  bindings: [], assets: [], devices: [], account: null, qr: { status: 'idle' }, status: {},
};
const calls = [];
let failChoice = false;

(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(target)];
      // Tauri serves embedded files by file name, so ./Font.woff2 comes from ui/fonts.
      const bytes = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'no-preference' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__offlineInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch');
      calls.push(structuredClone(args));
      if (args.action === 'presets.default') {
        if (failChoice) throw new Error('测试保存失败 [DV-S02]');
        state.rules.default_preset_id = args.payload.id;
        const preset = state.presets.find(item => item.id === args.payload.id);
        if (preset) state.rules.preferred_presets[preset.provider] = preset.id;
      } else if (!['bili.qr.cancel', 'doubao.qr.cancel'].includes(args.action)) {
        throw new Error('Unexpected action ' + args.action);
      }
      state.config_revision++;
      return structuredClone(state);
    });
    await page.addInitScript(() => {
      window.__offlineListeners = {};
      window.__TAURI__ = { core: { invoke: (command, args) => window.__offlineInvoke(command, args) }, event: { listen: async (name, listener) => { window.__offlineListeners[name] = listener; return () => {}; } } };
      window.__documentIdentity = crypto.randomUUID();
    });
    await page.goto(origin);
    await page.locator('[data-action="settings.open"]').click();
    await page.locator('[data-form="voice-audition"]').waitFor();
    await page.waitForTimeout(500);
    await page.locator('#voice-audition-text').fill('保留试听文字、光标和页面位置');
    const identity = await page.evaluate(() => {
      window.__retained = Object.fromEntries(['.settings-shell', '.settings-nav', '.s-page', '[data-form="voice-audition"]', '#voice-audition-text', '[data-form="tts-toggle"]'].map(selector => [selector, document.querySelector(selector)]));
      window.__entryAnimations = [];
      document.addEventListener('animationstart', event => {
        if (event.target.matches('.settings-dialog, .s-page')) window.__entryAnimations.push(event.animationName);
      });
      const text = document.querySelector('#voice-audition-text');
      text.focus(); text.setSelectionRange(3, 7);
      return window.__documentIdentity;
    });
    // Each focus/visibility transition should keep the DOM and completed entry animation.
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.__offlineListeners['resource-mode']({ payload: false }); });
      await page.waitForTimeout(70);
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.__offlineListeners['resource-mode']({ payload: true }); });
      await page.waitForTimeout(100);
    }
    assert.deepEqual(await page.evaluate(() => window.__entryAnimations), [], 'focus return restarted page entry animations');
    assert.equal(await page.evaluate(() => document.activeElement.selectionStart), 3);
    assert.equal(await page.evaluate(() => document.activeElement.selectionEnd), 7);
    await page.evaluate(() => { document.querySelector('#settings-content').scrollTop = 85; });
    const scroll = await page.locator('#settings-content').evaluate(node => node.scrollTop);
    const assertRetained = async () => {
      assert.equal(await page.evaluate(() => window.__documentIdentity), identity);
      assert.equal(await page.evaluate(() => Object.entries(window.__retained).every(([selector, node]) => document.querySelector(selector) === node && node.isConnected)), true, 'voice selection replaced settings/form DOM');
      assert.equal(await page.locator('#voice-audition-text').inputValue(), '保留试听文字、光标和页面位置');
      assert.equal(await page.locator('#settings-content').evaluate(node => node.scrollTop), scroll);
    };
    for (const provider of providers) {
      await page.locator(`[data-action="service.prefer"][data-id="${provider}"]`).click();
      await page.waitForFunction(expected => document.querySelector('[data-form="voice-audition"]').dataset.provider === expected, provider);
      await assertRetained();
      await page.locator(`input[name="preset_id"][value="${provider}-2"]`).locator('..').click();
      await page.waitForFunction(expected => document.querySelector(`input[name="preset_id"][value="${expected}"]`).checked && document.querySelector('#voice-management')?.innerText.includes('正在使用'), `${provider}-2`);
      await assertRetained();
      assert.equal(state.rules.default_preset_id, `${provider}-2`);
    }
    failChoice = true;
    await page.locator('input[name="preset_id"][value="doubao-1"]').locator('..').click();
    await page.locator('#settings-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('input[name="preset_id"][value="doubao-2"]').isChecked(), true);
    await assertRetained();
    assert.deepEqual(errors, []);
    assert.equal(calls.some(call => /local_services.stop|audition|qr.begin/.test(call.action)), false);
    await page.screenshot({ path: path.join(output, 'settings-preserved.png') });
    // An unsubmitted service editor must keep its original input and selection too.
    await page.locator('[data-action="service.configure"][data-id="fish_audio"]').click();
    await page.locator('details:has([data-form="service-fish"]) summary').click();
    await page.locator('input[name="credential"]').fill('fictional-unsaved-editor-value');
    await page.evaluate(() => {
      window.__editorInput = document.querySelector('input[name="credential"]');
      window.__editorInput.focus(); window.__editorInput.setSelectionRange(2, 6);
      window.__entryAnimations = [];
    });
    await page.evaluate(() => window.__offlineListeners['resource-mode']({ payload: false }));
    await page.waitForTimeout(80);
    await page.evaluate(() => window.__offlineListeners['resource-mode']({ payload: true }));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.querySelector('input[name="credential"]') === window.__editorInput), true);
    assert.equal(await page.locator('input[name="credential"]').inputValue(), 'fictional-unsaved-editor-value');
    assert.deepEqual(await page.evaluate(() => [window.__editorInput.selectionStart, window.__editorInput.selectionEnd]), [2, 6]);
    assert.deepEqual(await page.evaluate(() => window.__entryAnimations), []);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, headless: true, nativeWebView2: false, realTts: false, focusCycles: 4, providers: providers.length, failedSaveRestored: true, editorDraftRetained: true, calls: calls.map(call => call.action) }, null, 2));
    console.log('Settings stability browser regression passed: focus x4, 4 services, voices, failed save, retained forms/text/scroll/editor draft.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
