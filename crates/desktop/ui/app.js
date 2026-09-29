import { escapeHtml as esc, mergeSnapshot, headerIdentity, initial, identityColor, eventText, eventKeys, validUid, numericId, runtimeIssue, liveConnectionView, snapshotPollingPolicy, uiIsActive, safeQrUrl, safeMediaUrl, messageParts, playbackCaption, playbackFallbackNotice, startingStep, providerLabel, deviceValue, normalizedEvents, qrLabel, qrNeedsRoomFallback } from './helpers.mjs';
import { createAutosaveQueue } from './autosave.mjs';
import { mountSelects, closeSelect, stripSelects } from './select.mjs';

const app = document.querySelector('#app');
const settingsDialog = document.querySelector('#settings');
const confirmationDialog = document.querySelector('#confirmation');
const icons = {
  external: '<path d="M14 3h7v7M21 3l-10 10M10 3H4v17h17v-6"/>',
  settings: '<path d="m9 3-.6 2-2 .9-1.9-.5-2 3.4 1.4 1.5v2.4L2.5 14l2 3.4 1.9-.5 2 .9.6 2h4l.6-2 2-.9 1.9.5 2-3.4-1.4-1.3v-2.4l1.4-1.5-2-3.4-1.9.5-2-.9L13 3Z"/><circle cx="11" cy="11.5" r="3"/>',
  qr: '<path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/><path d="M7 7h3v3H7zM14 7h3v3h-3zM7 14h3v3H7zM14 14h3v3h-3z"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>', back: '<path d="m14 5-7 7 7 7"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  room: '<path d="M4 6h16v12H4zM9 3l3 3 3-3M9 21h6"/>', voice: '<path d="M5 10v4M9 5v14M13 2v20M17 6v12M21 10v4"/>',
  check: '<path d="m5 12 4 4L19 6"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>', skip: '<path d="m5 5 10 7-10 7ZM19 5v14"/>', stop: '<path d="M6 6h12v12H6z"/>',
  down: '<path d="m6 9 6 6 6-6"/>', edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>', trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', rules: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  assets: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  audio: '<path d="M3 9v6h4l5 4V5L7 9ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>', appearance: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 0 1 0 16"/>',
  muted: '<path d="M3 9v6h4l5 4V5L7 9ZM16 9l6 6M22 9l-6 6"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3ZM3 6V4h7l2 2h9v3"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  refresh: '<path d="M20 4v6h-6M4 20v-6h6M20 10a8 8 0 0 0-13-6M4 14a8 8 0 0 0 13 6"/>',
  chat: '<path d="M12 12h52a9 9 0 0 1 9 9v22a9 9 0 0 1-9 9H36L21 64V52h-9a9 9 0 0 1-9-9V21a9 9 0 0 1 9-9Z"/><path d="M24 32h.01M38 32h.01M52 32h.01"/>',
};
const icon = (name, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${icons[name] || icons.info}</svg>`;
const mark = '<img class="brand-mark" src="./logo.png" width="128" height="128" alt="" aria-hidden="true" draggable="false">';
const button = (label, action, options = {}) => `<button type="button" class="button ${options.class || ''}" data-action="${esc(action)}"${options.id ? ` data-id="${esc(options.id)}"` : ''}${options.disabled ? ' disabled' : ''}>${options.icon ? icon(options.icon) : ''}${esc(label)}</button>`;
const iconButton = (name, title, action, id = '') => `<button type="button" class="icon-button" aria-label="${esc(title)}" title="${esc(title)}" data-action="${esc(action)}" data-id="${esc(id)}">${icon(name)}</button>`;
const option = (value, label, selected) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
// Discard f32 serialization noise, without changing integer identifiers or text.
const displayNumber = value => typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value) ? Number(value.toFixed(6)) : value;
let fieldSequence = 0;
const pathField = (name, label, value, action, placeholder = '点击选择文件', hint = '') => {
  const id = `field-${++fieldSequence}`;
  return `<div class="field path-field"><span id="${id}">${esc(label)}</span><input type="hidden" name="${esc(name)}" value="${esc(value)}"><button type="button" class="path-picker" data-action="${esc(action)}" aria-labelledby="${id}" title="${esc(value || placeholder)}">${icon('folder')}<span data-path-value class="${value ? '' : 'placeholder'}">${esc(value || placeholder)}</span>${icon('arrow')}</button>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
};
function voiceName(id) {
  const voice = (snapshot.doubao_voices || []).find(item => (item.id || item.voice_id || item.value) === id);
  return voice?.name || voice?.label || '已保存的音色';
}
const field = (name, label, value = '', attrs = '', hint = '') => {
  const id = `field-${++fieldSequence}`;
  return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" name="${esc(name)}" value="${esc(attrs.includes('type="number"') ? displayNumber(value) : value)}" ${attrs}>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
};
const presetLabel = preset => preset.provider === 'doubao' && (!preset.name || preset.name.includes(preset.voice_id)) ? voiceName(preset.voice_id) : preset.name;
const textArea = (name, label, value = '', attrs = '', hint = '') => {
  const id = `field-${++fieldSequence}`;
  return `<div class="field"><label for="${id}">${esc(label)}</label><textarea id="${id}" name="${esc(name)}" rows="3" ${attrs}>${esc(value)}</textarea>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
};
const select = (name, label, options, hint = '') => {
  const id = `field-${++fieldSequence}`;
  return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" name="${esc(name)}">${options}</select>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
};
const check = (name, label, checked = false, description = '') => `<label class="check"><input name="${esc(name)}" type="checkbox"${checked ? ' checked' : ''}><span>${esc(label)}${description ? `<small>${esc(description)}</small>` : ''}</span></label>`;
const toggle = (name, label, checked, description = '') => `<label class="toggle-row"><span>${esc(label)}${description ? `<small>${esc(description)}</small>` : ''}</span><input type="checkbox" name="${esc(name)}"${checked ? ' checked' : ''}></label>`;
const heading = (title, description = '') => `<h2 class="settings-page-title">${esc(title)}</h2>${description ? `<p class="settings-page-description">${esc(description)}</p>` : ''}`;
const saveButton = (label = '保存更改') => `<button type="submit" class="button primary">${esc(label)}</button>`;
const autoStatus = () => '<div class="autosave-status" role="status" aria-live="polite" hidden><span data-autosave-label></span><button type="button" class="text-button" data-action="autosave.retry" hidden>重试</button><button type="button" class="text-button" data-action="autosave.discard" hidden>丢弃草稿</button></div>';
const autoFormTypes = new Set(['room-uid', 'gift-merge', 'preset', 'binding', 'tts-toggle', 'rules', 'sound-words', 'audio', 'appearance', 'startup', 'service-local', 'fish-settings', 'fish-preset']);
const manualSaveFormTypes = new Set(['service-fish', 'fish-voice', 'alias', 'asset', 'migration-apply']);
const autosaves = new Map();
const formDrafts = new Map();
const dotsSaves = new WeakMap();
const composingInputs = new WeakSet();
const tabEditors = new Map();
const empty = (message) => `<p class="empty-list">${esc(message)}</p>`;
let snapshot = null;
let updateInfo = null;
let updateBusy = false;
let updateError = "";
let step = null;
let setupTts = true;
let settingsTab = 'voices';
let settingsDirty = false;
let editor = null;
let migrationPreview = null;
let disposed = false;
let pendingCommands = 0;
let qrGeneration = 0;
let qrProvider = null;
let qrTimer = null;
let qrFailure = '';
let qrBusy = false;
let errorText = '';
let toastTimer;
let feedSignature = '';
const feedNodes = new Map();
const feedEvents = new Map();
let viewerContext = null;
let volumeDraft = null;
const voiceAuditionDraft = { provider: '', presetId: '', text: '你好，欢迎来到直播间。' };
let voiceAuditionRevision = 0;
let voiceAuditionDefaultSave = Promise.resolve();
let modelScan = { pairs: [], issues: [] };
let referenceProfiles = [];
const volumeSave = createAutosaveQueue({
  delay: 250,
  save: value => command('preferences.save', { preferences: { master_volume: value / 100, muted: false } }, { quiet: true, silent: true }),
  onSaved: (_, value) => { if (volumeDraft === value) volumeDraft = null; liveRenderSignature = ''; if (step === 'main') updateLive(); },
  onError: error => { volumeDraft = null; liveRenderSignature = ''; if (step === 'main') updateLive(); showError(error); },
});
let liveMainSignature = '';
let liveRenderSignature = '';
const seenPlaybackRecords = new Set();
let fallbackStatus = '';
let fallbackStatusTimer = null;
let snapshotTimer = null;
let windowFocused = document.hasFocus();
let nativeActive = null;
let effectiveActive = null;
const invoke = (command, args) => {
  if (!window.__TAURI__?.core?.invoke) return Promise.reject(new Error('桌面连接不可用，请从超绝可爱弹幕姬程序打开。'));
  return window.__TAURI__.core.invoke(command, args);
};

function showToast(message, isError = false) {
  const target = document.querySelector('#toast');
  clearTimeout(toastTimer);
  target.textContent = String(message);
  target.classList.toggle('error', isError);
  target.hidden = false;
  toastTimer = setTimeout(() => { target.hidden = true; }, isError ? 8000 : 3000);
}

function showError(error) {
  errorText = String(error?.message || error || '操作没有完成，请重试。');
  const target = document.querySelector('#step-error');
  if (target) { target.textContent = errorText; target.hidden = false; }
  const settingsError = document.querySelector('#settings-error');
  if (settingsDialog.open && settingsError) { settingsError.textContent = errorText; settingsError.hidden = false; }
  if (!target && !settingsDialog.open) showToast(errorText, true);
}

function clearError() {
  errorText = '';
  for (const node of document.querySelectorAll('#step-error, #settings-error')) { node.hidden = true; node.textContent = ''; }
}

function applyAppearance() {
  const preferences = snapshot?.preferences || {};
  const appearance = preferences.appearance || 'light';
  const theme = appearance === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : appearance;
  const startupTheme = window.__DANMAKUVOICE_STARTUP_THEME__;
  if (startupTheme?.session && startupTheme.appearance !== appearance) {
    try {
      window.sessionStorage?.setItem('danmakuvoice.startupTheme', JSON.stringify({ session: startupTheme.session, appearance }));
      startupTheme.appearance = appearance;
    } catch { /* Theme changes still work when browser storage is unavailable. */ }
  }
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
}

function acceptSnapshot(next) {
  snapshot = mergeSnapshot(snapshot, next);
  applyAppearance();
  updateHeaderIdentity();
  if (!step) { step = startingStep(snapshot); if (step === 'welcome') step = 'login'; setupTts = snapshot.setup?.tts_enabled ?? true; renderApp(); }
  if (snapshot.onboarding_done && step !== 'main') { stopQrPolling(); step = 'main'; renderApp(); }
  if (step === 'main') updateLive();
  if (settingsDialog.open) updateServiceIndicators();
  updateQr();
}

async function command(action, payload = {}, options = {}) {
  if (!options.quiet) clearError();
  pendingCommands++;
  try {
    const next = await invoke('dispatch', { action, payload });
    acceptSnapshot(next);
    if (options.success) showToast(options.success);
    return next;
  } catch (error) {
    try { acceptSnapshot(await invoke('snapshot')); } catch { /* Preserve the original command error. */ }
    if (!options.silent) showError(error);
    throw error;
  } finally { pendingCommands--; if (boot.polling) scheduleSnapshotPolling(); }
}

function setStep(next) {
  step = next;
  clearError();
  renderApp();
  if (next === 'login') void startQr('bilibili');
}

function errorSlot() { return '<div id="step-error" class="inline-error" role="alert" hidden></div>'; }

function renderChatBody(item) {
  return messageParts(item).map(part => part.type === 'emote'
    ? `<img class="message-emote${part.large ? ' large' : ''}" src="${esc(part.url)}" alt="${esc(part.text)}" title="${esc(part.text)}" loading="lazy" referrerpolicy="no-referrer">`
    : esc(part.text)).join('');
}


function renderHeaderPortrait(identity = headerIdentity(snapshot)) {
  if (!identity.loggedIn) return mark;
  return `<span class="account-avatar" aria-hidden="true"><span>${esc(initial(identity.name))}</span>${identity.avatar ? `<img class="account-photo" src="${esc(identity.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
}

function updateHeaderIdentity() {
  const portrait = document.querySelector('[data-brand-portrait]');
  if (!portrait) return;
  const identity = headerIdentity(snapshot);
  const signature = JSON.stringify(identity);
  if (portrait.dataset.identity === signature) return;
  portrait.dataset.identity = signature;
  portrait.innerHTML = renderHeaderPortrait(identity);
  const name = document.querySelector('[data-brand-name]');
  name.textContent = identity.name;
  name.title = identity.name;
}

function renderAvatar(item, key) {
  const url = safeMediaUrl(item.avatar_url);
  return `<button type="button" class="avatar avatar-button color-${identityColor(item.user_id || item.user_name)}" data-action="viewer.open" data-id="${esc(key)}" aria-label="设置 ${esc(item.user_name || '访客')} 的声音或别名" title="设置声音或别名"><span class="avatar-initial">${esc(initial(item.user_name))}</span>${url ? `<img class="avatar-photo" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</button>`;
}

function qrMarkup(provider, inSettings = false) {
  return `<div class="${inSettings ? 'settings-qr' : ''}" data-qr-provider="${provider}"><div class="qr-frame"><div class="qr-placeholder"><span class="spinner" aria-hidden="true"></span><span>正在生成二维码</span></div></div><div class="qr-status" role="status" aria-live="polite"><span class="status-dot pulse"></span><span data-qr-label>正在生成二维码</span></div><div class="actions qr-retry" hidden>${button('重新生成二维码', 'qr.retry', { icon: 'refresh', class: 'quiet small' })}</div></div>`;
}

function renderApp() {
  app.setAttribute('aria-busy', 'false');
  if (step === 'main') {
    app.innerHTML = `<div class="app-shell"><header class="app-header live-header"><div class="brand"><span data-brand-portrait>${renderHeaderPortrait()}</span><div class="brand-details"><div class="brand-name" data-brand-name>${esc(headerIdentity(snapshot).name)}</div><div class="room-status"><span id="connection-dot" class="status-dot"></span><span id="room-caption"></span></div></div></div><div class="header-actions"><button type="button" id="live-toggle" class="room-button" data-action="live.toggle"></button>${iconButton('settings', '打开设置', 'settings.open')}</div></header>${snapshot.network_disabled ? '<div class="test-mode-note" role="status">离线测试窗口 · 独立测试数据</div>' : ''}<main class="chat-main"><div id="live-error" class="live-error" role="status" hidden><span></span>${button('查看', 'settings.room', { class: 'quiet small' })}</div><div id="chat-scroll" class="chat-scroll" tabindex="0" aria-label="收到的弹幕"><div id="chat-empty" class="chat-empty"></div><div id="chat-feed" class="chat-feed" role="log" aria-label="实时弹幕" aria-live="polite" aria-relevant="additions"></div></div><button id="new-messages" class="new-messages" data-action="chat.bottom" hidden>${icon('down')}回到最新弹幕</button></main><footer id="playback-bar" class="playback-bar"><span id="playback-waves" class="playing-waves" aria-hidden="true"><i></i><i></i><i></i></span><span id="playback-caption" class="playback-caption"></span><div class="main-volume">${iconButton('audio', '静音', 'audio.mute')}<label class="sr-only" for="main-volume-range">播报主音量</label><input id="main-volume-range" type="range" min="0" max="200" step="5" value="${Math.round((snapshot.preferences?.master_volume ?? 1) * 100)}"><output id="main-volume-value" for="main-volume-range">${Math.round((snapshot.preferences?.master_volume ?? 1) * 100)}%</output></div>${iconButton('skip', '跳过当前播报', 'queue.skip')}${iconButton('stop', '停止接收和全部播报', 'queue.stop')}</footer><div id="viewer-menu" class="viewer-menu" hidden></div></div>`;
    app.querySelector('.header-actions').insertAdjacentHTML('afterbegin', `<button type="button" id="tts-switch" class="tts-switch" data-action="tts.open" aria-haspopup="menu" aria-expanded="false"></button>`);
    app.querySelector('#playback-bar .main-volume').insertAdjacentHTML('afterend', iconButton('trash', '清空待播队列', 'queue.clear'));
    app.querySelector('.app-shell').insertAdjacentHTML('beforeend', '<div id="tts-menu" class="tts-menu" role="menu" hidden></div>');
    feedSignature = ''; feedNodes.clear(); feedEvents.clear(); viewerContext = null; liveMainSignature = ''; liveRenderSignature = '';
    document.querySelector('#chat-scroll').addEventListener('scroll', event => {
      const node = event.currentTarget;
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 70) document.querySelector('#new-messages').hidden = true;
    }, { passive: true });
    updateLive();
    return;
  }
  const stepNumber = step === 'login' ? '01' : step === 'tts' || step === 'doubaoQr' ? '02' : '03';
  app.innerHTML = `<div class="app-shell"><header class="app-header"><div class="brand"><span data-brand-portrait>${renderHeaderPortrait()}</span><span class="brand-name" data-brand-name>${esc(headerIdentity(snapshot).name)}</span></div><div class="header-actions"><span class="step-counter">${stepNumber} / 03</span>${iconButton('settings', '打开设置', 'settings.open')}</div></header>${snapshot.network_disabled ? '<div class="test-mode-note" role="status">离线测试窗口 · 独立测试数据</div>' : ''}<main class="onboarding"><section class="setup-card ${step === 'login' || step === 'doubaoQr' ? 'qr-stage' : ''}" aria-label="初次设置">${renderStep()}</section><div class="setup-footer">${icon('shield')}登录凭据仅加密保存在这台电脑</div></main></div>`;
  updateQr();
}

function updateFallbackStatus(queue) {
  for (const record of queue.history || []) {
    if (seenPlaybackRecords.has(record.id)) continue;
    seenPlaybackRecords.add(record.id);
    if (seenPlaybackRecords.size > 200) seenPlaybackRecords.delete(seenPlaybackRecords.values().next().value);
    const notice = playbackFallbackNotice(record);
    if (!notice) continue;
    fallbackStatus = notice;
    clearTimeout(fallbackStatusTimer);
    fallbackStatusTimer = setTimeout(() => {
      fallbackStatus = '';
      fallbackStatusTimer = null;
      liveRenderSignature = '';
      if (step === 'main') updateLive();
    }, 8000);
  }
  return fallbackStatus;
}

function renderStep() {
  if (step === 'login') return `<div class="setup-eyebrow">首次设置</div><h1>连接直播间</h1><p class="setup-description">使用哔哩哔哩 App 扫码<br>自动找到你的直播间</p>${qrMarkup('bilibili')}${errorSlot()}<form data-form="anonymous" class="anonymous-form"><div class="anonymous-divider"><span>或匿名接收弹幕</span></div><div class="anonymous-input"><label for="anonymous-uid" class="sr-only">主播 UID</label><input id="anonymous-uid" name="uid" inputmode="numeric" autocomplete="off" placeholder="输入主播 UID" required pattern="[1-9][0-9]{0,19}" maxlength="20"><button type="submit" class="button primary" aria-label="使用主播 UID 匿名继续">继续 ${icon('arrow')}</button></div><p class="setup-footnote">UID 可在主播的个人主页找到</p></form>`;
  if (step === 'tts') return `<button type="button" class="back-button" data-action="setup.back">${icon('back')}返回</button><div class="tts-visual" aria-hidden="true"><span></span><span></span><span></span><span></span></div><div class="setup-eyebrow">语音播报</div><h1>开启豆包播报</h1><p class="setup-description">用豆包朗读直播间的新弹幕。<br>扫码连接后即可使用。</p>${button('使用豆包', 'setup.doubao', { class: 'primary wide', icon: 'voice' })}<div class="setup-actions">${button('暂时只看弹幕', 'setup.silent', { class: 'quiet wide' })}</div>${errorSlot()}`;
  if (step === 'doubaoQr') return `<button type="button" class="back-button" data-action="setup.back">${icon('back')}返回</button><div class="setup-eyebrow">语音播报</div><h1>扫码连接豆包</h1><p class="setup-description">使用豆包 App 扫描二维码<br>在手机上确认登录</p>${qrMarkup('doubao')}${errorSlot()}<div class="setup-actions">${button('暂时只看弹幕', 'setup.silent', { class: 'quiet wide' })}</div>`;
  return `<div class="ready-mark">${icon('check')}</div><div class="setup-eyebrow">首次设置</div><h1>配置完成</h1><p class="setup-description">现在可以接收直播间的弹幕了。</p><div class="setup-summary"><span>房间 ${esc(snapshot.setup?.room_id || '')}</span><span>${setupTts ? esc(providerLabel(snapshot.presets?.find(p => p.id === snapshot.rules?.default_preset_id)?.provider)) + '播报' : '仅显示弹幕'}</span></div>${button('开始接收弹幕', 'setup.finish', { class: 'primary wide', icon: 'arrow' })}${errorSlot()}`;
}

function updateQr() {
  for (const container of document.querySelectorAll('[data-qr-provider]')) {
    const matching = snapshot?.qr?.provider === container.dataset.qrProvider;
    const qr = matching ? snapshot.qr : { status: 'idle' };
    const needsRoom = matching && qrNeedsRoomFallback(snapshot);
    if (snapshot?.network_disabled) {
      if (container.dataset.renderSignature !== 'offline') {
        container.dataset.renderSignature = 'offline';
        container.querySelector('.qr-frame').innerHTML = '<div class="qr-placeholder">离线测试窗口</div>';
        container.querySelector('[data-qr-label]').textContent = '扫码请直接打开正式程序';
        container.querySelector('.status-dot').className = 'status-dot';
        container.querySelector('.qr-retry').hidden = true;
      }
      continue;
    }
    const frame = container.querySelector('.qr-frame');
    const url = safeQrUrl(qr.image_data_url);
    const signature = `${qr.status}:${url}:${qr.message || ''}:${qrFailure}:${qrBusy}:${needsRoom}`;
    if (container.dataset.renderSignature === signature) continue;
    container.dataset.renderSignature = signature;
    if (frame.dataset.signature !== signature) {
      frame.dataset.signature = signature;
      if (needsRoom) frame.innerHTML = `<div class="qr-placeholder">${icon('check')}<span>账号已登录<br>请在下方填写主播 UID</span></div>`;
      else if (qrFailure) frame.innerHTML = `<div class="qr-placeholder">${icon('qr')}<span>暂时无法生成二维码<br>请稍后重新尝试</span></div>`;
      else if (qr.status === 'expired') frame.innerHTML = `<div class="qr-placeholder">${icon('refresh')}<span>二维码已过期<br>重新生成后再扫码</span></div>`;
      else if (qr.status === 'complete') frame.innerHTML = `<div class="qr-placeholder">${icon('check')}<span>已完成登录</span></div>`;
      else if (url) { const image = document.createElement('img'); image.src = url; image.alt = container.dataset.qrProvider === 'bilibili' ? '哔哩哔哩登录二维码' : '豆包登录二维码'; frame.replaceChildren(image); }
      else frame.innerHTML = `<div class="qr-placeholder"><span class="spinner" aria-hidden="true"></span><span>正在生成二维码</span></div>`;
    }
    container.querySelector('[data-qr-label]').textContent = needsRoom ? '未找到本账号直播间；可填写主播 UID 匿名接收' : qrFailure || qrLabel(qr);
    container.querySelector('.status-dot').className = `status-dot ${qrFailure ? '' : qr.status === 'waiting' || qr.status === 'idle' ? 'pulse' : 'online'}`;
    container.querySelector('.qr-retry').hidden = needsRoom || qrBusy || (!qrFailure && !['expired', 'idle'].includes(qr.status));
  }
}

function stopQrPolling() { qrGeneration++; clearTimeout(qrTimer); qrTimer = null; qrProvider = null; }

async function startQr(provider, connectionId) {
  stopQrPolling();
  qrFailure = '';
  if (snapshot?.network_disabled) { qrBusy = false; updateQr(); return; }
  qrBusy = true;
  updateQr();
  qrProvider = provider;
  const generation = qrGeneration;
  try {
    await command(`${provider === 'bilibili' ? 'bili' : 'doubao'}.qr.begin`, connectionId ? { connection_id: connectionId } : {});
    if (generation === qrGeneration && !disposed) scheduleQrPoll(provider, generation);
  } catch {
    qrFailure = '二维码暂不可用，请重新生成';
  } finally { qrBusy = false; updateQr(); }
}

function scheduleQrPoll(provider, generation) {
  clearTimeout(qrTimer);
  if (!uiIsActive(nativeActive, windowFocused, document.hidden)) return;
  qrTimer = setTimeout(async () => {
    if (generation !== qrGeneration || disposed || !uiIsActive(nativeActive, windowFocused, document.hidden)) return;
    try {
      const next = await command(`${provider === 'bilibili' ? 'bili' : 'doubao'}.qr.poll`, {}, { quiet: true, silent: true });
      if (generation !== qrGeneration || disposed) return;
      if (next.qr?.status === 'complete') {
        stopQrPolling();
        if (settingsDialog.open && editor?.type === 'qr') {
          const preferredId = provider === 'doubao' && editor.makePreferred
            ? (snapshot.presets || []).find(preset => preset.id === editor.preferredPresetId && preset.provider === 'doubao')?.id
              || (snapshot.presets || []).find(preset => preset.provider === 'doubao' && preset.connection_id === editor.id)?.id
              || rememberedPreset('doubao')?.id
            : null;
          let preferenceError = null;
          if (preferredId) {
            try { await command('presets.default', { id: preferredId }, { quiet: true, silent: true }); }
            catch (error) { preferenceError = error; }
          }
          editor = null;
          renderSettings();
          if (preferenceError) showError(`豆包已连接，但设为首选失败：${preferenceError}`);
          else showToast(provider === 'bilibili' ? '哔哩哔哩已连接' : preferredId ? '豆包已连接并设为首选' : '豆包已连接');
        }
        else if (provider === 'bilibili' && step === 'login' && next.setup?.room_id) setStep('tts');
        else if (provider === 'doubao' && step === 'doubaoQr') { setupTts = true; setStep('ready'); }
      } else if (next.qr?.status !== 'expired') scheduleQrPoll(provider, generation);
    } catch {
      const needsRoom = qrNeedsRoomFallback(snapshot);
      qrFailure = needsRoom ? '' : '查询登录状态失败，请重新扫码';
      if (needsRoom && settingsDialog.open && editor?.type === 'qr' && editor.provider === 'bilibili') {
        editor = null;
        renderSettings();
      }
      updateQr();
    }
  }, 2500);
}

async function cancelQr() {
  const provider = qrProvider || snapshot?.qr?.provider;
  stopQrPolling();
  qrFailure = '';
  if (provider) await command(`${provider === 'bilibili' ? 'bili' : 'doubao'}.qr.cancel`, {}, { quiet: true });
}

function updateLive() {
  // The opaque settings surface owns the visible UI; catch up once it closes.
  if (settingsDialog.open) return;
  const scroll = document.querySelector('#chat-scroll');
  if (!scroll || !snapshot) return;
  const notice = updateFallbackStatus(snapshot.queue || {});
  const renderSignature = JSON.stringify([snapshot.live, snapshot.queue, snapshot.setup, snapshot.preferences?.tts_enabled, snapshot.preferences?.master_volume, snapshot.preferences?.muted, volumeDraft, snapshot.rules?.default_preset_id, snapshot.presets, snapshot.local_services, snapshot.status, notice]);
  if (liveRenderSignature === renderSignature) return;
  liveRenderSignature = renderSignature;
  const live = snapshot.live || {};
  const connection = liveConnectionView(live);
  const isOnline = connection.online;
  const isRunning = !!live.running;
  const room = live.room_id || snapshot.setup?.room_id;
  document.querySelector('#connection-dot').className = `status-dot ${isOnline ? 'online' : connection.pending ? 'pulse' : ''}`;
  const roomCaption = `${room ? `房间 ${room} · ` : ''}${connection.caption}`;
  const roomLabel = document.querySelector('#room-caption');
  if (roomLabel.textContent !== roomCaption) roomLabel.textContent = roomCaption;
  const control = document.querySelector('#live-toggle');
  const controlState = isOnline ? 'online' : live.connecting || connection.pending ? 'connecting' : 'offline';
  if (control.dataset.state !== controlState) control.dataset.state = controlState;
  const expired = live.state === 'session_expired';
  const controlSignature = `${isRunning}:${live.connecting}:${expired}`;
  if (control.dataset.signature !== controlSignature) {
    control.innerHTML = `${icon(isRunning ? 'pause' : 'play')}${expired ? '重新扫码' : isRunning ? '断开' : live.connecting ? '连接中' : '连接'}`;
    control.dataset.signature = controlSignature;
  }
  control.disabled = !!live.connecting;
  const preferred = snapshot.presets?.find(item => item.id === snapshot.rules?.default_preset_id);
  const switcher = document.querySelector('#tts-switch');
  const switchLabel = preferred ? providerLabel(preferred.provider) : '选择声音';
  if (switcher && switcher.dataset.label !== switchLabel) {
    switcher.innerHTML = `${icon('voice')}<span>${esc(switchLabel)}</span>${icon('down')}`;
    switcher.dataset.label = switchLabel;
  }
  const error = runtimeIssue(snapshot);
  const liveError = document.querySelector('#live-error');
  liveError.hidden = !error;
  const errorLabel = liveError.querySelector('span');
  if (errorLabel.textContent !== error) errorLabel.textContent = error;
  const events = normalizedEvents(snapshot);
  const keys = eventKeys(events);
  const signature = JSON.stringify(keys);
  if (feedSignature !== signature) {
    const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
    const feed = document.querySelector('#chat-feed');
    const wanted = new Set(keys);
    for (const [key, node] of feedNodes) if (!wanted.has(key)) { node.remove(); feedNodes.delete(key); feedEvents.delete(key); }
    for (let i = 0; i < events.length; i++) {
      feedEvents.set(keys[i], events[i]);
      if (feedNodes.has(keys[i])) continue;
      const item = events[i];
      const node = document.createElement('article');
      node.className = `chat-message message-tone-${identityColor(item.user_id || item.user_name)} ${item.kind === 'super_chat' ? 'super-chat' : item.kind === 'gift' || item.kind === 'guard' ? item.kind : ''}`;
      node.innerHTML = `${renderAvatar(item, keys[i])}<div class="message-content"><div class="message-name">${esc(item.user_name || '访客')}${item.kind === 'super_chat' ? `<span class="message-tag">醒目留言${item.price_yuan ? ` · ¥${esc(item.price_yuan)}` : ''}</span>` : ''}</div><div class="message-bubble">${renderChatBody(item)}</div></div>`;
      feedNodes.set(keys[i], node);
      feed.append(node);
    }
    feedSignature = signature;
    if (pinned) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    else if (events.length) document.querySelector('#new-messages').hidden = false;
  }
  const emptyNode = document.querySelector('#chat-empty');
  emptyNode.hidden = events.length > 0;
  const emptySignature = `${connection.caption}:${room}`;
  if (!events.length && liveMainSignature !== emptySignature) {
    emptyNode.innerHTML = `<div class="empty-art"><svg viewBox="0 0 80 70" aria-hidden="true">${icons.chat}</svg></div><h2>${connection.emptyTitle}</h2><p>${room ? connection.emptyDescription : '先在设置中连接一个直播间。'}</p>${!isRunning && !connection.pending ? button(room ? '连接直播间' : '设置直播间', room ? 'live.toggle' : 'settings.room', { class: 'small' }) : ''}`;
    liveMainSignature = emptySignature;
  }
  const queue = snapshot.queue || {};
  const enabled = snapshot.setup?.tts_enabled ?? snapshot.preferences?.tts_enabled;
  const bar = document.querySelector('#playback-bar');
  document.querySelector('#playback-waves').classList.toggle('active', !!queue.current);
  const playbackLabel = document.querySelector('#playback-caption');
  const playbackText = enabled || queue.current ? notice || playbackCaption(queue) : '播报已关闭';
  if (playbackLabel.textContent !== playbackText) playbackLabel.textContent = playbackText;
  if (playbackLabel.title !== notice) playbackLabel.title = notice;
  updateVolumeControls();
  bar.querySelector('[data-action="queue.skip"]').disabled = !queue.current;
  const clearQueue = bar.querySelector('[data-action="queue.clear"]');
  if (clearQueue) clearQueue.disabled = !queue.pending?.length;
  bar.querySelector('[data-action="queue.stop"]').disabled = !isRunning && !live.connecting && !queue.current && !queue.pending?.length;
}

function updateVolumeControls() {
  const volume = volumeDraft ?? Math.round((snapshot.preferences?.master_volume ?? 1) * 100);
  const muted = volume === 0 || (volumeDraft === null && !!snapshot.preferences?.muted);
  const slider = document.querySelector('#main-volume-range');
  if (slider && slider.value !== String(volume)) slider.value = String(volume);
  const output = document.querySelector('#main-volume-value');
  if (output) output.textContent = muted ? '静音' : `${volume}%`;
  const control = document.querySelector('[data-action="audio.mute"]');
  if (control) {
    const label = muted ? '取消静音' : '静音';
    control.title = label;
    control.setAttribute('aria-label', label);
    control.setAttribute('aria-pressed', String(muted));
    if (control.dataset.muted !== String(muted)) {
      control.dataset.muted = String(muted);
      control.innerHTML = icon(muted ? 'muted' : 'audio');
    }
  }
}

const tabs = [['room', 'room', '直播间'], ['voices', 'voice', '声音'], ['rules', 'rules', '播报规则'], ['assets', 'assets', '音效素材'], ['audio', 'audio', '音频输出'], ['appearance', 'appearance', '外观与启动'], ['data', 'folder', '数据与迁移'], ['about', 'info', '关于']];
const serviceProviders = ['doubao', 'dots', 'gpt_sovits', 'fish_audio'];
const providerTimeout = { doubao: 30, dots: 30, gpt_sovits: 30 };
const providerEndpoint = { dots: 'http://127.0.0.1:9881', gpt_sovits: 'http://127.0.0.1:9880' };
const fishDefaultVoiceId = '561fcedfdf0e4e1399d1bc4930d50c0e';

function rememberedPreset(provider) {
  const presets = snapshot.presets || [];
  const savedId = snapshot.rules?.preferred_presets?.[provider];
  return presets.find(item => item.provider === provider && item.id === savedId)
    || presets.find(item => item.provider === provider);
}

function serviceConnection(provider) {
  const preferred = rememberedPreset(provider);
  return (snapshot.connections || []).find(item => item.settings?.provider === provider && item.id === preferred?.connection_id)
    || (snapshot.connections || []).find(item => item.settings?.provider === provider);
}

function cloudPresetConnected(preset) {
  return !!(preset && (snapshot.connections || []).some(connection => connection.id === preset.connection_id && connection.has_credential));
}

function doubaoConnection(preset) {
  return (snapshot.connections || []).find(connection => connection.id === preset?.connection_id) || serviceConnection('doubao');
}

async function guideDoubaoLogin(preferredPresetId = '') {
  const preset = (snapshot.presets || []).find(item => item.id === preferredPresetId && item.provider === 'doubao');
  const connection = doubaoConnection(preset);
  if (settingsDialog.open && !await allowLeaveSettings()) return false;
  const nextEditor = { type: 'qr', provider: 'doubao', id: connection?.id || '', makePreferred: true, preferredPresetId: preset?.id || '' };
  if (settingsDialog.open) { editor = nextEditor; renderSettings(); }
  else await openViewerSettings('voices', nextEditor);
  await startQr('doubao', connection?.id);
  return true;
}

function providerStatus(provider, connection) {
  if (provider === 'dots' || provider === 'gpt_sovits') {
    const status = snapshot.local_services?.[provider];
    const detail = status?.message || '';
    if (status?.state === 'ready') return { tone: 'ready', label: '服务已就绪', detail };
    if (status?.state === 'checking') return { tone: 'pending', label: '正在检查', detail };
    if (status?.state === 'starting') return { tone: 'pending', label: '正在启动', detail };
    if (status?.state === 'failed') return { tone: 'error', label: '连接异常', detail: detail || '连接失败，请检查服务设置。' };
    if (status?.state === 'stopped') return { tone: 'idle', label: '已停止', detail };
    return connection || status?.directory
      ? { tone: 'idle', label: '待检查', detail: '可在服务设置中检查连接。安装目录仅用于自动启动。' }
      : { tone: 'idle', label: '未配置', detail: '先在服务设置中选择安装目录。' };
  }
  // The light reports saved account configuration, not a continuous cloud health probe.
  if (provider === 'doubao' && connection?.has_credential) return { tone: 'ready', label: '已登录', detail: '已在本机保存登录。可通过试听确认当前音色是否可用。' };
  if (provider === 'fish_audio' && connection?.has_credential) return { tone: 'ready', label: '已连接', detail: '已在本机保存 API Key。可通过试听确认当前音色是否可用。' };
  return { tone: 'idle', label: provider === 'doubao' ? '未登录' : '未连接', detail: provider === 'doubao' ? '在设置中扫码登录豆包。' : '在设置中连接 Fish Audio 账号。' };
}

function serviceChoiceLabel(provider, status, preferred) {
  return `${providerLabel(provider)}，${status.label}，${preferred ? '直播首选' : '设为直播首选'}`;
}

function updateAttribute(node, name, value) {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function updateServiceIndicators() {
  for (const row of settingsDialog.querySelectorAll('[data-service-provider]')) {
    const provider = row.dataset.serviceProvider;
    const status = providerStatus(provider, serviceConnection(provider));
    const light = row.querySelector('.service-light');
    const lightClass = `service-light ${status.tone}`;
    if (light && light.className !== lightClass) light.className = lightClass;
    const label = row.querySelector('.service-card-status, .service-status-label');
    if (label && label.textContent !== status.label) label.textContent = status.label;
    updateAttribute(label, 'title', status.detail || status.label);
    const choice = row.querySelector('.service-card-select');
    if (choice) {
      const preferred = snapshot.presets?.find(preset => preset.id === snapshot.rules?.default_preset_id)?.provider === provider;
      row.classList.toggle('preferred', preferred);
      updateAttribute(choice, 'aria-pressed', String(preferred));
      updateAttribute(choice, 'aria-label', serviceChoiceLabel(provider, status, preferred));
      updateAttribute(choice, 'title', status.detail || status.label);
    }
    const detail = row.querySelector('[data-service-message]');
    if (detail) {
      const state = snapshot.local_services?.[provider] || {};
      if (detail.textContent !== (state.message || '')) detail.textContent = state.message || '';
      detail.hidden = state.state !== 'failed' || !state.message;
      detail.classList.toggle('status-error', state.state === 'failed');
    }
  }
  const start = settingsDialog.querySelector('[data-action="service.start"]');
  if (start) {
    const provider = start.dataset.id;
    const state = snapshot.local_services?.[provider] || {};
    start.disabled = !serviceConnection(provider) || !state.directory || !!state.owned || ['checking', 'starting'].includes(state.state);
    const stop = settingsDialog.querySelector('[data-action="service.stop"]');
    if (stop) stop.disabled = !state.owned;
  }
}

function collectAutosave(form) {
  if (!form.checkValidity()) throw new Error('请检查未填或格式不正确的项目');
  const type = form.dataset.form;
  const data = new FormData(form);
  const value = key => String(data.get(key) ?? '').trim();
  const number = key => Number(data.get(key));
  const checked = key => data.has(key);
  const id = form.dataset.id || '';
  if (type === 'room-uid') {
    if (!validUid(value('uid'))) throw new Error('请输入有效的主播 UID');
    return { action: 'onboarding.anonymous', payload: { uid: value('uid') } };
  }
  if (type === 'gift-merge') {
    const gift_merge = { enabled: checked('enabled'), initial_seconds: number('initial_seconds'), increment_seconds: number('increment_seconds'), maximum_seconds: number('maximum_seconds') };
    if (gift_merge.maximum_seconds < gift_merge.initial_seconds) throw new Error('最长等待不能小于初始等待');
    return { action: 'live.save', payload: { gift_merge } };
  }
  if (type === 'preset') {
    const connection = snapshot.connections.find(item => item.id === value('connection_id'));
    if (!connection || !value('voice_id')) throw new Error('请选择语音服务和音色');
    const name = value('name') || (connection.settings.provider === 'doubao' ? voiceName(value('voice_id')) : snapshot.presets.find(item => item.id === id)?.name || `${providerLabel(connection.settings.provider)} · ${value('voice_id')}`).slice(0, 100);
    const preset = { id, name, connection_id: connection.id, provider: connection.settings.provider, voice_id: value('voice_id'), speed: number('speed'), volume: number('volume'), sovits: null };
    if (preset.provider === 'gpt_sovits') preset.sovits = { model_selection: value('model_selection'), gpt_weights_path: value('gpt_weights_path') || null, sovits_weights_path: value('sovits_weights_path') || null, reference_text: value('reference_text'), reference_text_free: checked('reference_text_free'), reference_language: value('reference_language'), text_language: value('text_language'), split: value('split'), top_k: number('top_k'), top_p: number('top_p'), temperature: number('temperature'), sample_steps: number('sample_steps'), super_sampling: checked('super_sampling'), fragment_interval_secs: number('fragment_interval_secs') };
    return { action: 'presets.save', payload: { preset } };
  }
  if (type === 'service-local') {
    if (!['dots', 'gpt_sovits'].includes(form.dataset.provider)) throw new Error('本地服务类型无效。');
    return { action: 'local_services.save', payload: { provider: form.dataset.provider, directory: value('directory') } };
  }
  if (type === 'fish-settings') {
    const connectionId = form.dataset.connectionId;
    if (!snapshot.connections.some(item => item.id === connectionId && item.has_credential)) throw new Error('请先连接 Fish Audio 账号。');
    return { action: 'fish.settings.save', payload: { connection_id: connectionId, settings: { model: value('model'), latency: value('latency'), volume_db: number('volume_db'), temperature: number('temperature'), top_p: number('top_p'), streaming: true } } };
  }
  if (type === 'fish-preset') {
    const existing = snapshot.presets.find(item => item.id === id && item.provider === 'fish_audio' && item.connection_id === form.dataset.connectionId);
    if (!existing) throw new Error('请重新打开音色设置。');
    return { action: 'presets.save', payload: { preset: { ...existing, name: value('name'), speed: number('speed'), volume: number('volume') } } };
  }
  if (type === 'binding') {
    const userId = value('user_id');
    const userName = value('user_name');
    if (!userId && !userName) throw new Error('请填写观众用户名或 UID');
    if (userId && !validUid(userId)) throw new Error('请输入有效的观众 UID');
    if (!value('preset_id')) throw new Error('请先选择声音预设');
    return { action: 'bindings.save', payload: { id, binding: { platform: 'bilibili', user_id: userId ? numericId(userId) : null, user_name: userId ? null : userName || null, legacy_user_name: snapshot.bindings.find(item => item.id === id)?.binding.legacy_user_name || null, preset_id: value('preset_id'), enabled: checked('enabled') } } };
  }
  if (type === 'tts-toggle') return { action: 'preferences.save', payload: { preferences: { tts_enabled: checked('tts_enabled') } } };
  if (type === 'rules') {
    const rules = structuredClone(snapshot.rules);
    for (const key of ['danmaku_on', 'gift_on', 'free_gift_on', 'super_chat_on', 'guard_on']) rules.events[key] = checked(key);
    for (const key of ['gift_threshold_yuan', 'super_chat_threshold_yuan']) rules.events[key] = number(key);
    for (const key of ['danmaku', 'gift', 'super_chat', 'guard']) rules.templates[key] = value(`template_${key}`);
    for (const type of ['user_words', 'message_words']) rules[type] = [...form.querySelectorAll(`[data-dictionary="${type}"] .dict-row`)].map(row => ({ from: row.querySelector('[data-key="from"]').value, to: row.querySelector('[data-key="to"]').value }));
    return { action: 'rules.save', payload: { rules } };
  }
  if (type === 'sound-words') {
    const rules = structuredClone(snapshot.rules);
    rules.sounds = [...form.querySelectorAll('[data-dictionary="sounds"] .dict-row')].map(row => ({ trigger: row.querySelector('[data-key="from"]').value, asset_id: row.querySelector('[data-key="to"]').value }));
    return { action: 'rules.save', payload: { rules } };
  }
  if (type === 'audio') return { action: 'preferences.save', payload: { preferences: { output: value('output') ? { named: value('output') } : 'default' }, confirmed: true } };
  if (type === 'appearance') return { action: 'preferences.save', payload: { preferences: { appearance: value('appearance'), scale: number('scale') } } };
  if (type === 'startup') return { action: 'startup.set', payload: { enabled: checked('enabled') } };
  throw new Error('暂时无法保存此项设置，请重新打开页面');
}

function showAutoState(form, message = '', state = '') {
  const node = form.querySelector('.autosave-status');
  if (!node) return;
  const needsAttention = state === 'error' || state === 'draft';
  node.hidden = !needsAttention;
  node.dataset.state = state;
  node.querySelector('[data-autosave-label]').textContent = needsAttention ? message : '';
  node.querySelector('[data-action="autosave.retry"]').hidden = state !== 'error';
  node.querySelector('[data-action="autosave.discard"]').hidden = state !== 'error' && state !== 'draft';
}

function copyFormDraft(form, record) {
  const clone = form.cloneNode(true);
  stripSelects(clone);
  const sourceFields = [...form.querySelectorAll('input,select,textarea')];
  const copiedFields = [...clone.querySelectorAll('input,select,textarea')];
  sourceFields.forEach((source, index) => {
    const copy = copiedFields[index];
    if (source.tagName === 'SELECT') [...copy.options].forEach(option => option.toggleAttribute('selected', option.value === source.value));
    else if (source.tagName === 'TEXTAREA') copy.textContent = source.value;
    else if (source.type === 'checkbox') copy.toggleAttribute('checked', source.checked);
    else copy.setAttribute('value', source.value);
  });
  delete clone.dataset.busy;
  clone.removeAttribute('aria-busy');
  for (const submit of clone.querySelectorAll('button[type="submit"]')) submit.disabled = false;
  formDrafts.set(record.key, { html: clone.outerHTML, editor: record.editor ? { ...record.editor } : null, tab: record.tab, type: form.dataset.form });
}

function dotsDraftKey(form) { return `voices:dots-preset:${form.dataset.id || 'new'}`; }

function rememberDotsDraft(form) {
  copyFormDraft(form, { key: dotsDraftKey(form), editor, tab: 'voices' });
}

function mountAutosaves() {
  for (let form of settingsDialog.querySelectorAll('[data-form]')) {
    const key = `${settingsTab}:${form.dataset.form}:${form.dataset.id || form.dataset.provider || form.dataset.connectionId || 'new'}`;
    const draft = formDrafts.get(key);
    if (draft) { const template = document.createElement('template'); template.innerHTML = draft.html; const restored = template.content.firstElementChild; form.replaceWith(restored); form = restored; }
    if (!autoFormTypes.has(form.dataset.form)) continue;
    const record = { key, form, tab: settingsTab, editor: editor ? { ...editor } : null, revision: 0, touched: !!draft, invalid: '', lastScheduled: '', baseline: '', queue: null };
    let validDraft = false;
    try { record.baseline = JSON.stringify(collectAutosave(form)); validDraft = true; } catch { /* An incomplete draft is not a saved setting. */ }
    if (draft) record.baseline = '';
    record.queue = createAutosaveQueue({
      delay: 600,
      prepare: envelope => {
        const prepared = structuredClone(envelope);
        if (form.dataset.form === 'preset') prepared.payload.preset.id = form.dataset.id || '';
        if (form.dataset.form === 'binding') prepared.payload.id = form.dataset.id || '';
        return prepared;
      },
      save: async ({ action, payload }) => {
        if (form.dataset.form === 'service-local') return saveLocalDirectory(payload.provider, payload.directory);
        if (form.dataset.form === 'room-uid' && qrProvider) await cancelQr();
        return command(action, payload, { quiet: true, silent: true });
      },
      onSaved: async (result, envelope) => {
        const oldKey = record.key;
        if (result.result?.id && ['preset', 'binding'].includes(form.dataset.form)) {
          form.dataset.id = result.result.id;
          record.key = `${record.tab}:${form.dataset.form}:${result.result.id}`;
          if (record.editor) record.editor.id = result.result.id;
          if (editor?.type === form.dataset.form) editor.id = result.result.id;
          if (formDrafts.has(oldKey)) { formDrafts.set(record.key, formDrafts.get(oldKey)); formDrafts.delete(oldKey); }
        }
        if (form.elements.credential && envelope.payload.credential && form.elements.credential.value.trim() === envelope.payload.credential) form.elements.credential.value = '';
        const savedPresetId = form.dataset.form === 'preset' ? result.result?.id || form.dataset.id : null;
        if (record.editor?.makePreferred && savedPresetId && !form.elements.model_pair) {
          await command('presets.default', { id: savedPresetId }, { quiet: true, silent: true });
          record.editor.makePreferred = false;
          if (editor?.type === 'preset' && editor.id === savedPresetId) editor.makePreferred = false;
        }
        if (record.revision === envelope.revision) {
          record.touched = false; record.invalid = ''; formDrafts.delete(record.key); formDrafts.delete(oldKey);
          try { record.baseline = JSON.stringify(collectAutosave(form)); record.lastScheduled = record.baseline; } catch { /* May become invalid only after a concurrent edit. */ }
          showAutoState(form);
          if (form.dataset.form === 'room-uid' && settingsDialog.open && settingsTab === 'room') {
            // The room page also contains an independent gift merge autosave.
            // Flush it before replacing the page, which would cancel its timer.
            const siblings = [...autosaves.entries()].filter(([otherForm]) => otherForm !== form);
            const results = await Promise.allSettled(siblings
              .filter(([, other]) => other.touched && !other.invalid)
              .map(([, other]) => other.queue.flush()));
            const siblingDraft = siblings.some(([otherForm, other]) => autosaves.get(otherForm) !== other || other.touched || other.queue.dirty);
            const composing = [...settingsDialog.querySelectorAll('input,textarea')].some(input => composingInputs.has(input));
            if (results.every(result => result.status === 'fulfilled') && !siblingDraft && !composing
              && record.revision === envelope.revision && autosaves.get(form) === record && settingsDialog.open && settingsTab === 'room') {
              editor = null;
              renderSettings();
            }
          }
        } else if (record.touched) { copyFormDraft(form, record); if (oldKey !== record.key) formDrafts.delete(oldKey); }
      },
      onError: error => { showAutoState(form, String(error?.message || error), 'error'); record.touched = true; copyFormDraft(form, record); },
      onState: state => {
        if (record.invalid) return;
        if (state.saving) showAutoState(form);
        else if (state.error) showAutoState(form, String(state.error?.message || state.error), 'error');
        else if (state.dirty || !record.touched) showAutoState(form);
      },
    });
    autosaves.set(form, record);
    if (draft) showAutoState(form, validDraft ? '已恢复未保存的修改，请重试保存' : '已恢复未完成的修改，请补全', validDraft ? 'error' : 'draft');
  }
}

function scheduleAutosave(form, immediate = false, deferUid = false, composing = false) {
  const record = autosaves.get(form);
  if (!record) return;
  record.touched = true;
  record.revision++;
  copyFormDraft(form, record);
  let envelope;
  try { envelope = collectAutosave(form); record.invalid = ''; }
  catch (error) {
    record.invalid = error.message; record.queue.cancel(); record.lastScheduled = '';
    showAutoState(form, `${error.message} · 草稿已保留`, 'draft'); return;
  }
  const signature = JSON.stringify(envelope);
  if (signature === record.baseline && !record.queue.saving) {
    record.queue.cancel(); record.touched = false; formDrafts.delete(record.key); showAutoState(form); return;
  }
  if (composing || (form.dataset.form === 'room-uid' && deferUid)) {
    record.queue.cancel();
    record.lastScheduled = '';
    showAutoState(form);
    return;
  }
  record.lastScheduled = signature;
  record.queue.schedule({ ...envelope, revision: record.revision }, { immediate });
}

async function flushAutosaves() {
  if ([...settingsDialog.querySelectorAll('input,textarea')].some(input => composingInputs.has(input))) {
    showToast('请先完成输入法选字，再切换或退出设置', true);
    return false;
  }
  let failed = false;
  for (const [form, record] of autosaves) {
    if (!record.touched) continue;
    scheduleAutosave(form, true);
    try { await record.queue.flush(); }
    catch { failed = true; copyFormDraft(form, record); }
  }
  if (failed) showToast('部分更改未能保存，修改已保留在设置中', true);
  return !failed && ![...autosaves.values()].some(record => record.touched && record.invalid);
}

function unmountAutosaves() {
  for (const [form, record] of autosaves) {
    if (record.touched) copyFormDraft(form, record);
    record.queue.cancel();
    if (!record.queue.saving) record.queue.dispose();
  }
  autosaves.clear();
}

function draftNotices() {
  return [...formDrafts.entries()].filter(([key, draft]) => key.startsWith('voices:') && draft.editor && !draft.editor.id).map(([key, draft]) => `<div class="draft-notice"><span>${esc({ connection: '服务连接', preset: '声音预设', 'dots-preset': 'dots 音色', binding: '观众声音' }[draft.type])}还有未完成的内容</span><div class="actions">${button('继续填写', 'draft.resume', { id: key, class: 'small' })}${button('丢弃', 'draft.discard', { id: key, class: 'small quiet' })}</div></div>`).join('');
}

function renderSettings() {
  closeSelect();
  unmountAutosaves();
  settingsDirty = false;
  settingsDialog.innerHTML = `<div class="settings-shell"><header class="settings-heading"><h2 id="settings-title">设置</h2>${iconButton('close', '关闭设置', 'settings.close')}</header><div id="settings-error" class="settings-status" role="alert" hidden></div><div class="settings-body"><label class="settings-category-label" for="settings-category"><span class="sr-only">设置分类</span><select id="settings-category" aria-label="设置分类">${tabs.map(([id, , title]) => option(id, title, settingsTab)).join('')}</select></label><nav class="settings-nav" aria-label="设置分类">${tabs.map(([id, glyph, title]) => `<button type="button" data-action="settings.tab" data-id="${id}"${settingsTab === id ? ' aria-current="page"' : ''}>${icon(glyph)}${title}</button>`).join('')}</nav><section class="settings-content" id="settings-content" tabindex="-1">${editor ? `<div class="editor-navigation">${button(`返回${tabs.find(([id]) => id === settingsTab)?.[2] || '设置'}`, 'editor.cancel', { class: 'small quiet', icon: 'back' })}</div>` : ''}${renderSettingsPage()}</section></div></div>`;
  mountAutosaves();
  if (editor?.type === 'preset') hideLegacyVoiceFields();
  if (editor?.type === 'preset' && !editor.id) applyModelPairToForm(false);
  updateServiceIndicators();
  mountSelects(settingsDialog);
  updateQr();
}

function renderAbout() {
  const status = updateBusy ? '正在检查…' : updateError || (updateInfo?.status === 'available' ? `发现新版本 ${updateInfo.latest_version}` : updateInfo?.status === 'up_to_date' ? '已是最新版本' : updateInfo?.status === 'no_release' ? '暂无正式发布版本' : '');
  return `${heading('超绝可爱弹幕姬')}<div class="about-mark">${mark}</div><dl class="key-value"><dt>版本</dt><dd>${esc(snapshot.app_version || '—')}</dd><dt>数据目录</dt><dd>${esc(snapshot.data_dir)}</dd></dl><div class="actions">${button(updateBusy ? '正在检查…' : '检查更新', 'update.check', { disabled: updateBusy || snapshot.network_disabled })}${updateInfo?.download_url ? button('下载新版', 'external.open', { id: 'update_download', class: 'primary', icon: 'external' }) : ''}${button('GitHub', 'external.open', { id: 'project', class: 'quiet', icon: 'external' })}${button('发布页面', 'external.open', { id: 'releases', class: 'quiet', icon: 'external' })}</div><p role="status" class="${updateError ? 'field-error' : 'quiet-note'}">${esc(status)}</p>${updateInfo?.status === 'available' ? '<p class="quiet-note">下载后解压 ZIP，退出程序，再用新版 EXE 替换原文件，设置会保留。</p>' : ''}<p class="license">AGPL-3.0-only · 许可信息见 GitHub 仓库 NOTICE。</p>`;
}

function renderSettingsPage() {
  if (!snapshot) return empty('桌面连接不可用。');
  if (settingsTab === 'room') return renderRoomSettings();
  if (settingsTab === 'voices') return renderVoicesSettings();
  if (settingsTab === 'rules') return renderRulesSettings();
  if (settingsTab === 'assets') return renderAssetsSettings();
  if (settingsTab === 'audio') return renderAudioSettings();
  if (settingsTab === 'appearance') return renderAppearanceSettings();
  if (settingsTab === 'data') return renderDataSettings();
  return renderAbout();
}

function renderRoomSettings() {
  const loggedIn = !!snapshot.account?.user_id;
  const expired = snapshot.live?.state === 'session_expired';
  const scanning = editor?.type === 'qr' && editor.provider === 'bilibili';
  const anonymous = snapshot.setup?.mode === 'anonymous';
  const needsRoom = qrNeedsRoomFallback(snapshot);
  const showUid = needsRoom || (!scanning && (!loggedIn || anonymous || editor?.type === 'anonymous-room'));
  const room = snapshot.setup?.room_id || snapshot.live_settings?.room_id;
  const accountActions = loggedIn
    ? `${needsRoom ? '' : anonymous ? button('使用我的直播间', 'bili.use_account', { class: 'small' }) : button('改用主播 UID', 'room.anonymous', { class: 'small' })}${button('重新扫码', 'bili.begin', { class: 'small quiet', icon: 'qr' })}`
    : button('扫码登录', 'bili.begin', { class: 'primary small', icon: 'qr' });
  const account = scanning ? `<div class="settings-card">${qrMarkup('bilibili', true)}${button('取消扫码', 'editor.cancel', { class: 'small' })}</div>`
    : `<section class="settings-card room-account"><div class="card-heading">${icon('person')}<h3>哔哩哔哩账号</h3><span class="account-state ${expired ? 'error' : loggedIn ? 'ready' : ''}">${expired ? '登录已失效' : loggedIn ? '已登录' : '未登录'}</span></div><p class="quiet-note">${expired ? '重新扫码登录后即可继续接收弹幕。' : needsRoom ? '尚未找到本人直播间，可以填写下方主播 UID。' : loggedIn ? '可使用自己的直播间，也可通过主播 UID 接收其他直播间。' : '用哔哩哔哩 App 扫码，自动找到自己的直播间。'}</p><div class="actions">${accountActions}</div></section>`;
  const uidForm = showUid ? `<form data-form="room-uid" class="settings-card room-uid"><div class="card-heading">${icon('room')}<h3>通过主播 UID 接收</h3><span class="badge">免登录</span></div><p class="quiet-note">填写主播个人主页中的 UID，输入完成后自动查找直播间。</p>${field('uid', '主播 UID', anonymous ? snapshot.setup?.uid || '' : '', 'inputmode="numeric" pattern="[1-9][0-9]{0,19}" maxlength="20" required placeholder="输入主播 UID"')}${room && anonymous ? `<p class="room-target">${icon('check')}接收目标 · 直播间 ${esc(room)}</p>` : ''}${autoStatus()}</form>` : '';
  return `${heading('直播间', needsRoom ? '未找到本账号直播间，可以通过主播 UID 接收弹幕。' : '')}${account}${uidForm}${!showUid && room && !scanning ? `<p class="room-target">${icon('check')}接收目标 · 直播间 ${esc(room)}</p>` : ''}<div class="room-options">${renderGiftMerge()}</div>${loggedIn ? `<div class="danger-zone">${button('退出哔哩哔哩账号', 'bili.logout', { class: 'small danger' })}</div>` : ''}`;
}

function renderGiftMerge() {
  const merge = snapshot.live_settings?.gift_merge || { enabled: false, initial_seconds: 1.5, increment_seconds: .5, maximum_seconds: 5 };
  return `<details class="details"><summary>合并连续赠送的礼物</summary><form data-form="gift-merge">${toggle('enabled', '合并同一观众连续赠送的同种礼物', merge.enabled)}<div class="field-grid">${field('initial_seconds', '初始等待（秒）', merge.initial_seconds, 'type="number" min="0.1" max="30" step="0.1" required')}${field('increment_seconds', '每次延长（秒）', merge.increment_seconds, 'type="number" min="0" max="30" step="0.1" required')}${field('maximum_seconds', '最长等待（秒）', merge.maximum_seconds, 'type="number" min="0.1" max="60" step="0.1" required')}</div><p class="quiet-note">断开直播间后可更改。礼物先按播报规则过滤，再合并数量。</p>${autoStatus()}</form></details>`;
}

function renderVoiceAudition(presets, preferred) {
  const provider = preferred?.provider || voiceAuditionDraft.provider || presets[0]?.provider || 'doubao';
  const voices = presets.filter(preset => preset.provider === provider);
  const selected = voices.find(preset => preset.id === preferred?.id) || voices.find(preset => preset.id === voiceAuditionDraft.presetId);
  const options = voices.map(preset => option(preset.id, presetLabel(preset), selected?.id)).join('');
  const choices = selected ? options : option('', '选择音色', '') + options;
  return `<section class="voice-audition" aria-labelledby="voice-audition-title"><div class="voice-audition-heading"><h3 id="voice-audition-title">播报声音</h3></div><div class="voice-step-label"><span>1</span>选择服务</div><div class="service-grid" role="group" aria-label="默认语音服务">${serviceProviders.map(item => renderServiceCard(item, preferred)).join('')}</div><form data-form="voice-audition" data-provider="${esc(provider)}"><div class="voice-audition-controls"><label><span class="voice-step-label"><span>2</span>选择音色</span><select name="preset_id" aria-label="直播首选音色" required${voices.length ? '' : ' disabled'}>${voices.length ? choices : '<option value="">先为这个服务添加音色</option>'}</select></label>${button('添加音色', 'voice-audition.add', { class: 'small quiet', icon: 'plus' })}</div><label class="voice-step-label" for="voice-audition-text"><span>3</span>试听</label><textarea id="voice-audition-text" name="text" aria-label="试听文字" maxlength="2000" rows="2" required placeholder="输入想试听的文字">${esc(voiceAuditionDraft.text)}</textarea><div class="voice-audition-footer"><button type="submit" class="button primary small"${selected ? '' : ' disabled'}>${icon('play')}试听声音</button></div></form></section>`;
}

function updateVoiceAudition(form) {
  const provider = form.dataset.provider;
  const voices = (snapshot.presets || []).filter(preset => preset.provider === provider);
  const voice = form.elements.preset_id;
  voice.disabled = !voices.length;
  voiceAuditionDraft.provider = provider;
  voiceAuditionDraft.presetId = voice.value;
  voiceAuditionDraft.text = form.elements.text.value;
  const selected = voices.find(preset => preset.id === voice.value);
  const audition = form.querySelector('[type="submit"]');
  if (audition) audition.disabled = !selected;
}

async function saveVoiceAuditionChoice(form) {
  updateVoiceAudition(form);
  const preset = (snapshot.presets || []).find(item => item.id === form.elements.preset_id.value && item.provider === form.dataset.provider);
  if (!preset) return false;
  if (preset.provider === 'doubao' && !cloudPresetConnected(preset)) {
    await settleVoiceAuditionChoice();
    if (!await guideDoubaoLogin(preset.id)) {
      const preferred = (snapshot.presets || []).find(item => item.id === snapshot.rules?.default_preset_id);
      const savedId = preferred?.provider === form.dataset.provider ? preferred.id : '';
      form.elements.preset_id.value = savedId;
      voiceAuditionDraft.provider = preferred?.provider || '';
      voiceAuditionDraft.presetId = savedId;
      const audition = form.querySelector('[type="submit"]');
      if (audition) audition.disabled = !savedId;
    }
    return false;
  }
  const revision = ++voiceAuditionRevision;
  voiceAuditionDefaultSave = voiceAuditionDefaultSave.catch(() => {}).then(async () => {
    if (revision !== voiceAuditionRevision || preset.id === snapshot.rules?.default_preset_id) return;
    await command('presets.default', { id: preset.id }, { success: `${preset.name} 已设为首选` });
  });
  try {
    await voiceAuditionDefaultSave;
    if (revision === voiceAuditionRevision && settingsDialog.open && settingsTab === 'voices' && !editor) renderSettings();
    return snapshot.rules?.default_preset_id === preset.id;
  } catch (error) {
    if (revision !== voiceAuditionRevision) return false;
    const preferred = snapshot.presets.find(item => item.id === snapshot.rules?.default_preset_id);
    voiceAuditionDraft.provider = preferred?.provider || '';
    voiceAuditionDraft.presetId = preferred?.id || '';
    renderSettings();
    showError(error);
    return false;
  }
}

async function settleVoiceAuditionChoice() {
  try {
    await voiceAuditionDefaultSave;
    return true;
  } catch {
    return false;
  } finally {
    voiceAuditionRevision++;
  }
}

async function flushExitEdits() {
  // Exit is one action: flush pending automatic saves, but never prompt about
  // an unsubmitted form or keep an owned service running because a save failed.
  await Promise.allSettled([volumeSave.flush(), settleVoiceAuditionChoice(), flushAutosaves()]);
  return true;
}

function renderVoicesSettings() {
  const presets = snapshot.presets || [];
  const bindings = snapshot.bindings || [];
  if (editor?.type === 'service') return renderServiceEditor(editor.provider);
  if (editor?.type === 'preset') return renderPresetEditor(editor.id);
  if (editor?.type === 'binding') return renderBindingEditor(editor.id);
  if (editor?.type === 'qr') return `${heading('连接豆包', '使用豆包 App 扫码，并在手机上确认登录。')}${qrMarkup('doubao', true)}<div class="actions">${button('返回', 'editor.cancel', { class: 'quiet' })}</div>`;
  const preferred = presets.find(item => item.id === snapshot.rules?.default_preset_id);
  const selectedProvider = preferred?.provider || voiceAuditionDraft.provider || presets[0]?.provider || 'doubao';
  const managedPresets = presets.filter(preset => preset.provider === selectedProvider);
  const presetRow = preset => `<div class="setting-row"><div class="row-text"><div class="row-title">${esc(presetLabel(preset))}${preferred?.id === preset.id ? '<span class="badge">正在使用</span>' : ''}</div><div class="row-description">${esc(providerLabel(preset.provider))} · ${esc(displayNumber(preset.speed))} 倍速</div></div><div class="row-actions">${iconButton('edit', `编辑 ${presetLabel(preset)}`, 'preset.edit', preset.id)}${iconButton('trash', `删除 ${presetLabel(preset)}`, 'preset.delete', preset.id)}</div></div>`;
  const presetRows = managedPresets.map(presetRow).join('');
  const otherPresets = presets.filter(preset => preset.provider !== selectedProvider);
  const otherVoices = otherPresets.length ? `<details class="details other-voices"><summary>其他服务的音色 · ${otherPresets.length}</summary><div class="row-list">${otherPresets.map(presetRow).join('')}</div></details>` : '';
  const bindingRows = bindings.map(({ id, binding }) => `<div class="setting-row"><div class="row-text"><div class="row-title">${binding.user_name ? esc(binding.user_name) : binding.user_id ? `UID ${esc(binding.user_id)}` : `${esc(binding.legacy_user_name || '旧用户名')} · 待确认`}</div><div class="row-description">${binding.user_name && binding.user_id ? `UID ${esc(binding.user_id)} · ` : ''}${esc(presets.find(p => p.id === binding.preset_id)?.name || binding.preset_id)} · ${binding.enabled ? '启用' : '停用'}</div></div><div class="row-actions">${iconButton('edit', '编辑声音绑定', 'binding.edit', id)}${iconButton('trash', '删除声音绑定', 'binding.delete', id)}</div></div>`).join('');
  const power = `<form data-form="tts-toggle" class="voice-power"><label class="toggle-row"><span>弹幕播报</span><input type="checkbox" name="tts_enabled" aria-label="为新弹幕播报"${snapshot.preferences?.tts_enabled ?? true ? ' checked' : ''}></label>${autoStatus()}</form>`;
  return `<div class="voice-heading"><div>${heading('声音')}</div>${power}</div>${draftNotices()}${renderVoiceAudition(presets, preferred)}<section class="voice-library"><div class="settings-section-title"><div><h3>音色管理</h3><p class="section-caption">${esc(providerLabel(selectedProvider))} · ${managedPresets.length} 个音色</p></div></div><div class="row-list">${managedPresets.length ? presetRows : empty('还没有音色，点击「添加音色」开始设置。')}</div>${otherVoices}</section><section class="viewer-voices"><div class="settings-section-title"><h3>为观众指定声音${bindings.length ? `（${bindings.length}）` : ''}</h3>${button('添加观众', 'binding.new', { class: 'small', icon: 'plus', disabled: !presets.length })}</div><div class="row-list">${bindings.length ? bindingRows : empty('直接添加用户名，或点击弹幕头像指定声音。')}</div></section><div id="operation-result" class="form-result"></div>`;
}

function renderServiceCard(provider, preferred) {
  const connection = serviceConnection(provider);
  const status = providerStatus(provider, connection);
  const isPreferred = preferred?.provider === provider;
  return `<div class="service-card${isPreferred ? ' preferred' : ''}" data-service-provider="${esc(provider)}"><button type="button" class="service-card-select" data-action="service.prefer" data-id="${esc(provider)}" aria-pressed="${isPreferred}" aria-label="${esc(serviceChoiceLabel(provider, status, isPreferred))}" title="${esc(status.detail || status.label)}"><span class="service-light ${status.tone}" aria-hidden="true"></span><span class="service-card-copy"><strong class="service-card-name">${esc(providerLabel(provider))}</strong><small class="service-card-status" title="${esc(status.detail || status.label)}">${esc(status.label)}</small></span></button><button type="button" class="button small quiet service-card-configure" data-action="service.configure" data-id="${esc(provider)}" aria-label="设置 ${esc(providerLabel(provider))}" title="设置 ${esc(providerLabel(provider))}">${icon('settings')}</button></div>`;
}

function renderFishServiceEditor(connection, statusRow, back) {
  const connected = !!connection?.has_credential;
  const settings = snapshot.fish_audio_settings?.[connection?.id] || {};
  const voices = (snapshot.presets || []).filter(preset => preset.provider === 'fish_audio' && preset.connection_id === connection?.id);
  const preferred = snapshot.rules?.default_preset_id;
  const rows = voices.map(preset => `<div class="setting-row"><div class="row-text"><div class="row-title">${esc(presetLabel(preset))}${preferred === preset.id ? '<span class="badge">首选</span>' : ''}</div><div class="row-description">${esc(displayNumber(preset.speed))} 倍速</div></div><div class="row-actions">${preferred !== preset.id ? button('设为首选', 'preset.default', { id: preset.id, class: 'small' }) : ''}${button('试听', 'fish.audition', { id: preset.id, class: 'small quiet' })}${iconButton('edit', `编辑 ${presetLabel(preset)}`, 'preset.edit', preset.id)}</div></div>`).join('');
  const credentialForm = `<form data-form="service-fish" data-id="${esc(connection?.id || '')}">${field('credential', 'API Key', '', 'type="password" autocomplete="new-password" required placeholder="在这里粘贴 API Key"', connected ? '验证新密钥后才会替换。' : '验证账号后加密保存在本机。')}<div class="form-footer">${saveButton(connected ? '验证并更换密钥' : '验证并连接')}</div></form>`;
  const account = `<section class="settings-card"><h3>账号连接</h3><div class="actions external-actions">${button('获取 API Key', 'fish.open_keys', { class: 'small', icon: 'external' })}${button('浏览音色广场', 'fish.open_discovery', { class: 'small', icon: 'external' })}</div>${connected ? `<details class="details"><summary>更换 API Key</summary>${credentialForm}</details>` : credentialForm}</section>`;
  if (!connected) return `${heading('Fish Audio')}${statusRow}${account}${back}`;
  const options = `<form data-form="fish-settings" data-connection-id="${esc(connection.id)}" class="form-section"><h3>生成设置</h3>${select('model', '生成模型', option('s2.1-pro-free', 'S2.1 Pro Free（默认）', settings.model || 's2.1-pro-free') + option('s2.1-pro', 'S2.1 Pro', settings.model) + option('s2-pro', 'S2 Pro', settings.model) + option('s1', 'S1', settings.model))}<div class="field-grid">${select('latency', '延迟模式', option('normal', '普通', settings.latency || 'normal') + option('balanced', '平衡', settings.latency) + option('low', '低延迟', settings.latency))}${field('volume_db', '合成音量（dB）', settings.volume_db ?? 0, 'type="number" min="-20" max="20" step="0.5" required')}${field('temperature', '温度', settings.temperature ?? .7, 'type="number" min="0" max="1" step="0.05" required')}${field('top_p', 'Top P', settings.top_p ?? .7, 'type="number" min="0" max="1" step="0.05" required')}</div><div class="form-footer">${autoStatus()}</div></form>`;
  return `${heading('Fish Audio')}${statusRow}${account}<div class="settings-section-title"><h3>音色收藏</h3><div class="actions">${button('添加音色', 'service.add_preset', { id: 'fish_audio', class: 'small', icon: 'plus' })}${button('恢复内置五音色', 'fish.restore_builtin', { class: 'small quiet' })}</div></div><div class="row-list">${rows || empty('还没有 Fish 音色。')}</div>${options}${back}`;
}

function renderServiceEditor(provider) {
  const connection = serviceConnection(provider);
  const status = providerStatus(provider, connection);
  const state = snapshot.local_services?.[provider] || {};
  const statusRow = `<div class="service-editor-state" data-service-provider="${esc(provider)}"><div class="service-editor-status"><span class="service-light ${status.tone}" aria-hidden="true"></span><span class="service-status-label" title="${esc(status.detail || status.label)}">${esc(status.label)}</span></div><p class="quiet-note${state.state === 'failed' ? ' status-error' : ''}" data-service-message${state.state === 'failed' && state.message ? '' : ' hidden'}>${esc(state.message || '')}</p></div>`;
  const back = '';
  if (provider === 'doubao') return `${heading('豆包')}${statusRow}${button(connection?.has_credential ? '重新扫码' : '扫码连接', 'doubao.begin', { id: connection?.id || '', class: 'primary small', icon: 'qr' })}${back}`;
  if (provider === 'fish_audio') return renderFishServiceEditor(connection, statusRow, back);
  const directory = state.directory || '';
  const directoryLabel = provider === 'dots' ? 'dots.tts 目录' : 'GPT-SoVITS 目录';
  return `${heading(providerLabel(provider), '设为默认语音服务后，随本应用启动。')}${statusRow}<form data-form="service-local" data-provider="${esc(provider)}">${pathField('directory', directoryLabel, directory, 'service.pick_directory', '点击选择安装目录')}${autoStatus()}</form><div class="actions">${button('启动服务', 'service.start', { id: provider, class: 'small primary', disabled: !connection || !state.directory || !!state.owned })}${button('停止服务', 'service.stop', { id: provider, class: 'small quiet', disabled: !state.owned })}${button('检查连接', 'service.check', { id: provider, class: 'small quiet', disabled: !connection })}${connection ? button('添加音色', 'service.add_preset', { id: provider, class: 'small quiet' }) : ''}</div>`;
}

function renderPresetCore(id) {
  const first = snapshot.connections.find(item => item.id === editor?.connectionId) || snapshot.connections[0];
  const preset = snapshot.presets.find(item => item.id === id) || { id: '', name: '', connection_id: first?.id || '', provider: first?.settings.provider, voice_id: '', speed: 1, volume: 1, sovits: null };
  const voices = snapshot.doubao_voices || [];
  const sovits = preset.sovits || {};
  const provider = snapshot.connections.find(item => item.id === preset.connection_id)?.settings.provider || preset.provider;
  const voiceLabel = provider === 'gpt_sovits' ? '角色名称' : '音色';
  const hasVoice = voices.some(voice => (voice.id || voice.voice_id || voice.value) === preset.voice_id);
  const voicePicker = provider === 'doubao'
    ? select('voice_id', '豆包音色', option('', '请选择音色', preset.voice_id) + (!hasVoice && preset.voice_id ? option(preset.voice_id, '已保存的音色', preset.voice_id) : '') + voices.map(voice => option(voice.id || voice.voice_id || voice.value, voice.name || voice.label || '未命名音色', preset.voice_id)).join(''))
    : field('voice_id', voiceLabel, preset.voice_id, 'required autocomplete="off"', '选择成对模型后会自动填入角色名称。');
  return `${heading(id ? '编辑音色' : '添加音色')}<form data-form="preset" data-id="${esc(id || '')}"><input type="hidden" name="connection_id" value="${esc(preset.connection_id)}"><p class="quiet-note">语音服务：${esc(providerLabel(provider))}</p>${voicePicker}<details class="details"><summary>语速与其他选项</summary>${field('name', '自定义名称（选填）', provider === 'doubao' && (preset.name === voiceName(preset.voice_id) || preset.name.includes(preset.voice_id)) ? '' : preset.name, 'maxlength="100" placeholder="默认使用音色名称"')}<div class="field-grid">${field('speed', '语速', preset.speed, 'type="number" min="0.5" max="2" step="0.05" required')}${field('volume', '音色音量', preset.volume, 'type="number" min="0" max="2" step="0.05" required')}</div><div id="sovits-fields"${provider === 'gpt_sovits' ? '' : ' hidden'}><details class="details"><summary>GPT-SoVITS 参数</summary>${select('model_selection', '模型选择', option('global_resident', '使用服务当前加载的模型', sovits.model_selection || 'global_resident') + option('per_request_atomic', '为每次请求指定模型', sovits.model_selection))}${field('gpt_weights_path', 'GPT 模型路径', sovits.gpt_weights_path || '')}${field('sovits_weights_path', 'SoVITS 模型路径', sovits.sovits_weights_path || '')}${field('reference_text', '参考文本', sovits.reference_text || '')}${check('reference_text_free', '无参考文本模式', sovits.reference_text_free ?? true)}<div class="field-grid">${field('reference_language', '参考语言', sovits.reference_language || 'all_zh')}${field('text_language', '合成语言', sovits.text_language || 'all_zh')}${field('split', '分句方法', sovits.split || 'cut0')}${field('fragment_interval_secs', '片段间隔（秒）', sovits.fragment_interval_secs ?? .3, 'type="number" min="0" max="5" step="0.05"')}${field('top_k', 'Top K', sovits.top_k ?? 5, 'type="number" min="1" max="100"')}${field('top_p', 'Top P', sovits.top_p ?? 1, 'type="number" min="0" max="1" step="0.05"')}${field('temperature', '温度', sovits.temperature ?? 1, 'type="number" min="0" max="2" step="0.05"')}${field('sample_steps', '采样步数', sovits.sample_steps ?? 8, 'type="number" min="1" max="128"')}</div>${check('super_sampling', '超采样', sovits.super_sampling || false)}</details></div></details><div class="form-footer">${autoStatus()}${button('返回', 'editor.cancel', { class: 'quiet' })}</div></form>`;
}

function selectedModelPair(preset) {
  const pairs = modelScan.pairs || [];
  if (Number.isInteger(editor?.modelIndex) && pairs[editor.modelIndex]) return { pair: pairs[editor.modelIndex], index: editor.modelIndex };
  const gpt = preset.sovits?.gpt_weights_path;
  const sovits = preset.sovits?.sovits_weights_path;
  const index = pairs.findIndex(pair => String(pair.gpt_path).toLowerCase() === String(gpt).toLowerCase() && String(pair.sovits_path).toLowerCase() === String(sovits).toLowerCase());
  if (index >= 0) return { pair: pairs[index], index };
  if (!preset.id && pairs.length) return { pair: pairs[0], index: 0 };
  return { pair: null, index: -1 };
}

function modelPairPicker(preset) {
  const { index } = selectedModelPair(preset);
  const options = (modelScan.pairs || []).map((pair, number) => option(number, `${pair.name} · ${pair.version}`, index)).join('');
  const retained = preset.sovits?.gpt_weights_path && index < 0 ? option('existing', '当前模型（安装目录中未找到）', 'existing') : '';
  const placeholder = options || retained ? '' : option('', '尚未发现成对模型', '');
  return `<div class="model-pair-picker">${select('model_pair', '角色模型', placeholder + retained + options, '从安装目录自动配对 GPT 与 SoVITS 权重。')}${button('刷新模型', 'models.refresh', { class: 'small quiet', icon: 'refresh' })}</div>${modelScan.error ? `<p class="quiet-note status-error">${esc(modelScan.error)}</p>` : ''}${modelScan.issues?.length ? `<p class="quiet-note">另有 ${modelScan.issues.length} 个文件未配对或存在歧义。</p>` : ''}`;
}

function referenceRole(provider, preset, pair) {
  if (provider === 'dots') return preset.voice_id ? { kind: 'dots', role: preset.voice_id } : null;
  if (provider !== 'gpt_sovits') return null;
  const gpt_weights_path = pair?.gpt_path || preset.sovits?.gpt_weights_path;
  const sovits_weights_path = pair?.sovits_path || preset.sovits?.sovits_weights_path;
  return gpt_weights_path && sovits_weights_path ? { kind: 'gpt_sovits', gpt_weights_path, sovits_weights_path } : null;
}

function currentReference(role) {
  if (!role) return null;
  const matches = candidate => candidate?.kind === role.kind && (role.kind === 'dots'
    ? candidate.role === role.role
    : String(candidate.gpt_weights_path).toLowerCase() === String(role.gpt_weights_path).toLowerCase() && String(candidate.sovits_weights_path).toLowerCase() === String(role.sovits_weights_path).toLowerCase());
  return referenceProfiles.find(entry => matches(entry.profile?.role)) || null;
}

function languageOptions(selected) {
  return [['auto', '自动识别'], ['all_zh', '中文'], ['en', '英语'], ['all_ja', '日语'], ['all_ko', '韩语'], ['all_yue', '粤语']].map(([code, label]) => option(code, label, selected)).join('');
}

function renderReferenceEditor(provider, preset, pair) {
  const role = referenceRole(provider, preset, pair);
  const saved = currentReference(role);
  const profile = saved?.profile || {};
  const audioLabel = saved?.profile?.audio_path ? '已记住音频原路径；移动或删除原文件后需要重新选择。' : '直接使用原文件，不复制音频。';
  const gptFields = provider === 'gpt_sovits' ? `<div class="field-grid">${select('reference_language', '参考语言', languageOptions(profile.reference_language || 'auto'))}${select('text_language', '文本语言', languageOptions(profile.text_language || 'auto'))}</div>${check('text_free', '无参考文本模式', profile.text_free || false)}` : '';
  return `<section id="reference-editor" class="reference-editor">${heading('参考音频', '选择一段角色录音，并填写录音中的台词。')}<p class="quiet-note">${esc(audioLabel)}</p><form data-form="reference">${pathField('audio_path', '参考音频', profile.audio_path || '', 'reference.pick_audio', '点击选择参考音频', '支持 WAV、MP3、FLAC、OGG 或 M4A')}${textArea('reference_text', '参考文本', profile.reference_text ?? preset.sovits?.reference_text ?? '', 'maxlength="8192"', '填写参考音频中实际说出的文字。')}${gptFields}<div class="form-footer">${saveButton('保存参考设置')}</div></form>${role ? '' : '<p class="quiet-note">先填写角色名称或选择角色模型。</p>'}</section>`;
}

function renderDotsPresetEditor(id, preset, connection) {
  const role = preset.voice_id || (editor.dotsVoiceId ||= `dots-${crypto.randomUUID()}`);
  const saved = currentReference({ kind: 'dots', role });
  const profile = saved?.profile || {};
  const legacy = !!id && !profile.audio_path;
  const hint = legacy
    ? '此旧音色尚未记录原文件路径，仍可沿用服务内文件名；选择原文件后会改用新路径。'
    : '使用原文件，不复制音频。原文件移动或删除后需重新选择。';
  return `${heading(id ? '编辑 dots 音色' : '添加 dots 音色', '选择一段录音作为参考声音。')}<form data-form="dots-preset" data-id="${esc(id || '')}" data-connection-id="${esc(connection.id)}">${field('name', '音色名称', preset.name || '', 'required maxlength="100" placeholder="例如：日常播报"')}${pathField('audio_path', '参考音频', profile.audio_path || '', 'reference.pick_audio', '点击选择参考音频', hint)}${textArea('reference_text', '参考文本（可选）', profile.reference_text || '', 'maxlength="8192"', '可填写参考音频中说出的文字。')}<div class="field-grid">${field('speed', '语速', preset.speed ?? 1, 'type="number" min="0.5" max="2" step="0.05" required')}${field('volume', '音色音量', preset.volume ?? 1, 'type="number" min="0" max="2" step="0.05" required')}</div><div class="form-footer">${saveButton('保存音色')}${button('返回', 'editor.cancel', { class: 'quiet' })}</div></form>`;
}

function renderFishPresetEditor(id, preset, connection) {
  const back = button('返回', 'editor.cancel', { class: 'quiet' });
  if (!id) return `${heading('收藏 Fish 音色', '粘贴官网音色页面链接或 32 位音色 ID，填写名称后保存。')}<form data-form="fish-voice" data-connection-id="${esc(connection.id)}">${field('id_or_url', '音色页面链接或 ID', '', 'required autocomplete="off" placeholder="https://fish.audio/m/… 或 32 位 ID"')}<div class="actions">${button('查找官方名称', 'fish.voice.lookup', { class: 'small quiet' })}</div><p class="quiet-note" data-fish-lookup-result role="status" hidden></p>${field('name', '收藏名称', '', 'maxlength="100"', '可自行命名；留空会先读取官方名称。')}<div class="form-footer">${saveButton('收藏音色')}${back}</div></form>`;
  return `${heading('编辑 Fish 音色')}<form data-form="fish-preset" data-id="${esc(id)}" data-connection-id="${esc(connection.id)}">${field('name', '音色名称', preset.name, 'required maxlength="100"')}<div class="field-grid">${field('speed', '语速', preset.speed, 'type="number" min="0.5" max="2" step="0.05" required')}${field('volume', '音色音量', preset.volume, 'type="number" min="0" max="2" step="0.05" required')}</div><div class="form-footer">${autoStatus()}${button('试听此音色', 'fish.audition', { id, class: 'quiet' })}${back}</div></form>`;
}

function renderPresetEditor(id) {
  if (!id && !editor?.connectionId) {
    return `${heading('添加音色', '选择语音服务。')}<div class="row-list">${snapshot.connections.map(connection => `<div class="setting-row"><div class="row-text"><div class="row-title">${esc(providerLabel(connection.settings.provider))}</div><div class="row-description">${esc(connection.name || providerLabel(connection.settings.provider))}</div></div><div class="row-actions">${button('选择', 'preset.choose_service', { id: connection.id, class: 'small' })}</div></div>`).join('')}</div><div class="actions">${button('返回', 'editor.cancel', { class: 'quiet' })}</div>`;
  }
  const first = snapshot.connections.find(item => item.id === editor?.connectionId) || snapshot.connections[0];
  const preset = snapshot.presets.find(item => item.id === id) || { id: '', connection_id: first?.id, provider: first?.settings.provider, voice_id: '', sovits: null };
  const connection = snapshot.connections.find(item => item.id === preset.connection_id);
  const provider = connection?.settings.provider || preset.provider;
  if (provider === 'dots' && connection) return renderDotsPresetEditor(id, preset, connection);
  if (provider === 'fish_audio' && connection) return renderFishPresetEditor(id, preset, connection);
  const selected = selectedModelPair(preset);
  let html = renderPresetCore(id);
  if (provider === 'gpt_sovits') html = html.replace('<details class="details"><summary>语速与其他选项', `${modelPairPicker(preset)}<details class="details"><summary>语速与其他选项`);
  if (provider === 'gpt_sovits') html += renderReferenceEditor(provider, preset, selected.pair);
  return html;
}

function hideLegacyVoiceFields() {
  const form = settingsDialog.querySelector('[data-form="preset"]');
  if (!form || !form.elements.model_pair) return;
  for (const name of ['model_selection', 'gpt_weights_path', 'sovits_weights_path', 'reference_text', 'reference_language', 'text_language']) {
    const container = form.elements[name]?.closest('.field');
    if (container) container.hidden = true;
  }
  const textFree = form.elements.reference_text_free?.closest('.check');
  if (textFree) textFree.hidden = true;
}

function applyModelPairToForm(save = true) {
  const form = settingsDialog.querySelector('[data-form="preset"]');
  const picker = form?.elements.model_pair;
  const pair = (modelScan.pairs || [])[Number(picker?.value)];
  if (!picker || !pair) return;
  form.elements.gpt_weights_path.value = pair.gpt_path;
  form.elements.sovits_weights_path.value = pair.sovits_path;
  form.elements.model_selection.value = 'per_request_atomic';
  if (save || !form.elements.voice_id.value.trim()) form.elements.voice_id.value = pair.name;
  if (save) scheduleAutosave(form, true);
  const preset = { voice_id: form.elements.voice_id.value, sovits: { gpt_weights_path: pair.gpt_path, sovits_weights_path: pair.sovits_path } };
  const section = settingsDialog.querySelector('#reference-editor');
  if (section) section.outerHTML = renderReferenceEditor('gpt_sovits', preset, pair);
}

async function loadVoiceEditorData(connectionId) {
  modelScan = { pairs: [], issues: [] };
  referenceProfiles = [];
  const connection = snapshot.connections.find(item => item.id === connectionId);
  if (!connection || !['dots', 'gpt_sovits'].includes(connection.settings.provider)) return;
  const profiles = await command('references.list', { connection_id: connectionId }, { quiet: true });
  referenceProfiles = Array.isArray(profiles.result) ? profiles.result : [];
  if (connection.settings.provider === 'gpt_sovits') {
    const directory = snapshot.local_services?.gpt_sovits?.directory;
    if (directory) {
      try {
        const scan = await command('models.scan', { path: directory }, { quiet: true, silent: true });
        modelScan = scan.result || modelScan;
      } catch (error) { modelScan.error = String(error?.message || error); }
    }
  }
}

function renderBindingEditor(id) {
  const record = snapshot.bindings.find(item => item.id === id);
  const binding = record?.binding || { user_id: editor?.userId || '', user_name: editor?.userName || '', preset_id: snapshot.presets[0]?.id, enabled: true };
  return `${heading(id ? '编辑观众声音' : '指定观众声音', '填写观众用户名即可指定声音；也可以填写 UID 精确识别。')}<form data-form="binding" data-id="${esc(id || '')}">${record?.binding.legacy_user_name ? `<p class="notice">旧配置用户名：${esc(record.binding.legacy_user_name)}。请确认后手动填写用户名或 UID。</p>` : ''}${field('user_name', '观众用户名', binding.user_name || '', 'maxlength="100" placeholder="输入观众当前用户名"')}${field('user_id', '观众 UID（选填）', binding.user_id || '', 'inputmode="numeric" pattern="[1-9][0-9]*" placeholder="有 UID 时建议填写"')}${select('preset_id', '声音预设', snapshot.presets.map(preset => option(preset.id, presetLabel(preset), binding.preset_id)).join(''))}<p class="quiet-note">按用户名精确匹配，同名账号会共用声音；填写 UID 时优先按 UID 匹配。</p>${check('enabled', '启用此绑定', binding.enabled)}<div class="form-footer">${autoStatus()}${button('返回', 'editor.cancel', { class: 'quiet' })}</div></form>`;
}

function renderAliasEditor() {
  const name = editor?.userName || '';
  const existing = snapshot.rules.user_words.find(row => row.from === name);
  return `${heading('添加播报别名', '这位观众的用户名会在播报时替换为别名。')}<form data-form="alias">${field('from', '原用户名', name, 'readonly required')}${field('to', '播报别名', existing?.to || '', 'required maxlength="100" placeholder="输入播报时使用的名字"')}<div class="form-footer">${saveButton('保存别名')}${button('返回', 'editor.cancel', { class: 'quiet' })}</div></form>`;
}

function dictionaryRows(type, rows) {
  return `<div class="dict-header"><span>${type === 'sounds' ? '触发词' : '原文字'}</span><span>${type === 'sounds' ? '音效素材' : '替换为'}</span></div><div data-dictionary="${type}">${rows.map(row => dictionaryRow(type, row)).join('')}</div>${button('添加一条', `dictionary.add.${type}`, { class: 'small quiet', icon: 'plus' })}`;
}

function dictionaryRow(type, row = {}) {
  return `<div class="dict-row"><input data-key="from" value="${esc(row.from ?? row.trigger ?? '')}" aria-label="${type === 'sounds' ? '触发词' : '原文字'}" required>${type === 'sounds' ? `<select data-key="to" aria-label="音效素材" required><option value="">选择素材</option>${snapshot.assets.map(asset => option(asset.id, asset.name, row.asset_id)).join('')}</select>` : `<input data-key="to" value="${esc(row.to || '')}" aria-label="替换为">`}${iconButton('close', '移除此条', 'dictionary.remove')}</div>`;
}

function previewEventForm() {
  return `<form data-form="preview"><div class="field-grid">${select('kind', '事件类型', option('danmaku', '弹幕', 'danmaku') + option('gift', '礼物') + option('super_chat', '醒目留言') + option('guard', '大航海'))}${field('user_name', '观众名字', '', 'required placeholder="输入用于预览的名字"')}${field('user_id', '观众 UID（选填）', '', 'inputmode="numeric"')}${field('price_yuan', '金额（元）', 0, 'type="number" min="0" step="0.1"')}${field('gift_name', '礼物名称', '')}${field('quantity', '礼物数量', 1, 'type="number" min="1"')}${field('guard_name', '大航海称号', '舰长')}${select('coin_type', '礼物类型', option('gold', '付费礼物', 'gold') + option('silver', '免费礼物'))}</div>${textArea('message', '预览消息', '', 'placeholder="输入一段文字"')}<div class="form-footer"><button class="button" type="submit">预览处理结果</button></div><p class="quiet-note">只预览处理结果，不请求语音服务。实际试听在“声音”页面。</p></form><div id="preview-result" class="form-result" aria-live="polite"></div>`;
}

function renderRulesSettings() {
  if (editor?.type === 'alias') return renderAliasEditor();
  const rules = snapshot.rules;
  const events = rules.events;
  return `${heading('播报规则')}<form data-form="rules"><div class="form-section"><h3>播报内容</h3>${toggle('danmaku_on', '弹幕', events.danmaku_on)}${toggle('gift_on', '礼物', events.gift_on)}${toggle('free_gift_on', '免费礼物', events.free_gift_on)}${toggle('super_chat_on', '醒目留言', events.super_chat_on)}${toggle('guard_on', '大航海', events.guard_on)}<div class="field-grid">${field('gift_threshold_yuan', '礼物最低金额（元）', events.gift_threshold_yuan, 'type="number" min="0" step="0.1" required')}${field('super_chat_threshold_yuan', '醒目留言最低金额（元）', events.super_chat_threshold_yuan, 'type="number" min="0" step="0.1" required')}</div></div><div class="form-section"><h3>播报模板</h3>${textArea('template_danmaku', '弹幕', rules.templates.danmaku, 'required')}${textArea('template_gift', '礼物', rules.templates.gift, 'required')}${textArea('template_super_chat', '醒目留言', rules.templates.super_chat, 'required')}${textArea('template_guard', '大航海', rules.templates.guard, 'required')}<p class="quiet-note">可用字段：{user_name}、{message}、{gift_name}、{gift_num}、{guard_name}、{price}。</p></div><div class="form-section"><h3>用户名词典</h3>${dictionaryRows('user_words', rules.user_words)}</div><div class="form-section"><h3>正文词典</h3>${dictionaryRows('message_words', rules.message_words)}</div><div class="form-footer">${autoStatus()}</div></form><details class="details"><summary>预览规则</summary>${previewEventForm()}</details>`;
}

function renderAssetsSettings() {
  const asset = editor?.type === 'asset' ? snapshot.assets.find(item => item.id === editor.id) : null;
  return `${heading('音效素材', '导入音频，并在这里设置触发音效的关键词。')}<form data-form="asset" data-id="${esc(asset?.id || '')}" class="editor"><h3>${asset ? `替换「${esc(asset.name)}」` : '导入音频'}</h3>${asset ? '' : field('name', '素材名称', '', 'required')}${field('path', '音频文件完整路径', '', 'required placeholder="例如：E:\\Audio\\hello.wav"', '支持 WAV、MP3 等常用音频；文件会复制到当前应用的数据目录。')}<div class="form-footer">${saveButton(asset ? '替换音频' : '导入素材')}${asset ? button('取消替换', 'editor.cancel', { class: 'quiet' }) : ''}</div></form><div class="row-list">${snapshot.assets.length ? snapshot.assets.map(item => `<div class="setting-row"><div class="row-text"><div class="row-title">${esc(item.name)}</div><div class="row-description">${Math.round(item.bytes / 1024)} KB · ${esc(item.relative_path)}<br>${(snapshot.rules.sounds || []).filter(rule => rule.asset_id === item.id).length} 条关键词规则引用</div></div><div class="row-actions">${button('替换', 'asset.replace', { id: item.id, class: 'small' })}${iconButton('trash', `删除 ${item.name}`, 'asset.delete', item.id)}</div></div>`).join('') : empty('还没有音效素材。')}</div><div class="form-section"><h3>关键词音效</h3><form data-form="sound-words">${dictionaryRows('sounds', snapshot.rules.sounds || [])}<p class="quiet-note">弹幕包含触发词时会播放对应音效。</p>${autoStatus()}</form></div>`;
}

function renderAudioSettings() {
  const prefs = snapshot.preferences;
  return `${heading('音频输出')}<form data-form="audio">${select('output', '输出设备', option('', '跟随系统默认设备', deviceValue(prefs.output)) + (snapshot.devices || []).map(device => option(device.name, `${device.name}${device.is_default ? '（系统默认）' : ''}`, deviceValue(prefs.output))).join(''))}<div class="actions">${button('刷新设备', 'devices.refresh', { class: 'small quiet', icon: 'refresh' })}${button('重新连接设备', 'audio.reconnect', { class: 'small quiet', icon: 'audio' })}</div><p class="quiet-note">切换或重新连接输出设备会停止当前播放和待播队列。</p><div class="form-footer">${autoStatus()}</div></form>`;
}

function renderAppearanceSettings() {
  const prefs = snapshot.preferences;
  const selectedScale = Math.min(1.4, Math.max(.8, Math.round((Number(prefs.scale) || 1) * 10) / 10));
  return `${heading('外观与启动')}<form data-form="appearance">${select('appearance', '主题', option('light', '浅色', prefs.appearance) + option('dark', '深色', prefs.appearance) + option('system', '跟随系统', prefs.appearance))}${select('scale', '界面缩放', [.8, .9, 1, 1.1, 1.2, 1.3, 1.4].map(scale => option(scale, `${Math.round(scale * 100)}%`, selectedScale)).join(''))}${autoStatus()}</form><form data-form="startup" class="form-section">${toggle('enabled', '开机启动', snapshot.startup_enabled, '登录 Windows 后打开超绝可爱弹幕姬。')}${autoStatus()}</form><div class="form-section"><h3>初次设置</h3><p class="quiet-note">重新走一遍扫码、直播间和豆包设置。已有声音和规则仍会保留。</p>${button('重新打开引导', 'onboarding.reset', { class: 'small' })}</div>`;
}

function renderDataSettings() {
  return `${heading('数据与迁移')}<dl class="key-value"><dt>当前数据目录</dt><dd>${esc(snapshot.data_dir)}</dd></dl><form data-form="export" class="form-section"><h3>导出配置</h3>${field('path', '保存为', '', 'required placeholder="例如：E:\\Backups\\danmakuvoice.json"', '保存到一个新文件；导出不包含登录凭据、音效文件和聊天记录。')}${saveButton('导出无凭据配置')}</form><form data-form="migration-preview" class="form-section"><h3>从旧版导入</h3>${field('path', '旧 config.json 的完整路径', '', 'required', '先读取预览，再由你选择要导入的内容。不会自动导入账号凭据。')}${saveButton('读取导入预览')}</form><div id="migration-preview">${migrationPreview ? renderMigrationPreview() : ''}</div><div id="operation-result" class="form-result"></div><div class="danger-zone"><h3>清除应用数据</h3><p class="quiet-note">删除本机保存的账号、语音服务凭据、设置、音效和备份，然后重新开始设置。</p>${button('清除应用数据', 'data.clear', { class: 'danger small' })}</div>`;
}

function renderMigrationPreview() {
  const preview = migrationPreview;
  return `<form data-form="migration-apply" class="editor"><h3>选择要导入的内容</h3><p class="quiet-note">直播间：${esc(preview.room_id || '未设置')}；服务 ${preview.provider_settings?.length || 0} 个；待确认用户绑定 ${preview.voice_bindings?.length || 0} 条；音效 ${preview.sounds?.length || 0} 个。</p>${check('import_rules', '播报规则和词典')}${check('import_live_settings', '直播间设置')}${check('import_connections', '服务连接与声音预设')}${check('import_pending_bindings', '待确认 UID 的用户声音绑定')}<details class="details"><summary>查看规则与服务内容</summary><pre class="code-output">${esc(JSON.stringify({ rules: preview.rules, provider_settings: preview.provider_settings, model_references: preview.model_references, gift_merge: preview.gift_merge }, null, 2))}</pre></details>${preview.sounds?.length ? `<details class="details" open><summary>选择要复制的音效文件</summary><div class="migration-sounds">${preview.sounds.map(sound => { const ready = sound.path_state === 'present' && Boolean(sound.source_sha256) && Number.isSafeInteger(sound.source_bytes); return `<label class="check"><input type="checkbox" name="selected_sound_ids" value="${esc(sound.preview_asset_id)}"${ready ? '' : ' disabled'}><span>${esc(sound.trigger)}<small>${esc(sound.source_path)} · ${ready ? '可导入' : '文件或预览校验不可用'}</small></span></label>`; }).join('')}</div></details>` : ''}<details class="details"><summary>替换已有设置</summary>${check('replace_existing_rules', '允许覆盖当前播报规则')}${check('replace_existing_live_settings', '允许覆盖当前直播间设置')}</details>${preview.warnings?.length ? `<details class="details" open><summary>需要注意的内容（${preview.warnings.length}）</summary><div class="code-output">${preview.warnings.map(warning => `${esc(warning.path)}：${esc(warning.message)}`).join('\n')}</div></details>` : ''}<p class="quiet-note">确认导入前会自动备份当前数据库。名字绑定必须补充 UID 才会生效。</p><div class="form-footer">${saveButton('确认所选内容')}${button('取消导入', 'migration.cancel', { class: 'quiet' })}</div></form>`;
}

async function confirmAction(title, message, label = '确认', danger = true) {
  if (confirmationDialog.open) return false;
  return new Promise(resolve => {
    confirmationDialog.innerHTML = `<h2 id="confirmation-title">${esc(title)}</h2><p>${esc(message)}</p><form method="dialog"><div class="actions"><button class="button quiet" value="cancel" autofocus>取消</button><button class="button ${danger ? 'danger' : 'primary'}" value="confirm">${esc(label)}</button></div></form>`;
    confirmationDialog.returnValue = '';
    confirmationDialog.addEventListener('close', () => resolve(confirmationDialog.returnValue === 'confirm'), { once: true });
    confirmationDialog.showModal();
  });
}

async function connectFishCredential(credential, form = null) {
  const existing = serviceConnection('fish_audio');
  const next = await command('fish.connect', { credential, connection_id: existing?.id }, { success: 'Fish Audio 账号已验证并连接' });
  if (form) form.elements.credential.value = '';
  if (editor?.makePreferred) {
    const connection = serviceConnection('fish_audio');
    const voices = snapshot.presets.filter(preset => preset.provider === 'fish_audio' && preset.connection_id === connection?.id);
    const preferred = voices.find(preset => preset.voice_id === fishDefaultVoiceId) || voices[0];
    if (preferred) await command('presets.default', { id: preferred.id });
    editor.makePreferred = false;
  }
  return next;
}

async function allowLeaveSettings() {
  if (!await flushAutosaves()) return false;
  const dots = settingsDialog.querySelector('[data-form="dots-preset"][data-dirty]');
  if (dots) {
    try { await saveDotsPresetForm(dots); }
    catch (error) { showError(error); return false; }
  }
  const reference = settingsDialog.querySelector('[data-form="reference"][data-dirty]');
  if (reference) {
    try { await saveReferenceForm(reference); }
    catch (error) { showError(error); return false; }
  }
  const pending = [...settingsDialog.querySelectorAll('[data-form][data-dirty]')]
    .filter(form => manualSaveFormTypes.has(form.dataset.form));
  if (!pending.length) return true;
  if (!await confirmAction('放弃未完成的填写？', '离开后，本页尚未提交的内容会丢失。', '放弃修改')) return false;
  for (const form of pending) delete form.dataset.dirty;
  return true;
}

async function closeSettings() {
  if (!await allowLeaveSettings()) return;
  if (!await settleVoiceAuditionChoice()) return;
  closeSelect();
  if (editor?.type === 'qr') await cancelQr();
  if (editor?.type === 'qr') editor = null;
  tabEditors.set(settingsTab, editor);
  settingsDirty = false; settingsDialog.close();
  if (step === 'main') updateLive();
  if (step === 'login' && !qrProvider) void startQr('bilibili');
  if (step === 'doubaoQr' && !qrProvider) void startQr('doubao');
}

async function openSettings(tab) {
  if (qrProvider) await cancelQr();
  if (tab && tab !== settingsTab) { tabEditors.set(settingsTab, editor); settingsTab = tab; editor = tabEditors.get(tab) || null; renderSettings(); }
  else if (!settingsDialog.open || !settingsDialog.querySelector('.settings-shell')) renderSettings();
  settingsDialog.showModal();
}

async function openViewerSettings(tab, nextEditor) {
  if (qrProvider) await cancelQr();
  tabEditors.set(settingsTab, editor);
  settingsTab = tab;
  editor = nextEditor;
  renderSettings();
  settingsDialog.showModal();
}

function renderResult(target, result) {
  const node = document.querySelector(target);
  if (!node) return;
  const pre = document.createElement('pre'); pre.className = 'code-output'; pre.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2); node.replaceChildren(pre);
}

function setPickedPath(input, path) {
  input.value = path;
  const field = input.closest('.path-field');
  const label = field?.querySelector('[data-path-value]');
  if (label) { label.textContent = path; label.classList.remove('placeholder'); field.querySelector('.path-picker').title = path; }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function saveLocalDirectory(provider, directory) {
  const existing = serviceConnection(provider);
  if (!existing) await command('connections.save', { connection: { id: '', name: providerLabel(provider), settings: { provider, endpoint: providerEndpoint[provider], timeout_secs: Math.min(providerTimeout[provider], 30) }, has_credential: false } }, { quiet: true, silent: true });
  const next = await command('local_services.save', { provider, directory }, { quiet: true, silent: true });
  updateServiceIndicators();
  return next;
}

async function handleAction(action, id, target) {
  if (action === 'audio.mute') {
    await volumeSave.flush();
    const volume = snapshot.preferences?.master_volume ?? 1;
    const unmute = !!snapshot.preferences?.muted || volume === 0;
    return command('preferences.save', { preferences: {
      muted: !unmute, ...(unmute && volume === 0 ? { master_volume: 1 } : {}),
    } }, { quiet: true, silent: true });
  }
  if (action === 'external.open') return command('external.open', { page: id }, { quiet: true });
  if (action === 'update.check') {
    if (updateBusy) return;
    updateBusy = true; updateError = ''; updateInfo = null;
    renderSettings();
    try { updateInfo = await invoke('check_update'); }
    catch (error) { updateError = String(error?.message || error); }
    finally { updateBusy = false; if (settingsDialog.open && settingsTab === 'about') renderSettings(); }
    return;
  }
  if (settingsDialog.open && !['settings.close', 'settings.tab', 'editor.cancel', 'autosave.retry', 'autosave.discard', 'draft.discard'].includes(action) && !action.startsWith('dictionary.')) {
    const replacesSettings = ['room.anonymous', 'bili.use_account', 'bili.logout', 'bili.begin', 'doubao.begin', 'fish.restore_builtin', 'service.configure', 'service.prefer', 'service.add_preset', 'voice-audition.add', 'preset.choose_service', 'preset.default', 'preset.clear-default', 'asset.replace', 'models.refresh', 'onboarding.reset', 'migration.cancel'].includes(action)
      || /^(preset|binding)\.(new|edit|delete)$/.test(action) || action === 'asset.delete';
    if (!await (replacesSettings ? allowLeaveSettings() : flushAutosaves())) return;
  }
  if (['tts.select', 'service.prefer', 'preset.default', 'preset.clear-default', 'voice-audition.add', 'fish.audition', 'settings.tab'].includes(action)) await settleVoiceAuditionChoice();
  if (action === 'tts.open') {
    const menu = document.querySelector('#tts-menu');
    if (!menu.hidden) { menu.hidden = true; target.setAttribute('aria-expanded', 'false'); return; }
    const preferred = snapshot.presets.find(item => item.id === snapshot.rules?.default_preset_id);
    menu.innerHTML = `${serviceProviders.map(provider => {
      const status = providerStatus(provider, serviceConnection(provider));
      const preset = rememberedPreset(provider);
      return `<button type="button" class="tts-menu-item" role="menuitem" data-action="tts.select" data-id="${esc(provider)}"${preset || provider === 'doubao' ? '' : ' disabled'}><span class="service-light ${status.tone}" aria-hidden="true"></span><span>${esc(providerLabel(provider))}<small>${esc(preset ? status.label : '尚未设置音色')}</small></span>${preferred?.provider === provider ? icon('check') : ''}</button>`;
    }).join('')}<button type="button" class="tts-menu-settings" data-action="settings.open">打开声音设置</button>`;
    const rect = target.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 220))}px`;
    menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 252)}px`;
    menu.hidden = false;
    target.setAttribute('aria-expanded', 'true');
    return;
  }
  if (action === 'tts.select') {
    document.querySelector('#tts-menu').hidden = true;
    document.querySelector('#tts-switch').setAttribute('aria-expanded', 'false');
    const preset = rememberedPreset(id);
    if (id === 'doubao' && !doubaoConnection(preset)?.has_credential) return guideDoubaoLogin(preset?.id);
    if (!preset) {
      if (id === 'doubao') {
        const connection = doubaoConnection();
        await openViewerSettings('voices', { type: 'preset', id: '', connectionId: connection.id, makePreferred: true });
        await loadVoiceEditorData(connection.id);
        renderSettings();
        return;
      }
      throw new Error('请先在声音设置中添加这个服务的音色。');
    }
    await command('presets.default', { id: preset.id }, { success: `已切换到 ${providerLabel(id)}` });
    return;
  }
  if (action === 'viewer.open') {
    const item = feedEvents.get(id);
    if (!item) return;
    viewerContext = item;
    const menu = document.querySelector('#viewer-menu');
    const canBind = validUid(item.user_id) || !!String(item.user_name || '').trim();
    menu.innerHTML = `<div class="viewer-menu-name">${esc(item.user_name || '访客')}</div>${button('指定声音', 'viewer.voice', { class: 'quiet small', disabled: !canBind })}${button('添加别名', 'viewer.alias', { class: 'quiet small' })}${canBind ? '' : '<p>这条弹幕没有可用用户名或 UID，暂时无法指定声音。</p>'}`;
    const rect = target.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 202))}px`;
    menu.style.top = `${Math.max(12, Math.min(rect.bottom + 7, window.innerHeight - 145))}px`;
    menu.hidden = false;
    return;
  }
  if (action === 'viewer.voice' || action === 'viewer.alias') {
    document.querySelector('#viewer-menu').hidden = true;
    const item = viewerContext;
    if (!item) return;
    if (action === 'viewer.voice') {
      const hasUid = validUid(item.user_id);
      if (!hasUid && !String(item.user_name || '').trim()) throw new Error('这条弹幕没有可用用户名或 UID，无法指定声音。');
      if (!snapshot.presets?.length) { await openViewerSettings('voices', null); showToast('请先添加一个声音预设'); return; }
      const record = snapshot.bindings.find(entry => hasUid
        ? String(entry.binding.user_id) === String(item.user_id)
        : !entry.binding.user_id && entry.binding.user_name === item.user_name);
      return openViewerSettings('voices', { type: 'binding', id: record?.id || '', userId: hasUid ? item.user_id : null, userName: item.user_name });
    }
    return openViewerSettings('rules', { type: 'alias', userName: item.user_name });
  }
  if (action === 'autosave.retry') { const form = target.closest('form'); scheduleAutosave(form, true); await autosaves.get(form)?.queue.flush(); return; }
  if (action === 'autosave.discard') {
    const form = target.closest('form'); const record = autosaves.get(form);
    if (record) { record.touched = false; record.queue.cancel(); await record.queue.flush(); formDrafts.delete(record.key); renderSettings(); }
    return;
  }
  if (action === 'draft.discard') { formDrafts.delete(id); renderSettings(); return; }
  if (action === 'draft.resume') { const draft = formDrafts.get(id); if (draft) { editor = draft.editor; renderSettings(); } return; }
  if (action === 'settings.open' || action === 'settings.room') {
    const menu = document.querySelector('#tts-menu');
    if (menu) menu.hidden = true;
    const switcher = document.querySelector('#tts-switch');
    if (switcher) switcher.setAttribute('aria-expanded', 'false');
    return openSettings(action === 'settings.room' ? 'room' : 'voices');
  }
  if (action === 'settings.close') return closeSettings();
  if (action === 'settings.tab') {
    if (!await allowLeaveSettings()) return;
    if (editor?.type === 'qr') await cancelQr();
    tabEditors.delete(settingsTab);
    tabEditors.delete(id);
    settingsTab = id; editor = null; renderSettings();
    document.querySelector('#settings-content').focus({ preventScroll: true }); return;
  }
  if (action === 'setup.back') { await cancelQr(); return setStep(step === 'doubaoQr' ? 'tts' : 'login'); }
  if (action === 'setup.doubao') { setStep('doubaoQr'); return startQr('doubao'); }
  if (action === 'setup.silent') { await cancelQr(); setupTts = false; return setStep('ready'); }
  if (action === 'setup.finish') { await command('onboarding.finish', { tts_enabled: setupTts, connect: true }); return; }
  if (action === 'qr.retry') return startQr(editor?.provider || (step === 'doubaoQr' ? 'doubao' : 'bilibili'), editor?.id);
  if (action === 'chat.bottom') { const scroll = document.querySelector('#chat-scroll'); scroll.scrollTop = scroll.scrollHeight; document.querySelector('#new-messages').hidden = true; return; }
  if (action === 'live.toggle') {
    if (snapshot.live?.state === 'session_expired') {
      await openSettings('room');
      return handleAction('bili.begin', '', target);
    }
    return command(snapshot.live?.running ? 'live.disconnect' : 'live.connect');
  }
  if (action === 'live.connect' || action === 'live.disconnect' || action === 'queue.skip') return command(action);
  if (action === 'queue.clear' || action === 'queue.stop') {
    if (await confirmAction(action === 'queue.clear' ? '清空待播队列？' : '断开直播并停止全部播报？', action === 'queue.clear' ? '尚未播放的消息会被移除，当前播报继续。' : '将断开直播间、停止当前播放并清空待播消息。重新接收需再次连接。', '确认停止')) await command(action);
    return;
  }
  if (action === 'room.anonymous') { editor = { type: 'anonymous-room' }; renderSettings(); return; }
  if (action === 'bili.use_account') { await command(action, {}, { success: '已切换到你的直播间' }); editor = null; renderSettings(); return; }
  if (action === 'bili.logout') { if (await confirmAction('退出哔哩哔哩账号？', '将清除本机保存的账号凭据。')) { await command(action, { confirmed: true }); renderSettings(); } return; }
  if (action === 'fish.open_keys' || action === 'fish.open_discovery') {
    await command('external.open', { page: action === 'fish.open_keys' ? 'fish_keys' : 'fish_discovery' });
    return;
  }
  if (action === 'fish.restore_builtin') {
    const connection = serviceConnection('fish_audio');
    if (!connection?.has_credential) throw new Error('请先连接 Fish Audio 账号。');
    const next = await command('fish.voices.restore_builtin', { connection_id: connection.id });
    renderSettings();
    showToast(next.result?.length ? `已恢复 ${next.result.length} 个内置音色` : '内置音色已齐全');
    return;
  }
  if (action === 'fish.voice.lookup') {
    const form = target.closest('[data-form="fish-voice"]');
    const idOrUrl = form?.elements.id_or_url.value.trim();
    const connectionId = form?.dataset.connectionId;
    if (!idOrUrl || !connectionId) throw new Error('请填写音色页面链接或 32 位音色 ID。');
    const next = await command('fish.voice.lookup', { connection_id: connectionId, id_or_url: idOrUrl });
    if (form.elements.id_or_url.value.trim() !== idOrUrl) return;
    form.elements.id_or_url.value = next.result.voice_id;
    if (!form.elements.name.value.trim()) form.elements.name.value = String(next.result.name || '').slice(0, 100);
    const status = form.querySelector('[data-fish-lookup-result]');
    if (status) { status.textContent = next.result.name ? `已找到：${next.result.name}` : '已确认音色 ID。'; status.hidden = false; }
    return;
  }
  if (action === 'fish.audition') {
    const preset = snapshot.presets.find(item => item.id === id && item.provider === 'fish_audio');
    if (!preset) throw new Error('请重新选择 Fish Audio 音色。');
    if (!snapshot.connections.some(connection => connection.id === preset.connection_id && connection.has_credential)) throw new Error('请先连接 Fish Audio 账号。');
    if (snapshot.rules?.default_preset_id !== preset.id) await command('presets.default', { id: preset.id }, { quiet: true });
    await command('audition', { preset_id: preset.id, text: '你好，欢迎来到直播间。' }, { success: '试听已加入播放队列' });
    return;
  }
  if (action === 'voice-audition.add') {
    const form = target.closest('[data-form="voice-audition"]');
    if (!form) throw new Error('请重新打开声音设置。');
    updateVoiceAudition(form);
    const provider = form.dataset.provider;
    const connection = serviceConnection(provider);
    if (!connection || (provider === 'fish_audio' && !connection.has_credential)) {
      editor = { type: 'service', provider, makePreferred: true };
    } else {
      editor = { type: 'preset', id: '', connectionId: connection.id, makePreferred: true };
      await loadVoiceEditorData(connection.id);
    }
    renderSettings();
    return;
  }
  if (action === 'service.configure') { editor = { type: 'service', provider: id }; renderSettings(); return; }
  if (action === 'service.prefer') {
    if (id === 'doubao' && !doubaoConnection(rememberedPreset('doubao'))?.has_credential) return guideDoubaoLogin(rememberedPreset('doubao')?.id);
    if (snapshot.presets.find(item => item.id === snapshot.rules?.default_preset_id)?.provider === id) return;
    if (id === 'fish_audio' && !serviceConnection(id)?.has_credential) {
      editor = { type: 'service', provider: id, makePreferred: true };
      renderSettings();
      showToast('先连接 Fish Audio 账号，验证后会设为首选');
      return;
    }
    const preset = rememberedPreset(id);
    if (preset) { await command('presets.default', { id: preset.id }, { success: `${providerLabel(id)} 已设为首选` }); renderSettings(); return; }
    const connection = serviceConnection(id);
    editor = connection ? { type: 'preset', id: '', connectionId: connection.id, makePreferred: true } : { type: 'service', provider: id, makePreferred: true };
    if (connection) await loadVoiceEditorData(connection.id);
    renderSettings();
    showToast(connection ? '先添加音色，保存后会设为首选' : '先连接服务，再添加首选音色');
    return;
  }
  if (action === 'service.add_preset') {
    const connection = serviceConnection(id);
    if (!connection) throw new Error('请先设置这个语音服务。');
    if (id === 'fish_audio' && !connection.has_credential) {
      editor = { type: 'service', provider: id, makePreferred: !!editor?.makePreferred || !snapshot.rules?.default_preset_id };
      renderSettings();
      showToast('请先连接 Fish Audio 账号');
      return;
    }
    editor = { type: 'preset', id: '', connectionId: connection.id, makePreferred: !!editor?.makePreferred || !snapshot.rules?.default_preset_id };
    await loadVoiceEditorData(connection.id);
    renderSettings(); return;
  }
  if (action === 'models.refresh') {
    if (!await allowLeaveSettings()) return;
    const connectionId = settingsDialog.querySelector('[data-form="preset"]')?.elements.connection_id?.value;
    if (!connectionId) throw new Error('请先选择 GPT-SoVITS 服务。');
    editor.modelIndex = undefined;
    await loadVoiceEditorData(connectionId);
    renderSettings(); return;
  }
  if (action === 'reference.pick_audio') {
    const pick = window.__TAURI__?.dialog?.open;
    if (!pick) throw new Error('文件选择器不可用，请重新打开应用。');
    const path = await pick({ multiple: false, title: '选择参考音频', filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }] });
    if (typeof path === 'string') {
      const input = target.closest('form').elements.audio_path;
      setPickedPath(input, path);
    }
    return;
  }
  if (action === 'service.pick_directory') {
    const pick = window.__TAURI__?.dialog?.open;
    if (!pick) throw new Error('目录选择器不可用，请重新打开应用。');
    const directory = await pick({ directory: true, multiple: false, title: '选择 TTS 安装目录' });
    if (typeof directory === 'string') {
      const input = target.closest('form').elements.directory;
      setPickedPath(input, directory);
      await flushAutosaves();
    }
    return;
  }
  if (action === 'service.check') { await command('local_services.check', { provider: id }, { success: '连接状态已更新' }); updateServiceIndicators(); return; }
  if (action === 'service.start' || action === 'service.stop') {
    const provider = id;
    const service = snapshot.local_services?.[provider];
    if (!['dots', 'gpt_sovits'].includes(provider)) throw new Error('本地服务类型无效。');
    if (action === 'service.start') {
      const input = settingsDialog.querySelector('[data-form="service-local"] [name="directory"]');
      if (input?.value.trim() !== String(service?.directory || '')) throw new Error('目录尚未保存，请检查目录并重试。');
    }
    await command(action === 'service.start' ? 'local_services.start' : 'local_services.stop', { provider }, { success: action === 'service.start' ? '正在启动本地服务' : '本应用启动的服务已停止' });
    updateServiceIndicators(); return;
  }
  if (action === 'bili.begin' || action === 'doubao.begin') {
    await cancelQr(); editor = { type: 'qr', provider: action === 'bili.begin' ? 'bilibili' : 'doubao', id }; renderSettings(); return startQr(editor.provider, id || undefined);
  }
  if (action === 'editor.cancel') {
    if (!await allowLeaveSettings()) return;
    if (editor?.type === 'qr') await cancelQr();
    editor = null; tabEditors.delete(settingsTab); renderSettings(); return;
  }
  if (/^(preset|binding)\.(new|edit)$/.test(action)) {
    editor = { type: action.split('.')[0], id: id || '', connectionId: !id && snapshot.connections.length === 1 ? snapshot.connections[0].id : undefined };
    if (editor.type === 'preset') {
      const connectionId = snapshot.presets.find(item => item.id === id)?.connection_id || editor.connectionId;
      const connection = snapshot.connections.find(item => item.id === connectionId);
      if (!id && connection?.settings.provider === 'fish_audio' && !connection.has_credential) {
        editor = { type: 'service', provider: 'fish_audio', makePreferred: !snapshot.rules?.default_preset_id };
        renderSettings();
        showToast('请先连接 Fish Audio 账号');
        return;
      }
      if (connectionId) await loadVoiceEditorData(connectionId);
    }
    renderSettings(); return;
  }
  if (action === 'preset.choose_service') {
    const connection = snapshot.connections.find(item => item.id === id);
    if (!connection || editor?.type !== 'preset' || editor.id) throw new Error('请重新选择语音服务。');
    if (connection.settings.provider === 'fish_audio' && !connection.has_credential) {
      editor = { type: 'service', provider: 'fish_audio', makePreferred: !!editor.makePreferred };
      renderSettings();
      showToast('请先连接 Fish Audio 账号');
      return;
    }
    editor.connectionId = connection.id;
    await loadVoiceEditorData(connection.id);
    renderSettings(); return;
  }
  if (/^(preset|binding|asset)\.delete$/.test(action)) {
    const type = action.split('.')[0];
    const label = ({ preset: '声音预设', binding: '用户声音绑定', asset: '音效素材' })[type];
    if (await confirmAction(`删除${label}？`, '删除后无法撤销。仍被使用的连接、默认预设或规则素材需要先解除引用。', '删除')) { await command(`${type === 'asset' ? 'assets' : `${type}s`}.delete`, { id, confirmed: true }); renderSettings(); }
    return;
  }
  if (action === 'preset.default' || action === 'preset.clear-default') { await command('presets.default', { id: action === 'preset.clear-default' ? null : id }); renderSettings(); return; }
  if (action === 'asset.replace') { if (!await allowLeaveSettings()) return; editor = { type: 'asset', id }; renderSettings(); return; }
  if (action.startsWith('dictionary.add.')) { const type = action.split('.')[2]; const list = document.querySelector(`[data-dictionary="${type}"]`); list.insertAdjacentHTML('beforeend', dictionaryRow(type)); mountSelects(list); scheduleAutosave(list.closest('form')); return; }
  if (action === 'dictionary.remove') { const form = target.closest('form'); target.closest('.dict-row').remove(); scheduleAutosave(form, true); return; }
  if (action === 'devices.refresh') {
    const form = document.querySelector('[data-form="audio"]'); const selected = form.elements.output.value;
    await command(action); form.elements.output.innerHTML = option('', '跟随系统默认设备', selected) + snapshot.devices.map(device => option(device.name, `${device.name}${device.is_default ? '（系统默认）' : ''}`, selected)).join(''); mountSelects(form); showToast('设备列表已刷新'); return;
  }
  if (action === 'audio.reconnect') {
    await command('preferences.save', { preferences: {}, reopen_output: true, confirmed: true }, { success: '音频输出已重新连接' });
    renderSettings();
    return;
  }
  if (action === 'onboarding.reset') {
    if (!await confirmAction('重新打开初次设置？', '已有声音、规则和素材会保留。', '重新设置', false)) return;
    await cancelQr(); await command(action); settingsDialog.close(); editor = null; setStep('login'); return;
  }
  if (action === 'migration.cancel') { await command(action); migrationPreview = null; renderSettings(); return; }
  if (action === 'data.clear') {
    if (!await confirmAction('清除全部应用数据？', '将删除本机保存的账号和语音服务凭据、声音预设、播报规则、界面设置、已导入的音效及应用备份。\n当前接收和播报会停止，随后回到首次设置。', '清除应用数据')) return;
    stopQrPolling();
    await command('data.clear', { confirmed: true });
    unmountAutosaves(); formDrafts.clear(); tabEditors.clear(); feedNodes.clear();
    editor = null; migrationPreview = null; settingsTab = 'voices'; settingsDirty = false; setupTts = true;
    settingsDialog.close(); settingsDialog.replaceChildren();
    showToast('应用数据已清除'); setStep('login'); return;
  }
  if (action === 'reconnect') return boot();
}

function eventFromForm(data) {
  const uid = data.get('user_id');
  if (uid && !validUid(uid)) throw new Error('观众 UID 需要是有效的正整数。');
  return { room_id: snapshot.setup?.room_id || 1, user_id: uid ? numericId(uid) : null, user_name: String(data.get('user_name')), kind: String(data.get('kind')), message: String(data.get('message') || ''), gift_name: String(data.get('gift_name') || ''), quantity: Number(data.get('quantity') || 1), price_yuan: Number(data.get('price_yuan') || 0), coin_type: String(data.get('coin_type') || 'gold'), guard_name: String(data.get('guard_name') || ''), platform_event_id: null, observed_at_ms: 0 };
}

async function saveDotsPresetForm(form) {
  const inFlight = dotsSaves.get(form);
  if (inFlight) return inFlight;
  const operation = saveDotsPresetFormInner(form);
  dotsSaves.set(form, operation);
  try { return await operation; }
  finally { dotsSaves.delete(form); }
}

async function saveDotsPresetFormInner(form) {
  if (!form.checkValidity()) { form.reportValidity(); throw new Error('请填好音色名称、参考音频、语速和音量。'); }
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const audioPath = String(data.get('audio_path') || '').trim();
  const referenceText = String(data.get('reference_text') || '').trim();
  const speed = Number(data.get('speed'));
  const volume = Number(data.get('volume'));
  const connection = snapshot.connections.find(item => item.id === form.dataset.connectionId && item.settings.provider === 'dots');
  const id = form.dataset.id || '';
  const existing = snapshot.presets.find(item => item.id === id);
  const voiceId = existing?.voice_id || editor?.dotsVoiceId;
  if (!connection || !voiceId || !name) throw new Error('请重新选择 dots.tts 服务并填写音色名称。');
  if (!Number.isFinite(speed) || speed < .5 || speed > 2 || !Number.isFinite(volume) || volume < 0 || volume > 2) throw new Error('语速须在 0.5–2，音量须在 0–2 之间。');
  if (!audioPath && (!id || currentReference({ kind: 'dots', role: voiceId }))) throw new Error('请重新选择参考音频原文件。');
  form.dataset.dirty = 'true';
  rememberDotsDraft(form);
  const preset = { id, name, connection_id: connection.id, provider: 'dots', voice_id: voiceId, speed, volume, sovits: null };
  const oldKey = dotsDraftKey(form);
  const profile = audioPath
    ? { connection_id: connection.id, role: { kind: 'dots', role: voiceId }, audio_path: audioPath, reference_text: referenceText, reference_language: '', text_language: '', text_free: false }
    : null;
  const result = profile
    ? await command('dots.voice.save', { preset, profile, make_preferred: !!editor?.makePreferred }, { quiet: true, silent: true })
    : await command('presets.save', { preset }, { quiet: true, silent: true });
  const savedId = result.result?.id || snapshot.presets.find(item => item.connection_id === connection.id && item.voice_id === voiceId)?.id;
  if (!savedId) throw new Error('无法确认音色编号；请重新打开声音设置核对。');
  if (!id) {
    form.dataset.id = savedId;
    editor.id = savedId;
  }
  if (profile) {
    referenceProfiles = referenceProfiles.filter(item => item.profile?.role?.kind !== 'dots' || item.profile.role.role !== voiceId);
    referenceProfiles.push({ profile });
  }
  if (editor?.makePreferred && !profile) {
    await command('presets.default', { id: savedId }, { quiet: true, silent: true });
  }
  if (editor) editor.makePreferred = false;
  delete form.dataset.dirty;
  formDrafts.delete(oldKey);
  formDrafts.delete(dotsDraftKey(form));
  return savedId;
}

async function saveReferenceForm(form) {
  const data = new FormData(form);
  const value = key => String(data.get(key) ?? '').trim();
  const checked = key => data.has(key);
  const presetForm = settingsDialog.querySelector('[data-form="preset"]');
  if (!presetForm || !presetForm.checkValidity()) throw new Error('请先填写角色名称和声音预设。');
  scheduleAutosave(presetForm, true);
  await autosaves.get(presetForm)?.queue.flush();
  const connection_id = presetForm.elements.connection_id.value;
  const provider = snapshot.connections.find(item => item.id === connection_id)?.settings.provider;
  const role = provider === 'dots'
    ? { kind: 'dots', role: presetForm.elements.voice_id.value.trim() }
    : provider === 'gpt_sovits'
      ? { kind: 'gpt_sovits', gpt_weights_path: presetForm.elements.gpt_weights_path.value.trim(), sovits_weights_path: presetForm.elements.sovits_weights_path.value.trim() }
      : null;
  if (!role || (role.kind === 'gpt_sovits' && (!role.gpt_weights_path || !role.sovits_weights_path))) throw new Error('请先选择成对的角色模型。');
  const path = value('audio_path');
  if (!path) throw new Error('请先选择参考音频。');
  if (provider === 'gpt_sovits' && !checked('text_free') && !value('reference_text')) throw new Error('请填写参考音频原文，或开启无参考文本模式。');
  const profile = { connection_id, role, audio_path: path, reference_text: value('reference_text'), reference_language: provider === 'gpt_sovits' ? value('reference_language') : '', text_language: provider === 'gpt_sovits' ? value('text_language') : '', text_free: provider === 'gpt_sovits' && checked('text_free') };
  await command('references.save', { profile }, { quiet: true, silent: true });
  if (editor?.makePreferred) {
    const id = presetForm.dataset.id;
    if (!id) throw new Error('音色尚未创建成功，请重试。');
    await command('presets.default', { id }, { quiet: true, silent: true });
    editor.makePreferred = false;
    const record = autosaves.get(presetForm);
    if (record?.editor) record.editor.makePreferred = false;
  }
  const listed = await command('references.list', { connection_id }, { quiet: true });
  referenceProfiles = Array.isArray(listed.result) ? listed.result : [];
  delete form.dataset.dirty;
  showToast('角色参考设置已保存');
}

async function handleForm(form, submitter) {
  const type = form.dataset.form;
  const data = new FormData(form);
  const value = key => String(data.get(key) ?? '').trim();
  const number = key => Number(data.get(key));
  const checked = key => data.has(key);
  const id = form.dataset.id || '';
  if (type === 'anonymous' || type === 'room-uid') {
    const uid = value('uid');
    if (!validUid(uid)) throw new Error('请输入有效的主播 UID。');
    await cancelQr(); await command('onboarding.anonymous', { uid });
    if (type === 'anonymous') setStep('tts'); else { renderSettings(); showToast('直播间已保存'); }
    return;
  }
  if (type === 'voice-audition') {
    const preset = snapshot.presets.find(item => item.id === value('preset_id') && item.provider === form.dataset.provider);
    const text = value('text');
    if (!preset) throw new Error('请先选择这个服务的音色。');
    if (!text) throw new Error('请输入试听文字。');
    if (!await saveVoiceAuditionChoice(form)) return;
    await command('audition', { preset_id: preset.id, text }, { success: '试听已加入播放队列' });
    return;
  }
  if (type === 'gift-merge') {
    const gift_merge = { enabled: checked('enabled'), initial_seconds: number('initial_seconds'), increment_seconds: number('increment_seconds'), maximum_seconds: number('maximum_seconds') };
    if (gift_merge.maximum_seconds < gift_merge.initial_seconds) throw new Error('最长等待不能小于初始等待。');
    await command('live.save', { gift_merge }, { success: '礼物合并设置已保存' });
  } else if (type === 'service-local') {
    const provider = form.dataset.provider;
    if (!['dots', 'gpt_sovits'].includes(provider)) throw new Error('本地服务类型无效。');
    const directory = value('directory');
    const existing = serviceConnection(provider);
    const endpoint = existing?.settings?.endpoint || providerEndpoint[provider];
    await command('connections.save', { connection: { id: existing?.id || '', name: providerLabel(provider), settings: { provider, endpoint, timeout_secs: Math.min(existing?.settings?.timeout_secs ?? providerTimeout[provider], 30) }, has_credential: false } });
    await command('local_services.save', { provider, directory }, { success: '本地服务设置已保存' });
    if (!snapshot.network_disabled) await command('local_services.check', { provider }, { quiet: true });
  } else if (type === 'service-fish') {
    await connectFishCredential(value('credential'), form);
  } else if (type === 'fish-settings') {
    const connectionId = form.dataset.connectionId;
    if (!snapshot.connections.some(connection => connection.id === connectionId && connection.settings.provider === 'fish_audio' && connection.has_credential)) throw new Error('请先连接 Fish Audio 账号。');
    const settings = { model: value('model'), latency: value('latency'), volume_db: number('volume_db'), temperature: number('temperature'), top_p: number('top_p'), streaming: true };
    if (!Number.isFinite(settings.volume_db) || settings.volume_db < -20 || settings.volume_db > 20 || ![settings.temperature, settings.top_p].every(item => Number.isFinite(item) && item >= 0 && item <= 1)) throw new Error('合成音量须在 -20–20 dB，温度与 Top P 须在 0–1 之间。');
    await command('fish.settings.save', { connection_id: connectionId, settings }, { success: 'Fish Audio 生成设置已保存' });
  } else if (type === 'fish-voice') {
    const connectionId = form.dataset.connectionId;
    if (!snapshot.connections.some(connection => connection.id === connectionId && connection.settings.provider === 'fish_audio' && connection.has_credential)) throw new Error('请先连接 Fish Audio 账号。');
    const idOrUrl = value('id_or_url');
    if (!idOrUrl) throw new Error('请填写音色页面链接或 32 位音色 ID。');
    let name = value('name');
    if (!name) {
      const found = await command('fish.voice.lookup', { connection_id: connectionId, id_or_url: idOrUrl }, { quiet: true });
      name = String(found.result?.name || '').slice(0, 100).trim();
      if (!name) throw new Error('未查到音色名称，请自行填写收藏名称。');
    }
    const saved = await command('fish.voice.save', { connection_id: connectionId, id_or_url: idOrUrl, name }, { success: 'Fish 音色已收藏' });
    if (editor?.makePreferred) await command('presets.default', { id: saved.result.id });
    editor = null;
  } else if (type === 'fish-preset') {
    const existing = snapshot.presets.find(preset => preset.id === id && preset.provider === 'fish_audio' && preset.connection_id === form.dataset.connectionId);
    if (!existing) throw new Error('Fish 音色不存在，请重新打开设置。');
    const preset = { ...existing, name: value('name'), speed: number('speed'), volume: number('volume') };
    if (!preset.name || !Number.isFinite(preset.speed) || preset.speed < .5 || preset.speed > 2 || !Number.isFinite(preset.volume) || preset.volume < 0 || preset.volume > 2) throw new Error('请填写名称；语速须在 0.5–2，音量须在 0–2 之间。');
    await command('presets.save', { preset }, { success: 'Fish 音色已保存' });
    editor = null;
  } else if (type === 'preset') {
    const connection = snapshot.connections.find(item => item.id === value('connection_id'));
    if (!connection) throw new Error('请先选择有效的服务连接。');
    const name = value('name') || (connection.settings.provider === 'doubao' ? voiceName(value('voice_id')) : snapshot.presets.find(item => item.id === id)?.name || `${providerLabel(connection.settings.provider)} · ${value('voice_id')}`).slice(0, 100);
    const preset = { id, name, connection_id: connection.id, provider: connection.settings.provider, voice_id: value('voice_id'), speed: number('speed'), volume: number('volume'), sovits: null };
    if (preset.provider === 'gpt_sovits') preset.sovits = { model_selection: value('model_selection'), gpt_weights_path: value('gpt_weights_path') || null, sovits_weights_path: value('sovits_weights_path') || null, reference_text: value('reference_text'), reference_text_free: checked('reference_text_free'), reference_language: value('reference_language'), text_language: value('text_language'), split: value('split'), top_k: number('top_k'), top_p: number('top_p'), temperature: number('temperature'), sample_steps: number('sample_steps'), super_sampling: checked('super_sampling'), fragment_interval_secs: number('fragment_interval_secs') };
    await command('presets.save', { preset }, { success: '声音预设已保存' }); editor = null;
  } else if (type === 'dots-preset') {
    await saveDotsPresetForm(form);
    editor = null;
    renderSettings();
    showToast('音色已保存');
    return;
  } else if (type === 'reference') {
    await saveReferenceForm(form);
    renderSettings();
    return;
  } else if (type === 'binding') {
    const envelope = collectAutosave(form);
    await command(envelope.action, envelope.payload, { success: '观众声音已保存' }); editor = null;
  } else if (type === 'tts-toggle') {
    await command('preferences.save', { preferences: { tts_enabled: checked('tts_enabled') } }, { success: '播报开关已保存' });
  } else if (type === 'alias') {
    const from = value('from');
    const to = value('to');
    if (!from || !to) throw new Error('请填写播报别名。');
    const rules = structuredClone(snapshot.rules);
    const index = rules.user_words.findIndex(row => row.from === from);
    if (index >= 0) rules.user_words[index] = { from, to };
    else rules.user_words.push({ from, to });
    await command('rules.save', { rules }, { success: '播报别名已保存' });
    editor = null;
  } else if (type === 'rules') {
    const rules = structuredClone(snapshot.rules);
    for (const key of ['danmaku_on', 'gift_on', 'free_gift_on', 'super_chat_on', 'guard_on']) rules.events[key] = checked(key);
    for (const key of ['gift_threshold_yuan', 'super_chat_threshold_yuan']) rules.events[key] = number(key);
    for (const key of ['danmaku', 'gift', 'super_chat', 'guard']) rules.templates[key] = value(`template_${key}`);
    for (const type of ['user_words', 'message_words']) rules[type] = [...form.querySelectorAll(`[data-dictionary="${type}"] .dict-row`)].map(row => ({ from: row.querySelector('[data-key="from"]').value, to: row.querySelector('[data-key="to"]').value }));
    await command('rules.save', { rules }, { success: '播报规则已保存' });
  } else if (type === 'sound-words') {
    const rules = structuredClone(snapshot.rules);
    rules.sounds = [...form.querySelectorAll('[data-dictionary="sounds"] .dict-row')].map(row => ({ trigger: row.querySelector('[data-key="from"]').value, asset_id: row.querySelector('[data-key="to"]').value }));
    await command('rules.save', { rules }, { success: '关键词音效已保存' });
  } else if (type === 'preview') {
    const event = eventFromForm(data);
    const next = await command('rules.preview', { event });
    const preview = next.result;
    const node = document.querySelector('#preview-result');
    node.innerHTML = `<div class="notice">${preview.filtered_reason ? `已过滤：${esc(preview.filtered_reason)}` : `${esc(preview.final_text || '没有可播报的文字')}<br>声音：${esc(preview.voice?.name || '未指定默认声音')}${preview.pending_legacy_binding ? '<br>同名旧绑定待确认 UID，尚未应用。' : ''}`}</div><pre class="code-output">${esc(JSON.stringify(preview.parts, null, 2))}</pre>`;
    return;
  } else if (type === 'asset') {
    if (id && !await confirmAction('替换这份音效？', '今后的播报使用新音频；已经排队的消息仍可能使用旧文件。', '替换')) return;
    await command(id ? 'assets.replace' : 'assets.import', id ? { id, path: value('path'), confirmed: true } : { path: value('path'), name: value('name') }, { success: id ? '素材已替换' : '素材已导入' }); editor = null;
  } else if (type === 'audio') {
    const output = value('output') ? { named: value('output') } : 'default';
    const needsConfirm = JSON.stringify(output) !== JSON.stringify(snapshot.preferences.output);
    if (needsConfirm && !await confirmAction('应用新的音频输出？', '当前播放和待播队列会停止。', '应用并停止播放', false)) return;
    await command('preferences.save', { preferences: { output }, confirmed: needsConfirm }, { success: '音频设置已保存' });
  } else if (type === 'appearance') {
    await command('preferences.save', { preferences: { appearance: value('appearance'), scale: number('scale') } }, { success: '外观已保存' });
  } else if (type === 'startup') {
    await command('startup.set', { enabled: checked('enabled') }, { success: '启动选项已保存' });
  } else if (type === 'export') {
    const next = await command('configuration.export', { path: value('path') }, { success: '配置已导出，不含登录凭据' }); renderResult('#operation-result', next.result || '导出完成'); settingsDirty = false; return;
  } else if (type === 'migration-preview') {
    const next = await command('migration.preview', { path: value('path') }); migrationPreview = next.result; settingsDirty = false; document.querySelector('#migration-preview').innerHTML = renderMigrationPreview(); return;
  } else if (type === 'migration-apply') {
    const options = { selected_sound_ids: data.getAll('selected_sound_ids') };
    for (const key of ['import_rules', 'import_live_settings', 'import_connections', 'import_pending_bindings', 'replace_existing_rules', 'replace_existing_live_settings']) options[key] = checked(key);
    if (!options.import_rules && options.selected_sound_ids.length) throw new Error('导入音效时，请同时勾选播报规则和词典。');
    if (!options.import_rules && !options.import_live_settings && !options.import_connections && !options.import_pending_bindings) throw new Error('请至少选择一项要导入的内容。');
    const selected = [['import_rules', '播报规则和词典'], ['import_live_settings', '直播间设置'], ['import_connections', '服务连接与声音预设'], ['import_pending_bindings', '待确认 UID 的绑定']].filter(([key]) => options[key]).map(([, label]) => label);
    if (!await confirmAction('确认导入这些内容？', `${selected.join('、')}，以及 ${options.selected_sound_ids.length} 个音效文件。\n${options.replace_existing_rules || options.replace_existing_live_settings ? '已选择允许覆盖当前对应设置。\n' : ''}会先备份当前数据库，不导入登录凭据。`, '备份并导入', false)) return;
    const next = await command('migration.apply', { confirmed: true, options }); migrationPreview = null; renderSettings(); renderResult('#operation-result', next.result); showToast('导入完成，请查看结果'); return;
  }
  settingsDirty = false;
  renderSettings();
}

document.addEventListener('click', async event => {
  const viewerMenu = document.querySelector('#viewer-menu');
  if (viewerMenu && !viewerMenu.hidden && !viewerMenu.contains(event.target) && !event.target.closest('[data-action="viewer.open"]')) viewerMenu.hidden = true;
  const ttsMenu = document.querySelector('#tts-menu');
  if (ttsMenu && !ttsMenu.hidden && !ttsMenu.contains(event.target) && !event.target.closest('[data-action="tts.open"]')) {
    ttsMenu.hidden = true;
    document.querySelector('#tts-switch').setAttribute('aria-expanded', 'false');
  }
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const wasDisabled = target.disabled;
  target.disabled = true;
  try { await handleAction(target.dataset.action, target.dataset.id, target); }
  catch (error) { showError(error); }
  finally {
    if (target.isConnected) {
      target.disabled = wasDisabled;
      if (['service.start', 'service.stop', 'service.check'].includes(target.dataset.action)) updateServiceIndicators();
    }
  }
});

document.addEventListener('input', event => {
  if (event.target.id !== 'main-volume-range') return;
  volumeDraft = Number(event.target.value);
  updateVolumeControls();
});

document.addEventListener('change', event => {
  if (event.target.id !== 'main-volume-range') return;
  volumeDraft = Number(event.target.value);
  volumeSave.schedule(volumeDraft, { immediate: true });
});

document.addEventListener('error', event => {
  if (event.target.classList?.contains('avatar-photo') || event.target.classList?.contains('account-photo')) event.target.remove();
  else if (event.target.classList?.contains('message-emote')) event.target.replaceWith(document.createTextNode(event.target.alt));
}, true);

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (autoFormTypes.has(form.dataset.form)) {
    scheduleAutosave(form, true);
    try { await autosaves.get(form)?.queue.flush(); } catch { /* Inline status owns this error. */ }
    return;
  }
  if (form.dataset.busy) return;
  form.dataset.busy = 'true'; form.setAttribute('aria-busy', 'true');
  const submitter = event.submitter;
  if (submitter) submitter.disabled = true;
  try { clearError(); await handleForm(form, submitter); }
  catch (error) { showError(error); }
  finally { delete form.dataset.busy; form.removeAttribute('aria-busy'); if (submitter?.isConnected) submitter.disabled = false; }
});

settingsDialog.addEventListener('cancel', event => { event.preventDefault(); void closeSettings(); });
settingsDialog.addEventListener('compositionstart', event => { composingInputs.add(event.target); });
settingsDialog.addEventListener('compositionend', event => {
  composingInputs.delete(event.target);
  const form = event.target.closest('[data-form]');
  if (form?.dataset.form === 'reference') form.dataset.dirty = 'true';
  if (form?.dataset.form === 'dots-preset') { form.dataset.dirty = 'true'; rememberDotsDraft(form); }
  if (form && manualSaveFormTypes.has(form.dataset.form)) form.dataset.dirty = 'true';
  if (form && autoFormTypes.has(form.dataset.form)) scheduleAutosave(form, false, event.target.name === 'uid');
});
settingsDialog.addEventListener('input', event => {
  if (event.target.id === 'settings-category') return;
  const form = event.target.closest('[data-form]');
  if (form?.dataset.form === 'voice-audition') { updateVoiceAudition(form); return; }
  settingsDirty = true;
  if (form?.dataset.form === 'reference') form.dataset.dirty = 'true';
  if (form?.dataset.form === 'dots-preset') { form.dataset.dirty = 'true'; rememberDotsDraft(form); }
  if (form && manualSaveFormTypes.has(form.dataset.form)) form.dataset.dirty = 'true';
  if (form && autoFormTypes.has(form.dataset.form)) scheduleAutosave(form, false, event.target.name === 'uid', event.isComposing || composingInputs.has(event.target));
});
settingsDialog.addEventListener('change', async event => {
  if (event.target.id === 'settings-category') {
    const selected = event.target.value;
    event.target.value = settingsTab;
    void handleAction('settings.tab', selected).catch(showError);
    return;
  }
  if (event.target.closest('[data-form="voice-audition"]')) {
    const form = event.target.closest('form');
    if (event.target.name === 'preset_id') await saveVoiceAuditionChoice(form);
    else updateVoiceAudition(form);
    return;
  }
  settingsDirty = true;
  if (event.target.name === 'model_pair') {
    const reference = settingsDialog.querySelector('[data-form="reference"]');
    if (reference?.dataset.dirty) {
      const preset = snapshot.presets.find(item => item.id === editor?.id) || { id: '' };
      event.target.value = String(editor?.modelIndex ?? selectedModelPair(preset).index);
      showToast('请先保存参考设置，再切换模型。', true);
      return;
    }
    editor.modelIndex = Number(event.target.value);
    applyModelPairToForm();
    return;
  }
  if (event.target.name === 'connection_id') {
    const connection = snapshot.connections.find(item => item.id === event.target.value);
    if (editor?.type === 'preset') {
      if (editor.id) {
        event.target.value = snapshot.presets.find(item => item.id === editor.id)?.connection_id || '';
        showToast('更换语音服务请新建音色。', true);
        return;
      }
      editor.connectionId = connection?.id;
      editor.modelIndex = undefined;
      try { await loadVoiceEditorData(connection?.id); renderSettings(); } catch (error) { showError(error); }
      return;
    }
  }
  const form = event.target.closest('[data-form]');
  if (form?.dataset.form === 'dots-preset' && !form.dataset.dirty) { form.dataset.dirty = 'true'; rememberDotsDraft(form); }
  if (form && manualSaveFormTypes.has(form.dataset.form)) form.dataset.dirty = 'true';
  if (form && autoFormTypes.has(form.dataset.form)) {
    const immediate = event.target.tagName === 'SELECT' || ['checkbox', 'range'].includes(event.target.type);
    scheduleAutosave(form, immediate, event.target.name === 'uid', composingInputs.has(event.target));
  }
});
settingsDialog.addEventListener('focusout', event => {
  const form = event.target.closest('[data-form]');
  if (form && autosaves.get(form)?.touched && !composingInputs.has(event.target)) scheduleAutosave(form, true);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
window.addEventListener('pagehide', () => { disposed = true; stopQrPolling(); closeSelect(); clearTimeout(snapshotTimer); clearTimeout(fallbackStatusTimer); });
function refreshVisibility() {
  const active = uiIsActive(nativeActive, windowFocused, document.hidden);
  if (active === effectiveActive) return;
  effectiveActive = active;
  const inactive = String(!active);
  if (document.documentElement.dataset.inactive !== inactive) document.documentElement.dataset.inactive = inactive;
  if (boot.polling) scheduleSnapshotPolling(active);
  if (!active) clearTimeout(qrTimer);
  else if (qrProvider && !qrBusy && !qrFailure && ['waiting', 'scanned'].includes(snapshot?.qr?.status)) scheduleQrPoll(qrProvider, qrGeneration);
}
window.addEventListener('focus', () => { windowFocused = true; refreshVisibility(); });
window.addEventListener('blur', () => { windowFocused = false; refreshVisibility(); });
document.addEventListener('visibilitychange', refreshVisibility);

function scheduleSnapshotPolling(immediate = false) {
  clearTimeout(snapshotTimer);
  if (disposed || !uiIsActive(nativeActive, windowFocused, document.hidden)) return;
  const policy = snapshotPollingPolicy(snapshot, { step, hidden: document.hidden, focused: nativeActive ?? windowFocused, busy: pendingCommands > 0 });
  if (!policy.poll && !pendingCommands) return;
  snapshotTimer = setTimeout(pollSnapshot, immediate ? 0 : policy.delay);
}

async function pollSnapshot() {
  if (disposed) return;
  const policy = snapshotPollingPolicy(snapshot, { step, hidden: document.hidden, focused: nativeActive ?? windowFocused, busy: pendingCommands > 0 });
  if (policy.poll) {
    try { acceptSnapshot(await invoke('snapshot', { configRevision: snapshot?.config_revision })); }
    catch (error) { try { acceptSnapshot(await invoke('snapshot')); } catch { showError(error); } }
  }
  scheduleSnapshotPolling();
}

async function boot() {
  try {
    if (!boot.resourceListener && window.__TAURI__?.event?.listen) {
      boot.resourceListener = await window.__TAURI__.event.listen('resource-mode', event => {
        if (typeof event.payload === 'boolean') { nativeActive = event.payload; refreshVisibility(); }
      });
      try { const active = await invoke('ui_activity', {}); if (typeof active === 'boolean') nativeActive = active; }
      catch { /* Older hosts and standalone fixtures use browser focus instead. */ }
      refreshVisibility();
    }
    if (!boot.exitListener && window.__TAURI__?.event?.listen) {
      boot.exitListener = await window.__TAURI__.event.listen('exit-requested', async event => {
        const saved = await flushExitEdits();
        try { await invoke('finish_exit', { saved, requestId: event.payload?.request_id }); }
        catch (error) { showToast(`退出前停止播报失败：${error?.message || error}`, true); }
      });
    }
    acceptSnapshot(await invoke('snapshot'));
    if (step === 'login') await startQr('bilibili');
    if (!boot.polling) { boot.polling = true; scheduleSnapshotPolling(); }
  } catch (error) {
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = `<main class="disconnected">${mark}<h1>桌面连接不可用</h1><p>请重新打开超绝可爱弹幕姬，或点击重试。</p><p class="quiet-note">${esc(error?.message || error)}</p>${button('重试连接', 'reconnect', { class: 'small' })}</main>`;
  }
}

void boot();
