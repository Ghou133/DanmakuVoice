import { errorMessage, mergeSnapshot, audienceUsers, audienceDisplayCount } from './helpers.mjs';

test('audience list searches confirmed viewers safely and clears when the room stops', () => {
  const snapshot = { live: { running: true, audience: { active: true, live_status: 1, rank_count: 9999, users: [{ user_id: 42, user_name: '<Viewer>' }, { user_id: null, user_name: '神秘人', mystery: true }] }, events: [
    { user_id: 7, user_name: 'Chatter', kind: 'danmaku', message: 'hello' },
  ] } };
  assert.equal(audienceUsers(snapshot, '42')[0].user_name, '<Viewer>');
  assert.equal(audienceUsers(snapshot, 'viewer').length, 1);
  assert.equal(audienceUsers(snapshot, 'missing').length, 0);
  assert.equal(audienceUsers(snapshot, 'chatter').length, 0, 'chat senders are not presented as confirmed viewers');
  assert.equal(audienceUsers(snapshot).length, 2);
  snapshot.live.running = false;
  assert.equal(audienceUsers(snapshot).length, 0);
});

test('audience excludes a verified self once and never guesses from an empty list or a name', () => {
  const self = { user_id: 42, user_name: 'Me' };
  const snapshot = { account: { user_id: 42, name: 'Me' }, live: { running: true, audience: { active: true, live_status: 1, rank_count_text: '1', users: [self] } } };
  assert.equal(audienceDisplayCount(snapshot), '0');
  assert.equal(audienceUsers(snapshot).length, 0);
  snapshot.live.audience.users.push(self);
  assert.equal(audienceDisplayCount(snapshot), '0', 'duplicate pages cannot subtract self twice');
  snapshot.live.audience.rank_count_text = '9999+';
  assert.equal(audienceDisplayCount(snapshot), '9998+');
  snapshot.live.audience.rank_count_text = '1';
  snapshot.live.audience.users = [{ user_id: 7, user_name: 'Me' }];
  assert.equal(audienceDisplayCount(snapshot), '1');
  assert.equal(audienceUsers(snapshot).length, 1);
  snapshot.live.audience.users = [];
  assert.equal(audienceDisplayCount(snapshot), '1', 'an anonymous/partial list does not prove self inclusion');
  snapshot.live.audience.users = [{ ...self, mystery: true }];
  assert.equal(audienceDisplayCount(snapshot), '1');
  snapshot.account.user_id = null;
  snapshot.live.audience.users = [self];
  assert.equal(audienceDisplayCount(snapshot), '1');
});

test('unbroadcast rooms show zero despite active reception, and unknown state is unavailable', () => {
  const snapshot = { live: { running: true, audience: { active: true, live_status: 0, rank_count_text: '1', users: [{ user_id: 7, user_name: 'Old' }] } } };
  assert.equal(audienceDisplayCount(snapshot), '0');
  assert.equal(audienceUsers(snapshot).length, 0);
  snapshot.live.audience.live_status = 2;
  assert.equal(audienceDisplayCount(snapshot), '0');
  snapshot.live.audience.live_status = null;
  assert.equal(audienceDisplayCount(snapshot), null);
  snapshot.live.audience.live_status = 1;
  snapshot.live.audience.error = 'Network failure';
  assert.equal(audienceDisplayCount(snapshot), null);
});

