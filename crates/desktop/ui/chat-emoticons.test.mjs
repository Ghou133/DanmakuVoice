import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t, ui, getLanguage, setLanguage } from './i18n.mjs';
import { localizeDiagnostic } from './i18n-diagnostics.mjs';
import { escapeHtml as esc, safeMediaUrl, validUid } from './helpers.mjs';

function emoticonContext() {
  setLanguage('zh-CN');
  const picker = { hidden: true, innerHTML: '' };
  const surface = { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const context = vm.createContext({
    document: { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener() {}, querySelector: selector => selector === '#chat-emoticon-picker' ? picker : surface, querySelectorAll: () => [] },
    window: { addEventListener() {} }, matchMedia: () => ({ addEventListener() {} }),
    t, ui, getLanguage, setLanguage, esc, safeMediaUrl, validUid, localizeDiagnostic,
    mountSelects() {}, closeSelect() {}, stripSelects() {},
    createAutosaveQueue: () => ({ schedule() {}, flush: async () => {} }), setTimeout, clearTimeout,
  });
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bvoid boot\(\);\s*$/, '');
  vm.runInContext(source, context, { filename: 'app.js' });
  vm.runInContext(`step = 'main'; snapshot = { account: { user_id: 42 }, setup: { room_id: 999 }, preferences: { broadcast_console: false }, chat_send: {} }; syncChatEmoticonContext();`, context);
  return { context, picker };
}

const pack = (index, size) => ({ name: `平台顺序 ${index}`, source: 'live', pkg_type: 1, icon: null, emoticons: Array.from({ length: size }, (_, item) => ({ emoticon_unique: `${index}:${item}`, emoji: `表情 ${index}:${item}`, allowed: item % 3 !== 0, kind: 'emoticon', url: '', description: '平台锁定条件' })) });

test('each returned package becomes one image-only accessible tab in platform order, including zero and one package', () => {
  for (const count of [0, 1, 2, 5]) {
    const { context, picker } = emoticonContext();
    context.view = { room_id: 7777, emoticons: Array.from({ length: count }, (_, index) => pack(count - index, 1)) };
    vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
    assert.equal((picker.innerHTML.match(/role="tab"/g) || []).length, count);
    const names = [...picker.innerHTML.matchAll(/role="tab"[^>]*aria-label="([^<"]*)"/g)].map(match => match[1]);
    assert.deepEqual(names, context.view.emoticons.map(value => value.name));
    assert.doesNotMatch(picker.innerHTML, /lake-emote-pack-name|EMOTES|个表情包|\btitle=/);
  }
});

test('the full returned package renders continuously without pages, truncation or invented emojis', () => {
  for (const size of [0, 1, 18, 19, 55]) {
    const { context, picker } = emoticonContext();
    context.view = { room_id: 7777, emoticons: [pack(1, size)] };
    vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
    assert.equal((picker.innerHTML.match(/class="lake-emote-sticker"/g) || []).length, size);
    assert.doesNotMatch(picker.innerHTML, /chat\.emoticon\.page|<select|<option|data-page-index|data-page-count/);
    if (size) assert.match(picker.innerHTML, new RegExp(`aria-label="表情 1:${size - 1}"`));
  }
});

test('metadata requires its authenticated owner and can display the verified own room independently of reception', () => {
  const { context, picker } = emoticonContext();
  context.packs = [{ name: '<script>包名</script>', emoticons: [{ emoticon_unique: 'locked', emoji: '平台表情', allowed: false, kind: 'emoticon', url: 'javascript:attack()', description: '<b>不能用</b>' }] }];
  vm.runInContext(`chatMetadataLoadedContext = chatEmoteContext; snapshot.chat_send = { room_id: 7777, message_limit: 40, emoticons: packs };`, context);
  assert.equal(vm.runInContext('chatEmoticonView().emoticons.length', context), 0, 'an ownerless old fixture is not trusted');
  vm.runInContext('snapshot.chat_send.account_id = 99', context);
  assert.equal(vm.runInContext('chatEmoticonView().emoticons.length', context), 0, 'another account cannot supply cached permissions');
  vm.runInContext(`snapshot.chat_send.account_id = 42; renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), chatEmoticonView(), false)`, context);
  assert.match(picker.innerHTML, /data-room-id="7777"/);
  assert.match(picker.innerHTML, /&lt;script&gt;包名&lt;\/script&gt;/);
  assert.match(picker.innerHTML, /&lt;b&gt;不能用&lt;\/b&gt;/);
  assert.match(picker.innerHTML, /data-id="locked"[^>]* disabled/);
  assert.doesNotMatch(picker.innerHTML, /<script>|<img|javascript:/);
});

