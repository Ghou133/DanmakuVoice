// Production Lake module, fictional local IPC only: no account or TTS request.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const root = path.resolve(arg('--ui-root', path.join(__dirname, '../crates/desktop/ui')));
const output = path.resolve(arg('--output', path.join(__dirname, '../target/spotlight-transition-tests')));
const checks = [], errors = [], calls = [];
const emoteUrl = 'https://i0.hdslb.com/bfs/emote/offline-transition-test.png';
const pixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrVsAAAAASUVORK5CYII=', 'base64');
const event = (id, uid, message, extra = {}) => ({ room_id: 123, platform_event_id: `transition-${id}`, observed_at_ms: Date.now() + id * 1000, kind: 'danmaku', user_id: uid, user_name: `观众${uid}`, message, ...extra });
const keyFor = line => `${JSON.stringify([line.room_id, line.platform_event_id])}:0`;
const snapshotFor = (events, reading) => ({ config_revision: 1, onboarding_done: true, network_disabled: true,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: true }, setup: { room_id: 123, tts_enabled: true, mode: 'account', uid: 42 },
  live_settings: { gift_merge: { enabled: false } }, live: { running: true, state: 'connected', room_id: 123, events },
  queue: { current: reading ? { id: 'test-speaking', origin: 'live', user_name: events.at(-1)?.user_name, text: events.at(-1)?.message } : null, pending: [], history: [] },
  rules: { default_preset_id: null, preferred_presets: {}, user_words: [] }, connections: [], presets: [], local_services: {}, bindings: [], assets: [], devices: [], account: null, qr: { status: 'idle' }, status: {} });

