// Fictional IPC fixtures only. Headless Edge; no real Bilibili account or chat writes.
// External traffic is blocked. Explicit fictional cover URLs use local logo pixels.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/chat-send-ui-tests'));
const checks = [];
const calls = [];
const check = name => { checks.push(name); console.log(`ok ${name}`); };
const auditedAssets = ['app.js', 'helpers.mjs', 'index.html', 'styles.css', 'lake.css', 'lake-drawers.css', 'fonts/DanmakuVoiceSerifSC-Medium.woff2', 'fonts/DanmakuVoiceSerifSC-Bold.woff2', 'fonts/DanmakuVoiceSerifSC-Black.woff2', 'fonts/InstrumentSerif-Regular.woff2', 'fonts/InstrumentSerif-Italic.woff2'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(auditedAssets.map(async relative => [relative, createHash('sha256').update(await fs.readFile(path.join(root, relative))).digest('hex')])));
const packs = [
  { name: '常规 B站表情', source: 'live', pkg_type: 3, icon: null, emoticons: [
    { emoticon_unique: 'fixture_live_text_laugh', emoji: '笑哭', url: '', allowed: true, kind: 'text', text: '[笑哭]', description: '' },
    { emoticon_unique: 'fixture_live_text_support', emoji: '支持', url: '', allowed: true, kind: 'text', text: '[支持]', description: '' },
  ] },
  { name: '直播表情 · 虚构包', source: 'live', pkg_type: 1, icon: 'https://i0.hdslb.com/bfs/live/fictional-pack-cover-only.png', emoticons: [
    { emoticon_unique: 'fixture_live_smile', emoji: '虚构微笑', url: 'https://i0.hdslb.com/bfs/live/fictional-emote-only.png', allowed: true, kind: 'emoticon', text: '', description: '' },
    { emoticon_unique: 'fixture_locked', emoji: '未解锁表情', url: '', allowed: false, kind: 'emoticon', text: '', description: '虚构解锁条件' },
    { emoticon_unique: 'fixture_escaped', emoji: '<script>虚构表情 & 名称</script>', url: 'javascript:window.__badEmoji=true', allowed: true, kind: 'emoticon', text: '', description: '' },
  ] },
];
const fivePacks = Array.from({ length: 5 }, (_, pack) => ({
  name: `第二账号表情包 ${5 - pack}`,
  source: 'live',
  pkg_type: 1,
  icon: pack % 2 === 0 ? `https://i0.hdslb.com/bfs/live/fictional-package-${pack}.png` : null,
  emoticons: Array.from({ length: pack === 4 ? 55 : pack + 1 }, (_, item) => ({
    emoticon_unique: `account72_pack${pack}_item${item}`, emoji: `第二账号 ${pack}:${item}`,
    url: '', allowed: item % 4 !== 0, kind: 'emoticon', text: '', description: item % 4 === 0 ? '真实夹具锁定说明' : '',
  })),
}));
const accountPackages = new Map([[71, packs], [72, fivePacks], [73, []], [74, [fivePacks[0]]]]);
const ownedPack = {
  name: '实际购买包 · 虚构夹具', source: 'account', pkg_type: 2,
  icon: 'https://i0.hdslb.com/bfs/emote/fictional-owned-cover.png',
  emoticons: Array.from({ length: 20 }, (_, index) => ({
    emoticon_unique: `account:fixture-package:${index}`, emoji: index === 0 ? '花花' : `收藏表情 ${index}`,
    text: index === 0 ? '[实际购买包_花花]' : `[实际购买包_收藏表情${index}]`,
    url: `https://i0.hdslb.com/bfs/emote/fictional-owned-${index}.png`, allowed: true, kind: 'text', description: '',
  })),
};
accountPackages.set(75, [ownedPack, packs[1]]);
accountPackages.set(76, [packs[1]]);
const accountWarnings = new Map([[76, ['个人表情读取失败：虚构权限响应 [DV-B04]']]]);
const viewer = { room_id: 999, platform_event_id: 'fictional-received-message', observed_at_ms: Date.now(), kind: 'danmaku', user_id: 501, user_name: '虚构观众', message: '仅用于本地回归的已接收弹幕', avatar_url: null };
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: false },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, events: [viewer] },
  queue: { current: null, pending: [], history: [] },
  rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: {}, qr: { status: 'idle' }, status: {},
  broadcast: { room: { room_id: 999, title: '虚构直播间', parent_area_id: 2, area_id: 86, live_status: 0 }, areas: [], busy: false },
  obs: { settings: { enabled: false, auto_launch: false }, status: { state: 'idle' } },
  overlay: { settings: { enabled: true }, running: true },
  chat_send: { busy: false, error: null, warnings: [], account_id: null, room_id: null, message_limit: 20, emoticons: [] },
  moderation: { busy: false, user_id: null, room_id: null, can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null, message: null },
};
const writes = () => calls.filter(call => /^bili\.chat\.(send|emoticon\.send)$/.test(call.action));
const reads = () => calls.filter(call => call.action === 'bili.chat.emoticons.refresh');
const until = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fictional IPC state');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
let failSend = false;
let failRead = false;
let deferred = null;

