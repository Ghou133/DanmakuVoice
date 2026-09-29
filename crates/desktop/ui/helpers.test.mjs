import { errorMessage, mergeSnapshot } from './helpers.mjs';

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

test('header uses only the logged-in account and blocks unsafe or offline avatar requests', () => {
  assert.equal(headerIdentity({account:{name:'stale user'}}).name, '超绝可爱弹幕姬');
  assert.equal(headerIdentity({account:{user_id:42}}).name, '哔哩哔哩用户');
  const state = {account:{user_id:42,name:'当前账号',avatar_url:'https://i0.hdslb.com/bfs/face/avatar.jpg'}};
  assert.equal(headerIdentity(state).avatar, state.account.avatar_url);
  assert.equal(headerIdentity({...state,network_disabled:true}).avatar, '');
  assert.equal(headerIdentity({account:{...state.account,avatar_url:'https://evil.example/image.jpg'}}).avatar, '');
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

test('onboarding resumes from saved state without fabricating successful setup', () => {
  assert.equal(startingStep({}), 'welcome');
  assert.equal(startingStep({ setup: { room_id: 12 } }), 'tts');
  assert.equal(startingStep({ setup: { room_id: 12, tts_enabled: true }, rules: { default_preset_id: 'a' }, presets: [{ id: 'a' }] }), 'ready');
  assert.equal(startingStep({ onboarding_done: true }), 'main');
});

test('QR room fallback is shown only after account login without a resolved room', () => {
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: { user_id: 12 }, setup: { room_id: null } }), true);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: { user_id: 12 }, setup: { room_id: 34 } }), false);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'bilibili', status: 'expired' }, account: {}, setup: {} }), false);
  assert.equal(qrNeedsRoomFallback({ qr: { provider: 'doubao', status: 'expired' }, account: { user_id: 12 }, setup: {} }), false);
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
  assert.throws(() => mergeSnapshot(config, {config_revision:3, config_unchanged:true}));
  assert.throws(() => mergeSnapshot(null, {config_revision:4, config_unchanged:true}));
  const replacement = {config_revision:5, config_unchanged:false, presets:[]};
  assert.equal(mergeSnapshot(config, replacement), replacement);
});
