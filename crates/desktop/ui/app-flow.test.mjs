import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAutosaveQueue } from './autosave.mjs';
import { errorMessage, deviceValue, mergeSnapshot, escapeHtml, headerIdentity, initial, messageParts, numericId, playbackIssue, playbackFallbackNotice, qrNeedsRoomFallback, uiIsActive, validUid } from './helpers.mjs';

function appContext() {
  const surface = { listeners: {}, addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const document = { querySelector(selector) { return selector?.startsWith('[data-brand') ? null : surface; }, addEventListener() {}, hasFocus() { return true; }, documentElement: { dataset: {} } };
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    matchMedia: () => ({ addEventListener() {} }),
    createAutosaveQueue: () => ({ schedule() {}, flush: async () => {} }),
    mountSelects() {}, closeSelect() {}, stripSelects() {},
    crypto: { randomUUID: () => 'stable-role-id' },
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.fields[key] ?? null; } has(key) { return Object.hasOwn(this.form.fields, key); } },
    esc: escapeHtml,
    errorMessage,
    mergeSnapshot,
    providerLabel: provider => provider,
    structuredClone,
    headerIdentity,
    initial,
    messageParts,
    numericId,
    playbackFallbackNotice,
    playbackIssue,
    qrNeedsRoomFallback,
    uiIsActive,
    validUid,
    deviceValue,
    setTimeout,
    clearTimeout,
  });
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/\bvoid boot\(\);\s*$/, '');
  vm.runInContext(source, context, { filename: 'app.js' });
  vm.runInContext(`snapshot = {
    connections: [{ id: 'dots-connection', name: 'dots', settings: { provider: 'dots' } }],
    presets: [], rules: { default_preset_id: null }
  }; editor = { type: 'preset', id: '', connectionId: 'dots-connection', makePreferred: true }; referenceProfiles = [];`, context);
  return context;
}

test('audition page receives asynchronous playback diagnostics without closing settings', () => {
  const context = appContext();
  const alert = { textContent: '', hidden: true };
  context.document.querySelector = selector => selector === '#voice-playback-error, #audio-playback-error' ? alert : null;
  vm.runInContext(`snapshot.queue = { history: [{ state: 'failed', detail: '豆包 响应无效：登录状态无效（710012001）' }] }; updateServiceIndicators();`, context);
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /710012001/);
  vm.runInContext(`snapshot.queue.history.push({ state: 'played' }); updateServiceIndicators();`, context);
  assert.equal(alert.hidden, true);
  assert.equal(alert.textContent, '');
  assert.match(vm.runInContext('renderVoiceAudition([], null)', context), /id="voice-playback-error"[^>]*role="alert"/);
});

test('audio settings offer a local sound test and show asynchronous output errors', async () => {
  const context = appContext();
  context.calls = [];
  vm.runInContext(`snapshot.preferences = { output: {kind:'default'} }; command = async action => calls.push(action); flushAutosaves = async () => true;`, context);
  const html = vm.runInContext('renderAudioSettings()', context);
  assert.match(html, /data-action="audio.test"/);
  assert.match(html, /id="audio-playback-error"/);
  await vm.runInContext("handleAction('audio.test', '', null)", context);
  assert.deepEqual(Array.from(context.calls), ['audio.test']);
});

test('header identity updates after login and logout without repeated image loads', () => {
  const context = appContext();
  let writes = 0;
  const portrait = { dataset: {}, value: '', set innerHTML(value) { writes++; this.value = value; } };
  const name = { textContent: '', title: '' };
  context.document.querySelector = selector => selector === '[data-brand-portrait]' ? portrait : name;
  vm.runInContext(`snapshot.account = {user_id:42,name:'桃子<测试>',avatar_url:'https://i0.hdslb.com/bfs/face/avatar.jpg'}; updateHeaderIdentity();`, context);
  assert.equal(name.textContent, '桃子<测试>');
  assert.match(portrait.value, /account-photo/);
  assert.equal(writes, 1);
  vm.runInContext('updateHeaderIdentity();', context);
  assert.equal(writes, 1, 'unchanged snapshots must not reload the avatar');
  vm.runInContext(`snapshot.account = {}; updateHeaderIdentity();`, context);
  assert.equal(name.textContent, '超绝可爱弹幕姬');
  assert.match(portrait.value, /logo.png/);
  assert.doesNotMatch(portrait.value, /avatar.jpg/);
});

test('offline onboarding does not attempt a QR request', async () => {
  const context = appContext();
  context.document.querySelectorAll = () => [];
  vm.runInContext('snapshot.network_disabled = true;', context);
  await vm.runInContext("startQr('bilibili')", context);
  assert.equal(vm.runInContext('qrBusy', context), false);
  assert.equal(vm.runInContext('qrFailure', context), '');
});

test('service indicators distinguish account configuration, local checks, startup and failures', () => {
  const context = appContext();
  const status = vm.runInContext('providerStatus', context);
  for (const provider of ['doubao', 'fish_audio']) {
    assert.equal(status(provider, { has_credential: true }).tone, 'ready');
    assert.equal(status(provider, { has_credential: false }).tone, 'idle');
    assert.equal(status(provider, null).tone, 'idle');
    assert.doesNotMatch(status(provider, { has_credential: true }).label, /在线|就绪/);
  }
  for (const provider of ['dots', 'gpt_sovits']) {
    for (const [state, tone, label] of [
      ['checking', 'pending', '正在检查'], ['starting', 'pending', '正在启动'],
      ['ready', 'ready', '服务已就绪'], ['failed', 'error', '连接异常'], ['stopped', 'idle', '已停止'],
    ]) {
      context.localState = { [provider]: { state, message: '具体诊断' } };
      vm.runInContext('snapshot.local_services = localState', context);
      assert.equal(status(provider, {}).tone, tone);
      assert.equal(status(provider, {}).label, label);
      assert.equal(status(provider, {}).detail, '具体诊断');
    }
    vm.runInContext('snapshot.local_services = {}', context);
    assert.equal(status(provider, {}).label, '待检查', 'external service connections do not require an install directory');
  }
});

test('dynamic indicators update lamp, tooltip and accessible name together without replacing a form', () => {
  const context = appContext();
  let writes = 0;
  const attrs = () => ({ values: {}, getAttribute(key) { return this.values[key] ?? null; }, setAttribute(key, value) { writes++; this.values[key] = value; } });
  const light = { className: '' };
  const label = { ...attrs(), textContent: '' };
  const choice = attrs();
  const row = { dataset: { serviceProvider: 'dots' }, classList: { toggle() {} }, querySelector(selector) {
    return selector === '.service-light' ? light : selector === '.service-card-status, .service-status-label' ? label : selector === '.service-card-select' ? choice : null;
  } };
  context.document.querySelector('#settings').querySelectorAll = () => [row];
  vm.runInContext("snapshot.local_services = { dots: { state: 'checking' } }; updateServiceIndicators()", context);
  assert.equal(light.className, 'service-light pending');
  assert.equal(label.textContent, '正在检查');
  assert.match(choice.values['aria-label'], /正在检查/);
  vm.runInContext("snapshot.local_services.dots = { state: 'ready', message: '健康检查成功' }; updateServiceIndicators()", context);
  assert.equal(light.className, 'service-light ready');
  assert.equal(label.textContent, '服务已就绪');
  assert.equal(label.values.title, '健康检查成功');
  assert.match(choice.values['aria-label'], /服务已就绪/);
  const before = writes;
  vm.runInContext('updateServiceIndicators()', context);
  assert.equal(writes, before, 'unchanged snapshots must not rewrite status attributes');
});

test('closing settings catches up the chat without requesting another snapshot', async () => {
  const context = appContext();
  const dialog = context.document.querySelector('#settings');
  dialog.open = true;
  dialog.close = () => { dialog.open = false; };
  let updates = 0;
  context.updateChat = () => { assert.equal(dialog.open, false); updates++; };
  vm.runInContext("step = 'main'; editor = null; allowLeaveSettings = async () => true; settleVoiceAuditionChoice = async () => true; updateLive = updateChat;", context);
  await vm.runInContext('closeSettings()', context);
  assert.equal(updates, 1);
});