(async () => {
  await fs.mkdir(output, { recursive: true });
  const testedAssets = await sourceHashes();
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
      let source = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
      if (pathname === '/app.js') source = source.toString() + `
        window.__chatPush = next => acceptSnapshot(next);
        window.__chatAttemptSend = sendChatMessage;
        window.__chatFixtureBusy = () => chatSendBusy;
        window.__chatFixtureBroadcast = () => snapshot.preferences?.broadcast_console;
        window.__chatFixtureIdentity = () => ({ account: snapshot.account?.user_id, room: snapshot.setup?.room_id });`;
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(source);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', executablePath: process.env.DV_BROWSER_PATH || undefined, headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion: 'reduce' });
    const coverPixels = await fs.readFile(path.join(root, 'logo.png'));
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/')) return route.continue();
      if (url === 'https://i0.hdslb.com/bfs/live/fictional-received-emote-only.png') return route.fulfill({ contentType: 'image/png', body: coverPixels });
      if (url === 'https://i0.hdslb.com/bfs/live/fictional-received-emote-missing.png') return route.fulfill({ status: 404, body: '' });
      if (/^https:\/\/i0\.hdslb\.com\/bfs\/live\/(?:fictional-pack-cover-only|fictional-package-\d+)\.png$/.test(url)) return route.fulfill({ contentType: 'image/png', body: coverPixels });
      if (/^https:\/\/i0\.hdslb\.com\/bfs\/emote\/fictional-owned-(?:cover|\d+)\.png$/.test(url)) return route.fulfill({ contentType: 'image/png', body: coverPixels });
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__chatInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch');
      const { action, payload } = args;
      calls.push(structuredClone({ action, payload }));
      if (action.startsWith('bili.chat.')) {
        assert.ok(state.account.user_id, 'chat dispatch requires a QR account');
        assert.equal(state.network_disabled, false, 'offline mode cannot dispatch chat');
        if (deferred?.action === action) {
          const pending = deferred;
          pending.started = true;
          return new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
        }
      }
      if (action === 'bili.chat.emoticons.refresh') {
        assert.deepEqual(payload, {});
        state.chat_send.account_id = state.account.user_id;
        if (failRead) {
          state.chat_send.error = '虚构表情读取失败 [DV-B04]';
          throw new Error(state.chat_send.error);
        }
        state.chat_send.emoticons = structuredClone(accountPackages.get(state.account.user_id) || packs);
        state.chat_send.warnings = structuredClone(accountWarnings.get(state.account.user_id) || []);
        state.chat_send.error = null;
        state.chat_send.room_id = state.broadcast.room.room_id;
        state.chat_send.message_limit = 40;
      } else if (action === 'bili.chat.send') {
        assert.deepEqual(Object.keys(payload).sort(), ['confirmed', 'message']);
        assert.equal(payload.confirmed, true);
        assert.equal(typeof payload.message, 'string');
        assert.equal(payload.message, payload.message.trim());
        assert.ok(payload.message.length > 0 && payload.message.length <= state.chat_send.message_limit);
        if (failSend) throw new Error('虚构弹幕发送失败 [DV-B04]');
        state.chat_send.error = null;
      } else if (action === 'bili.chat.emoticon.send') {
        assert.deepEqual(Object.keys(payload).sort(), ['confirmed', 'emoticon_unique']);
        assert.equal(payload.confirmed, true);
        const item = state.chat_send.emoticons.flatMap(pack => pack.emoticons).find(item => item.emoticon_unique === payload.emoticon_unique);
        assert.ok(item && ['emoticon', 'text'].includes(item.kind));
        assert.equal(item?.allowed, true);
        if (failSend) throw new Error('虚构表情发送失败 [DV-B04]');
        state.chat_send.error = null;
      } else if (action === 'bili.broadcast.refresh') {
        assert.equal(state.preferences.broadcast_console, true);
      } else if (action === 'bili.moderation.refresh') {
        state.moderation = { ...state.moderation, user_id: payload.user_id, room_id: state.setup.room_id };
      } else if (!['bili.qr.cancel', 'doubao.qr.cancel'].includes(action)) {
        throw new Error(`Unexpected fictional action ${action}`);
      }
      return structuredClone(state);
    });
    await page.addInitScript(() => {
      window.__TAURI__ = { core: { invoke: (command, args) => window.__chatInvoke(command, args) }, event: { listen: async () => () => {} } };
    });
    const push = (next = state) => page.evaluate(value => window.__chatPush(value), structuredClone(next));
    const compose = page.locator('#chat-compose');
    const input = compose.locator('#chat-message');
    const form = compose.locator('form[data-form="chat-send"]');
    const send = compose.locator('button[type="submit"]');
    const emoji = compose.locator('[data-action="chat.emoticons"]');
    const picker = page.locator('#chat-emoticon-picker');
    const tabNames = () => picker.getByRole('tab').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    const assertImageOnlyPicker = async () => {
      const visibleText = await picker.evaluate(root => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), texts = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || node.parentElement.closest('.sr-only')) continue;
          const style = getComputedStyle(node.parentElement);
          if (style.display !== 'none' && style.visibility !== 'hidden') texts.push(node.textContent.trim());
        }
        return texts;
      });
      assert.deepEqual(visibleText, [], 'the picker has no visible package, item, status, count or navigation text');
      assert.equal(await picker.locator('[title], select, [data-action="chat.emoticon.page"], .lake-emote-pages').count(), 0, 'text tooltips and pagination are absent');
      const controls = await picker.locator('[role="tab"], .lake-emote-sticker').evaluateAll(nodes => nodes.map(node => ({
        accessible: !!node.getAttribute('aria-label'),
        graphic: [...node.children].some(child => ['IMG', 'svg'].includes(child.tagName)),
        text: [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()),
      })));
      assert.ok(controls.every(control => control.accessible && control.graphic && !control.text), JSON.stringify(controls));
    };
    const ready = () => page.waitForFunction(() => {
      const node = document.querySelector('#chat-message');
      return node && !node.disabled;
    });
    const openPicker = async () => {
      if (!(await picker.isVisible())) await emoji.click();
      await picker.waitFor();
      await ready();
      await picker.getByRole('tab').nth(0).click();
      await picker.locator('[data-action="chat.emoticon.send"]').first().waitFor();
    };
    const togglePicker = async () => {
      if (await picker.isVisible()) await page.keyboard.press('Escape');
      else await emoji.click();
    };
    const assertDisabled = async pattern => {
      assert.equal(await input.isDisabled(), true);
      assert.equal(await send.isDisabled(), true);
      assert.equal(await emoji.isDisabled(), true);
      assert.match(await input.getAttribute('title'), pattern);
    };

    await page.goto(origin);
    await page.locator('#lake-transcript').waitFor();
    assert.equal(await compose.isVisible(), true);
    assert.equal(await input.isDisabled(), true);
    assert.equal(reads().length, 0);
    assert.equal(writes().length, 0);
    check('the logged-out composer remains visible with disabled controls and performs no chat API reads or writes');

    assert.equal(state.overlay.settings.enabled, true);
    await page.evaluate(() => window.__chatAttemptSend());
    assert.equal(await input.isDisabled(), true);
    assert.equal(writes().length, 0);
    await page.locator('#lake-current .lake-avatar-button').click();
    await page.locator('#viewer-drawer #viewer-alias').waitFor();
    assert.equal(await page.locator('#viewer-moderation').isHidden(), true);
    assert.equal(calls.some(call => call.action === 'bili.moderation.refresh'), false);
    await page.keyboard.press('Escape');
    check('an active OBS overlay does not bypass chat authentication or enable avatar moderation');

    const receivedImage = { ...viewer, platform_event_id: 'fictional-received-emote-image', observed_at_ms: viewer.observed_at_ms + 1, message: '[虚构图片表情]', emotes: [{ text: '[虚构图片表情]', url: 'https://i0.hdslb.com/bfs/live/fictional-received-emote-only.png', large: true }] };
    const missingImage = { ...viewer, platform_event_id: 'fictional-received-emote-missing', observed_at_ms: viewer.observed_at_ms + 2, message: '[虚构缺失表情]', emotes: [{ text: '[虚构缺失表情]', url: 'https://i0.hdslb.com/bfs/live/fictional-received-emote-missing.png', large: true }] };
    state.live.events = [viewer, receivedImage];
    await push();
    const currentImage = page.locator('#lake-current img.message-emote');
    await currentImage.waitFor();
    await page.waitForFunction(() => document.querySelector('#lake-current img.message-emote')?.naturalWidth > 0);
    assert.equal(await currentImage.getAttribute('alt'), '');
    assert.equal(await currentImage.getAttribute('aria-label'), '[虚构图片表情]');
    assert.equal(await currentImage.getAttribute('title'), null);
    await currentImage.hover();
    assert.doesNotMatch(await page.locator('#lake-current').textContent(), /\[虚构图片表情\]/);
    check('a received featured emote renders decoded pixels with an accessible original name and no visible name or hover title');

    state.live.events = [viewer, receivedImage, missingImage];
    await push();
    const missingGraphic = page.locator('#lake-current .message-emote.emote-unavailable');
    await missingGraphic.waitFor();
    assert.equal(await missingGraphic.getAttribute('role'), 'img');
    assert.equal(await missingGraphic.getAttribute('aria-label'), '[虚构缺失表情]');
    assert.equal(await missingGraphic.getAttribute('title'), null);
    assert.equal(await missingGraphic.textContent(), '');
    assert.equal(await missingGraphic.locator('svg').count(), 1);
    const missingBox = await missingGraphic.boundingBox();
    assert.ok(missingBox.width > 0 && missingBox.height > 0, JSON.stringify(missingBox));
    assert.doesNotMatch(await page.locator('#lake-current, #lake-history').allTextContents().then(items => items.join('')), /\[虚构(?:图片|缺失)表情\]/);
    assert.equal(await page.locator('#lake-history img.message-emote[title]').count(), 0);
    check('a failed received image becomes a visible graphic fallback with the same accessible name and no marker text, including the sunk history');

    await page.locator('.lake-history-open').click();
    await page.locator('#lake-history-dialog').waitFor();
    const historyImages = page.locator('#chat-feed .message-emote');
    await page.locator('#chat-feed .emote-unavailable').waitFor();
    assert.equal(await historyImages.count(), 2);
    assert.equal(await historyImages.locator('[title]').count(), 0);
    const imageStates = await historyImages.evaluateAll(nodes => nodes.map(node => ({
      name: node.getAttribute('aria-label'), title: node.getAttribute('title'), alt: node.getAttribute('alt'),
      text: node.textContent, graphic: node.tagName === 'IMG' || !!node.querySelector('svg'),
    })));
    assert.ok(imageStates.every(item => item.name && item.title === null && (item.alt === null || item.alt === '') && item.text === '' && item.graphic), JSON.stringify(imageStates));
    assert.doesNotMatch(await page.locator('#chat-feed').textContent(), /\[虚构(?:图片|缺失)表情\]/);
    await page.screenshot({ path: path.join(output, 'received-emote-images-and-fallback.png') });
    check('the complete transcript preserves normal and missing received emotes as accessible images without textual names or tooltips');
    await page.keyboard.press('Escape');
    state.live.events = [viewer];
    await push();

    state.account = { user_id: 42, name: '虚构主播' };
    await push();
    await compose.waitFor();
    await ready();
    await until(() => reads().length === 1);
    assert.equal(await input.getAttribute('maxlength'), '40');
    assert.equal(await input.getAttribute('placeholder'), '说点什么…');
    assert.equal(await emoji.getAttribute('aria-label'), '表情包');
    assert.equal(await send.getAttribute('aria-label'), '发送');
    assert.equal(reads().length, 1);
    assert.equal(writes().length, 0);
    assert.equal(await picker.isHidden(), true);
    assert.equal(state.preferences.broadcast_console, false);
    check('a logged-in account reads metadata and enables chat with broadcast mode off, applying the real message limit without sending or opening the picker');

    state.preferences.broadcast_console = true;
    await push();
    await ready();
    assert.equal(reads().length, 1);
    assert.equal(await page.locator('#masthead-name').textContent(), '虚构主播');
    assert.equal(await page.locator('#masthead-suffix').textContent(), '的直播间');
    assert.doesNotMatch(await page.locator('#lake-current').textContent(), /tonight[’']s title/i);
    assert.equal(await page.locator('#lake-current .lake-state-title').textContent(), state.broadcast.room.title);
    state.live.audience = { active: true, loading: false, live_status: 1, rank_count_text: '0', users: [] };
    await push();
    assert.equal(await page.locator('#audience-count').isHidden(), true);
    state.live.audience.rank_count_text = '2';
    state.broadcast.room.live_status = 1;
    await push();
    assert.equal(await page.locator('#audience-count').isVisible(), true);
    assert.match(await page.locator('#audience-count').textContent(), /2\s*人在看/);
    state.live.audience.rank_count_text = '0';
    await push();
    assert.equal(await page.locator('#audience-count').isHidden(), true);
    assert.match(await page.locator('#lake-daypart').textContent(), /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+night$/);
    check('the masthead keeps account name plus room suffix, preparation omits the title label, zero viewers hide the full entry and positive counts remain available');
    state.preferences.broadcast_console = false;
    state.broadcast.room.live_status = 0;
    await push();
    await ready();
    assert.equal(reads().length, 1);
    check('broadcast mode toggles do not clear chat ownership or refetch valid metadata');

    await push();
    await push();
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(100);
    assert.equal(reads().length, 1);
    check('loaded metadata is reused across polling and window focus changes');

    assert.equal(await send.isDisabled(), true);
    await form.evaluate(node => node.requestSubmit());
    await page.waitForTimeout(80);
    assert.equal(writes().length, 0);
    assert.match(await page.locator('#toast').textContent(), /请输入弹幕内容/);
    check('an empty submission is rejected without a chat write');

    await input.fill('  虚构测试消息  ');
    await send.click();
    await ready();
    await until(() => writes().length === 1);
    assert.deepEqual(writes()[0], { action: 'bili.chat.send', payload: { message: '虚构测试消息', confirmed: true } });
    assert.equal(await input.inputValue(), '');
    // A one-message transcript has no history drawer entry point. Its visible
    // current phrase, not a lazily retained hidden list, proves no fake echo.
    assert.equal(await page.locator('#lake-current .lake-message').count(), 1);
    assert.equal(await page.locator('#lake-history .lake-message').count(), 0);
    assert.doesNotMatch(await page.locator('#lake-current').textContent(), /虚构测试消息/);
    check('a successful explicit submission sends one trimmed message, clears its draft and does not fabricate a received chat row');

    await input.fill('Enter 虚构消息');
    await input.press('Enter');
    await ready();
    await until(() => writes().length === 2);
    assert.equal(writes().at(-1).payload.message, 'Enter 虚构消息');
    check('Enter submits the ordinary message once');

    await input.fill('正在输入中文');
    const beforeIme = writes().length;
    await input.dispatchEvent('compositionstart', { data: '中文' });
    await form.evaluate(node => node.requestSubmit());
    await page.waitForTimeout(50);
    assert.equal(writes().length, beforeIme);
    assert.equal(await input.inputValue(), '正在输入中文');
    await input.dispatchEvent('compositionend', { data: '中文' });
    await send.click();
    await ready();
    assert.equal(writes().length, beforeIme + 1);
    check('IME composition cannot trigger a message write, while an explicit submission after composition succeeds');

    await input.fill('失败时保留的草稿');
    failSend = true;
    const beforeFailure = writes().length;
    await send.click();
    await ready();
    assert.equal(writes().length, beforeFailure + 1);
    assert.equal(await input.inputValue(), '失败时保留的草稿');
    assert.match(await page.locator('#toast').textContent(), /虚构弹幕发送失败/);
    await push();
    await push();
    await page.waitForTimeout(100);
    assert.equal(writes().length, beforeFailure + 1);
    assert.equal(await input.inputValue(), '失败时保留的草稿');
    failSend = false;
    await send.click();
    await ready();
    assert.equal(writes().length, beforeFailure + 2);
    assert.equal(await input.inputValue(), '');
    check('a failed send keeps the draft and never retries from polling; a deliberate retry sends exactly once');

    deferred = { action: 'bili.chat.send' };
    await input.fill('虚构等待中的消息');
    await send.click();
    await until(() => deferred.started);
    assert.equal(await input.isDisabled(), true);
    assert.equal(await send.isDisabled(), true);
    const pendingWrites = writes().length;
    await form.evaluate(node => node.requestSubmit());
    await push();
    assert.equal(writes().length, pendingWrites);
    assert.equal(await input.inputValue(), '虚构等待中的消息');
    deferred.resolve(structuredClone(state));
    deferred = null;
    await ready();
    assert.equal(await input.inputValue(), '');
    check('an in-flight send disables the composer, preserves its draft during polling and rejects duplicate submissions');

    await input.fill('常规表情测试');
    const beforePickerWrites = writes().length;
    await openPicker();
    assert.equal(reads().length, 2);
    assert.equal(writes().length, beforePickerWrites);
    assert.equal(await input.inputValue(), '常规表情测试');
    assert.equal(await picker.getByRole('tab').count(), 2);
    assert.equal(await picker.locator('[data-action="chat.emoticon.send"]').count(), 2, 'only the selected package direct-send images are present');
    await picker.getByRole('tab').nth(1).click();
    assert.equal(await picker.locator('script').count(), 0);
    assert.equal(await picker.locator('button[aria-label="<script>虚构表情 & 名称</script>"] img').count(), 0);
    assert.equal(await picker.locator('.lake-emote-stickers img').count(), 1);
    assert.match(await picker.locator('.lake-emote-stickers img').getAttribute('src'), /^https:\/\/i0\.hdslb\.com\/bfs\//);
    await picker.getByRole('tab').nth(0).click();
    check('explicitly opening the emoji picker refreshes metadata, preserves the draft and safely renders untrusted labels and image URLs');

    await input.evaluate(node => node.setSelectionRange(2, 4));
    await picker.getByRole('button', { name: '笑哭', exact: true }).click();
    await ready();
    assert.equal(await input.inputValue(), '常规表情测试');
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 4]);
    assert.equal(writes().length, beforePickerWrites + 1);
    assert.deepEqual(writes().at(-1), { action: 'bili.chat.emoticon.send', payload: { emoticon_unique: 'fixture_live_text_laugh', confirmed: true } });
    check('a regular returned text-kind emoji directly sends its opaque ID once without changing the draft or selection');

    await openPicker();
    await picker.getByRole('tab').nth(1).click();
    const locked = picker.getByRole('button', { name: '未解锁表情', exact: true });
    assert.equal(await locked.isDisabled(), true);
    assert.equal(await locked.getAttribute('title'), null);
    const beforeLocked = writes().length;
    await locked.evaluate(node => node.click());
    assert.equal(writes().length, beforeLocked);
    check('locked live emoticons remain visible and disabled, and a click cannot dispatch them');

    await input.fill('独立表情不清除此草稿');
    await picker.getByRole('button', { name: '虚构微笑', exact: true }).click();
    await ready();
    assert.deepEqual(writes().at(-1), { action: 'bili.chat.emoticon.send', payload: { emoticon_unique: 'fixture_live_smile', confirmed: true } });
    assert.equal(await input.inputValue(), '独立表情不清除此草稿');
    assert.equal(await page.locator('#lake-current .lake-message').count(), 1);
    assert.equal(await page.locator('#lake-history .lake-message').count(), 0);
    check('an allowed live emoticon sends its unique ID once and preserves the ordinary draft without a fabricated echo');

    await openPicker();
    state.chat_send.message_limit = 5;
    await input.fill('ABCDE');
    await push();
    assert.equal(await input.getAttribute('maxlength'), '5');
    const beforeOversized = writes().length;
    await picker.getByRole('button', { name: '支持', exact: true }).click();
    await ready();
    assert.equal(await input.inputValue(), 'ABCDE');
    assert.equal(writes().length, beforeOversized + 1);
    assert.deepEqual(writes().at(-1), { action: 'bili.chat.emoticon.send', payload: { emoticon_unique: 'fixture_live_text_support', confirmed: true } });
    state.chat_send.message_limit = 30;
    await push();
    assert.equal(await input.getAttribute('maxlength'), '30');
    await input.fill('字符😀界限');
    await push();
    assert.equal(await input.inputValue(), '字符😀界限');
    check('room limits update the ordinary text maxlength while independent emoji sends never append markup to a full draft');

    state.network_disabled = true;
    await push();
    await assertDisabled(/离线测试窗口/);
    const blockedWrites = writes().length;
    const blockedReads = reads().length;
    await page.evaluate(() => window.__chatAttemptSend());
    await form.evaluate(node => node.requestSubmit());
    assert.equal(writes().length, blockedWrites);
    assert.equal(reads().length, blockedReads);
    state.network_disabled = false;
    state.account = {};
    await push();
    await assertDisabled(/扫码登录/);
    await page.evaluate(() => window.__chatAttemptSend('fixture_live_smile'));
    assert.equal(writes().length, blockedWrites);
    assert.equal(reads().length, blockedReads);
    state.account = { user_id: 42, name: '虚构主播' };
    await push();
    await ready();
    check('offline mode and logout disable text, emoji reads and emoticon sends even with retained metadata and drafts');

    state.preferences.broadcast_console = false;
    await push();
    assert.equal(await compose.isVisible(), true);
    await ready();
    await openPicker();
    const beforeConsoleToggle = { writes: writes().length, reads: reads().length };
    state.preferences.broadcast_console = true;
    await push();
    await ready();
    assert.equal(await picker.isVisible(), true);
    assert.equal(await input.inputValue(), '字符😀界限');
    assert.equal(writes().length, beforeConsoleToggle.writes);
    assert.equal(reads().length, beforeConsoleToggle.reads);
    check('broadcast mode toggles leave the authenticated picker open and preserve its metadata and text draft');

    await openPicker();
    await togglePicker();
    state.chat_send.emoticons = [];
    failRead = true;
    const beforeReadFailure = reads().length;
    await togglePicker();
    await ready();
    assert.equal(reads().length, beforeReadFailure + 1);
    await push();
    assert.equal(reads().length, beforeReadFailure + 1);
    assert.equal(writes().length, blockedWrites);
    assert.equal(await input.inputValue(), '字符😀界限');
    failRead = false;
    await togglePicker();
    await openPicker();
    assert.equal(reads().length, beforeReadFailure + 2);
    check('a failed metadata read does not retry or send from snapshots, and the picker can be reopened for an explicit retry');

    await togglePicker();
    deferred = { action: 'bili.chat.send' };
    await input.fill('旧账号等待中的消息');
    await send.click();
    await until(() => deferred.started);
    state.account = { user_id: 43, name: '另一个虚构主播' };
    state.setup = { ...state.setup, uid: 43, room_id: 1000 };
    state.live_settings.room_id = 1000;
    state.live.room_id = 1000;
    state.broadcast.room.room_id = 1000;
    state.chat_send = { ...state.chat_send, room_id: 1000, emoticons: [] };
    await push();
    await input.evaluate(node => { node.value = '新账号自己的草稿'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.locator('#toast').waitFor({ state: 'hidden' });
    deferred.resolve(structuredClone(state));
    deferred = null;
    await ready();
    assert.equal(await input.inputValue(), '新账号自己的草稿');
    assert.equal(await page.locator('#toast').isHidden(), true);
    assert.deepEqual(await page.evaluate(() => window.__chatFixtureIdentity()), { account: 43, room: 1000 });
    check('a send response after an account and room switch cannot clear the new draft or claim success for the new room');

    const staleSnapshot = structuredClone(state);
    deferred = { action: 'bili.chat.emoticons.refresh' };
    await togglePicker();
    await until(() => deferred.started);
    staleSnapshot.chat_send.emoticons = structuredClone(packs);
    staleSnapshot.chat_send.warnings = ['旧账号个人表情读取失败 [DV-B04]'];
    state.account = { user_id: 44, name: '第三个虚构主播' };
    state.setup = { ...state.setup, uid: 44, room_id: 1001 };
    state.live_settings.room_id = 1001;
    state.live.room_id = 1001;
    state.broadcast.room.room_id = 1001;
    state.chat_send = { ...state.chat_send, room_id: 1001, emoticons: [] };
    await push();
    deferred.resolve(staleSnapshot);
    deferred = null;
    await ready();
    assert.deepEqual(await page.evaluate(() => window.__chatFixtureIdentity()), { account: 44, room: 1001 });
    assert.equal(await picker.locator('[data-action="chat.emoticon.send"]').count(), 0);
    assert.doesNotMatch(await compose.locator('.chat-compose-note').textContent(), /旧账号个人表情/);
    assert.equal(await input.inputValue(), '新账号自己的草稿');
    check('late emoji metadata cannot restore an old account, room or old permitted live emoticons');

    if (await picker.isVisible()) await page.keyboard.press('Escape');
    await page.locator('#toast').waitFor({ state: 'hidden' });
    deferred = { action: 'bili.chat.send' };
    await input.fill('关闭开关前等待发送');
    const consoleReply = structuredClone(state);
    await send.click();
    await until(() => deferred.started);
    state.preferences.broadcast_console = false;
    state.config_revision += 1;
    await push();
    deferred.resolve(consoleReply);
    deferred = null;
    await page.waitForFunction(() => !window.__chatFixtureBusy());
    assert.equal(await compose.isVisible(), true);
    assert.equal(await input.isDisabled(), false);
    assert.match(await page.locator('#toast').textContent(), /已发送/);
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.evaluate(() => window.__chatFixtureBroadcast()), false);
    state.preferences.broadcast_console = true;
    state.config_revision += 1;
    await push();
    await ready();
    check('a pending ordinary send remains valid across broadcast mode toggles and clears its submitted draft once');

    await page.locator('#toast').waitFor({ state: 'hidden' });
    deferred = { action: 'bili.chat.send' };
    await input.fill('退出账号前等待发送');
    const logoutReply = structuredClone(state);
    await send.click();
    await until(() => deferred.started);
    state.account = {};
    await push();
    deferred.resolve(logoutReply);
    deferred = null;
    await page.waitForFunction(() => !window.__chatFixtureBusy());
    await assertDisabled(/扫码登录/);
    assert.equal(await page.locator('#toast').isHidden(), true);
    assert.equal(await input.inputValue(), '退出账号前等待发送');
    assert.equal(await page.evaluate(() => window.__chatFixtureIdentity().account), undefined);
    state.account = { user_id: 44, name: '第三个虚构主播' };
    await push();
    await ready();
    await input.fill('新账号自己的草稿');
    check('a pending send cannot restore a logged-out account or enable its composer when its old snapshot arrives');

    state.preferences.language = 'en';
    state.preferences.appearance = 'light';
    state.chat_send.emoticons = structuredClone(packs);
    await push();
    await ready();
    assert.equal(await input.getAttribute('placeholder'), 'Say something…');
    assert.equal(await send.getAttribute('aria-label'), 'Send');
    assert.equal(await emoji.getAttribute('aria-label'), 'Emoticons');
    assert.equal(await compose.locator('[role="status"]').isHidden(), true);
    await openPicker();
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, 'chat-send-en-light.png') });
    check('English translates composer labels while retaining original Bilibili pack and emoji names');

    state.preferences.language = 'zh-CN';
    state.preferences.appearance = 'dark';
    await push();
    await page.setViewportSize({ width: 640, height: 560 });
    await ready();
    await openPicker();
    for (const node of [compose, picker]) {
      const bounds = await node.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 641 && bounds.y + bounds.height <= 561, JSON.stringify(bounds));
      assert.equal(await node.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    }
    await page.screenshot({ path: path.join(output, 'chat-send-zh-dark-compact.png') });
    check('the compact composer and scrollable emoji picker stay inside a 640 by 560 window without horizontal overflow');

    state.preferences.broadcast_console = false;
    state.account = {};
    state.chat_send = { ...state.chat_send, room_id: null, emoticons: [], error: null, message_limit: 20 };
    await push();
    failRead = true;
    const beforeAutomaticFailure = reads().length;
    const beforeAutomaticWrites = writes().length;
    state.account = { user_id: 45, name: '自动读取失败账号' };
    state.setup.uid = 45;
    await push();
    await until(() => reads().length === beforeAutomaticFailure + 1);
    await ready();
    await push();
    await push();
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(100);
    assert.equal(reads().length, beforeAutomaticFailure + 1);
    assert.equal(writes().length, beforeAutomaticWrites);
    assert.equal(await input.inputValue(), '新账号自己的草稿');
    assert.match(await compose.locator('[role="status"]').textContent(), /虚构表情读取失败/);
    assert.equal(await picker.isHidden(), true);
    failRead = false;
    await openPicker();
    assert.equal(reads().length, beforeAutomaticFailure + 2);
    assert.equal(await input.getAttribute('maxlength'), '40');
    check('an automatic metadata failure appears inline, preserves the draft and never loops from snapshots or focus; explicit opening retries once');

    await page.keyboard.press('Escape');
    state.account = { user_id: 71, name: '两包账号' };
    state.setup.uid = 71;
    await push();
    await ready();
    await openPicker();
    assert.equal(await picker.getByRole('tab').count(), 2);
    assert.deepEqual(await tabNames(), packs.map(pack => pack.name));
    assert.equal(await picker.locator('.lake-emote-pack-icon').count(), 1);
    assert.equal(await picker.getByRole('tab').nth(0).locator('img').count(), 0);
    assert.equal(await picker.getByRole('tab').nth(0).locator('svg').count(), 1, 'coverless and image-less packages retain an image-only missing-image indicator');
    assert.equal(await picker.getByRole('tab').nth(1).locator('.lake-emote-pack-icon').getAttribute('src'), packs[1].icon);
    assert.equal(await picker.getByRole('tab').nth(1).locator('.lake-emote-pack-icon').evaluate(node => node.complete && node.naturalWidth > 0), true);
    await picker.getByRole('tab').nth(0).press('ArrowRight');
    assert.equal(await picker.getByRole('tab').nth(1).getAttribute('aria-selected'), 'true');
    assert.equal(await picker.getByRole('tab').nth(1).evaluate(node => node === document.activeElement), true);
    assert.equal(await picker.locator('[data-action="chat.emoticon.insert"]').count(), 0);
    await assertImageOnlyPicker();
    check('the actual two returned packs form two ordered keyboard-selectable tabs without mixing their contents');

    await page.keyboard.press('Escape');
    deferred = { action: 'bili.chat.emoticons.refresh' };
    await emoji.click();
    await until(() => deferred.started);
    const oldPackageRead = deferred;
    const oldPackageSnapshot = structuredClone(state);
    deferred = { action: 'bili.chat.emoticons.refresh' };
    state.account = { user_id: 72, name: '五包账号' };
    state.setup.uid = 72;
    state.broadcast.room.room_id = 7777; // Actual own send room may differ from reception/setup.
    await push();
    await until(() => deferred.started);
    assert.equal(await picker.isHidden(), true);
    assert.equal(await picker.getByRole('tab').count(), 0, 'old account packages disappear before the replacement read returns');
    oldPackageRead.resolve(oldPackageSnapshot);
    await page.waitForTimeout(100);
    assert.equal(await input.isDisabled(), true, 'the old finally must not release the new account read');
    assert.equal(await picker.getByRole('tab').count(), 0);
    state.chat_send = { ...state.chat_send, account_id: 72, room_id: 7777, emoticons: structuredClone(fivePacks), error: null };
    deferred.resolve(structuredClone(state));
    deferred = null;
    await ready();
    await emoji.click();
    await ready();
    assert.equal(await picker.getByRole('tab').count(), 5);
    assert.deepEqual(await tabNames(), fivePacks.map(pack => pack.name));
    assert.equal(await picker.locator('#chat-emote-page').getAttribute('data-room-id'), '7777');
    await picker.getByRole('tab').nth(0).press('End');
    assert.equal(await picker.getByRole('tab').nth(4).getAttribute('aria-selected'), 'true');
    assert.equal(await picker.locator('[data-action="chat.emoticon.send"]').count(), 55);
    const beforeNewLocked = writes().length;
    const newLocked = picker.getByRole('button', { name: '第二账号 4:0', exact: true });
    assert.equal(await newLocked.isDisabled(), true);
    await newLocked.evaluate(node => node.click());
    assert.equal(writes().length, beforeNewLocked);
    assert.equal(await picker.getByRole('button', { name: '第二账号 4:54', exact: true }).isEnabled(), true);
    await picker.getByRole('button', { name: '第二账号 4:54', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await picker.locator('#chat-emote-page').evaluate(node => node.scrollHeight > node.clientHeight && node.scrollTop > 0), true, 'all 55 items use continuous scrolling through the final item');
    const scrolledTop = await picker.locator('#chat-emote-page').evaluate(node => node.scrollTop);
    state.chat_send.emoticons[4].emoticons[0].description += ' · 已刷新权限说明';
    await push(); // A same-pack metadata refresh changes markup and replaces the DOM body.
    await push(); // Unchanged periodic snapshot must also retain the current scroll.
    assert.ok(Math.abs(await picker.locator('#chat-emote-page').evaluate(node => node.scrollTop) - scrolledTop) < 1, 'same-package rerenders preserve the user scroll position');
    await picker.getByRole('tab').nth(0).click();
    assert.equal(await picker.locator('#chat-emote-page').evaluate(node => node.scrollTop), 0);
    await picker.getByRole('tab').nth(4).click();
    assert.equal(await picker.locator('#chat-emote-page').evaluate(node => node.scrollTop), 0, 'explicit package switching returns the selected package to its first image');
    await picker.getByRole('button', { name: '第二账号 4:54', exact: true }).scrollIntoViewIfNeeded();
    await assertImageOnlyPicker();
    await page.screenshot({ path: path.join(output, 'chat-packages-account72-continuous-scroll.png') });
    check('a switch from two to five packs clears stale content and replies, preserves own-room identity, and exposes all 55 image-only items in one continuous scroll with platform locks');
    check('same-package changed and unchanged metadata rerenders preserve scroll position, while explicit package switching starts at the first image');

    state.chat_send.emoticons = [fivePacks[4], fivePacks[2], fivePacks[0], fivePacks[1], fivePacks[3]].map(pack => structuredClone(pack));
    await push();
    assert.deepEqual(await tabNames(), state.chat_send.emoticons.map(pack => pack.name));
    assert.equal(await picker.getByRole('tab').nth(0).getAttribute('aria-selected'), 'true');
    assert.equal(await picker.getByRole('button', { name: '第二账号 4:54', exact: true }).count(), 1);
    assert.deepEqual(await picker.locator('.lake-emote-pack-icon').evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))), state.chat_send.emoticons.filter(pack => pack.icon).map(pack => pack.icon));
    await page.screenshot({ path: path.join(output, 'chat-packages-names-covers-reordered.png') });
    state.chat_send.emoticons = [{ ...structuredClone(fivePacks[3]), name: '<script>实际包名 & 图标</script>', icon: 'javascript:window.__badPackage=true' }];
    await push();
    assert.equal(await picker.getByRole('tab').count(), 1);
    assert.equal(await picker.getByRole('tab').getAttribute('aria-label'), '<script>实际包名 & 图标</script>');
    assert.equal(await picker.locator('.lake-emote-pack-icon').count(), 0);
    assert.equal(await picker.locator('script').count(), 0);
    assert.equal(await picker.locator('[data-action="chat.emoticon.send"]').count(), fivePacks[3].emoticons.length);
    assert.equal(await page.evaluate(() => window.__badPackage), undefined);
    await assertImageOnlyPicker();
    check('accessible package names and covers stay paired in platform order, refresh retains selection, and removed packs or unsafe icons use graphic fallback without visible text');

    state.chat_send.emoticons[0].emoticons[0].url = 'javascript:window.__badItemCover=true';
    state.chat_send.emoticons[0].emoticons[1].url = packs[1].icon;
    await push();
    const itemCover = picker.getByRole('tab').locator('img');
    assert.equal(await itemCover.getAttribute('src'), packs[1].icon, 'a missing or unsafe cover uses the first safe returned item image');
    await itemCover.evaluate(node => node.decode());
    assert.equal(await picker.getByRole('button', { name: '第二账号 3:0', exact: true }).locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__badItemCover), undefined);
    await assertImageOnlyPicker();
    check('a package without a valid cover uses its first safe actual item image while unsafe image URLs stay graphic-only and never execute');

    for (const [account, expectedCount] of [[73, 0], [74, 1]]) {
      await page.keyboard.press('Escape');
      state.account = { user_id: account, name: `账号${account}` };
      state.setup.uid = account;
      await push();
      await ready();
      await emoji.click();
      await ready();
      assert.equal(await picker.getByRole('tab').count(), expectedCount);
      assert.equal(await picker.locator('[data-action="chat.emoticon.send"]').count(), expectedCount);
      await assertImageOnlyPicker();
    }
    check('zero and one returned package retain correct content and graphic-only empty state without fabricated tabs or pages');

    await page.keyboard.press('Escape');
    const beforeRoomChange = reads().length;
    state.setup.room_id = 8888;
    state.live_settings.room_id = 8888;
    state.live.room_id = 8888;
    await push();
    await ready();
    assert.equal(reads().length, beforeRoomChange + 1);
    assert.equal(await picker.getByRole('tab').count(), 0);
    await emoji.click();
    await ready();
    assert.equal(await picker.getByRole('tab').count(), 1);
    assert.equal(await picker.locator('#chat-emote-page').getAttribute('data-room-id'), '7777');
    check('a reception-room change clears the old picker and re-fetches while the send destination remains the verified own room');

    await page.keyboard.press('Escape');
    state.account = { user_id: 75, name: '购买和收藏表情账号' };
    state.setup.uid = 75;
    await push();
    await ready();
    await emoji.click();
    await ready();
    assert.deepEqual(await tabNames(), [ownedPack.name, packs[1].name]);
    assert.equal(await picker.locator('.lake-emote-sticker[data-action="chat.emoticon.send"]').count(), 20);
    assert.equal(await picker.locator('[data-action="chat.emoticon.insert"]').count(), 0);
    assert.equal(await picker.locator('.lake-emote-stickers img').count(), 20);
    await picker.getByRole('button', { name: '花花', exact: true }).locator('img').evaluate(node => node.decode());
    assert.equal(await picker.getByRole('button', { name: '花花', exact: true }).locator('img').getAttribute('src'), ownedPack.emoticons[0].url);
    assert.equal(await picker.getByRole('button', { name: '花花', exact: true }).getAttribute('data-emoticon-text'), null);
    await assertImageOnlyPicker();
    await page.screenshot({ path: path.join(output, 'chat-owned-package-images.png') });
    check('purchased or saved account packages precede live packages, retain covers and images, and display all 20 items continuously without names or pagination');

    await input.fill('前后');
    await input.evaluate(node => node.setSelectionRange(1, 1));
    const beforeOwnedSend = writes().length;
    await picker.getByRole('button', { name: '花花', exact: true }).click();
    await ready();
    assert.equal(await input.inputValue(), '前后');
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [1, 1]);
    assert.equal(writes().length, beforeOwnedSend + 1);
    assert.deepEqual(writes().at(-1), { action: 'bili.chat.emoticon.send', payload: { emoticon_unique: 'account:fixture-package:0', confirmed: true } });
    assert.equal(writes().slice(beforeOwnedSend).filter(call => call.action === 'bili.chat.send').length, 0);
    check('a personal image directly sends its exact returned account identity once, preserving the draft and selection without inserting markers or using ordinary text send');

    await openPicker();
    await input.fill('个人表情不会改这份草稿');
    await input.evaluate(node => node.setSelectionRange(2, 6));
    deferred = { action: 'bili.chat.emoticon.send' };
    const beforeOwnedBusy = writes().length;
    await picker.getByRole('button', { name: '花花', exact: true }).click();
    await until(() => deferred.started);
    assert.equal(await input.isDisabled(), true);
    await page.evaluate(() => window.__chatAttemptSend('account:fixture-package:0'));
    await push();
    assert.equal(writes().length, beforeOwnedBusy + 1);
    assert.equal(await input.inputValue(), '个人表情不会改这份草稿');
    deferred.resolve(structuredClone(state));
    deferred = null;
    await ready();
    assert.equal(await input.inputValue(), '个人表情不会改这份草稿');
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 6]);
    check('a pending personal image disables duplicate sends and preserves the same draft and selection across snapshots and successful completion');

    await openPicker();
    failSend = true;
    const beforeOwnedFailure = writes().length;
    await picker.getByRole('button', { name: '花花', exact: true }).click();
    await ready();
    assert.match(await page.locator('#toast').textContent(), /虚构表情发送失败/);
    assert.equal(await input.inputValue(), '个人表情不会改这份草稿');
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 6]);
    await push();
    await push();
    assert.equal(writes().length, beforeOwnedFailure + 1);
    failSend = false;
    await openPicker();
    await picker.getByRole('button', { name: '花花', exact: true }).click();
    await ready();
    assert.equal(writes().length, beforeOwnedFailure + 2);
    assert.equal(await input.inputValue(), '个人表情不会改这份草稿');
    check('a failed personal-image send leaves draft and selection intact and never retries automatically; a deliberate retry sends only once');

    state.chat_send.warnings = ['直播表情读取失败：虚构接口响应 [DV-B04]'];
    await push();
    await emoji.click();
    await ready();
    state.chat_send.emoticons = [structuredClone(ownedPack)];
    state.chat_send.warnings = ['直播表情读取失败：虚构接口响应 [DV-B04]'];
    await push();
    assert.equal(await picker.getByRole('tab').count(), 1);
    assert.match(await picker.locator('.lake-emote-warning[role="status"]').textContent(), /直播表情读取失败/);
    assert.match(await compose.locator('.chat-compose-note').textContent(), /直播表情读取失败/);
    assert.equal(await picker.getByRole('button', { name: '花花', exact: true }).isEnabled(), true);
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, 'chat-owned-package-partial-warning.png') });
    await assertImageOnlyPicker();
    check('a partial live-package failure has an accessible graphic picker status and detailed composer message while personal images remain usable');

    await input.fill('旧账号个人表情等待');
    deferred = { action: 'bili.chat.emoticon.send' };
    const oldPersonalReply = structuredClone(state);
    await picker.getByRole('button', { name: '花花', exact: true }).click();
    await until(() => deferred.started);
    state.account = { user_id: 76, name: '个人接口读取失败账号' };
    state.setup.uid = 76;
    await push();
    await ready();
    await input.fill('新账号独立草稿');
    await input.evaluate(node => node.setSelectionRange(1, 3));
    await page.locator('#toast').waitFor({ state: 'hidden' });
    deferred.resolve(oldPersonalReply);
    deferred = null;
    await ready();
    assert.equal(await input.inputValue(), '新账号独立草稿');
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [1, 3]);
    assert.equal(await page.evaluate(() => window.__chatFixtureIdentity().account), 76);
    assert.equal(await page.locator('#toast').isHidden(), true);
    check('a late personal-image reply cannot restore the old account, replace the new draft or selection, or report success for the new account');
    await emoji.click();
    await ready();
    assert.equal(await picker.getByRole('tab').count(), 1);
    assert.equal(await picker.getByRole('tab').getAttribute('aria-label'), packs[1].name);
    assert.match(await picker.locator('.lake-emote-warning').textContent(), /个人表情读取失败/);
    assert.match(await compose.locator('.chat-compose-note').textContent(), /个人表情读取失败/);
    assert.equal(await picker.getByRole('button', { name: '未解锁表情', exact: true }).isDisabled(), true);
    assert.equal(await picker.getByRole('button', { name: '虚构微笑', exact: true }).getAttribute('data-action'), 'chat.emoticon.send');
    await assertImageOnlyPicker();
    check('a partial account-package failure reports that source explicitly while retaining genuine live standalone permissions');

    deferred = { action: 'bili.chat.emoticons.refresh' };
    state.account = { user_id: 72, name: '五包账号' };
    state.setup.uid = 72;
    await push();
    await until(() => deferred.started);
    assert.equal(await picker.getByRole('tab').count(), 0);
    assert.equal(await compose.locator('.chat-compose-note').isHidden(), true);
    assert.equal(await picker.locator('.lake-emote-warning').count(), 0);
    state.chat_send = { ...state.chat_send, account_id: 72, emoticons: structuredClone(fivePacks), warnings: [], error: null };
    deferred.resolve(structuredClone(state));
    deferred = null;
    await ready();
    assert.equal(await compose.locator('.chat-compose-note').isHidden(), true);
    check('account changes clear old packages and source warnings immediately, and new owner metadata does not retain another account warning');

    assert.deepEqual(errors, []);
    assert.deepEqual(await sourceHashes(), testedAssets, 'production assets must remain unchanged throughout browser acceptance');
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ evidence: 'headless Edge with fictional IPC and blocked external traffic; explicit fictional platform cover URLs render local logo fixture pixels; no live chat or account acceptance', checked_at: new Date().toISOString(), tested_assets_sha256: testedAssets, checks, emoji_reads: reads().length, chat_writes: writes().length }, null, 2));
    console.log(`${checks.length} chat-send UI checks passed`);
  } finally {
    if (deferred?.resolve) deferred.resolve(structuredClone(state));
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