test('support codes survive wrapping and runtime display without duplicated generic labels', () => {
  const original = 'FFmpeg 无法启动（系统错误 5） [DV-C02]';
  assert.equal(errorMessage(new Error(original)), original);
  assert.equal(errorMessage(errorMessage(original)), original);
  assert.equal(runtimeIssue({ queue: { history: [{ state: 'failed', detail: original }] } }), `播报未能播放：${original}`);
  assert.equal(errorMessage('保存失败 [DV-S01]；草稿已保留'), '保存失败；草稿已保留 [DV-S01]');
  assert.equal(errorMessage('保存失败'), '保存失败 [DV-UI01]');
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, headerIdentity, initial, eventText, eventKeys, validUid, numericId, safeQrUrl, safeMediaUrl, messageParts, playbackCaption, playbackFallbackNotice, startingStep, runtimeIssue, liveConnectionView, snapshotPollingPolicy, uiIsActive, qrNeedsRoomFallback } from './helpers.mjs';

test('voice settings keep read-only observations active during onboarding', () => {
  assert.equal(snapshotPollingPolicy({}, { step: 'login', settingsOpen: true }).poll, true);
  assert.equal(snapshotPollingPolicy({}, { step: 'login', settingsOpen: false }).poll, false);
  assert.equal(snapshotPollingPolicy({}, { step: 'login', settingsOpen: true, hidden: true }).poll, false);
  assert.equal(snapshotPollingPolicy({}, { step: 'login', settingsOpen: true, focused: false }).poll, false);
});

test('header uses only the logged-in account and blocks unsafe or offline avatar requests', () => {
  assert.equal(headerIdentity({account:{name:'stale user'}}).name, '超绝可爱弹幕姬');
  for (const user_id of [0, '0', -1, 'anonymous-42', '18446744073709551616']) {
    const identity = headerIdentity({ account:{user_id,name:'stale user'}, setup:{mode:'anonymous',uid:77,room_id:12} });
    assert.equal(identity.loggedIn, false);
    assert.equal(identity.name, '超绝可爱弹幕姬');
  }
  assert.equal(headerIdentity({account:{user_id:42}}).name, '哔哩哔哩用户');
  const state = {account:{user_id:42,name:'当前账号',avatar_url:'https://i0.hdslb.com/bfs/face/avatar.jpg'}};
  assert.equal(headerIdentity(state).avatar, state.account.avatar_url);
  assert.equal(headerIdentity({...state,network_disabled:true}).avatar, '');
  assert.equal(headerIdentity({account:{...state.account,avatar_url:'https://evil.example/image.jpg'}}).avatar, '');
  assert.equal(headerIdentity({...state,setup:{mode:'anonymous',uid:77,room_id:12}}).name, '当前账号');
});

test('untrusted danmaku and attribute text cannot introduce HTML', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">&\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(initial('😀名字'), '😀');
});

test('QR rendering accepts raster data from the backend, not executable or remote content', () => {
  assert.equal(safeQrUrl('data:image/png;base64,YWJjZA=='), 'data:image/png;base64,YWJjZA==');
  for (const unsafe of ['https://example.com/qr.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,YWJj', 'data:image/png;base64,abc" onload="alert(1)', null]) assert.equal(safeQrUrl(unsafe), '');
});

test('ring-buffer evictions preserve message identity and duplicate messages remain separate', () => {
  const first = { room_id: 1, observed_at_ms: 1, user_name: '小明', kind: 'danmaku', message: '你好' };
  const second = { ...first, observed_at_ms: 2 };
  const third = { ...first, observed_at_ms: 3 };
  assert.deepEqual(eventKeys([first, second, third]).slice(1), eventKeys([second, third]));
  assert.notEqual(...eventKeys([first, first]));
  const serverId = { ...first, platform_event_id: 'server-1' };
  assert.equal(eventKeys([serverId])[0], eventKeys([{ ...serverId, observed_at_ms: 500 }])[0]);
});

test('UID validation rejects empty, signed, decimal, exponent and overflow inputs', () => {
  for (const invalid of ['', '0', '-1', '+123', '1e5', '123.4', '00123', '18446744073709551616', '<b>1</b>']) assert.equal(validUid(invalid), false, invalid);
  assert.equal(validUid(' 123456 '), true);
  assert.equal(validUid('18446744073709551615'), true);
  assert.throws(() => numericId('9007199254740993'), /精确整数/);
  assert.equal(numericId('123456'), 123456);
});

test('onboarding requires an account and its room before resuming saved online setup', () => {
  assert.equal(startingStep({}), 'welcome');
  assert.equal(startingStep({ setup: { room_id: 12 } }), 'login');
  assert.equal(startingStep({ onboarding_done: true }), 'login');
  assert.equal(startingStep({ onboarding_done: true, setup:{mode:'anonymous',uid:77,room_id:12}, account:{} }), 'login');
  const loggedIn = {account:{user_id:42},setup:{mode:'account',uid:42,room_id:12}};
  assert.equal(startingStep(loggedIn), 'tts');
  assert.equal(startingStep({ ...loggedIn, setup: {...loggedIn.setup,tts_enabled:true}, rules:{default_preset_id:'a'}, presets:[{id:'a'}] }), 'ready');
  assert.equal(startingStep({ ...loggedIn, onboarding_done:true }), 'main');
  assert.equal(startingStep({ ...loggedIn, onboarding_done:true, live:{running:true,state:'connected'} }), 'main');
  assert.equal(startingStep({ account:{user_id:42}, onboarding_done:true, setup:{} }), 'login');
});

