// Fictional IPC fixtures only. Headless Edge; all external traffic is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/audience-ui-tests'));
const checks = [];
const calls = [];
const check = name => { checks.push(name); console.log(`ok ${name}`); };
const user = (id, name = `虚构观众${id}`) => ({ user_id: id, user_name: name, rank: id - 99, score: '20', guard_level: 3, medal_name: '虚构粉丝牌', medal_level: 7, avatar_url: null });
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: false },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999 },
  live: { running: true, state: 'connected', room_id: 999, events: [
    { user_id: 501, user_name: '互动甲', kind: 'danmaku', message: '旧消息', room_id: 999, observed_at_ms: 1 },
    { user_id: 501, user_name: '互动甲', kind: 'danmaku', message: '最新消息', room_id: 999, observed_at_ms: 2 },
    { user_id: null, user_name: '无 UID 用户', kind: 'danmaku', message: '匿名消息', room_id: 999, observed_at_ms: 3 },
  ], audience: { active: true, live_status: 1, loading: false, error: null, rank_count: 9999, rank_count_text: '9999+', watched_count: 12500, updated_at_ms: Date.now(), page: 1, has_more: true, users: [user(100, '<用户 & 甲>'), ...Array.from({ length: 48 }, (_, i) => user(101 + i)), { user_id: null, user_name: '虚构神秘人', rank: 50, mystery: true }] } },
  queue: { current: null, pending: [], history: [] }, rules: { default_preset_id: null, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: {}, qr: { status: 'idle' }, status: {},
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
      let source = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
      if (pathname === '/app.js') source = source.toString() + '\nwindow.__audiencePush = acceptSnapshot;';
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
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__fixtureInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch');
      calls.push(args.action);
      if (args.action === 'live.audience.more') {
        state.live.audience.users.push(user(160)); state.live.audience.has_more = false; state.live.audience.page = 2;
      } else if (args.action === 'rules.save') state.rules = structuredClone(args.payload.rules);
      else if (args.action === 'preferences.save') Object.assign(state.preferences, args.payload.preferences);
      else if (!['bili.qr.cancel', 'doubao.qr.cancel'].includes(args.action)) throw new Error(`Unexpected fixture action ${args.action}`);
      return structuredClone(state);
    });
    await page.addInitScript(() => {
      window.__TAURI__ = { core: { invoke: (command, args) => window.__fixtureInvoke(command, args) }, event: { listen: async () => () => {} } };
    });
    const push = () => page.evaluate(next => window.__audiencePush(next), structuredClone(state));
    const dialog = page.locator('#audience-dialog');
    await page.goto(origin);
    const byline = page.locator('#audience-count');
    const bylineText = () => byline.evaluate(node => [...node.querySelectorAll('.audience-now, .audience-reach')].map(part => part.textContent).join(' | '));
    await byline.waitFor();
    assert.equal(await bylineText(), '9999+人在看');
    assert.equal(await byline.getAttribute('aria-label'), '9999+ 人在看');
    assert.doesNotMatch(await page.locator('#live-shell').textContent(), /看过/);
    assert.equal(await page.locator('.lake-room-row .audience-face').count(), 3);
    assert.equal(await page.locator('#masthead-kicker #audience-count').count(), 0);
    check('masthead byline shows confirmed viewers and faces without cumulative reach');
    await byline.hover();
    await page.waitForFunction(() => document.querySelector('#audience-dialog')?.open);
    assert.equal(await page.locator('#lake-pop-scrim').isHidden(), true, 'hover opens a nonmodal source popover');
    await page.mouse.move(5, 400);
    await page.waitForTimeout(100);
    assert.equal(await dialog.evaluate(node => node.open), true, 'header hover leave allows travel into the popover');
    await page.waitForFunction(() => !document.querySelector('#audience-dialog')?.open);
    await byline.click();
    await page.mouse.move(5, 400);
    await page.waitForTimeout(400);
    assert.equal(await dialog.evaluate(node => node.open), true, 'click pins the source popover');
    await page.mouse.click(5, 400);
    assert.equal(await dialog.evaluate(node => node.open), false, 'outside click closes the pinned popover');
    check('source audience hover opens without a scrim, leave waits350ms, click pins and outside closes');
    await byline.click();
    await dialog.waitFor();
    assert.equal(await page.locator('#audience-search').isHidden(), true, 'source design has no visible search field');
    assert.equal(await dialog.locator('.audience-user').count(), 50);
    assert.equal(await dialog.locator('[role="tab"]').count(), 0);
    assert.equal(await dialog.locator('[data-action="audience.refresh"], [data-action="audience.more"]').count(), 0);
    assert.doesNotMatch(await dialog.textContent(), /高能|最近互动|刷新/);
    assert.equal(await page.locator('#audience-total').textContent(), '9999+');
    assert.doesNotMatch(await dialog.textContent(), /看过/);
    const top = await dialog.boundingBox(); const anchor = await byline.boundingBox();
    assert.ok(top.y > anchor.y + anchor.height && Math.abs(top.x - 92) < 1, 'source popover occupies x92/y190 under the header');
    check('source popover has no tabs, search or refresh control and sits below the header');
    const first = dialog.locator('.audience-user').first();
    assert.equal(await first.locator('.audience-user-name').textContent(), '<用户 & 甲>');
    assert.match(await first.getAttribute('title'), /^UID 100 · 舰长 · 虚构粉丝牌 7 · 贡献值 20$/, 'additional real metadata stays available through the row tooltip');
    assert.equal(await first.locator('.audience-tag').textContent(), '舰长');
    assert.equal(await first.locator('.audience-medal,.audience-score').count(), 0);
    assert.equal(await dialog.locator('用户').count(), 0);
    const mystery = dialog.locator('.audience-user').last();
    assert.equal(await mystery.isDisabled(), true);
    assert.equal(await mystery.getAttribute('title'), null);
    check('source rows show rank, name and guard without HTML injection or a mystery UID');
    await push();
    assert.equal(await dialog.locator('.audience-user').count(), 50);
    assert.equal(calls.includes('live.audience.more'), false, 'a snapshot refresh must not page before scrolling');
    check('source list survives live snapshots without loading unrequested pages');
    await page.locator('#audience-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('.audience-user').length === 51);
    assert.equal(calls.filter(call => call === 'live.audience.more').length, 1);
    assert.match(await dialog.locator('#audience-tail').textContent(), /B站只公开部分在线观众/);
    check('scrolling near the end loads the next page once, then shows the coverage note');
    await dialog.locator('.audience-user').first().click();
    await page.locator('#viewer-alias').waitFor();
    assert.equal(await dialog.evaluate(node => node.open), false);
    assert.equal(await page.locator('.viewer-name').textContent(), '<用户 & 甲>');
    await page.locator('#viewer-alias').fill('虚构读音');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#viewer-drawer')?.hidden);
    assert.equal(await dialog.evaluate(node => node.open), false, 'source viewer card closes to the main lake');
    assert.equal(state.rules.user_words.some(word => word.from === '<用户 & 甲>' && word.to === '虚构读音'), true);
    check('viewer detail reuses alias autosave and closes to the source main lake');
    await byline.click();
    state.live.audience.error = 'B站接口返回错误码 -352 [DV-B04]';
    await push();
    assert.match(await bylineText(), /^—人在看/);
    assert.equal(await dialog.locator('.audience-user').count(), 51);
    assert.match(await dialog.locator('#audience-status').textContent(), /显示上次获取的名单.*-352/);
    assert.equal(await dialog.getAttribute('data-state'), 'error');
    check('request failure retains the labeled last list and hides the stale count');
    state.live.audience.error = null; state.live.audience.watched_count = 0; state.live.audience.rank_count_text = '0'; state.live.audience.users = []; state.live.audience.has_more = false;
    await push();
    assert.equal(await bylineText(), '0人在看');
    assert.equal(await byline.isHidden(), true);
    assert.equal(await page.locator('.lake-room-row .audience-face').count(), 0);
    assert.match(await dialog.locator('.audience-empty').textContent(), /暂时没有/);
    check('confirmed zero hides the masthead entry while open-list data remains distinct from unavailable');
    state.account = { user_id: 100, name: '<用户 & 甲>' };
    state.live.audience.rank_count_text = '1'; state.live.audience.users = [user(100, '<用户 & 甲>')];
    await push();
    assert.equal(await bylineText(), '0人在看');
    assert.equal(await byline.isHidden(), true, 'self-only audience hides the zero entry');
    assert.equal(await page.locator('#audience-total').textContent(), '0');
    assert.equal(await dialog.locator('.audience-user').count(), 0);
    assert.equal(await page.locator('.lake-room-row .audience-face').count(), 0);
    state.account = {}; state.live.audience.users = []; state.live.audience.live_status = 0;
    await push();
    assert.equal(await bylineText(), '0人在看');
    assert.equal(await byline.isHidden(), true, 'offair zero is hidden');
    assert.equal(await page.locator('#audience-total').textContent(), '0');
    assert.equal(await dialog.locator('#audience-status').textContent(), '未开播');
    assert.equal(await dialog.getAttribute('data-state'), 'off');
    check('self is excluded from the count, avatars and list; an unbroadcast room cannot show one viewer');
    state.live.audience.live_status = 1;
    await push();
    assert.equal(await bylineText(), '1人在看', 'an empty partial list is not proof of self inclusion');
    assert.equal(await byline.isVisible(), true, 'positive count restores the entry');
    state.live.audience.live_status = null;
    await push();
    assert.equal(await bylineText(), '—人在看');
    assert.match(await dialog.locator('#audience-status').textContent(), /正在获取直播状态/);
    state.live.audience.live_status = 1; state.live.audience.rank_count_text = '0';
    await push();
    check('unknown broadcast status stays unavailable and counts are never blindly decremented');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate(node => node.open), false);
    assert.equal(await byline.evaluate(node => node === document.activeElement), false, 'a zero-count hidden entry cannot receive restored focus');
    state.live.running = false; state.live.state = 'stopped'; state.live.audience.active = false;
    await push();
    assert.equal(await byline.isVisible(), false);
    assert.equal(await page.locator('#lake-title').isVisible(), true);
    check('Escape closes the zero-count list and disconnect keeps the room identity');
    state.preferences.language = 'en'; state.preferences.appearance = 'light';
    state.live.running = true; state.live.state = 'connected'; state.live.audience.active = true;
    state.live.audience.users = Array.from({ length: 50 }, (_, i) => user(100 + i));
    state.live.audience.rank_count_text = '9999+'; state.live.audience.watched_count = 12500; state.live.audience.has_more = true;
    await push();
    assert.equal(await bylineText(), '9999+watching');
    await byline.click();
    assert.equal(await page.locator('#audience-title').textContent(), 'Viewers watching now');
    assert.doesNotMatch(await dialog.textContent(), /Watched/);
    assert.equal(await dialog.locator('.audience-tag').first().textContent(), 'Captain');
    await page.screenshot({ path: path.join(output, 'audience-en-light.png') });
    await page.keyboard.press('Escape');
    check('English keeps viewer names and identifiers intact');
    state.preferences.language = 'zh-CN'; state.preferences.appearance = 'dark';
    await push();
    await page.setViewportSize({ width: 640, height: 560 });
    await byline.click();
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 640 && bounds.y + bounds.height <= 560);
    assert.ok(await page.locator('#audience-scroll').evaluate(node => node.scrollHeight > node.clientHeight));
    await page.screenshot({ path: path.join(output, 'audience-zh-dark-compact.png') });
    check('compact dark layout keeps the scrollable list within the window');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ evidence: 'headless browser with fictional IPC; no live account or WebSocket acceptance', checks }, null, 2));
    console.log(`${checks.length} audience UI checks passed`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