test('audio reconnect saves drafts first and reopens even with unchanged output selection', async () => {
  const context = appContext();
  vm.runInContext("snapshot.preferences = { output: 'default' }; snapshot.devices = []; settingsDialog.open = true;", context);
  assert.match(vm.runInContext('renderAudioSettings()', context), /data-action="audio\.reconnect"/);

  const calls = [];
  context.mockFlush = async () => { calls.push('flush'); return true; };
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); };
  context.mockRender = () => { calls.push('render'); };
  vm.runInContext('flushAutosaves = mockFlush; command = mockCommand; renderSettings = mockRender', context);
  await vm.runInContext('handleAction', context)('audio.reconnect', null, null);
  assert.equal(calls[0], 'flush');
  assert.equal(calls[1].action, 'preferences.save');
  assert.equal(calls[1].payload.reopen_output, true);
  assert.equal(calls[1].payload.confirmed, true);
  assert.deepEqual(Object.keys(calls[1].payload.preferences), []);
  assert.equal(calls[2], 'render');

  calls.length = 0;
  context.mockFlush = async () => { calls.push('draft blocked'); return false; };
  vm.runInContext('flushAutosaves = mockFlush', context);
  await vm.runInContext('handleAction', context)('audio.reconnect', null, null);
  assert.deepEqual(calls, ['draft blocked']);
});

test('audio settings display and save only the output device', async () => {
  const context = appContext();
  vm.runInContext("snapshot.preferences = { output: 'default' }; snapshot.devices = []; snapshot.ffmpeg_path = 'C:/old/ffmpeg.exe';", context);
  const html = vm.runInContext('renderAudioSettings()', context);
  assert.doesNotMatch(html, /FFmpeg|ffmpeg_path|高级音频设置/);

  const form = { dataset: { form: 'audio' }, fields: { output: '', ffmpeg_path: 'C:/old/ffmpeg.exe' }, checkValidity: () => true };
  const autosave = vm.runInContext('collectAutosave', context)(form);
  assert.equal(autosave.action, 'preferences.save');
  assert.equal(autosave.payload.preferences.output, 'default');
  assert.equal(Object.hasOwn(autosave.payload, 'ffmpeg_path'), false);

  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); };
  context.mockConfirm = async () => { throw new Error('unchanged output must not request confirmation'); };
  vm.runInContext('command = mockCommand; confirmAction = mockConfirm; renderSettings = () => {}', context);
  await vm.runInContext('handleForm', context)(form);
  assert.equal(calls[0].action, 'preferences.save');
  assert.equal(calls[0].payload.confirmed, false);
  assert.equal(Object.hasOwn(calls[0].payload, 'ffmpeg_path'), false);

  form.fields.output = 'Speakers';
  context.mockConfirm = async () => true;
  vm.runInContext('confirmAction = mockConfirm', context);
  await vm.runInContext('handleForm', context)(form);
  assert.equal(calls[1].payload.preferences.output.named, 'Speakers');
  assert.equal(calls[1].payload.confirmed, true);
  assert.equal(Object.hasOwn(calls[1].payload, 'ffmpeg_path'), false);
});

test('dots editor uses one visible form and keeps its generated role key hidden', () => {
  const context = appContext();
  const html = vm.runInContext('renderPresetEditor("")', context);
  assert.match(html, /data-form="dots-preset"/);
  assert.match(html, /name="audio_path"/);
  assert.match(html, /name="reference_text"/);
  assert.match(html, /<textarea[^>]+name="reference_text"/);
  assert.match(html, /name="name"/);
  assert.doesNotMatch(html, /data-form="reference"|name="voice_id"|myvoice/);
  assert.equal(vm.runInContext('editor.dotsVoiceId', context), 'dots-stable-role-id');
});

test('multiline templates preserve line breaks and escape user text', () => {
  const context = appContext();
  vm.runInContext(`snapshot.rules = { events: { danmaku_on: true }, templates: { danmaku: '', gift: '礼物', super_chat: '醒目留言', guard: '大航海' }, user_words: [], message_words: [] }; snapshot.assets = []; editor = null;`, context);
  context.multilineTemplate = '第一行\n第二行<&';
  vm.runInContext('snapshot.rules.templates.danmaku = multilineTemplate', context);
  const html = vm.runInContext('renderRulesSettings()', context);
  assert.match(html, /<textarea[^>]+name="template_danmaku"[^>]*>第一行\n第二行&lt;&amp;<\/textarea>/);
  assert.match(html, /<textarea[^>]+name="message"/);
});

test('sound settings put service choice and audition voice first with compact selectable services', () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '木兰', connection_id: 'dots-connection', provider: 'dots', voice_id: 'role', speed: 1, volume: 1 }]; snapshot.rules.default_preset_id = 'dots-voice'; snapshot.bindings = []; snapshot.preferences = { tts_enabled: true }; editor = null;", context);
  const html = vm.runInContext('renderVoicesSettings()', context);
  assert.ok(html.indexOf('data-form="tts-toggle"') < html.indexOf('data-form="voice-audition"'));
  assert.ok(html.indexOf('<section class="voice-audition"') < html.indexOf('class="service-grid"'));
  assert.ok(html.indexOf('class="service-grid"') < html.indexOf('data-form="voice-audition"'));
  assert.ok(html.indexOf('name="preset_id"') < html.indexOf('name="text" aria-label="试听文字"'));
  assert.ok(html.indexOf('data-form="voice-audition"') < html.indexOf('<h3>音色管理</h3>'));
  assert.match(html, /class="voice-heading"/);
  assert.match(html, /class="service-card preferred"/);
  assert.match(html, /class="service-card-select" data-action="service\.prefer"[^>]+aria-pressed="true"/);
  assert.match(html, /data-form="voice-audition" data-provider="dots"/);
  assert.match(html, /name="preset_id" aria-label="直播首选音色"/);
  assert.doesNotMatch(html, /<select name="provider"/);
  assert.match(html, /data-action="service\.configure"/);
  assert.match(html, /data-action="binding\.new"/);
  assert.doesNotMatch(html, /data-action="preset\.default"/);
  assert.doesNotMatch(html, /<details[^>]*><summary>为观众指定声音/);
  const rules = vm.runInContext("snapshot.rules.events = { danmaku_on: true, gift_on: true, free_gift_on: false, super_chat_on: true, guard_on: true, gift_threshold_yuan: 0, super_chat_threshold_yuan: 0 }; snapshot.rules.templates = { danmaku: '{message}', gift: '礼物', super_chat: '醒目留言', guard: '大航海' }; snapshot.rules.user_words = []; snapshot.rules.message_words = []; renderRulesSettings()", context);
  assert.match(rules, /<summary>预览规则<\/summary>/);
  assert.doesNotMatch(rules, /value="audition"|<button[^>]*>实际试听<\/button>/);
});

test('service card choice saves its first voice as the live default and keeps audition text', async () => {
  const context = appContext();
  vm.runInContext("snapshot.connections.push({ id: 'fish-connection', settings: { provider: 'fish_audio' }, has_credential: true }); snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots' }, { id: 'fish-voice', name: '桃子', provider: 'fish_audio' }]; snapshot.rules.default_preset_id = 'dots-voice'; editor = null;", context);
  const calls = [];
  context.mockCommand = async (action, payload) => {
    calls.push({ action, payload });
    vm.runInContext("snapshot.rules.default_preset_id = 'fish-voice'", context);
  };
  context.mockRender = () => calls.push({ action: 'render' });
  const form = { dataset: { provider: 'dots' }, elements: { preset_id: { value: 'dots-voice' }, text: { value: '比较音色' } }, querySelector: () => ({ disabled: false }) };
  context.testForm = form;
  vm.runInContext('command = mockCommand; renderSettings = mockRender', context);
  vm.runInContext('updateVoiceAudition(testForm)', context);
  await vm.runInContext('handleAction', context)('service.prefer', 'fish_audio', null);
  assert.equal(calls[0].action, 'presets.default');
  assert.equal(calls[0].payload.id, 'fish-voice');
  assert.equal(calls[1].action, 'render');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '比较音色');
  const html = vm.runInContext('renderVoiceAudition(snapshot.presets, snapshot.presets[1])', context);
  assert.match(html, /data-provider="fish_audio"/);
  assert.match(html, /<option value="fish-voice" selected>/);
  assert.match(html, />比较音色<\/textarea>/);
});

