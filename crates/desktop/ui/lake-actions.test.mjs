import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t, ui, getLanguage, setLanguage } from './i18n.mjs';
import { escapeHtml as esc, validUid } from './helpers.mjs';

// The production functions run unchanged; only the desktop/DOM boundary is
// fictional. These tests neither contact Bilibili nor play audio.
function actionContext() {
  setLanguage('zh-CN');
  const surface = { listeners: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const toast = { classList: { add() {}, toggle() {} }, hidden: true, textContent: '', innerHTML: '' };
  const timers = new Map();
  let sequence = 0;
  const context = vm.createContext({
    document: { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener() {}, querySelector: selector => selector === '#toast' ? toast : surface, querySelectorAll: () => [] },
    window: { addEventListener() {} }, matchMedia: () => ({ addEventListener() {} }),
    t, ui, getLanguage, setLanguage, esc, validUid,
    mountSelects() {}, closeSelect() {}, stripSelects() {},
    createAutosaveQueue: () => ({ schedule() {}, flush: async () => {} }),
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bvoid boot\(\);\s*$/, '');
  vm.runInContext(source, context, { filename: 'app.js' });
  vm.runInContext(`step = 'main'; snapshot = { preferences: {}, account: {}, presets: [], rules: { default_preset_id: 'saved' }, connections: [] };`, context);
  return { context, toast, timers };
}

test('toast undo escapes external names, consumes once, and expires after the source duration', async () => {
  const { context, toast, timers } = actionContext();
  context.undoCount = 0;
  vm.runInContext(`showToast('<img src=x onerror=attack()>', false, async () => { undoCount++; });`, context);
  assert.match(toast.innerHTML, /&lt;img src=x onerror=attack\(\)&gt;/);
  assert.doesNotMatch(toast.innerHTML, /<img/);
  assert.equal([...timers.values()].at(-1).delay, 3600);
  await vm.runInContext(`handleAction('toast.undo', '', null)`, context);
  await vm.runInContext(`handleAction('toast.undo', '', null)`, context);
  assert.equal(context.undoCount, 1);
  assert.equal(toast.hidden, true);
  assert.equal(timers.size, 0);
  vm.runInContext(`showToast('second', false, async () => { undoCount++; });`, context);
  [...timers.values()].at(-1).fn();
  await vm.runInContext(`handleAction('toast.undo', '', null)`, context);
  assert.equal(context.undoCount, 1);
  assert.equal(toast.hidden, true);
});

test('a later toast replaces its previous undo callback and preserves error visibility time', async () => {
  const { context, toast, timers } = actionContext();
  context.undos = [];
  vm.runInContext(`showToast('old', false, async () => undos.push('old')); showToast('new', false, async () => undos.push('new'));`, context);
  assert.equal(timers.size, 1);
  await vm.runInContext(`handleAction('toast.undo', '', null)`, context);
  assert.deepEqual(context.undos, ['new']);
  vm.runInContext(`showToast('operation failed', true);`, context);
  assert.equal([...timers.values()].at(-1).delay, 8000);
  assert.equal(toast.textContent, 'operation failed');
});

test('selecting a different voice saves only its preset and leaves the current utterance and local services alone', async () => {
  const { context } = actionContext();
  const calls = [], messages = [];
  context.save = async (action, payload) => { calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) }); return {}; };
  context.say = message => messages.push(message);
  vm.runInContext(`snapshot.presets = [{ id: 'saved', provider: 'dots', name: '原音色' }, { id: 'next', provider: 'gpt_sovits', name: '新音色' }]; snapshot.queue = { current: { id: 19, preset_id: 'saved', text: '正在读的原句' } }; snapshot.local_services = { dots: { state: 'running' } }; command = save; showToast = say; renderVoicePanel = () => {};`, context);
  await vm.runInContext(`handleAction('voice.pick', 'missing', null)`, context);
  await vm.runInContext(`handleAction('voice.pick', 'saved', null)`, context);
  assert.equal(calls.length, 0);
  await vm.runInContext(`handleAction('voice.pick', 'next', null)`, context);
  assert.deepEqual(calls, [{ action: 'presets.default', payload: { id: 'next' } }]);
  assert.deepEqual(messages, ['之后的弹幕用「新音色」朗读']);
  assert.equal(vm.runInContext('snapshot.queue.current.preset_id', context), 'saved');
  assert.equal(vm.runInContext('snapshot.local_services.dots.state', context), 'running');
});

