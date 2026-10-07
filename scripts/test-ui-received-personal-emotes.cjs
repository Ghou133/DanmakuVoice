// Actual UI and overlay bytes; normalized event fixtures and fictional IPC only.
// No account API, chat POST, audio, OBS websocket or native UI is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../crates/desktop/ui');
const overlayPath = path.resolve(root, '../overlay/overlay.html');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/received-personal-emotes/browser-final'));
const marker = '[费可装扮表情包_爱你]';
const actualUrl = 'https://i0.hdslb.com/bfs/garb/699dc00ce1374521842dc1bf13d5946fc5d5607e.png';
const missingUrl = 'https://i0.hdslb.com/bfs/garb/fictional-received-personal-missing.png';
const assets = ['app.js', 'helpers.mjs', 'index.html', 'styles.css', 'lake.css', 'lake-drawers.css', 'fonts/DanmakuVoiceSerifSC-Medium.woff2', 'fonts/DanmakuVoiceSerifSC-Bold.woff2', 'fonts/DanmakuVoiceSerifSC-Black.woff2', 'fonts/InstrumentSerif-Regular.woff2', 'fonts/InstrumentSerif-Italic.woff2'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [], trace = [], calls = [], requests = [], errors = [];
const check = name => { checks.push(name); console.log(`ok ${name}`); };
const emote = (large = false, url = actualUrl) => ({ text: marker, url, large });
const event = (number, message = marker, emotes = []) => ({ room_id: 999, observed_at_ms: Date.now() + number, platform_event_id: `fictional-personal-receive-${number}`, kind: 'danmaku', user_id: 501, user_name: '虚构观众', avatar_url: null, message, emotes, is_bilibili_emoticon: emotes.length > 0 && message === marker });
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: true, broadcast_console: false },
  setup: { room_id: 999, tts_enabled: true, mode: 'account', uid: 42 }, live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, received: 1, events: [event(1)] },
  queue: { current: null, pending: [], history: [] },
  rules: { default_preset_id: null, preferred_presets: {}, user_words: [], message_words: [], sounds: [], events: { danmaku_on: true, filter_bilibili_emoticons: true, gift_on: true, free_gift_on: false, super_chat_on: true, guard_on: true, gift_threshold_yuan: 0, super_chat_threshold_yuan: 0 }, templates: { danmaku: '{message}', gift: '{user_name}送出{gift_name}', super_chat: '{message}', guard: '{user_name}开通{guard_name}' } },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {}, account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: { room_id: 999, title: '虚构直播间', parent_area_id: 1, area_id: 10, live_status: 0 }, areas: [], busy: false },
  obs: { settings: { enabled: false }, status: { state: 'idle' } }, overlay: { settings: { enabled: true }, running: true, clients: [] },
  chat_send: { busy: false, error: null, warnings: [], account_id: 42, room_id: 999, message_limit: 40, emoticons: [] }, moderation: { busy: false, can_moderate: false, can_blacklist: false, can_manage_admins: false },
};
const pack = { source: 'account', name: '费可装扮表情包', pkg_type: 3, icon: actualUrl, emoticons: [{ emoticon_unique: 'account:fixture-package:fixture-item', emoji: marker, text: marker, url: actualUrl, kind: 'text', allowed: true }] };
let page, overlayPage, browser, server, testedAssets;
let nativeActive = true;
const snapshot = () => structuredClone(state);
const push = async () => { await page.evaluate(next => window.__richPush(next), snapshot()); await page.waitForTimeout(100); };
const close = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(100); };
async function imageSurface(locator, label, count, expectedText, expectedLiteralMarkers = 0) {
  assert.equal(await locator.locator('img.message-emote, img.emote, img.sticker').count(), count, `${label} image count`);
  await locator.locator('img').evaluateAll(nodes => Promise.all(nodes.map(img => img.complete ? Promise.resolve() : new Promise(resolve => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); }))));
  const actual = await locator.evaluate(root => ({ text: root.textContent, images: [...root.querySelectorAll('img.message-emote, img.emote, img.sticker')].map(img => ({ src: img.currentSrc || img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, alt: img.alt, title: img.getAttribute('title'), label: img.getAttribute('aria-label') })) }));
  trace.push({ label, actual });
  assert.equal(actual.images.length, count, `${label} image count`);
  assert.ok(actual.images.every(img => img.naturalWidth > 0 && img.naturalHeight > 0 && img.src === actualUrl), `${label} failed to decode the actual metadata CDN image`);
  assert.ok(actual.images.every(img => img.alt === '' && img.title === null && img.label === marker), `${label} emote names must be accessible without visible alt text or hover titles`);
  assert.equal(actual.text.split(marker).length - 1, expectedLiteralMarkers, `${label} exposes an enriched marker as visible text`);
  if (expectedText !== undefined) assert.equal(actual.text, expectedText, `${label} changed surrounding text`);
}
async function draftUnchanged(label) {
  assert.equal(await page.locator('#chat-message').inputValue(), '这份草稿保留');
  assert.deepEqual(await page.locator('#chat-message').evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 5], `${label} changed composer selection`);
}
async function activity(value) {
  nativeActive = value;
  await page.evaluate(next => window.__richListeners['resource-mode']({ payload: next }), value);
  await page.waitForTimeout(100);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const sources = new Map();
  for (const file of assets) sources.set(file, await fs.readFile(path.join(root, file)));
  sources.set('../overlay/overlay.html', await fs.readFile(overlayPath));
  testedAssets = Object.fromEntries([...sources].map(([file, bytes]) => [file, hash(bytes)]));
  server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/overlay-test') {
        const source = sources.get('../overlay/overlay.html').toString().replace('</script>', '\n// Response-only fixture hooks.\nwindow.__richReceive = receive; window.__richConfig = applyConfig; window.__richReady = () => ov.classList.add("ready");\n</script>');
        return response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(source);
      }
      const relative = pathname.startsWith('/overlay/fonts/') ? 'fonts/' + path.basename(pathname) : pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
      const target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
      let source = sources.get(relative) || await fs.readFile(target);
      if (relative === 'app.js') source = source.toString() + '\n// Response-only fixture hooks.\nwindow.__richPush = acceptSnapshot; window.__richStop = () => {clearTimeout(snapshotTimer);boot.polling=false;}; window.__richSettings = openSettings; window.__richQueue = () => { document.querySelector("#queue-panel").hidden = false; renderQueuePanel(normalizedEvents(snapshot)); };';
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(source);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'no-preference' });
    await context.route('**/*', route => {
      const request = route.request(), url = request.url();
      if (url.startsWith(origin + '/')) return route.continue();
      requests.push({ url, method: request.method() });
      if (url === actualUrl && request.method() === 'GET') return route.continue();
      if (url === missingUrl && request.method() === 'GET') return route.fulfill({ status: 404, body: '' });
      return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__richInvoke', async (command, args) => {
      if (command === 'ui_activity') return nativeActive;
      if (command === 'snapshot') return snapshot();
      assert.equal(command, 'dispatch'); calls.push(structuredClone(args));
      if (args.action === 'bili.chat.emoticons.refresh') state.chat_send.emoticons = [pack];
      else if (args.action === 'rules.save') { state.rules = structuredClone(args.payload.rules); state.config_revision++; }
      else if (args.action === 'preferences.save') { Object.assign(state.preferences, args.payload.preferences); state.config_revision++; }
      else throw new Error(`Unexpected fixture action ${args.action}`);
      return snapshot();
    });
    await page.addInitScript(() => {
      window.__richListeners = {};
      window.__DANMAKUVOICE_STARTUP_THEME__ = { session: 'fictional-received-personal-emotes', appearance: 'dark', language: 'zh-CN' };
      window.__TAURI__ = { core: { invoke: (command, args) => window.__richInvoke(command, args) }, event: { listen: async (name, listener) => { window.__richListeners[name] = listener; return () => {}; } } };
    });
    await page.goto(origin); await page.locator('#lake-current .lake-message').waitFor(); await page.evaluate(() => window.__richStop());
    // The old wire condition contains a plain marker and no image metadata.
    assert.equal(await page.locator('#lake-current img.message-emote').count(), 0);
    assert.equal(await page.locator('#lake-current .lake-message-text').textContent(), marker);
    await page.screenshot({ path: path.join(output, 'raw-marker-without-enrichment.png') });
    check('without backend emote metadata the literal received marker remains text; the UI does not guess from brackets');

    state.live.events.push(event(2, marker, [emote()])); await push();
    await imageSurface(page.locator('#lake-current .lake-message-text'), 'pure lake current', 1, '');
    state.live.events.push(event(3, `早安${marker}，还有[待办]`, [emote()])); await push();
    await imageSurface(page.locator('#lake-current .lake-message-text'), 'mixed lake current', 1, '早安，还有[待办]');
    assert.equal(await page.locator('#lake-current .lake-letter').count(), [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment('早安，还有[待办]')].length + 1);
    check('trusted enriched pure and mixed personal emotes become images, preserving ordinary bracket text and letter staggering');

    await page.locator('[data-action="history.open"]').click();
    await imageSurface(page.locator('#chat-feed'), 'full history', 2, undefined, 1);
    await page.screenshot({ path: path.join(output, 'history-enriched-personal.png') }); await close();
    const firstImageHistory = page.locator('#lake-history .lake-message-text').filter({ has: page.locator('img.message-emote') });
    await imageSurface(firstImageHistory, 'sunk lake history', 1, '');
    check('sunk lake history and the full history drawer both consume the same normalized emotes');

    await page.locator('#chat-message').fill('这份草稿保留'); await page.locator('#chat-message').evaluate(input => input.setSelectionRange(2, 5));
    await page.locator('#lake-current .lake-message-name').click();
    await imageSurface(page.locator('#viewer-drawer .viewer-said'), 'viewer recent messages', 2, undefined, 1);
    await page.screenshot({ path: path.join(output, 'viewer-enriched-personal.png') });
    check('the viewer card uses images for received personal emotes rather than showing their marker names');
    await close(); await draftUnchanged('viewer card');

    // Late enrichment must retain the existing article and static presentation.
    await page.locator('#lake-history .lake-message').filter({ hasText: marker }).evaluate(node => { window.__lateArticle = node; });
    state.live.events[0].emotes = [emote()]; state.live.events[0].is_bilibili_emoticon = true; await push();
    assert.equal(await page.evaluate(() => document.querySelector('#lake-history').contains(window.__lateArticle)), true);
    await imageSurface(page.locator('#lake-history .lake-message-text').last(), 'late enriched sunk row', 1, '');
    await page.locator('#lake-current .lake-message').evaluate(node => { window.__lateCurrent = node; });
    const bareCurrent = event(4); state.live.events.push(bareCurrent); await push();
    await page.locator('#lake-current .lake-message').evaluate(node => { window.__lateCurrent = node; window.__lateBody = node.querySelector('.lake-message-text'); window.__lateIdentity = node.querySelector('.lake-message-name'); window.__lateIdentity.focus(); });
    await page.waitForTimeout(100); state.live.events.at(-1).emotes = [emote()]; state.live.events.at(-1).is_bilibili_emoticon = true; await push();
    assert.equal(await page.evaluate(() => document.querySelector('#lake-current .lake-message') === window.__lateCurrent), true);
    assert.equal(await page.evaluate(() => document.querySelector('#lake-current .lake-message-text') === window.__lateBody && document.activeElement === window.__lateIdentity), true, 'late enrichment lost the body container or focused identity button');
    await imageSurface(page.locator('#lake-current .lake-message-text'), 'late enriched current', 1, '');
    assert.equal(await page.locator('#lake-current .lake-letter').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none')), true, 'late enrichment replayed already displayed lyrics');
    check('late same-ID enrichment replaces marker text with images in place while keeping already displayed current letters static');

    await page.locator('[data-action="history.open"]').click(); await imageSurface(page.locator('#chat-feed'), 'retroactive full history', 4); await close();
    await page.locator('#lake-current .lake-message-name').click(); await page.locator('#viewer-alias').fill('保留的未提交读作');
    state.live.events.push(event(5, `更新${marker}`, [emote()])); await push();
    assert.equal(await page.locator('#viewer-alias').inputValue(), '保留的未提交读作');
    await imageSurface(page.locator('#viewer-drawer .viewer-said'), 'viewer refreshed recent messages', 3);
    await page.waitForTimeout(1350);
    await page.screenshot({ path: path.join(output, 'viewer-personal-final.png') });
    await page.locator('#viewer-alias').fill(''); await close(); await draftUnchanged('enrichment updates');
    check('incoming enriched messages refresh viewer history without replacing its alias field or composer draft and selection');

    await page.evaluate(() => window.__richSettings('rules'));
    const filter = page.locator('#settings [name="filter_bilibili_emoticons"]');
    assert.equal(await filter.isChecked(), true); await filter.uncheck(); await page.waitForTimeout(250); await close();
    assert.equal(state.rules.events.filter_bilibili_emoticons, false); await imageSurface(page.locator('#lake-current .lake-message-text'), 'filter off still renders images', 1, '更新');
    await page.evaluate(() => window.__richSettings('rules')); await filter.check(); await page.waitForTimeout(250); await close();
    assert.equal(state.rules.events.filter_bilibili_emoticons, true); await imageSurface(page.locator('#lake-current .lake-message-text'), 'filter on still renders images', 1, '更新'); await draftUnchanged('filter toggle');
    check('the saved speech-filter checkbox toggles its real rule without hiding images or altering message drafts');

    state.preferences.appearance = 'light'; state.config_revision++; await push();
    await page.screenshot({ path: path.join(output, 'received-personal-day.png') });
    state.preferences.appearance = 'dark'; state.config_revision++; await push();
    await page.screenshot({ path: path.join(output, 'received-personal-night.png') });
    check('personal received images remain decoded in day and night without changing text or font assets');

    const unknown = event(6, '[普通方括号] <img src=x onerror=alert(1)>', [{ text: '[普通方括号]', url: 'javascript:alert(1)', large: false }]);
    state.live.events.push(unknown); await push();
    assert.equal(await page.locator('#lake-current img.message-emote').count(), 0);
    assert.equal(await page.locator('#lake-current .lake-message-text').textContent(), unknown.message);
    assert.equal(await page.locator('#lake-current img[src="x"]').count(), 0);
    check('unknown brackets and unsafe image metadata stay escaped ordinary text rather than invented emotes');

    state.live.events.push(event(7, marker, [emote(false, missingUrl)])); await push();
    await page.waitForFunction(() => document.querySelector('#lake-current .emote-unavailable'));
    const fallback = page.locator('#lake-current .emote-unavailable');
    assert.equal(await fallback.textContent(), ''); assert.equal(await fallback.getAttribute('aria-label'), marker); assert.equal(await fallback.locator('svg').count(), 1);
    check('failed received images use a graphic fallback with accessible names and no visible marker');

    await activity(false);
    state.live.events.push(event(8)); await push();
    state.live.events.at(-1).emotes = [emote()]; await push();
    await imageSurface(page.locator('#lake-current .lake-message-text'), 'background late-enriched current', 1, '');
    const letterAnimation = () => page.locator('#lake-current .lake-letter').evaluateAll(nodes => nodes.map(node => ({ name: getComputedStyle(node).animationName, state: getComputedStyle(node).animationPlayState })));
    assert.ok((await letterAnimation()).every(item => /^lake-letter-[ab]$/.test(item.name) && item.state === 'paused'));
    await activity(true);
    assert.ok((await letterAnimation()).every(item => /^lake-letter-[ab]$/.test(item.name) && item.state === 'running'));
    await page.reload(); await page.locator('#lake-current img.message-emote').waitFor(); await page.evaluate(() => window.__richStop());
    await imageSurface(page.locator('#lake-current .lake-message-text'), 'first-displayed enriched current restored', 1, '');
    assert.ok((await letterAnimation()).every(item => item.name === 'none'));
    check('an unseen background raw phrase enriched in place animates on its first foreground display, then reloads statically');

    const trustedQueueEvent = structuredClone(state.live.events[2]);
    const spokenText = '已经过滤表情后的正常朗读正文';
    state.queue.pending = [{ id: 991, origin: 'live', user_name: trustedQueueEvent.user_name, text: spokenText, event: trustedQueueEvent }, { id: 992, origin: 'live', user_name: trustedQueueEvent.user_name, text: spokenText, event: null }];
    await push(); await page.evaluate(() => window.__richQueue());
    await imageSurface(page.locator('#queue-panel [data-id="991"] .queue-line'), 'queue with exact backend event', 1, '早安，还有[待办]');
    assert.equal(await page.locator('#queue-panel [data-id="992"] .queue-line').textContent(), spokenText);
    assert.equal(await page.locator('#queue-panel [data-id="992"] img').count(), 0);
    assert.equal(state.queue.pending[0].text, spokenText); assert.equal(state.queue.pending[1].text, spokenText);
    state.queue.pending[0].event = { ...trustedQueueEvent, message: marker, emotes: [emote()] }; await push();
    await imageSurface(page.locator('#queue-panel [data-id="991"] .queue-line'), 'queue body after trusted event metadata update', 1, '');
    await close(); state.queue.pending = []; await push();
    check('queue images use only the exact backend job event; same-name legacy jobs neither borrow images nor change their speech text');

    overlayPage = await context.newPage(); overlayPage.on('pageerror', error => errors.push(error.message)); await overlayPage.goto(origin + '/overlay-test');
    await overlayPage.evaluate(() => { window.__richConfig({ theme: 'lake-night', show_header: true, linger_seconds: 60, merge: false }); window.__richReady(); });
    const overlayItem = (seq, message, emotes, sticker = false) => ({ seq, at: Date.now(), kind: 'danmaku', viewer: '虚构观众', uid: 501, message, emotes, sticker, job_id: null });
    await overlayPage.evaluate(item => window.__richReceive(item), overlayItem(1, `直播${marker}普通[待办]`, [emote()]));
    await overlayPage.locator('.item .lit img.emote').waitFor();
    await imageSurface(overlayPage.locator('.item .lit').first(), 'overlay mixed received body', 1, '直播普通[待办]');
    await overlayPage.evaluate(item => window.__richReceive(item), overlayItem(2, marker, [emote(true)], true));
    await overlayPage.locator('.item .lit img.sticker').waitFor();
    await imageSurface(overlayPage.locator('.item .lit').first(), 'overlay standalone sticker', 1, '');
    await overlayPage.waitForTimeout(1500);
    await overlayPage.screenshot({ path: path.join(output, 'overlay-personal-pure-mixed.png'), omitBackground: true });
    check('the actual OBS overlay page consumes the same backend emotes for mixed text and standalone images');
    await overlayPage.evaluate(item => window.__richReceive(item), overlayItem(3, marker, [emote(false, missingUrl)]));
    await overlayPage.waitForFunction(() => document.querySelector('.emote-unavailable'));
    const overlayFallback = overlayPage.locator('.emote-unavailable');
    assert.equal(await overlayFallback.textContent(), ''); assert.equal(await overlayFallback.getAttribute('aria-label'), marker); assert.equal(await overlayFallback.locator('svg').count(), 1);
    check('OBS missing images also use graphic-only fallbacks without exposing marker names');

    const longerMarker = marker + '加长';
    const overlapping = [{ text: marker, url: missingUrl, large: false }, { text: longerMarker, url: actualUrl, large: false }];
    const overlapEvent = event(9, longerMarker, overlapping); state.live.events.push(overlapEvent); await push();
    const mainLongest = await page.locator('#lake-current .lake-message-text').evaluate(root => ({ text: root.textContent, labels: [...root.querySelectorAll('img')].map(img => img.getAttribute('aria-label')), sources: [...root.querySelectorAll('img')].map(img => img.src) }));
    assert.deepEqual(mainLongest, { text: '', labels: [longerMarker], sources: [actualUrl] });
    await overlayPage.evaluate(item => window.__richReceive(item), overlayItem(4, longerMarker, overlapping));
    await overlayPage.waitForFunction(label => document.querySelector('.item:first-child img[aria-label]')?.getAttribute('aria-label') === label, longerMarker);
    const overlayLongest = await overlayPage.locator('.item .lit').first().evaluate(root => ({ text: root.textContent, labels: [...root.querySelectorAll('img')].map(img => img.getAttribute('aria-label')), sources: [...root.querySelectorAll('img')].map(img => img.src) }));
    assert.deepEqual(overlayLongest, mainLongest);
    check('main and overlay both choose the longest exact trusted marker without leaving suffix text or borrowing the shorter image');

    assert.deepEqual(errors, [], 'browser JavaScript errors');
    assert.ok(requests.every(request => request.method === 'GET' && [actualUrl, missingUrl].includes(request.url)), 'unexpected external request');
    assert.ok(calls.every(call => ['bili.chat.emoticons.refresh', 'rules.save', 'preferences.save'].includes(call.action)), 'a fixture attempted chat/OBS/audio operations');
    for (const [file, digest] of Object.entries(testedAssets)) assert.equal(hash(await fs.readFile(path.resolve(root, file))), digest, `production asset changed during acceptance: ${file}`);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, checked_at: new Date().toISOString(), evidence: 'headless actual main and overlay UI; fictional normalized events and IPC; only credential-free GET of the exact pre-existing metadata CDN image; no account/chat/OBS/audio acceptance; engine speech filtering validated separately', metadata_source: 'target/chat-package-protocol/owned-rust-metadata.json', marker, actual_url: actualUrl, tested_assets_sha256: testedAssets, checks, trace, requests, calls, errors }, null, 2));
    console.log(`${checks.length} received personal emote checks passed`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, checked_at: new Date().toISOString(), tested_assets_sha256: testedAssets, checks, trace, requests, calls, errors, error: error.stack }, null, 2));
    throw error;
  } finally { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