test('legacy anonymous and other-user targets return to authenticated own-room resolution', () => {
  const loggedIn = {account:{user_id:42},onboarding_done:true};
  assert.equal(startingStep({...loggedIn,setup:{mode:'anonymous',uid:77,room_id:12}}), 'login');
  assert.equal(startingStep({...loggedIn,setup:{mode:'anonymous',uid:42,room_id:12}}), 'login');
  assert.equal(startingStep({...loggedIn,setup:{mode:'account',uid:77,room_id:12}}), 'login');
  assert.equal(startingStep({onboarding_done:true,account:{name:'stale user'},setup:{mode:'account',room_id:12}}), 'login');
});

test('explicit offline fixtures can exercise local setup without enabling real anonymous reception', () => {
  assert.equal(startingStep({network_disabled:true}), 'welcome');
  assert.equal(startingStep({network_disabled:true,setup:{mode:'anonymous',room_id:12}}), 'tts');
  assert.equal(startingStep({network_disabled:true,setup:{room_id:12,tts_enabled:true},rules:{default_preset_id:'a'},presets:[{id:'a'}]}), 'ready');
  assert.equal(startingStep({network_disabled:true,onboarding_done:true}), 'main');
  assert.equal(startingStep({network_disabled:false,onboarding_done:true,setup:{mode:'anonymous',room_id:12}}), 'login');
});

test('missing own-room status requires a real account after QR login', () => {
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: { user_id: 12 }, setup: { room_id: null } }), true);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: { user_id: 12 }, setup: { room_id: 34 } }), false);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: {}, setup: {} }), false);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'doubao', status: 'expired' }, account: { user_id: 12 }, setup: {} }), false);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'waiting' }, account: { user_id: 12 }, setup: {} }), false);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: { user_id: '0' }, setup: {} }), false);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: { user_id: 12 }, setup: {room_id:0} }), true);
});

test('event text preserves real messages and represents gifts and guards', () => {
  assert.equal(eventText({ kind: 'danmaku', message: '<script>hello</script>' }), '<script>hello</script>');
  assert.equal(eventText({ kind: 'gift', gift_name: '鲜花', quantity: 3 }), '送出 鲜花 × 3');
  assert.equal(eventText({ kind: 'guard', guard_name: '舰长' }), '开通了舰长');
});

test('Bilibili avatar and emote URLs are restricted to the image CDN', () => {
  assert.equal(safeMediaUrl('//i0.hdslb.com/bfs/face/a.jpg'), 'https://i0.hdslb.com/bfs/face/a.jpg');
  for (const url of ['http://i0.hdslb.com/bfs/face/a.jpg', 'https://i0.hdslb.com.evil.test/bfs/face/a.jpg', 'https://i0.hdslb.com/other/a.jpg', 'javascript:alert(1)', 'https://i0.hdslb.com/bfs/a.svg']) assert.equal(safeMediaUrl(url), '', url);
});

test('emotes replace only matching text and keep untrusted content as text', () => {
  assert.deepEqual(messageParts({ kind: 'danmaku', message: '好[妙] <img>', emotes: [{ text: '[妙]', url: 'https://i0.hdslb.com/bfs/live/a.png' }] }), [
    { type: 'text', text: '好' },
    { type: 'emote', text: '[妙]', url: 'https://i0.hdslb.com/bfs/live/a.png' },
    { type: 'text', text: ' <img>' },
  ]);
  assert.deepEqual(messageParts({ kind: 'danmaku', message: '[妙]', emotes: [{ text: '[妙]', url: 'https://evil.test/a.png' }] }), [{ type: 'text', text: '[妙]' }]);
});

test('large emotes follow explicit metadata, not whether the emote fills the message', () => {
  const base = { kind: 'danmaku', message: '[妙]' };
  const image = { text: '[妙]', url: 'https://i0.hdslb.com/bfs/live/a.png' };
  assert.deepEqual(messageParts({ ...base, emotes: [{ ...image, large: true }] }), [{ type: 'emote', ...image, large: true }]);
  assert.deepEqual(messageParts({ ...base, emotes: [{ ...image, large: false }] }), [{ type: 'emote', ...image }]);
});