async function frame(page, key) {
  return page.evaluate(wanted => {
    const nodes = [...document.querySelectorAll('#lake-current [data-key],#lake-history [data-key]')].filter(n => n.dataset.key === wanted);
    const node = nodes[0], text = node?.querySelector('.lake-message-text'), css = node && getComputedStyle(node), textCss = text && getComputedStyle(text), box = node?.getBoundingClientRect();
    return { copies: nodes.length, sameNode: node === window.__heldPhrase, historical: !!node?.closest('#lake-history'), current: !!node?.closest('#lake-current'), avatarCount: node?.querySelectorAll('.avatar').length ?? 0,
      text: text?.textContent, font: parseFloat(textCss?.fontSize), visibility: textCss?.visibility, transform: css?.transform, filter: css?.filter, y: box?.y,
      clones: document.querySelectorAll('.spot-ghost,.afterglow,.spot-fold-surface').length,
      animations: node?.getAnimations().filter(a => a.effect?.target === node).map(a => ({ duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, state: a.playState })) || [] };
  }, key);
}
function oneVisible(value, label) { assert.equal(value.copies, 1, label); assert.equal(value.avatarCount, 1, label); assert.equal(value.clones, 0, label); assert.equal(value.visibility, 'visible', label); }
async function seek(page, key, time) {
  await page.evaluate(({ key, time }) => {
    const node = [...document.querySelectorAll('#lake-history [data-key]')].find(n => n.dataset.key === key);
    const animations = node?.getAnimations().filter(a => a.effect?.target === node) || [];
    if (!animations.some(a => a.effect.getTiming().duration === 900)) throw new Error('No original 900 ms sink animation');
    for (const animation of animations) { animation.pause(); animation.currentTime = time; }
  }, { key, time });
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
      let source = await fs.readFile(file).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(file))));
      if (pathname === '/app.js') source = source.toString() + '\nwindow.__deliver = acceptSnapshot; window.__stopPoll = () => { clearTimeout(snapshotTimer); clearInterval(lakeClockTimer); boot.polling = false; };';
      res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream' }).end(source);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`; let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge', args: ['--disable-features=msWindowTabManagerPublic'] });
    const makePage = async (events, reading, motion = 'no-preference') => {
      const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: motion });
      await context.route('**/*', route => { const url = route.request().url(); if (url.startsWith(origin + '/')) return route.continue(); if (url === emoteUrl) return route.fulfill({ contentType: 'image/png', body: pixelPng }); return route.abort(); });
      const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
      await page.exposeFunction('__invoke', async (command, args) => { calls.push(command === 'dispatch' ? args.action : command); if (command === 'ui_activity') return true; if (command === 'snapshot') return snapshotFor(events, reading); throw new Error('Unexpected IPC: ' + command); });
      await page.addInitScript(() => { window.__listeners = {}; window.__TAURI__ = { core: { invoke: (c, a) => window.__invoke(c, a) }, event: { listen: async (n, l) => { window.__listeners[n] = l; return () => {}; } } }; });
      await page.goto(origin); await page.locator('#lake-current .lake-message').waitFor(); await page.evaluate(async () => { window.__stopPoll(); await document.fonts.ready; });
      return { page, context, deliver: async (events, reading) => page.evaluate(next => window.__deliver(next), snapshotFor(events, reading)) };
    };
    const a = event(1, 101, '第一句在天空'), b = event(2, 102, '第二句来了'), c = event(3, 103, '接着是第三句');
    {
      const { page, context, deliver } = await makePage([a, b], true);
      await page.evaluate(() => { window.__heldPhrase = document.querySelector('#lake-current .lake-message'); }); await deliver([a, b, c], true);
      await seek(page, keyFor(b), 0); const start = await frame(page, keyFor(b)); oneVisible(start, 'sink start'); assert.equal(start.sameNode, true); assert.equal(start.historical, true); assert.equal(start.font, 20); assert.match(start.transform, /-70\)/); assert.equal(start.filter, 'blur(4px)');
      assert.deepEqual(start.animations.map(a => [a.duration, a.delay]), [[900, 0], [6000, 900]]); await page.screenshot({ path: path.join(output, 'source-sink-start.png') });
      await seek(page, keyFor(b), 450); const middle = await frame(page, keyFor(b)); oneVisible(middle, 'sink middle'); assert.notEqual(middle.transform, start.transform); assert.notEqual(middle.filter, start.filter); await page.screenshot({ path: path.join(output, 'source-sink-middle.png') });
      await seek(page, keyFor(b), 900); const end = await frame(page, keyFor(b)); oneVisible(end, 'sink end'); assert.match(end.filter, /^(?:none|blur\(0px\))$/); assert.ok(Math.abs(end.y - 494) < 1); await page.screenshot({ path: path.join(output, 'source-sink-end.png') });
      checks.push({ name: 'same DOM phrase: source 900ms sink (-70px, blur4px) followed by delayed 6s sway', start, middle, end });
      await page.evaluate(() => { window.__heldPhrase = document.querySelector('#lake-current .lake-message'); }); await deliver([a, b, c], false); const idle = await frame(page, keyFor(c)); oneVisible(idle, 'idle'); assert.equal(idle.sameNode, true); assert.equal(idle.current, true);
      checks.push({ name: 'reading completion keeps latest phrase in sky until another arrival', frame: idle });
      const d = event(4, 104, '过渡期间又来一句'); await deliver([a, b, c, d], true); const next = await frame(page, keyFor(c)); oneVisible(next, 'new arrival'); assert.equal(next.sameNode, true); assert.equal(next.historical, true); checks.push({ name: 'another arrival preserves phrase identity and no detached duplicates', frame: next }); await context.close();
    }
    {
      const same = Array.from({ length: 6 }, (_, i) => event(10 + i, 111, `同一位观众第${i + 1}句`)); const { page, context } = await makePage(same, true);
      assert.equal(await page.locator('#lake-current .lake-message').count(), 1); assert.equal(await page.locator('#lake-history .lake-message').count(), 4);
      assert.deepEqual(await page.locator('#lake-history .lake-message-text').allTextContents(), same.slice(1, -1).reverse().map(e => e.message));
      await page.locator('[data-action="history.open"]').click(); assert.equal(await page.locator('#chat-feed .lake-history-entry').count(), 6); assert.ok((await page.locator('#chat-feed .lake-history-entry').first().textContent()).includes(same.at(-1).message));
      checks.push({ name: 'four previous phrases and full history newest-first preserve same-viewer messages individually' }); await context.close();
    }
    {
      const long = event(30, 130, '第一行[笑]\n第二行完整消息。' + '历史里保持完整内容。'.repeat(12), { emotes: [{ text: '[笑]', url: emoteUrl }] }); const { page, context, deliver } = await makePage([a, long], true);
      await page.locator('[data-action="history.open"]').click(); assert.equal(await page.locator('#chat-feed .lake-history-entry img.message-emote').count(), 1); assert.ok((await page.locator('#chat-feed .lake-history-body b').first().textContent()).includes(long.message.split('[笑]')[1]));
      await deliver([a, long, c], true); assert.equal(await page.locator('#lake-history .lake-message img.message-emote').count(), 1); await page.screenshot({ path: path.join(output, 'history-long-emote.png') }); checks.push({ name: 'full history retains multiline text and inline emote after the same message sinks' }); await context.close();
    }
    for (const mode of ['reduce', 'background']) {
      const { page, context, deliver } = await makePage([a], true, mode === 'reduce' ? 'reduce' : 'no-preference'); await page.evaluate(() => { window.__heldPhrase = document.querySelector('#lake-current .lake-message'); }); await deliver([a, b], true);
      if (mode === 'background') await page.evaluate(() => window.__listeners['resource-mode']({ payload: false })); const f = await frame(page, keyFor(a)); oneVisible(f, mode); assert.equal(f.sameNode, true); assert.equal(f.historical, true);
      if (mode === 'reduce') assert.equal(f.animations.length, 0); else { assert.ok(f.animations.length > 0); assert.ok(f.animations.every(a => a.state === 'paused')); } checks.push({ name: `${mode} preserves the phrase and correctly stops or pauses motion`, frame: f }); await context.close();
    }
    assert.deepEqual(errors, []); assert.equal(calls.some(c => !['snapshot', 'ui_activity'].includes(c)), false);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, evidence: 'Headless Edge, actual app module, test-only IPC; no native WebView2, account, real TTS or network acceptance.', checks, errors, calls }, null, 2)); console.log(`${checks.length} source Lake phrase transition browser checks passed`);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