test('account or reception changes clear selection and content, and returning to an old account cannot accept its old request', () => {
  const { context, picker } = emoticonContext();
  vm.runInContext(`patchMarkup(document.querySelector('#chat-emoticon-picker'), '<button>previous account package</button>'); chatEmoticonsOpen = true; chatEmotePackIndex = 4; chatMetadataLoadedContext = chatEmoteContext; globalThis.previousGuard = chatResponseGuard(); snapshot.account.user_id = 99; syncChatEmoticonContext();`, context);
  assert.equal(picker.innerHTML, '');
  assert.equal(picker.hidden, true);
  assert.equal(vm.runInContext('chatEmotePackIndex', context), 0);
  assert.equal(vm.runInContext('chatMetadataLoadedContext', context), '');
  assert.equal(vm.runInContext('chatEmotePackKey', context), '');
  assert.equal(vm.runInContext('chatEmotePackTokens.length', context), 0);
  vm.runInContext(`snapshot.account.user_id = 42; syncChatEmoticonContext();`, context);
  assert.equal(vm.runInContext('previousGuard(snapshot)', context), false);
  vm.runInContext(`globalThis.roomGuard = chatResponseGuard(); snapshot.setup.room_id = 1001; syncChatEmoticonContext();`, context);
  assert.equal(vm.runInContext('roomGuard(snapshot)', context), false);
});

test('image-only tabs retain accessible package names and safe covers, with graphic fallback for missing images', () => {
  const { context, picker } = emoticonContext();
  const rejected = ['javascript:attack()', 'data:image/png;base64,abc', 'https://evil.example/cover.png', 'https://i0.hdslb.com.evil.example/bfs/cover.png', 'https://user@i0.hdslb.com/bfs/cover.png', 'https://i0.hdslb.com:444/bfs/cover.png', 'https://i0.hdslb.com/bfs/cover.svg'];
  context.view = { emoticons: [
    { ...pack(0, 0), name: '<b>平台 & 原名</b>', icon: '//i0.hdslb.com/bfs/emote/actual-cover.png' },
    { ...pack(1, 2), icon: null, emoticons: [
      { ...pack(1, 1).emoticons[0], url: 'javascript:attack()' },
      { ...pack(1, 2).emoticons[1], url: '//i0.hdslb.com/bfs/emote/first-safe-item.png' },
    ] },
    ...rejected.map((icon, index) => ({ ...pack(index + 2, 0), icon })),
  ] };
  vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  assert.equal((picker.innerHTML.match(/class="lake-emote-pack-icon"/g) || []).length, 2);
  assert.match(picker.innerHTML, /src="https:\/\/i0\.hdslb\.com\/bfs\/emote\/actual-cover\.png" alt="" loading="lazy" referrerpolicy="no-referrer"/);
  assert.match(picker.innerHTML, /src="https:\/\/i0\.hdslb\.com\/bfs\/emote\/first-safe-item\.png"/);
  assert.match(picker.innerHTML, /aria-label="&lt;b&gt;平台 &amp; 原名&lt;\/b&gt;"/);
  assert.doesNotMatch(picker.innerHTML, /lake-emote-pack-name|\btitle=/);
  assert.doesNotMatch(picker.innerHTML, /javascript:|data:image|evil\.example|<b>平台/);
});

