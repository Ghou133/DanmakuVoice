import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAutosaveQueue } from './autosave.mjs';
import { t, ui, getLanguage, setLanguage } from './i18n.mjs';
import { localizeDiagnostic } from './i18n-diagnostics.mjs';
import { errorMessage, deviceValue, mergeSnapshot, escapeHtml, eventText, headerIdentity, identityColor, initial, messageParts, numericId, playbackIssue, playbackFallbackNotice, qrNeedsRoomFallback, safeMediaUrl, snapshotPollingPolicy, createSnapshotSequencer, truncateUtf16, uiIsActive, validUid } from './helpers.mjs';

// overrides replace harness stubs before app.js runs (for example the real autosave queue).
function appContext(overrides = {}) {
  setLanguage('zh-CN');
  const surface = { listeners: {}, dataset: {}, show() { this.open = true; }, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const document = { querySelector(selector) { return selector?.startsWith('[data-brand') ? null : surface; }, addEventListener() {}, hasFocus() { return true; }, documentElement: { dataset: {} } };
  const context = vm.createContext({
    document,
    t, ui, getLanguage, setLanguage,
    localizeDiagnostic,
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
    identityColor,
    eventText,
    initial,
    messageParts,
    numericId,
    playbackFallbackNotice,
    playbackIssue,
    qrNeedsRoomFallback,
    safeMediaUrl,
    snapshotPollingPolicy,
    createSnapshotSequencer,
    truncateUtf16,
    uiIsActive,
    validUid,
    deviceValue,
    setTimeout,
    clearTimeout,
    ...overrides,
  });
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/\bvoid boot\(\);\s*$/, '');
  vm.runInContext(source, context, { filename: 'app.js' });
  vm.runInContext(`snapshot = {
    connections: [{ id: 'dots-connection', name: 'dots', settings: { provider: 'dots' } }],
    presets: [], assets: [], bindings: [], rules: { default_preset_id: null }
  }; editor = { type: 'voice-add', provider: 'dots', connectionId: 'dots-connection' }; referenceProfiles = [];`, context);
  return context;
}

test('opening voice settings refreshes the exact remembered local connections', async () => {
  const context = appContext();
  context.calls = [];
  const dialog = context.document.querySelector('#settings');
  dialog.showModal = () => { dialog.open = true; };
  vm.runInContext(`snapshot.connections = [
    { id: 'gpt-old', settings: { provider: 'gpt_sovits', endpoint: 'http://127.0.0.1:9880' } },
    { id: 'gpt-used', settings: { provider: 'gpt_sovits', endpoint: 'http://127.0.0.1:9990' } }
  ]; snapshot.presets = [{ id: 'used', provider: 'gpt_sovits', connection_id: 'gpt-used' }];
  snapshot.rules.preferred_presets = { gpt_sovits: 'used' };
  renderSettings = () => {}; command = async (action, payload) => calls.push({ action, payload });`, context);
  await vm.runInContext("openSettings('voices')", context);
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].action, 'local_services.check');
  assert.equal(context.calls[0].payload.connection_id, 'gpt-used');
  assert.equal(context.calls[0].payload.provider, 'gpt_sovits');
});

test('automatic local observations are throttled, retry changed addresses, and skip offline or closed settings', async () => {
  const context = appContext();
  context.calls = [];
  vm.runInContext(`settingsDialog.open = true; settingsTab = 'voices';
    command = async (action, payload) => calls.push(payload);`, context);
  await vm.runInContext('refreshLocalServices()', context);
  await vm.runInContext('refreshLocalServices()', context);
  assert.equal(context.calls.length, 1);
  vm.runInContext("snapshot.connections[0].settings.endpoint = 'http://127.0.0.1:9991'", context);
  await vm.runInContext('refreshLocalServices()', context);
  assert.equal(context.calls.length, 2);
  vm.runInContext('snapshot.network_disabled = true', context);
  await vm.runInContext('refreshLocalServices(true)', context);
  vm.runInContext('snapshot.network_disabled = false; settingsDialog.open = false', context);
  await vm.runInContext('refreshLocalServices(true)', context);
  assert.equal(context.calls.length, 2);
});

test('overlapping settings refreshes never duplicate local probes', async () => {
  const context = appContext();
  let release;
  context.probeGate = new Promise(resolve => { release = resolve; });
  context.calls = [];
  vm.runInContext(`settingsDialog.open = true; settingsTab = 'voices';
    command = async action => { calls.push(action); await probeGate; };`, context);
  const first = vm.runInContext('refreshLocalServices(true)', context);
  await vm.runInContext('refreshLocalServices(true)', context);
  assert.equal(context.calls.length, 1);
  release();
  await first;
  assert.equal(vm.runInContext('localRefreshBusy', context), false);
});

test('a local status cached for another address cannot light up the selected connection', () => {
  const context = appContext();
  vm.runInContext(`snapshot.local_services = { gpt_sovits: {
    state: 'ready', endpoint: 'http://127.0.0.1:9880', message: 'old observation'
  } };`, context);
  const status = vm.runInContext('providerStatus', context);
  assert.equal(status('gpt_sovits', { settings: { endpoint: 'http://127.0.0.1:9990' } }).label, '待检查');
  assert.equal(status('gpt_sovits', { settings: { endpoint: 'http://127.0.0.1:9880' } }).tone, 'ready');
});

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

test('current masthead follows logged account identity and logout', () => {
  const context = appContext();
  vm.runInContext("snapshot = { setup: { mode: 'account', room_id: 123 }, account: { user_id: 42, name: '桃子<测试>' } }", context);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('mastheadView(snapshot)', context))), {name:'桃子<测试>',suffix:'的直播间'});
  vm.runInContext("snapshot.preferences = { broadcast_console: true }; snapshot.broadcast = { room: { title: '不应替换用户名字的直播标题' } }", context);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('mastheadView(snapshot)', context))), {name:'桃子<测试>',suffix:'的直播间'});
  vm.runInContext("snapshot.setup.mode = 'anonymous'", context);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('mastheadView(snapshot)', context))), {name:'桃子<测试>',suffix:'的直播间'});
  vm.runInContext("snapshot.account = {}; snapshot.setup = {}", context);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('mastheadView(snapshot)', context))), {name:'直播间',suffix:''});
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
  assert.equal(Object.hasOwn(autosave.payload, 'confirmed'), false, 'consent is never assumed while collecting a draft');
});

// The output select autosaves on change; this drives that real path with the real queue.
function audioAutosaveContext() {
  const context = appContext();
  const select = { name: 'output', tagName: 'SELECT', type: 'select-one', value: '', closest: selector => selector === '[data-form]' ? form : null, matches: () => false };
  const form = { dataset: { form: 'audio' }, elements: { output: select }, fields: { get output() { return select.value; } }, checkValidity: () => true, querySelector: () => null };
  const dialog = context.document.querySelector('#settings');
  dialog.querySelectorAll = selector => selector === '[data-form]' ? [form] : [];
  context.createAutosaveQueue = createAutosaveQueue;
  context.audioForm = form;
  context.calls = [];
  context.confirmReply = false;
  vm.runInContext(`snapshot.preferences = { output: 'default' }; snapshot.queue = { current: { id: 1 }, pending: [{ id: 2 }] };
    copyFormDraft = () => {}; mountSelects = () => calls.push('sync select');
    command = async (action, payload) => { calls.push({ action, payload }); snapshot.preferences.output = payload.preferences.output; return snapshot; };
    confirmAction = async (...args) => { calls.push({ confirm: args }); return confirmReply; };
    mountAutosaves();`, context);
  const choose = async value => {
    select.value = value;
    for (const listener of dialog.listeners.change) await listener({ target: select });
    await vm.runInContext('autosaves.get(audioForm).queue.flush()', context);
  };
  return { context, select, choose };
}

test('choosing another output while speech plays asks before stopping it, and cancelling restores the saved device', async () => {
  const { context, select, choose } = audioAutosaveContext();
  await choose('Speakers');
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [{ confirm: ['应用新的音频输出？', '当前播放和待播队列会停止。', '应用并停止播放', false] }, 'sync select']);
  assert.equal(select.value, '', 'the select returns to the device that is still in use');
  assert.equal(vm.runInContext('autosaves.get(audioForm).touched', context), false, 'a declined change leaves no draft to retry');

  context.calls.length = 0;
  context.confirmReply = true;
  await choose('Speakers');
  assert.equal(context.calls.length, 2);
  assert.ok(context.calls[0].confirm);
  assert.equal(context.calls[1].action, 'preferences.save');
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls[1].payload)), { preferences: { output: { named: 'Speakers' } }, confirmed: true });

  context.calls.length = 0;
  vm.runInContext('snapshot.queue = { current: null, pending: [] }', context);
  await choose('');
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [{ action: 'preferences.save', payload: { preferences: { output: 'default' }, confirmed: true } }], 'nothing to stop: switch without a dialog');
});

test('dots add page shows the recording, optional text and name without an internal role field', () => {
  const context = appContext();
  vm.runInContext("snapshot.local_services = { dots: { state: 'ready', directory: 'D:/dots' } }; lakeVoiceDraft = { audio_path: 'D:/sample.wav', name: '日常播报' };", context);
  const html = vm.runInContext('renderLakeVoiceAdd()', context);
  assert.match(html, /data-action="voice\.reference\.pick"/);
  assert.match(html, /data-voice-draft="reference_text"/);
  assert.match(html, /参考文本（可选）/);
  assert.match(html, /data-voice-draft="name"/);
  assert.match(html, /data-action="voice\.dots\.add"/);
  assert.doesNotMatch(html, /name="voice_id"|dots-stable-role-id|myvoice/);
});

test('multiline templates preserve line breaks and escape user text', () => {
  const context = appContext();
  vm.runInContext(`snapshot.rules = { events: { danmaku_on: true }, templates: { danmaku: '', gift: '礼物', super_chat: '醒目留言', guard: '大航海' }, user_words: [], message_words: [] }; snapshot.assets = []; editor = null;`, context);
  context.multilineTemplate = '第一行\n第二行<&';
  vm.runInContext('snapshot.rules.templates.danmaku = multilineTemplate', context);
  const html = vm.runInContext('renderRulesSettings()', context);
  assert.match(html, /data-lake-template="danmaku"[^>]*>第一行\n第二行&lt;&amp;<\/div>/);
  assert.match(html, /name="template_danmaku" value="第一行\n第二行&lt;&amp;"/);
  assert.doesNotMatch(html, /data-form="preview"/);
});

test('voice drawer has default audition followed by one flat editable list', () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '木兰', connection_id: 'dots-connection', provider: 'dots', voice_id: 'role', speed: 1, volume: 1 }]; snapshot.rules.default_preset_id = 'dots-voice'; snapshot.bindings = []; snapshot.preferences = { tts_enabled: true }; editor = null;", context);
  const html = vm.runInContext('renderVoicesSettings()', context);
  assert.ok(html.indexOf('data-form="voice-audition"') < html.indexOf('id="voice-management"'));
  assert.match(html, /data-default-voice-name>木兰<\/h2>/);
  assert.match(html, /data-form="voice-audition" data-provider="dots"/);
  assert.match(html, /type="hidden" name="preset_id" value="dots-voice"/);
  assert.match(html, /data-action="voice\.add"/);
  assert.match(html, /data-action="voice\.edit" data-id="dots-voice"/);
  assert.match(html, /data-action="voice\.preview" data-id="dots-voice"/);
  assert.doesNotMatch(html, /tts-toggle|service-grid|service\.prefer|binding\.new|<select name="provider"/);
  vm.runInContext("lakeVoiceEditId = 'dots-voice'", context);
  const edit = vm.runInContext('renderVoicesSettings()', context);
  assert.match(edit, /data-form="lake-voice-edit"/);
  // The default voice says so instead of offering a disabled button.
  assert.match(edit, /<span class="voice-edit-default">这是默认声音/);
  assert.match(edit, /data-action="voice\.default" data-id="dots-voice" hidden/);
  assert.match(edit, /data-action="voice\.remove"/);
  // A local voice shows its reference recording first; speed and volume are waterlines, not number fields.
  assert.match(edit, /data-action="voice\.reference\.pick" data-id="dots-voice"/);
  assert.ok(edit.indexOf('voice.reference.pick') < edit.indexOf('name="speed"'));
  assert.doesNotMatch(edit, /type="number"/);
});

test('GPT-SoVITS catalog names and inline edits omit legacy prefixes while keeping custom names', async () => {
  const context = appContext();
  context.calls = [];
  vm.runInContext(`snapshot.connections = [{id:'gpt',settings:{provider:'gpt_sovits'}}];
    editor = { type:'voice-add', provider:'gpt_sovits', connectionId:'gpt' };
    modelScan = { pairs:[{name:'流萤',gpt_path:'D:/m/a.ckpt',sovits_path:'D:/m/a.pth'}], issues:[] };
    command = async (action, payload) => { calls.push({action,payload}); return {result:{id:'new'}}; };
    renderSettings = () => {}; showToast = () => {};`, context);
  await vm.runInContext('handleAction', context)('voice.catalog.pick', '0', {});
  vm.runInContext("lakeVoiceDraft.audio_path='D:/sample.wav'; lakeVoiceDraft.reference_text='你好'", context);
  await vm.runInContext('handleAction', context)('voice.sovits.add', '', {});
  assert.equal(context.calls[0].payload.preset.name, '流萤');
  vm.runInContext(`snapshot.presets = [{id:'old',name:'GPT-SoVITS · 流萤',provider:'gpt_sovits',connection_id:'gpt',voice_id:'流萤',speed:1,volume:1}];
    snapshot.rules.default_preset_id = 'old'; editor = null; voiceBrowse = 'gpt_sovits';`, context);
  context.testForm = { checkValidity:()=>true, dataset:{form:'lake-voice-edit',id:'old'}, fields:{name:'流萤',speed:'1',volume:'1'} };
  assert.equal(vm.runInContext('collectAutosave(testForm).payload.preset.name', context), '流萤');
  assert.match(vm.runInContext('renderVoiceAudition(snapshot.presets, snapshot.presets[0])', context), /data-default-voice-name>流萤<\/h2>/);
  assert.doesNotMatch(vm.runInContext('renderVoiceAudition(snapshot.presets, snapshot.presets[0])', context), /GPT-SoVITS · 流萤/);
  const panel = context.document.querySelector('#tts-menu');
  vm.runInContext('renderVoicePanel()', context);
  assert.match(panel.innerHTML, />流萤<\/(?:span|b)>/);
  assert.doesNotMatch(panel.innerHTML, /GPT-SoVITS · 流萤/);
  context.testForm.fields.name = '自定义流萤';
  assert.equal(vm.runInContext('collectAutosave(testForm).payload.preset.name', context), '自定义流萤');
});

test('stopping a local service sends no live disconnect while the room remains connected', async () => {
  const context = appContext();
  context.calls = [];
  vm.runInContext(`snapshot.live = {running:true,state:'connected'}; snapshot.local_services = {dots:{owned:true}};
    command = async (action, payload) => calls.push({action,payload}); updateServiceIndicators = () => {};`, context);
  await vm.runInContext("handleAction('service.stop', 'dots', null)", context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [{action:'local_services.stop',payload:{provider:'dots',connection_id:'dots-connection'}}]);
  assert.equal(vm.runInContext('snapshot.live.running', context), true);
});

