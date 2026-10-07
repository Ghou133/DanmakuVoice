// Fictional IPC fixtures only. Headless Edge; no Bilibili account or API calls.
// All browser requests outside the local fixture server are blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/moderation-ui-tests'));
const checks = [];
const calls = [];
const check = name => { checks.push(name); console.log(`ok ${name}`); };
const event = (id, name = `虚构观众${id}`, extra = {}) => ({
  room_id: 999, platform_event_id: `fictional-${name}`, observed_at_ms: Date.now(),
  kind: 'danmaku', user_id: id, user_name: name, message: '本地虚构弹幕', avatar_url: null, ...extra,
});
const moderation = (id, extra = {}) => ({
  busy: false, user_id: String(id), room_id: 999, can_moderate: true,
  can_blacklist: true, can_manage_admins: true, muted: false, blacklisted: false, is_admin: false, message: null, ...extra,
});
const viewerA = event(501, '<虚构观众甲 & 测试>');
const viewerB = event(502, '虚构观众乙');
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false,
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: false, broadcast_console: true },
  setup: { room_id: 999, tts_enabled: false, mode: 'account', uid: 42 },
  live_settings: { room_id: 999 },
  live: { running: true, state: 'connected', room_id: 999, events: [viewerA] },
  queue: { current: null, pending: [], history: [] },
  rules: { default_preset_id: null, preferred_presets: {}, user_words: [] },
  connections: [], presets: [], bindings: [], assets: [], devices: [], local_services: {},
  account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: { room_id: 999, title: '虚构直播间', parent_area_id: 2, area_id: 86, live_status: 1 }, areas: [], busy: false },
  overlay: { settings: { enabled: false }, running: false },
  chat_send: { busy: false, error: null, room_id: 999, message_limit: 20, emoticons: [] },
  moderation: { busy: false, user_id: null, room_id: null, can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null, message: null },
};
const mutations = () => calls.filter(call => /^bili\.moderation\.(mute|unmute|blacklist|unblacklist|appoint|dismiss)$/.test(call.action));
const refreshes = () => calls.filter(call => call.action === 'bili.moderation.refresh');
const records = new Map();
const until = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fixture state');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
let failMutation = '';
let refreshPermission = true;
let refreshBlacklist = true;
let refreshManageAdmins = true;
let deferredRefresh = null;
let deferredMutation = null;
let snapshotReads = 0;