test('service without an available voice opens setup without clearing the live default', async () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots' }]; snapshot.rules.default_preset_id = 'dots-voice'; editor = null;", context);
  const calls = [];
  context.mockCommand = async action => calls.push(action);
  context.mockRender = () => {};
  context.mockToast = message => calls.push(message);
  vm.runInContext('command = mockCommand; renderSettings = mockRender; showToast = mockToast', context);
  await vm.runInContext('handleAction', context)('service.prefer', 'fish_audio', null);
  assert.deepEqual(calls, ['先连接 Fish Audio 账号，验证后会设为首选']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');
  assert.equal(vm.runInContext('editor.type', context), 'service');
  assert.equal(vm.runInContext('editor.makePreferred', context), true);
});

test('unconnected Doubao selection opens QR instead of replacing the live voice', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: false });
    snapshot.presets = [{ id: 'dots-voice', provider: 'dots', connection_id: 'dots-connection' }, { id: 'doubao-voice', provider: 'doubao', connection_id: 'doubao-connection' }];
    snapshot.rules = { default_preset_id: 'dots-voice', preferred_presets: { doubao: 'doubao-voice' } };
    editor = null;`, context);
  const calls = [];
  context.mockGuide = async id => { calls.push(id); };
  context.mockCommand = async action => { throw new Error(`unexpected ${action}`); };
  vm.runInContext('guideDoubaoLogin = mockGuide; command = mockCommand', context);
  await vm.runInContext('handleAction', context)('service.prefer', 'doubao', null);
  assert.deepEqual(calls, ['doubao-voice']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');

  context.document.querySelector('#tts-switch').setAttribute = () => {};
  await vm.runInContext('handleAction', context)('tts.select', 'doubao', null);
  assert.deepEqual(calls, ['doubao-voice', 'doubao-voice']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');

  const menu = { hidden: true, innerHTML: '', style: {} };
  context.document.querySelector = selector => selector === '#tts-menu' ? menu : { setAttribute() {} };
  await vm.runInContext('handleAction', context)('tts.open', '', { getBoundingClientRect: () => ({ left: 10, bottom: 10 }), setAttribute() {} });
  assert.match(menu.innerHTML, /data-action="tts\.select" data-id="doubao"(?! disabled)/);
});

test('an expired Bilibili session opens QR instead of repeating the failed live connection', async () => {
  const context = appContext();
  const calls = [];
  context.mockOpen = async tab => { calls.push(['open', tab]); };
  context.mockCancel = async () => { calls.push(['cancel']); };
  context.mockRender = () => { calls.push(['render']); };
  context.mockStart = async provider => { calls.push(['qr', provider]); };
  context.mockCommand = async action => { throw new Error(`unexpected ${action}`); };
  vm.runInContext("snapshot.live = { state: 'session_expired', running: false }; openSettings = mockOpen; cancelQr = mockCancel; renderSettings = mockRender; startQr = mockStart; command = mockCommand", context);
  await vm.runInContext('handleAction', context)('live.toggle', null, null);
  assert.deepEqual(calls, [['open', 'room'], ['cancel'], ['render'], ['qr', 'bilibili']]);
});

test('selecting an unconnected Doubao audition voice requests QR for that voice', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: false });
    snapshot.presets = [{ id: 'dots-voice', provider: 'dots', connection_id: 'dots-connection' }, { id: 'doubao-voice', provider: 'doubao', connection_id: 'doubao-connection' }];
    snapshot.rules.default_preset_id = 'dots-voice';`, context);
  const calls = [];
  context.mockSettle = async () => { calls.push('settle'); };
  context.mockGuide = async id => { calls.push(id); return true; };
  context.mockCommand = async action => { throw new Error(`unexpected ${action}`); };
  vm.runInContext('settleVoiceAuditionChoice = mockSettle; guideDoubaoLogin = mockGuide; command = mockCommand', context);
  const form = { dataset: { provider: 'doubao' }, elements: { preset_id: { value: 'doubao-voice' }, text: { value: '试听豆包' } }, querySelector: () => ({ disabled: false }) };
  await vm.runInContext('saveVoiceAuditionChoice', context)(form);
  assert.deepEqual(calls, ['settle', 'doubao-voice']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '试听豆包');
});

test('blocked Doubao QR navigation restores the visible saved live voice', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: false });
    snapshot.presets = [{ id: 'dots-voice', provider: 'dots', connection_id: 'dots-connection' }, { id: 'doubao-voice', provider: 'doubao', connection_id: 'doubao-connection' }];
    snapshot.rules.default_preset_id = 'dots-voice';`, context);
  context.mockGuide = async () => false;
  vm.runInContext('guideDoubaoLogin = mockGuide', context);
  const submit = { disabled: false };
  const form = { dataset: { provider: 'doubao' }, elements: { preset_id: { value: 'doubao-voice' }, text: { value: '保留文字' } }, querySelector: () => submit };
  await vm.runInContext('saveVoiceAuditionChoice', context)(form);
  assert.equal(form.elements.preset_id.value, '');
  assert.equal(submit.disabled, true);
  assert.equal(vm.runInContext('voiceAuditionDraft.provider', context), 'dots');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '保留文字');
});

test('a connected Doubao service without a voice opens voice setup instead of QR', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: true });
    snapshot.presets = [{ id: 'dots-voice', provider: 'dots', connection_id: 'dots-connection' }];
    snapshot.rules.default_preset_id = 'dots-voice'; editor = null;`, context);
  const calls = [];
  context.mockGuide = async () => { throw new Error('unexpected QR'); };
  context.mockLoad = async id => { calls.push(['load', id]); };
  context.mockRender = () => { calls.push(['render']); };
  context.mockOpen = async (tab, nextEditor) => {
    calls.push(['open', tab]);
    context.testEditor = nextEditor;
    vm.runInContext('editor = testEditor', context);
  };
  vm.runInContext('guideDoubaoLogin = mockGuide; loadVoiceEditorData = mockLoad; renderSettings = mockRender; openViewerSettings = mockOpen; showToast = () => {}', context);
  await vm.runInContext('handleAction', context)('service.prefer', 'doubao', null);
  assert.equal(vm.runInContext('editor.type', context), 'preset');
  assert.equal(vm.runInContext('editor.connectionId', context), 'doubao-connection');
  assert.equal(vm.runInContext('editor.makePreferred', context), true);
  assert.deepEqual(calls, [['load', 'doubao-connection'], ['render']]);

  calls.length = 0;
  context.document.querySelector('#tts-switch').setAttribute = () => {};
  await vm.runInContext('handleAction', context)('tts.select', 'doubao', null);
  assert.deepEqual(calls, [['open', 'voices'], ['load', 'doubao-connection'], ['render']]);
});

test('Doubao QR setup waits for pending settings saves before replacing the page', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: false }); settingsDialog.open = true; editor = null;`, context);
  const calls = [];
  let allow = false;
  context.mockAllow = async () => { calls.push('flush'); return allow; };
  context.mockRender = () => { calls.push('render'); };
  context.mockStart = async (provider, id) => { calls.push(['qr', provider, id]); };
  vm.runInContext('allowLeaveSettings = mockAllow; renderSettings = mockRender; startQr = mockStart', context);
  assert.equal(await vm.runInContext('guideDoubaoLogin', context)(), false);
  assert.deepEqual(calls, ['flush']);
  assert.equal(vm.runInContext('editor', context), null);
  allow = true;
  assert.equal(await vm.runInContext('guideDoubaoLogin', context)(), true);
  assert.deepEqual(calls, ['flush', 'flush', 'render', ['qr', 'doubao', 'doubao-connection']]);
  assert.equal(vm.runInContext('editor.type', context), 'qr');
});

test('completed Doubao QR promotes the voice chosen before login', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: false });
    snapshot.presets = [{ id: 'dots-voice', provider: 'dots', connection_id: 'dots-connection' }, { id: 'doubao-voice', provider: 'doubao', connection_id: 'doubao-connection' }];
    snapshot.rules.default_preset_id = 'dots-voice'; settingsDialog.open = true;
    editor = { type: 'qr', provider: 'doubao', id: 'doubao-connection', makePreferred: true, preferredPresetId: 'doubao-voice' };`, context);
  const calls = [];
  let poll;
  context.setTimeout = callback => { poll = callback; return 1; };
  context.mockCommand = async (action, payload) => {
    calls.push([action, payload]);
    if (action === 'doubao.qr.poll') {
      vm.runInContext("snapshot.connections.find(item => item.id === 'doubao-connection').has_credential = true", context);
      return { qr: { status: 'complete' } };
    }
    if (action === 'presets.default') {
      vm.runInContext("snapshot.rules.default_preset_id = 'doubao-voice'", context);
      return {};
    }
    throw new Error(`unexpected ${action}`);
  };
  context.mockRender = () => { calls.push(['render']); };
  context.mockToast = message => { calls.push(['toast', message]); };
  vm.runInContext('command = mockCommand; renderSettings = mockRender; showToast = mockToast', context);
  vm.runInContext('scheduleQrPoll("doubao", qrGeneration)', context);
  await poll();
  assert.deepEqual(calls.map(call => call[0]), ['doubao.qr.poll', 'presets.default', 'render', 'toast']);
  assert.equal(calls[1][1].id, 'doubao-voice');
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'doubao-voice');
  assert.equal(vm.runInContext('editor', context), null);
});