test('metadata refresh keeps the selected package across reordering, cover updates and item additions, then clamps removed packages', () => {
  const { context, picker } = emoticonContext();
  const selected = pack(2, 55);
  context.view = { emoticons: [pack(1, 1), selected, pack(3, 2)] };
  vm.runInContext(`chatEmotePackIndex = 1; renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  context.view = { emoticons: [pack(3, 2), pack(1, 1), { ...pack(2, 56), icon: 'https://i0.hdslb.com/bfs/emote/new-cover.png' }] };
  vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  assert.match(picker.innerHTML, /id="chat-emote-tab-2"[^>]*aria-selected="true"/);
  assert.match(picker.innerHTML, /data-pack-index="2"/);
  assert.equal((picker.innerHTML.match(/class="lake-emote-sticker"/g) || []).length, 56);
  context.view.emoticons[2] = pack(2, 1);
  vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  assert.match(picker.innerHTML, /data-pack-index="2"/);
  assert.equal((picker.innerHTML.match(/class="lake-emote-sticker"/g) || []).length, 1);
  context.view = { emoticons: [pack(3, 2)] };
  vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  assert.match(picker.innerHTML, /data-pack-index="0"/);
});

test('same-name packages are distinguished by their actual emoji identities rather than their array position', () => {
  const { context, picker } = emoticonContext();
  const left = { ...pack(1, 2), name: '同名真实包' };
  const right = { ...pack(2, 2), name: '同名真实包' };
  context.view = { emoticons: [left, right] };
  vm.runInContext(`chatEmotePackIndex = 1; renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  context.view = { emoticons: [right, left] };
  vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  assert.match(picker.innerHTML, /id="chat-emote-tab-0"[^>]*aria-selected="true"/);
  assert.match(picker.innerHTML, /aria-label="表情 2:1"/);
  assert.doesNotMatch(picker.innerHTML, /aria-label="表情 1:1"/);
});

test('personal image emoticons directly send the returned ID while original bracket text stays in backend metadata only', () => {
  const { context, picker } = emoticonContext();
  context.view = { emoticons: [{ name: '我的实际包', source: 'account', pkg_type: 2, icon: null, emoticons: [
    { kind: 'text', allowed: true, emoticon_unique: 'account:401:9', emoji: '花花', text: '[我的实际包_花花]', url: '//i0.hdslb.com/bfs/emote/flowers.png' },
    { kind: 'text', allowed: true, emoticon_unique: 'account:401:10', emoji: '危险 & 标签', text: '[我的实际包_危险 & 标签]', url: 'javascript:attack()' },
  ] }] };
  vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  assert.match(picker.innerHTML, /class="lake-emote-stickers"/);
  assert.match(picker.innerHTML, /class="lake-emote-sticker" data-action="chat.emoticon.send" data-id="account:401:9"/);
  assert.match(picker.innerHTML, /src="https:\/\/i0\.hdslb\.com\/bfs\/emote\/flowers\.png"/);
  assert.match(picker.innerHTML, /class="lake-emote-sticker" data-action="chat.emoticon.send" data-id="account:401:10"/);
  assert.equal(context.view.emoticons[0].emoticons[0].text, '[我的实际包_花花]');
  assert.doesNotMatch(picker.innerHTML, /chat\.emoticon\.insert|data-emoticon-text|javascript:|<small>|\btitle=/);
});

test('chat account context and pending replies survive broadcast-console toggles but reject logout and offline state', () => {
  const { context, picker } = emoticonContext();
  vm.runInContext(`chatMetadataLoadedContext = chatEmoteContext; chatSendBusy = true; chatEmoticonsOpen = true; globalThis.previousContext = chatEmoteContext; globalThis.guard = chatResponseGuard(); snapshot.preferences.broadcast_console = true; syncChatEmoticonContext();`, context);
  assert.equal(vm.runInContext('chatEmoteContext', context), context.previousContext);
  assert.equal(vm.runInContext('chatMetadataLoadedContext', context), context.previousContext);
  assert.equal(vm.runInContext('chatSendBusy && chatEmoticonsOpen && guard(snapshot)', context), true);
  vm.runInContext(`snapshot.preferences.broadcast_console = false; syncChatEmoticonContext();`, context);
  assert.equal(vm.runInContext('guard(snapshot)', context), true);
  assert.equal(vm.runInContext('chatSendBusy && chatEmoticonsOpen', context), true);
  vm.runInContext(`snapshot.network_disabled = true;`, context);
  assert.equal(vm.runInContext('guard(snapshot)', context), false);
  vm.runInContext(`snapshot.network_disabled = false; snapshot.account = {}; syncChatEmoticonContext();`, context);
  assert.equal(vm.runInContext('guard(snapshot)', context), false);
  assert.equal(picker.hidden, true);
});

test('same-name and same-token packages keep selection attached to the returned account or live source', () => {
  const { context, picker } = emoticonContext();
  const shared = { ...pack(1, 1), name: '同名包' };
  context.view = { emoticons: [{ ...shared, source: 'account' }, { ...shared, source: 'live' }] };
  vm.runInContext(`chatEmotePackIndex = 1; renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  context.view.emoticons.reverse();
  vm.runInContext(`renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), view, false)`, context);
  assert.match(picker.innerHTML, /id="chat-emote-tab-0"[^>]*aria-selected="true"/);
  assert.equal(vm.runInContext('chatEmotePackKey', context), '["live",1,"同名包"]');
});

test('partial metadata warnings retain escaped accessible status beside usable image packages and remain scoped to the loaded account', () => {
  const { context, picker } = emoticonContext();
  context.warning = '个人表情读取失败 <script>错误</script> [DV-B04]';
  context.packs = [pack(1, 1)];
  vm.runInContext(`chatMetadataLoadedContext = chatEmoteContext; snapshot.chat_send = { account_id: 42, room_id: 7777, emoticons: packs, warnings: [warning, warning, null, ''] }; renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), chatEmoticonView(), false)`, context);
  assert.match(picker.innerHTML, /class="lake-emote-warning" role="status"/);
  assert.match(picker.innerHTML, /class="sr-only">个人表情读取失败 &lt;script&gt;错误&lt;\/script&gt; \[DV-B04\]/);
  assert.equal((picker.innerHTML.match(/个人表情读取失败/g) || []).length, 1);
  assert.match(picker.innerHTML, /role="tab"/);
  assert.doesNotMatch(picker.innerHTML, /<script>/);
  vm.runInContext(`snapshot.account.user_id = 99; syncChatEmoticonContext(); renderChatEmoticons(document.querySelector('#chat-emoticon-picker'), chatEmoticonView(), false)`, context);
  assert.doesNotMatch(picker.innerHTML, /个人表情读取失败|role="tab"/);
  assert.equal(vm.runInContext('chatEmoticonView().warnings.length', context), 0);
});