test('choosing a voice as default keeps audition text and the current settings page', async () => {
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
  await vm.runInContext('handleAction', context)('voice.default', 'fish-voice', null);
  assert.equal(calls[0].action, 'presets.default');
  assert.equal(calls[0].payload.id, 'fish-voice');
  assert.equal(calls.length, 1, 'a service choice must not replace the settings page');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '比较音色');
  const html = vm.runInContext('renderVoiceAudition(snapshot.presets, snapshot.presets[1])', context);
  assert.match(html, /data-provider="fish_audio"/);
  assert.match(html, /name="preset_id" value="fish-voice">/);
  assert.match(html, />比较音色<\/textarea>/);
});

test('adding an unavailable service opens its connection page without clearing the default voice', async () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '木兰', provider: 'dots' }]; snapshot.rules.default_preset_id = 'dots-voice'; editor = null; renderSettings=()=>{};", context);
  context.mockCommand = async action => { throw new Error(`unexpected ${action}`); };
  vm.runInContext('command=mockCommand',context);
  await vm.runInContext('handleAction', context)('voice.add', '', {});
  await vm.runInContext('handleAction', context)('voice.provider', 'fish_audio', {});
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');
  assert.equal(vm.runInContext('editor.type', context), 'voice-add');
  assert.equal(vm.runInContext('editor.provider', context), 'fish_audio');
  assert.match(vm.runInContext('renderLakeVoiceAdd()',context), /data-form="service-fish"/);
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
  vm.runInContext('guideDoubaoLogin = mockGuide; command = mockCommand; closeVoicePanel = () => {}', context);
  await vm.runInContext('handleAction', context)('voice.pick', 'doubao-voice', null);
  assert.deepEqual(calls, ['doubao-voice']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');

  context.document.querySelector('#tts-switch').setAttribute = () => {};
  await vm.runInContext('handleAction', context)('voice.login', '', null);
  assert.deepEqual(calls, ['doubao-voice', 'doubao-voice']);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'dots-voice');

  const menu = { hidden: true, innerHTML: '', style: {}, classList: { remove() {} } };
  context.document.querySelector = selector => selector === '#tts-menu' ? menu : { setAttribute() {} };
  await vm.runInContext('handleAction', context)('tts.open', '', { getBoundingClientRect: () => ({ left: 10, bottom: 10 }), setAttribute() {} });
  assert.match(menu.innerHTML, /data-action="voice\.pick" data-id="doubao-voice"/);
  assert.match(menu.innerHTML, /data-action="lake\.voice\.wake" data-id="dots-voice"/);
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

test('connected Doubao without a saved voice opens its catalog without QR or default changes', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections.push({ id: 'doubao-connection', settings: { provider: 'doubao' }, has_credential: true });
    snapshot.presets = [{ id: 'dots-voice', provider: 'dots', connection_id: 'dots-connection' }];
    snapshot.doubao_voices = [{id:'available',name:'温柔'}];
    snapshot.rules.default_preset_id = 'dots-voice'; editor = null; renderSettings=()=>{};`, context);
  context.mockCommand = async action => { throw new Error(`unexpected ${action}`); };
  context.mockGuide = async () => { throw new Error('unexpected QR'); };
  vm.runInContext('command=mockCommand; guideDoubaoLogin=mockGuide',context);
  await vm.runInContext('handleAction', context)('voice.add', '', {});
  await vm.runInContext('handleAction', context)('voice.provider', 'doubao', {});
  assert.equal(vm.runInContext('editor.type', context), 'voice-add');
  assert.equal(vm.runInContext('editor.connectionId', context), 'doubao-connection');
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id',context), 'dots-voice');
  const html = vm.runInContext('renderLakeVoiceAdd()',context);
  assert.match(html, /data-action="voice\.catalog\.add" data-id="available"/);
  assert.doesNotMatch(html, /data-qr-provider|voice\.doubao\.connect/);
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
  await vm.runInContext('handleAction', context)('voice.default', 'dots-b', null);
  assert.equal(calls[0].action, 'presets.default');
  assert.equal(calls[0].payload.id, 'dots-b');
  context.document.querySelector('#tts-switch').setAttribute = () => {};
  await vm.runInContext('handleAction', context)('voice.pick', 'dots-b', null);
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

test('a current default-voice action waits for a pending audition choice and wins', async () => {
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
  const serviceClick = vm.runInContext('handleAction', context)('voice.default', 'dots-voice', null);
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

test('a failed volume save does not block later mute clicks', async () => {
  const context = appContext();
  const calls = [];
  context.saveOrFail = async (action, payload) => {
    assert.equal(action, 'preferences.save');
    calls.push(structuredClone(payload.preferences));
    context.nextPreferences = payload.preferences;
    vm.runInContext('Object.assign(snapshot.preferences, nextPreferences)', context);
  };
  // The harness stubs the queue; model the real one's retained failure.
  vm.runInContext(`snapshot.preferences = {master_volume: 0.65, muted: false}; command = saveOrFail;
    volumeSave.error = new Error('保存失败');
    volumeSave.cancel = () => { volumeSave.error = null; };
    volumeSave.flush = async () => { if (volumeSave.error) throw volumeSave.error; };`, context);
  await vm.runInContext('handleAction', context)('audio.mute');
  assert.equal(vm.runInContext('snapshot.preferences.muted', context), true);
  assert.equal(vm.runInContext('snapshot.preferences.master_volume', context), 0.65);
  assert.equal(vm.runInContext('volumeSave.error', context), null);
  assert.deepEqual(calls.map(preferences => preferences.muted), [true]);
});

test('muted waterline shows zero and retains the saved gain with accessible slider values', () => {
  const context = appContext();
  const output = {textContent: ''};
  const host = { muted: false, classList: { toggle(name, value) { host[name] = value; } } };
  const control = {dataset: {}, attrs: {}, style: { setProperty(name, value) { control[name] = value; } }, setAttribute(name, value) {this.attrs[name] = value;}};
  context.document.querySelector = selector => selector === '.lake-voice-control' ? host : selector === '#main-volume-value' ? output : control;
  vm.runInContext('snapshot.preferences = {master_volume: 0.65, muted: false}; updateVolumeControls();', context);
  assert.equal(control.attrs['aria-label'], '播报音量');
  assert.equal(control.attrs['aria-valuenow'], '65');
  assert.equal(control.attrs['aria-valuetext'], '65%');
  assert.equal(control.attrs['aria-valuemax'], '100');
  assert.equal(control['--volume'], '65%');
  assert.equal(output.textContent, '65');
  vm.runInContext('snapshot.preferences.muted = true; updateVolumeControls();', context);
  assert.equal(host.muted, true);
  assert.equal(control.attrs['aria-valuenow'], '0');
  assert.equal(control.attrs['aria-valuetext'], '0% · 已静音');
  assert.equal(control.title, '取消静音');
  // Muting shows zero while the saved level is kept for unmuting.
  assert.equal(output.textContent, '0');
  assert.equal(control['--volume'], '0%');
  assert.equal(vm.runInContext('snapshot.preferences.master_volume', context), .65);
  vm.runInContext('snapshot.preferences.master_volume = 0; snapshot.preferences.muted = false; updateVolumeControls();', context);
  assert.equal(control.attrs['aria-valuetext'], '0% · 已静音');
  vm.runInContext('volumeDraft = 80; updateVolumeControls();', context);
  assert.equal(control.attrs['aria-valuenow'], '80');
  assert.equal(control.attrs['aria-valuetext'], '80%');
  assert.equal(control['--volume'], '80%');
  assert.equal(host.muted, false);
  vm.runInContext('volumeDraft = null; snapshot.preferences.master_volume = 2; updateVolumeControls();', context);
  assert.equal(control.attrs['aria-valuenow'], '200');
  assert.equal(control.attrs['aria-valuemax'], '200', 'a legacy amplified level remains a valid ARIA value until explicitly adjusted');
  assert.equal(vm.runInContext('snapshot.preferences.master_volume', context), 2);
});

test('failed audition voice switch restores the saved default', async () => {
  const context = appContext();
  vm.runInContext("snapshot.presets = [{ id: 'dots-voice', name: '本地', provider: 'dots' }, { id: 'fish-voice', name: '云端', provider: 'fish_audio' }]; snapshot.rules.default_preset_id = 'dots-voice';", context);
  const errors = [];
  context.mockCommand = async () => { throw new Error('服务暂不可用'); };
  context.mockRender = () => { throw new Error('failed voice save replaced the settings page'); };
  context.mockError = error => errors.push(error.message);
  const voice = { value: 'fish-voice' };
  const form = { dataset: { provider: 'fish_audio' }, elements: { preset_id: voice, text: { value: '保留试听文字' } }, querySelector: () => ({ disabled: false }) };
  vm.runInContext('command = mockCommand; renderSettings = mockRender; showError = mockError', context);
  await vm.runInContext('saveVoiceAuditionChoice', context)(form);
  assert.equal(vm.runInContext('voiceAuditionDraft.provider', context), 'dots');
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '保留试听文字');
  assert.deepEqual(errors, ['服务暂不可用']);
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

test('anonymous navigation and legacy UID forms are disabled before invoking any command', async () => {
  const context = appContext();
  context.calls = [];
  vm.runInContext("command = async action => calls.push(action); snapshot.account = {}; snapshot.setup = { mode: 'anonymous', room_id: 123 }; snapshot.preferences = {};", context);
  for (const action of ['setup.uid', 'room.anonymous']) {
    await assert.rejects(vm.runInContext(`handleAction('${action}', '', null)`, context), /扫码登录/);
  }
  for (const type of ['anonymous', 'room-uid']) {
    context.form = { dataset: { form: type }, fields: { uid: '123' }, elements: {} };
    await assert.rejects(vm.runInContext('handleForm(form, null)', context), /扫码登录/);
  }
  vm.runInContext("step = 'connect'", context);
  assert.doesNotMatch(vm.runInContext('renderStep()', context), /setup\.uid|免登录|输入主播 UID|匿名/);
  vm.runInContext("step = 'login'", context);
  assert.doesNotMatch(vm.runInContext('renderStep()', context), /setup\.uid|改用主播 UID|匿名/);
  assert.equal(context.calls.length, 0);
});

// 2026-10-19: the app never asks to discard a draft (docs/UI-DESIGN.md). An
// unfinished Fish key is left behind, and it still never becomes a draft.
test('leaving with an unsaved Fish API key never prompts and never copies the key into drafts', async () => {
  const context = appContext();
  const form = { dataset: { form: 'service-fish' }, fields: { credential: 'private-test-key' } };
  const input = { id: '', name: 'credential', closest() { return form; } };
  const dialog = context.document.querySelector('#settings');
  dialog.querySelectorAll = selector => selector === '[data-form][data-dirty]' && form.dataset.dirty ? [form] : [];
  const prompts = [];
  context.testConfirm = async (title, message) => { prompts.push({ title, message }); return false; };
  vm.runInContext('confirmAction = testConfirm', context);
  dialog.listeners.input[0]({ target: input });
  assert.equal(form.dataset.dirty, 'true');
  assert.equal(vm.runInContext('formDrafts.size', context), 0);
  const leave = vm.runInContext('allowLeaveSettings', context);
  assert.equal(await leave(), true);
  assert.equal(form.dataset.dirty, undefined);
  assert.deepEqual(prompts, []);
  assert.equal(vm.runInContext('formDrafts.size', context), 0);
});

// Leaving never waits on an unfinished field; it is put down, not kept for later.
test('leaving puts an unfinished automatic field down, while staying on the page keeps it', async () => {
  const context = appContext();
  const form = {
    dataset: { form: 'sound-words' }, fields: {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    cloneNode() { return { dataset: { ...this.dataset }, querySelectorAll() { return []; }, removeAttribute() {}, outerHTML: '<form></form>' }; },
  };
  context.testForm = form;
  context.unfinished = () => { throw new Error('请检查未填或格式不正确的项目'); };
  vm.runInContext(`collectAutosave = unfinished; autosaves.set(testForm, { key: 'advanced:sound-words:new', form: testForm, tab: 'advanced', editor: null, revision: 0, touched: true, invalid: '', lastScheduled: '', baseline: '', queue: { cancel() {}, schedule() {}, flush: async () => {}, saving: false } });`, context);
  assert.equal(await vm.runInContext('flushAutosaves()', context), false, 'an action on the same page waits for the field');
  assert.equal(vm.runInContext('formDrafts.has("advanced:sound-words:new")', context), true);
  assert.equal(await vm.runInContext('allowLeaveSettings()', context), true);
  assert.equal(vm.runInContext('autosaves.get(testForm).touched', context), false);
  assert.equal(vm.runInContext('formDrafts.size', context), 0);
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

test('chat renders large images only for explicitly marked emotes and keeps names accessible without visible text or hover titles', () => {
  const context = appContext();
  const base = { kind: 'danmaku', message: '[妙]' };
  const image = { text: '[妙]', url: 'https://i0.hdslb.com/bfs/live/a.png' };
  context.chatEvent = { ...base, emotes: [{ ...image, large: true }] };
  assert.match(vm.runInContext('renderChatBody(chatEvent)', context), /class="message-emote large"/);
  context.chatEvent = { ...base, emotes: [{ ...image, large: false }] };
  assert.match(vm.runInContext('renderChatBody(chatEvent)', context), /class="message-emote"/);
  for (const large of [false, true]) {
    context.chatEvent = { ...base, emotes: [{ ...image, large }] };
    const body = vm.runInContext('renderChatBody(chatEvent)', context);
    const lake = vm.runInContext('lakeLettersHtml(messageParts(chatEvent)).html', context);
    for (const markup of [body, lake]) {
      assert.match(markup, /alt="" aria-label="\[妙\]"/);
      assert.doesNotMatch(markup, /\btitle=|>\[妙\]</);
    }
  }
});

test('room settings never expose anonymous UID controls, including no-own-room and logged-out states', () => {
  const context = appContext();
  vm.runInContext(`snapshot.account = { user_id: 12 }; snapshot.setup = { mode: 'account', room_id: 34 }; snapshot.qr = { provider: 'bilibili', status: 'complete' }; editor = null;`, context);
  assert.doesNotMatch(vm.runInContext('renderRoomSettings()', context), /data-form="room-uid"/);
  vm.runInContext(`snapshot.setup.room_id = null; snapshot.qr.status = 'expired'; editor = { type: 'qr', provider: 'bilibili' };`, context);
  const fallback = vm.runInContext('renderRoomSettings()', context);
  assert.doesNotMatch(fallback, /data-form="room-uid"|room\.anonymous|主播 UID|匿名/);
  assert.match(fallback, /未找到本账号直播间/);
  assert.doesNotMatch(fallback, /已使用登录账号的直播间/);
  vm.runInContext(`snapshot.setup.room_id = 34; snapshot.live = { state: 'session_expired' }; editor = null;`, context);
  const expired = vm.runInContext('renderRoomSettings()', context);
  assert.match(expired, /登录已失效/);
  assert.match(expired, /重新扫码登录/);
});

test('the room number changes in place: no editor page, form, save or cancel', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.account = { user_id: 12 }; snapshot.setup = { mode: 'account', room_id: 34 }; settingsTab = 'room'; editor = null;`, context);
  const page = vm.runInContext('renderRoomSettings()', context);
  assert.match(page, /<strong>34<\/strong><button[^>]*data-action="lake\.room\.edit"/);
  assert.doesNotMatch(page, /data-form="lake-room"|lake\.room\.save|lake\.editor\.cancel/);
  await vm.runInContext(`handleAction('lake.room.edit', '', null)`, context);
  assert.equal(vm.runInContext('editor', context), null);
  assert.equal(vm.runInContext('settingsViewDepth()', context), 1);
  assert.match(vm.runInContext('lakeRoomNumberField(true)', context), /<input class="lake-room-input" value="34"/);
});