test('returning to a TTS restores its last chosen voice and ignores a deleted voice', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections = [
    { id: 'dots-first', settings: { provider: 'dots' } },
    { id: 'dots-second', settings: { provider: 'dots' } },
    { id: 'fish', settings: { provider: 'fish_audio' }, has_credential: true }
  ]; snapshot.presets = [
    { id: 'dots-a', provider: 'dots', connection_id: 'dots-first' },
    { id: 'dots-b', provider: 'dots', connection_id: 'dots-second' },
    { id: 'fish-a', provider: 'fish_audio', connection_id: 'fish' }
  ]; snapshot.rules = { default_preset_id: 'fish-a', preferred_presets: { dots: 'dots-b', fish_audio: 'fish-a' } }; editor = null;`, context);
  assert.equal(vm.runInContext('rememberedPreset("dots").id', context), 'dots-b');
  assert.equal(vm.runInContext('serviceConnection("dots").id', context), 'dots-second');
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); };
  vm.runInContext('command = mockCommand; renderSettings = () => {}', context);
  await vm.runInContext('handleAction', context)('service.prefer', 'dots', null);
  assert.equal(calls[0].action, 'presets.default');
  assert.equal(calls[0].payload.id, 'dots-b');
  context.document.querySelector('#tts-switch').setAttribute = () => {};
  await vm.runInContext('handleAction', context)('tts.select', 'dots', null);
  assert.equal(calls[1].payload.id, 'dots-b');
  vm.runInContext('snapshot.presets = snapshot.presets.filter(item => item.id !== "dots-b")', context);
  assert.equal(vm.runInContext('rememberedPreset("dots").id', context), 'dots-a');
  assert.equal(vm.runInContext('serviceConnection("dots").id', context), 'dots-first');
});

test('rapid audition voice changes retain the last selected live default', async () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'first', name: '一号', provider: 'dots' }, { id: 'second', name: '二号', provider: 'dots' }]; snapshot.rules.default_preset_id = 'second'; editor = null;", context);
  const calls = [];
  let started;
  let release;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const firstBlocked = new Promise(resolve => { release = resolve; });
  context.mockCommand = async (action, payload) => {
    calls.push(payload.id);
    if (payload.id === 'first') { started(); await firstBlocked; }
    vm.runInContext(`snapshot.rules.default_preset_id = '${payload.id}'`, context);
  };
  context.mockRender = () => {};
  const voice = { value: 'first' };
  const form = { dataset: { provider: 'dots' }, elements: { preset_id: voice, text: { value: '文字保留' } }, querySelector: () => ({ disabled: false }) };
  vm.runInContext('command = mockCommand; renderSettings = mockRender', context);
  const first = vm.runInContext('saveVoiceAuditionChoice', context)(form);
  await firstStarted;
  voice.value = 'second';
  const second = vm.runInContext('saveVoiceAuditionChoice', context)(form);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'second');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '文字保留');
});

test('a service click after a pending voice save remains the live default', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'fish-connection', settings: { provider: 'fish_audio' }, has_credential: true });
    snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots', connection_id: 'dots-connection' },
      { id: 'fish-voice', name: '桃子', provider: 'fish_audio', connection_id: 'fish-connection' }];
    snapshot.rules.default_preset_id = 'dots-voice'; editor = null;`, context);
  const calls = [];
  let started;
  let release;
  const fishStarted = new Promise(resolve => { started = resolve; });
  const fishBlocked = new Promise(resolve => { release = resolve; });
  context.mockCommand = async (action, payload) => {
    assert.equal(action, 'presets.default');
    calls.push(payload.id);
    if (payload.id === 'fish-voice') { started(); await fishBlocked; }
    vm.runInContext(`snapshot.rules.default_preset_id = '${payload.id}'`, context);
  };
  const form = { dataset: { provider: 'fish_audio' }, elements: { preset_id: { value: 'fish-voice' }, text: { value: '保留试听文字' } }, querySelector: () => ({ disabled: false }) };
  vm.runInContext('command = mockCommand; renderSettings = () => {}', context);
  const voiceChange = vm.runInContext('saveVoiceAuditionChoice', context)(form);
  await fishStarted;
  const serviceClick = vm.runInContext('handleAction', context)('service.prefer', 'dots', null);
  release();
  await Promise.all([voiceChange, serviceClick]);
  assert.deepEqual(calls, ['fish-voice', 'dots-voice']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '保留试听文字');
});

test('audition submit saves its selected live voice and plays without a confirmation', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'fish-connection', settings: { provider: 'fish_audio' }, has_credential: true });
    snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots', connection_id: 'dots-connection' },
      { id: 'fish-voice', name: '桃子', provider: 'fish_audio', connection_id: 'fish-connection' }];
    snapshot.rules.default_preset_id = 'dots-voice'; editor = null;`, context);
  const calls = [];
  context.mockCommand = async (action, payload) => {
    calls.push(action);
    if (action === 'presets.default') vm.runInContext(`snapshot.rules.default_preset_id = '${payload.id}'`, context);
  };
  context.mockConfirm = async () => { throw new Error('audition must not ask again'); };
  const form = {
    dataset: { form: 'voice-audition', provider: 'fish_audio' },
    fields: { preset_id: 'fish-voice', text: '比较这段声音' },
    elements: { preset_id: { value: 'fish-voice' }, text: { value: '比较这段声音' } },
    querySelector: () => ({ disabled: false }),
  };
  vm.runInContext('command = mockCommand; renderSettings = () => {}; confirmAction = mockConfirm', context);
  await vm.runInContext('handleForm', context)(form);
  assert.deepEqual(calls, ['presets.default', 'audition']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'fish-voice');
});

test('unconnected Doubao audition submit starts login without bypassing the live voice guard', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: false });
    snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots', connection_id: 'dots-connection' },
      { id: 'doubao-voice', name: '桃子', provider: 'doubao', connection_id: 'doubao-connection' }];
    snapshot.rules.default_preset_id = 'dots-voice';`, context);
  const calls = [];
  context.mockGuide = async id => { calls.push(['login', id]); return true; };
  context.mockCommand = async action => { throw new Error(`unexpected ${action}`); };
  const form = {
    dataset: { form: 'voice-audition', provider: 'doubao' },
    fields: { preset_id: 'doubao-voice', text: '试听豆包' },
    elements: { preset_id: { value: 'doubao-voice' }, text: { value: '试听豆包' } },
    querySelector: () => ({ disabled: false }),
  };
  vm.runInContext('guideDoubaoLogin = mockGuide; command = mockCommand', context);
  await vm.runInContext('handleForm', context)(form);
  assert.deepEqual(calls, [['login', 'doubao-voice']]);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');
});