(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
      let source = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
      if (pathname === '/app.js') source = source.toString() + `
        window.__moderationTrace = [];
        const fixtureAcceptSnapshot = acceptSnapshot;
        acceptSnapshot = next => {
          fixtureAcceptSnapshot(next);
          const host = document.querySelector('#viewer-drawer #viewer-moderation');
          if (host) window.__moderationTrace.push({
            viewer: document.querySelector('#viewer-drawer .viewer-name')?.textContent,
            user_id: String(next.moderation?.user_id),
            enabled: [...host.querySelectorAll('button[data-action]')].filter(node => !node.disabled).map(node => node.dataset.action),
          });
        };
        window.__moderationPush = next => acceptSnapshot(next);
        window.__moderationRead = refreshViewerModeration;
        window.__moderationFixtureBusy = () => viewerModerationBusy;
        window.__moderationFixtureIdentity = () => ({ account: snapshot.account?.user_id, console: snapshot.preferences?.broadcast_console });`;
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
      if (command === 'snapshot') { snapshotReads++; return structuredClone(state); }
      assert.equal(command, 'dispatch');
      const { action, payload } = args;
      calls.push(structuredClone({ action, payload }));
      if (action === 'bili.moderation.refresh') {
        assert.equal(typeof payload.user_id, 'string');
        assert.match(payload.user_id, /^[1-9]\d*$/);
        assert.deepEqual(Object.keys(payload), ['user_id']);
        if (deferredRefresh?.user_id === payload.user_id) {
          const pending = deferredRefresh;
          state.moderation = moderation(payload.user_id, { busy: true, can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null });
          pending.started = true;
          return new Promise(resolve => { pending.resolve = resolve; });
        }
        state.moderation = moderation(payload.user_id, { ...records.get(payload.user_id), can_moderate: refreshPermission, can_blacklist: refreshPermission && refreshBlacklist, can_manage_admins: refreshPermission && refreshManageAdmins });
      } else if (/^bili\.moderation\.(mute|unmute|blacklist|unblacklist|appoint|dismiss)$/.test(action)) {
        assert.equal(payload.confirmed, true);
        assert.equal(payload.user_id, state.moderation.user_id);
        assert.equal(typeof payload.user_id, 'string');
        assert.equal(payload.room_id, 999);
        if (action.endsWith('.mute') || action.endsWith('.unmute')) assert.equal(state.moderation.can_moderate, true);
        assert.equal(state.account.user_id, 42);
        assert.equal(state.network_disabled, false);
        const expectedKeys = ['confirmed', 'room_id', 'user_id'];
        if (action === 'bili.moderation.mute') {
          assert.ok([0, 1, 24, 168, -1].includes(payload.hours));
          expectedKeys.push('hours');
        }
        assert.deepEqual(Object.keys(payload).sort(), expectedKeys.sort());
        if (deferredMutation?.action === action) {
          const pending = deferredMutation;
          pending.started = true;
          return new Promise(resolve => { pending.resolve = resolve; });
        }
        if (failMutation === action) throw new Error('虚构管理接口失败 [DV-B04]');
        if (action.endsWith('.mute')) state.moderation.muted = true;
        if (action.endsWith('.unmute')) state.moderation.muted = false;
        if (action.endsWith('.blacklist') || action.endsWith('.unblacklist')) {
          assert.equal(state.moderation.can_blacklist, true);
          state.moderation.blacklisted = action.endsWith('.blacklist');
        }
        if (action.endsWith('.appoint') || action.endsWith('.dismiss')) {
          assert.equal(state.moderation.can_manage_admins, true);
          state.moderation.is_admin = action.endsWith('.appoint');
        }
        records.set(payload.user_id, { muted: state.moderation.muted, blacklisted: state.moderation.blacklisted, is_admin: state.moderation.is_admin });
      } else if (action === 'bili.broadcast.refresh') {
        assert.equal(state.preferences.broadcast_console, true);
      } else if (action === 'rules.save') {
        state.rules = structuredClone(payload.rules);
        state.config_revision++;
      } else if (!['bili.qr.cancel', 'doubao.qr.cancel'].includes(action)) {
        throw new Error(`Unexpected fixture action ${action}`);
      }
      return structuredClone(state);
    });
    await page.addInitScript(() => {
      window.__TAURI__ = { core: { invoke: (command, args) => window.__fixtureInvoke(command, args) }, event: { listen: async () => () => {} } };
    });
    const push = (next = state) => page.evaluate(value => window.__moderationPush(value), structuredClone(next));
    // The source card has no refresh button; directly exercise the retained
    // production read guard as a focused backend-boundary regression.
    const refresh = () => page.evaluate(() => window.__moderationRead());
    const host = page.locator('#viewer-drawer #viewer-moderation');
    const control = action => host.locator(`[data-action="viewer.moderation.${action}"]`);
    const close = async () => {
      if (await page.locator('#viewer-drawer').isVisible()) {
        await page.keyboard.press('Escape');
        await page.locator('#viewer-drawer').waitFor({ state: 'hidden' });
      }
      await page.locator('.viewer-layer.leaving').waitFor({ state: 'detached' });
    };
    const open = async item => {
      await close();
      state.live.events = [structuredClone(item)];
      await push();
      await page.locator('#lake-current .lake-avatar-button').click();
      await page.locator('#viewer-drawer #viewer-alias').waitFor();
      assert.equal(await page.locator('#viewer-drawer .viewer-name').textContent(), item.user_name);
    };
    const ready = async () => {
      await page.waitForFunction(() => {
        const mute = document.querySelector('#viewer-drawer [data-action="viewer.moderation.mute"]');
        return mute && !mute.disabled;
      });
    };
    const chooseHours = async (label, value) => {
      await host.getByRole('radio', { name: label, exact: true }).check();
      assert.equal(await host.locator('#viewer-mute-hours').inputValue(), String(value));
    };
    const assertDisabled = async (note, refreshDisabled = true) => {
      assert.equal(await host.locator('button[data-action]:not([data-action="viewer.moderation.refresh"])').count(), 3);
      assert.equal(await host.locator('button[data-action]:not([data-action="viewer.moderation.refresh"])').evaluateAll(nodes => nodes.every(node => node.disabled)), true);
      assert.equal(await host.locator('#viewer-mute-hours').isDisabled(), true);
      assert.equal(await control('refresh').count(), 0);
      assert.match(await host.locator('[role="status"]').textContent(), note);
    };
    const assertQrOnlyRoomSettings = async loggedIn => {
      await close();
      await page.locator('[data-action="settings.open"]').click();
      await page.locator('#settings [data-action="settings.tab"][data-id="room"]').click();
      const content = page.locator('#settings-content');
      await content.locator('[data-action="bili.begin"]').waitFor();
      assert.equal(await content.locator('[data-action="bili.begin"]').textContent(), loggedIn ? '重新扫码' : '扫码登录');
      assert.equal(await content.locator('[data-action="bili.logout"]').count(), loggedIn ? 1 : 0);
      assert.equal(await content.locator('[data-action="onboarding.anonymous"], [data-action="room.anonymous"], [data-action="setup.uid"], [data-form="anonymous"], [data-form="room-uid"], input[name="uid"], #anonymous-uid').count(), 0);
      assert.doesNotMatch(await content.textContent(), /匿名|UID/);
      assert.equal(calls.some(call => ['onboarding.anonymous', 'room.anonymous', 'setup.uid'].includes(call.action)), false);
      await page.locator('#settings [data-action="settings.close"]').click();
      await page.locator('#settings').waitFor({ state: 'hidden' });
    };

    await page.goto(origin);
    await page.locator('#lake-transcript').waitFor();
    assert.equal(refreshes().length, 0);
    assert.equal(mutations().length, 0);
    check('opening the app performs no user moderation reads or writes');

    await assertQrOnlyRoomSettings(true);
    check('signed-in room settings offer QR account controls without anonymous or manual UID entry');

    state.preferences.broadcast_console = false;
    await push();
    await open(viewerA);
    assert.equal(await host.isHidden(), true);
    assert.equal(refreshes().length, 0);
    assert.equal(mutations().length, 0);
    check('disabling the experimental broadcast console hides avatar moderation without reading user permissions');

    state.overlay.settings.enabled = true;
    state.overlay.running = true;
    await push();
    await open(viewerA);
    assert.equal(await host.isHidden(), true);
    assert.equal(refreshes().length, 0);
    assert.equal(mutations().length, 0);
    check('enabling only the OBS overlay does not expose or authorize avatar moderation');

    state.preferences.broadcast_console = true;
    await push();

    await open(viewerA);
    await ready();
    assert.equal(refreshes().length, 1);
    assert.deepEqual(refreshes()[0].payload, { user_id: '501' });
    assert.equal(await control('blacklist').isEnabled(), true);
    assert.equal(await control('appoint').isEnabled(), true);
    assert.equal(mutations().length, 0);
    assert.match(await host.textContent(), /当前直播间.*999/s);
    assert.equal(await page.locator('#viewer-drawer script').count(), 0);
    check('clicking the avatar opens mute, live blacklist and room-admin operations and reads only that public UID');

    assert.deepEqual(await host.locator('#viewer-mute-hours option').evaluateAll(nodes => nodes.map(node => [node.value, node.label])), [['0', '本场'], ['1', '1 小时'], ['24', '24 小时'], ['168', '7 天'], ['-1', '永久']]);
    check('mute choices include this broadcast, one hour, one day, one week and permanent');

    await page.locator('#viewer-drawer #viewer-alias').fill('未保存的虚构读音');
    await chooseHours('7 天', 168);
    state.moderation = moderation(501, { busy: true });
    await push();
    assert.equal(await host.locator('#viewer-mute-hours').inputValue(), '168');
    assert.equal(await host.locator('input[name="viewer-mute-duration"]:checked').inputValue(), '168');
    state.moderation = moderation(501);
    await push();
    assert.equal(await page.locator('#viewer-drawer #viewer-alias').inputValue(), '未保存的虚构读音');
    assert.equal(await host.locator('#viewer-mute-hours').inputValue(), '168');
    await until(() => state.rules.user_words.some(row => row.from === viewerA.user_name && row.to === '未保存的虚构读音'));
    check('intermediate busy and polling snapshots preserve alias input and the selected mute duration');

    await chooseHours('本场', 0);
    await control('mute').click();
    await control('unmute').waitFor();
    assert.deepEqual(mutations().at(-1), { action: 'bili.moderation.mute', payload: { user_id: '501', room_id: 999, confirmed: true, hours: 0 } });
    assert.equal(await host.locator('#viewer-mute-hours').isDisabled(), true);
    const readsBeforeUndo = refreshes().length;
    await page.locator('#toast [data-action="toast.undo"]').waitFor();
    assert.match(await page.locator('#toast').textContent(), /已禁言 .* · 本场.*撤销/s);
    await page.locator('#toast [data-action="toast.undo"]').click();
    await control('mute').waitFor();
    assert.equal(refreshes().length, readsBeforeUndo + 1, 'undo refreshes real permission before writing');
    assert.deepEqual(mutations().at(-1), { action: 'bili.moderation.unmute', payload: { user_id: '501', room_id: 999, confirmed: true } });
    assert.equal(await host.locator('#viewer-mute-hours').inputValue(), '0');
    check('source mute toast names the viewer and duration; its real undo refreshes permission and unmutes the exact viewed room/user');

    await control('mute').click();
    await page.locator('#toast [data-action="toast.undo"]').waitFor();
    const writesBeforeAccountChangeUndo = mutations().length;
    state.account = { user_id: 43, name: '另一个虚构账号' };
    await push();
    const readsBeforeAccountChangeUndo = refreshes().length;
    const staleUndo = page.locator('#toast [data-action="toast.undo"]');
    if (await staleUndo.isVisible()) await staleUndo.click();
    assert.equal(mutations().length, writesBeforeAccountChangeUndo, 'an old account toast must not unmute for a new account');
    assert.equal(refreshes().length, readsBeforeAccountChangeUndo, 'an old account toast must not read the old target under a new account');
    state.account = { user_id: 42, name: '虚构主播' };
    records.set('501', { muted: false, blacklisted: false, is_admin: false });
    state.moderation = moderation(501);
    await push();
    await open(viewerA);
    await ready();
    check('source mute undo cannot read or mutate after the account changes');

    await chooseHours('永久', -1);
    await control('mute').click();
    await control('unmute').waitFor();
    assert.equal(mutations().at(-1).payload.hours, -1);
    await control('unmute').click();
    await control('mute').waitFor();
    check('permanent mute sends minus one and can be removed');

    const writesBeforeBlacklistArm = mutations().length;
    await control('blacklist').click();
    assert.equal(mutations().length, writesBeforeBlacklistArm, 'the first inline blacklist click must only arm confirmation');
    assert.match(await control('blacklist').textContent(), /确认拉黑/);
    await control('blacklist').click();
    await control('unblacklist').waitFor();
    assert.deepEqual(mutations().at(-1), { action: 'bili.moderation.blacklist', payload: { user_id: '501', room_id: 999, confirmed: true } });
    assert.match(await host.locator('.viewer-block-row').textContent(), /已在直播间黑名单.*解除/s);
    await control('unblacklist').click();
    await control('blacklist').waitFor();
    assert.deepEqual(mutations().at(-1), { action: 'bili.moderation.unblacklist', payload: { user_id: '501', room_id: 999, confirmed: true } });
    check('live-room blacklist updates and removal use the same user and room without an account-blacklist action');

    const writesBeforeRefresh = mutations().length;
    const readsBeforeRefresh = refreshes().length;
    await refresh();
    await until(() => refreshes().length === readsBeforeRefresh + 1);
    await ready();
    assert.equal(mutations().length, writesBeforeRefresh);
    check('the retained production permission refresh only reads status without replaying a mutation');

    await chooseHours('24 小时', 24);
    await page.locator('#viewer-drawer #viewer-alias').fill('失败期间保留的读音');
    failMutation = 'bili.moderation.mute';
    const failedWritesBefore = mutations().length;
    const snapshotsBeforeFailure = snapshotReads;
    await control('mute').click();
    await page.locator('#toast.error').filter({ hasText: 'DV-B04' }).waitFor();
    await push();
    await push();
    await until(() => snapshotReads >= snapshotsBeforeFailure + 2);
    assert.equal(mutations().length, failedWritesBefore + 1);
    assert.equal(await page.locator('#viewer-drawer #viewer-alias').inputValue(), '失败期间保留的读音');
    assert.equal(await host.locator('#viewer-mute-hours').inputValue(), '24');
    assert.equal(await control('mute').isEnabled(), true);
    assert.equal(state.moderation.muted, false);
    check('a failed request keeps the alias and duration, and neither polling nor snapshots retries it');
    failMutation = '';
    await control('mute').click();
    await control('unmute').waitFor();
    assert.equal(mutations().length, failedWritesBefore + 2);
    await control('unmute').click();
    await control('mute').waitFor();
    check('an explicit user retry sends exactly one additional request');

    state.moderation = moderation(501, { muted: null });
    await push();
    assert.equal(await control('mute').isDisabled(), true);
    assert.equal(await control('blacklist').isEnabled(), true);
    state.moderation = moderation(501, { blacklisted: null });
    await push();
    assert.equal(await control('mute').isEnabled(), true);
    assert.equal(await control('blacklist').isDisabled(), true);
    check('unknown mute or blacklist status disables that operation until it is known');

    state.moderation = moderation(502);
    await push();
    await assertDisabled(/获授权/, false);
    assert.equal(mutations().length, failedWritesBefore + 3);
    await refresh();
    await ready();
    check('a status snapshot for a different user cannot enable the open user controls');

    deferredRefresh = { user_id: '501', started: false, resolve: null };
    await open(viewerA);
    await until(() => deferredRefresh.started);
    await open(viewerB);
    assert.equal(await host.locator('button[data-action]').evaluateAll(nodes => nodes.every(node => node.disabled)), true);
    const secondUserReads = refreshes().filter(call => call.payload.user_id === '502').length;
    const pending = deferredRefresh;
    deferredRefresh = null;
    state.moderation = moderation(501, { muted: true, blacklisted: true });
    pending.resolve(structuredClone(state));
    await until(() => refreshes().filter(call => call.payload.user_id === '502').length === secondUserReads + 1);
    await ready();
    assert.equal(await page.locator('#viewer-drawer .viewer-name').textContent(), viewerB.user_name);
    const staleTrace = await page.evaluate(name => window.__moderationTrace.filter(item => item.viewer === name && item.user_id === '501'), viewerB.user_name);
    assert.ok(staleTrace.length > 0, 'the late response was actually rendered against the new card');
    assert.equal(staleTrace.every(item => item.enabled.every(action => action === 'viewer.moderation.refresh')), true, JSON.stringify(staleTrace));
    assert.equal(state.moderation.user_id, '502');
    const writesBeforeIndependentArm = mutations().length;
    await control('blacklist').click();
    assert.equal(mutations().length, writesBeforeIndependentArm, 'independent blacklist permission also requires the inline second click');
    await control('blacklist').click();
    await control('unblacklist').waitFor();
    assert.equal(mutations().at(-1).payload.user_id, '502');
    await control('unblacklist').click();
    await control('blacklist').waitFor();
    check('a late response cannot enable another user controls and one catch-up read restores that user status');

    for (const item of [event(null, '无 UID 用户'), event(0, '零 UID 用户'), event('bad-uid', '非法 UID 用户'), event('18446744073709551616', '超出范围 UID 用户'), event(503, '虚构神秘人', { mystery: true }), event(42, '虚构主播')]) {
      const reads = refreshes().length;
      const writes = mutations().length;
      await open(item);
      await assertDisabled(item.user_id === 42 ? /自己/ : /没有公开 UID/);
      assert.equal(refreshes().length, reads);
      assert.equal(mutations().length, writes);
    }
    check('missing, zero, malformed, overflowing and mystery UIDs plus self cannot be read or moderated');

    await open(viewerA);
    await ready();
    state.account = {};
    state.moderation = moderation(501);
    await push();
    await assertDisabled(/扫码登录/);
    const loggedOutReads = refreshes().length;
    await refresh();
    assert.equal(refreshes().length, loggedOutReads);
    check('logout disables previously authorized controls even when a stale permission snapshot remains');

    await assertQrOnlyRoomSettings(false);
    await open(viewerA);
    await assertDisabled(/扫码登录/);
    assert.equal(refreshes().length, loggedOutReads);
    check('signed-out room settings offer QR login without anonymous entry, and reopening a viewer stays disabled');

    state.account = { user_id: 42, name: '虚构主播' };
    state.network_disabled = true;
    state.moderation = moderation(501);
    await push();
    await assertDisabled(/离线测试窗口/);
    check('offline test mode disables all moderation controls despite retained authorization');

    state.network_disabled = false;
    refreshPermission = false;
    state.moderation = moderation(501, { can_moderate: false, can_blacklist: false, can_manage_admins: false });
    await push();
    await assertDisabled(/获授权/, false);
    const noAuthorityWrites = mutations().length;
    await refresh();
    await assertDisabled(/获授权/, false);
    assert.equal(mutations().length, noAuthorityWrites);
    check('an account without room authority can refresh permissions but cannot change user status');

    refreshPermission = true;
    refreshBlacklist = false;
    refreshManageAdmins = false;
    await refresh();
    await ready();
    assert.equal(await control('blacklist').isDisabled(), true);
    assert.equal(await control('appoint').isDisabled(), true);
    assert.equal(await control('appoint').isDisabled(), true);
    const roomModeratorWrites = mutations().length;
    await page.evaluate(() => document.querySelector('#viewer-drawer [data-action="viewer.moderation.appoint"]').click());
    assert.equal(mutations().length, roomModeratorWrites);
    await page.evaluate(() => document.querySelector('#viewer-drawer [data-action="viewer.moderation.blacklist"]').click());
    assert.equal(mutations().length, roomModeratorWrites);
    check('an ordinary authorized room moderator can mute but cannot blacklist or appoint another moderator');

    state.moderation = moderation(501, { can_moderate: false, can_blacklist: true, can_manage_admins: false });
    await push();
    assert.equal(await control('mute').isDisabled(), true);
    assert.equal(await control('appoint').isDisabled(), true);
    assert.equal(await control('blacklist').isEnabled(), true);
    const independentWrites = mutations().length;
    await control('blacklist').click();
    assert.equal(mutations().length, independentWrites);
    await control('blacklist').click();
    await control('unblacklist').waitFor();
    assert.equal(await control('unblacklist').isEnabled(), true);
    await control('unblacklist').click();
    await control('blacklist').waitFor();
    assert.equal(await control('mute').isDisabled(), true);
    check('independent live-blacklist permission can block and unblock while mute and room-admin appointment remain unavailable');

    refreshBlacklist = true;
    await refresh();
    await ready();
    assert.equal(await control('blacklist').isEnabled(), true);
    assert.equal(await control('appoint').isDisabled(), true);
    const seniorWrites = mutations().length;
    await control('blacklist').click();
    assert.equal(mutations().length, seniorWrites);
    await control('blacklist').click();
    await control('unblacklist').waitFor();
    await control('unblacklist').click();
    await control('blacklist').waitFor();
    check('a senior moderator with live-blacklist permission can block and unblock but still cannot appoint room admins');

    refreshManageAdmins = true;
    await refresh();
    await ready();
    assert.equal(await control('appoint').isEnabled(), true);
    await control('appoint').click();
    await control('dismiss').waitFor();
    assert.deepEqual(mutations().at(-1), { action: 'bili.moderation.appoint', payload: { user_id: '501', room_id: 999, confirmed: true } });
    await refresh();
    await control('dismiss').waitFor();
    assert.equal(await control('dismiss').isEnabled(), true);
    assert.equal(state.moderation.is_admin, true);
    await control('dismiss').click();
    await control('appoint').waitFor();
    assert.deepEqual(mutations().at(-1), { action: 'bili.moderation.dismiss', payload: { user_id: '501', room_id: 999, confirmed: true } });
    assert.equal(state.moderation.is_admin, false);
    check('the owner can appoint and dismiss the same target, and refreshing recognizes the appointed status');

    state.moderation.is_admin = null;
    await push();
    assert.equal(await control('appoint').isDisabled(), true);
    assert.equal(await control('mute').isEnabled(), true);
    await refresh();
    await ready();
    check('unknown room-admin status disables appointment until a successful status refresh');

    await page.locator('#toast').waitFor({ state: 'hidden' });
    deferredMutation = { action: 'bili.moderation.mute' };
    const consoleReply = structuredClone(state);
    consoleReply.moderation.muted = true;
    await control('mute').click();
    await until(() => deferredMutation.started);
    state.preferences.broadcast_console = false;
    await push();
    deferredMutation.resolve(consoleReply);
    deferredMutation = null;
    await page.waitForFunction(() => !window.__moderationFixtureBusy());
    assert.equal(await host.isVisible(), false);
    assert.equal(await page.locator('#toast').isVisible(), false);
    assert.equal((await page.evaluate(() => window.__moderationFixtureIdentity())).console, false);
    state.preferences.broadcast_console = true;
    await push();
    await ready();
    check('an old moderation response cannot reopen a disabled console or show success after the feature is turned off');

    deferredMutation = { action: 'bili.moderation.mute' };
    const logoutReply = structuredClone(state);
    logoutReply.moderation.muted = true;
    await control('mute').click();
    await until(() => deferredMutation.started);
    state.account = {};
    await push();
    deferredMutation.resolve(logoutReply);
    deferredMutation = null;
    await page.waitForFunction(() => !window.__moderationFixtureBusy());
    await assertDisabled(/登录/);
    assert.equal(await page.locator('#toast').isVisible(), false);
    assert.equal((await page.evaluate(() => window.__moderationFixtureIdentity())).account, undefined);
    state.account = { user_id: 42, name: '虚构主播' };
    await push();
    await ready();
    check('an old moderation response cannot restore a logged-out account, enable mutations or show a success toast');

    refreshPermission = true;
    state.preferences.language = 'en';
    state.preferences.appearance = 'light';
    await push();
    await open(viewerA);
    await ready();
    assert.match(await host.textContent(), /Current room.*Block in room/s);
    assert.match(await control('mute').textContent(), /^Mute /);
    assert.equal(await control('refresh').count(), 0);
    assert.equal(await control('appoint').getAttribute('aria-label'), 'Appoint moderator');
    assert.equal(await host.locator('#viewer-mute-hours').getAttribute('aria-label'), 'Mute duration');
    assert.deepEqual(await host.locator('#viewer-mute-hours option').evaluateAll(nodes => nodes.map(node => node.label)), ['This stream', '1 hour', '24 hours', '7 days', 'Permanent']);
    assert.equal(await page.locator('#viewer-drawer .viewer-name').textContent(), viewerA.user_name);
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, 'moderation-en-light.png') });
    check('English translates moderation labels and durations while preserving the original viewer name');

    await close();
    state.preferences.language = 'zh-CN';
    state.preferences.appearance = 'dark';
    await push();
    await page.setViewportSize({ width: 640, height: 560 });
    await open(viewerA);
    await ready();
    const bounds = await page.locator('#viewer-drawer .viewer-sheet').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 640 && bounds.y + bounds.height <= 560, JSON.stringify(bounds));
    assert.equal(await page.locator('#viewer-drawer .viewer-sheet').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.locator('#viewer-drawer .viewer-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const moderationBounds = await host.boundingBox();
    assert.ok(moderationBounds.x >= bounds.x && moderationBounds.x + moderationBounds.width <= bounds.x + bounds.width + 1);
    assert.equal(await control('blacklist').isVisible(), true);
    for (const action of ['mute', 'blacklist', 'appoint']) {
      const actionBounds = await control(action).boundingBox();
      assert.ok(actionBounds.y >= bounds.y && actionBounds.y + actionBounds.height <= bounds.y + bounds.height + 1, `${action}: ${JSON.stringify(actionBounds)}`);
    }
    await page.screenshot({ path: path.join(output, 'moderation-zh-dark-compact.png') });
    check('compact dark layout keeps the scrollable card and management rows inside the window without horizontal overflow');

    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ evidence: 'headless Edge with fictional IPC and blocked external traffic; no live account or API acceptance', checks, moderation_reads: refreshes().length, moderation_writes: mutations().length }, null, 2));
    console.log(`${checks.length} moderation UI checks passed`);
  } finally {
    if (deferredRefresh?.resolve) deferredRefresh.resolve(structuredClone(state));
    if (deferredMutation?.resolve) deferredMutation.resolve(structuredClone(state));
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