test('a changed room number reconnects a running room; a failed change reconnects the old one; others write nothing', async () => {
  const context = appContext();
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push([action, payload]); if (action === 'live.save' && payload.room_id === 13) throw new Error('fixture failure'); };
  vm.runInContext(`command = mockCommand; showLakeRoomNumber = () => {}; snapshot.setup = { room_id: 34 }; snapshot.live = { running: true };`, context);
  const save = vm.runInContext('saveLakeRoomNumber', context);
  const input = { value: ' 56 ', readOnly: false, isConnected: true };
  await save(input);
  assert.deepEqual(calls.map(([action]) => action), ['live.disconnect', 'live.save', 'live.connect']);
  assert.equal(calls[1][1].room_id, 56);
  assert.equal(input.readOnly, false);
  calls.length = 0;
  input.value = '13';
  await assert.rejects(save(input), /fixture failure/);
  assert.deepEqual(calls.map(([action]) => action), ['live.disconnect', 'live.save', 'live.connect']);
  assert.equal(input.readOnly, false);
  calls.length = 0;
  for (const value of ['', '34', '0', '12a', '99999999999999999']) { input.value = value; await save(input); }
  assert.deepEqual(calls, []);
  vm.runInContext('snapshot.live = { running: false }', context);
  input.value = '78';
  await save(input);
  assert.deepEqual(calls.map(([action]) => action), ['live.save']);
});

test('dots add saves the voice and reference atomically and preserves the draft on failure', async () => {
  const context = appContext();
  const calls = [];
  let failSave = true;
  context.mockCommand = async (action, payload) => {
    calls.push({ action, payload });
    if (failSave) { failSave = false; throw new Error('source missing'); }
    return { result: { id: 'preset-1' } };
  };
  vm.runInContext(`command=mockCommand; renderSettings=()=>{}; showToast=()=>{};
    lakeVoiceDraft={ name:'日常播报', audio_path:'C:/voices/sample.wav', reference_text:'你好' };`,context);
  const add = vm.runInContext('handleAction',context);
  await assert.rejects(add('voice.dots.add','',{}), /source missing/);
  assert.equal(vm.runInContext('editor.type',context), 'voice-add');
  assert.equal(vm.runInContext('lakeVoiceDraft.name',context), '日常播报');
  assert.equal(vm.runInContext('lakeVoiceDraft.audio_path',context), 'C:/voices/sample.wav');
  assert.deepEqual(calls.map(call=>call.action), ['dots.voice.save']);
  assert.equal(calls[0].payload.preset.voice_id,calls[0].payload.profile.role.role);
  assert.equal(calls[0].payload.profile.audio_path,'C:/voices/sample.wav');
  assert.equal(calls[0].payload.make_preferred,false);
  await add('voice.dots.add','',{});
  assert.deepEqual(calls.map(call=>call.action), ['dots.voice.save','dots.voice.save']);
  assert.equal(calls[1].payload.preset.voice_id,calls[1].payload.profile.role.role);
  assert.equal(vm.runInContext('editor',context),null);
  assert.equal(vm.runInContext('Object.keys(lakeVoiceDraft).length',context),0);
});

test('inline edits of a legacy dots voice preserve its service filename without requiring a reference path', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.presets=[{id:'old-1',name:'旧音色',connection_id:'dots-connection',provider:'dots',voice_id:'myvoice.wav',speed:1,volume:1}];`,context);
  const form={ dataset:{form:'lake-voice-edit',id:'old-1'}, fields:{name:'改名',speed:'1.1',volume:'.9'},checkValidity:()=>true };
  const saved=vm.runInContext('collectAutosave',context)(form);
  assert.equal(saved.action,'presets.save');
  assert.equal(saved.payload.preset.voice_id,'myvoice.wav');
  assert.equal(saved.payload.preset.connection_id,'dots-connection');
  assert.equal(saved.payload.preset.name,'改名');
  assert.equal(saved.payload.preset.speed,1.1);
  assert.equal(saved.payload.preset.volume,.9);
});

test('Fish account form uses read-only verification before storing the key', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.local_services = {}; editor = { type: 'service', provider: 'fish_audio' }; renderSettings = () => {}; showToast = () => {};`, context);
  const html = vm.runInContext('renderVoiceConnect("fish_audio", snapshot.connections?.[0])', context);
  assert.match(html, /fish\.open_keys/);
  assert.doesNotMatch(html, /fish\.open_discovery/);
  assert.match(html, /只存在这台电脑上，不会被导出/);
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
  await vm.runInContext('handleAction', context)('voice.add', '', {});
  assert.equal(vm.runInContext('editor.type', context), 'voice-add');
  await vm.runInContext('handleAction', context)('voice.provider', 'fish_audio', {});
  // Connecting happens in place on the Fish tab of the add page.
  assert.equal(vm.runInContext('editor.type', context), 'voice-add');
  assert.equal(vm.runInContext('editor.provider', context), 'fish_audio');
  assert.match(vm.runInContext('renderLakeVoiceAdd()', context), /data-form="service-fish"/);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), null);
});

test('Fish add looks up the voice before saving its official name without generation tuning', async () => {
  const context=appContext();
  const timers=[];
  context.queueLookup=callback=>{timers.push(callback);return timers.length;};
  context.calls=[];
  vm.runInContext(`snapshot.connections=[{id:'fish-1',settings:{provider:'fish_audio'},has_credential:true}];
    editor={type:'voice-add',provider:'fish_audio',connectionId:'fish-1'};
    renderSettings=()=>{};showToast=()=>{};setTimeout=queueLookup;
    command=async(action,payload)=>{calls.push({action,payload});return {result:action==='fish.voice.lookup'?{voice_id:'a'.repeat(32),name:'官方名称'}:{id:'preset-fish'}};};
    lakeVoiceDraft={fish:'https://fish.audio/m/'+'a'.repeat(32)};`,context);
  const html=vm.runInContext('renderLakeVoiceAdd()',context);
  assert.match(html,/data-voice-draft="fish"/);
  assert.doesNotMatch(html,/data-form="fish-settings"|name="model"|name="temperature"/);
  vm.runInContext('scheduleFishLookup()',context);
  assert.equal(timers.length,1);
  await timers[0]();
  assert.equal(vm.runInContext('lakeVoiceDraft.fishFound.name',context),'官方名称');
  await vm.runInContext('handleAction',context)('voice.fish.add','',{});
  assert.deepEqual(context.calls.map(call=>call.action),['fish.voice.lookup','fish.voice.save']);
  assert.equal(context.calls[1].payload.name,'官方名称');
  assert.equal(context.calls[1].payload.id_or_url,'https://fish.audio/m/'+'a'.repeat(32));
});