test('leaving voices waits for the selected live default to save', async () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'first', name: '一号', provider: 'dots' }, { id: 'second', name: '二号', provider: 'dots' }]; snapshot.rules.default_preset_id = 'first'; editor = null;", context);
  const calls = [];
  context.mockCommand = async (action, payload) => {
    calls.push(payload.id);
    vm.runInContext("snapshot.rules.default_preset_id = 'second'", context);
  };
  context.mockRender = () => {};
  const form = { dataset: { provider: 'dots' }, elements: { preset_id: { value: 'second' }, text: { value: '试听' } }, querySelector: () => ({ disabled: false }) };
  vm.runInContext('command = mockCommand; renderSettings = mockRender', context);
  const saving = vm.runInContext('saveVoiceAuditionChoice', context)(form);
  const leaving = vm.runInContext('settleVoiceAuditionChoice', context)();
  await Promise.all([saving, leaving]);
  assert.deepEqual(calls, ['second']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'second');
});

test('exit flushes automatic saves without confirmation or blocking on failed drafts', async () => {
  const context = appContext();
  const calls = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  context.blocked = blocked;
  context.mockVolume = async () => { calls.push('volume'); };
  context.mockLeave = async () => { calls.push('other settings'); return true; };
  vm.runInContext('volumeSave.flush = mockVolume; flushAutosaves = mockLeave; allowLeaveSettings = () => { throw new Error("Must not prompt on exit"); }; voiceAuditionDefaultSave = blocked; formDrafts.set("unsent-key", {});', context);
  const exit = vm.runInContext('flushExitEdits()', context);
  await Promise.resolve();
  assert.deepEqual(calls, ['volume', 'other settings']);
  release();
  assert.equal(await exit, true);
  assert.deepEqual(calls, ['volume', 'other settings']);

  vm.runInContext('voiceAuditionDefaultSave = Promise.reject(new Error("保存失败"))', context);
  assert.equal(await vm.runInContext('flushExitEdits()', context), true);
  assert.deepEqual(calls, ['volume', 'other settings', 'volume', 'other settings']);
});

test('mute click preserves gain, unmutes on the next click and restores a zero slider', async () => {
  const context = appContext();
  const calls = [];
  context.saveMute = async (action, payload) => {
    assert.equal(action, 'preferences.save');
    calls.push(structuredClone(payload.preferences));
    context.nextPreferences = payload.preferences;
    vm.runInContext('Object.assign(snapshot.preferences, nextPreferences)', context);
  };
  vm.runInContext('snapshot.preferences = {master_volume: 0.65, muted: false}; command = saveMute;', context);
  const act = vm.runInContext('handleAction', context);
  await act('audio.mute');
  assert.equal(vm.runInContext('snapshot.preferences.master_volume', context), 0.65);
  assert.equal(vm.runInContext('snapshot.preferences.muted', context), true);
  await act('audio.mute');
  assert.equal(vm.runInContext('snapshot.preferences.muted', context), false);
  assert.equal(vm.runInContext('snapshot.preferences.master_volume', context), 0.65);
  vm.runInContext('snapshot.preferences.master_volume = 0;', context);
  await act('audio.mute');
  assert.equal(vm.runInContext('snapshot.preferences.master_volume', context), 1);
  assert.equal(vm.runInContext('snapshot.preferences.muted', context), false);
  assert.equal(calls.length, 3);
});

test('muted volume control has a different icon and accessible toggle state', () => {
  const context = appContext();
  const slider = {value: ''};
  const output = {textContent: ''};
  const control = {dataset: {}, attrs: {}, setAttribute(name, value) {this.attrs[name] = value;}};
  context.document.querySelector = selector => selector === '#main-volume-range' ? slider : selector === '#main-volume-value' ? output : control;
  vm.runInContext('snapshot.preferences = {master_volume: 0.65, muted: false}; updateVolumeControls();', context);
  const unmutedIcon = control.innerHTML;
  assert.equal(control.attrs['aria-label'], '静音');
  assert.equal(output.textContent, '65%');
  vm.runInContext('snapshot.preferences.muted = true; updateVolumeControls();', context);
  assert.notEqual(control.innerHTML, unmutedIcon);
  assert.equal(control.attrs['aria-pressed'], 'true');
  assert.equal(control.title, '取消静音');
  assert.equal(output.textContent, '静音');
  assert.equal(slider.value, '65');
  vm.runInContext('snapshot.preferences.master_volume = 0; snapshot.preferences.muted = false; updateVolumeControls();', context);
  assert.equal(control.attrs['aria-pressed'], 'true');
  vm.runInContext('volumeDraft = 80; updateVolumeControls();', context);
  assert.equal(control.attrs['aria-pressed'], 'false');
  assert.equal(control.innerHTML, unmutedIcon);
});

test('failed audition voice switch restores the saved default', async () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '本地', provider: 'dots' }, { id: 'fish-voice', name: '云端', provider: 'fish_audio' }]; snapshot.rules.default_preset_id = 'dots-voice';", context);
  const errors = [];
  context.mockCommand = async () => { throw new Error('服务暂不可用'); };
  context.mockRender = () => {};
  context.mockError = error => errors.push(error.message);
  const voice = { value: 'fish-voice' };
  const form = { dataset: { provider: 'fish_audio' }, elements: { preset_id: voice, text: { value: '保留试听文字' } }, querySelector: () => ({ disabled: false }) };
  vm.runInContext('command = mockCommand; renderSettings = mockRender; showError = mockError', context);
  await vm.runInContext('saveVoiceAuditionChoice', context)(form);
  assert.equal(vm.runInContext('voiceAuditionDraft.provider', context), 'dots');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '保留试听文字');
  assert.deepEqual(errors, ['服务暂不可用']);
});

test('manual viewer name binding saves without UID and keeps UID optional', () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots' }]; snapshot.bindings = []; editor = { type: 'binding', id: '' };", context);
  const html = vm.runInContext("renderBindingEditor('')", context);
  assert.match(html, /name="user_name"/);
  assert.match(html, /name="user_id"[^>]*pattern/);
  assert.doesNotMatch(html, /name="user_id"[^>]*required/);
  const form = { dataset: { form: 'binding', id: '' }, fields: { user_name: '观众小花', user_id: '', preset_id: 'dots-voice', enabled: 'on' }, checkValidity: () => true };
  context.testForm = form;
  const binding = vm.runInContext('collectAutosave(testForm).payload.binding', context);
  assert.equal(binding.user_id, null);
  assert.equal(binding.user_name, '观众小花');
  assert.equal(binding.preset_id, 'dots-voice');
  form.fields.user_id = '42';
  const precise = vm.runInContext('collectAutosave(testForm).payload.binding', context);
  assert.equal(precise.user_id, 42);
  assert.equal(precise.user_name, null);
});

test('avatar without UID can open an exact-name voice binding', async () => {
  const context = appContext();
  const opened = [];
  context.mockOpen = async (tab, nextEditor) => opened.push({ tab, nextEditor });
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots' }]; snapshot.bindings = []; viewerContext = { user_id: null, user_name: '观众小花' }; openViewerSettings = mockOpen", context);
  await vm.runInContext('handleAction', context)('viewer.voice', '', null);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].tab, 'voices');
  assert.equal(opened[0].nextEditor.userId, null);
  assert.equal(opened[0].nextEditor.userName, '观众小花');
});

test('saved floating-point scale selects the matching option', () => {
  const context = appContext();
  vm.runInContext(`snapshot.preferences = { appearance: 'light', scale: 1.399999976158142 }; snapshot.startup_enabled = false;`, context);
  const html = vm.runInContext('renderAppearanceSettings()', context);
  assert.match(html, /<option value="1\.4" selected>140%<\/option>/);
  assert.doesNotMatch(html, /<option value="0\.8" selected>/);
});