test('failed voice saves and unconnected Doubao choices never announce a selected voice', async () => {
  const { context } = actionContext();
  const guided = [], messages = [];
  context.failedSave = async () => { throw new Error('真实保存失败'); };
  context.guide = async id => guided.push(id);
  context.say = message => messages.push(message);
  vm.runInContext(`snapshot.presets = [{ id: 'saved', provider: 'dots' }, { id: 'next', provider: 'gpt_sovits' }, { id: 'cloud', provider: 'doubao', connection_id: 'cloud-link' }]; snapshot.connections = [{ id: 'cloud-link', settings: { provider: 'doubao' }, has_credential: false }]; command = failedSave; showToast = say; renderVoicePanel = () => {}; closeVoicePanel = () => {}; guideDoubaoLogin = guide;`, context);
  await assert.rejects(vm.runInContext(`handleAction('voice.pick', 'next', null)`, context), /真实保存失败/);
  await vm.runInContext(`handleAction('voice.pick', 'cloud', null)`, context);
  assert.deepEqual(guided, ['cloud']);
  assert.deepEqual(messages, []);
  assert.equal(vm.runInContext('snapshot.rules.default_preset_id', context), 'saved');
});

test('mute undo refreshes permission before one explicit write and skips unknown or absent mute state', async () => {
  for (const moderation of [{ can_moderate: true, muted: true }, { can_moderate: false, muted: true }, { can_moderate: true, muted: null }, { can_moderate: true, muted: false }]) {
    const { context } = actionContext();
    const calls = [], messages = [];
    context.mod = moderation;
    context.call = async (action, payload, options) => {
      calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
      const reply = { preferences: { broadcast_console: true }, account: { user_id: 42 }, moderation: { ...moderation, user_id: 77, room_id: 123 } };
      return options.accept(reply) ? reply : null;
    };
    context.say = message => messages.push(message);
    vm.runInContext(`snapshot.preferences.broadcast_console = true; snapshot.account.user_id = 42; snapshot.broadcast = { room: { room_id: 123 } }; viewerContext = null; updateViewerModeration = () => {}; command = call; showToast = say;`, context);
    await vm.runInContext(`undoLakeMute({ account: '42', user_id: '77', room_id: 123 })`, context);
    const applies = moderation.can_moderate && moderation.muted === true;
    assert.deepEqual(calls.map(call => call.action), applies ? ['bili.moderation.refresh', 'bili.moderation.unmute'] : ['bili.moderation.refresh']);
    if (applies) assert.deepEqual(calls[1].payload, { user_id: '77', room_id: 123, confirmed: true });
    assert.deepEqual(messages, applies ? ['已解除禁言'] : []);
    assert.equal(vm.runInContext('viewerModerationBusy', context), false);
  }
});

test('moderation success exposes undo only for an applied mute in the same viewer context', async () => {
  for (const outcome of ['applied', 'failed', 'viewer-closed']) {
    const { context } = actionContext();
    const messages = [], calls = [];
    context.save = async (action, payload) => {
      calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
      if (outcome === 'failed') throw new Error('平台未接受禁言');
      if (outcome === 'viewer-closed') vm.runInContext('viewerContext = null', context);
      return {};
    };
    context.say = (message, isError, undo) => messages.push({ message, isError, undo });
    vm.runInContext(`snapshot.preferences.broadcast_console = true; snapshot.account.user_id = 42; snapshot.live = { room_id: 123 }; snapshot.moderation = { user_id: 77, room_id: 123, muted: false, can_moderate: true }; viewerContext = { user_id: 77, user_name: '真实显示名' }; viewerModerationAccount = '42'; updateViewerModeration = () => {}; command = save; showToast = say;`, context);
    const work = vm.runInContext(`moderateViewer('mute')`, context);
    if (outcome === 'failed') await assert.rejects(work, /平台未接受禁言/);
    else await work;
    assert.deepEqual(calls, [{ action: 'bili.moderation.mute', payload: { user_id: '77', room_id: 123, confirmed: true, hours: 1 } }]);
    assert.equal(messages.length, outcome === 'applied' ? 1 : 0);
    if (outcome === 'applied') {
      assert.equal(messages[0].message, '已禁言 真实显示名 · 1 小时');
      assert.equal(messages[0].isError, false);
      assert.equal(typeof messages[0].undo, 'function');
    }
    assert.equal(vm.runInContext('viewerModerationBusy', context), false);
  }
});