test('Fish generation settings and targeted audition use their dedicated IPC', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.connections = [{ id: 'fish-1', name: 'Fish Audio', settings: { provider: 'fish_audio' }, has_credential: true }]; snapshot.presets = [{ id: 'preset-fish', connection_id: 'fish-1', provider: 'fish_audio', voice_id: '${'a'.repeat(32)}', name: '测试音色', speed: 1, volume: 1 }]; snapshot.fish_audio_settings = { 'fish-1': { streaming: false } }; snapshot.local_services = {}; editor = { type: 'service', provider: 'fish_audio' }; renderSettings = () => {}; showToast = () => {}; confirmAction = async () => true;`, context);
  const html = vm.runInContext('renderVoiceConnect("fish_audio", snapshot.connections?.[0])', context);
  assert.doesNotMatch(html, /name="streaming"|流式接收音频/);
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push({ action, payload }); return { result: null }; };
  vm.runInContext('command = (action, payload) => mockCommand(action, payload)', context);
  const form = { dataset: { form: 'fish-settings', connectionId: 'fish-1' }, fields: { model: 's2.1-pro-free', latency: 'balanced', volume_db: '-2', temperature: '0.6', top_p: '0.8' } };
  await vm.runInContext('handleForm', context)(form);
  await vm.runInContext('handleAction', context)('voice.preview', 'preset-fish', null);
  assert.deepEqual(calls.map(call => call.action), ['fish.settings.save', 'audition']);
  assert.equal(calls[0].payload.settings.volume_db, -2);
  assert.equal(calls[0].payload.settings.streaming, true);
  assert.equal(calls[1].payload.preset_id, 'preset-fish');
  assert.equal(typeof calls[1].payload.text, 'string');
  calls.length = 0;
  vm.runInContext('confirmAction = async () => { throw new Error("audition must not ask again"); }', context);
  await vm.runInContext('handleAction', context)('voice.preview', 'preset-fish', null);
  assert.deepEqual(calls.map(call => call.action), ['audition']);
});

test('Fish accepts a manually pasted key without a clipboard watcher', async () => {
  const context = appContext();
  vm.runInContext(`snapshot.local_services = {}; editor = { type: 'service', provider: 'fish_audio' }; renderSettings = () => {};`, context);
  const html = vm.runInContext('renderVoiceConnect("fish_audio", snapshot.connections?.[0])', context);
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

test('settings merge legacy categories, and 开播 and OBS 叠加层 into one OBS page', async () => {
  const context = appContext();
  context.document.querySelector().focus = () => {};
  vm.runInContext(`settingsTab = 'voices'; editor = null; renderSettings = () => {}; allowLeaveSettings = async () => true;`, context);
  assert.equal(vm.runInContext('tabs.map(([id]) => id).join()', context), 'home,room,voices,overlay,readings,general,advanced');
  for (const [legacy, page] of [['audio', 'general'], ['appearance', 'general'], ['about', 'general'], ['rules', 'advanced'], ['assets', 'advanced'], ['missing', 'home'], ['overlay', 'overlay'], ['live', 'overlay'], ['broadcast', 'overlay']]) {
    await vm.runInContext('handleAction', context)('settings.tab', legacy);
    assert.equal(vm.runInContext('settingsTab', context), page);
    if (legacy === 'overlay' || legacy === 'live') assert.equal(vm.runInContext('livePanel', context), 'overlay', 'the old overlay entry opens its panel and the page keeps it');
  }
  assert.equal(vm.runInContext('livePanel', context), 'broadcast');
});

test('category navigation returns to its root including when already selected', async () => {
  const context = appContext();
  context.document.querySelector().focus = () => {};
  vm.runInContext(`editor = { type: 'service', provider: 'fish_audio' }; settingsTab = 'voices'; renderSettings = () => {}; allowLeaveSettings = async () => true;`, context);
  await vm.runInContext('handleAction', context)('settings.tab', 'voices');
  assert.equal(vm.runInContext('editor', context), null);
  vm.runInContext(`editor = { type: 'voice-add', provider: 'dots', id: 'draft' }; allowLeaveSettings = async () => false;`, context);
  await vm.runInContext('handleAction', context)('settings.tab', 'room');
  assert.equal(vm.runInContext('settingsTab', context), 'voices');
  assert.equal(vm.runInContext('editor.id', context), 'draft');
});

test('Doubao catalog names stay readable while adding exact internal voice IDs', async () => {
  const context=appContext();context.calls=[];
  vm.runInContext(`snapshot.connections=[{id:'doubao',settings:{provider:'doubao'},has_credential:true}];
    snapshot.doubao_voices=[{id:'zh_female_test_bigtts',name:'温柔桃子'}];
    editor={type:'voice-add',provider:'doubao',connectionId:'doubao'};
    renderSettings=()=>{};showToast=()=>{};command=async(action,payload)=>{calls.push({action,payload});return {result:{id:'new'}};};`,context);
  const html=vm.runInContext('renderLakeVoiceAdd()',context);
  assert.match(html,/>温柔桃子<\/span>/);
  assert.match(html,/data-action="voice\.catalog\.add" data-id="zh_female_test_bigtts"/);
  assert.doesNotMatch(html,/datalist|音色 ID/);
  await vm.runInContext('handleAction',context)('voice.catalog.add','zh_female_test_bigtts',{});
  assert.equal(context.calls[0].payload.preset.name,'温柔桃子');
  assert.equal(context.calls[0].payload.preset.voice_id,'zh_female_test_bigtts');
});

test('GPT-SoVITS catalog renders replacement-pattern names literally and escapes HTML', () => {
  const context=appContext();
  context.specialName='a$`b$&';
  vm.runInContext(`snapshot.connections=[{id:'gpt',settings:{provider:'gpt_sovits'}}];
    snapshot.local_services={gpt_sovits:{state:'ready',directory:'D:/models'}};
    modelScan={pairs:[{name:specialName,version:'v2',gpt_path:'D:/a.ckpt',sovits_path:'D:/a.pth'}],issues:[]};
    editor={type:'voice-add',provider:'gpt_sovits',connectionId:'gpt'};`,context);
  const special=vm.runInContext('renderLakeVoiceAdd()',context);
  vm.runInContext("modelScan.pairs[0].name='plain'",context);
  const plain=vm.runInContext('renderLakeVoiceAdd()',context);
  assert.equal(special.split('class="voice-catalog-row').length-1,1);
  assert.equal(special,plain.split('>plain<small').join('>a$`b$&amp;<small'));
  assert.match(special,/a\$`b\$&amp;/);
});

test('number fields suppress f32 noise and preserve text identifiers', () => {
  const context = appContext();
  const format = vm.runInContext('displayNumber', context);
  assert.equal(format(0.699999988079071), .7);
  assert.equal(format(1.2000000476837158), 1.2);
  assert.equal(format(12345678912345), 12345678912345);
  assert.equal(format('000123456789'), '000123456789');
});

test('Fish inline voice edits autosave names and numbers while preserving hidden provider IDs', () => {
  const context=appContext();
  vm.runInContext(`snapshot.connections=[{id:'fish',settings:{provider:'fish_audio'},has_credential:true}];
    snapshot.presets=[{id:'voice',provider:'fish_audio',connection_id:'fish',voice_id:'${'a'.repeat(32)}',name:'测试',speed:1,volume:1}];
    editor=null;lakeVoiceEditId='voice';`,context);
  const form={checkValidity:()=>true,dataset:{form:'lake-voice-edit',id:'voice'},fields:{name:'新的中文名称',speed:'1.2',volume:'.8'}};
  const saved=vm.runInContext('collectAutosave',context)(form);
  assert.equal(saved.payload.preset.name,'新的中文名称');assert.equal(saved.payload.preset.speed,1.2);assert.equal(saved.payload.preset.volume,.8);
  assert.equal(saved.payload.preset.voice_id,'a'.repeat(32));assert.equal(saved.payload.preset.connection_id,'fish');
  const html=vm.runInContext('renderVoicesSettings()',context);
  assert.match(html,/data-form="lake-voice-edit"/);
  assert.doesNotMatch(html,/音色 ID|保存音色|更改自动保存|已自动保存|a{32}/);
  assert.match(html,/class="autosave-status"[^>]+ hidden/);
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

test('appearance page exposes a persisted language choice in both languages', () => {
  const context = appContext();
  vm.runInContext("snapshot.preferences = { language: 'en', appearance: 'dark', scale: 1.2 }; applyLanguage();", context);
  const html = vm.runInContext('renderAppearanceSettings()', context);
  assert.match(html, /name="language"/);
  assert.match(html, /value="en" checked><span>English/);
  assert.match(html, /value="zh-CN"><span>简体中文/);
  assert.match(html, /Interface language/);
  assert.match(html, /name="appearance" value="dark" checked/);
  assert.doesNotMatch(html.replace('简体中文', ''), /\p{Script=Han}/u);
  assert.equal(context.document.documentElement.lang, 'en');
  assert.equal(context.document.title, 'DanmakuVoice');
  vm.runInContext("snapshot.preferences.language = 'zh-CN'; applyLanguage();", context);
  assert.match(vm.runInContext('renderAppearanceSettings()', context), /界面语言/);
});

test('language change flushes existing edits and saves only the language preference', async () => {
  const context = appContext();
  const calls = [];
  context.flushLanguage = async () => { calls.push('flush'); return true; };
  context.saveLanguage = async (action, payload) => {
    calls.push({ action, payload: structuredClone(payload) });
    context.changedLanguage = payload.preferences.language;
    vm.runInContext('snapshot.preferences.language = changedLanguage; applyLanguage()', context);
  };
  context.languageToast = message => calls.push(message);
  vm.runInContext("snapshot.preferences = {language: 'zh-CN'}; flushAutosaves = flushLanguage; command = saveLanguage; showToast = languageToast;", context);
  await vm.runInContext('changeLanguage', context)('en');
  assert.deepEqual(calls, ['flush', { action:'preferences.save', payload:{preferences:{language:'en'}} }, 'Language saved']);
  await vm.runInContext('changeLanguage', context)('en');
  assert.equal(calls.length, 3);
});

test('failed settings flush or language save leaves the current language intact', async () => {
  const context = appContext();
  let saves = 0;
  context.failFlush = async () => false;
  context.failLanguage = async () => { saves++; throw new Error('cannot save'); };
  vm.runInContext("snapshot.preferences = {language:'zh-CN'}; flushAutosaves = failFlush; command = failLanguage;", context);
  await vm.runInContext('changeLanguage', context)('en');
  assert.equal(saves, 0);
  vm.runInContext('flushAutosaves = async () => true', context);
  await assert.rejects(vm.runInContext('changeLanguage', context)('en'), /cannot save/);
  assert.equal(saves, 1);
  assert.equal(getLanguage(), 'zh-CN');
});

test('language rerenders both surfaces without restarting QR login, translating only the untouched sample', () => {
  const context = appContext();
  const calls = [];
  context.languageRenderApp = () => calls.push('app');
  context.languageRenderSettings = () => calls.push('settings');
  context.startingStep = () => 'login';
  vm.runInContext("step = 'login'; settingsDialog.open = true; renderApp = languageRenderApp; renderSettings = languageRenderSettings; updateQr = () => {}; snapshot.preferences = {language:'zh-CN'};", context);
  const next = vm.runInContext("({...snapshot, preferences:{language:'en'}})", context);
  vm.runInContext('acceptSnapshot', context)(next);
  assert.deepEqual(calls, ['app','settings']);
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), 'Hello, welcome to the stream.');
  vm.runInContext(`voiceAuditionDraft.text = '我的自定义试听句'; voiceAuditionDraft.customText = true;`, context);
  vm.runInContext('acceptSnapshot', context)(vm.runInContext("({...snapshot, preferences:{language:'zh-CN'}})", context));
  assert.equal(vm.runInContext('voiceAuditionDraft.text', context), '我的自定义试听句');
});

test('snapshot polling leaves the shell title unchanged until the language changes', () => {
  const context = appContext();
  const titles = [];
  let title = '';
  Object.defineProperty(context.document, 'title', {
    get: () => title,
    set: value => { title = value; titles.push(value); },
  });
  vm.runInContext(`step = 'login'; settingsDialog.open = false;
    renderApp = () => {}; updateQr = () => {};
    snapshot.config_revision = 1; snapshot.preferences = {language:'zh-CN'};`, context);
  const accept = vm.runInContext('acceptSnapshot', context);
  for (let i = 0; i < 20; i++) accept({ config_revision: 1, config_unchanged: true, live: { errors: i } });
  assert.deepEqual(titles, ['超绝可爱弹幕姬']);
  accept(vm.runInContext("({...snapshot, config_revision:2, config_unchanged:false, preferences:{language:'en'}})", context));
  for (let i = 0; i < 20; i++) accept({ config_revision: 2, config_unchanged: true, live: { errors: i } });
  assert.deepEqual(titles, ['超绝可爱弹幕姬', 'DanmakuVoice']);
  accept(vm.runInContext("({...snapshot, config_revision:3, config_unchanged:false, preferences:{language:'zh-CN'}})", context));
  assert.deepEqual(titles, ['超绝可爱弹幕姬', 'DanmakuVoice', '超绝可爱弹幕姬']);
});

test('chat keeps updating during a long command and polls started before its reply are dropped', async () => {
  const context = appContext();
  context.document.querySelectorAll = () => [];
  const requests = [];
  context.window.__TAURI__ = { core: { invoke: (command, args) => new Promise(resolve => requests.push({ command, args, resolve })) } };
  const state = (received, live) => ({ config_revision: 1, live: { running: true, state: 'connected', received }, queue: {}, broadcast: { live } });
  vm.runInContext("step = 'tts'; scheduleSnapshotPolling = () => {}; refreshLocalServices = async () => {};", context);
  context.initial = state(1, false);
  vm.runInContext('snapshot = initial', context);
  const broadcast = vm.runInContext("command('broadcast.start', {}, { quiet: true })", context);
  assert.equal(requests.length, 1);
  const during = vm.runInContext('pollSnapshot()', context);
  assert.equal(requests[1]?.command, 'snapshot', 'a command waiting for OBS must not freeze danmaku, queue and audience');
  requests[1].resolve(state(2, false));
  await during;
  assert.equal(vm.runInContext('snapshot.live.received', context), 2);
  const racing = vm.runInContext('pollSnapshot()', context);
  requests[0].resolve(state(3, true));
  await broadcast;
  requests[2].resolve(state(2, false));
  await racing;
  assert.equal(vm.runInContext('snapshot.broadcast.live', context), true, 'a poll started before the command reply cannot roll it back');
  assert.equal(vm.runInContext('snapshot.live.received', context), 3);
  const after = vm.runInContext('pollSnapshot()', context);
  requests[3].resolve(state(4, true));
  await after;
  assert.equal(vm.runInContext('snapshot.live.received', context), 4);
});

test('leaving the main screen stops the lake clock', () => {
  const context = appContext();
  context.lakeSceneMarkup = () => '';
  context.document.querySelectorAll = () => [];
  const cleared = [];
  context.clearInterval = id => cleared.push(id);
  const surface = context.document.querySelector('#surface');
  surface.setAttribute = () => {};
  context.document.querySelector = selector => selector.startsWith('#titlebar') || selector === '[data-titlebar-name]' || selector === '#lake-orb' ? null : surface;
  vm.runInContext("lakeClockTimer = 41; step = 'welcome'; renderApp();", context);
  assert.deepEqual(cleared, [41]);
  assert.equal(vm.runInContext('lakeClockTimer', context), null);
});

test('new messages entering the open history keep the entry being read in place', () => {
  const context = appContext();
  const scroll = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 500 }) };
  const feed = { children: [], set innerHTML(html) {
    this.children = [...html.matchAll(/data-id="([^"]+)"/g)].map((match, index) => ({ dataset: { id: match[1] },
      getBoundingClientRect: () => ({ top: 100 + index * 40 - scroll.scrollTop, bottom: 140 + index * 40 - scroll.scrollTop }) }));
  } };
  const nodes = new Map([['#chat-feed', feed], ['#chat-scroll', scroll]]);
  const surface = context.document.querySelector('#surface');
  context.document.querySelector = selector => nodes.has(selector) ? nodes.get(selector) : surface;
  vm.runInContext('lakeDeep = true;', context);
  const events = count => Array.from({ length: count }, (_, index) => ({ kind: 'danmaku', user_name: `观众${index}`, message: `第${index}句`, observed_at_ms: 1_700_000_000_000 + index }));
  const render = list => { context.list = list; vm.runInContext('renderLakeHistory(list, list.map((event, index) => `k${event.observed_at_ms}`))', context); };
  render(events(10));
  render(events(11));
  assert.equal(scroll.scrollTop, 0, 'at the top the newest message stays in view');
  scroll.scrollTop = 200;
  const reading = feed.children[5].dataset.id;
  render(events(13));
  assert.equal(feed.children[7].dataset.id, reading);
  assert.equal(scroll.scrollTop, 280, 'the entry being read stays under the same point');
});

test('a second voice chip chosen while the first binding is being created updates that binding', async () => {
  const context = appContext();
  context.requests = [];
  vm.runInContext(`snapshot.bindings = []; snapshot.presets = [{ id: 'a', name: '甲', provider: 'dots' }, { id: 'b', name: '乙', provider: 'dots' }];
    viewerContext = { user_name: 'Alice', user_id: 7 }; updateViewerVoices = () => {};
    command = (action, payload) => new Promise(resolve => requests.push({ action, payload, resolve: () => {
      const id = payload.id || 'created-' + requests.length;
      snapshot.bindings = [...snapshot.bindings.filter(entry => entry.id !== id), { id, binding: payload.binding }];
      resolve({ ...snapshot, result: { id } });
    } }));`, context);
  const first = vm.runInContext("handleAction('viewer.bind', 'a', null)", context);
  const second = vm.runInContext("handleAction('viewer.bind', 'b', null)", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.requests.length, 1, 'the second choice waits for the binding the first one creates');
  context.requests[0].resolve();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.requests[1]?.payload.id, 'created-1');
  assert.equal(context.requests[1].payload.binding.preset_id, 'b');
  context.requests[1].resolve();
  await second;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('snapshot.bindings.map(entry => [entry.id, entry.binding.preset_id])', context))), [['created-1', 'b']]);
});

// A minimal composer whose controls drop focus when disabled, as browsers do.
function composeContext() {
  const context = appContext();
  const body = { id: 'body' };
  context.document.body = body;
  const control = extra => {
    const node = { hidden: false, isConnected: true, dataset: {}, attrs: {}, title: '', innerHTML: '', textContent: '', classList: { toggle() {} },
      setAttribute(key, value) { this.attrs[key] = value; }, focus() { context.document.activeElement = this; }, ...extra };
    let disabled = false;
    Object.defineProperty(node, 'disabled', { get: () => disabled, set: value => { disabled = !!value; if (disabled && context.document.activeElement === node) context.document.activeElement = body; } });
    return node;
  };
  const input = control({ id: 'chat-message', value: '你好', maxLength: 20 });
  const submit = control({ type: 'submit' });
  const emoji = control({});
  const form = control({ contains: node => [input, submit, emoji].includes(node) });
  const parts = { form, '#chat-message': input, '.chat-compose-note': control({}), '.lake-compose-count': control({}), '[data-action="chat.emoticons"]': emoji, 'button[type="submit"]': submit };
  const host = control({ querySelector: selector => parts[selector] ?? null, querySelectorAll: () => [input, submit, emoji] });
  const count = parts['.lake-compose-count'];
  const surface = context.document.querySelector('#surface');
  const nodes = new Map([['#chat-compose', host], ['#chat-compose form', form], ['#chat-message', input], ['#chat-emoticon-picker', null]]);
  context.document.querySelector = selector => nodes.has(selector) ? nodes.get(selector) : surface;
  context.requests = [];
  vm.runInContext(`step = 'main'; snapshot = { account: { user_id: 42 }, setup: { room_id: 99 }, chat_send: { account_id: 42, room_id: 99, message_limit: 20 }, preferences: {} };
    showToast = () => {}; command = (action, payload) => new Promise(resolve => requests.push({ action, payload, resolve: () => resolve(snapshot) }));
    chatMessageDraft = '你好'; updateChatCompose();`, context);
  return { context, input, submit, body, count };
}

test('the chat counter and @-mention prefill count what the field and platform enforce', async () => {
  const { context, input, count } = composeContext();
  input.value = '😀😀a';
  vm.runInContext('updateChatCompose()', context);
  assert.equal(count.textContent, '5/20', 'maxlength and the platform both count UTF-16 units');
  vm.runInContext(`chatMessageDraft = ''; viewerContext = { user_name: '${'😀'.repeat(10)}', user_id: 9 };
    renderViewerDrawer = () => {}; updateLive = () => {};`, context);
  await vm.runInContext("handleAction('viewer.at', '', null)", context);
  const draft = vm.runInContext('chatMessageDraft', context);
  assert.equal(draft.isWellFormed(), true, 'a cut surrogate pair would be rejected as invalid JSON');
  assert.equal(draft, '@' + '😀'.repeat(9));
  assert.equal(input.value, draft);
});

test('sending chat keeps the composer focused for the next message', async () => {
  const { context, input, submit, body } = composeContext();
  input.focus();
  const sent = vm.runInContext('sendChatMessage()', context);
  assert.equal(context.requests[0].action, 'bili.chat.send');
  context.requests[0].resolve();
  await sent;
  assert.equal(input.disabled, false);
  assert.equal(context.document.activeElement, input, 'Enter-to-send returns to the field');

  vm.runInContext("chatMessageDraft = '再来一条'", context);
  input.value = '再来一条';
  vm.runInContext('updateChatCompose()', context);
  submit.focus();
  const clicked = vm.runInContext('sendChatMessage()', context);
  context.requests[1].resolve();
  await clicked;
  assert.equal(context.document.activeElement, input, 'the emptied send button is disabled, so focus returns to the field');

  const elsewhere = { id: 'elsewhere' };
  vm.runInContext("chatMessageDraft = '第三条'", context);
  input.value = '第三条';
  vm.runInContext('updateChatCompose()', context);
  input.focus();
  const moved = vm.runInContext('sendChatMessage()', context);
  context.document.activeElement = elsewhere;
  context.requests[2].resolve();
  await moved;
  assert.equal(context.document.activeElement, elsewhere, 'focus the person moved elsewhere is not taken back');
  assert.notEqual(body, elsewhere);
});

test('a failing viewer alias save is shown but never traps the card or settings, and its draft survives', async () => {
  const context = appContext({ createAutosaveQueue });
  context.saved = [];
  context.opened = [];
  vm.runInContext(`step = 'main'; snapshot.rules = { user_words: [{ from: 'Bob', to: '老鲍' }] }; snapshot.account = {};
    renderViewerDrawer = () => {}; updateLive = () => {}; closeVoicePanel = () => {}; openSettings = async tab => { opened.push(tab); };
    command = async () => { throw new Error('rules save failed'); };
    viewerContext = { user_name: 'Alice', user_id: 7 }; viewerOpenIdentity = 'uid:7';`, context);
  vm.runInContext("scheduleViewerAlias('小A')", context);
  await vm.runInContext("handleAction('viewer.close', '', null)", context);
  assert.equal(vm.runInContext('viewerContext', context), null, 'the card closes even though the save failed');
  assert.match(vm.runInContext('errorText', context), /rules save failed/);
  assert.equal(vm.runInContext("viewerAliasValue({ user_name: 'Alice' })", context), '小A', 'reopening the card shows the unsaved alias');

  vm.runInContext("viewerContext = { user_name: 'Bob', user_id: 8 }; errorText = ''; scheduleViewerAlias('鲍勃')", context);
  await vm.runInContext("handleAction('settings.open', '', null)", context);
  assert.deepEqual(context.opened, ['home'], 'settings still open');
  assert.equal(vm.runInContext('viewerContext', context), null);
  assert.match(vm.runInContext('errorText', context), /rules save failed/);

  vm.runInContext('command = async (action, payload) => { saved.push(payload.rules.user_words); snapshot.rules = payload.rules; return snapshot; }', context);
  assert.equal(await vm.runInContext('flushViewerAlias()', context), true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.saved.at(-1))), [{ from: 'Alice', to: '小A' }, { from: 'Bob', to: '鲍勃' }], 'both drafts are kept until a save succeeds');
  assert.equal(vm.runInContext("viewerAliasValue({ user_name: 'Alice' })", context), '小A');
  assert.equal(vm.runInContext('viewerAliasDrafts.size', context), 0);
});

test('advanced message settings pin emote filtering and preserve readings and templates', () => {
  const context = appContext();
  vm.runInContext(`snapshot.rules = {events:{danmaku_on:true,gift_on:true,free_gift_on:false,super_chat_on:true,guard_on:true,gift_threshold_yuan:8,super_chat_threshold_yuan:30},templates:{danmaku:'{message}',gift:'{gift_name}',super_chat:'{message}',guard:'{guard_name}'},user_words:[],message_words:[],sounds:[]}`, context);
  const html = vm.runInContext('renderRulesSettings()', context);
  assert.doesNotMatch(html, /过滤 B站官方表情|name="filter_bilibili_emoticons"|data-form="preview"/);
  assert.match(html, /data-form="lake-thresholds"/);
  assert.match(html, /data-form="lake-templates"/);
  vm.runInContext('snapshot.rules.events.filter_bilibili_emoticons = false', context);
  context.testForm = { dataset:{form:'lake-thresholds'}, fields:{danmaku_on:'on',gift_on:'on',super_chat_on:'on',guard_on:'on',gift_threshold_yuan:'8',super_chat_threshold_yuan:'30'},querySelectorAll:()=>[],checkValidity:()=>true };
  const saved = vm.runInContext('collectAutosave(testForm)', context);
  assert.equal(saved.action, 'rules.save');
  assert.equal(saved.payload.rules.events.filter_bilibili_emoticons, true);
  assert.equal(saved.payload.rules.events.gift_threshold_yuan, 8);
  assert.equal(saved.payload.rules.templates.danmaku, '{message}');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.payload.rules.user_words)), []);
});

test('main screen speech switch, queue jump and spotlight use real queue data', async () => {
  const context = appContext();
  const calls = [];
  context.mockCommand = async (action, payload) => { calls.push([action, payload]); };
  vm.runInContext("command = mockCommand; snapshot.setup = { tts_enabled: true }; snapshot.preferences = { tts_enabled: true };", context);
  await vm.runInContext('handleAction', context)('speech.toggle', '', null);
  await vm.runInContext('handleAction', context)('queue.jump', '42', null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['preferences.save', { preferences: { tts_enabled: false } }], ['queue.jump', { id: 42 }]]);
  const spotlight = vm.runInContext('spotlightKey', context);
  const events = [
    { kind: 'danmaku', user_name: '甲', message: '早上好' },
    { kind: 'danmaku', user_name: '乙', message: '你好' },
    { kind: 'danmaku', user_name: '甲', message: '晚上好' },
  ];
  const keys = ['a', 'b', 'c'];
  assert.equal(spotlight(events, keys, { origin: 'live', user_name: '甲', text: '甲说早上好' }), 'a');
  assert.equal(spotlight(events, keys, { origin: 'live', user_name: '甲', text: '改写后的文字' }), 'c');
  assert.equal(spotlight(events, keys, { origin: 'audition', user_name: '甲', text: '早上好' }), '');
  assert.equal(spotlight(events, keys, null), '');
  // A job keeps its line while a later message with the same words arrives.
  const repeated = [
    { kind: 'danmaku', user_name: '甲', message: '钓鱼' },
    { kind: 'danmaku', user_name: '乙', message: '你好' },
  ];
  assert.equal(spotlight(repeated, ['x', 'y'], { id: 7, origin: 'live', user_name: '甲', text: '甲说钓鱼' }), 'x');
  repeated.push({ kind: 'danmaku', user_name: '甲', message: '钓鱼' });
  assert.equal(spotlight(repeated, ['x', 'y', 'z'], { id: 7, origin: 'live', user_name: '甲', text: '甲说钓鱼' }), 'x');
  // The next job with the same words takes the next matching line.
  assert.equal(spotlight(repeated, ['x', 'y', 'z'], { id: 8, origin: 'live', user_name: '甲', text: '甲说钓鱼' }), 'z');
});

test('feed groups one viewer, adds time breaks and keeps the read line as its own card', () => {
  const context = appContext();
  const feedItems = vm.runInContext('feedItems', context);
  const at = minutes => 1_700_000_000_000 + minutes * 60_000;
  const events = [
    { kind: 'danmaku', user_id: 5, user_name: '甲', message: '一', observed_at_ms: at(0) },
    { kind: 'danmaku', user_id: 5, user_name: '甲', message: '二', observed_at_ms: at(1) },
    { kind: 'danmaku', user_id: 5, user_name: '甲', message: '三', observed_at_ms: at(9) },
    { kind: 'gift', user_id: 6, user_name: '乙', gift_name: '花', quantity: 2, observed_at_ms: at(9) },
    { kind: 'danmaku', user_id: 5, user_name: '甲', message: '四', observed_at_ms: at(10) },
  ];
  const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
  const shape = items => JSON.parse(JSON.stringify(items.map(item => item.type + (item.events ? item.events.length : ''))));
  assert.deepEqual(shape(feedItems(events, keys, '')), ['run2', 'time', 'run1', 'gift', 'run1']);
  assert.deepEqual(shape(feedItems(events, keys, 'k2')), ['run1', 'spot', 'time', 'run1', 'gift', 'run1']);
  const jobText = vm.runInContext('jobDisplayText', context);
  assert.equal(jobText({ user_name: '甲', text: '甲说四' }, events), '四');
  assert.equal(jobText({ user_name: '丙', text: '丙说你好' }, events), '丙说你好');
});

const overlaySnapshot = () => ({
  settings: { enabled: true, style: 'spine', corner: 'top_right', offset_x: 0, offset_y: 0, scale: 1.100000023841858, vignette: 0.6000000238418579, title: '今晚的弹幕', tagline: '', show_danmaku: true, show_gift: true, show_super_chat: true, show_guard: false, names: 'special', merge_duplicates: true, linger_seconds: 14, port: 47823, token: '0123456789abcdef0123456789abcdef' },
  running: true, port: 47823, url: 'http://127.0.0.1:47823/overlay?token=0123456789abcdef0123456789abcdef', error: null, clients: [{ width: 3840, height: 1728 }],
});

test('overlay settings render connection, placement and advanced without retired controls', () => {
  const context = appContext();
  context.overlay = overlaySnapshot();
  context.overlay.settings.enabled = false;
  vm.runInContext("snapshot.overlay = overlay; settingsTab = 'overlay'; editor = null; snapshot.obs = { settings: { host: '127.0.0.1', port: 4455 }, status: { state: 'idle' } };", context);
  const connect = vm.runInContext('renderSettingsPage()', context);
  assert.match(connect, /data-obs-view="connect"/);
  assert.match(connect, /data-form="obs"/);
  assert.match(connect, /data-obs-secret/);
  assert.doesNotMatch(connect, /data-form="overlay"/);
  // Once the overlay was added, a closed OBS keeps the stage instead of the form.
  context.overlay.settings.enabled = true;
  vm.runInContext("snapshot.obs.status = { state: 'error', message: '无法连接 OBS（连接被拒绝） [DV-OB01]' };", context);
  const offline = vm.runInContext('renderSettingsPage()', context);
  assert.match(offline, /data-obs-view="offline"/);
  assert.match(offline, /data-ovp-drag/);
  assert.match(offline, /data-action="lake\.obs\.launch"/);
  assert.doesNotMatch(offline, /data-form="obs"/);
  assert.equal(vm.runInContext('isLakeObsWide()', context), true);
  // A rejected password still needs the connection form.
  vm.runInContext("snapshot.obs.status = { state: 'error', message: 'OBS WebSocket 密码不正确 [DV-OB03]' };", context);
  assert.match(vm.runInContext('renderSettingsPage()', context), /data-obs-view="connect"/);
  vm.runInContext("snapshot.obs.status = { state: 'ok' };", context);
  const html = vm.runInContext('renderSettingsPage()', context);
  assert.match(html, /data-form="overlay"/);
  assert.match(html, /data-ovp-drag/);
  assert.match(html, /data-ovp-resize/);
  assert.match(html, /data-ovp-edit="title"/);
  assert.match(html, /data-ovp-edit="tagline"/);
  assert.match(html, /data-action="overlay\.obs_add"/);
  assert.match(html, /type="hidden" name="corner" value="top_right"/);
  assert.match(html, /type="hidden" name="title" value="今晚的弹幕"/);
  assert.match(html, /type="hidden" name="offset_x" value="0"/);
  assert.match(html, /type="hidden" name="offset_y" value="0"/);
  assert.doesNotMatch(html, /data-action="overlay\.(?:copy|test)"|name="(?:style|linger_seconds)"|实验/);
  // 2026-10-18: readability is the streamer's again, under the preview rather than in 高级.
  assert.match(html, /type="range" name="vignette" min="0" max="1" step="0.01" value="0.6000000238418579"/);
  assert.match(html, /type="range" name="history_opacity" min="0.3" max="1" step="0.01" value="0.72"/);
  assert.doesNotMatch(html, /0123456789abcdef0123456789abcdef/);
  assert.equal(vm.runInContext('isLakeObsWide()', context), true);
  const advanced = vm.runInContext("lakeObsPage = 'advanced'; renderSettingsPage()", context);
  assert.match(advanced, /data-form="obs-link"/);
  assert.match(advanced, /name="names" value="special" checked/);
  assert.match(advanced, /name="show_guard" value="on"/);
  assert.doesNotMatch(advanced, /data-action="overlay\.token\.reset"|lake-obs-advanced-foot|name="(?:vignette|history_opacity)"/);
  assert.equal(vm.runInContext('isLakeObsWide()', context), false);
  assert.equal(vm.runInContext('overlayPreviewSize().width', context), 3840);
});

test('overlay binding state is independent from browser clients and reports actual canvas', () => {
  const context = appContext();
  context.overlay = overlaySnapshot();
  vm.runInContext("snapshot.overlay = overlay; snapshot.obs = { status: { state: 'ok' } };", context);
  const status = () => vm.runInContext('overlayStatus()', context);
  context.overlay.clients.push({ width: 1920, height: 1080 });
  assert.equal(status().tone, 'pending', 'ordinary browser clients are not evidence of a managed OBS source');
  assert.equal(status().text, '叠加层还没放进场景');
  vm.runInContext("snapshot.obs.status.overlay_sync = {state:'ready', scene:'游戏场景', width:2560, height:1440};", context);
  assert.equal(status().text, '已放进场景「游戏场景」');
  assert.equal(vm.runInContext('overlayPreviewSize().width', context), 2560);
  vm.runInContext('snapshot.obs.status.canvas_width = 1080; snapshot.obs.status.canvas_height = 1920;', context);
  assert.equal(vm.runInContext('overlayPreviewSize().width', context), 1080, 'the current base canvas supersedes an older source size');
  assert.equal(vm.runInContext('overlayPreviewSize().height', context), 1920);
  context.overlay.error = 'OBS 叠加层无法使用本机端口 47823 起的 10 个端口：拒绝访问 [DV-O01]';
  assert.equal(status().tone, 'error');
  assert.match(status().text, /DV-O01/);
  vm.runInContext("snapshot.preferences = { language: 'en' }; applyLanguage(); overlay.settings.title = 'Tonight'; overlay.error = null; snapshot.obs.status.overlay_sync = {state:'ready'};", context);
  assert.equal(status().tone, 'ready');
  assert.doesNotMatch(status().text, /\p{Script=Han}/u);
  const html = vm.runInContext("settingsTab = 'overlay'; editor = null; renderSettingsPage()", context);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
  assert.match(html, /Add to OBS/);
});

test('overlay partial autosave preserves source identity and unrelated choices while retiring style controls', () => {
  const context = appContext();
  context.overlay = overlaySnapshot();
  vm.runInContext("snapshot.overlay = overlay;", context);
  const fields = { corner: 'bottom_left', offset_x: '-37', offset_y: '121', scale: '1.25', title: ' 深夜电台 ', tagline: 'one more round.' };
  context.overlayForm = { dataset: { form: 'overlay' }, fields, elements: Object.fromEntries(Object.keys(fields).map(key => [key, {}])), checkValidity: () => true };
  const envelope = vm.runInContext('collectAutosave(overlayForm)', context);
  assert.equal(envelope.action, 'overlay.save');
  // The stored shade passes through untouched; it is no longer pinned to 0.6.
  assert.deepEqual(JSON.parse(JSON.stringify(envelope.payload.settings)), { ...context.overlay.settings, style: 'spine', corner: 'bottom_left', offset_x: -37, offset_y: 121, scale: 1.25, title: '深夜电台', tagline: 'one more round.', linger_seconds: 14 });
  for (const [vignette, history, ok] of [['1', '0.3', true], ['0', '1', true], ['1.01', '0.72', false], ['0.6', '0.29', false]]) {
    context.overlayForm.fields = { ...fields, vignette, history_opacity: history };
    context.overlayForm.elements = Object.fromEntries(Object.keys(context.overlayForm.fields).map(key => [key, {}]));
    if (ok) assert.deepEqual(['vignette', 'history_opacity'].map(key => vm.runInContext('collectAutosave(overlayForm)', context).payload.settings[key]), [Number(vignette), Number(history)]);
    else assert.throws(() => vm.runInContext('collectAutosave(overlayForm)', context));
  }
  context.overlayForm.fields = fields;
  context.overlayForm.elements = Object.fromEntries(Object.keys(fields).map(key => [key, {}]));
  fields.title = '  ';
  assert.throws(() => vm.runInContext('collectAutosave(overlayForm)', context), /主标题/);
  for (const invalid of ['字'.repeat(25), '坏\u0085标题']) {
    fields.title = invalid;
    assert.throws(() => vm.runInContext('collectAutosave(overlayForm)', context), /主标题/);
  }
  fields.title = '字'.repeat(24);
  assert.equal(vm.runInContext('collectAutosave(overlayForm).payload.settings.title', context), fields.title);
  for (const key of ['offset_x', 'offset_y']) {
    for (const invalid of ['1.5', '-8193', '8193', 'NaN']) {
      fields[key] = invalid;
      assert.throws(() => vm.runInContext('collectAutosave(overlayForm)', context), /位置偏移/);
    }
    for (const valid of ['-8192', '8192', '0']) {
      fields[key] = valid;
      assert.equal(vm.runInContext('collectAutosave(overlayForm)', context).payload.settings[key], Number(valid));
    }
  }
  context.overlayForm.fields = { names: 'none', show_danmaku: 'on' };
  context.overlayForm.elements = { names: {}, show_danmaku: {}, show_gift: {}, merge_duplicates: {} };
  const partial = vm.runInContext('collectAutosave(overlayForm).payload.settings', context);
  assert.equal(partial.enabled, true); assert.equal(partial.corner, 'top_right');
  assert.equal(partial.show_gift, false); assert.equal(partial.merge_duplicates, false); assert.equal(partial.show_super_chat, true);
});

test('overlay canvas snapping converts all four anchors and keeps offsets in source pixels', () => {
  const context = appContext();
  const place = vm.runInContext('lakeOverlayPlacement', context);
  const canvas = { width: 640, height: 300, canvasWidth: 1920, canvasHeight: 1080, scale: 1, corner: 'top_left', snap: 24 };
  for (const [corner, x, y] of [['top_left', 72, 48], ['top_right', 1208, 48], ['bottom_left', 72, 732], ['bottom_right', 1208, 732]]) {
    const found = place({ ...canvas, x: x + 9, y: y - 8 });
    assert.equal(found.corner, corner); assert.equal(found.offset_x, 0); assert.equal(found.offset_y, 0); assert.equal(found.snapped, true);
  }
  const moved = place({ ...canvas, corner: 'bottom_right', x: 1000, y: 700, snap: 0 });
  assert.equal(moved.offset_x, -208); assert.equal(moved.offset_y, -32);
  const scaled = place({ ...canvas, canvasWidth: 3840, canvasHeight: 2160, width: 1280, height: 600, x: 219, y: 145 });
  assert.equal(scaled.offset_x, 75); assert.equal(scaled.offset_y, 49);
  // Sliding along the left edge sticks to that edge only.
  const edge = place({ ...canvas, x: 80, y: 400, follow: true });
  assert.equal(edge.snapX, 'left'); assert.equal(edge.snapY, ''); assert.equal(edge.snapped, false); assert.equal(edge.offset_x, 0);
  // Below the middle, the block anchors to the bottom so new lines grow upwards.
  const low = place({ ...canvas, x: 600, y: 600, follow: true });
  assert.equal(low.corner, 'bottom_left'); assert.equal(low.offset_x, 528); assert.equal(low.offset_y, -132);
});

test('overlay actions copy the full address and send test items', async () => {
  const context = appContext();
  context.overlay = overlaySnapshot();
  context.calls = [];
  vm.runInContext(`snapshot.overlay = overlay;
    copyText = async text => calls.push({ copied: text });
    showToast = message => calls.push({ toast: message });
    command = async (action, payload) => calls.push({ action, payload });`, context);
  const act = vm.runInContext('handleAction', context);
  await act('overlay.copy');
  assert.equal(context.calls[0].copied, context.overlay.url);
  await act('overlay.test', 'super_chat');
  await act('overlay.test', 'danmaku');
  assert.deepEqual([...context.calls.slice(-2).map(call => call.payload.kind)], ['super_chat', 'danmaku']);
  await act('overlay.preview', 'backdrop=light');
  assert.equal(vm.runInContext('overlayPreview.backdrop', context), 'light');
  await act('overlay.preview', 'aspect=21:9');
  assert.equal(vm.runInContext('JSON.stringify(overlayPreview)', context), '{"backdrop":"light"}');
  assert.equal(vm.runInContext('overlayPreviewSize().height', context), 1728);
  context.overlay.clients = [];
  assert.equal(vm.runInContext('overlayPreviewSize().width', context), 1920);
});

function broadcastSnapshot(extra = {}) {
  return {
    room: { room_id: 123, title: '虚构直播间', parent_area_id: 2, area_id: 86, live_status: 0, live_since: null },
    areas: [{ id: 2, name: '网游', children: [{ id: 86, name: '英雄联盟' }, { id: 87, name: '其他网游' }] }],
    busy: false, has_stream_key: false, face_image: null, ...extra,
  };
}

test('broadcast console formats elapsed time and the server category path verbatim', () => {
  const context = appContext();
  context.view = broadcastSnapshot();
  vm.runInContext('snapshot.broadcast = view;', context);
  assert.equal(vm.runInContext('broadcastAreaPath()', context), '网游 · 英雄联盟');
  const now = Math.floor(Date.now() / 1000);
  context.since = now - (3600 + 23 * 60 + 45);
  assert.equal(vm.runInContext('onAirElapsed(since)', context), '01:23:45');
  context.since = now + 30;
  assert.equal(vm.runInContext('onAirElapsed(since)', context), '00:00:00');
  setLanguage('en');
  assert.equal(vm.runInContext('broadcastAreaPath()', context), '网游 · 英雄联盟');
});

test('broadcast refresh is read-only, opt-in and rate limited', async () => {
  const context = appContext();
  context.calls = [];
  context.view = broadcastSnapshot({ room: null });
  vm.runInContext(`snapshot.broadcast = view; snapshot.account = { user_id: 42 }; snapshot.preferences = { broadcast_console: false }; step = 'main';
    window.__TAURI__ = { core: { invoke: async (kind, args) => { if (kind !== 'dispatch') throw new Error('unexpected IPC'); calls.push(args); return snapshot; } } };
    acceptSnapshot = next => { snapshot = next; };
    updateBroadcastViews = () => {};`, context);
  const refresh = vm.runInContext('refreshBroadcast', context);
  await refresh();
  assert.equal(context.calls.length, 0);
  vm.runInContext('snapshot.preferences.broadcast_console = true; snapshot.network_disabled = true;', context);
  await refresh();
  assert.equal(context.calls.length, 0);
  vm.runInContext('snapshot.network_disabled = false;', context);
  await refresh();
  await refresh();
  assert.deepEqual(context.calls.map(call => call.action), ['bili.broadcast.refresh']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls[0].payload)), {});
  assert.equal(vm.runInContext('pendingCommands', context), 0, 'background room read must not pause snapshot polling');
  vm.runInContext('snapshot.account = { user_id: 43 };', context);
  await refresh();
  assert.equal(context.calls.length, 2);
  vm.runInContext('snapshot.account = { user_id: null };', context);
  await refresh(true);
  assert.equal(context.calls.length, 2);
});

test('going live submits pending title edits first, then opens with the saved category', async () => {
  const context = appContext();
  context.calls = [];
  context.view = broadcastSnapshot();
  const form = { dataset: { dirty: 'true' }, elements: { title: { value: ' 新标题 ' }, area_id: { value: '87' } }, reportValidity: () => true, closest: () => null };
  context.form = form;
  vm.runInContext(`snapshot.broadcast = view; snapshot.account = { user_id: 42 }; step = 'main';
    document.querySelector = selector => selector.includes('[data-dirty]') && form.dataset.dirty ? form : null;
    document.querySelectorAll = () => [];
    command = async (action, payload) => { calls.push({ action, payload }); if (action === 'bili.broadcast.update') snapshot.broadcast.room.area_id = payload.area_id; return snapshot; };
    showToast = message => calls.push({ toast: message });
    openOnAirPanel = mode => calls.push({ panel: mode });
    updateBroadcastViews = () => {};`, context);
  await vm.runInContext('startBroadcast', context)();
  const actions = context.calls.filter(call => call.action);
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), [
    { action: 'bili.broadcast.update', payload: { confirmed: true, title: '新标题', area_id: 87 } },
    { action: 'bili.broadcast.start', payload: { confirmed: true, area_id: 87 } },
  ]);
  assert.equal(form.dataset.dirty, undefined);
  assert.deepEqual(context.calls.filter(call => call.panel).map(call => call.panel), []);
});

test('face verification opens its own panel instead of claiming the room is live', async () => {
  const context = appContext();
  context.calls = [];
  context.view = broadcastSnapshot();
  vm.runInContext(`snapshot.broadcast = view; snapshot.account = { user_id: 42 }; step = 'main';
    document.querySelector = () => null; document.querySelectorAll = () => [];
    command = async action => { calls.push({ action }); snapshot.broadcast.face_image = 'data:image/png;base64,AA=='; return snapshot; };
    showToast = message => calls.push({ toast: message });
    openOnAirPanel = mode => calls.push({ panel: mode });
    updateBroadcastViews = () => {};`, context);
  await vm.runInContext('startBroadcast', context)();
  assert.deepEqual(context.calls.filter(call => call.panel).map(call => call.panel), ['face']);
  assert.deepEqual(context.calls.filter(call => call.toast), [], 'main face sheet already explains verification');
  assert.equal(vm.runInContext('snapshot.broadcast.room.live_status', context), 0);
  context.calls.length = 0;
  vm.runInContext('settingsDialog.open = true', context);
  await vm.runInContext('startBroadcast', context)();
  assert.deepEqual(context.calls.filter(call => call.panel), [], 'with settings open the face sheet stays closed; a toast asks instead');
  assert.deepEqual(context.calls.filter(call => call.toast).map(call => call.toast), ['请先扫码完成人脸验证']);
  assert.equal(vm.runInContext('snapshot.broadcast.room.live_status', context), 0);
});

test('ending the stream is one click, reports the OBS link and never touches chat reception', async () => {
  const context = appContext();
  context.calls = [];
  context.toasts = [];
  context.view = broadcastSnapshot({ room: { ...broadcastSnapshot().room, live_status: 1, live_since: 1 }, has_stream_key: true });
  vm.runInContext(`snapshot.broadcast = view; snapshot.account = { user_id: 42 };
    let obs = null; document.querySelectorAll = () => [];
    confirmAction = async () => { calls.push('confirm'); return false; };
    command = async action => { calls.push({ action }); return obs ? { ...snapshot, result: { obs } } : snapshot; };
    showToast = (message, error = false) => { toasts.push([message, error]); }; closeOnAirPanel = () => {}; updateBroadcastViews = () => {};
    globalThis.setObs = value => { obs = value; };`, context);
  const act = vm.runInContext('handleAction', context);
  await act('broadcast.stop');
  assert.deepEqual(context.calls.map(call => call.action || call), ['bili.broadcast.stop']);
  vm.runInContext(`setObs({ outcome: 'stopped' })`, context);
  await act('broadcast.stop');
  vm.runInContext(`setObs({ error: 'OBS WebSocket 密码不正确 [DV-OB03]' })`, context);
  await act('broadcast.stop');
  assert.deepEqual(context.calls.map(call => call.action || call), ['bili.broadcast.stop', 'bili.broadcast.stop', 'bili.broadcast.stop']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.toasts)), [
    ['已下播', false],
    ['已下播，OBS 已停止推流', false],
    ['已下播，但 OBS 没能停止推流，请在 OBS 里手动停止：OBS WebSocket 密码不正确 [DV-OB03]', true],
  ]);
});

test('OBS connection and overlay actions retain their separate command scopes', async () => {
  const context = appContext();
  context.overlay = overlaySnapshot();
  context.calls = [];
  vm.runInContext(`snapshot.overlay = overlay; snapshot.preferences = { broadcast_console: true };
    snapshot.obs = { settings: { enabled: true, host: '127.0.0.1', port: 4455, auto_launch: true, executable: null }, has_password: true, status: { state: 'ok', streaming: false, obs_version: '31.0.0' }, detected: 'C:/OBS/bin/64bit/obs64.exe', local: true };
    showToast = (message, error = false) => calls.push({ toast: message, error });
    command = async (action, payload) => { calls.push({ action, payload });
      return { result: action === 'obs.overlay.add' ? { created: true, added_to_scene: true, found: true, scene: '游戏场景', width: 2560, height: 1440 } : action === 'obs.launch' ? { launched: true } : { streaming: false } }; };`, context);
  const html = vm.runInContext("settingsTab = 'overlay'; editor = null; lakeObsPage = 'advanced'; renderSettingsPage()", context);
  assert.equal((html.match(/data-obs-root/g) || []).length, 1);
  assert.match(html, /已连接 OBS 31\.0\.0/);
  assert.match(html, /已自动找到 obs64\.exe/);
  assert.match(html, /name="auto_launch" checked/);
  assert.match(html, /data-action="lake\.obs\.launch"/);
  const act = vm.runInContext('handleAction', context);
  await act('lake.obs.launch');
  await act('lake.obs.connect');
  await act('overlay.obs_add');
  assert.deepEqual(context.calls.filter(call => call.action).map(call => call.action), ['obs.launch', 'obs.test', 'obs.overlay.add']);
  assert.deepEqual(context.calls.filter(call => call.toast).map(call => call.toast), ['OBS 已启动并连上', 'OBS 连接正常 · 未在推流', '已添加到 OBS · “游戏场景” · 2560 × 1440']);
  assert.equal(vm.runInContext('obsBusy', context), '');
});

test('a failed voice choice is consumed so a second close can finish', async () => {
  const context = appContext();
  vm.runInContext('voiceAuditionDefaultSave = Promise.reject(new Error("temporary"));', context);
  assert.equal(await vm.runInContext('settleVoiceAuditionChoice()', context), false);
  assert.equal(await vm.runInContext('settleVoiceAuditionChoice()', context), true);
});

test('an older voice metadata reply cannot replace the latest editor data', async () => {
  const context = appContext();
  let release;
  context.oldReply = new Promise(resolve => { release = resolve; });
  vm.runInContext(`snapshot.connections.push({id:'new', settings:{provider:'dots'}});
    command = async (action, payload) => payload.connection_id === 'dots-connection' ? oldReply : {result:[{new:true}]};`, context);
  const old = vm.runInContext("loadVoiceEditorData('dots-connection')", context);
  vm.runInContext("editor = {type:'preset',connectionId:'new'}", context);
  await vm.runInContext("loadVoiceEditorData('new')", context);
  release({result:[{old:true}]}); await old;
  assert.equal(vm.runInContext('referenceProfiles[0].new', context), true);
});


test('inline dots edits made during autosave are saved last with the same voice identity', async () => {
  const context=appContext();
  vm.runInContext("snapshot.presets=[{id:'voice',provider:'dots',connection_id:'dots-connection',voice_id:'role',name:'原名',speed:1,volume:1}];",context);
  let release;let started;
  const gate=new Promise(resolve=>{release=resolve;});const begun=new Promise(resolve=>{started=resolve;});const writes=[];
  const form={dataset:{form:'lake-voice-edit',id:'voice'},fields:{name:'first',speed:'1',volume:'1'},checkValidity:()=>true};
  const collect=vm.runInContext('collectAutosave',context);
  const queue=createAutosaveQueue({delay:0,save:async envelope=>{writes.push(envelope.payload.preset);if(writes.length===1){started();await gate;}}});
  queue.schedule(collect(form),{immediate:true});await begun;
  form.fields.name='typed while saving';queue.schedule(collect(form),{immediate:true});
  release();await queue.flush();
  assert.deepEqual(writes.map(p=>p.name),['first','typed while saving']);
  assert.ok(writes.every(p=>p.id==='voice'&&p.voice_id==='role'&&p.connection_id==='dots-connection'));
});

test('settling an older voice choice never erases a newer pending choice', async () => {
  const context = appContext();
  let reject;
  context.first = new Promise((_, fail) => {reject=fail});
  context.second = Promise.resolve('new choice');
  vm.runInContext('voiceAuditionDefaultSave = first', context);
  const settling = vm.runInContext('settleVoiceAuditionChoice()',context);
  vm.runInContext('voiceAuditionDefaultSave = second',context);
  reject(new Error('old failed')); await settling;
  assert.equal(vm.runInContext('voiceAuditionDefaultSave === second',context),true);
});

test('current reference edits serialize and retain the latest text and existing profile fields', async () => {
  const context=appContext();let release;let started;
  const gate=new Promise(resolve=>{release=resolve;});const begun=new Promise(resolve=>{started=resolve;});
  const writes=[];let saved;
  context.mockCommand=async(action,payload)=>{
    if(action==='references.list')return {result:[{profile:saved}]};
    assert.equal(action,'references.save');writes.push(structuredClone(payload.profile));
    if(writes.length===1){started();await gate;}saved=structuredClone(payload.profile);
  };
  vm.runInContext(`snapshot.connections=[{id:'gpt',settings:{provider:'gpt_sovits'}}];
    snapshot.presets=[{id:'voice',connection_id:'gpt',provider:'gpt_sovits',sovits:{gpt_weights_path:'D:/a.ckpt',sovits_weights_path:'D:/a.pth'}}];
    referenceProfiles=[{profile:{role:referenceRole('gpt_sovits',snapshot.presets[0]),audio_path:'D:/fixture.wav',reference_text:'old',reference_language:'all_zh',text_language:'en'}}];
    command=mockCommand;`,context);
  const preset=vm.runInContext('snapshot.presets[0]',context);const save=vm.runInContext('saveVoiceReference',context);
  const first=save(preset,{reference_text:'first'});await begun;
  const second=save(preset,{reference_text:'new edit'});
  assert.equal(writes.length,1,'the second write waits for the first profile');
  release();await Promise.all([first,second]);
  assert.deepEqual(writes.map(profile=>profile.reference_text),['first','new edit']);
  assert.ok(writes.every(profile=>profile.audio_path==='D:/fixture.wav'&&profile.reference_language==='all_zh'&&profile.text_language==='en'));
  assert.equal(vm.runInContext('referenceProfiles[0].profile.reference_text',context),'new edit');
  assert.equal(vm.runInContext('voiceReferenceSaves.size',context),0);
});

test('queued dots reference edits keep names and tuning saved by the current inline editor', async () => {
  const context = appContext();
  let release;
  let started;
  const blocked = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const writes = [];
  let savedProfile;
  context.mockCommand = async (action, payload) => {
    if (action === 'references.list') return { result: [{ profile: savedProfile }] };
    if (action === 'presets.save') {
      context.editedPreset = structuredClone(payload.preset);
      vm.runInContext('snapshot.presets = [editedPreset]', context);
      return { result: { id: 'voice' } };
    }
    assert.equal(action, 'dots.voice.save');
    writes.push(structuredClone(payload));
    if (writes.length === 1) { started(); await blocked; }
    savedProfile = structuredClone(payload.profile);
    return { result: { id: 'voice' } };
  };
  vm.runInContext(`snapshot.presets = [{ id:'voice', connection_id:'dots-connection', provider:'dots', voice_id:'role', name:'before', speed:1, volume:1 }];
    referenceProfiles = [{ profile:{ role:{kind:'dots',role:'role'}, audio_path:'D:/original.wav', reference_text:'old' } }];
    command = mockCommand;`, context);
  const preset = vm.runInContext('snapshot.presets[0]', context);
  const save = vm.runInContext('saveVoiceReference', context);
  const first = save(preset, { reference_text: 'first' });
  await begun;
  const second = save(preset, { audio_path: 'D:/replacement.wav' });
  const form = { dataset:{form:'lake-voice-edit',id:'voice'}, fields:{name:'new name',speed:'1.4',volume:'.7'}, checkValidity:()=>true };
  const edited = vm.runInContext('collectAutosave', context)(form);
  await context.mockCommand(edited.action, edited.payload);
  release();
  await Promise.all([first, second]);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].preset.name, 'new name');
  assert.equal(writes[1].preset.speed, 1.4);
  assert.equal(writes[1].preset.volume, .7);
  assert.equal(writes[1].profile.audio_path, 'D:/replacement.wav');
  assert.equal(writes[1].profile.reference_text, 'first');
  assert.equal(writes[1].preset.voice_id, 'role');
});

test('a queued reference edit rejects a deleted voice or a changed connection or role', async () => {
  for (const mutation of ["snapshot.presets = []", "snapshot.presets[0].connection_id = 'other'", "snapshot.presets[0].voice_id = 'other-role'"]) {
    const context = appContext();
    let release;
    let started;
    const blocked = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { started = resolve; });
    let writes = 0;
    context.mockCommand = async (action, payload) => {
      if (action === 'references.list') return { result: [{ profile: payload }] };
      assert.equal(action, 'dots.voice.save');
      writes++;
      started();
      await blocked;
      return { result: { id: 'voice' } };
    };
    vm.runInContext(`snapshot.presets = [{ id:'voice', connection_id:'dots-connection', provider:'dots', voice_id:'role' }];
      referenceProfiles = [{profile:{role:{kind:'dots',role:'role'},audio_path:'D:/original.wav'}}]; command=mockCommand;`, context);
    const preset = vm.runInContext('snapshot.presets[0]', context);
    const save = vm.runInContext('saveVoiceReference', context);
    const first = save(preset, { reference_text: 'first' });
    await begun;
    const second = save(preset, { reference_text: 'later' });
    vm.runInContext(mutation, context);
    release();
    await first;
    await assert.rejects(second, /请重新打开声音设置/);
    assert.equal(writes, 1, mutation);
    assert.equal(vm.runInContext('voiceReferenceSaves.size', context), 0);
  }
});

test('adding voices: every service completes on one page with its essential setting up front', async () => {
  const context = appContext();
  context.calls = [];
  context.pairs = [{ name: '流萤', version: 'v4', gpt_path: 'D:/m/流萤.ckpt', sovits_path: 'D:/m/流萤.pth' }, { name: '伊蕾娜', version: 'v4', gpt_path: 'D:/m/伊蕾娜.ckpt', sovits_path: 'D:/m/伊蕾娜.pth' }];
  vm.runInContext(`snapshot.connections = [{ id: 'db', settings: { provider: 'doubao' }, has_credential: true }, { id: 'fish', settings: { provider: 'fish_audio' }, has_credential: true }, { id: 'gpt', settings: { provider: 'gpt_sovits' } }, { id: 'dots', settings: { provider: 'dots' } }];
    snapshot.local_services = { gpt_sovits: { state: 'ready', directory: 'D:/GPT-SoVITS' }, dots: { state: 'ready', directory: 'D:/dots' } };
    snapshot.doubao_voices = [{ id: 'zh_a', name: '温柔' }, { id: 'zh_b', name: '元气' }]; snapshot.presets = []; snapshot.rules.default_preset_id = null;
    modelScan = { pairs, issues: [] }; referenceProfiles = [];
    renderSettings = () => {}; showToast = () => {};
    command = async (action, payload) => { calls.push({ action, payload }); return { result: action === 'presets.save' ? { id: 'new-' + calls.length } : action === 'fish.voice.lookup' ? { voice_id: 'f'.repeat(32), name: '官方名' } : action === 'references.list' ? [] : { id: 'new-' + calls.length } }; };
    window.__TAURI__ = { dialog: { open: async () => 'D:/参考/流萤_今天也要加油哦.wav' } };`, context);
  // Doubao: no search for a short list, and each row adds with one click.
  vm.runInContext(`editor = { type: 'voice-add', provider: 'doubao', connectionId: 'db' }`, context);
  const doubao = vm.runInContext('renderLakeVoiceAdd()', context);
  assert.doesNotMatch(doubao, /data-voice-search/);
  assert.match(doubao, /data-action="voice\.catalog\.add" data-id="zh_a"/);
  await vm.runInContext('handleAction', context)('voice.catalog.add', 'zh_a', {});
  assert.equal(context.calls.at(-1).action, 'presets.save');
  assert.equal(context.calls.at(-1).payload.preset.voice_id, 'zh_a');
  // GPT-SoVITS: picking a model asks for the recording right there; the transcript comes from the file name.
  vm.runInContext(`editor = { type: 'voice-add', provider: 'gpt_sovits', connectionId: 'gpt' }`, context);
  await vm.runInContext('handleAction', context)('voice.catalog.pick', '1', {});
  const picked = vm.runInContext('renderLakeVoiceAdd()', context);
  assert.match(picked, /data-action="voice\.reference\.pick"/);
  assert.match(picked, /data-action="voice\.sovits\.add"[^>]*disabled/);
  await vm.runInContext('handleAction', context)('voice.reference.pick', '', {});
  assert.equal(vm.runInContext('lakeVoiceDraft.reference_text', context), '今天也要加油哦');
  context.calls.length = 0;
  await vm.runInContext('handleAction', context)('voice.sovits.add', '', {});
  assert.deepEqual(context.calls.map(call => call.action), ['presets.save', 'references.save']);
  assert.equal(context.calls[0].payload.preset.sovits.gpt_weights_path, 'D:/m/伊蕾娜.ckpt');
  assert.equal(context.calls[1].payload.profile.audio_path, 'D:/参考/流萤_今天也要加油哦.wav');
  // Fish: a pasted link is looked up, then saved under the name found.
  vm.runInContext(`editor = { type: 'voice-add', provider: 'fish_audio', connectionId: 'fish' }; lakeVoiceDraft = { fish: 'https://fish.audio/m/${'f'.repeat(32)}', fishFound: { voice_id: '${'f'.repeat(32)}', name: '官方名' }, name: '官方名' }`, context);
  context.calls.length = 0;
  await vm.runInContext('handleAction', context)('voice.fish.add', '', {});
  assert.deepEqual(context.calls.map(call => call.action), ['fish.voice.save']);
  assert.equal(context.calls[0].payload.name, '官方名');
  // dots: one recording and a name make a voice.
  vm.runInContext(`editor = { type: 'voice-add', provider: 'dots', connectionId: 'dots' }; lakeVoiceDraft = {}`, context);
  await vm.runInContext('handleAction', context)('voice.reference.pick', '', {});
  context.calls.length = 0;
  await vm.runInContext('handleAction', context)('voice.dots.add', '', {});
  assert.deepEqual(context.calls.map(call => call.action), ['dots.voice.save']);
  assert.equal(context.calls[0].payload.profile.audio_path, 'D:/参考/流萤_今天也要加油哦.wav');
  assert.equal(context.calls[0].payload.preset.name, '流萤_今天也要加油哦');
});

test('viewer card finds a name binding when the viewer also has a UID, as playback does', () => {
  const context = appContext();
  vm.runInContext(`snapshot.bindings = [{ id: 'by-name', binding: { platform: 'bilibili', user_id: null, user_name: 'Kinoko7', preset_id: 'fish', enabled: true } }];`, context);
  assert.equal(vm.runInContext(`viewerBinding({ user_id: 504, user_name: 'Kinoko7' })?.id`, context), 'by-name');
  vm.runInContext(`snapshot.bindings.push({ id: 'by-uid', binding: { platform: 'bilibili', user_id: 504, user_name: null, preset_id: 'dots', enabled: true } });`, context);
  assert.equal(vm.runInContext(`viewerBinding({ user_id: 504, user_name: 'Kinoko7' })?.id`, context), 'by-uid');
});

test('voice-panel audition follows UI language and preserves an explicitly edited sample', async () => {
  const context = appContext();
  context.calls = [];
  vm.runInContext(`snapshot.presets = ['doubao', 'fish_audio', 'dots', 'gpt_sovits'].map(provider => ({ id: provider, provider, connection_id: provider, sovits: { text_language: 'auto' } }));
    renderVoicePanel = () => {};
    command = async (action, payload) => { calls.push({ action, payload }); return { result: [] }; };`, context);
  const action = vm.runInContext('handleAction', context);
  setLanguage('en');
  for (const provider of ['doubao', 'fish_audio', 'dots', 'gpt_sovits']) {
    await action('voice.audition', provider, null);
    assert.equal(context.calls.at(-1).action, 'audition');
    assert.equal(context.calls.at(-1).payload.text, 'Hello, welcome to the stream.');
    assert.equal(context.calls.at(-1).payload.preset_id, provider);
  }
  setLanguage('zh-CN');
  await action('voice.audition', 'dots', null);
  assert.equal(context.calls.at(-1).payload.text, '你好，欢迎来到直播间。');
  setLanguage('en');
  vm.runInContext(`voiceAuditionDraft.customText = true; voiceAuditionDraft.text = '用户自己写的试听句';`, context);
  await action('voice.audition', 'dots', null);
  assert.equal(context.calls.at(-1).payload.text, '用户自己写的试听句');
  vm.runInContext(`voiceAuditionDraft.text = '';`, context);
  await action('voice.audition', 'dots', null);
  assert.equal(context.calls.at(-1).payload.text, 'Hello, welcome to the stream.');
  assert.equal(context.calls.some(call => call.action === 'presets.default'), false);
});

test('GPT-SoVITS preview respects the effective saved text language without changing model configuration', async () => {
  const context = appContext();
  context.calls = [];
  vm.runInContext(`snapshot.presets = [{ id: 'gpt', provider: 'gpt_sovits', connection_id: 'local', sovits: { model_selection: 'per_request_atomic', gpt_weights_path: 'D:/voice.ckpt', sovits_weights_path: 'D:/voice.pth', text_language: 'en' } }];
    renderVoicePanel = () => {};
    referenceOverride = 'all_zh';
    command = async (action, payload) => { calls.push({ action, payload }); return { result: [{ profile: { role: referenceRole('gpt_sovits', snapshot.presets[0]), text_language: referenceOverride } }] }; };`, context);
  setLanguage('en');
  const action = vm.runInContext('handleAction', context);
  await action('voice.audition', 'gpt', null);
  assert.deepEqual(context.calls.map(call => call.action), ['references.list', 'audition']);
  assert.equal(context.calls.at(-1).payload.text, '你好，欢迎来到直播间。');
  vm.runInContext(`referenceOverride = 'auto'; snapshot.presets[0].sovits.text_language = 'all_zh';`, context);
  await action('voice.audition', 'gpt', null);
  assert.equal(context.calls.at(-1).payload.text, 'Hello, welcome to the stream.');
  assert.equal(context.calls.some(call => /save|default/.test(call.action)), false);
});

test('current-message relative time uses the design just-now accent only for recent messages', () => {
  const context = appContext();
  const label = vm.runInContext('lakeMessageTime', context);
  assert.equal(label(1_000, 1_000), 'just now');
  assert.equal(label(1_000, 60_999), 'just now');
  assert.notEqual(label(1_000, 61_000), 'just now');
  assert.notEqual(label(1_001, 1_000), 'just now');
  assert.notEqual(label(0, 1_000), 'just now');
});


test('lake captions preserve spaces and whole Latin words without changing grapheme reveal order', () => {
  const context = appContext();
  const render = vm.runInContext('lakeLettersHtml', context);
  const sentences = [
    ['Good evening by the lake', ['Good', 'evening', 'by', 'the', 'lake']],
    ['主播  Good evening 今晚好 ', ['Good', 'evening']],
    ["Café naïve don't stop", ['Café', 'naïve', "don't", 'stop']],
    ['Supercalifragilisticexpialidocious', ['Supercalifragilisticexpialidocious']],
  ];
  for (const [sentence, words] of sentences) {
    const { html } = render([{ type: 'text', text: sentence }]);
    const letters = [...html.matchAll(/<span class="lake-letter [ab]" style="--letter-delay:(\d+)ms">([^<]*)<\/span>/gu)];
    assert.equal(letters.map(match => match[2]).join(''), escapeHtml(sentence), 'no character or space is dropped');
    assert.deepEqual(letters.map(match => Number(match[1])), letters.map((_, index) => index * 160), 'word grouping preserves the reveal/read position of every grapheme');
    const lines = html.split('<span class="lake-text-line">').slice(1).map(line => line.replace(/<[^>]+>/gu, ''));
    assert.ok(lines.length <= 3);
    for (const word of words) assert.equal(lines.filter(line => line.includes(escapeHtml(word))).length, 1, `word stays on one line: ${word}`);
    assert.equal((html.match(/class="lake-word"/gu) || []).length, words.length);
  }
});

test('lake caption grouping preserves CJK line sizes, combining graphemes and accessible emotes', () => {
  const context = appContext();
  const render = vm.runInContext('lakeLettersHtml', context);
  for (const [count, size, rows] of [[8, 'normal', 1], [16, 'normal', 2], [24, 'medium', 3], [30, 'small', 3]]) {
    const { html, size: actualSize } = render([{ type: 'text', text: '湖'.repeat(count) }]);
    assert.equal(actualSize, size);
    assert.equal((html.match(/class="lake-letter /gu) || []).length, count);
    assert.equal((html.match(/class="lake-text-line"/gu) || []).length, rows);
    assert.doesNotMatch(html, /class="lake-word"/u);
  }
  const { html } = render([{ type: 'text', text: 'e\u0301 ' }, { type: 'emote', text: '[妙]', url: 'https://i0.hdslb.com/bfs/live/a.png', large: true }, { type: 'text', text: ' 湖' }]);
  assert.equal((html.match(/class="lake-letter /gu) || []).length, 5, 'a combining grapheme and an emote each keep one reading position');
  assert.match(html, /alt="" aria-label="\[妙\]"/u);
  assert.deepEqual([...html.matchAll(/--letter-delay:(\d+)ms/gu)].map(match => Number(match[1])), [0, 160, 320, 480, 640]);
});

test('lake reading progress still marks identical grapheme positions in caption and reflection', () => {
  const context = appContext();
  const makeLetters = () => Array.from({ length: 8 }, () => ({ unread: false, classList: { toggle(name, value) { assert.equal(name, 'lake-unread'); this.node.unread = value; } } }));
  const lists = [makeLetters(), makeLetters()];
  for (const letters of lists) for (const node of letters) node.classList.node = node;
  context.document.querySelectorAll = selector => {
    assert.equal(selector, '#lake-current .lake-message-text, #lake-text-reflection');
    return lists.map(letters => ({ querySelectorAll(selector) { assert.equal(selector, '.lake-letter'); return letters; } }));
  };
  vm.runInContext("snapshot.queue = { current: { id: 'job' } }; snapshot.playback = { job_id: 'job', queued_ms: 1000, played_ms: 500 }; syncLakeReadingProgress();", context);
  for (const letters of lists) assert.deepEqual(letters.map(node => node.unread), [false, false, false, false, true, true, true, true]);
  vm.runInContext("snapshot.playback.job_id = 'different-job'; syncLakeReadingProgress();", context);
  for (const letters of lists) assert.equal(letters.some(node => node.unread), false, 'unmatched audio never invents reading progress');
});

test('lake history count changes between English singular and plural on both surface and deep summary', () => {
  const context = appContext();
  const nodes = new Map(['#chat-feed', '#lake-history-total', '#lake-history-label', '#lake-deep-new', '#lake-deep-reading', '#lake-deep-stats'].map(selector => [selector, { innerHTML: '', textContent: '', hidden: false }]));
  context.document.querySelector = selector => nodes.get(selector) || null;
  const render = vm.runInContext('renderLakeHistory', context);
  setLanguage('en');
  for (const count of [0, 1, 2, 1]) {
    context.count = count;
    vm.runInContext('snapshot.live_history = { messages: count, unique_viewers: 1 };', context);
    render([], []);
    const label = count === 1 ? 'message rests in the lake' : 'messages rest in the lake';
    assert.equal(nodes.get('#lake-history-total').textContent, String(count));
    assert.equal(nodes.get('#lake-history-label').innerHTML, label);
    assert.ok(nodes.get('#lake-deep-stats').innerHTML.includes(`<span>${label}</span>`));
  }
  setLanguage('zh-CN');
  render([], []);
  assert.equal(nodes.get('#lake-history-label').innerHTML, '句沉在湖里');
  assert.ok(nodes.get('#lake-deep-stats').innerHTML.includes('<span>句弹幕沉在湖里</span>'));
});

test('lake durations use English singular and plural hours and minutes', () => {
  const duration = vm.runInContext('lakeDuration', appContext());
  setLanguage('en');
  assert.equal(duration(3600 + 60), '1 hour 1 minute');
  assert.equal(duration(3600 + 24 * 60), '1 hour 24 minutes');
  assert.equal(duration(2 * 3600 + 14 * 60 + 59), '2 hours 14 minutes');
  assert.equal(duration(5 * 60), '0 hours 5 minutes');
  assert.equal(duration(null), '');
  setLanguage('zh-CN');
  assert.equal(duration(3600 + 24 * 60), '1 小时 24 分');
});


test('lake visual-width table keeps short English and mixed captions on two balanced lines', () => {
  const render = vm.runInContext('lakeLettersHtml', appContext());
  const cases = [
    ['Good evening by the lake', ['Good evening ', 'by the lake']],
    ['主播 晚上好 Hello lake', ['主播 晚上好 ', 'Hello lake']],
    ['6666666666 哈哈哈哈哈', ['6666666666 ', '哈哈哈哈哈']],
    ['2333333333333333 笑死', ['2333333333333333 ', '笑死']],
  ];
  for (const [text, expectedLines] of cases) {
    const { html, size } = render([{ type: 'text', text }]);
    const lines = html.split('<span class="lake-text-line">').slice(1).map(line => line.replace(/<[^>]+>/gu, ''));
    assert.deepEqual(lines, expectedLines, text);
    assert.equal(size, 'normal', text);
    assert.equal(lines.join(''), text, 'line balancing preserves the original spaces');
  }
});

test('lake word grouping preserves numbers and other scripts without swallowing CJK boundaries', () => {
  const render = vm.runInContext('lakeLettersHtml', appContext());
  const cases = [
    ['AWSL2333 Привет Γειά مرحبا नमस्ते', ['AWSL2333', 'Привет', 'Γειά', 'مرحبا', 'नमस्ते']],
    ['abc漢字123 カタカナABC123 かなDEF456 한국어AWSL2333', ['abc', '123', 'ABC123', 'DEF456', 'AWSL2333']],
    ['ПриветAWSL2333 ١٢٣٤٥٦٧٨٩٠', ['ПриветAWSL2333', '١٢٣٤٥٦٧٨٩٠']],
    ['ＡＢＣ１２３ 湖', ['ＡＢＣ１２３']],
  ];
  for (const [text, expectedWords] of cases) {
    const { html } = render([{ type: 'text', text }]);
    const wordMarkup = /<span class="lake-word">((?:<span class="lake-letter [ab]" style="--letter-delay:\d+ms">[^<]*<\/span>)+)<\/span>/gu;
    const words = [...html.matchAll(wordMarkup)].map(match => match[1].replace(/<[^>]+>/gu, '').trimEnd());
    assert.deepEqual(words, expectedWords, text);
    const letters = [...html.matchAll(/<span class="lake-letter [ab]" style="--letter-delay:(\d+)ms">([^<]*)<\/span>/gu)];
    assert.deepEqual(letters.map(match => match[2]), [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].map(({ segment }) => escapeHtml(segment)));
    assert.deepEqual(letters.map(match => Number(match[1])), letters.map((_, index) => index * 160), 'visual widths never change reading/reveal indices');
  }
});

test('lake width thresholds distinguish half-width text, full-width punctuation and emote images', () => {
  const render = vm.runInContext('lakeLettersHtml', appContext());
  const cases = [
    ['A'.repeat(10) + '湖湖', 'normal', 1],
    ['A'.repeat(10) + '湖湖湖', 'normal', 2],
    ['a '.repeat(10) + '湖'.repeat(5), 'normal', 2], // 16 visual units exactly.
    ['a '.repeat(10) + '湖'.repeat(5) + ' ', 'medium', 3],
    ['a '.repeat(20) + '湖'.repeat(4), 'medium', 3], // 26 visual units exactly.
    ['a '.repeat(20) + '湖'.repeat(4) + ' ', 'small', 3],
    ['！'.repeat(9), 'normal', 2],
    ['，'.repeat(17), 'medium', 3],
    ['\u3000'.repeat(17), 'medium', 3],
    ['\uffe5'.repeat(17), 'medium', 3],
    ['Ａ'.repeat(17), 'medium', 1], // A full-width word remains indivisible.
  ];
  for (const [text, expectedSize, expectedRows] of cases) {
    const { html, size } = render([{ type: 'text', text }]);
    assert.equal(size, expectedSize, JSON.stringify(text));
    assert.equal((html.match(/class="lake-text-line"/gu) || []).length, expectedRows, JSON.stringify(text));
  }
  for (const [count, expectedSize, expectedRows] of [[7, 'normal', 1], [8, 'normal', 2], [15, 'normal', 2], [16, 'medium', 3]]) {
    const { html, size } = render([{ type: 'text', text: '湖'.repeat(count) }, { type: 'emote', text: '[妙]', url: 'https://i0.hdslb.com/bfs/live/a.png' }]);
    assert.equal(size, expectedSize);
    assert.equal((html.match(/class="lake-text-line"/gu) || []).length, expectedRows);
    assert.equal((html.match(/class="lake-letter /gu) || []).length, count + 1, 'an image retains one full-width unit and one reading position');
    assert.match(html, new RegExp(`--letter-delay:${count * 160}ms"><img`));
  }
});