test('IME composition keeps a draft but does not queue an unfinished write', () => {
  const context = appContext();
  const calls = [];
  const form = {
    dataset: { form: 'rules' },
    fields: { text: '未完成' },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    cloneNode() { return { dataset: { ...this.dataset }, querySelectorAll() { return []; }, removeAttribute() {}, outerHTML: '<form></form>' }; },
  };
  const input = { name: 'template_danmaku', closest() { return form; } };
  context.testForm = form;
  context.collectTestAutosave = candidate => ({ action: 'rules.save', payload: { text: candidate.fields.text } });
  vm.runInContext(`collectAutosave = collectTestAutosave; autosaves.set(testForm, { key: 'rules:rules:new', form: testForm, tab: 'rules', editor: null, revision: 0, touched: false, invalid: '', lastScheduled: '', baseline: '', queue: { cancel() { testCalls.push('cancel'); }, schedule(value) { testCalls.push(value.payload.text); }, saving: false } });`, Object.assign(context, { testCalls: calls }));
  const listeners = context.document.querySelector('#settings').listeners;
  listeners.compositionstart[0]({ target: input });
  listeners.input[0]({ target: input, isComposing: true });
  assert.deepEqual(calls, ['cancel']);
  assert.equal(vm.runInContext('formDrafts.has("rules:rules:new")', context), true);
  form.fields.text = '你好';
  listeners.compositionend[0]({ target: input });
  assert.deepEqual(calls, ['cancel', '你好']);
});

test('saving a room UID waits for gift edits and retains failed or composing drafts', async () => {
  const context = appContext();
  context.createAutosaveQueue = createAutosaveQueue;
  const calls = [];
  let giftFailure = false;
  const giftInput = {};
  const makeForm = (type, fields) => ({
    dataset: { form: type },
    fields,
    elements: {},
    checkValidity() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    cloneNode() {
      return {
        dataset: { form: type },
        querySelectorAll() { return []; },
        removeAttribute() {},
        outerHTML: '<form></form>',
      };
    },
  });
  const uid = makeForm('room-uid', { uid: '123' });
  const gift = makeForm('gift-merge', { enabled: true, initial_seconds: '1.5', increment_seconds: '0.5', maximum_seconds: '5' });
  const dialog = context.document.querySelector('#settings');
  dialog.open = true;
  dialog.querySelectorAll = selector => selector === '[data-form]' ? [uid, gift] : selector === 'input,textarea' ? [giftInput] : [];
  context.mockCommand = async action => {
    calls.push(action);
    if (action === 'live.save' && giftFailure) throw new Error('直播连接中，请先断开');
    return { result: null };
  };
  context.mockRender = () => { calls.push('render'); };
  vm.runInContext('settingsTab = "room"; command = mockCommand; renderSettings = mockRender; mountAutosaves()', context);
  gift.fields.initial_seconds = '2';
  vm.runInContext('scheduleAutosave', context)(gift, false);
  uid.fields.uid = '456';
  vm.runInContext('scheduleAutosave', context)(uid, true);
  const uidQueue = vm.runInContext('autosaves.get(settingsDialog.querySelectorAll("[data-form]")[0]).queue', context);
  const giftQueue = vm.runInContext('autosaves.get(settingsDialog.querySelectorAll("[data-form]")[1]).queue', context);
  await uidQueue.flush();
  assert.deepEqual(calls, ['onboarding.anonymous', 'live.save', 'render']);

  calls.length = 0;
  giftFailure = true;
  gift.fields.initial_seconds = '3';
  vm.runInContext('scheduleAutosave', context)(gift, false);
  uid.fields.uid = '789';
  vm.runInContext('scheduleAutosave', context)(uid, true);
  await uidQueue.flush();
  assert.deepEqual(calls, ['onboarding.anonymous', 'live.save']);
  assert.match(giftQueue.error.message, /直播连接中/);
  assert.equal(vm.runInContext('autosaves.get(settingsDialog.querySelectorAll("[data-form]")[1]).touched', context), true);

  giftFailure = false;
  giftQueue.retry();
  await giftQueue.flush();
  calls.length = 0;
  context.giftInput = giftInput;
  vm.runInContext('composingInputs.add(giftInput)', context);
  gift.fields.initial_seconds = '4';
  vm.runInContext('scheduleAutosave', context)(gift, false, false, true);
  uid.fields.uid = '987';
  vm.runInContext('scheduleAutosave', context)(uid, true);
  await uidQueue.flush();
  assert.deepEqual(calls, ['onboarding.anonymous']);
  assert.equal(vm.runInContext('autosaves.get(settingsDialog.querySelectorAll("[data-form]")[1]).touched', context), true);
  vm.runInContext('composingInputs.delete(giftInput)', context);
  vm.runInContext('scheduleAutosave', context)(gift, true);
  await giftQueue.flush();
  vm.runInContext('unmountAutosaves()', context);
});

test('unsaved Fish API key requires explicit discard and is never copied into drafts', async () => {
  const context = appContext();
  const form = { dataset: { form: 'service-fish' }, fields: { credential: 'private-test-key' } };
  const input = { id: '', name: 'credential', closest() { return form; } };
  const dialog = context.document.querySelector('#settings');
  dialog.querySelectorAll = selector => selector === '[data-form][data-dirty]' && form.dataset.dirty ? [form] : [];
  const prompts = [];
  let discard = false;
  context.testConfirm = async (title, message) => { prompts.push({ title, message }); return discard; };
  vm.runInContext('confirmAction = testConfirm', context);
  dialog.listeners.input[0]({ target: input });
  assert.equal(form.dataset.dirty, 'true');
  const leave = vm.runInContext('allowLeaveSettings', context);
  assert.equal(await leave(), false);
  assert.equal(form.dataset.dirty, 'true');
  assert.equal(vm.runInContext('formDrafts.size', context), 0);
  discard = true;
  assert.equal(await leave(), true);
  assert.equal(form.dataset.dirty, undefined);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(JSON.stringify(prompts), /private-test-key/);
});

test('checking a local service keeps an unsaved directory field visible', async () => {
  const context = appContext();
  const form = { dataset: { form: 'service-local', dirty: 'true' }, fields: { directory: 'C:\\private\\dots' } };
  const dialog = context.document.querySelector('#settings');
  dialog.open = true;
  dialog.querySelectorAll = () => [];
  context.mockCommand = async action => { assert.equal(action, 'local_services.check'); return {}; };
  vm.runInContext('command = mockCommand; renderSettings = () => { throw new Error("unexpected re-render"); }; updateServiceIndicators = () => {};', context);
  await vm.runInContext('handleAction', context)('service.check', 'dots', null);
  assert.equal(form.fields.directory, 'C:\\private\\dots');
  assert.equal(form.dataset.dirty, 'true');
});

test('a successful fallback updates the footer once and expires without replay', () => {
  const context = appContext();
  const timers = [];
  const cancelled = [];
  context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  context.clearTimeout = timer => { cancelled.push(timer); };
  context.testUpdates = [];
  vm.runInContext('step = "main"; updateLive = () => testUpdates.push(fallbackStatus)', context);
  const track = vm.runInContext('updateFallbackStatus', context);
  const record = { id: 7, state: 'played', detail: '指定的 dots.tts 不可用（无法连接服务），本条临时使用默认 GPT-SoVITS；播报完成' };
  const queue = { current: { text: '下一条播报正文' }, history: [record] };
  const expected = 'dots.tts 无法连接服务，已用首选 GPT-SoVITS 播报';
  assert.equal(track(queue), expected);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 8000);
  assert.equal(track(queue), expected);
  assert.equal(timers.length, 1, 'polling the same history must not start another notice');
  timers[0].callback();
  assert.equal(track(queue), '');
  assert.deepEqual(context.testUpdates, ['']);
  assert.equal(cancelled.length, 1);
  assert.doesNotMatch(expected, /下一条播报正文/);
});

test('chat renders large images only for explicitly marked emotes', () => {
  const context = appContext();
  const base = { kind: 'danmaku', message: '[妙]' };
  const image = { text: '[妙]', url: 'https://i0.hdslb.com/bfs/live/a.png' };
  context.chatEvent = { ...base, emotes: [{ ...image, large: true }] };
  assert.match(vm.runInContext('renderChatBody(chatEvent)', context), /class="message-emote large"/);
  context.chatEvent = { ...base, emotes: [{ ...image, large: false }] };
  assert.match(vm.runInContext('renderChatBody(chatEvent)', context), /class="message-emote"/);
});