test('playback caption uses the rendered speech text only once', () => {
  assert.equal(playbackCaption({ current: { user_name: '小明', text: '小明说：你好' } }), '小明说：你好');
  assert.equal(playbackCaption({ pending: [{}, {}] }), '等待播报 · 2 条');
});

test('only a completed fallback gets a brief status without speech text', () => {
  const record = { id: 7, state: 'played', detail: '指定的 dots.tts 不可用（无法连接服务），本条临时使用默认 GPT-SoVITS；播报完成' };
  assert.equal(playbackFallbackNotice(record), 'dots.tts 无法连接服务，已用首选 GPT-SoVITS 播报');
  for (const [selected, preferred] of [['GPT-SoVITS', 'Fish Audio'], ['Fish Audio', '豆包'], ['豆包', 'dots.tts']]) {
    assert.equal(
      playbackFallbackNotice({ ...record, detail: `指定的 ${selected} 不可用（生成前失败），本条临时使用默认 ${preferred}；播报完成` }),
      `${selected} 生成前失败，已用首选 ${preferred} 播报`,
    );
  }
  assert.equal(
    playbackFallbackNotice({ ...record, detail: '指定的 Fish Audio 合成失败（尚未播放音频），本条临时使用默认 豆包；播报完成' }),
    'Fish Audio 合成失败（尚未播放音频），已用首选 豆包 播报',
  );
  assert.equal(playbackFallbackNotice({ ...record, state: 'failed' }), '');
  assert.equal(playbackFallbackNotice({ ...record, detail: '播报完成' }), '');
  assert.equal(playbackFallbackNotice({ ...record, detail: '小明说：你好' }), '');
});

test('asynchronous speech failures are actionable instead of appearing healthy', () => {
  assert.equal(runtimeIssue({ status: { error: true, message: '设备已断开' } }), '设备已断开 [DV-X00]');
  assert.match(runtimeIssue({ queue: { history: [{ state: 'failed', detail: 'timeout' }] } }), /未能播放/);
  assert.equal(runtimeIssue({ queue: { history: [{ state: 'failed' }, { state: 'played' }] } }), '');
  assert.match(runtimeIssue({ live: { running: true, no_voice: 1 }, setup: { tts_enabled: true }, rules: {} }), /未能播报/);
  assert.equal(runtimeIssue({ live: { running: true, no_voice: 1 }, setup: { tts_enabled: false }, rules: {} }), '');
  assert.match(runtimeIssue({ live: { running: true, errors: 1 } }), /接收或播报错误/);
  assert.equal(runtimeIssue({ live: { running: false, errors: 1 } }), '');
  assert.equal(runtimeIssue({ live: { state: 'reconnecting', running: true } }), '');
  assert.match(runtimeIssue({ live: { state: 'session_expired', running: false } }), /重新扫码/);
  assert.match(runtimeIssue({ live: { running: true }, received_emotes_error: '读取超时' }), /个人表情信息读取失败.*读取超时/);
  assert.equal(runtimeIssue({ live: { running: false }, received_emotes_error: '读取超时' }), '');
});

test('playback failures preserve the engine diagnosis with an empty-detail fallback', () => {
  for (const detail of [
    '豆包 响应无效：登录状态无效，请重新登录（710012001）',
    '豆包 返回 HTTP 403：账号或设备语音请求受限',
    '豆包 连接请求失败：连接超时',
    '音频解码失败或文件不完整',
  ]) {
    assert.equal(runtimeIssue({ queue: { history: [{ state: 'failed', detail }] } }), `播报未能播放：${detail} [DV-Q01]`);
  }
  for (const detail of [undefined, null, '  ', {}]) {
    assert.match(runtimeIssue({ queue: { history: [{ state: 'failed', detail }] } }), /请检查声音服务和输出设备/);
  }
});