test('lake pure-CJK captions retain the previous exact line markup and size at every boundary', () => {
  const render = vm.runInContext('lakeLettersHtml', appContext());
  const cases = [
    [1, 'normal', [1]], [8, 'normal', [8]], [9, 'normal', [5, 4]], [16, 'normal', [8, 8]],
    [17, 'medium', [6, 6, 5]], [19, 'medium', [7, 7, 5]], [24, 'medium', [8, 8, 8]], [26, 'medium', [9, 9, 8]],
    [27, 'small', [9, 9, 9]], [80, 'small', [27, 27, 26]],
  ];
  for (const [count, expectedSize, previousRows] of cases) {
    let index = 0;
    const previousHtml = previousRows.map(length => `<span class="lake-text-line">${Array.from({ length }, () => `<span class="lake-letter b" style="--letter-delay:${index++ * 160}ms">湖</span>`).join('')}</span>`).join('');
    const { html, size } = render([{ type: 'text', text: '湖'.repeat(count) }]);
    assert.equal(size, expectedSize, `${count} CJK graphemes`);
    assert.equal(html, previousHtml, `${count} CJK graphemes preserve exact markup, line lengths and delays`);
  }
});


test('lake common Chinese punctuation preserves the previous exact CJK line markup and size', () => {
  const render = vm.runInContext('lakeLettersHtml', appContext());
  const cases = [
    ['湖边晚安……大家好', 'normal', ['湖边晚安…', '…大家好']],
    ['“湖”“风”“月”', 'normal', ['“湖”“风', '”“月”']],
    ['‘湖’‘风’‘月’', 'normal', ['‘湖’‘风', '’‘月’']],
    ['等等——等等——我', 'normal', ['等等——等', '等——我']],
    ['湖'.repeat(13) + '“”……', 'medium', ['湖'.repeat(6), '湖'.repeat(6), '湖“”……']],
  ];
  for (const [text, expectedSize, previousLines] of cases) {
    let index = 0;
    const previousHtml = previousLines.map(line => `<span class="lake-text-line">${[...line].map(letter => `<span class="lake-letter b" style="--letter-delay:${index++ * 160}ms">${letter}</span>`).join('')}</span>`).join('');
    const { html, size } = render([{ type: 'text', text }]);
    assert.equal(size, expectedSize, text);
    assert.equal(html, previousHtml, text);
  }
});