test('logged-in room settings hide UID input unless own-room discovery failed', () => {
  const context = appContext();
  vm.runInContext(`snapshot.account = { user_id: 12 }; snapshot.setup = { mode: 'account', room_id: 34 }; snapshot.qr = { provider: 'bilibili', status: 'complete' }; editor = null;`, context);
  assert.doesNotMatch(vm.runInContext('renderRoomSettings()', context), /data-form="room-uid"/);
  vm.runInContext(`snapshot.setup.room_id = null; snapshot.qr.status = 'expired'; editor = { type: 'qr', provider: 'bilibili' };`, context);
  const fallback = vm.runInContext('renderRoomSettings()', context);
  assert.match(fallback, /data-form="room-uid"/);
  assert.match(fallback, /未找到本账号直播间/);
  assert.doesNotMatch(fallback, /已使用登录账号的直播间/);
  vm.runInContext(`snapshot.setup.room_id = 34; snapshot.live = { state: 'session_expired' }; editor = null;`, context);
  const expired = vm.runInContext('renderRoomSettings()', context);
  assert.match(expired, /登录已失效/);
  assert.match(expired, /重新扫码登录/);
});

test('dots voice save is atomic and retains the draft and role on failure', async () => {
  const context = appContext();
  vm.runInContext('renderPresetEditor("")', context);
  const calls = [];
  let failSave = true;
  context.mockCommand = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'dots.voice.save' && failSave) {
      failSave = false;
      throw new Error('source missing');
    }
    context.savedPreset = payload.preset;
    vm.runInContext('snapshot.presets = [{ ...savedPreset, id: "preset-1" }]', context);
    return { result: { id: 'preset-1' } };
  };
  vm.runInContext('command = (action, payload) => mockCommand(action, payload)', context);
  const form = {
    dataset: { id: '', connectionId: 'dots-connection' },
    fields: { name: '日常播报', audio_path: 'C:\\voices\\sample.wav', reference_text: '', speed: '1', volume: '1' },
    checkValidity() { return true; },
    querySelectorAll() { return []; },
    cloneNode() { return { dataset: { ...this.dataset }, querySelectorAll() { return []; }, removeAttribute() {}, outerHTML: '<form></form>' }; },
  };
  const save = vm.runInContext('saveDotsPresetForm', context);
  await assert.rejects(save(form), /source missing/);
  assert.equal(form.dataset.id, '');
  assert.equal(vm.runInContext('editor.id', context), '');
  assert.equal(vm.runInContext('formDrafts.has("voices:dots-preset:new")', context), true);
  assert.deepEqual(calls.map(call => call.action), ['dots.voice.save']);
  assert.equal(calls[0].payload.preset.voice_id, 'dots-stable-role-id');
  assert.equal(calls[0].payload.profile.role.role, 'dots-stable-role-id');
  assert.equal(calls[0].payload.make_preferred, true);

  await save(form);
  assert.deepEqual(calls.map(call => call.action), ['dots.voice.save', 'dots.voice.save']);
  assert.equal(calls[1].payload.preset.voice_id, 'dots-stable-role-id');
  assert.equal(calls[1].payload.preset.id, '');
  assert.equal(form.dataset.id, 'preset-1');
  assert.equal(vm.runInContext('editor.id', context), 'preset-1');
  assert.equal(vm.runInContext('formDrafts.size', context), 0);
});

test('an old dots preset without a reference path only saves its preset fields', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.presets = [{ id: 'old-1', name: '旧音色', connection_id: 'dots-connection', provider: 'dots', voice_id: 'myvoice.wav', speed: 1, volume: 1 }]; editor.id = 'old-1'; editor.makePreferred = false;`, context);
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); return { result: { id: 'old-1' } }; };
  vm.runInContext('command = (action, payload) => mockCommand(action, payload)', context);
  const form = {
    dataset: { id: 'old-1', connectionId: 'dots-connection' },
    fields: { name: '改名', audio_path: '', reference_text: '', speed: '1.1', volume: '0.9' },
    checkValidity() { return true; },
    querySelectorAll() { return []; },
    cloneNode() { return { dataset: { ...this.dataset }, querySelectorAll() { return []; }, removeAttribute() {}, outerHTML: '<form></form>' }; },
  };
  await vm.runInContext('saveDotsPresetForm', context)(form);
  assert.deepEqual(calls.map(call => call.action), ['presets.save']);
  assert.equal(calls[0].payload.preset.voice_id, 'myvoice.wav');
  assert.equal(calls[0].payload.preset.name, '改名');
});

test('Fish account form uses read-only verification before storing the key', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.local_services = {}; editor = { type: 'service', provider: 'fish_audio' }; renderSettings = () => {}; showToast = () => {};`, context);
  const html = vm.runInContext('renderServiceEditor("fish_audio")', context);
  assert.match(html, /fish\.open_keys/);
  assert.match(html, /fish\.open_discovery/);
  assert.match(html, /data-form="service-fish"/);
  assert.doesNotMatch(html, /data-form="fish-settings"/);
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); return { result: { id: 'fish-1', verified: true } }; };
  vm.runInContext('command = (action, payload) => mockCommand(action, payload)', context);
  const form = { dataset: { form: 'service-fish', id: '' }, fields: { credential: 'private-test-key' }, elements: { credential: { value: 'private-test-key' } } };
  await vm.runInContext('handleForm', context)(form);
  assert.deepEqual(calls.map(call => call.action), ['fish.connect']);
  assert.equal(calls[0].payload.credential, 'private-test-key');
  assert.equal(form.elements.credential.value, '');
});

test('an unconnected Fish service opens account setup before adding a voice', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections = [{ id: 'fish-1', name: 'Fish Audio', settings: { provider: 'fish_audio' }, has_credential: false }]; editor = null; renderSettings = () => {}; showToast = () => {};`, context);
  context.mockCommand = () => { throw new Error('voice creation must not reach the backend'); };
  vm.runInContext('command = mockCommand', context);
  await vm.runInContext('handleAction', context)('preset.new', '', {});
  assert.equal(vm.runInContext('editor.type', context), 'service');
  assert.equal(vm.runInContext('editor.provider', context), 'fish_audio');
  assert.equal(vm.runInContext('editor.makePreferred', context), true);
});

test('Fish custom voice lookup precedes save and the free model is the default', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections = [{ id: 'fish-1', name: 'Fish Audio', settings: { provider: 'fish_audio' }, has_credential: true }]; snapshot.fish_audio_settings = {}; snapshot.local_services = {}; editor = { type: 'preset', id: '', connectionId: 'fish-1', makePreferred: false }; renderSettings = () => {}; showToast = () => {};`, context);
  const serviceHtml = vm.runInContext('renderServiceEditor("fish_audio")', context);
  assert.match(serviceHtml, /value="s2\.1-pro-free" selected/);
  assert.match(serviceHtml, /data-form="fish-settings"/);
  const voiceHtml = vm.runInContext('renderPresetEditor("")', context);
  assert.match(voiceHtml, /data-form="fish-voice"/);
  assert.match(voiceHtml, /fish\.voice\.lookup/);
  const calls = [];
  context.mockCommand = async (action, payload) => {
    calls.push({ action, payload });
    return { result: action === 'fish.voice.lookup' ? { voice_id: 'a'.repeat(32), name: '官方名称' } : { id: 'preset-fish' } };
  };
  vm.runInContext('command = (action, payload) => mockCommand(action, payload)', context);
  const form = { dataset: { form: 'fish-voice', connectionId: 'fish-1', id: '' }, fields: { id_or_url: 'https://fish.audio/m/' + 'a'.repeat(32), name: '' } };
  await vm.runInContext('handleForm', context)(form);
  assert.deepEqual(calls.map(call => call.action), ['fish.voice.lookup', 'fish.voice.save']);
  assert.equal(calls[1].payload.name, '官方名称');
  assert.equal(calls[1].payload.id_or_url, form.fields.id_or_url);
});