test('live connection display follows the actual room state', () => {
  assert.equal(liveConnectionView({ running: true, state: 'connecting' }).online, false);
  assert.equal(liveConnectionView({ running: true, state: 'reconnecting' }).pending, true);
  assert.match(liveConnectionView({ running: true, state: 'reconnecting' }).caption, /重连/);
  assert.equal(liveConnectionView({ running: true, state: 'connected' }).online, true);
  assert.equal(liveConnectionView({ running: false, state: 'connected' }).online, false);
  assert.match(liveConnectionView({ running: false, state: 'session_expired' }).caption, /登录已失效/);
});

test('snapshot polling sleeps during setup and stays responsive for live playback', () => {
  const idle = { live: { running: false, connecting: false }, queue: { current: null, pending: [] } };
  assert.deepEqual(snapshotPollingPolicy(idle, { step: 'login' }), { poll: false, delay: 5000 });
  assert.deepEqual(snapshotPollingPolicy(idle), { poll: true, delay: 5000 });
  assert.deepEqual(snapshotPollingPolicy({ ...idle, live: { running: true } }), { poll: true, delay: 800 });
  assert.deepEqual(snapshotPollingPolicy({ ...idle, queue: { current: { id: 1 } } }, { step: 'tts' }), { poll: true, delay: 800 });
  assert.deepEqual(snapshotPollingPolicy({ ...idle, local_services: { dots: { state: 'starting' } } }, { step: 'tts' }), { poll: true, delay: 800 });
  assert.deepEqual(snapshotPollingPolicy({ ...idle, local_services: { gpt_sovits: { state: 'checking' } } }, { step: 'tts' }), { poll: true, delay: 800 });
  assert.deepEqual(snapshotPollingPolicy({ ...idle, local_services: { dots: { state: 'stopped' } } }, { step: 'tts' }), { poll: false, delay: 5000 });
  assert.deepEqual(snapshotPollingPolicy({ ...idle, local_services: { dots: { state: 'starting' } } }, { hidden: true, step: 'tts' }), { poll: false, delay: 5000 });
  assert.deepEqual(snapshotPollingPolicy({ ...idle, queue: { pending: [{ id: 1 }] } }, { hidden: true }), { poll: false, delay: 5000 });
  assert.equal(snapshotPollingPolicy({ live: { connecting: true } }, { busy: true }).poll, false);
  assert.deepEqual(snapshotPollingPolicy({ live: { running: true } }, { focused: false }), { poll: false, delay: 5000 });
  assert.equal(uiIsActive(true, false, false), true, 'native title-bar activation overrides stale DOM focus');
  assert.equal(uiIsActive(false, true, false), false, 'native minimization overrides stale DOM focus');
  assert.equal(uiIsActive(null, true, false), true, 'browser-only fixtures retain focus fallback');
  assert.equal(uiIsActive(true, true, true), false, 'hidden documents do not poll');
});


test('incremental snapshots retain settings, drop transient results and reject stale revisions', () => {
  const config = { config_revision: 4, presets: [{id:'voice'}], rules: { default_preset_id:'voice' }, live: { received:1 }, result: 'old operation' };
  const merged = mergeSnapshot(config, { config_revision:4, config_unchanged:true, live:{received:2} });
  assert.equal(merged.presets, config.presets);
  assert.equal(merged.rules, config.rules);
  assert.equal(merged.live.received, 2);
  assert.equal(merged.result, undefined);
  assert.throws(() => mergeSnapshot(config, {config_revision:5, config_unchanged:true}));
  assert.throws(() => mergeSnapshot(null, {config_revision:4, config_unchanged:true}));
  const replacement = {config_revision:5, config_unchanged:false, presets:[]};
  assert.equal(mergeSnapshot(config, replacement), replacement);
});


test('late poll replies cannot roll back a newer saved configuration or its runtime', () => {
  const current = { config_revision: 7, preferences: { language: 'en' }, rules: { user_words: [{ from: '观众', to: '新读音' }] }, live: { state: 'connected' }, result: 'old operation' };
  for (const late of [
    { config_revision: 6, preferences: { language: 'zh-CN' }, rules: { user_words: [] }, live: { state: 'stopped' } },
    { config_revision: 6, config_unchanged: true, live: { state: 'stopped' } },
  ]) {
    assert.deepEqual(mergeSnapshot(current, late), { ...current, result: undefined });
  }
  const next = { config_revision: 8, preferences: { language: 'zh-CN' }, live: { state: 'stopped' } };
  assert.equal(mergeSnapshot(current, next), next);
});