test('lake enumerated Chinese punctuation is full width while ASCII punctuation stays half width', () => {
  const render = vm.runInContext('lakeLettersHtml', appContext());
  for (const language of ['zh-CN', 'en']) {
    setLanguage(language);
    for (const character of '“”‘’…—') {
      for (const [count, expectedSize, expectedRows] of [[8, 'normal', 1], [9, 'normal', 2], [16, 'normal', 2], [17, 'medium', 3], [26, 'medium', 3], [27, 'small', 3]]) {
        const { html, size } = render([{ type: 'text', text: character.repeat(count) }]);
        assert.equal(size, expectedSize, `${language}/${character}/${count}`);
        assert.equal((html.match(/class="lake-text-line"/gu) || []).length, expectedRows, `${language}/${character}/${count}`);
      }
    }
    for (const character of ['"', "'", '.', '-']) {
      for (const [count, expectedSize, expectedRows] of [[9, 'normal', 1], [17, 'normal', 2], [27, 'normal', 2], [30, 'medium', 3]]) {
        const { html, size } = render([{ type: 'text', text: character.repeat(count) }]);
        assert.equal(size, expectedSize, `${language}/ASCII ${character}/${count}`);
        assert.equal((html.match(/class="lake-text-line"/gu) || []).length, expectedRows, `${language}/ASCII ${character}/${count}`);
      }
    }
    const { html } = render([{ type: 'text', text: 'don’t' }]);
    assert.equal((html.match(/class="lake-word"/gu) || []).length, 1, 'the enumerated curly apostrophe still belongs to the same intact word');
    assert.equal(html.replace(/<[^>]+>/gu, ''), 'don’t');
    assert.deepEqual([...html.matchAll(/--letter-delay:(\d+)ms/gu)].map(match => Number(match[1])), [0, 160, 320, 480, 640]);
  }
  setLanguage('zh-CN');
});