test('Fish generation settings and targeted audition use their dedicated IPC', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections = [{ id: 'fish-1', name: 'Fish Audio', settings: { provider: 'fish_audio' }, has_credential: true }]; snapshot.presets = [{ id: 'preset-fish', connection_id: 'fish-1', provider: 'fish_audio', voice_id: '${'a'.repeat(32)}', name: '测试音色', speed: 1, volume: 1 }]; snapshot.fish_audio_settings = { 'fish-1': { streaming: false } }; snapshot.local_services = {}; editor = { type: 'service', provider: 'fish_audio' }; renderSettings = () => {}; showToast = () => {}; confirmAction = async () => true;`, context);
  const html = vm.runInContext('renderServiceEditor("fish_audio")', context);
  assert.doesNotMatch(html, /name="streaming"|流式接收音频/);
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); return { result: null }; };
  vm.runInContext('command = (action, payload) => mockCommand(action, payload)', context);
  const form = { dataset: { form: 'fish-settings', connectionId: 'fish-1' }, fields: { model: 's2.1-pro-free', latency: 'balanced', volume_db: '-2', temperature: '0.6', top_p: '0.8' } };
  await vm.runInContext('handleForm', context)(form);
  await vm.runInContext('handleAction', context)('fish.audition', 'preset-fish', null);
  assert.deepEqual(calls.map(call => call.action), ['fish.settings.save', 'presets.default', 'audition']);
  assert.equal(calls[0].payload.settings.volume_db, -2);
  assert.equal(calls[0].payload.settings.streaming, true);
  assert.equal(calls[1].payload.id, 'preset-fish');
  assert.equal(calls[2].payload.preset_id, 'preset-fish');
  assert.equal(typeof calls[2].payload.text, 'string');
  calls.length = 0;
  vm.runInContext('confirmAction = async () => { throw new Error("audition must not ask again"); }', context);
  await vm.runInContext('handleAction', context)('fish.audition', 'preset-fish', null);
  assert.deepEqual(calls.map(call => call.action), ['presets.default', 'audition']);
});

test('Fish accepts a manually pasted key without a clipboard watcher', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.local_services = {}; editor = { type: 'service', provider: 'fish_audio' }; renderSettings = () => {};`, context);
  const html = vm.runInContext('renderServiceEditor("fish_audio")', context);
  assert.doesNotMatch(html, /剪贴板|检测复制|可能产生费用/);
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); return { result: null }; };
  vm.runInContext('command = mockCommand', context);
  const form = { dataset: { form: 'service-fish' }, fields: { credential: 'locally-pasted-test-key' }, elements: { credential: { value: 'locally-pasted-test-key' } } };
  await vm.runInContext('handleForm', context)(form);
  assert.deepEqual(calls.map(call => call.action), ['fish.connect']);
  assert.equal(calls[0].payload.credential, 'locally-pasted-test-key');
  assert.equal(form.elements.credential.value, '');
});

test('category navigation returns to its root including when already selected', async () => {
  const context = appContext();
  context.document.querySelector().focus = () => {};
  vm.runInContext(`editor = { type: 'service', provider: 'fish_audio' }; settingsTab = 'voices'; renderSettings = () => {}; allowLeaveSettings = async () => true;`, context);
  await vm.runInContext('handleAction', context)('settings.tab', 'voices');
  assert.equal(vm.runInContext('editor', context), null);
  vm.runInContext(`editor = { type: 'preset', id: 'draft' }; allowLeaveSettings = async () => false;`, context);
  await vm.runInContext('handleAction', context)('settings.tab', 'room');
  assert.equal(vm.runInContext('settingsTab', context), 'voices');
  assert.equal(vm.runInContext('editor.id', context), 'draft');
});

test('Doubao names stay readable while saving exact internal voice IDs', () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections = [{ id: 'doubao', settings: { provider: 'doubao' } }]; snapshot.doubao_voices = [{ id: 'zh_female_test_bigtts', name: '温柔桃子' }]; editor = { type: 'preset', connectionId: 'doubao' };`, context);
  const html = vm.runInContext('renderPresetEditor("")', context);
  assert.match(html, /option value="zh_female_test_bigtts">温柔桃子<\/option>/);
  assert.doesNotMatch(html, /datalist|音色 ID/);
  const form = { checkValidity: () => true, dataset: { form: 'preset' }, fields: { connection_id: 'doubao', voice_id: 'zh_female_test_bigtts', name: '', speed: '1', volume: '1' } };
  const result = vm.runInContext('collectAutosave', context)(form);
  assert.equal(result.payload.preset.name, '温柔桃子');
  assert.equal(result.payload.preset.voice_id, 'zh_female_test_bigtts');
});

test('number fields suppress f32 noise and preserve text identifiers', () => {
  const context = appContext();
  const format = vm.runInContext('displayNumber', context);
  assert.equal(format(0.699999988079071), .7);
  assert.equal(format(1.2000000476837158), 1.2);
  assert.equal(format(12345678912345), 12345678912345);
  assert.equal(format('000123456789'), '000123456789');
});

test('Fish parameter and voice edits use autosave without exposing voice IDs', () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections = [{ id: 'fish', settings: { provider: 'fish_audio' }, has_credential: true }]; snapshot.presets = [{ id: 'voice', provider: 'fish_audio', connection_id: 'fish', voice_id: '${'a'.repeat(32)}', name: '测试', speed: 1, volume: 1 }]; snapshot.local_services = {}; editor = { type: 'preset', id: 'voice' };`, context);
  const form = { checkValidity: () => true, dataset: { form: 'fish-preset', id: 'voice', connectionId: 'fish' }, fields: { name: '新的中文名称', speed: '1.2', volume: '.8' } };
  const saved = vm.runInContext('collectAutosave', context)(form);
  assert.equal(saved.payload.preset.name, '新的中文名称');
  assert.equal(saved.payload.preset.speed, 1.2);
  const html = vm.runInContext('renderPresetEditor("voice")', context);
  assert.doesNotMatch(html, /音色 ID|保存音色/);
  assert.doesNotMatch(html, /更改自动保存|已自动保存/);
  assert.match(html, /class="autosave-status"[^>]+ hidden/);
});

test('routine saves stay silent while failures retain visible recovery actions', () => {
  const context = appContext();
  const parts = { '[data-autosave-label]': {}, '[data-action="autosave.retry"]': {}, '[data-action="autosave.discard"]': {} };
  const node = { hidden: false, dataset: {}, querySelector: selector => parts[selector] };
  const form = { querySelector: () => node };
  const update = vm.runInContext('showAutoState', context);
  update(form);
  assert.equal(node.hidden, true);
  assert.equal(parts['[data-autosave-label]'].textContent, '');
  update(form, '无法写入配置', 'error');
  assert.equal(node.hidden, false);
  assert.equal(parts['[data-autosave-label]'].textContent, '无法写入配置');
  assert.equal(parts['[data-action="autosave.retry"]'].hidden, false);
  update(form);
  assert.equal(node.hidden, true);
  assert.equal(parts['[data-action="autosave.retry"]'].hidden, true);
});


test('about shows versions and update states without development provenance', () => {
  const context = appContext();
  vm.runInContext("snapshot.app_version = '0.2.0'; snapshot.data_dir = 'D:/test';", context);
  let html = vm.runInContext('renderAbout()', context);
  assert.match(html, /0\.2\.0/);
  assert.match(html, /检查更新/);
  assert.doesNotMatch(html, /blive|Tauri|WebView2|视觉参考/);
  vm.runInContext("updateInfo = { status:'available', latest_version:'0.10.0', download_url:'https://github.com/Ghou133/DanmakuVoice/releases/download/v0.10.0/DanmakuVoice.exe' };", context);
  html = vm.runInContext('renderAbout()', context);
  assert.match(html, /发现新版本 0\.10\.0/);
  assert.match(html, /下载新版/);
  assert.match(html, /设置会保留/);
  vm.runInContext("updateInfo = null; updateBusy = true;", context);
  assert.match(vm.runInContext('renderAbout()', context), /disabled/);
  vm.runInContext("updateBusy = false; updateError = '<网络失败>';", context);
  assert.match(vm.runInContext('renderAbout()', context), /&lt;网络失败&gt;/);
});


test('Store installation offers Store updates and never portable downloads', () => {
  const ctx = appContext();
  vm.runInContext(`snapshot = { update_channel: 'store', app_version: '0.2.2', data_dir: 'test' }; updateInfo = { status: 'available', download_url: 'https://example.test/old.exe' };`, ctx);
  const html = vm.runInContext('renderAbout()', ctx);
  assert.match(html, /Microsoft Store 更新/);
  assert.match(html, /store_updates/);
  assert.doesNotMatch(html, /下载新版|解压 ZIP|update_download|data-id="releases"/);
});
