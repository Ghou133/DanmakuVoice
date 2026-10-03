import { t, ui, getLanguage, setLanguage } from './i18n.mjs';
import { localizeDiagnostic } from './i18n-diagnostics.mjs';
import { errorMessage, escapeHtml as esc, mergeSnapshot, headerIdentity, initial, identityColor, eventText, eventKeys, validUid, numericId, playbackIssue, runtimeIssue, liveConnectionView, snapshotPollingPolicy, uiIsActive, safeQrUrl, safeMediaUrl, messageParts, playbackCaption, playbackFallbackNotice, startingStep, providerLabel, deviceValue, normalizedEvents, qrLabel, qrNeedsRoomFallback } from './helpers.mjs';
import { createAutosaveQueue } from './autosave.mjs';
import { mountSelects, closeSelect, stripSelects } from './select.mjs';

setLanguage(document.documentElement.lang || window.__DANMAKUVOICE_STARTUP_THEME__?.language);

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
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>', chatSmall: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>', skip: '<path d="m5 5 10 7-10 7ZM19 5v14"/>', stop: '<path d="M6 6h12v12H6z"/>',
  down: '<path d="m6 9 6 6 6-6"/>', up: '<path d="m6 15 6-6 6 6"/>', moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>', edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>', trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', rules: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  assets: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  audio: '<path d="M3 9v6h4l5 4V5L7 9ZM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>', appearance: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M12 4a8 8 0 0 1 0 16"/>',
  muted: '<path d="M3 9v6h4l5 4V5L7 9ZM16 9l6 6M22 9l-6 6"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3ZM3 6V4h7l2 2h9v3"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  refresh: '<path d="M20 4v6h-6M4 20v-6h6M20 10a8 8 0 0 0-13-6M4 14a8 8 0 0 0 13 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  navRoom: '<path d="M3 6h18v11H3zM8 21h8M12 17v4"/>', navVoice: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  navRules: '<path d="M4 6h10M4 12h16M4 18h7M18 4v4M14 16v4"/>', navSounds: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  navOverlay: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  navBroadcast: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14.5 8.5l2 2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  navGeneral: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/>', navAbout: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
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
const pathField = (name, label, value, action, placeholder = t('点击选择文件'), hint = '') => {
  const id = `field-${++fieldSequence}`;
  return `<div class="field path-field"><span id="${id}">${esc(label)}</span><input type="hidden" name="${esc(name)}" value="${esc(value)}"><button type="button" class="path-picker" data-action="${esc(action)}" aria-labelledby="${id}" title="${esc(value || placeholder)}">${icon('folder')}<span data-path-value class="${value ? '' : 'placeholder'}">${esc(value || placeholder)}</span>${icon('arrow')}</button>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
};
function voiceName(id) {
  const voice = (snapshot.doubao_voices || []).find(item => (item.id || item.voice_id || item.value) === id);
  return voice?.name || voice?.label || t('已保存的音色');
}
const field = (name, label, value = '', attrs = '', hint = '') => {
  const id = `field-${++fieldSequence}`;
  return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" name="${esc(name)}" value="${esc(attrs.includes('type="number"') ? displayNumber(value) : value)}" ${attrs}>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`;
};
const presetLabel = preset => preset.provider === 'doubao' && (!preset.name || preset.name.includes(preset.voice_id)) ? voiceName(preset.voice_id) : preset.provider === 'gpt_sovits' ? String(preset.name || '').replace(/^GPT-SoVITS\s*·\s*/, '') || preset.voice_id : preset.name;
function defaultPresetName(provider, voiceId, id) {
  if (provider === 'doubao') return voiceName(voiceId);
  const existing = snapshot.presets.find(item => item.id === id);
  return (existing?.name ? presetLabel(existing) : provider === 'gpt_sovits' ? voiceId : `${providerLabel(provider)} · ${voiceId}`).slice(0, 100);
}
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
const saveButton = (label = t('保存更改')) => `<button type="submit" class="button primary">${esc(label)}</button>`;
const autoStatus = () => t('<div class="autosave-status" role="status" aria-live="polite" hidden><span data-autosave-label></span><button type="button" class="text-button" data-action="autosave.retry" hidden>重试</button><button type="button" class="text-button" data-action="autosave.discard" hidden>丢弃草稿</button></div>');
const autoFormTypes = new Set(['room-uid', 'gift-merge', 'preset', 'binding', 'tts-toggle', 'rules', 'sound-words', 'audio', 'appearance', 'startup', 'service-local', 'fish-settings', 'fish-preset', 'overlay']);
const manualSaveFormTypes = new Set(['service-fish', 'fish-voice', 'alias', 'asset', 'migration-apply', 'broadcast-room']);
const autosaves = new Map();
const formDrafts = new Map();
const dotsSaves = new WeakMap();
const composingInputs = new WeakSet();
const tabEditors = new Map();
const empty = (message) => `<p class="empty-list">${esc(message)}</p>`;
// Settings page building blocks (晨雾 / 夜幕 flat cards).
const sLabel = (text, extra = '') => `<div class="s-label-row"><span class="s-label">${esc(text)}</span>${extra}</div>`;
const sSection = (label, body, extra = '', note = '', id = '') => `<section class="s-section"${id ? ` id="${esc(id)}"` : ''}>${sLabel(label, extra)}${body}${note ? `<p class="s-note">${esc(note)}</p>` : ''}</section>`;
const sSwitch = (name, label, checked, note = '', extra = '') => {
  const id = `field-${++fieldSequence}`;
  return `<div class="s-row"><label class="s-text" for="${id}"><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</label>${extra}<input id="${id}" class="s-switch" type="checkbox" role="switch" name="${esc(name)}"${checked ? ' checked' : ''}></div>`;
};
// Fixed sample values show what a template reads like; the real text comes from the engine.
const templateSamples = () => ({ user_name: t('小蘑菇'), gift_name: t('小花花'), gift_num: '10', guard_name: t('舰长'), price: '30' });
const templatePreview = (key, text) => {
  const sample = { ...templateSamples(), message: key === 'super_chat' ? t('祝直播顺利') : t('主播晚上好') };
  return String(text || '').replace(/\{(\w+)\}/g, (whole, field) => sample[field] ?? whole);
};
let dictionaryView = 'message_words';
let dataPanel = null;
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
const feedEvents = new Map();
let viewerContext = null;
let aliasReturnContext = null;
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
let queueSignature = '';
let feedLastKey = '';
const seenFeedKeys = new Set();
// When each line first appeared, so a render in the middle of its entrance resumes it.
const enteredAt = new Map();
const ENTER_MS = 600;
let unfoldState = null;
const foldingRows = new Map();
const FOLD_MS = 520;
let currentSpotKey = '';
let lastQueueCount = 0;
let lastSettingsTab = '';
let settingsInkTop = null;
// Preview-only choices for the OBS overlay page; they never reach OBS.
let overlayPreview = { backdrop: 'dark' };
let broadcastBusy = false;

// Motion: script-driven animations follow the same rules as CSS ones — none when the
// system asks for reduced motion, and none while the window is in the background.
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
function motionAllowed() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return document.documentElement?.dataset?.inactive !== 'true' && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
}

// Hiding stays immediate for the app's state; a detached copy plays the exit instead.
function leaveGhost(node, ms = 280) {
  if (!node || node.hidden || !node.parentNode || typeof node.cloneNode !== 'function' || !motionAllowed()) return;
  const ghost = node.cloneNode(true);
  ghost.removeAttribute('id');
  for (const child of ghost.querySelectorAll('[id]')) child.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.classList.add('leaving');
  node.after(ghost);
  setTimeout(() => ghost.remove(), ms);
}

// The new theme spreads as a circle from the button that was pressed.
function revealTheme(next, origin) {
  const root = document.documentElement;
  if (typeof document.startViewTransition !== 'function' || !motionAllowed()) { root.dataset.theme = next; return; }
  const rect = origin?.getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 80;
  const y = rect ? rect.top + rect.height / 2 : 20;
  root.style.setProperty('--reveal-x', `${x}px`);
  root.style.setProperty('--reveal-y', `${y}px`);
  root.style.setProperty('--reveal-r', `${Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))}px`);
  document.startViewTransition(() => { root.dataset.theme = next; });
}

function closeQueuePanel(focusPill = false) {
  const panel = document.querySelector('#queue-panel');
  if (!panel || panel.hidden) return;
  leaveGhost(panel, 220);
  panel.hidden = true;
  const pill = document.querySelector('#queue-pill');
  pill?.setAttribute('aria-expanded', 'false');
  if (focusPill) pill?.focus();
}
let spotlightStartedAt = 0;
let voiceBrowse = '';
let auditionPresetId = '';
let auditionStartedAt = 0;
let viewerOpenIdentity = '';
const viewerAliasSave = createAutosaveQueue({
  delay: 600,
  save: pending => {
    const rules = structuredClone(snapshot.rules);
    rules.user_words = (rules.user_words || []).filter(row => row.from !== pending.name);
    if (pending.to && pending.to !== pending.name) rules.user_words.push({ from: pending.name, to: pending.to });
    return command('rules.save', { rules }, { quiet: true, silent: true });
  },
  onError: showError,
});
const markupCache = new WeakMap();
function patchMarkup(node, html) {
  if (!node || markupCache.get(node) === html) return;
  node.innerHTML = html;
  markupCache.set(node, html);
}
const seenPlaybackRecords = new Set();
let localRefreshBusy = false;
let localRefreshAt = 0;
let localRefreshSignature = '';

let fallbackStatus = '';
let fallbackStatusTimer = null;
let snapshotTimer = null;
let windowFocused = document.hasFocus();
let nativeActive = null;
let effectiveActive = null;
const invoke = (command, args) => {
  if (!window.__TAURI__?.core?.invoke) return Promise.reject(new Error(t('桌面连接不可用，请从超绝可爱弹幕姬程序打开。 [DV-UI02]')));
  return window.__TAURI__.core.invoke(command, args).catch(error => { throw new Error(errorMessage(error, command === 'snapshot' ? 'DV-X12' : command === 'check_update' ? 'DV-U01' : 'DV-UI02')); });
};

function showToast(message, isError = false) {
  const target = document.querySelector('#toast');
  clearTimeout(toastTimer);
  target.classList.add('toast');
  target.textContent = String(message);
  target.classList.toggle('error', isError);
  target.hidden = false;
  toastTimer = setTimeout(() => { leaveGhost(target, 260); target.hidden = true; }, isError ? 8000 : 3000);
}

function showError(error) {
  errorText = errorMessage(error);
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
      window.sessionStorage?.setItem('danmakuvoice.startupTheme', JSON.stringify({ session: startupTheme.session, appearance, language: startupTheme.language }));
      startupTheme.appearance = appearance;
    } catch { /* Theme changes still work when browser storage is unavailable. */ }
  }
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
}

function applyLanguage() {
  const changed = setLanguage(snapshot?.preferences?.language);
  document.documentElement.lang = getLanguage();
  document.title = t('超绝可爱弹幕姬');
  const startupTheme = window.__DANMAKUVOICE_STARTUP_THEME__;
  if (startupTheme?.session && startupTheme.language !== getLanguage()) {
    startupTheme.language = getLanguage();
    try {
      window.sessionStorage?.setItem('danmakuvoice.startupTheme', JSON.stringify(startupTheme));
    } catch { /* The persisted desktop preference remains authoritative. */ }
  }
  return changed;
}

function acceptSnapshot(next) {
  snapshot = mergeSnapshot(snapshot, next);
  applyAppearance();
  const languageChanged = applyLanguage();
  if (!step) { step = startingStep(snapshot);  setupTts = snapshot.setup?.tts_enabled ?? true; renderApp(); }
  else if (languageChanged) renderApp();
  if (languageChanged && settingsDialog.open) renderSettings();
  if (snapshot.onboarding_done && step !== 'main') { stopQrPolling(); step = 'main'; renderApp(); }
  if (step === 'main') updateLive();
  if (settingsDialog.open) { updateVoiceSettings(); updateServiceIndicators(); updateOverlayStatus(); updateBroadcastSettings(); }
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


function qrMarkup(provider, inSettings = false) {
  return ui`<div class="${inSettings ? 'settings-qr' : ''}" data-qr-provider="${provider}"><div class="qr-frame"><div class="qr-placeholder"><span class="spinner" aria-hidden="true"></span><span>正在生成二维码</span></div></div><div class="qr-status" role="status" aria-live="polite"><span class="status-dot pulse"></span><span data-qr-label>正在生成二维码</span></div><div class="actions qr-retry" hidden>${button(t('重新生成二维码'), 'qr.retry', { icon: 'refresh', class: 'quiet small' })}</div></div>`;
}

function renderApp() {
  clearFoldingRows();
  app.setAttribute('aria-busy', 'false');
  document.documentElement.dataset.step = step || '';
  const titlebarActions = document.querySelector('#titlebar-actions');
  if (titlebarActions) titlebarActions.innerHTML = step ? iconButton('moon', t('切换深浅色'), 'theme.toggle') + iconButton('settings', t('打开设置'), 'settings.open') : '';
  updateTitlebar();
  if (step === 'main') {
    const volume = Math.round((snapshot.preferences?.master_volume ?? 1) * 100);
    app.innerHTML = ui`<div class="app-shell live-shell" id="live-shell"><div class="live-aura one" aria-hidden="true"></div><div class="live-aura two" aria-hidden="true"></div><div class="live-grain" aria-hidden="true"></div>${snapshot.network_disabled ? t('<div class="test-mode-note" role="status">离线测试窗口 · 独立测试数据</div>') : ''}<main class="chat-main live-stage"><header class="masthead"><div class="masthead-kicker" id="masthead-kicker"><span id="connection-dot" class="status-dot"></span><span aria-hidden="true">LIVE</span><span id="room-caption" class="sr-only"></span></div><h1 class="masthead-title"><span id="masthead-name" class="masthead-name"></span><span id="masthead-suffix" class="masthead-suffix"></span></h1><span class="masthead-rule" aria-hidden="true"></span></header><div class="onair-wrap" data-broadcast-scope="main"><div id="onair" class="onair" role="group" aria-label="开播" hidden></div><div id="onair-panel" class="onair-panel" role="dialog" aria-label="开播" hidden></div></div><div id="live-error" class="live-error" role="status" hidden><span></span>${button(t('查看'), 'settings.room', { class: 'quiet small' })}</div><div id="chat-scroll" class="chat-scroll" tabindex="0" aria-label="收到的弹幕"><div id="chat-empty" class="chat-empty"></div><div id="chat-feed" class="chat-feed" role="log" aria-label="实时弹幕" aria-live="polite" aria-relevant="additions"></div></div><button id="new-messages" class="new-messages" data-action="chat.bottom" hidden>${icon('down')}回到最新弹幕</button></main><div class="dock-wrap"><div id="tts-menu" class="voice-panel" role="dialog" aria-label="播报声音" hidden></div><div id="queue-panel" class="queue-panel" role="list" aria-label="待读弹幕" hidden></div><div class="dock"><button type="button" id="tts-switch" class="dock-voice" data-action="tts.open" aria-haspopup="dialog" aria-expanded="false"></button><span class="dock-sep" aria-hidden="true"></span><div class="dock-volume"><button type="button" class="dock-mute" data-action="audio.mute"></button><label class="sr-only" for="main-volume-range">播报主音量</label><input id="main-volume-range" type="range" min="0" max="200" step="5" value="${volume}"><output id="main-volume-value" for="main-volume-range">${volume}</output></div><span id="queue-sep" class="dock-sep" aria-hidden="true" hidden></span><button type="button" id="queue-pill" class="queue-pill" data-action="queue.toggle" aria-expanded="false" hidden></button><span class="dock-sep" aria-hidden="true"></span><button type="button" id="speech-switch" class="speech-switch" role="switch" data-action="speech.toggle" aria-label="弹幕播报" aria-checked="false"><span></span></button></div></div><div id="viewer-drawer" class="viewer-layer" hidden></div></div>`;
    feedSignature = ''; feedLastKey = ''; onAirSignature = ''; onAirPanelMode = ''; feedEvents.clear(); viewerContext = null; viewerOpenIdentity = ''; liveMainSignature = ''; liveRenderSignature = ''; queueSignature = '';
    document.querySelector('#chat-scroll').addEventListener('scroll', event => {
      const node = event.currentTarget;
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 70) document.querySelector('#new-messages').hidden = true;
      updateFeedDepth();
    }, { passive: true });
    updateLive();
    return;
  }
  const note = snapshot.network_disabled ? t('<div class="test-mode-note" role="status">离线测试窗口 · 独立测试数据</div>') : '';
  if (step === 'welcome') {
    app.innerHTML = ui`<div class="app-shell onboard-shell">${note}<div class="onboard-aura one" aria-hidden="true"></div><div class="onboard-aura two" aria-hidden="true"></div><main class="welcome"><div class="welcome-mark" aria-hidden="true"><span></span><span></span><span></span><img src="./logo.png" width="148" height="148" alt="" draggable="false"></div><h1>超绝可爱弹幕姬</h1><p>接收 B 站直播弹幕，用你喜欢的声音读出来。</p><button type="button" class="onboard-cta" data-action="setup.start">开始设置${icon('arrow')}</button><p class="welcome-foot">${icon('shield')}登录凭据仅加密保存在这台电脑</p></main></div>`;
    return;
  }
  const phase = ['connect', 'login', 'uid'].includes(step) ? 1 : ['tts', 'doubaoQr'].includes(step) ? 2 : 3;
  const roomDone = !!snapshot.setup?.room_id;
  const stepSubs = [
    snapshot.setup?.mode === 'anonymous' && roomDone ? t('通过主播 UID') : roomDone ? t('扫码登录') : t('扫码或输入 UID'),
    phase > 2 ? (setupTts ? t('豆包') : t('仅显示弹幕')) : t('可跳过'),
    t('开始接收弹幕'),
  ];
  const rail = [t('连接直播间'), t('语音播报'), t('完成')].map((title, index) => {
    const state = index + 1 === phase ? 'active' : index + 1 < phase ? 'done' : '';
    return `<li class="${state}"><span class="onboard-index">${index + 1}</span><span class="onboard-label"><strong>${esc(title)}</strong><small>${esc(stepSubs[index])}</small></span></li>`;
  }).join('');
  app.innerHTML = ui`<div class="app-shell onboard-shell">${note}<div class="onboard-aura one" aria-hidden="true"></div><div class="onboard-aura two" aria-hidden="true"></div><div class="onboard-body"><aside class="onboard-rail"><span class="onboard-kicker">首次设置</span><ol>${rail}</ol></aside><main class="onboarding"><section class="setup-card ${step === 'login' || step === 'doubaoQr' ? 'qr-stage' : ''}" aria-label="初次设置">${renderStep()}</section></main></div></div>`;
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
  const back = step === 'ready' && snapshot.onboarding_done ? '' : ui`<button type="button" class="back-button" data-action="setup.back">${icon('back')}返回</button>`;
  if (step === 'connect') return ui`${back}<h1>连接直播间</h1><p class="setup-description">选择接收弹幕的方式，之后也可以在设置里更改。</p><div class="choice-grid"><button type="button" class="choice-card" data-action="setup.qr"><span class="choice-top"><span class="choice-glyph pink">${icon('qr')}</span><span class="choice-badge">推荐</span></span><strong>扫码登录</strong><span>用哔哩哔哩 App 扫码，自动找到你的直播间。</span></button><button type="button" class="choice-card" data-action="setup.uid"><span class="choice-top"><span class="choice-glyph blue">${icon('person')}</span></span><strong>输入主播 UID</strong><span>免登录，接收任意主播直播间的弹幕。</span></button></div>${errorSlot()}`;
  if (step === 'login') return ui`${back}<div class="qr-layout"><div class="qr-copy"><h1>用哔哩哔哩扫码</h1><ol class="qr-steps"><li><span>1</span>打开哔哩哔哩 App，扫描二维码</li><li><span>2</span>在手机上确认登录</li></ol><button type="button" class="text-link onboard-link" data-action="setup.uid">改用主播 UID</button></div>${qrMarkup('bilibili')}</div>${errorSlot()}`;
  if (step === 'uid') return ui`${back}<h1>输入主播 UID</h1><p class="setup-description">填写主播个人主页中的 UID，会自动查找直播间。</p><form data-form="anonymous" class="anonymous-form uid-form"><label for="anonymous-uid" class="onboard-field-label">主播 UID</label><div class="anonymous-input"><input id="anonymous-uid" name="uid" inputmode="numeric" autocomplete="off" placeholder="输入主播 UID" required pattern="[1-9][0-9]{0,19}" maxlength="20"><button type="submit" class="onboard-cta" aria-label="使用主播 UID 匿名继续">继续 ${icon('arrow')}</button></div></form>${errorSlot()}`;
  if (step === 'tts') return ui`${back}<h1>要读出弹幕吗？</h1><p class="setup-description">其他语音服务可以稍后在设置中添加。</p><div class="choice-grid"><button type="button" class="choice-card" data-action="setup.doubao"><span class="choice-top"><span class="choice-glyph gradient">${icon('voice')}</span></span><strong>用豆包朗读</strong><span>扫码连接豆包，使用默认音色朗读新弹幕。</span></button><button type="button" class="choice-card" data-action="setup.silent"><span class="choice-top"><span class="choice-glyph quiet">${icon('chatSmall')}</span></span><strong>暂时只看弹幕</strong><span>不需要音频设备，随时可以在设置中开启。</span></button></div>${errorSlot()}`;
  if (step === 'doubaoQr') return ui`${back}<div class="qr-layout"><div class="qr-copy"><h1>扫码连接豆包</h1><ol class="qr-steps"><li><span>1</span>打开豆包 App，扫描二维码</li><li><span>2</span>在手机上确认登录</li></ol><button type="button" class="text-link onboard-link" data-action="setup.silent">暂时只看弹幕</button></div>${qrMarkup('doubao')}</div>${errorSlot()}`;
  const room = snapshot.setup?.room_id;
  const voice = setupTts ? `${providerLabel(snapshot.presets?.find(p => p.id === snapshot.rules?.default_preset_id)?.provider || 'doubao')}` : t('仅显示弹幕');
  return ui`${back}<h1>一切就绪</h1><dl class="setup-summary-card"><div><dt>直播间</dt><dd>${snapshot.setup?.mode === 'anonymous' ? t('匿名接收') : t('我的直播间')} · <span class="num">${esc(room || '')}</span></dd></div><div><dt>播报</dt><dd>${esc(voice)}</dd></div></dl><button type="button" class="onboard-cta" data-action="setup.finish">开始接收弹幕${icon('arrow')}</button>${errorSlot()}`;
}

function updateQr() {
  for (const container of document.querySelectorAll('[data-qr-provider]')) {
    const matching = snapshot?.qr?.provider === container.dataset.qrProvider;
    const qr = matching ? snapshot.qr : { status: 'idle' };
    const needsRoom = matching && qrNeedsRoomFallback(snapshot);
    if (snapshot?.network_disabled) {
      if (container.dataset.renderSignature !== 'offline') {
        container.dataset.renderSignature = 'offline';
        container.querySelector('.qr-frame').innerHTML = t('<div class="qr-placeholder">离线测试窗口</div>');
        container.querySelector('[data-qr-label]').textContent = t('扫码请直接打开正式程序');
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
      if (needsRoom) frame.innerHTML = ui`<div class="qr-placeholder">${icon('check')}<span>账号已登录<br>请改用主播 UID</span></div>`;
      else if (qrFailure) frame.innerHTML = ui`<div class="qr-placeholder">${icon('qr')}<span>暂时无法生成二维码<br>请稍后重新尝试</span></div>`;
      else if (qr.status === 'expired') frame.innerHTML = ui`<div class="qr-placeholder">${icon('refresh')}<span>二维码已过期<br>重新生成后再扫码</span></div>`;
      else if (qr.status === 'complete') frame.innerHTML = ui`<div class="qr-placeholder">${icon('check')}<span>已完成登录</span></div>`;
      else if (url) { const image = document.createElement('img'); image.src = url; image.alt = container.dataset.qrProvider === 'bilibili' ? t('哔哩哔哩登录二维码') : t('豆包登录二维码'); frame.replaceChildren(image); }
      else frame.innerHTML = ui`<div class="qr-placeholder"><span class="spinner" aria-hidden="true"></span><span>正在生成二维码</span></div>`;
    }
    container.querySelector('[data-qr-label]').textContent = needsRoom ? t('未找到本账号直播间；可填写主播 UID 匿名接收') : qrFailure || qrLabel(qr);
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
  } catch (error) {
    qrFailure = errorMessage(error, provider === 'bilibili' ? 'DV-X01' : 'DV-X02');
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
          if (preferenceError) showError(ui`豆包已连接，但设为首选失败：${preferenceError}`);
          else showToast(provider === 'bilibili' ? t('哔哩哔哩已连接') : preferredId ? t('豆包已连接并设为首选') : t('豆包已连接'));
        }
        else if (provider === 'bilibili' && step === 'login' && next.setup?.room_id) setStep('tts');
        else if (provider === 'doubao' && step === 'doubaoQr') { setupTts = true; setStep('ready'); }
      } else if (next.qr?.status !== 'expired') scheduleQrPoll(provider, generation);
    } catch (error) {
      const needsRoom = qrNeedsRoomFallback(snapshot);
      qrFailure = needsRoom ? '' : errorMessage(error, provider === 'bilibili' ? 'DV-X01' : 'DV-X02');
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

function updateTitlebar() {
  const name = document.querySelector('[data-titlebar-name]');
  if (name) name.textContent = t('超绝可爱弹幕姬');
  for (const [kind, label] of [['minimize', t('最小化')], ['maximize', t('最大化')], ['close', t('关闭')]]) {
    const control = document.querySelector(`#titlebar [data-window="${kind}"]`);
    if (control) { control.setAttribute('aria-label', label); control.title = label; }
  }
}

// The masthead names whose room this is; a broadcaster name is only known for the signed-in account.
function mastheadView(snapshot) {
  const identity = headerIdentity(snapshot);
  const room = snapshot.live?.room_id || snapshot.setup?.room_id;
  if (snapshot.setup?.mode === 'account' && identity.loggedIn) return { name: identity.name, suffix: t('的直播间') };
  return { name: t('直播间'), suffix: room ? String(room) : '' };
}

// Match the job being read to the chat line it came from. Jobs carry the final spoken text,
// which templates and dictionaries may rewrite, so match a line from that viewer whose
// original text still appears in the spoken text. Once a job has a line it keeps it: a later
// message with the same words must not move the card while the first one is still read.
let spotBinding = { job: null, key: '' };
function spotlightKey(events, keys, current) {
  if (!current || current.origin === 'audition' || !current.user_name) return '';
  const job = current.id ?? null;
  if (job !== null && spotBinding.job === job && keys.includes(spotBinding.key)) return spotBinding.key;
  // Jobs are read in order, so a new job prefers the first matching line after the last card.
  const after = spotBinding.key ? keys.indexOf(spotBinding.key) : -1;
  let first = '';
  let newest = '';
  let fallback = '';
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.user_name !== current.user_name) continue;
    fallback = keys[i];
    const text = eventText(event);
    if (!text || !String(current.text || '').includes(text)) continue;
    newest = keys[i];
    if (!first && after >= 0 && i > after) first = keys[i];
  }
  const key = first || newest || fallback;
  if (job !== null) spotBinding = { job, key };
  return key;
}

// Queue rows show what the viewer actually wrote, not the templated speech text.
function jobDisplayText(job, events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.user_name !== job.user_name) continue;
    const text = eventText(event);
    if (text && String(job.text || '').includes(text)) return text;
  }
  return job.text || '';
}

function viewerIdentity(event) {
  if (!event) return '';
  return validUid(event.user_id) ? `uid:${event.user_id}` : `name:${String(event.user_name || '').trim()}`;
}

function viewerBinding(event) {
  const hasUid = validUid(event?.user_id);
  return (snapshot.bindings || []).find(entry => hasUid
    ? String(entry.binding.user_id) === String(event.user_id)
    : !entry.binding.user_id && entry.binding.user_name === event?.user_name);
}

function viewerAlias(event) {
  const name = String(event?.user_name || '');
  return (snapshot.rules?.user_words || []).find(row => row.from === name)?.to || '';
}

function viewerVoiceTag(event) {
  const record = viewerBinding(event);
  if (!record?.binding?.enabled) return '';
  const preset = snapshot.presets?.find(item => item.id === record.binding.preset_id);
  return preset ? presetLabel(preset) : '';
}

function viewerAvatar(event, large = false) {
  const url = safeMediaUrl(event?.avatar_url);
  return `<span class="avatar ${large ? 'avatar-large ' : ''}color-${identityColor(event?.user_id || event?.user_name)}" aria-hidden="true"><span class="avatar-initial">${esc(initial(event?.user_name))}</span>${url ? `<img class="avatar-photo" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>`;
}

function clockLabel(ms) {
  const date = new Date(Number(ms) || 0);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Group the feed: consecutive chat lines from one viewer form one block, gaps of five
// minutes or more get a time divider, and the line being read becomes its own card.
function feedItems(events, keys, spotKey, folding = new Set()) {
  const items = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const key = keys[i];
    const previous = events[i - 1];
    if (previous && Number(event.observed_at_ms) - Number(previous.observed_at_ms) >= 300000) items.push({ type: 'time', at: event.observed_at_ms, last: i });
    const isSpot = key === spotKey;
    const kind = ['gift', 'guard', 'super_chat'].includes(event.kind) ? event.kind : 'run';
    if (isSpot) { items.push({ type: 'spot', event, key, last: i }); continue; }
    const tail = items.at(-1);
    if (kind === 'run' && !folding.has(key) && tail?.type === 'run' && !folding.has(tail.key) && tail.viewer === viewerIdentity(event)) { tail.events.push(event); tail.keys.push(key); tail.last = i; continue; }
    if (kind === 'run') items.push({ type: 'run', viewer: viewerIdentity(event), events: [event], keys: [key], key, last: i });
    else items.push({ type: kind, event, key, last: i });
  }
  return items;
}

// `entering` maps keys still in their entrance to the milliseconds already played.
function feedItemHtml(item, entering) {
  const isFresh = key => entering === true || (entering instanceof Map && entering.has(key));
  const delay = key => { const played = entering instanceof Map ? entering.get(key) : 0; return played > 0 ? ` style="animation-delay:-${Math.round(played)}ms"` : ''; };
  const enter = isFresh(item.key) ? ' enter' : '';
  const enterStyle = enter ? delay(item.key) : '';
  if (item.type === 'time') return `<div class="chat-time${entering ? ' enter' : ''}" data-last="${item.last}" data-key="time:${esc(item.at)}"><span></span><time>${esc(clockLabel(item.at))}</time><span></span></div>`;
  const event = item.event || item.events[0];
  const name = esc(event.user_name || t('访客'));
  const selected = viewerOpenIdentity && viewerIdentity(event) === viewerOpenIdentity ? ' selected' : '';
  const tag = viewerVoiceTag(event);
  const tagHtml = tag ? `<span class="voice-tag">${esc(tag)}</span>` : '';
  const label = esc(`${t('设置观众声音或别名：')}${event.user_name || t('访客')}`);
  const keyAttr = item.type === 'run' ? '' : ` data-key="${esc(item.key)}"`;
  const open = (body, cls) => `<article class="chat-item ${cls}${selected}${enter}" data-last="${item.last}"${keyAttr}${enterStyle}><button type="button" class="chat-hit" data-action="viewer.open" data-id="${esc(item.key)}" aria-label="${label}">${body}</button></article>`;
  if (item.type === 'guard') return `<div class="chat-item chat-guard${enter}" data-last="${item.last}"${keyAttr}${enterStyle}><span></span><p><strong>${name}</strong> ${esc(ui`开通了${event.guard_name || t('大航海')}`)}</p><span></span></div>`;
  if (item.type === 'gift') return open(`${viewerAvatar(event)}<span class="gift-text"><span class="gift-name">${name}</span> ${esc(t('赠送'))} <strong>${esc(event.gift_name || t('礼物'))}</strong></span>${event.quantity > 1 ? `<span class="gift-count">×${esc(event.quantity)}</span>` : ''}`, 'chat-gift');
  if (item.type === 'super_chat') return open(`<span class="sc-head"><span class="sc-tag">${esc(t('醒目留言'))}</span><span class="sc-name">${name}</span>${tagHtml}${event.price_yuan ? `<span class="sc-price">¥${esc(event.price_yuan)}</span>` : ''}</span><span class="sc-text">${renderChatBody(event)}</span>`, 'chat-sc');
  if (item.type === 'spot') {
    const duration = Math.min(25, Math.max(1.6, eventText(event).length / 4.2));
    const elapsed = Math.max(0, (Date.now() - spotlightStartedAt) / 1000);
    return open(`<span class="spot-head">${viewerAvatar(event)}<span class="spot-name">${name}</span>${tagHtml}<span class="reading-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span></span><span class="spot-text">${renderChatBody(event)}</span><span class="spot-progress" aria-hidden="true"><i style="animation-duration:${duration.toFixed(1)}s;animation-delay:-${Math.min(elapsed, duration).toFixed(2)}s"></i></span>`, 'chat-spot');
  }
  return open(`${viewerAvatar(event)}<span class="run-body"><span class="run-name"><span class="run-user-name">${name}</span>${tagHtml}</span>${item.events.map((line, index) => { const key = item.keys?.[index] || ''; const lineEnter = index > 0 && isFresh(key); return `<span class="run-line${lineEnter ? ' enter' : ''}" data-key="${esc(key)}"${lineEnter ? delay(key) : ''}>${renderChatBody(line)}</span>`; }).join('')}</span>`, 'chat-run');
}

function feedPinned(scroll) {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
}

// Dim by distance from the line being read only while the newest messages are in view.
function updateFeedDepth() {
  const scroll = document.querySelector('#chat-scroll');
  if (!scroll) return;
  const nodes = [...document.querySelectorAll('#chat-feed [data-last]')];
  const pinned = feedPinned(scroll);
  const spot = document.querySelector('#chat-feed .chat-spot');
  const focus = spot ? Number(spot.dataset.last) : -1;
  const last = feedEvents.size - 1;
  for (const node of nodes) {
    const index = Number(node.dataset.last);
    const distance = focus >= 0 ? Math.abs(index - focus) : last - index;
    const opacity = !pinned ? 1 : focus >= 0 ? Math.max(0.3, 1 - distance * 0.16) : Math.max(0.45, 1 - Math.max(0, distance - 2) * 0.1);
    node.style.setProperty('--depth', String(Number(opacity.toFixed(2))));
  }
}

function renderFeed(events, keys) {
  const scroll = document.querySelector('#chat-scroll');
  const feed = document.querySelector('#chat-feed');
  if (!scroll || !feed) return;
  const enabled = !!(snapshot.setup?.tts_enabled ?? snapshot.preferences?.tts_enabled);
  const spotKey = enabled ? spotlightKey(events, keys, snapshot.queue?.current) : '';
  const previousSpot = currentSpotKey;
  if (spotKey !== currentSpotKey) { currentSpotKey = spotKey; spotlightStartedAt = Date.now(); }
  const signature = JSON.stringify([keys, spotKey, viewerOpenIdentity, snapshot.bindings, (snapshot.presets || []).map(item => [item.id, item.name, item.voice_id]), getLanguage()]);
  if (signature === feedSignature) { updateFeedDepth(); return; }
  const pinned = feedPinned(scroll);
  const before = scroll.scrollTop;
  const motion = feedSignature !== '' && motionAllowed();
  // Where every line sat before this render, so moved lines can glide instead of jump.
  const previous = motion ? measureFeed(feed) : null;
  const oldSpot = motion && previousSpot && previousSpot !== spotKey ? feed.querySelector('.chat-spot') : null;
  // Capture the actual visible components, including an interrupted transition. There
  // is only one text/avatar/name: the normal row itself shrinks out of the card.
  if (!motion) clearFoldingRows();
  else {
    for (const [key, fold] of foldingRows) {
      if (!keys.includes(key) || key === spotKey || fold.until <= performance.now()) { clearFold(key); continue; }
      if (fold.item?.isConnected) fold.from = measureFold(fold.item);
    }
    const completed = events[keys.indexOf(previousSpot)];
    if (oldSpot && completed && !['gift', 'guard', 'super_chat'].includes(completed.kind)) {
      const from = measureFold(oldSpot, true);
      if (from) foldingRows.set(previousSpot, { from, until: performance.now() + FOLD_MS });
    }
  }
  feedEvents.clear();
  keys.forEach((key, index) => feedEvents.set(key, events[index]));
  const items = feedItems(events, keys, spotKey, new Set(foldingRows.keys()));
  const now = performance.now();
  if (feedSignature !== '') for (const key of keys) if (key && !seenFeedKeys.has(key)) enteredAt.set(key, now);
  const entering = feedSignature === '' ? null : new Map();
  if (entering) for (const [key, at] of enteredAt) { if (now - at < ENTER_MS) entering.set(key, now - at); else enteredAt.delete(key); }
  feed.innerHTML = items.map(item => feedItemHtml(item, item.type === 'time' ? entering?.get(keys[item.last]) === 0 : entering)).join('');
  for (const key of keys) seenFeedKeys.add(key);
  while (seenFeedKeys.size > 400) seenFeedKeys.delete(seenFeedKeys.values().next().value);
  const grew = feedSignature !== '' && keys.at(-1) !== feedLastKey;
  feedSignature = signature;
  feedLastKey = keys.at(-1) || '';
  if (pinned) {
    setScrollTop(scroll, scroll.scrollHeight);
    // Transformed content can temporarily enlarge scrollHeight. Repinning against
    // that animated overflow would move every component after measuring its start.
    requestAnimationFrame(() => { if (!motion && feedPinned(scroll)) setScrollTop(scroll, scroll.scrollHeight); updateFeedDepth(); });
  } else { setScrollTop(scroll, before); if (grew) document.querySelector('#new-messages').hidden = false; }
  updateFeedDepth();
  // A card that was already on screen (as a card or as a row) must not replay its intro.
  const spotNode = spotKey ? feed.querySelector('.chat-spot') : null;
  if (spotNode && previous?.has(spotKey)) spotNode.classList.add('settled');
  if (previous) animateFeed(scroll, feed, previous, { previousSpot, spotKey });
}

function setScrollTop(scroll, top) {
  // The stage scrolls smoothly for people; programmatic jumps must land at once so that
  // positions can be measured for the glide.
  if (typeof scroll.scrollTo === 'function') scroll.scrollTo({ top, behavior: 'instant' });
  else scroll.scrollTop = top;
}

function measureFeed(feed) {
  const positions = new Map();
  for (const node of feed.querySelectorAll('[data-key]')) {
    const rect = node.getBoundingClientRect();
    positions.set(node.dataset.key, { top: rect.top, height: rect.height });
  }
  return positions;
}

// FLIP: each block starts where its first line used to be and settles into place. The line
// being read unfolds from its old row into the card; the actual normal row shrinks
// from the card when reading finishes, with no detached duplicate or text fade.
function animateFeed(scroll, feed, previous, spot) {
  const bounds = scroll.getBoundingClientRect();
  const nearView = rect => rect.bottom > bounds.top - 120 && rect.top < bounds.bottom + 120;
  for (const item of feed.children) {
    const anchor = item.dataset.key ? item : item.querySelector('[data-key]');
    const before = anchor && previous.get(anchor.dataset.key);
    if (!before) continue;
    const fold = foldingRows.get(anchor.dataset.key);
    if (fold) { foldRow(item, anchor, fold); continue; }
    const rect = anchor.getBoundingClientRect();
    if (!nearView(rect)) continue;
    const dy = before.top - rect.top;
    if (item.classList.contains('chat-spot') && anchor.dataset.key !== spot.previousSpot) { unfoldSpot(item, dy, before.height); continue; }
    if (item.classList.contains('chat-spot') && unfoldState?.key === anchor.dataset.key) resumeUnfold(item);
    if (Math.abs(dy) >= 0.5) item.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 520, easing: EASE_OUT });
    // A finished standalone line rejoins the viewer's block after the shrink. Glide
    // the other lines inside that block too, without moving its name/avatar twice.
    for (const line of item.querySelectorAll('.run-line')) {
      if (line === anchor || line.classList.contains('enter')) continue;
      const lineBefore = previous.get(line.dataset.key);
      if (!lineBefore) continue;
      const offset = lineBefore.top - line.getBoundingClientRect().top;
      if (Math.abs(offset) >= 0.5) line.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], { duration: 520, easing: EASE_OUT });
    }
  }
}

function unfoldSpot(item, dy, rowHeight) {
  const card = item.querySelector('.chat-hit');
  if (!card) return;
  const height = card.getBoundingClientRect().height;
  unfoldState = { key: item.dataset.key, start: performance.now(), dy, keep: Math.max(rowHeight + 20, 44), height };
  playUnfold(item, 0);
}

// A new message during the unfold rebuilds the card; continue from the same moment.
function resumeUnfold(item) {
  const played = performance.now() - unfoldState.start;
  if (played >= 640) { unfoldState = null; return; }
  playUnfold(item, played);
}

function playUnfold(item, played) {
  const card = item.querySelector('.chat-hit');
  if (!card) return;
  const { dy, keep, height } = unfoldState;
  item.classList.add('settled', 'unfolding');
  const unfold = card.animate([
    { transform: `translateY(${dy}px) scale(.985)`, clipPath: `inset(0 0 ${Math.max(0, height - keep)}px 0 round 16px)`, opacity: .55 },
    { transform: 'none', clipPath: 'inset(0 0 0 0 round 24px)', opacity: 1 },
  ], { duration: 640, easing: 'cubic-bezier(.22,.9,.22,1)' });
  const text = card.querySelector('.spot-text')?.animate([
    { opacity: 0, transform: 'translateY(8px)', filter: 'blur(6px)' },
    { opacity: 1, transform: 'none', filter: 'blur(0)' },
  ], { duration: 560, delay: 140, easing: EASE_OUT, fill: 'backwards' });
  if (played) { unfold.currentTime = played; if (text) text.currentTime = played; }
  const done = () => { if (item.isConnected) item.classList.remove('unfolding'); };
  unfold.finished.then(done, done);
}

function measureFold(item, spotlight = false) {
  const part = selector => {
    const node = item.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { rect, style: Object.fromEntries(['fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'color', 'backgroundColor', 'borderColor', 'borderRadius', 'boxShadow'].map(name => [name, style[name]])) };
  };
  return {
    surface: part(spotlight ? '.chat-hit' : '.spot-fold-surface'),
    avatar: part('.avatar'), name: part(spotlight ? '.spot-name' : '.run-user-name'),
    text: part(spotlight ? '.spot-text' : '.run-line'), tag: part('.voice-tag'),
  };
}

function clearFold(key) {
  const fold = foldingRows.get(key);
  if (!fold) return;
  foldingRows.delete(key);
  clearTimeout(fold.timer);
  for (const animation of fold.animations || []) animation.cancel();
  fold.item?.classList.remove('folding');
  fold.item?.querySelector('.spot-fold-surface')?.remove();
  for (const node of fold.item?.querySelectorAll('.run-body,.run-name,.run-line') || []) node.style.removeProperty('height');
}

function clearFoldingRows() {
  for (const key of foldingRows.keys()) clearFold(key);
}

function foldRow(item, line, fold) {
  const duration = fold.until - performance.now();
  if (duration <= 0 || !fold.from?.text) { clearFold(line.dataset.key); return; }
  // Keep this row separate until it settles, so the avatar/name of an existing
  // group do not disappear or overlap while consecutive messages are reading.
  item.classList.remove('enter');
  line.classList.remove('enter');
  item.classList.add('folding');
  const hit = item.querySelector('.chat-hit');
  const surface = document.createElement('span');
  surface.className = 'spot-fold-surface';
  surface.setAttribute('aria-hidden', 'true');
  hit.prepend(surface);
  // Typography changes must not resize the feed on every animation frame. Its final
  // layout stays fixed while the visible components glide over that layout.
  for (const node of item.querySelectorAll('.run-body,.run-name,.run-line')) node.style.height = `${node.getBoundingClientRect().height}px`;
  const animations = [];
  const frames = [];
  const glide = (node, from, properties, scale = false) => {
    if (!node || !from) return;
    const to = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const resize = scale ? ` scale(${from.rect.width / Math.max(1, to.width)},${from.rect.height / Math.max(1, to.height)})` : '';
    const start = { transform: `translate(${from.rect.left - to.left}px,${from.rect.top - to.top}px)${resize}`, transformOrigin: '0 0' };
    const end = { transform: 'none', transformOrigin: '0 0' };
    for (const property of properties) { start[property] = from.style[property]; end[property] = style[property]; }
    if (node === line) { start.width = `${from.rect.width}px`; end.width = `${to.width}px`; }
    frames.push({ node, start, end });
  };
  glide(surface, fold.from.surface, ['backgroundColor', 'borderColor', 'borderRadius', 'boxShadow'], true);
  glide(item.querySelector('.avatar'), fold.from.avatar, [], true);
  glide(item.querySelector('.run-user-name'), fold.from.name, ['fontSize', 'color']);
  glide(line, fold.from.text, ['fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'color']);
  glide(item.querySelector('.voice-tag'), fold.from.tag, [], true);
  for (const { node, start, end } of frames) animations.push(node.animate([start, end], { duration, easing: EASE_OUT }));
  fold.item = item;
  fold.animations = animations;
  clearTimeout(fold.timer);
  const settle = () => {
    if (foldingRows.get(line.dataset.key) !== fold || fold.item !== item || !item.isConnected) return;
    clearFold(line.dataset.key);
    // Regroup only after all the animated components have reached their row.
    feedSignature = 'fold-settled';
    renderFeed([...feedEvents.values()], [...feedEvents.keys()]);
  };
  animations[0]?.finished.then(settle, () => {});
  fold.timer = setTimeout(settle, duration + 40);
}

function renderDockVoice() {
  const switcher = document.querySelector('#tts-switch');
  if (!switcher) return;
  const preferred = snapshot.presets?.find(item => item.id === snapshot.rules?.default_preset_id);
  const title = preferred ? presetLabel(preferred) : t('选择声音');
  const service = preferred ? providerLabel(preferred.provider) : t('尚未设置音色');
  const signature = `${title}\u0000${service}`;
  if (switcher.dataset.label === signature) return;
  switcher.dataset.label = signature;
  switcher.innerHTML = `<span class="orb" aria-hidden="true"><span><i></i><i></i><i></i><i></i></span></span><span class="dock-voice-text"><span class="dock-voice-name">${esc(title)}</span><span class="dock-voice-service">${esc(service)}</span></span>${icon('up')}`;
  switcher.setAttribute('aria-label', `${t('播报声音')}：${title} · ${service}`);
}

function renderVoicePanel() {
  const panel = document.querySelector('#tts-menu');
  if (!panel) return;
  const preferred = snapshot.presets?.find(item => item.id === snapshot.rules?.default_preset_id);
  const browse = voiceBrowse || preferred?.provider || 'doubao';
  const services = serviceProviders.map(provider => {
    const status = providerStatus(provider, serviceConnection(provider));
    return `<button type="button" class="voice-service${provider === browse ? ' on' : ''}" data-action="voice.browse" data-id="${esc(provider)}"><span class="service-light ${status.tone}" aria-hidden="true"></span><span><span class="voice-service-name">${esc(providerLabel(provider))}</span><small>${esc(status.label)}</small></span></button>`;
  }).join('');
  const presets = (snapshot.presets || []).filter(item => item.provider === browse);
  const auditioning = snapshot.queue?.current?.origin === 'audition' || Date.now() - auditionStartedAt < 1500;
  let body;
  if (browse === 'doubao' && !doubaoConnection()?.has_credential) {
    body = `<div class="voice-empty"><p>${esc(t('扫码连接豆包后即可选择音色。'))}</p>${button(t('扫码连接'), 'voice.login', { class: 'small' })}</div>`;
  } else if (!presets.length) {
    const hint = browse === 'dots' ? t('选择 dots.tts 安装目录并添加参考音频后，这里会出现可选的音色。')
      : browse === 'gpt_sovits' ? t('选择 GPT-SoVITS 安装目录，会自动配对角色模型。')
      : t('先为这个服务添加音色');
    body = `<div class="voice-empty"><p>${esc(hint)}</p>${button(t('去设置'), 'settings.open', { class: 'small' })}</div>`;
  } else {
    body = `<div class="voice-rows">${presets.map(preset => {
      const on = preset.id === preferred?.id;
      const playing = auditioning && auditionPresetId === preset.id;
      return `<div class="voice-row${on ? ' on' : ''}"><button type="button" class="voice-pick" data-action="voice.pick" data-id="${esc(preset.id)}" aria-pressed="${on}"><span class="voice-radio" aria-hidden="true"><span></span></span><span>${esc(presetLabel(preset))}</span></button><button type="button" class="voice-play${playing ? ' busy' : ''}" data-action="voice.audition" data-id="${esc(preset.id)}" aria-label="${esc(`${t('试听')} ${presetLabel(preset)}`)}">${playing ? '<span class="reading-mark" aria-hidden="true"><i></i><i></i><i></i></span>' : icon('play')}</button></div>`;
    }).join('')}</div>`;
  }
  patchMarkup(panel, `<div class="voice-services"><span class="panel-kicker">${esc(t('服务'))}</span>${services}</div><div class="voice-list"><span class="panel-kicker">${esc(providerLabel(browse))}</span>${body}<div class="voice-foot"><span>${esc(t('选中即用于直播播报'))}</span><button type="button" class="text-link" data-action="settings.open">${esc(t('管理声音'))}${icon('arrow')}</button></div></div>`);
}

function closeVoicePanel() {
  const panel = document.querySelector('#tts-menu');
  if (panel) { leaveGhost(panel, 220); panel.hidden = true; }
  document.querySelector('#tts-switch')?.setAttribute('aria-expanded', 'false');
}

function pendingLiveJobs() {
  return (snapshot.queue?.pending || []).filter(job => job.origin !== 'audition');
}

function renderQueuePanel(events) {
  const panel = document.querySelector('#queue-panel');
  if (!panel) return;
  const pending = pendingLiveJobs();
  const signature = JSON.stringify(pending.slice(0, 8).map(job => [job.id, job.user_name, job.text]).concat([pending.length, getLanguage()]));
  if (queueSignature === signature) return;
  queueSignature = signature;
  panel.innerHTML = pending.slice(0, 8).map((job, index) => {
    const name = job.user_name || t('访客');
    const text = jobDisplayText(job, events);
    return `<button type="button" class="queue-item" role="listitem" data-action="queue.jump" data-id="${esc(job.id)}" aria-label="${esc(`${t('立即朗读')}：${name}：${text}`)}" title="${esc(t('立即朗读'))}" style="--queue-opacity:${Math.max(0.55, 1 - index * 0.1).toFixed(2)}"><span class="queue-index">${index + 1}</span><span class="queue-text"><span class="queue-name">${esc(name)}</span><span class="queue-line">${esc(text)}</span></span><span class="queue-play" aria-hidden="true">${icon('play')}</span></button>`;
  }).join('') + (pending.length > 8 ? `<p class="queue-more">+${pending.length - 8} ${esc(t('条'))}</p>` : '');
}

function viewerChipsHtml(event) {
  const record = viewerBinding(event);
  const bound = record?.binding?.enabled ? record.binding.preset_id : '';
  const canBind = validUid(event.user_id) || !!String(event.user_name || '').trim();
  const presets = snapshot.presets || [];
  const chips = [`<button type="button" class="voice-chip${bound ? '' : ' on'}" data-action="viewer.bind" data-id=""${canBind ? '' : ' disabled'}>${esc(t('跟随默认'))}</button>`]
    .concat(presets.map(preset => `<button type="button" class="voice-chip${bound === preset.id ? ' on' : ''}" data-action="viewer.bind" data-id="${esc(preset.id)}" title="${esc(providerLabel(preset.provider))}"${canBind ? '' : ' disabled'}>${esc(presetLabel(preset))}</button>`));
  const boundPreset = presets.find(item => item.id === bound);
  const preferred = presets.find(item => item.id === snapshot.rules?.default_preset_id);
  const note = !canBind ? t('这条弹幕没有可用用户名或 UID，无法指定声音。')
    : boundPreset ? ui`这位观众的弹幕将用「${presetLabel(boundPreset)}」朗读。`
    : preferred ? ui`使用当前直播声音「${presetLabel(preferred)}」朗读。` : t('请先添加一个声音预设');
  return `<div class="voice-chips">${chips.join('')}</div><p class="viewer-hint">${esc(note)}</p>`;
}

function renderViewerDrawer() {
  const layer = document.querySelector('#viewer-drawer');
  if (!layer) return;
  const event = viewerContext;
  if (!event) { leaveGhost(layer, 300); layer.hidden = true; layer.innerHTML = ''; return; }
  const alias = viewerAlias(event);
  const voiceMarkup = viewerChipsHtml(event);
  const uid = validUid(event.user_id) ? `<span class="viewer-uid">UID ${esc(event.user_id)}</span>` : '';
  layer.innerHTML = `<button type="button" class="viewer-scrim" data-action="viewer.close" aria-label="${esc(t('关闭观众卡片'))}"></button><aside class="viewer-sheet" role="dialog" aria-modal="true" aria-label="${esc(t('观众设置'))}"><header class="viewer-head">${viewerAvatar(event, true)}<div class="viewer-title"><span class="viewer-name">${esc(event.user_name || t('访客'))}</span>${uid}</div>${iconButton('close', t('关闭'), 'viewer.close')}</header><section class="viewer-section"><label class="panel-kicker" for="viewer-alias">${esc(t('读作'))}</label><input id="viewer-alias" class="viewer-alias" maxlength="40" autocomplete="off" placeholder="${esc(t('按原名朗读'))}" value="${esc(alias)}"${String(event.user_name || '').trim() ? '' : ' disabled'}><p class="viewer-hint">${esc(t('播报时这样称呼：'))}<strong id="viewer-spoken">${esc(alias || event.user_name || t('访客'))}</strong></p></section><section class="viewer-section"><span class="panel-kicker">${esc(t('专属音色'))}</span><div id="viewer-voices">${voiceMarkup}</div></section><footer class="viewer-foot">${button(t('试听'), 'viewer.audition', { class: 'small', icon: 'play' })}<button type="button" class="text-link" data-action="viewer.manage">${esc(t('管理全部观众'))}${icon('arrow')}</button></footer></aside>`;
  markupCache.set(layer.querySelector('#viewer-voices'), voiceMarkup);
  layer.hidden = false;
  requestAnimationFrame(() => layer.querySelector('#viewer-alias:not([disabled])')?.focus({ preventScroll: true }));
}

async function closeViewerDrawer() {
  if (!viewerContext) return;
  await flushViewerAlias();
  viewerContext = null;
  viewerOpenIdentity = '';
  renderViewerDrawer();
  feedSignature = '';
  if (step === 'main') { liveRenderSignature = ''; updateLive(); }
}

function scheduleViewerAlias(value) {
  const event = viewerContext;
  if (!event) return;
  const spoken = document.querySelector('#viewer-spoken');
  if (spoken) spoken.textContent = value.trim() || event.user_name || t('访客');
  const name = String(event.user_name || '');
  if (name) viewerAliasSave.schedule({ name, to: value.trim() });
}

async function flushViewerAlias() {
  if (viewerAliasSave.error) viewerAliasSave.retry();
  await viewerAliasSave.flush();
}

async function bindViewerVoice(presetId) {
  const event = viewerContext;
  if (!event) return;
  const hasUid = validUid(event.user_id);
  if (!hasUid && !String(event.user_name || '').trim()) throw new Error(t('这条弹幕没有可用用户名或 UID，无法指定声音。'));
  const record = viewerBinding(event);
  if (!presetId) {
    if (record) await command('bindings.delete', { id: record.id, confirmed: true }, { quiet: true });
  } else {
    await command('bindings.save', { id: record?.id || '', binding: { platform: 'bilibili', user_id: hasUid ? numericId(event.user_id) : null, user_name: hasUid ? null : event.user_name, legacy_user_name: record?.binding.legacy_user_name || null, preset_id: presetId, enabled: true } }, { quiet: true });
  }
  const voices = document.querySelector('#viewer-voices');
  if (voices && viewerContext) patchMarkup(voices, viewerChipsHtml(viewerContext));
}

function updateLive() {
  // The opaque settings surface owns the visible UI; catch up once it closes.
  if (settingsDialog.open) return;
  const scroll = document.querySelector('#chat-scroll');
  if (!scroll || !snapshot) return;
  updateOnAir();
  const notice = updateFallbackStatus(snapshot.queue || {});
  const renderSignature = JSON.stringify([snapshot.live, snapshot.queue, snapshot.setup, snapshot.account, snapshot.bindings, snapshot.rules?.user_words, snapshot.preferences?.tts_enabled, snapshot.preferences?.master_volume, snapshot.preferences?.muted, volumeDraft, snapshot.rules?.default_preset_id, snapshot.presets, snapshot.connections, snapshot.local_services, snapshot.status, notice, viewerOpenIdentity]);
  if (liveRenderSignature === renderSignature) return;
  liveRenderSignature = renderSignature;
  const live = snapshot.live || {};
  const connection = liveConnectionView(live);
  const isRunning = !!live.running;
  const room = live.room_id || snapshot.setup?.room_id;
  document.querySelector('#connection-dot').className = `status-dot ${connection.online ? 'online' : connection.pending ? 'pulse' : ''}`;
  const roomLabel = document.querySelector('#room-caption');
  if (roomLabel.textContent !== connection.caption) roomLabel.textContent = connection.caption;
  const kicker = document.querySelector('#masthead-kicker');
  if (kicker && kicker.title !== connection.caption) kicker.title = connection.caption;
  const masthead = mastheadView(snapshot);
  const mastName = document.querySelector('#masthead-name');
  if (mastName && mastName.textContent !== masthead.name) { mastName.textContent = masthead.name; mastName.title = masthead.name; }
  const mastSuffix = document.querySelector('#masthead-suffix');
  if (mastSuffix && mastSuffix.textContent !== masthead.suffix) mastSuffix.textContent = masthead.suffix;
  renderDockVoice();
  const error = runtimeIssue(snapshot) || notice;
  const liveError = document.querySelector('#live-error');
  liveError.hidden = !error;
  const errorLabel = liveError.querySelector('span');
  if (errorLabel.textContent !== error) errorLabel.textContent = error;
  const events = normalizedEvents(snapshot);
  const keys = eventKeys(events);
  renderFeed(events, keys);
  const emptyNode = document.querySelector('#chat-empty');
  emptyNode.hidden = events.length > 0;
  const emptySignature = `${connection.caption}:${room}:${getLanguage()}`;
  if (!events.length && liveMainSignature !== emptySignature) {
    // A quiet room spends most of its time here: a slow ripple says "listening"
    // without inventing content; it quickens while connecting and stops offline.
    const idle = connection.pending ? 'connecting' : connection.online ? 'listening' : 'offline';
    const title = String(connection.emptyTitle).replace(/[.…]+$/, '');
    emptyNode.innerHTML = `<div class="idle-visual ${idle}" aria-hidden="true"><span></span><span></span><span></span><i></i></div><h2>${esc(title)}</h2><p>${room ? connection.emptyDescription : t('先在设置中连接一个直播间。')}</p>${!isRunning && !connection.pending ? button(room ? t('连接直播间') : t('设置直播间'), room ? 'live.toggle' : 'settings.room', { class: 'small primary' }) : ''}`;
    liveMainSignature = emptySignature;
  }
  const queue = snapshot.queue || {};
  const enabled = !!(snapshot.setup?.tts_enabled ?? snapshot.preferences?.tts_enabled);
  const shell = document.querySelector('#live-shell');
  shell?.classList.toggle('speech-off-state', !enabled);
  shell?.classList.toggle('speaking', enabled && !!queue.current);
  const speechSwitch = document.querySelector('#speech-switch');
  if (speechSwitch) {
    speechSwitch.setAttribute('aria-checked', String(enabled));
    speechSwitch.classList.toggle('on', enabled);
    speechSwitch.title = enabled ? t('关闭弹幕播报') : t('开启弹幕播报');
  }
  const pending = enabled ? pendingLiveJobs() : [];
  const pill = document.querySelector('#queue-pill');
  const queuePanel = document.querySelector('#queue-panel');
  pill.hidden = !pending.length;
  document.querySelector('#queue-sep').hidden = !pending.length;
  const countLabel = `${getLanguage()}:${pending.length}`;
  if (pill.dataset.countLabel !== countLabel) {
    pill.dataset.countLabel = countLabel;
    pill.innerHTML = `${esc(t('接下来'))}<span class="queue-count${pending.length !== lastQueueCount && lastQueueCount ? ' bump' : ''}">${pending.length}</span>${icon('up')}`;
  }
  lastQueueCount = pending.length;
  if (!pending.length) closeQueuePanel();
  if (!queuePanel.hidden) renderQueuePanel(events);
  else queueSignature = '';
  const voicePanel = document.querySelector('#tts-menu');
  if (voicePanel && !voicePanel.hidden) renderVoicePanel();
  if (viewerContext) {
    const voices = document.querySelector('#viewer-voices');
    if (voices) patchMarkup(voices, viewerChipsHtml(viewerContext));
  }
  updateVolumeControls();
}

function updateVolumeControls() {
  const stored = Math.round((snapshot.preferences?.master_volume ?? 1) * 100);
  const muted = volumeDraft === null ? (!!snapshot.preferences?.muted || stored === 0) : volumeDraft === 0;
  // Muting shows zero; the saved level returns when sound is turned back on.
  const volume = volumeDraft ?? (muted ? 0 : stored);
  const slider = document.querySelector('#main-volume-range');
  if (slider && slider.value !== String(volume)) slider.value = String(volume);
  if (slider?.style) slider.style.setProperty('--fill', `${Math.round((volume / Number(slider.max || 200)) * 100)}%`);
  const output = document.querySelector('#main-volume-value');
  if (output) output.textContent = String(volume);
  const control = document.querySelector('[data-action="audio.mute"]');
  if (control) {
    const label = muted ? t('取消静音') : t('静音');
    control.title = label;
    control.setAttribute('aria-label', label);
    control.setAttribute('aria-pressed', String(muted));
    control.classList?.toggle('on', muted);
    if (control.dataset.muted !== String(muted)) {
      control.dataset.muted = String(muted);
      control.innerHTML = icon(muted ? 'muted' : 'audio');
    }
  }
}

const tabs = [['room', 'navRoom', '直播间'], ['voices', 'navVoice', '声音'], ['rules', 'navRules', '播报内容'], ['assets', 'navSounds', '音效'], ['broadcast', 'navBroadcast', '开播'], ['overlay', 'navOverlay', 'OBS 叠加层'], ['general', 'navGeneral', '通用'], ['data', 'navAbout', '数据与关于']];
// Older entry points still name the pages that were merged into 通用 and 数据与关于.
const legacyTabs = { audio: 'general', appearance: 'general', about: 'data' };
const settingsTabId = id => legacyTabs[id] || (tabs.some(([tab]) => tab === id) ? id : 'voices');
const serviceProviders = ['doubao', 'dots', 'gpt_sovits', 'fish_audio'];
const providerTimeout = { doubao: 30, dots: 30, gpt_sovits: 30 };
const providerEndpoint = { dots: 'http://127.0.0.1:9881', gpt_sovits: 'http://127.0.0.1:9880' };
const fishDefaultVoiceId = '561fcedfdf0e4e1399d1bc4930d50c0e';

function rememberedPreset(provider) {
  const presets = snapshot.presets || [];
  const savedId = snapshot.rules?.preferred_presets?.[provider];
  return presets.find(item => item.provider === provider && item.id === savedId)
    || presets.find(item => item.provider === provider && item.id === snapshot.rules?.default_preset_id)
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

function localServiceState(provider, connection = serviceConnection(provider)) {
  const cached = snapshot.local_services?.[provider] || {};
  return cached.endpoint && connection?.settings?.endpoint && cached.endpoint !== connection.settings.endpoint
    ? { ...cached, state: 'unknown', message: '' } : cached;
}

function providerStatus(provider, connection) {
  if (provider === 'dots' || provider === 'gpt_sovits') {
    const status = localServiceState(provider, connection);
    const detail = localizeDiagnostic(status?.message || '');
    if (status?.state === 'ready') return { tone: 'ready', label: t('服务已就绪'), detail };
    if (status?.state === 'checking') return { tone: 'pending', label: t('正在检查'), detail };
    if (status?.state === 'starting') return { tone: 'pending', label: t('正在启动'), detail };
    if (status?.state === 'failed') return { tone: 'error', label: t('连接异常'), detail: detail || t('连接失败，请检查服务设置。') };
    if (status?.state === 'stopped') return { tone: 'idle', label: t('已停止'), detail };
    return connection || status?.directory
      ? { tone: 'idle', label: t('待检查'), detail: t('可在服务设置中检查连接。安装目录仅用于自动启动。') }
      : { tone: 'idle', label: t('未配置'), detail: t('先在服务设置中选择安装目录。') };
  }
  // The light reports saved account configuration, not a continuous cloud health probe.
  if (provider === 'doubao' && connection?.has_credential) return { tone: 'ready', label: t('已登录'), detail: t('已在本机保存登录。可通过试听确认当前音色是否可用。') };
  if (provider === 'fish_audio' && connection?.has_credential) return { tone: 'ready', label: t('已连接'), detail: t('已在本机保存 API Key。可通过试听确认当前音色是否可用。') };
  return { tone: 'idle', label: provider === 'doubao' ? t('未登录') : t('未连接'), detail: provider === 'doubao' ? t('在设置中扫码登录豆包。') : t('在设置中连接 Fish Audio 账号。') };
}

function serviceChoiceLabel(provider, status, preferred) {
  return ui`${providerLabel(provider)}，${status.label}，${preferred ? t('直播首选') : t('设为直播首选')}`;
}

function updateAttribute(node, name, value) {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function updatePlaybackIssue() {
  const target = document.querySelector('#voice-playback-error, #audio-playback-error');
  if (!target) return;
  const message = playbackIssue(snapshot?.queue);
  target.textContent = message;
  target.hidden = !message;
}

function updateServiceIndicators() {
  updatePlaybackIssue();
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
      const state = localServiceState(provider);
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
  if (!form.checkValidity()) throw new Error(t('请检查未填或格式不正确的项目'));
  const type = form.dataset.form;
  const data = new FormData(form);
  const value = key => String(data.get(key) ?? '').trim();
  const number = key => Number(data.get(key));
  const checked = key => data.has(key);
  const id = form.dataset.id || '';
  if (type === 'room-uid') {
    if (!validUid(value('uid'))) throw new Error(t('请输入有效的主播 UID'));
    return { action: 'onboarding.anonymous', payload: { uid: value('uid') } };
  }
  if (type === 'gift-merge') {
    const gift_merge = { enabled: checked('enabled'), initial_seconds: number('initial_seconds'), increment_seconds: number('increment_seconds'), maximum_seconds: number('maximum_seconds') };
    if (gift_merge.maximum_seconds < gift_merge.initial_seconds) throw new Error(t('最长等待不能小于初始等待'));
    return { action: 'live.save', payload: { gift_merge } };
  }
  if (type === 'preset') {
    const connection = snapshot.connections.find(item => item.id === value('connection_id'));
    if (!connection || !value('voice_id')) throw new Error(t('请选择语音服务和音色'));
    const name = value('name') || defaultPresetName(connection.settings.provider, value('voice_id'), id);
    const preset = { id, name, connection_id: connection.id, provider: connection.settings.provider, voice_id: value('voice_id'), speed: number('speed'), volume: number('volume'), sovits: null };
    if (preset.provider === 'gpt_sovits') preset.sovits = { model_selection: value('model_selection'), gpt_weights_path: value('gpt_weights_path') || null, sovits_weights_path: value('sovits_weights_path') || null, reference_text: value('reference_text'), reference_text_free: checked('reference_text_free'), reference_language: value('reference_language'), text_language: value('text_language'), split: value('split'), top_k: number('top_k'), top_p: number('top_p'), temperature: number('temperature'), sample_steps: number('sample_steps'), super_sampling: checked('super_sampling'), fragment_interval_secs: number('fragment_interval_secs') };
    return { action: 'presets.save', payload: { preset } };
  }
  if (type === 'service-local') {
    if (!['dots', 'gpt_sovits'].includes(form.dataset.provider)) throw new Error(t('本地服务类型无效。'));
    return { action: 'local_services.save', payload: { provider: form.dataset.provider, directory: value('directory') } };
  }
  if (type === 'fish-settings') {
    const connectionId = form.dataset.connectionId;
    if (!snapshot.connections.some(item => item.id === connectionId && item.has_credential)) throw new Error(t('请先连接 Fish Audio 账号。'));
    return { action: 'fish.settings.save', payload: { connection_id: connectionId, settings: { model: value('model'), latency: value('latency'), volume_db: number('volume_db'), temperature: number('temperature'), top_p: number('top_p'), streaming: true } } };
  }
  if (type === 'fish-preset') {
    const existing = snapshot.presets.find(item => item.id === id && item.provider === 'fish_audio' && item.connection_id === form.dataset.connectionId);
    if (!existing) throw new Error(t('请重新打开音色设置。'));
    return { action: 'presets.save', payload: { preset: { ...existing, name: value('name'), speed: number('speed'), volume: number('volume') } } };
  }
  if (type === 'binding') {
    const userId = value('user_id');
    const userName = value('user_name');
    if (!userId && !userName) throw new Error(t('请填写观众用户名或 UID'));
    if (userId && !validUid(userId)) throw new Error(t('请输入有效的观众 UID'));
    if (!value('preset_id')) throw new Error(t('请先选择声音预设'));
    return { action: 'bindings.save', payload: { id, binding: { platform: 'bilibili', user_id: userId ? numericId(userId) : null, user_name: userId ? null : userName || null, legacy_user_name: snapshot.bindings.find(item => item.id === id)?.binding.legacy_user_name || null, preset_id: value('preset_id'), enabled: checked('enabled') } } };
  }
  if (type === 'tts-toggle') return { action: 'preferences.save', payload: { preferences: { tts_enabled: checked('tts_enabled') } } };
  if (type === 'rules') {
    const rules = structuredClone(snapshot.rules);
    for (const key of ['danmaku_on', 'filter_bilibili_emoticons', 'gift_on', 'free_gift_on', 'super_chat_on', 'guard_on']) rules.events[key] = checked(key);
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
  if (type === 'overlay') {
    const current = snapshot.overlay?.settings;
    if (!current) throw new Error(t('暂时无法保存此项设置，请重新打开页面'));
    if (!value('title')) throw new Error(t('请填写叠加层标题'));
    const settings = { ...current, enabled: checked('enabled'), style: value('style'), corner: value('corner'), scale: number('scale'), vignette: number('vignette'), title: value('title'), tagline: value('tagline'), show_danmaku: checked('show_danmaku'), show_gift: checked('show_gift'), show_super_chat: checked('show_super_chat'), show_guard: checked('show_guard'), names: value('names'), merge_duplicates: checked('merge_duplicates'), linger_seconds: number('linger_seconds') };
    if (!Number.isInteger(settings.linger_seconds) || settings.linger_seconds < 3 || settings.linger_seconds > 120) throw new Error(t('停留时间需在 3 到 120 秒之间'));
    return { action: 'overlay.save', payload: { settings } };
  }
  throw new Error(t('暂时无法保存此项设置，请重新打开页面'));
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
  // Keep control values separately so another language can render fresh labels
  // without translating user input or losing an unfinished dictionary row.
  const fields = sourceFields.map(input => ({ name: input.name, value: input.value, checked: input.checked, tag: input.tagName, type: input.type, key: input.dataset.key }));
  formDrafts.set(record.key, { html: clone.outerHTML, fields, language: getLanguage(), editor: record.editor ? { ...record.editor } : null, tab: record.tab, type: form.dataset.form });
}

function dotsDraftKey(form) { return `voices:dots-preset:${form.dataset.id || 'new'}`; }

function rememberDotsDraft(form) {
  copyFormDraft(form, { key: dotsDraftKey(form), editor, tab: 'voices' });
}

function mountAutosaves() {
  for (let form of settingsDialog.querySelectorAll('[data-form]')) {
    const key = form.dataset.form === 'dots-preset' ? dotsDraftKey(form)
      : `${settingsTab}:${form.dataset.form}:${form.dataset.id || form.dataset.provider || form.dataset.connectionId || 'new'}`;
    const draft = formDrafts.get(key);
    if (draft) {
      const template = document.createElement('template'); template.innerHTML = draft.html;
      const restored = template.content.firstElementChild;
      if (draft.language === getLanguage()) { form.replaceWith(restored); form = restored; }
      else {
        // Dictionary rows carry user data and may outnumber the saved rows.
        for (const dictionary of restored.querySelectorAll('[data-dictionary]')) {
          const current = form.querySelector(`[data-dictionary="${dictionary.dataset.dictionary}"]`);
          if (current) current.innerHTML =
            [...dictionary.querySelectorAll('.dict-row')].map(row => dictionary.dataset.dictionary === 'sounds'
              ? { trigger: row.querySelector('[data-key="from"]').value, asset_id: row.querySelector('[data-key="to"]').value }
              : { from: row.querySelector('[data-key="from"]').value, to: row.querySelector('[data-key="to"]').value })
              .map(row => dictionaryRow(dictionary.dataset.dictionary, row)).join('');
        }
        const controls = [...form.querySelectorAll('input,select,textarea')];
        const used = new Set();
        for (const saved of draft.fields || []) {
          const input = controls.find(control => !used.has(control) && control.name === saved.name && control.dataset.key === saved.key && control.tagName === saved.tag && control.type === saved.type);
          if (!input) continue;
          used.add(input); input.value = saved.value;
          if (input.type === 'checkbox') input.checked = saved.checked;
        }
        if (restored.dataset.dirty) form.dataset.dirty = restored.dataset.dirty;
      }
    }
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
      onError: error => { showAutoState(form, errorMessage(error), 'error'); record.touched = true; copyFormDraft(form, record); },
      onState: state => {
        if (record.invalid) return;
        if (state.saving) showAutoState(form);
        else if (state.error) showAutoState(form, errorMessage(state.error), 'error');
        else if (state.dirty || !record.touched) showAutoState(form);
      },
    });
    autosaves.set(form, record);
    if (draft) showAutoState(form, validDraft ? t('已恢复未保存的修改，请重试保存') : t('已恢复未完成的修改，请补全'), validDraft ? 'error' : 'draft');
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
    showAutoState(form, errorMessage(ui`${error.message} · 草稿已保留`), 'draft'); return;
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
    showToast(t('请先完成输入法选字，再切换或退出设置'), true);
    return false;
  }
  let failed = false;
  for (const [form, record] of autosaves) {
    if (!record.touched) continue;
    scheduleAutosave(form, true);
    try { await record.queue.flush(); }
    catch { failed = true; copyFormDraft(form, record); }
  }
  if (failed) showToast(t('部分更改未能保存，修改已保留在设置中'), true);
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
  return [...formDrafts.entries()].filter(([key, draft]) => key.startsWith('voices:') && draft.editor && !draft.editor.id).map(([key, draft]) => ui`<div class="draft-notice"><span>${esc({ connection: t('服务连接'), preset: t('声音预设'), 'dots-preset': t('dots 音色'), binding: t('观众声音') }[draft.type])}还有未完成的内容</span><div class="actions">${button(t('继续填写'), 'draft.resume', { id: key, class: 'small' })}${button(t('丢弃'), 'draft.discard', { id: key, class: 'small quiet' })}</div></div>`).join('');
}

function renderSettings() {
  closeSelect();
  unmountAutosaves();
  settingsDirty = false;
  settingsDialog.innerHTML = ui`<div class="settings-shell"><header class="settings-heading" data-tauri-drag-region><button type="button" class="settings-back" data-action="settings.close">${icon('back')}<span>返回直播</span></button><span class="settings-heading-space" data-tauri-drag-region></span>${iconButton('moon', t('切换深浅色'), 'theme.toggle')}<span class="titlebar-divider" aria-hidden="true"></span>${windowControls()}</header><div id="settings-error" class="settings-status" role="alert" hidden></div><div class="settings-body"><label class="settings-category-label" for="settings-category"><span class="sr-only">设置分类</span><select id="settings-category" aria-label="设置分类">${tabs.map(([id, , title]) => option(id, t(title), settingsTab)).join('')}</select></label><nav class="settings-nav" aria-label="设置分类"><h2 id="settings-title" class="settings-nav-title">设置</h2><span class="settings-nav-ink" aria-hidden="true"></span>${tabs.map(([id, glyph, title]) => `<button type="button" data-action="settings.tab" data-id="${id}"${settingsTab === id ? ' aria-current="page"' : ''}>${icon(glyph)}${t(title)}${id === 'overlay' || id === 'broadcast' ? `<span class="settings-nav-badge">${esc(t('实验'))}</span>` : ''}</button>`).join('')}</nav><section class="settings-content" id="settings-content" tabindex="-1">${editor ? `<div class="editor-navigation">${button(aliasReturnContext && editor?.type === 'alias' ? t('返回主界面') : `${t('返回')} ${t(tabs.find(([id]) => id === settingsTab)?.[2] || '设置')}`, 'editor.cancel', { class: 'small quiet', icon: 'back' })}</div>` : ''}${renderSettingsPage()}</section></div></div>`;
  settleSettingsMotion();
  mountAutosaves();
  if (editor?.type === 'preset') hideLegacyVoiceFields();
  if (editor?.type === 'preset' && !editor.id) applyModelPairToForm(false);
  updateVoiceSettings();
  updateServiceIndicators();
  updateOverlayStatus();
  updateOverlayPreview();
  updateBroadcastSettings();
  mountSelects(settingsDialog);
  updateQr();
}

function renderAbout() {
  const store = snapshot.update_channel === 'store';
  const hero = ui`<div class="s-about-hero"><img class="s-about-logo" src="./logo.png" width="84" height="84" alt="" draggable="false"><div><strong>超绝可爱弹幕姬</strong><span>版本 <span class="s-num">${esc(snapshot.app_version || '—')}</span>${store ? ' · Microsoft Store' : ''}</span></div></div>`;
  const dataRow = ui`<div class="s-row"><span class="s-text"><span>数据目录</span></span><span class="s-mono" title="${esc(snapshot.data_dir)}">${esc(snapshot.data_dir)}</span></div>`;
  if (store) {
    return ui`${hero}<div class="s-card"><div class="s-row"><span class="s-text"><span>更新</span><small>此版本由 Microsoft Store 安装和更新。</small></span>${button(t('打开 Microsoft Store 更新'), 'external.open', { id: 'store_updates', class: 'small', icon: 'external' })}</div>${dataRow}<div class="s-row"><span class="s-text"><span>项目主页</span></span>${button('GitHub', 'external.open', { id: 'project', class: 'small', icon: 'external' })}</div></div>`;
  }
  const status = updateBusy ? t('正在检查…') : updateError || (updateInfo?.status === 'available' ? ui`发现新版本 ${updateInfo.latest_version}` : updateInfo?.status === 'up_to_date' ? t('已是最新版本') : updateInfo?.status === 'no_release' ? t('暂无正式发布版本') : '');
  const updateActions = `${button(updateBusy ? t('正在检查…') : t('检查更新'), 'update.check', { class: 'small', disabled: updateBusy || snapshot.network_disabled })}${updateInfo?.download_url ? button(t('下载新版'), 'external.open', { id: 'update_download', class: 'primary small', icon: 'external' }) : ''}`;
  return ui`${hero}<div class="s-card"><div class="s-row s-wrap"><span class="s-text"><span>更新</span><small role="status" class="${updateError ? 'field-error' : ''}">${esc(status)}</small>${updateInfo?.status === 'available' ? t('<small>下载后解压 ZIP，退出程序，再用新版 EXE 替换原文件，设置会保留。</small>') : ''}</span><span class="s-row-actions">${updateActions}</span></div>${dataRow}<div class="s-row"><span class="s-text"><span>项目主页</span></span><span class="s-row-actions">${button('GitHub', 'external.open', { id: 'project', class: 'small', icon: 'external' })}${button(t('发布页面'), 'external.open', { id: 'releases', class: 'small', icon: 'external' })}</span></div></div>`;
}

// A new page rises in; the highlight in the category list slides to the chosen page.
function settleSettingsMotion() {
  const view = `${settingsTab}|${editor?.type || ''}|${editor?.id || editor?.provider || ''}`;
  const changed = lastSettingsTab !== view || !settingsDialog.open;
  lastSettingsTab = view;
  const motion = motionAllowed();
  if (changed && motion) settingsDialog.querySelector('#settings-content')?.classList?.add('tab-enter');
  const nav = settingsDialog.querySelector('.settings-nav');
  const ink = nav?.querySelector?.('.settings-nav-ink');
  const current = nav?.querySelector?.('[aria-current="page"]');
  if (!ink?.style || !current) return;
  const top = current.offsetTop;
  if (motion && settingsDialog.open && settingsInkTop !== null && settingsInkTop !== top) {
    ink.style.transform = `translateY(${settingsInkTop}px)`;
    ink.getBoundingClientRect();
    ink.classList.add('moving');
  }
  ink.style.transform = `translateY(${top}px)`;
  settingsInkTop = top;
}

// While the dialog was closed nothing had a position; put the highlight on the open page.
function placeSettingsInk() {
  const nav = settingsDialog.querySelector('.settings-nav');
  const ink = nav?.querySelector?.('.settings-nav-ink');
  const current = nav?.querySelector?.('[aria-current="page"]');
  if (!ink?.style || !current) return;
  ink.classList.remove('moving');
  settingsInkTop = current.offsetTop;
  ink.style.transform = `translateY(${settingsInkTop}px)`;
}

// Settings cover the custom title bar, so they carry their own copy of the window buttons.
const windowControls = () => document.querySelector('#titlebar .titlebar-controls')?.outerHTML || '';

function renderSettingsPage() {
  if (!snapshot) return empty(t('桌面连接不可用。'));
  if (settingsTab === 'room') return renderRoomSettings();
  if (settingsTab === 'voices') return renderVoicesSettings();
  if (settingsTab === 'rules') return renderRulesSettings();
  if (settingsTab === 'assets') return renderAssetsSettings();
  if (settingsTab === 'broadcast') return renderBroadcastSettings();
  if (settingsTab === 'overlay') return renderOverlaySettings();
  if (settingsTab === 'general') {
    const reset = ui`<section class="s-section">${sLabel(t('初次设置'))}<div class="s-card"><div class="s-row"><span class="s-text"><span>重新打开引导</span><small>重新走一遍扫码、直播间和豆包设置。已有声音和规则仍会保留。</small></span>${button(t('重新打开'), 'onboarding.reset', { class: 'small' })}</div></div></section>`;
    return `<div class="s-page">${heading(t('通用'))}${renderAppearanceSettings()}${renderAudioSettings()}${reset}</div>`;
  }
  return `<div class="s-page s-about">${renderAbout()}${renderDataSettings()}<p class="s-license">AGPL-3.0-only · ${esc(t('许可信息见 GitHub 仓库 NOTICE。'))}</p></div>`;
}

function renderRoomSettings() {
  const loggedIn = !!snapshot.account?.user_id;
  const expired = snapshot.live?.state === 'session_expired';
  const scanning = editor?.type === 'qr' && editor.provider === 'bilibili';
  const anonymous = snapshot.setup?.mode === 'anonymous';
  const needsRoom = qrNeedsRoomFallback(snapshot);
  const showUid = needsRoom || (!scanning && (!loggedIn || anonymous || editor?.type === 'anonymous-room'));
  const room = snapshot.setup?.room_id || snapshot.live_settings?.room_id;
  const identity = headerIdentity(snapshot);
  const name = loggedIn ? identity.name : t('未登录');
  const state = expired ? t('登录已失效') : loggedIn ? t('已登录') : t('未登录');
  const note = expired ? t('重新扫码登录后即可继续接收弹幕。') : loggedIn ? '' : t('用哔哩哔哩 App 扫码，自动找到自己的直播间。');
  const avatar = `<span class="s-avatar large color-${identityColor(snapshot.account?.user_id || name)}" aria-hidden="true">${loggedIn ? `<span>${esc(initial(name))}</span>` : icon('person')}${identity.avatar ? `<img src="${esc(identity.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
  const heroActions = loggedIn
    ? `${button(t('重新扫码'), 'bili.begin', { class: `small${expired ? ' primary' : ''}`, icon: 'qr' })}${button(t('退出账号'), 'bili.logout', { class: 'small danger' })}`
    : button(t('扫码登录'), 'bili.begin', { class: 'primary small', icon: 'qr' });
  const hero = scanning
    ? `<section class="s-hero s-qr-hero">${qrMarkup('bilibili', true)}<div class="actions">${button(t('取消扫码'), 'editor.cancel', { class: 'small' })}</div></section>`
    : ui`<section class="s-hero s-account"><span class="s-hero-glow" aria-hidden="true"></span>${avatar}<div class="s-account-text"><strong>${esc(name)}</strong><span class="${expired ? 's-bad' : ''}">哔哩哔哩账号 · ${esc(state)}</span>${note ? `<small>${esc(note)}</small>` : ''}</div><div class="s-hero-actions">${heroActions}</div></section>`;
  const uidMode = showUid;
  const seg = loggedIn && !needsRoom && !scanning
    ? ui`<div class="s-seg" role="group" aria-label="接收目标"><button type="button"${uidMode ? ' data-action="bili.use_account"' : ' class="on"'} aria-pressed="${!uidMode}">我的直播间</button><button type="button"${uidMode ? ' class="on"' : ' data-action="room.anonymous"'} aria-pressed="${uidMode}">主播 UID</button></div>`
    : '';
  const roomRow = ui`<div class="s-row"><span class="s-text"><span>直播间</span></span><span class="s-num">${room ? esc(room) : '—'}</span></div>`;
  const uidId = `field-${++fieldSequence}`;
  const uidRow = ui`<div class="s-row"><label class="s-text" for="${uidId}"><span>主播 UID</span><small>填写主播个人主页中的 UID，输入完成后自动查找直播间。</small></label><input id="${uidId}" class="s-input s-num-input" name="uid" value="${esc(anonymous ? snapshot.setup?.uid || '' : '')}" ${t('inputmode="numeric" pattern="[1-9][0-9]{0,19}" maxlength="20" required placeholder="输入主播 UID"')}></div>`;
  const card = showUid ? `<form data-form="room-uid" class="s-card">${uidRow}${roomRow}${autoStatus()}</form>` : `<div class="s-card">${roomRow}</div>`;
  const targetNote = needsRoom ? t('未找到本账号直播间，可以通过主播 UID 接收弹幕。') : '';
  return `<div class="s-page">${heading(t('直播间'))}${hero}${sSection(t('接收目标'), seg + card, '', targetNote)}${sSection(t('礼物合并'), renderGiftMerge(), '', t('断开直播间后可更改。礼物先按播报规则过滤，再合并数量。'))}</div>`;
}

// ---- 开播 (experimental) ----
// The console manages the signed-in account's own room only; chat reception, speech and
// OBS media output stay independent. Push credentials never enter snapshots or drafts.
const BROADCAST_REFRESH_MS = 60000;
let broadcastRefreshAt = 0;
let broadcastRefreshAccount = '';
let broadcastRefreshError = '';
let broadcastRefreshing = false;
let onAirPanelMode = '';
let onAirClockTimer = null;
let onAirSignature = '';

const broadcastEnabled = () => !!snapshot?.preferences?.broadcast_console;
const broadcastAccount = () => String(snapshot?.account?.user_id || '');
const broadcastLive = room => room?.live_status === 1;

function broadcastAreaPath(view = snapshot.broadcast || {}, room = view.room) {
  if (!room) return '';
  const parent = (view.areas || []).find(item => item.children.some(child => child.id === room.area_id)) || (view.areas || []).find(item => item.id === room.parent_area_id);
  const child = parent?.children.find(item => item.id === room.area_id);
  return [parent?.name, child?.name].filter(Boolean).join(' · ');
}

function onAirElapsed(since) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(since || 0));
  const two = value => String(value).padStart(2, '0');
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
}

function tickOnAirClocks() {
  const clocks = document.querySelectorAll('[data-onair-since]');
  if (!clocks.length) { clearInterval(onAirClockTimer); onAirClockTimer = null; return; }
  if (document.documentElement.dataset.inactive === 'true') return;
  for (const node of clocks) {
    const text = onAirElapsed(node.dataset.onairSince);
    if (node.textContent !== text) node.textContent = text;
  }
}

function startOnAirClocks() {
  tickOnAirClocks();
  if (!onAirClockTimer && document.querySelector('[data-onair-since]')) onAirClockTimer = setInterval(tickOnAirClocks, 1000);
}

const onAirClock = room => broadcastLive(room) && room.live_since ? `<span class="onair-clock" data-onair-since="${esc(room.live_since)}">${onAirElapsed(room.live_since)}</span>` : '';

// Reading the own room is read-only; it happens only after the person turned the console on.
async function refreshBroadcast(force = false) {
  const account = broadcastAccount();
  if (!broadcastEnabled() || !account || snapshot.network_disabled || broadcastBusy || broadcastRefreshing || snapshot.broadcast?.busy) return;
  const visible = (step === 'main' && !settingsDialog.open) || (settingsDialog.open && settingsTab === 'broadcast');
  if (!visible || !uiIsActive(nativeActive, windowFocused, document.hidden)) return;
  const due = force || broadcastRefreshAccount !== account || Date.now() - broadcastRefreshAt > BROADCAST_REFRESH_MS;
  if (!due) return;
  broadcastRefreshing = true;
  broadcastRefreshAt = Date.now();
  broadcastRefreshAccount = account;
  updateBroadcastViews();
  try {
    await command('bili.broadcast.refresh', {}, { quiet: true, silent: true });
    broadcastRefreshError = '';
  } catch (error) {
    if (broadcastAccount() === account) broadcastRefreshError = errorMessage(error);
  } finally {
    broadcastRefreshing = false;
    updateBroadcastViews();
  }
}

function updateBroadcastViews() {
  updateOnAir();
  updateBroadcastSettings();
}

function hidePushCredentials(root = document) {
  const all = selector => [...(root?.querySelectorAll?.(selector) || [])];
  for (const input of all('[data-push-address], [data-push-key]')) input.value = '';
  for (const key of all('[data-push-key]')) key.type = 'password';
  for (const button of all('[data-action="broadcast.hide"]')) {
    button.dataset.action = 'broadcast.reveal';
    button.innerHTML = `${icon('eye')}${esc(t('显示'))}`;
  }
}

async function runBroadcastAction(action, payload = {}) {
  if (broadcastBusy) return;
  broadcastBusy = true;
  const scopes = [...document.querySelectorAll('[data-broadcast-scope]')];
  const controls = scopes.flatMap(scope => [...scope.querySelectorAll('button, input, select')]).map(node => [node, node.disabled]);
  controls.forEach(([node]) => { node.disabled = true; });
  for (const scope of scopes) scope.classList.add('broadcast-busy');
  for (const go of document.querySelectorAll('[data-onair-go]')) go.classList.add('working');
  try { return await command(`bili.broadcast.${action}`, payload); }
  finally {
    broadcastBusy = false;
    controls.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; });
    for (const scope of scopes) scope.classList.remove('broadcast-busy');
    for (const go of document.querySelectorAll('[data-onair-go]')) go.classList.remove('working');
    if (action === 'refresh') { broadcastRefreshAt = Date.now(); broadcastRefreshAccount = broadcastAccount(); broadcastRefreshError = ''; }
    updateBroadcastViews();
  }
}

function broadcastFormValues(form) {
  const title = form.elements.title.value.trim();
  const area_id = Number(form.elements.area_id.value);
  if (!title || Array.from(title).length > 40 || !Number.isSafeInteger(area_id) || area_id <= 0) throw new Error(t('请填写 1 到 40 字的标题，并选择直播子分区。'));
  return { title, area_id };
}

async function saveBroadcastForm(form) {
  if (!form?.reportValidity() || broadcastBusy) return false;
  const { title, area_id } = broadcastFormValues(form);
  await runBroadcastAction('update', { confirmed: true, title, area_id });
  delete form.dataset.dirty;
  if (form.closest('#onair-panel')) closeOnAirPanel();
  updateBroadcastViews();
  showToast(t('直播标题与分区已更新'));
  return true;
}

// A changed title or category is submitted first, so the room opens with what is on screen.
async function startBroadcast() {
  if (broadcastBusy) return;
  if (!snapshot.broadcast?.room) await runBroadcastAction('refresh');
  const room = snapshot.broadcast?.room;
  if (!room) return;
  const form = document.querySelector('[data-broadcast-scope] form[data-form="broadcast-room"][data-dirty]');
  if (form && !await saveBroadcastForm(form)) return;
  await runBroadcastAction('start', { confirmed: true, area_id: snapshot.broadcast.room.area_id });
  if (snapshot.broadcast?.face_image) {
    if (step === 'main' && !settingsDialog.open) openOnAirPanel('face');
    showToast(t('请先扫码完成人脸验证'));
    return;
  }
  if (step === 'main' && !settingsDialog.open) openOnAirPanel('push');
  showToast(t('已开播，请在 OBS 中开始推流'));
}

async function stopBroadcast() {
  closeOnAirPanel();
  if (!await confirmAction(t('下播？'), t('请先在 OBS 中停止推流。下播只关闭 B站直播间，弹幕接收和播报会继续。'), t('下播'))) return;
  await runBroadcastAction('stop', { confirmed: true });
  hidePushCredentials();
  showToast(t('已下播'));
}

async function revealOrCopyCredentials(action, target) {
  if (broadcastBusy) return;
  const account = snapshot.account?.user_id;
  // Do not put credentials in the retained application snapshot or drafts.
  const next = await invoke('dispatch', { action: 'bili.broadcast.credentials', payload: { confirmed: true } });
  const credentials = next.result; delete next.result; acceptSnapshot(next);
  try {
    if (snapshot.account?.user_id !== account || !snapshot.broadcast?.has_stream_key) return;
    if (action === 'broadcast.reveal') {
      const scope = target.closest('[data-broadcast-scope]') || document;
      const address = scope.querySelector('[data-push-address]');
      const key = scope.querySelector('[data-push-key]');
      if (address && key) { address.value = credentials.address; key.value = credentials.stream_key; key.type = 'text'; }
      target.dataset.action = 'broadcast.hide'; target.innerHTML = `${icon('eye')}${esc(t('隐藏'))}`;
    } else {
      await copyText(action === 'broadcast.copy.address' ? credentials.address : credentials.stream_key);
      showToast(t(action === 'broadcast.copy.address' ? '服务器已复制，请粘贴到 OBS' : '推流码已复制，请粘贴到 OBS'));
      const row = target.closest('.onair-push-row, .s-onair-push-row');
      if (row && motionAllowed()) { row.classList.remove('copied'); row.getBoundingClientRect(); row.classList.add('copied'); }
    }
  } finally { if (credentials) { credentials.address = ''; credentials.stream_key = ''; } }
}

// Shared markup ---------------------------------------------------------------------------
let broadcastFieldSequence = 0;
function broadcastInfoFields(view, room) {
  const areas = view.areas || [];
  const parent = areas.find(item => item.children.some(child => child.id === room.area_id)) || areas.find(item => item.id === room.parent_area_id) || areas[0];
  const children = parent?.children || [];
  const id = `broadcast-title-${++broadcastFieldSequence}`;
  const length = Array.from(room.title || '').length;
  return ui`<div class="onair-field"><label for="${id}">直播标题</label><span class="onair-input"><input id="${id}" name="title" value="${esc(room.title)}" maxlength="40" required autocomplete="off" spellcheck="false"><output class="onair-count" data-title-count>${length}/40</output></span></div><div class="onair-areas"><label class="onair-field"><span>分区</span><select name="parent_area_id" aria-label="${esc(t('直播分区'))}">${areas.map(item => option(item.id, item.name, parent?.id)).join('')}</select></label><label class="onair-field"><span>子分区</span><select name="area_id" aria-label="${esc(t('直播子分区'))}" required>${children.map(child => option(child.id, child.name, room.area_id)).join('')}</select></label></div>`;
}

function broadcastPushRows(view, room) {
  if (!view.has_stream_key) {
    const live = broadcastLive(room);
    return ui`<p class="onair-push-empty">${live ? t('推流码只保存在本次运行的内存里。需要时可以重新获取。') : t('开播后，这里会给出 OBS 需要的服务器和推流码。')}</p>${live ? button(t('重新获取推流码'), 'broadcast.start', { class: 'small', icon: 'key' }) : ''}`;
  }
  const row = (label, attrs, action, copyLabel) => `<div class="onair-push-row"><span class="onair-push-label">${esc(label)}</span><input class="onair-push-value" ${attrs} readonly autocomplete="off" spellcheck="false" placeholder="••••••••••••" aria-label="${esc(label)}"><button type="button" class="onair-copy-btn" data-action="${action}" title="${esc(copyLabel)}" aria-label="${esc(copyLabel)}">${icon('copy')}<span>${esc(t('复制'))}</span></button></div>`;
  return `${row(t('服务器'), 'data-push-address', 'broadcast.copy.address', t('复制服务器'))}${row(t('推流码'), 'data-push-key type="password"', 'broadcast.copy.key', t('复制推流码'))}<ol class="onair-steps">${ui`<li>打开 OBS「设置 → 直播」</li><li>服务选「自定义」</li><li>粘贴服务器和推流码，再点「开始直播」</li>`}</ol><div class="onair-push-tools">${`<button type="button" class="onair-text-button" data-action="broadcast.reveal">${icon('eye')}${esc(t('显示'))}</button><button type="button" class="onair-text-button" data-action="broadcast.forget">${icon('trash')}${esc(t('清除'))}</button>`}<span>${esc(t('仅保存在本次运行的内存中'))}</span></div>`;
}

const broadcastFace = view => ui`<div class="onair-face"><span class="onair-face-qr"><img src="${esc(safeQrUrl(view.face_image))}" alt="${esc(t('开播人脸验证二维码'))}"></span><div><strong>开播前需要人脸验证</strong><p>用哔哩哔哩 App 扫码完成验证，然后点「继续开播」。</p></div></div>`;

// Main screen -------------------------------------------------------------------------------
function onAirGoButton(room, view, label = '') {
  const live = broadcastLive(room);
  const busy = broadcastBusy || view.busy;
  const text = label || (live ? t('下播') : view.face_image ? t('继续开播') : t('开播'));
  return `<button type="button" class="onair-go ${live && !label ? 'live' : ''}${busy ? ' working' : ''}" data-onair-go data-action="${live && !label ? 'broadcast.stop' : 'broadcast.start'}"${busy || snapshot.network_disabled ? ' disabled' : ''}><i aria-hidden="true"></i><span>${esc(text)}</span></button>`;
}

// Sign-in and retry are side roads, not the main act: a quiet pill with its own icon.
const onAirSideButton = (label, action, glyph) => `<button type="button" class="onair-side" data-action="${esc(action)}"${action === 'settings.room' ? '' : ' data-onair-go'}>${icon(glyph)}<span>${esc(label)}</span></button>`;

function updateOnAir() {
  const host = document.querySelector('#onair');
  if (!host) return;
  const enabled = broadcastEnabled() && step === 'main';
  const shell = document.querySelector('#live-shell');
  const view = snapshot.broadcast || {};
  const room = view.room;
  const account = broadcastAccount();
  shell?.classList.toggle('onair-mode', enabled);
  shell?.classList.toggle('on-air', enabled && !!account && broadcastLive(room));
  if (!enabled) {
    if (!host.hidden) { host.hidden = true; host.innerHTML = ''; onAirSignature = ''; }
    closeOnAirPanel();
    return;
  }
  void refreshBroadcast();
  const signature = JSON.stringify([account, view, broadcastBusy, broadcastRefreshing, broadcastRefreshError, getLanguage(), !!snapshot.network_disabled]);
  if (signature === onAirSignature && !host.hidden) return;
  onAirSignature = signature;
  host.hidden = false;
  const live = broadcastLive(room);
  const kicker = (text, extra = '') => `<span class="onair-kicker"><i class="onair-dot" aria-hidden="true"></i><span>${text}</span>${extra}</span>`;
  let copy;
  let actions;
  if (!account) {
    copy = `${kicker('OFF AIR')}<span class="onair-title static">${esc(t('登录 B站账号后即可开播'))}</span>`;
    actions = onAirSideButton(t('扫码登录'), 'settings.room', 'qr');
  } else if (!room) {
    const failed = broadcastRefreshError && !broadcastRefreshing;
    copy = `${kicker('OFF AIR')}<span class="onair-title static${failed ? ' error' : ' loading'}">${esc(failed ? t('读取开播状态失败') : t('正在读取开播状态…'))}</span>${failed ? `<span class="onair-area" title="${esc(broadcastRefreshError)}">${esc(broadcastRefreshError)}</span>` : ''}`;
    actions = failed ? onAirSideButton(t('重试'), 'broadcast.refresh', 'refresh') : onAirGoButton(room, { ...view, busy: true });
  } else {
    const state = live ? 'ON AIR' : room.live_status === 2 ? 'REPLAY' : 'OFF AIR';
    const area = broadcastAreaPath(view, room);
    copy = ui`${kicker(state, onAirClock(room))}<button type="button" class="onair-title" data-action="onair.info" title="修改直播标题和分区"><span>${esc(room.title)}</span>${icon('edit')}</button>${area ? `<span class="onair-area">${esc(area)}</span>` : ''}`;
    const push = live || view.has_stream_key ? `<button type="button" class="onair-key${view.has_stream_key ? ' ready' : ''}" data-action="onair.push" aria-haspopup="dialog" aria-expanded="${onAirPanelMode === 'push'}" title="${esc(t('推流到 OBS'))}" aria-label="${esc(t('推流到 OBS'))}">${icon('key')}</button>` : '';
    // While face verification waits, the panel carries the "continue" action next to its QR.
    actions = push + onAirGoButton(room, { ...view, face_image: onAirPanelMode === 'face' ? null : view.face_image });
  }
  host.innerHTML = `<div class="onair-copy">${copy}</div><div class="onair-actions">${actions}</div>`;
  host.dataset.state = !account ? 'signed-out' : !room ? 'loading' : live ? 'live' : 'off';
  startOnAirClocks();
  if (onAirPanelMode) renderOnAirPanel();
  if (!room || !account) closeOnAirPanel();
}

function renderOnAirPanel() {
  const panel = document.querySelector('#onair-panel');
  const view = snapshot.broadcast || {};
  const room = view.room;
  if (!panel || !room) return;
  // A form someone is editing, or credentials on show, must not be replaced underneath them.
  if (panel.querySelector('form[data-dirty]') || panel.querySelector('[data-push-key][type="text"]')) return;
  const signature = JSON.stringify([onAirPanelMode, view, getLanguage()]);
  if (panel.dataset.signature === signature && !panel.hidden) return;
  panel.dataset.signature = signature;
  const head = (title, note = '') => `<header class="onair-panel-head"><div><strong>${esc(title)}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div><button type="button" class="onair-close" data-action="onair.close" aria-label="${esc(t('关闭'))}" title="${esc(t('关闭'))}">${icon('close')}</button></header>`;
  if (onAirPanelMode === 'info') {
    panel.innerHTML = `${head(t('直播信息'), t('保存后立刻在 B站生效'))}<form data-form="broadcast-room" class="onair-info" novalidate>${broadcastInfoFields(view, room)}<div class="onair-panel-foot"><button type="button" class="onair-text-button" data-action="onair.close">${esc(t('取消'))}</button><button type="submit" class="onair-save">${esc(t('保存到 B站'))}</button></div></form>`;
    mountSelects(panel);
  } else if (onAirPanelMode === 'face' && view.face_image) {
    panel.innerHTML = `${head(t('人脸验证'))}${broadcastFace(view)}<div class="onair-panel-foot">${onAirGoButton(room, view, t('继续开播'))}</div>`;
  } else {
    panel.innerHTML = `${head(t('推流到 OBS'), broadcastLive(room) ? t('直播间已打开，等待 OBS 推流') : '')}<div class="onair-push">${broadcastPushRows(view, room)}</div>`;
  }
  panel.dataset.mode = onAirPanelMode;
}

function openOnAirPanel(mode) {
  const panel = document.querySelector('#onair-panel');
  if (!panel || !snapshot.broadcast?.room) return;
  closeVoicePanel(); closeQueuePanel();
  if (!panel.hidden && onAirPanelMode === mode) { closeOnAirPanel(); return; }
  if (!panel.hidden) hidePushCredentials(panel);
  onAirPanelMode = mode;
  panel.dataset.signature = '';
  renderOnAirPanel();
  panel.hidden = false;
  document.querySelector('[data-action="onair.push"]')?.setAttribute('aria-expanded', String(mode === 'push'));
  if (mode === 'info') panel.querySelector('input[name="title"]')?.focus({ preventScroll: true });
}

function closeOnAirPanel(focus = false) {
  const panel = document.querySelector('#onair-panel');
  onAirPanelMode = '';
  if (!panel || panel.hidden) return;
  closeSelect();
  hidePushCredentials(panel);
  leaveGhost(panel, 220);
  panel.hidden = true;
  panel.innerHTML = '';
  panel.dataset.signature = '';
  document.querySelector('[data-action="onair.push"]')?.setAttribute('aria-expanded', 'false');
  if (focus) document.querySelector('#onair .onair-go')?.focus();
}

// Settings page -----------------------------------------------------------------------------
function renderBroadcastSettings() {
  const enabled = broadcastEnabled();
  const id = `field-${++fieldSequence}`;
  return ui`<div class="s-page s-onair" data-broadcast-scope="settings"><div class="s-page-head"><div class="s-ovl-head"><div class="s-ovl-title-row">${heading(t('开播'))}<span class="s-ovl-badge">实验性</span></div><p class="s-ovl-lede">在弹幕姬里开播、下播，随时改标题和分区。画面和声音仍由 OBS 推流。</p></div><label class="s-ovl-enable" for="${id}"><span>启用</span><input id="${id}" class="s-switch" type="checkbox" role="switch" data-broadcast-enable${enabled ? ' checked' : ''}></label></div><div class="s-onair-body" data-broadcast-body></div></div>`;
}

function broadcastPreview() {
  const sample = ui`<div class="s-onair-preview" aria-hidden="true"><div class="s-onair-stage"><div class="s-onair-mast"><span class="s-onair-mini-kicker"><i></i>LIVE</span><strong>主播的直播间</strong><i class="s-onair-mini-rule"></i></div><div class="onair s-onair-mini" data-state="live"><div class="onair-copy"><span class="onair-kicker"><i class="onair-dot"></i><span>ON AIR</span><span class="onair-clock">01:24:10</span></span><span class="onair-title static"><span>今晚一起听歌</span></span><span class="onair-area">娱乐 · 视频唱见</span></div><div class="onair-actions"><span class="onair-key ready">${icon('key')}</span><span class="onair-go live"><i></i><span>下播</span></span></div></div><div class="s-onair-lines"><i></i><i></i><i></i></div></div></div>`;
  const points = ui`<ul class="s-onair-points"><li><strong>一键开播、下播</strong><span>主界面右上角出现开播台，直播时显示已开播时长。</span></li><li><strong>随时改标题和分区</strong><span>点标题即可修改，保存后立刻在 B站生效。</span></li><li><strong>推流码一键复制</strong><span>开播后直接复制到 OBS，不用再打开直播姬。</span></li></ul>`;
  return `${sample}${points}`;
}

function updateBroadcastSettings() {
  const body = settingsDialog.open ? settingsDialog.querySelector('[data-broadcast-body]') : null;
  if (!body) return;
  void refreshBroadcast();
  const enabled = broadcastEnabled();
  const account = broadcastAccount();
  const view = snapshot.broadcast || {};
  const toggle = settingsDialog.querySelector('[data-broadcast-enable]');
  if (toggle && !toggle.disabled && toggle.checked !== enabled) toggle.checked = enabled;
  const signature = JSON.stringify([enabled, account, view, broadcastRefreshing, broadcastRefreshError, getLanguage(), !!snapshot.network_disabled]);
  const changedAccount = body.dataset.account !== account;
  if (!changedAccount && (broadcastBusy || body.querySelector('form[data-dirty]') || body.querySelector('[data-push-key][type="text"]'))) return;
  if (body.dataset.signature === signature) return;
  body.dataset.signature = signature; body.dataset.account = account;
  const room = view.room;
  if (!enabled) { body.innerHTML = broadcastPreview(); return; }
  if (snapshot.network_disabled) { body.innerHTML = `<div class="s-card"><div class="s-row"><span class="s-text"><small>${esc(t('离线测试窗口不能管理直播间。'))}</small></span></div></div>`; return; }
  if (!account) {
    body.innerHTML = ui`<section class="s-hero s-onair-signin"><span class="s-hero-glow" aria-hidden="true"></span><span class="s-onair-signin-mark" aria-hidden="true">${icon('navBroadcast')}</span><div class="s-account-text"><strong>先登录自己的 B站账号</strong><span>开播管理只作用于扫码登录账号自己的直播间。</span></div><div class="s-hero-actions">${button(t('去扫码登录'), 'settings.tab', { id: 'room', class: 'primary small', icon: 'qr' })}</div></section>`;
    return;
  }
  if (!room) {
    const failed = broadcastRefreshError && !broadcastRefreshing;
    body.innerHTML = `<div class="s-card"><div class="s-row s-wrap"><span class="s-text"><span>${esc(failed ? t('读取开播状态失败') : t('正在读取开播状态…'))}</span>${failed ? `<small class="field-error">${esc(broadcastRefreshError)}</small>` : ''}</span>${failed ? button(t('重试'), 'broadcast.refresh', { class: 'small', icon: 'refresh' }) : '<span class="spinner" aria-hidden="true"></span>'}</div></div>`;
    return;
  }
  const live = broadcastLive(room);
  const stateText = live ? t('直播中') : room.live_status === 2 ? t('轮播中') : t('未开播');
  const area = broadcastAreaPath(view, room);
  const hero = ui`<section class="s-hero s-onair-hero" data-state="${live ? 'live' : 'off'}"><span class="s-hero-glow" aria-hidden="true"></span><div class="s-onair-state"><span class="onair-kicker"><i class="onair-dot" aria-hidden="true"></i><span>${live ? 'ON AIR' : room.live_status === 2 ? 'REPLAY' : 'OFF AIR'}</span></span><strong>${esc(stateText)}${live && room.live_since ? `<span class="s-onair-clock" data-onair-since="${esc(room.live_since)}">${onAirElapsed(room.live_since)}</span>` : ''}</strong><small>房间 <span class="s-num">${esc(room.room_id)}</span>${area ? ` · ${esc(area)}` : ''}</small></div><div class="s-onair-hero-actions"><span class="s-onair-tools">${iconButton('refresh', t('刷新开播状态'), 'broadcast.refresh')}${iconButton('external', t('打开直播间'), 'external.open', 'bili_broadcast_room')}</span>${onAirGoButton(room, view)}</div></section>`;
  const info = ui`<section class="s-section">${sLabel(t('直播信息'), `<span class="s-label-note">${esc(t('保存后立刻在 B站生效'))}</span>`)}<form data-form="broadcast-room" class="s-card s-onair-info" novalidate>${broadcastInfoFields(view, room)}<div class="s-onair-info-foot"><small>${esc(t('开播时如有未保存的修改，会先保存再开播。'))}</small><button type="submit" class="button small">${esc(t('保存到 B站'))}</button></div></form></section>`;
  const face = view.face_image ? `<section class="s-section">${sLabel(t('人脸验证'))}<div class="s-card s-onair-face-card">${broadcastFace(view)}</div></section>` : '';
  const push = ui`<section class="s-section">${sLabel(t('推流到 OBS'))}<div class="s-card onair-push s-onair-push">${broadcastPushRows(view, room)}</div></section>`;
  const note = `<p class="s-note">${esc(t('开播只打开 B站直播间；画面和声音由 OBS 推送。退出弹幕姬不会自动下播。启用期间，弹幕姬约每分钟读取一次自己房间的开播状态。'))}</p>`;
  body.innerHTML = `${hero}${face}${info}${push}${note}`;
  mountSelects(body);
  startOnAirClocks();
}

function renderGiftMerge() {
  const merge = snapshot.live_settings?.gift_merge || { enabled: false, initial_seconds: 1.5, increment_seconds: .5, maximum_seconds: 5 };
  return `<form data-form="gift-merge" class="s-card s-merge">${sSwitch('enabled', t('合并连续赠送的礼物'), merge.enabled, t('合并同一观众连续赠送的同种礼物'))}<div class="s-row s-grid3">${field('initial_seconds', t('初始等待（秒）'), merge.initial_seconds, 'type="number" min="0.1" max="30" step="0.1" required')}${field('increment_seconds', t('每次延长（秒）'), merge.increment_seconds, 'type="number" min="0" max="30" step="0.1" required')}${field('maximum_seconds', t('最长等待（秒）'), merge.maximum_seconds, 'type="number" min="0.1" max="60" step="0.1" required')}</div>${autoStatus()}</form>`;
}

function renderVoiceChoices(presets, preferred) {
  const provider = preferred?.provider || voiceAuditionDraft.provider || presets[0]?.provider || 'doubao';
  const voices = presets.filter(preset => preset.provider === provider);
  const selected = voices.find(preset => preset.id === preferred?.id) || voices.find(preset => preset.id === voiceAuditionDraft.presetId);
  // The empty radio keeps preset_id a group even with one voice, so "no choice" reads as ''.
  const chips = `<input type="radio" name="preset_id" value="" hidden tabindex="-1" aria-hidden="true"${selected ? '' : ' checked'}>${voices.map(preset => `<label class="s-chip"><input type="radio" name="preset_id" value="${esc(preset.id)}"${selected?.id === preset.id ? ' checked' : ''}><span>${esc(presetLabel(preset))}</span></label>`).join('')}`;
  const connection = serviceConnection(provider);
  let setup = '';
  if (!voices.length) {
    const needsLogin = provider === 'doubao' ? !connection?.has_credential : provider === 'fish_audio' ? !connection?.has_credential : !connection;
    const text = provider === 'doubao' ? (needsLogin ? t('扫码登录豆包后即可选择音色。') : t('这个服务还没有音色。'))
      : provider === 'fish_audio' ? (needsLogin ? t('连接 Fish Audio 账号后即可添加音色。') : t('这个服务还没有音色。'))
      : needsLogin ? (provider === 'dots' ? t('选择 dots.tts 的安装目录后，可以添加参考音频作为音色。') : t('选择 GPT-SoVITS 的安装目录后，可以添加角色音色。')) : t('这个服务还没有音色。');
    const action = !needsLogin ? '' : provider === 'doubao' ? button(t('扫码登录'), 'doubao.begin', { id: connection?.id || '', class: 'small', icon: 'qr' })
      : button(provider === 'fish_audio' ? t('连接账号') : t('选择安装目录'), 'service.configure', { id: provider, class: 'small', icon: provider === 'fish_audio' ? 'person' : 'folder' });
    setup = `<div class="s-setup"><span>${esc(text)}</span>${action}</div>`;
  }
  return { provider, html: ui`<div class="s-chips" role="radiogroup" aria-label="直播首选音色">${chips}<button type="button" class="s-chip s-chip-add" data-action="voice-audition.add">${icon('plus')}添加音色</button></div>${setup}`, selected };
}

function renderVoiceAudition(presets, preferred) {
  const choices = renderVoiceChoices(presets, preferred);
  return ui`<section class="s-hero voice-audition" aria-labelledby="voice-audition-title"><span class="s-hero-glow" aria-hidden="true"></span><span class="s-label" id="voice-audition-title">直播首选</span><div class="s-tiles service-grid" role="group" aria-label="默认语音服务">${serviceProviders.map(item => renderServiceCard(item, preferred)).join('')}</div><form data-form="voice-audition" data-provider="${esc(choices.provider)}"><div data-voice-choices>${choices.html}</div><div class="s-audition"><textarea id="voice-audition-text" name="text" aria-label="试听文字" maxlength="2000" rows="2" required placeholder="输入想试听的文字">${esc(voiceAuditionDraft.text)}</textarea><button type="submit" class="button primary"${choices.selected ? '' : ' disabled'}>${icon('play')}试听</button></div></form><div id="voice-playback-error" class="inline-error" role="alert" hidden></div></section>`;
}

function updateVoiceSettings() {
  if (settingsTab !== 'voices' || editor) return;
  const form = settingsDialog.querySelector('[data-form="voice-audition"]');
  const choices = form?.querySelector('[data-voice-choices]');
  if (!choices) return;
  const presets = snapshot.presets || [];
  const preferred = presets.find(preset => preset.id === snapshot.rules?.default_preset_id);
  const next = renderVoiceChoices(presets, preferred);
  // Retain the form, text field, focus, selection and independent autosaves.
  // Only the available voices change when switching providers.
  const signature = JSON.stringify([next.provider, presets, serviceConnection(next.provider), getLanguage()]);
  if (form.dataset.provider !== next.provider || (choices.dataset.signature && choices.dataset.signature !== signature)) {
    choices.innerHTML = next.html;
  }
  choices.dataset.signature = signature;
  form.dataset.provider = next.provider;
  form.elements.preset_id.value = next.selected?.id || '';
  const audition = form.querySelector('[type="submit"]');
  if (audition) audition.disabled = !next.selected;
  const list = settingsDialog.querySelector('#voice-management');
  const listSignature = JSON.stringify([next.provider, preferred?.id, presets, getLanguage()]);
  if (list && list.dataset.signature !== listSignature) {
    const open = list.querySelector('details')?.open;
    // The management section has no forms; keep its surrounding page intact.
    list.innerHTML = renderVoiceManagement(presets, preferred, true);
    if (open && list.querySelector('details')) list.querySelector('details').open = true;
    list.dataset.signature = listSignature;
  }
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
    await command('presets.default', { id: preset.id }, { success: ui`${preset.name} 已设为首选` });
  });
  try {
    await voiceAuditionDefaultSave;
    if (revision === voiceAuditionRevision && settingsDialog.open) updateVoiceSettings();
    return snapshot.rules?.default_preset_id === preset.id;
  } catch (error) {
    if (revision !== voiceAuditionRevision) return false;
    const preferred = snapshot.presets.find(item => item.id === snapshot.rules?.default_preset_id);
    voiceAuditionDraft.provider = preferred?.provider || '';
    voiceAuditionDraft.presetId = preferred?.id || '';
    updateVoiceSettings();
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
  await Promise.allSettled([volumeSave.flush(), flushViewerAlias(), settleVoiceAuditionChoice(), flushAutosaves()]);
  return true;
}

function renderVoiceManagement(presets, preferred, bodyOnly = false) {
  const selectedProvider = preferred?.provider || voiceAuditionDraft.provider || presets[0]?.provider || 'doubao';
  const managedPresets = presets.filter(preset => preset.provider === selectedProvider);
  const presetRow = preset => ui`<div class="s-row"><span class="s-text"><span>${esc(presetLabel(preset))}${preferred?.id === preset.id ? t('<span class="s-tag">正在使用</span>') : ''}</span><small>${esc(providerLabel(preset.provider))} · ${esc(displayNumber(preset.speed))} 倍速</small></span><span class="s-row-actions">${iconButton('edit', ui`编辑 ${presetLabel(preset)}`, 'preset.edit', preset.id)}${iconButton('trash', ui`删除 ${presetLabel(preset)}`, 'preset.delete', preset.id)}</span></div>`;
  const otherPresets = presets.filter(preset => preset.provider !== selectedProvider);
  const otherVoices = otherPresets.length ? ui`<details class="s-details"><summary>其他服务的音色 · ${otherPresets.length}</summary><div class="s-card">${otherPresets.map(presetRow).join('')}</div></details>` : '';
  const body = `<div class="s-card">${managedPresets.length ? managedPresets.map(presetRow).join('') : `<div class="s-row s-empty-row">${esc(t('还没有音色，点击「添加音色」开始设置。'))}</div>`}</div>${otherVoices}`;
  const extra = ui`<span class="s-caption">${esc(providerLabel(selectedProvider))} · ${managedPresets.length} 个音色</span>`;
  return bodyOnly ? sLabel(t('音色管理'), extra) + body : sSection(t('音色管理'), body, extra, '', 'voice-management');
}

function renderVoicesSettings() {
  const presets = snapshot.presets || [];
  const bindings = snapshot.bindings || [];
  if (editor?.type === 'service') return renderServiceEditor(editor.provider);
  if (editor?.type === 'preset') return renderPresetEditor(editor.id);
  if (editor?.type === 'binding') return renderBindingEditor(editor.id);
  if (editor?.type === 'qr') return `${heading(t('连接豆包'), t('使用豆包 App 扫码，并在手机上确认登录。'))}${qrMarkup('doubao', true)}<div class="actions">${button(t('返回'), 'editor.cancel', { class: 'quiet' })}</div>`;
  const preferred = presets.find(item => item.id === snapshot.rules?.default_preset_id);
  const voiceList = renderVoiceManagement(presets, preferred);
  const aliasFor = name => name && (snapshot.rules?.user_words || []).find(row => row.from === name)?.to;
  const bindingRow = ({ id, binding }) => {
    const name = binding.user_name || (binding.user_id ? `UID ${binding.user_id}` : ui`${binding.legacy_user_name || t('旧用户名')} · 待确认`);
    const alias = aliasFor(binding.user_name);
    const preset = presets.find(item => item.id === binding.preset_id);
    const detail = [alias ? ui`别名「${alias}」` : '', binding.user_name && binding.user_id ? `UID ${binding.user_id}` : '', binding.enabled ? '' : t('停用')].filter(Boolean).join(' · ');
    return `<div class="s-row"><span class="s-avatar color-${identityColor(binding.user_id || binding.user_name)}" aria-hidden="true"><span>${esc(initial(binding.user_name || binding.legacy_user_name || name))}</span></span><span class="s-text"><span>${esc(name)}</span>${detail ? `<small>${esc(detail)}</small>` : ''}</span><span class="s-value">${esc(preset ? `${providerLabel(preset.provider)} · ${presetLabel(preset)}` : binding.preset_id)}</span><span class="s-row-actions">${iconButton('edit', t('编辑声音绑定'), 'binding.edit', id)}${iconButton('trash', t('删除声音绑定'), 'binding.delete', id)}</span></div>`;
  };
  const viewers = sSection(t('观众专属声音'), `<div class="s-card">${bindings.length ? bindings.map(bindingRow).join('') : `<div class="s-row s-empty-row">${esc(t('还没有为观众指定声音。'))}</div>`}</div>`, button(t('添加观众'), 'binding.new', { class: 'small', icon: 'plus', disabled: !presets.length }), t('也可以在直播界面点击弹幕，直接指定声音或读作。'));
  const serviceRow = provider => {
    const connection = serviceConnection(provider);
    const status = providerStatus(provider, connection);
    const action = provider === 'doubao'
      ? button(connection?.has_credential ? t('重新扫码') : t('扫码登录'), 'doubao.begin', { id: connection?.id || '', class: 'small' })
      : button(provider === 'fish_audio' && !connection?.has_credential ? t('连接账号') : t('设置'), 'service.configure', { id: provider, class: 'small' });
    return `<div class="s-row" data-service-provider="${esc(provider)}"><span class="s-text"><span>${esc(providerLabel(provider))}</span></span><span class="s-status" title="${esc(status.detail || status.label)}"><span class="service-light ${status.tone}" aria-hidden="true"></span><small class="service-status-label">${esc(status.label)}</small></span>${action}</div>`;
  };
  const services = sSection(t('服务连接'), `<div class="s-card">${serviceProviders.map(serviceRow).join('')}</div>`);
  const power = ui`<form data-form="tts-toggle" class="s-power"><label for="tts-power">弹幕播报</label><input id="tts-power" class="s-switch" type="checkbox" role="switch" name="tts_enabled" aria-label="为新弹幕播报"${snapshot.preferences?.tts_enabled ?? true ? ' checked' : ''}>${autoStatus()}</form>`;
  return `<div class="s-page"><div class="s-page-head">${heading(t('声音'))}${power}</div>${draftNotices()}${renderVoiceAudition(presets, preferred)}${voiceList}${viewers}${services}<div id="operation-result" class="form-result"></div></div>`;
}

function renderServiceCard(provider, preferred) {
  const connection = serviceConnection(provider);
  const status = providerStatus(provider, connection);
  const isPreferred = preferred?.provider === provider;
  return `<div class="s-tile-wrap${isPreferred ? ' preferred' : ''}" data-service-provider="${esc(provider)}"><button type="button" class="service-card-select s-tile" data-action="service.prefer" data-id="${esc(provider)}" aria-pressed="${isPreferred}" aria-label="${esc(serviceChoiceLabel(provider, status, isPreferred))}" title="${esc(status.detail || status.label)}"><strong class="service-card-name">${esc(providerLabel(provider))}</strong><span class="s-tile-status"><span class="service-light ${status.tone}" aria-hidden="true"></span><small class="service-card-status">${esc(status.label)}</small></span></button></div>`;
}

function renderFishServiceEditor(connection, statusRow, back) {
  const connected = !!connection?.has_credential;
  const settings = snapshot.fish_audio_settings?.[connection?.id] || {};
  const voices = (snapshot.presets || []).filter(preset => preset.provider === 'fish_audio' && preset.connection_id === connection?.id);
  const preferred = snapshot.rules?.default_preset_id;
  const rows = voices.map(preset => ui`<div class="setting-row"><div class="row-text"><div class="row-title">${esc(presetLabel(preset))}${preferred === preset.id ? t('<span class="badge">首选</span>') : ''}</div><div class="row-description">${esc(displayNumber(preset.speed))} 倍速</div></div><div class="row-actions">${preferred !== preset.id ? button(t('设为首选'), 'preset.default', { id: preset.id, class: 'small' }) : ''}${button(t('试听'), 'fish.audition', { id: preset.id, class: 'small quiet' })}${iconButton('edit', ui`编辑 ${presetLabel(preset)}`, 'preset.edit', preset.id)}</div></div>`).join('');
  const credentialForm = `<form data-form="service-fish" data-id="${esc(connection?.id || '')}">${field('credential', 'API Key', '', t('type="password" autocomplete="new-password" required placeholder="在这里粘贴 API Key"'), connected ? t('验证新密钥后才会替换。') : t('验证账号后加密保存在本机。'))}<div class="form-footer">${saveButton(connected ? t('验证并更换密钥') : t('验证并连接'))}</div></form>`;
  const account = ui`<section class="settings-card"><h3>账号连接</h3><div class="actions external-actions">${button(t('获取 API Key'), 'fish.open_keys', { class: 'small', icon: 'external' })}${button(t('浏览音色广场'), 'fish.open_discovery', { class: 'small', icon: 'external' })}</div>${connected ? ui`<details class="details"><summary>更换 API Key</summary>${credentialForm}</details>` : credentialForm}</section>`;
  if (!connected) return `${heading('Fish Audio')}${statusRow}${account}${back}`;
  const options = ui`<form data-form="fish-settings" data-connection-id="${esc(connection.id)}" class="form-section"><h3>生成设置</h3>${select('model', t('生成模型'), option('s2.1-pro-free', t('S2.1 Pro Free（默认）'), settings.model || 's2.1-pro-free') + option('s2.1-pro', 'S2.1 Pro', settings.model) + option('s2-pro', 'S2 Pro', settings.model) + option('s1', 'S1', settings.model))}<div class="field-grid">${select('latency', t('延迟模式'), option('normal', t('普通'), settings.latency || 'normal') + option('balanced', t('平衡'), settings.latency) + option('low', t('低延迟'), settings.latency))}${field('volume_db', t('合成音量（dB）'), settings.volume_db ?? 0, 'type="number" min="-20" max="20" step="0.5" required')}${field('temperature', t('温度'), settings.temperature ?? .7, 'type="number" min="0" max="1" step="0.05" required')}${field('top_p', 'Top P', settings.top_p ?? .7, 'type="number" min="0" max="1" step="0.05" required')}</div><div class="form-footer">${autoStatus()}</div></form>`;
  return ui`${heading('Fish Audio')}${statusRow}${account}<div class="settings-section-title"><h3>音色收藏</h3><div class="actions">${button(t('添加音色'), 'service.add_preset', { id: 'fish_audio', class: 'small', icon: 'plus' })}${button(t('恢复内置五音色'), 'fish.restore_builtin', { class: 'small quiet' })}</div></div><div class="row-list">${rows || empty(t('还没有 Fish 音色。'))}</div>${options}${back}`;
}

function renderServiceEditor(provider) {
  const connection = serviceConnection(provider);
  const status = providerStatus(provider, connection);
  const state = localServiceState(provider, connection);
  const statusRow = `<div class="service-editor-state" data-service-provider="${esc(provider)}"><div class="service-editor-status"><span class="service-light ${status.tone}" aria-hidden="true"></span><span class="service-status-label" title="${esc(status.detail || status.label)}">${esc(status.label)}</span></div><p class="quiet-note${state.state === 'failed' ? ' status-error' : ''}" data-service-message${state.state === 'failed' && state.message ? '' : ' hidden'}>${esc(state.message || '')}</p></div>`;
  const back = '';
  if (provider === 'doubao') return `${heading(t('豆包'))}${statusRow}${button(connection?.has_credential ? t('重新扫码') : t('扫码连接'), 'doubao.begin', { id: connection?.id || '', class: 'primary small', icon: 'qr' })}${back}`;
  if (provider === 'fish_audio') return renderFishServiceEditor(connection, statusRow, back);
  const directory = state.directory || '';
  const directoryLabel = provider === 'dots' ? t('dots.tts 目录') : t('GPT-SoVITS 目录');
  return `${heading(providerLabel(provider), t('设为默认语音服务后，随本应用启动。'))}${statusRow}<form data-form="service-local" data-provider="${esc(provider)}">${pathField('directory', directoryLabel, directory, 'service.pick_directory', t('点击选择安装目录'))}${autoStatus()}</form><div class="actions">${button(t('启动服务'), 'service.start', { id: provider, class: 'small primary', disabled: !connection || !state.directory || !!state.owned })}${button(t('停止服务'), 'service.stop', { id: provider, class: 'small quiet', disabled: !state.owned })}${button(t('检查连接'), 'service.check', { id: provider, class: 'small quiet', disabled: !connection })}${connection ? button(t('添加音色'), 'service.add_preset', { id: provider, class: 'small quiet' }) : ''}</div>`;
}

function renderPresetCore(id) {
  const first = snapshot.connections.find(item => item.id === editor?.connectionId) || snapshot.connections[0];
  const preset = snapshot.presets.find(item => item.id === id) || { id: '', name: '', connection_id: first?.id || '', provider: first?.settings.provider, voice_id: '', speed: 1, volume: 1, sovits: null };
  const voices = snapshot.doubao_voices || [];
  const sovits = preset.sovits || {};
  const provider = snapshot.connections.find(item => item.id === preset.connection_id)?.settings.provider || preset.provider;
  const voiceLabel = provider === 'gpt_sovits' ? t('角色名称') : t('音色');
  const hasVoice = voices.some(voice => (voice.id || voice.voice_id || voice.value) === preset.voice_id);
  const voicePicker = provider === 'doubao'
    ? select('voice_id', t('豆包音色'), option('', t('请选择音色'), preset.voice_id) + (!hasVoice && preset.voice_id ? option(preset.voice_id, t('已保存的音色'), preset.voice_id) : '') + voices.map(voice => option(voice.id || voice.voice_id || voice.value, voice.name || voice.label || t('未命名音色'), preset.voice_id)).join(''))
    : field('voice_id', voiceLabel, preset.voice_id, 'required autocomplete="off"', t('选择成对模型后会自动填入角色名称。'));
  return ui`${heading(id ? t('编辑音色') : t('添加音色'))}<form data-form="preset" data-id="${esc(id || '')}"><input type="hidden" name="connection_id" value="${esc(preset.connection_id)}"><p class="quiet-note">语音服务：${esc(providerLabel(provider))}</p>${voicePicker}<details class="details"><summary>语速与其他选项</summary>${field('name', t('自定义名称（选填）'), provider === 'doubao' && (preset.name === voiceName(preset.voice_id) || preset.name.includes(preset.voice_id)) ? '' : presetLabel(preset), t('maxlength="100" placeholder="默认使用音色名称"'))}<div class="field-grid">${field('speed', t('语速'), preset.speed, 'type="number" min="0.5" max="2" step="0.05" required')}${field('volume', t('音色音量'), preset.volume, 'type="number" min="0" max="2" step="0.05" required')}</div><div id="sovits-fields"${provider === 'gpt_sovits' ? '' : ' hidden'}><details class="details"><summary>GPT-SoVITS 参数</summary>${select('model_selection', t('模型选择'), option('global_resident', t('使用服务当前加载的模型'), sovits.model_selection || 'global_resident') + option('per_request_atomic', t('为每次请求指定模型'), sovits.model_selection))}${field('gpt_weights_path', t('GPT 模型路径'), sovits.gpt_weights_path || '')}${field('sovits_weights_path', t('SoVITS 模型路径'), sovits.sovits_weights_path || '')}${field('reference_text', t('参考文本'), sovits.reference_text || '')}${check('reference_text_free', t('无参考文本模式'), sovits.reference_text_free ?? true)}<div class="field-grid">${field('reference_language', t('参考语言'), sovits.reference_language || 'all_zh')}${field('text_language', t('合成语言'), sovits.text_language || 'all_zh')}${field('split', t('分句方法'), sovits.split || 'cut0')}${field('fragment_interval_secs', t('片段间隔（秒）'), sovits.fragment_interval_secs ?? .3, 'type="number" min="0" max="5" step="0.05"')}${field('top_k', 'Top K', sovits.top_k ?? 5, 'type="number" min="1" max="100"')}${field('top_p', 'Top P', sovits.top_p ?? 1, 'type="number" min="0" max="1" step="0.05"')}${field('temperature', t('温度'), sovits.temperature ?? 1, 'type="number" min="0" max="2" step="0.05"')}${field('sample_steps', t('采样步数'), sovits.sample_steps ?? 8, 'type="number" min="1" max="128"')}</div>${check('super_sampling', t('超采样'), sovits.super_sampling || false)}</details></div></details><div class="form-footer">${autoStatus()}${button(t('返回'), 'editor.cancel', { class: 'quiet' })}</div></form>`;
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
  const retained = preset.sovits?.gpt_weights_path && index < 0 ? option('existing', t('当前模型（安装目录中未找到）'), 'existing') : '';
  const placeholder = options || retained ? '' : option('', t('尚未发现成对模型'), '');
  return `<div class="model-pair-picker">${select('model_pair', t('角色模型'), placeholder + retained + options, t('从安装目录自动配对 GPT 与 SoVITS 权重。'))}${button(t('刷新模型'), 'models.refresh', { class: 'small quiet', icon: 'refresh' })}</div>${modelScan.error ? `<p class="quiet-note status-error">${esc(modelScan.error)}</p>` : ''}${modelScan.issues?.length ? ui`<p class="quiet-note">另有 ${modelScan.issues.length} 个文件未配对或存在歧义。</p>` : ''}`;
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
  return [['auto', t('自动识别')], ['all_zh', t('中文')], ['en', t('英语')], ['all_ja', t('日语')], ['all_ko', t('韩语')], ['all_yue', t('粤语')]].map(([code, label]) => option(code, label, selected)).join('');
}

function renderReferenceEditor(provider, preset, pair) {
  const role = referenceRole(provider, preset, pair);
  const saved = currentReference(role);
  const profile = saved?.profile || {};
  const audioLabel = saved?.profile?.audio_path ? t('已记住音频原路径；移动或删除原文件后需要重新选择。') : t('直接使用原文件，不复制音频。');
  const gptFields = provider === 'gpt_sovits' ? `<div class="field-grid">${select('reference_language', t('参考语言'), languageOptions(profile.reference_language || 'auto'))}${select('text_language', t('文本语言'), languageOptions(profile.text_language || 'auto'))}</div>${check('text_free', t('无参考文本模式'), profile.text_free || false)}` : '';
  return `<section id="reference-editor" class="reference-editor">${heading(t('参考音频'), t('选择一段角色录音，并填写录音中的台词。'))}<p class="quiet-note">${esc(audioLabel)}</p><form data-form="reference">${pathField('audio_path', t('参考音频'), profile.audio_path || '', 'reference.pick_audio', t('点击选择参考音频'), t('支持 WAV、MP3、FLAC、OGG 或 M4A'))}${textArea('reference_text', t('参考文本'), profile.reference_text ?? preset.sovits?.reference_text ?? '', 'maxlength="8192"', t('填写参考音频中实际说出的文字。'))}${gptFields}<div class="form-footer">${saveButton(t('保存参考设置'))}</div></form>${role ? '' : t('<p class="quiet-note">先填写角色名称或选择角色模型。</p>')}</section>`;
}

function renderDotsPresetEditor(id, preset, connection) {
  const role = preset.voice_id || (editor.dotsVoiceId ||= `dots-${crypto.randomUUID()}`);
  const saved = currentReference({ kind: 'dots', role });
  const profile = saved?.profile || {};
  const legacy = !!id && !profile.audio_path;
  const hint = legacy
    ? t('此旧音色尚未记录原文件路径，仍可沿用服务内文件名；选择原文件后会改用新路径。')
    : t('使用原文件，不复制音频。原文件移动或删除后需重新选择。');
  return `${heading(id ? t('编辑 dots 音色') : t('添加 dots 音色'), t('选择一段录音作为参考声音。'))}<form data-form="dots-preset" data-id="${esc(id || '')}" data-connection-id="${esc(connection.id)}">${field('name', t('音色名称'), preset.name || '', t('required maxlength="100" placeholder="例如：日常播报"'))}${pathField('audio_path', t('参考音频'), profile.audio_path || '', 'reference.pick_audio', t('点击选择参考音频'), hint)}${textArea('reference_text', t('参考文本（可选）'), profile.reference_text || '', 'maxlength="8192"', t('可填写参考音频中说出的文字。'))}<div class="field-grid">${field('speed', t('语速'), preset.speed ?? 1, 'type="number" min="0.5" max="2" step="0.05" required')}${field('volume', t('音色音量'), preset.volume ?? 1, 'type="number" min="0" max="2" step="0.05" required')}</div><div class="form-footer">${saveButton(t('保存音色'))}${button(t('返回'), 'editor.cancel', { class: 'quiet' })}</div></form>`;
}

function renderFishPresetEditor(id, preset, connection) {
  const back = button(t('返回'), 'editor.cancel', { class: 'quiet' });
  if (!id) return `${heading(t('收藏 Fish 音色'), t('粘贴官网音色页面链接或 32 位音色 ID，填写名称后保存。'))}<form data-form="fish-voice" data-connection-id="${esc(connection.id)}">${field('id_or_url', t('音色页面链接或 ID'), '', t('required autocomplete="off" placeholder="https://fish.audio/m/… 或 32 位 ID"'))}<div class="actions">${button(t('查找官方名称'), 'fish.voice.lookup', { class: 'small quiet' })}</div><p class="quiet-note" data-fish-lookup-result role="status" hidden></p>${field('name', t('收藏名称'), '', 'maxlength="100"', t('可自行命名；留空会先读取官方名称。'))}<div class="form-footer">${saveButton(t('收藏音色'))}${back}</div></form>`;
  return `${heading(t('编辑 Fish 音色'))}<form data-form="fish-preset" data-id="${esc(id)}" data-connection-id="${esc(connection.id)}">${field('name', t('音色名称'), preset.name, 'required maxlength="100"')}<div class="field-grid">${field('speed', t('语速'), preset.speed, 'type="number" min="0.5" max="2" step="0.05" required')}${field('volume', t('音色音量'), preset.volume, 'type="number" min="0" max="2" step="0.05" required')}</div><div class="form-footer">${autoStatus()}${button(t('试听此音色'), 'fish.audition', { id, class: 'quiet' })}${back}</div></form>`;
}

function renderPresetEditor(id) {
  if (!id && !editor?.connectionId) {
    return `${heading(t('添加音色'), t('选择语音服务。'))}<div class="row-list">${snapshot.connections.map(connection => `<div class="setting-row"><div class="row-text"><div class="row-title">${esc(providerLabel(connection.settings.provider))}</div><div class="row-description">${esc(connection.name || providerLabel(connection.settings.provider))}</div></div><div class="row-actions">${button(t('选择'), 'preset.choose_service', { id: connection.id, class: 'small' })}</div></div>`).join('')}</div><div class="actions">${button(t('返回'), 'editor.cancel', { class: 'quiet' })}</div>`;
  }
  const first = snapshot.connections.find(item => item.id === editor?.connectionId) || snapshot.connections[0];
  const preset = snapshot.presets.find(item => item.id === id) || { id: '', connection_id: first?.id, provider: first?.settings.provider, voice_id: '', sovits: null };
  const connection = snapshot.connections.find(item => item.id === preset.connection_id);
  const provider = connection?.settings.provider || preset.provider;
  if (provider === 'dots' && connection) return renderDotsPresetEditor(id, preset, connection);
  if (provider === 'fish_audio' && connection) return renderFishPresetEditor(id, preset, connection);
  const selected = selectedModelPair(preset);
  let html = renderPresetCore(id);
  if (provider === 'gpt_sovits') html = html.replace(t('<details class="details"><summary>语速与其他选项'), ui`${modelPairPicker(preset)}<details class="details"><summary>语速与其他选项`);
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
      } catch (error) { modelScan.error = errorMessage(error); }
    }
  }
}

function renderBindingEditor(id) {
  const record = snapshot.bindings.find(item => item.id === id);
  const binding = record?.binding || { user_id: editor?.userId || '', user_name: editor?.userName || '', preset_id: snapshot.presets[0]?.id, enabled: true };
  return ui`${heading(id ? t('编辑观众声音') : t('指定观众声音'), t('填写观众用户名即可指定声音；也可以填写 UID 精确识别。'))}<form data-form="binding" data-id="${esc(id || '')}">${record?.binding.legacy_user_name ? ui`<p class="notice">旧配置用户名：${esc(record.binding.legacy_user_name)}。请确认后手动填写用户名或 UID。</p>` : ''}${field('user_name', t('观众用户名'), binding.user_name || '', t('maxlength="100" placeholder="输入观众当前用户名"'))}${field('user_id', t('观众 UID（选填）'), binding.user_id || '', t('inputmode="numeric" pattern="[1-9][0-9]*" placeholder="有 UID 时建议填写"'))}${select('preset_id', t('声音预设'), snapshot.presets.map(preset => option(preset.id, presetLabel(preset), binding.preset_id)).join(''))}<p class="quiet-note">按用户名精确匹配，同名账号会共用声音；填写 UID 时优先按 UID 匹配。</p>${check('enabled', t('启用此绑定'), binding.enabled)}<div class="form-footer">${autoStatus()}${button(t('返回'), 'editor.cancel', { class: 'quiet' })}</div></form>`;
}

function renderAliasEditor() {
  const name = editor?.userName || '';
  const existing = snapshot.rules.user_words.find(row => row.from === name);
  return `${heading(t('添加播报别名'), t('这位观众的用户名会在播报时替换为别名。'))}<form data-form="alias">${field('from', t('原用户名'), name, 'readonly required')}${field('to', t('播报别名'), existing?.to || '', t('required maxlength="100" placeholder="输入播报时使用的名字"'))}<div class="form-footer">${saveButton(t('保存别名'))}${button(t('返回'), 'editor.cancel', { class: 'quiet' })}</div></form>`;
}

function dictionaryRows(type, rows) {
  if (type === 'sounds') return `<div class="s-sound-grid" data-dictionary="sounds">${rows.map(row => dictionaryRow(type, row)).join('')}</div><p class="s-sound-empty">${esc(t('还没有关键词音效。'))}</p>`;
  return `<div class="s-card s-dict-card"><div data-dictionary="${type}">${rows.map(row => dictionaryRow(type, row)).join('')}</div><div class="s-row s-dict-add">${button(t('添加词条'), `dictionary.add.${type}`, { class: 'small dashed', icon: 'plus' })}</div></div>`;
}

function dictionaryRow(type, row = {}) {
  if (type === 'sounds') {
    return ui`<div class="dict-row s-sound-card"><div class="s-sound-top"><span class="s-quote" aria-hidden="true">「</span><input data-key="from" class="s-sound-trigger" value="${esc(row.from ?? row.trigger ?? '')}" aria-label="触发词" placeholder="关键词" required><span class="s-quote" aria-hidden="true">」</span>${iconButton('close', t('移除此条'), 'dictionary.remove')}</div><span class="s-sound-line" aria-hidden="true"></span><select data-key="to" aria-label="音效素材" required><option value="">选择素材</option>${snapshot.assets.map(asset => option(asset.id, asset.name, row.asset_id)).join('')}</select></div>`;
  }
  return `<div class="dict-row s-row"><input data-key="from" class="s-dict-input" value="${esc(row.from ?? '')}" aria-label="${t('原文字')}" placeholder="${t('原文字')}" required><span class="s-dict-arrow" aria-hidden="true">${icon('arrowRight')}</span><input data-key="to" class="s-dict-input" value="${esc(row.to || '')}" aria-label="${t('替换为')}" placeholder="${t('读作')}">${iconButton('close', t('移除此条'), 'dictionary.remove')}</div>`;
}

function previewEventForm() {
  return ui`<form data-form="preview"><div class="field-grid">${select('kind', t('事件类型'), option('danmaku', t('弹幕'), 'danmaku') + option('gift', t('礼物')) + option('super_chat', t('醒目留言')) + option('guard', t('大航海')))}${field('user_name', t('观众名字'), '', t('required placeholder="输入用于预览的名字"'))}${field('user_id', t('观众 UID（选填）'), '', 'inputmode="numeric"')}${field('price_yuan', t('金额（元）'), 0, 'type="number" min="0" step="0.1"')}${field('gift_name', t('礼物名称'), '')}${field('quantity', t('礼物数量'), 1, 'type="number" min="1"')}${field('guard_name', t('大航海称号'), t('舰长'))}${select('coin_type', t('礼物类型'), option('gold', t('付费礼物'), 'gold') + option('silver', t('免费礼物')))}</div>${textArea('message', t('预览消息'), '', t('placeholder="输入一段文字"'))}<div class="form-footer"><button class="button" type="submit">预览处理结果</button></div><p class="quiet-note">只预览处理结果，不请求语音服务。实际试听在“声音”页面。</p></form><div id="preview-result" class="form-result" aria-live="polite"></div>`;
}

function renderRulesSettings() {
  if (editor?.type === 'alias') return renderAliasEditor();
  const rules = snapshot.rules;
  const events = rules.events;
  const amount = (name, value, label) => `<span class="s-amount"><span aria-hidden="true">≥ ¥</span><input name="${name}" type="number" min="0" step="0.1" required value="${esc(displayNumber(value))}" aria-label="${esc(label)}"></span>`;
  const toggles = sSwitch('danmaku_on', t('弹幕'), events.danmaku_on)
    + sSwitch('filter_bilibili_emoticons', t('过滤 B站官方表情'), events.filter_bilibili_emoticons ?? true, t('仅跳过单独发送的 B站表情播报，仍显示在聊天中。普通文字、emoji 和行内表情照常播报。'))
    + sSwitch('gift_on', t('礼物'), events.gift_on, '', amount('gift_threshold_yuan', events.gift_threshold_yuan, t('礼物最低金额（元）')))
    + sSwitch('free_gift_on', t('免费礼物'), events.free_gift_on)
    + sSwitch('super_chat_on', t('醒目留言'), events.super_chat_on, '', amount('super_chat_threshold_yuan', events.super_chat_threshold_yuan, t('醒目留言最低金额（元）')))
    + sSwitch('guard_on', t('大航海'), events.guard_on);
  const template = (key, label) => {
    const id = `field-${++fieldSequence}`;
    const value = rules.templates[key] || '';
    return ui`<div class="s-row s-template"><label for="${id}">${esc(label)}</label><div class="s-template-body"><textarea id="${id}" name="template_${key}" rows="1" required data-template="${key}">${esc(value)}</textarea><span class="s-preview">预览：<span data-template-preview>${esc(templatePreview(key, value))}</span></span></div></div>`;
  };
  const templates = `<div class="s-card">${template('danmaku', t('弹幕'))}${template('gift', t('礼物'))}${template('super_chat', t('醒目留言'))}${template('guard', t('大航海'))}</div>`;
  const view = dictionaryView === 'user_words' ? 'user_words' : 'message_words';
  const seg = ui`<div class="s-seg small" role="group" aria-label="读音词典"><button type="button" data-action="dictionary.view" data-id="message_words" class="${view === 'message_words' ? 'on' : ''}" aria-pressed="${view === 'message_words'}">正文</button><button type="button" data-action="dictionary.view" data-id="user_words" class="${view === 'user_words' ? 'on' : ''}" aria-pressed="${view === 'user_words'}">用户名</button></div>`;
  const dictionary = ['message_words', 'user_words'].map(type => `<div class="s-dict" data-view="${type}"${view === type ? '' : ' hidden'}>${dictionaryRows(type, rules[type])}<p class="s-note">${esc(type === 'user_words' ? t('观众名字按这里的读法播报；直播界面观众卡片里的“读作”也保存在这里。') : t('弹幕正文中的词按这里替换后再朗读。'))}</p></div>`).join('');
  return `<div class="s-page">${heading(t('播报内容'))}<form data-form="rules">${sSection(t('读哪些消息'), `<div class="s-card">${toggles}</div>`)}${sSection(t('播报模板'), templates, '', t('可用字段：{user_name}、{message}、{gift_name}、{gift_num}、{guard_name}、{price}。'))}<section class="s-section">${sLabel(t('读音词典'), seg)}${dictionary}</section><div class="form-footer">${autoStatus()}</div></form><details class="s-details s-try"><summary>${t('预览规则')}</summary>${previewEventForm()}</details></div>`;
}

function renderAssetsSettings() {
  const asset = editor?.type === 'asset' ? snapshot.assets.find(item => item.id === editor.id) : null;
  const sounds = snapshot.rules.sounds || [];
  const add = button(t('添加音效'), 'dictionary.add.sounds', { class: 'primary small', icon: 'plus', disabled: !snapshot.assets.length });
  const assetRow = item => ui`<div class="s-row"><span class="s-text"><span>${esc(item.name)}</span><small>${Math.round(item.bytes / 1024)} KB · ${sounds.filter(rule => rule.asset_id === item.id).length} 条关键词规则引用</small></span><span class="s-row-actions">${button(t('替换'), 'asset.replace', { id: item.id, class: 'small' })}${iconButton('trash', ui`删除 ${item.name}`, 'asset.delete', item.id)}</span></div>`;
  const library = `<div class="s-card">${snapshot.assets.length ? snapshot.assets.map(assetRow).join('') : `<div class="s-row s-empty-row">${esc(t('还没有音效素材，先导入一段音频。'))}</div>`}</div>`;
  const importForm = ui`<form data-form="asset" data-id="${esc(asset?.id || '')}" class="s-card s-import"><div class="s-import-title">${asset ? ui`替换「${esc(asset.name)}」` : t('导入音频')}</div><div class="s-import-fields">${asset ? '' : field('name', t('素材名称'), '', 'required')}${field('path', t('音频文件完整路径'), '', t('required placeholder="例如：E:\\Audio\\hello.wav"'), t('支持 WAV、MP3 等常用音频；文件会复制到当前应用的数据目录。'))}</div><div class="form-footer">${saveButton(asset ? t('替换音频') : t('导入素材'))}${asset ? button(t('取消替换'), 'editor.cancel', { class: 'quiet' }) : ''}</div></form>`;
  return `<div class="s-page"><div class="s-page-head">${heading(t('关键词音效'))}${add}</div><form data-form="sound-words" class="s-sound-form">${dictionaryRows('sounds', sounds)}${autoStatus()}</form><p class="s-note">${esc(t('弹幕包含触发词时会播放对应音效。'))}</p>${sSection(t('音效素材'), library + importForm)}</div>`;
}

// ---------- OBS overlay (experimental) ----------
const overlayDefaultTagline = "say a word — it'll be read aloud.";
const overlayWeekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function overlayMaskedUrl(url, token) {
  if (!url || !token) return '';
  return url.replace(token, `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-4)}`);
}

// The preview uses the canvas OBS reports for its browser source, and 1080p until one connects.
function overlayPreviewSize() {
  const client = (snapshot.overlay?.clients || [])[0];
  return client ? { width: client.width, height: client.height, note: t('来自 OBS') } : { width: 1920, height: 1080, note: t('连上 OBS 后按实际画布显示') };
}

function overlayStatus() {
  const view = snapshot.overlay || {};
  const clients = view.clients || [];
  if (!view.settings?.enabled) return { tone: 'idle', text: t('未启用 · 打开右上角的开关后，OBS 才能显示叠加层') };
  if (view.error) return { tone: 'error', text: errorMessage(view.error) };
  if (!view.running) return { tone: 'pending', text: t('正在启动…') };
  if (!clients.length) return { tone: 'pending', text: t('等待 OBS 连接 · 在 OBS 中添加浏览器来源并粘贴地址') };
  const [first] = clients;
  return { tone: 'ready', text: ui`OBS 已连接 · ${first.width} × ${first.height}` + (clients.length > 1 ? ui` · ${clients.length} 个画面` : '') };
}

function renderOverlaySettings() {
  const view = snapshot.overlay;
  if (!view?.settings) return `<div class="s-page">${heading(t('OBS 叠加层'))}${empty(t('桌面连接不可用。'))}</div>`;
  const s = view.settings;
  const radio = (name, value, label, current) => `<label><input type="radio" name="${name}" value="${value}"${current === value ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  const backdrop = (value, label) => `<button type="button" class="s-ovl-swatch ${value}" data-action="overlay.preview" data-id="backdrop=${value}" aria-pressed="${overlayPreview.backdrop === value}" aria-label="${esc(label)}" title="${esc(label)}"></button>`;
  const range = (name, label, value, min, max, step, note = '') => {
    const id = `field-${++fieldSequence}`;
    return `<div class="s-row"><label class="s-text" for="${id}"><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</label><input id="${id}" class="s-range" type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${esc(displayNumber(value))}"><output class="s-num s-range-value" data-overlay-out="${name}"></output></div>`;
  };
  const textRow = (name, label, value, attrs, note) => {
    const id = `field-${++fieldSequence}`;
    return `<div class="s-row s-wrap"><label class="s-text" for="${id}"><span>${esc(label)}</span><small>${esc(note)}</small></label><input id="${id}" class="s-input s-overlay-text" name="${name}" value="${esc(value)}" ${attrs}></div>`;
  };
  const lingerId = `field-${++fieldSequence}`;
  const styleCard = (value, name, english, note) => ui`<label class="s-ovl-style"><input type="radio" name="style" value="${value}"${s.style === value ? ' checked' : ''}><span class="s-ovl-thumb ${value}" aria-hidden="true"><i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i><i class="e"></i><i class="f"></i></span><span class="s-ovl-style-name"><strong>${esc(name)}</strong><em>${english}</em></span><small>${esc(note)}</small></label>`;
  const preview = ui`<div class="s-ovl-preview">
<div class="ovp" data-style="${s.style}" data-corner="${s.corner}" data-backdrop="${overlayPreview.backdrop}"><div class="ovp-stage" aria-hidden="true"><div class="ovp-block"><i class="ovp-vig"></i><i class="ovp-card"></i><i class="ovp-spine"></i>
<div class="ovp-mast"><div class="ovp-kicker"><i class="ovp-dot"></i><span class="ovp-live">LIVE</span><span class="ovp-sep">·</span><span data-ovp-day>SAT</span><span class="ovp-time" data-ovp-time>21:04</span></div><div class="ovp-title" data-ovp-title></div><div class="ovp-tagrow"><i class="ovp-rule"></i><span class="ovp-tagline" data-ovp-tagline></span></div></div>
<div class="ovp-list"><div class="ovp-item spot"><span class="ovp-av"><i class="ovp-ring"></i><i class="ovp-face"></i></span><span class="ovp-text"><span class="ovp-lit">${esc(t('这一波要是没闪现就寄了，主播反应好快'))}</span></span><span class="ovp-prog"><i class="ovp-fill"></i><i class="ovp-comet"></i></span></div><div class="ovp-item"><span class="ovp-av"><i class="ovp-face two"></i></span><span class="ovp-text">${esc(t('晚上好呀，今天也来听你读弹幕'))}</span></div></div></div></div>
</div>
<div class="s-ovl-under"><div class="s-ovl-backdrops" role="group" aria-label="${esc(t('预览背景'))}">${backdrop('dark', t('深色背景'))}${backdrop('light', t('亮色背景'))}${backdrop('clear', t('透明背景'))}</div><span class="s-ovl-size" data-ovp-size></span><span class="s-ovl-tests" title="${esc(t('发一条测试内容到 OBS 里的叠加层'))}">${button(t('测试弹幕'), 'overlay.test', { id: 'danmaku', class: 'small', icon: 'play' })}${button(t('测试醒目留言'), 'overlay.test', { id: 'super_chat', class: 'small' })}</span></div></div>`;
  const address = ui`<div class="s-card"><div class="s-row s-wrap s-ovl-address"><span class="s-text"><span>叠加层地址</span><small class="s-ovl-url" data-overlay-url></small></span><span class="s-row-actions">${button(t('复制地址'), 'overlay.copy', { class: 'small primary', icon: 'check' })}${button(t('重新生成'), 'overlay.token.reset', { class: 'small', icon: 'refresh' })}</span></div><div class="s-row s-ovl-status" data-overlay-status><span class="service-light idle"></span><span data-overlay-status-text></span></div><div class="s-row"><span class="s-text"><small>在 OBS 里添加“浏览器”来源，粘贴地址，宽和高填 OBS 的画布分辨率（设置 → 视频 → 基础分辨率）。叠加层按画面大小自动缩放，1080p、2K、4K、16:10 和带鱼屏都能直接用。</small></span></div></div>`;
  const look = ui`<div class="s-ovl-styles" role="radiogroup" aria-label="${esc(t('样式'))}">${styleCard('card', t('一体卡'), 'one card', t('刊头和弹幕收进一张玻璃卡片，读完的弹幕变成小行。'))}${styleCard('spine', t('光脊'), 'spine', t('一条发光的竖线串起刊头和弹幕，没有底板，最轻。'))}</div><div class="s-card"><div class="s-row s-wrap"><span class="s-text"><span id="overlay-corner-label">位置</span></span><div class="s-seg" role="radiogroup" aria-labelledby="overlay-corner-label">${radio('corner', 'top_left', t('左上'), s.corner)}${radio('corner', 'top_right', t('右上'), s.corner)}${radio('corner', 'bottom_left', t('左下'), s.corner)}${radio('corner', 'bottom_right', t('右下'), s.corner)}</div></div>${range('scale', t('大小'), s.scale, .5, 2, .05)}${range('vignette', t('暗角深浅'), s.vignette, 0, 1, .05, t('在亮的游戏画面上调深一些，文字更清楚。'))}</div>`;
  const masthead = ui`<div class="s-card">${textRow('title', t('标题'), s.title, 'maxlength="12" required', t('最多 12 个字，例如“今晚的弹幕”。'))}${textRow('tagline', t('副标题'), s.tagline, `maxlength="48" placeholder="${esc(overlayDefaultTagline)}"`, t('冷场时显示。建议写英文，留空用默认的一句。'))}</div>`;
  const content = ui`<div class="s-card">${sSwitch('show_danmaku', t('弹幕'), s.show_danmaku)}${sSwitch('show_gift', t('礼物'), s.show_gift)}${sSwitch('show_super_chat', t('醒目留言'), s.show_super_chat, t('单独显示在画面上方正中。'))}${sSwitch('show_guard', t('大航海'), s.show_guard)}<div class="s-row s-wrap"><span class="s-text"><span id="overlay-names-label">观众名字</span><small>看直播和录播的观众只需要看到内容，默认只在礼物和醒目留言旁显示名字。</small></span><div class="s-seg" role="radiogroup" aria-labelledby="overlay-names-label">${radio('names', 'none', t('不显示'), s.names)}${radio('names', 'special', t('仅礼物与醒目留言'), s.names)}${radio('names', 'all', t('全部'), s.names)}</div></div>${sSwitch('merge_duplicates', t('合并重复弹幕'), s.merge_duplicates, t('同样的话连着出现时显示为“×N”。'))}<div class="s-row"><label class="s-text" for="${lingerId}"><span>停留时间</span><small>没有在朗读的弹幕显示多久后淡出。</small></label><span class="s-amount"><input id="${lingerId}" name="linger_seconds" type="number" min="3" max="120" step="1" required value="${esc(s.linger_seconds)}"><span>秒</span></span></div></div>`;
  const enabledId = `field-${++fieldSequence}`;
  return ui`<form data-form="overlay" class="s-page s-ovl" novalidate><div class="s-page-head"><div class="s-ovl-head"><div class="s-ovl-title-row">${heading(t('OBS 叠加层'))}<span class="s-ovl-badge">实验性</span></div><p class="s-ovl-lede">把弹幕和正在朗读的内容画进直播画面，看录播的观众也能看到。</p></div><label class="s-ovl-enable" for="${enabledId}"><span>启用</span><input id="${enabledId}" class="s-switch" type="checkbox" role="switch" name="enabled"${s.enabled ? ' checked' : ''}></label></div>${preview}${sSection(t('添加到 OBS'), address, `<span class="s-label-note">${esc(t('地址只在本机可用，重新生成会让旧地址失效'))}</span>`)}${sSection(t('样式'), look)}${sSection(t('刊头文字'), masthead)}${sSection(t('显示内容'), content)}${autoStatus()}</form>`;
}

// Connection state changes while the page is open; only the status parts are rewritten.
function updateOverlayStatus() {
  const page = settingsDialog.querySelector?.('form[data-form="overlay"]');
  if (!page || !snapshot.overlay) return;
  const view = snapshot.overlay;
  const status = overlayStatus();
  const light = page.querySelector('[data-overlay-status] .service-light');
  const lightClass = `service-light ${status.tone}`;
  if (light && light.className !== lightClass) light.className = lightClass;
  const text = page.querySelector('[data-overlay-status-text]');
  if (text && text.textContent !== status.text) text.textContent = status.text;
  const url = page.querySelector('[data-overlay-url]');
  const masked = view.settings?.enabled ? overlayMaskedUrl(view.url, view.settings?.token) : t('启用后生成本机地址');
  if (url && url.textContent !== masked) url.textContent = masked;
  for (const node of page.querySelectorAll('[data-action="overlay.copy"]')) node.disabled = !view.settings?.enabled || !view.settings?.token;
  for (const node of page.querySelectorAll('[data-action="overlay.test"]')) node.disabled = !view.running;
  updateOverlayPreview();
}

function updateOverlayPreview() {
  const frame = settingsDialog.querySelector?.('.ovp');
  const form = frame?.closest('form');
  if (!frame || !form) return;
  const field = name => form.elements[name];
  const choice = name => form.querySelector(`input[name="${name}"]:checked`)?.value;
  const scale = Math.min(2, Math.max(.5, Number(field('scale')?.value) || 1));
  const vignette = Math.min(1, Math.max(0, Number(field('vignette')?.value)));
  frame.dataset.style = choice('style') || 'spine';
  frame.dataset.corner = choice('corner') || 'top_left';
  frame.dataset.backdrop = overlayPreview.backdrop;
  frame.style.setProperty('--ovp-scale', String(scale));
  frame.style.setProperty('--ovp-vig', String(Number.isFinite(vignette) ? vignette : .6));
  const size = overlayPreviewSize();
  frame.style.setProperty('--ovp-ratio', `${size.width} / ${size.height}`);
  const title = String(field('title')?.value || '').trim() || '今晚的弹幕';
  const tagline = String(field('tagline')?.value || '').trim() || overlayDefaultTagline;
  const now = new Date();
  const values = {
    '[data-ovp-title]': title, '[data-ovp-tagline]': tagline,
    '[data-ovp-day]': overlayWeekdays[now.getDay()], '[data-ovp-time]': `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    '[data-ovp-size]': `${size.width} × ${size.height} · ${size.note}`,
    '[data-overlay-out="scale"]': `${Math.round(scale * 100)}%`, '[data-overlay-out="vignette"]': `${Math.round((Number.isFinite(vignette) ? vignette : .6) * 100)}%`,
  };
  for (const [selector, value] of Object.entries(values)) {
    const node = form.querySelector(selector);
    if (node && node.textContent !== value) node.textContent = value;
  }
  for (const button of form.querySelectorAll('[data-action="overlay.preview"]')) {
    const [key, value] = button.dataset.id.split('=');
    button.setAttribute('aria-pressed', String(overlayPreview[key] === value));
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; }
  catch { /* Some WebView2 builds refuse the async clipboard; fall back to a selection copy. */ }
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error(t('无法复制到剪贴板，请稍后重试'));
}

function renderAudioSettings() {
  const prefs = snapshot.preferences;
  const id = `field-${++fieldSequence}`;
  const volume = prefs.muted ? 0 : Math.round((Number(prefs.master_volume ?? 1) || 0) * 100);
  return ui`<section class="s-section">${sLabel(t('音频输出'))}<form data-form="audio" class="s-card"><div class="s-row"><label class="s-text" for="${id}"><span>输出设备</span></label><select id="${id}" name="output">${option('', t('跟随系统默认设备'), deviceValue(prefs.output)) + (snapshot.devices || []).map(device => option(device.name, `${device.name}${device.is_default ? t('（系统默认）') : ''}`, deviceValue(prefs.output))).join('')}</select></div><div class="s-row"><span class="s-text"><span>播报主音量</span><small>在直播界面底部调节</small></span><span class="s-num">${volume}</span></div><div class="s-row s-wrap"><span class="s-text"><span>测试与重连</span><small>切换或重连设备会停止播放并清空待播队列。</small></span><span class="s-row-actions">${button(t('播放测试音'), 'audio.test', { class: 'small primary', icon: 'play' })}${button(t('刷新设备'), 'devices.refresh', { class: 'small', icon: 'refresh' })}${button(t('重新连接设备'), 'audio.reconnect', { class: 'small', icon: 'audio' })}</span></div><div id="audio-playback-error" class="inline-error" role="alert" hidden></div>${autoStatus()}</form></section>`;
}

function renderAppearanceSettings() {
  const prefs = snapshot.preferences;
  const selectedScale = Math.min(1.4, Math.max(.8, Math.round((Number(prefs.scale) || 1) * 10) / 10));
  const appearance = prefs.appearance || 'system';
  const themes = [['system', t('跟随系统')], ['dark', t('夜幕')], ['light', t('晨雾')]]
    .map(([id, name]) => `<label class="s-theme"><input type="radio" name="appearance" value="${id}"${appearance === id ? ' checked' : ''}><span class="s-theme-preview ${id}" aria-hidden="true"></span><span>${esc(name)}</span></label>`).join('');
  const scaleId = `field-${++fieldSequence}`;
  const language = prefs.language || 'zh-CN';
  const languages = [['zh-CN', '简体中文'], ['en', 'English']].map(([id, name]) => `<label><input type="radio" name="language" value="${id}"${language === id ? ' checked' : ''}><span>${name}</span></label>`).join('');
  return ui`<section class="s-section">${sLabel(t('外观'))}<form data-form="appearance"><div class="s-themes" role="radiogroup" aria-label="主题">${themes}</div><div class="s-card"><div class="s-row"><label class="s-text" for="${scaleId}"><span>界面缩放</span></label><select id="${scaleId}" name="scale">${[.8, .9, 1, 1.1, 1.2, 1.3, 1.4].map(scale => option(scale, `${Math.round(scale * 100)}%`, selectedScale)).join('')}</select></div></div>${autoStatus()}</form></section><div class="s-card"><form data-form="language" class="s-row"><span class="s-text"><span id="language-label">界面语言</span></span><div class="s-seg" role="radiogroup" aria-labelledby="language-label">${languages}</div></form><form data-form="startup">${sSwitch('enabled', t('开机时启动'), snapshot.startup_enabled)}${autoStatus()}</form></div>`;
}

async function changeLanguage(language) {
  if (language === (snapshot.preferences?.language || 'zh-CN')) return;
  if (!await flushAutosaves()) return;
  await command('preferences.save', { preferences: { language } });
  showToast(t('语言已保存'));
}

function renderDataSettings() {
  const panel = migrationPreview ? 'import' : dataPanel;
  const tab = (id, label) => `<button type="button" class="button${panel === id ? ' active' : ''}" data-action="data.panel" data-id="${id}" aria-expanded="${panel === id}">${esc(label)}</button>`;
  const exportForm = ui`<form data-form="export" class="s-card s-import"><div class="s-import-title">导出配置</div>${field('path', t('保存为'), '', t('required placeholder="例如：E:\\Backups\\danmakuvoice.json"'), t('保存到一个新文件；导出不包含登录凭据、音效文件和聊天记录。'))}<div class="form-footer">${saveButton(t('导出无凭据配置'))}</div></form>`;
  const importForm = ui`<form data-form="migration-preview" class="s-card s-import"><div class="s-import-title">从旧版导入</div>${field('path', t('旧 config.json 的完整路径'), '', 'required', t('先读取预览，再由你选择要导入的内容。不会自动导入账号凭据。'))}<div class="form-footer">${saveButton(t('读取导入预览'))}</div></form>`;
  return ui`<section class="s-section">${sLabel(t('数据与迁移'))}<div class="s-button-row">${tab('import', t('导入旧配置'))}${tab('export', t('导出配置'))}${button(t('清除应用数据'), 'data.clear', { class: 'danger' })}</div>${panel === 'export' ? exportForm : panel === 'import' ? importForm : ''}<div id="migration-preview">${migrationPreview ? renderMigrationPreview() : ''}</div><div id="operation-result" class="form-result"></div><p class="s-note">导出的配置不包含登录凭据。清除应用数据会删除本机保存的账号、语音服务凭据、设置、音效和备份，然后重新开始设置。</p></section>`;
}

function renderMigrationPreview() {
  const preview = migrationPreview;
  return ui`<form data-form="migration-apply" class="editor"><h3>选择要导入的内容</h3><p class="quiet-note">直播间：${esc(preview.room_id || t('未设置'))}；服务 ${preview.provider_settings?.length || 0} 个；待确认用户绑定 ${preview.voice_bindings?.length || 0} 条；音效 ${preview.sounds?.length || 0} 个。</p>${check('import_rules', t('播报规则和词典'))}${check('import_live_settings', t('直播间设置'))}${check('import_connections', t('服务连接与声音预设'))}${check('import_pending_bindings', t('待确认 UID 的用户声音绑定'))}<details class="details"><summary>查看规则与服务内容</summary><pre class="code-output">${esc(JSON.stringify({ rules: preview.rules, provider_settings: preview.provider_settings, model_references: preview.model_references, gift_merge: preview.gift_merge }, null, 2))}</pre></details>${preview.sounds?.length ? ui`<details class="details" open><summary>选择要复制的音效文件</summary><div class="migration-sounds">${preview.sounds.map(sound => { const ready = sound.path_state === 'present' && Boolean(sound.source_sha256) && Number.isSafeInteger(sound.source_bytes); return `<label class="check"><input type="checkbox" name="selected_sound_ids" value="${esc(sound.preview_asset_id)}"${ready ? '' : ' disabled'}><span>${esc(sound.trigger)}<small>${esc(sound.source_path)} · ${ready ? t('可导入') : t('文件或预览校验不可用')}</small></span></label>`; }).join('')}</div></details>` : ''}<details class="details"><summary>替换已有设置</summary>${check('replace_existing_rules', t('允许覆盖当前播报规则'))}${check('replace_existing_live_settings', t('允许覆盖当前直播间设置'))}</details>${preview.warnings?.length ? ui`<details class="details" open><summary>需要注意的内容（${preview.warnings.length}）</summary><div class="code-output">${preview.warnings.map(warning => ui`${esc(warning.path)}：${esc(warning.message)}`).join('\n')}</div></details>` : ''}<p class="quiet-note">确认导入前会自动备份当前数据库。名字绑定必须补充 UID 才会生效。</p><div class="form-footer">${saveButton(t('确认所选内容'))}${button(t('取消导入'), 'migration.cancel', { class: 'quiet' })}</div></form>`;
}

async function confirmAction(title, message, label = t('确认'), danger = true) {
  if (confirmationDialog.open) return false;
  return new Promise(resolve => {
    confirmationDialog.innerHTML = ui`<h2 id="confirmation-title">${esc(title)}</h2><p>${esc(message)}</p><form method="dialog"><div class="actions"><button class="button quiet" value="cancel" autofocus>取消</button><button class="button ${danger ? 'danger' : 'primary'}" value="confirm">${esc(label)}</button></div></form>`;
    confirmationDialog.returnValue = '';
    confirmationDialog.addEventListener('close', () => resolve(confirmationDialog.returnValue === 'confirm'), { once: true });
    confirmationDialog.showModal();
  });
}

async function connectFishCredential(credential, form = null) {
  const existing = serviceConnection('fish_audio');
  const next = await command('fish.connect', { credential, connection_id: existing?.id }, { success: t('Fish Audio 账号已验证并连接') });
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
  if (!await confirmAction(t('放弃未完成的填写？'), t('离开后，本页尚未提交的内容会丢失。'), t('放弃修改'))) return false;
  for (const form of pending) delete form.dataset.dirty;
  return true;
}

async function closeSettings() {
  if (!await allowLeaveSettings()) return;
  if (!await settleVoiceAuditionChoice()) return;
  hidePushCredentials(settingsDialog);
  closeSelect();
  if (aliasReturnContext && editor?.type === 'alias') { restoreAliasNavigation(); return; }
  if (editor?.type === 'qr') await cancelQr();
  if (editor?.type === 'qr') editor = null;
  tabEditors.set(settingsTab, editor);
  settingsDirty = false; leaveGhost(settingsDialog, 260); settingsDialog.close();
  if (step === 'main') updateLive();
  if (step === 'login' && !qrProvider) void startQr('bilibili');
  if (step === 'doubaoQr' && !qrProvider) void startQr('doubao');
}

async function refreshLocalServices(force = false) {
  if (localRefreshBusy || snapshot?.network_disabled || !settingsDialog.open || settingsTab !== 'voices' || !uiIsActive(nativeActive, windowFocused, document.hidden)) return;
  const connections = ['dots', 'gpt_sovits'].map(provider => serviceConnection(provider)).filter(Boolean);
  const signature = JSON.stringify(connections.map(connection => [connection.id, connection.settings.endpoint]));
  if (!force && signature === localRefreshSignature && Date.now() - localRefreshAt < 10000) return;
  localRefreshBusy = true;
  localRefreshAt = Date.now();
  localRefreshSignature = signature;
  try {
    for (const connection of connections) {
      if (!settingsDialog.open || disposed || snapshot?.network_disabled) break;
      try {
        await command('local_services.check', { provider: connection.settings.provider, connection_id: connection.id, automatic: true }, { quiet: true, silent: true });
      } catch { /* Automatic observations retry; explicit checks still report errors. */ }
    }
  } finally { localRefreshBusy = false; }
}

async function openSettings(tab) {
  if (qrProvider) await cancelQr();
  if (tab) tab = settingsTabId(tab);
  if (tab && tab !== settingsTab) { tabEditors.set(settingsTab, editor); settingsTab = tab; editor = tabEditors.get(tab) || null; renderSettings(); }
  else if (!settingsDialog.open || !settingsDialog.querySelector('.settings-shell')) renderSettings();
  settingsDialog.showModal();
  placeSettingsInk();
  void refreshLocalServices(true);
}

function restoreAliasNavigation() {
  const origin = aliasReturnContext;
  if (!origin) return;
  aliasReturnContext = null;
  settingsTab = origin.tab; editor = origin.editor;
  settingsDirty = false;
  closeSelect(); settingsDialog.close();
  if (step === 'main') updateLive();
}

async function openViewerSettings(tab, nextEditor) {
  if (nextEditor?.type === 'alias' && aliasReturnContext && settingsDialog.open) return;
  if (nextEditor?.type === 'alias' && !settingsDialog.open) {
    aliasReturnContext = { tab: settingsTab, editor };
  }
  if (qrProvider) await cancelQr();
  tabEditors.set(settingsTab, editor);
  settingsTab = tab;
  editor = nextEditor;
  renderSettings();
  settingsDialog.showModal();
  placeSettingsInk();
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
  if (action === 'speech.toggle') {
    const enabled = !!(snapshot.setup?.tts_enabled ?? snapshot.preferences?.tts_enabled);
    await command('preferences.save', { preferences: { tts_enabled: !enabled } }, { quiet: true });
    // Turning speech on sends one soft ring out of the voice orb.
    const orb = document.querySelector('#tts-switch .orb');
    if (!enabled && orb?.classList && motionAllowed()) { orb.classList.remove('pulse'); orb.getBoundingClientRect(); orb.classList.add('pulse'); }
    return;
  }
  if (action === 'queue.jump') return command('queue.jump', { id: Number(id) }, { quiet: true });
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
    catch (error) { updateError = errorMessage(error, 'DV-U01'); }
    finally { updateBusy = false; if (settingsDialog.open && settingsTab === 'data') renderSettings(); }
    return;
  }
  if (settingsDialog.open && !['settings.close', 'settings.tab', 'editor.cancel', 'autosave.retry', 'autosave.discard', 'draft.discard', 'overlay.preview', 'overlay.copy'].includes(action) && !action.startsWith('dictionary.')) {
    const replacesSettings = ['room.anonymous', 'bili.use_account', 'bili.logout', 'bili.begin', 'doubao.begin', 'fish.restore_builtin', 'service.configure', 'service.prefer', 'service.add_preset', 'voice-audition.add', 'preset.choose_service', 'preset.default', 'preset.clear-default', 'asset.replace', 'models.refresh', 'onboarding.reset', 'migration.cancel'].includes(action)
      || /^(preset|binding)\.(new|edit|delete)$/.test(action) || action === 'asset.delete';
    if (!await (replacesSettings ? allowLeaveSettings() : flushAutosaves())) return;
  }
  if (['tts.select', 'service.prefer', 'preset.default', 'preset.clear-default', 'voice-audition.add', 'fish.audition', 'settings.tab'].includes(action)) await settleVoiceAuditionChoice();
  if (action === 'tts.open') {
    const menu = document.querySelector('#tts-menu');
    if (!menu.hidden) { closeVoicePanel(); return; }
    document.querySelector('#queue-panel')?.setAttribute('hidden', '');
    voiceBrowse = snapshot.presets?.find(item => item.id === snapshot.rules?.default_preset_id)?.provider || 'doubao';
    renderVoicePanel();
    menu.hidden = false;
    target?.setAttribute('aria-expanded', 'true');
    return;
  }
  if (action === 'voice.browse') { voiceBrowse = id; renderVoicePanel(); return; }
  if (action === 'voice.login') { closeVoicePanel(); return guideDoubaoLogin(rememberedPreset('doubao')?.id); }
  if (action === 'voice.pick') {
    const preset = snapshot.presets.find(item => item.id === id);
    if (!preset) return;
    if (preset.provider === 'doubao' && !doubaoConnection(preset)?.has_credential) { closeVoicePanel(); return guideDoubaoLogin(preset.id); }
    await command('presets.default', { id: preset.id }, { quiet: true });
    renderVoicePanel();
    return;
  }
  if (action === 'voice.audition') {
    auditionPresetId = id; auditionStartedAt = Date.now(); renderVoicePanel();
    await command('audition', { preset_id: id, text: voiceAuditionDraft.text || t('你好，欢迎来到直播间。') }, { quiet: true });
    return;
  }
  if (action === 'queue.toggle') {
    const panel = document.querySelector('#queue-panel');
    closeVoicePanel();
    if (!panel.hidden) { closeQueuePanel(); return; }
    queueSignature = '';
    renderQueuePanel(normalizedEvents(snapshot));
    panel.hidden = false;
    target?.setAttribute('aria-expanded', 'true');
    return;
  }
  if (action === 'theme.toggle') {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    revealTheme(next, target);
    await command('preferences.save', { preferences: { appearance: next } }, { quiet: true });
    for (const choice of settingsDialog.querySelectorAll('input[name="appearance"]')) choice.checked = choice.value === next;
    return;
  }
  if (action === 'tts.select') {
    closeVoicePanel();
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
      throw new Error(t('请先在声音设置中添加这个服务的音色。'));
    }
    await command('presets.default', { id: preset.id }, { success: ui`已切换到 ${providerLabel(id)}` });
    return;
  }
  if (action === 'viewer.open') {
    const item = feedEvents.get(id);
    if (!item) return;
    closeVoicePanel();
    document.querySelector('#queue-panel')?.setAttribute('hidden', '');
    await flushViewerAlias();
    viewerContext = item;
    viewerOpenIdentity = viewerIdentity(item);
    renderViewerDrawer();
    feedSignature = '';
    liveRenderSignature = '';
    updateLive();
    return;
  }
  if (action === 'viewer.close') return closeViewerDrawer();
  if (action === 'viewer.bind') return bindViewerVoice(id || '');
  if (action === 'viewer.audition') {
    const event = viewerContext;
    if (!event) return;
    const presetId = (viewerBinding(event)?.binding?.enabled && viewerBinding(event).binding.preset_id) || snapshot.rules?.default_preset_id;
    if (!presetId) throw new Error(t('请先添加一个声音预设'));
    await flushViewerAlias();
    const spoken = viewerAlias(event) || event.user_name || t('访客');
    return command('audition', { preset_id: presetId, text: `${spoken}：${eventText(event) || t('你好，欢迎来到直播间。')}` }, { quiet: true });
  }
  if (action === 'viewer.manage') {
    await flushViewerAlias();
    viewerContext = null; viewerOpenIdentity = ''; renderViewerDrawer();
    return openSettings('voices');
  }
  if (action === 'viewer.voice' || action === 'viewer.alias') {
    const item = viewerContext;
    if (!item) return;
    if (action === 'viewer.voice') {
      const hasUid = validUid(item.user_id);
      if (!hasUid && !String(item.user_name || '').trim()) throw new Error(t('这条弹幕没有可用用户名或 UID，无法指定声音。'));
      if (!snapshot.presets?.length) { await openViewerSettings('voices', null); showToast(t('请先添加一个声音预设')); return; }
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
    closeVoicePanel();
    if (viewerContext) { await flushViewerAlias(); viewerContext = null; viewerOpenIdentity = ''; renderViewerDrawer(); }
    return openSettings(action === 'settings.room' ? 'room' : 'voices');
  }
  if (action === 'settings.close') return closeSettings();
  if (action === 'broadcast.refresh') {
    const form = document.querySelector('[data-broadcast-scope] form[data-form="broadcast-room"][data-dirty]');
    if (form && !await confirmAction(t('放弃未保存的直播信息？'), t('刷新会读取 B站上的标题和分区，本页尚未保存的修改会丢失。'), t('放弃修改'))) return;
    if (form) delete form.dataset.dirty;
    return runBroadcastAction('refresh');
  }
  if (action === 'broadcast.start') return startBroadcast();
  if (action === 'broadcast.stop') return stopBroadcast();
  if (action === 'broadcast.hide') { hidePushCredentials(target.closest('[data-broadcast-scope]') || document); return; }
  if (action === 'broadcast.forget') { hidePushCredentials(); return runBroadcastAction('forget'); }
  if (action === 'broadcast.reveal' || action.startsWith('broadcast.copy.')) return revealOrCopyCredentials(action, target);
  if (action === 'onair.info') return openOnAirPanel('info');
  if (action === 'onair.push') return openOnAirPanel('push');
  if (action === 'onair.close') {
    const form = document.querySelector('#onair-panel form[data-dirty]');
    if (form && !await confirmAction(t('放弃未保存的直播信息？'), t('关闭后，尚未保存的标题和分区修改会丢失。'), t('放弃修改'))) return;
    closeOnAirPanel(true); return;
  }
  if (action === 'overlay.preview') {
    const [key, choice] = String(id).split('=');
    if (key in overlayPreview) overlayPreview[key] = choice;
    updateOverlayPreview();
    return;
  }
  if (action === 'overlay.copy') {
    const url = snapshot.overlay?.url;
    if (!url || !snapshot.overlay?.settings?.token) return;
    await copyText(url);
    showToast(t('地址已复制，粘贴到 OBS 的浏览器来源'));
    return;
  }
  if (action === 'overlay.token.reset') {
    if (!await confirmAction(t('重新生成叠加层地址？'), t('旧地址会立即失效，OBS 里的浏览器来源需要换成新地址。'), t('重新生成'))) return;
    await command('overlay.token.reset', {}, { success: t('已生成新地址，记得更新 OBS 里的地址') });
    updateOverlayStatus();
    return;
  }
  if (action === 'overlay.test') {
    await command('overlay.test', { kind: id === 'super_chat' ? 'super_chat' : 'danmaku' }, { quiet: true });
    return;
  }
  if (action === 'settings.tab') {
    if (!await allowLeaveSettings()) return;
    if (editor?.type === 'qr') await cancelQr();
    tabEditors.delete(settingsTab);
    tabEditors.delete(settingsTabId(id));
    aliasReturnContext = null;
    settingsTab = settingsTabId(id); editor = null; renderSettings();
    void refreshLocalServices(true);
    document.querySelector('#settings-content').focus({ preventScroll: true }); return;
  }
  if (action === 'setup.start') return setStep('connect');
  if (action === 'setup.qr') return setStep('login');
  if (action === 'setup.uid') { await cancelQr(); return setStep('uid'); }
  if (action === 'setup.back') {
    await cancelQr();
    const previous = { connect: 'welcome', login: 'connect', uid: 'connect', tts: 'connect', doubaoQr: 'tts', ready: 'tts' };
    return setStep(previous[step] || 'welcome');
  }
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
    if (await confirmAction(action === 'queue.clear' ? t('清空待播队列？') : t('断开直播并停止全部播报？'), action === 'queue.clear' ? t('尚未播放的消息会被移除，当前播报继续。') : t('将断开直播间、停止当前播放并清空待播消息。重新接收需再次连接。'), t('确认停止'))) await command(action);
    return;
  }
  if (action === 'data.panel') { dataPanel = dataPanel === id ? null : id; if (!dataPanel) migrationPreview = null; renderSettings(); return; }
  if (action === 'room.anonymous') { editor = { type: 'anonymous-room' }; renderSettings(); return; }
  if (action === 'bili.use_account') { await command(action, {}, { success: t('已切换到你的直播间') }); editor = null; renderSettings(); return; }
  if (action === 'bili.logout') { if (await confirmAction(t('退出哔哩哔哩账号？'), t('将清除本机保存的账号凭据。'))) { await command(action, { confirmed: true }); renderSettings(); } return; }
  if (action === 'fish.open_keys' || action === 'fish.open_discovery') {
    await command('external.open', { page: action === 'fish.open_keys' ? 'fish_keys' : 'fish_discovery' });
    return;
  }
  if (action === 'fish.restore_builtin') {
    const connection = serviceConnection('fish_audio');
    if (!connection?.has_credential) throw new Error(t('请先连接 Fish Audio 账号。'));
    const next = await command('fish.voices.restore_builtin', { connection_id: connection.id });
    renderSettings();
    showToast(next.result?.length ? ui`已恢复 ${next.result.length} 个内置音色` : t('内置音色已齐全'));
    return;
  }
  if (action === 'fish.voice.lookup') {
    const form = target.closest('[data-form="fish-voice"]');
    const idOrUrl = form?.elements.id_or_url.value.trim();
    const connectionId = form?.dataset.connectionId;
    if (!idOrUrl || !connectionId) throw new Error(t('请填写音色页面链接或 32 位音色 ID。'));
    const next = await command('fish.voice.lookup', { connection_id: connectionId, id_or_url: idOrUrl });
    if (form.elements.id_or_url.value.trim() !== idOrUrl) return;
    form.elements.id_or_url.value = next.result.voice_id;
    if (!form.elements.name.value.trim()) form.elements.name.value = String(next.result.name || '').slice(0, 100);
    const status = form.querySelector('[data-fish-lookup-result]');
    if (status) { status.textContent = next.result.name ? ui`已找到：${next.result.name}` : t('已确认音色 ID。'); status.hidden = false; }
    return;
  }
  if (action === 'fish.audition') {
    const preset = snapshot.presets.find(item => item.id === id && item.provider === 'fish_audio');
    if (!preset) throw new Error(t('请重新选择 Fish Audio 音色。'));
    if (!snapshot.connections.some(connection => connection.id === preset.connection_id && connection.has_credential)) throw new Error(t('请先连接 Fish Audio 账号。'));
    if (snapshot.rules?.default_preset_id !== preset.id) await command('presets.default', { id: preset.id }, { quiet: true });
    await command('audition', { preset_id: preset.id, text: '你好，欢迎来到直播间。' }, { success: t('试听已加入播放队列') });
    return;
  }
  if (action === 'voice-audition.add') {
    const form = target.closest('[data-form="voice-audition"]');
    if (!form) throw new Error(t('请重新打开声音设置。'));
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
      showToast(t('先连接 Fish Audio 账号，验证后会设为首选'));
      return;
    }
    const preset = rememberedPreset(id);
    if (preset) { await command('presets.default', { id: preset.id }, { success: ui`${providerLabel(id)} 已设为首选` }); updateVoiceSettings(); updateServiceIndicators(); return; }
    const connection = serviceConnection(id);
    editor = connection ? { type: 'preset', id: '', connectionId: connection.id, makePreferred: true } : { type: 'service', provider: id, makePreferred: true };
    if (connection) await loadVoiceEditorData(connection.id);
    renderSettings();
    showToast(connection ? t('先添加音色，保存后会设为首选') : t('先连接服务，再添加首选音色'));
    return;
  }
  if (action === 'service.add_preset') {
    const connection = serviceConnection(id);
    if (!connection) throw new Error(t('请先设置这个语音服务。'));
    if (id === 'fish_audio' && !connection.has_credential) {
      editor = { type: 'service', provider: id, makePreferred: !!editor?.makePreferred || !snapshot.rules?.default_preset_id };
      renderSettings();
      showToast(t('请先连接 Fish Audio 账号'));
      return;
    }
    editor = { type: 'preset', id: '', connectionId: connection.id, makePreferred: !!editor?.makePreferred || !snapshot.rules?.default_preset_id };
    await loadVoiceEditorData(connection.id);
    renderSettings(); return;
  }
  if (action === 'models.refresh') {
    if (!await allowLeaveSettings()) return;
    const connectionId = settingsDialog.querySelector('[data-form="preset"]')?.elements.connection_id?.value;
    if (!connectionId) throw new Error(t('请先选择 GPT-SoVITS 服务。'));
    editor.modelIndex = undefined;
    await loadVoiceEditorData(connectionId);
    renderSettings(); return;
  }
  if (action === 'reference.pick_audio') {
    const pick = window.__TAURI__?.dialog?.open;
    if (!pick) throw new Error(t('文件选择器不可用，请重新打开应用。'));
    const path = await pick({ multiple: false, title: t('选择参考音频'), filters: [{ name: t('音频'), extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }] });
    if (typeof path === 'string') {
      const input = target.closest('form').elements.audio_path;
      setPickedPath(input, path);
    }
    return;
  }
  if (action === 'service.pick_directory') {
    const pick = window.__TAURI__?.dialog?.open;
    if (!pick) throw new Error(t('目录选择器不可用，请重新打开应用。'));
    const directory = await pick({ directory: true, multiple: false, title: t('选择 TTS 安装目录') });
    if (typeof directory === 'string') {
      const input = target.closest('form').elements.directory;
      setPickedPath(input, directory);
      await flushAutosaves();
    }
    return;
  }
  if (action === 'service.check') { await command('local_services.check', { provider: id, connection_id: serviceConnection(id)?.id }, { success: t('连接状态已更新') }); updateServiceIndicators(); return; }
  if (action === 'service.start' || action === 'service.stop') {
    const provider = id;
    const service = snapshot.local_services?.[provider];
    if (!['dots', 'gpt_sovits'].includes(provider)) throw new Error(t('本地服务类型无效。'));
    if (action === 'service.start') {
      const input = settingsDialog.querySelector('[data-form="service-local"] [name="directory"]');
      if (input?.value.trim() !== String(service?.directory || '')) throw new Error(t('目录尚未保存，请检查目录并重试。'));
    }
    await command(action === 'service.start' ? 'local_services.start' : 'local_services.stop', { provider, connection_id: serviceConnection(provider)?.id }, { success: action === 'service.start' ? t('正在启动本地服务') : t('本应用启动的服务已停止') });
    updateServiceIndicators(); return;
  }
  if (action === 'bili.begin' || action === 'doubao.begin') {
    await cancelQr(); editor = { type: 'qr', provider: action === 'bili.begin' ? 'bilibili' : 'doubao', id }; renderSettings(); return startQr(editor.provider, id || undefined);
  }
  if (action === 'editor.cancel') {
    if (aliasReturnContext && editor?.type === 'alias') return closeSettings();
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
        showToast(t('请先连接 Fish Audio 账号'));
        return;
      }
      if (connectionId) await loadVoiceEditorData(connectionId);
    }
    renderSettings(); return;
  }
  if (action === 'preset.choose_service') {
    const connection = snapshot.connections.find(item => item.id === id);
    if (!connection || editor?.type !== 'preset' || editor.id) throw new Error(t('请重新选择语音服务。'));
    if (connection.settings.provider === 'fish_audio' && !connection.has_credential) {
      editor = { type: 'service', provider: 'fish_audio', makePreferred: !!editor.makePreferred };
      renderSettings();
      showToast(t('请先连接 Fish Audio 账号'));
      return;
    }
    editor.connectionId = connection.id;
    await loadVoiceEditorData(connection.id);
    renderSettings(); return;
  }
  if (/^(preset|binding|asset)\.delete$/.test(action)) {
    const type = action.split('.')[0];
    const label = ({ preset: t('声音预设'), binding: t('用户声音绑定'), asset: t('音效素材') })[type];
    if (await confirmAction(ui`删除${label}？`, t('删除后无法撤销。仍被使用的连接、默认预设或规则素材需要先解除引用。'), t('删除'))) { await command(`${type === 'asset' ? 'assets' : `${type}s`}.delete`, { id, confirmed: true }); renderSettings(); }
    return;
  }
  if (action === 'preset.default' || action === 'preset.clear-default') { await command('presets.default', { id: action === 'preset.clear-default' ? null : id }); if (settingsTab === 'voices' && !editor) { updateVoiceSettings(); updateServiceIndicators(); } else renderSettings(); return; }
  if (action === 'asset.replace') { if (!await allowLeaveSettings()) return; editor = { type: 'asset', id }; renderSettings(); return; }
  if (action === 'dictionary.view') {
    dictionaryView = id === 'user_words' ? 'user_words' : 'message_words';
    for (const panel of settingsDialog.querySelectorAll('.s-dict')) panel.hidden = panel.dataset.view !== dictionaryView;
    for (const choice of settingsDialog.querySelectorAll('[data-action="dictionary.view"]')) { choice.classList.toggle('on', choice.dataset.id === dictionaryView); choice.setAttribute('aria-pressed', String(choice.dataset.id === dictionaryView)); }
    return;
  }
  if (action.startsWith('dictionary.add.')) { const type = action.split('.')[2]; const list = document.querySelector(`[data-dictionary="${type}"]`); list.insertAdjacentHTML('beforeend', dictionaryRow(type)); list.lastElementChild?.classList.add('enter'); mountSelects(list); scheduleAutosave(list.closest('form')); return; }
  if (action === 'dictionary.remove') { const form = target.closest('form'); target.closest('.dict-row').remove(); scheduleAutosave(form, true); return; }
  if (action === 'audio.test') {
    await command('audio.test', {}, { success: t('测试音已加入播放队列') });
    return;
  }
  if (action === 'devices.refresh') {
    const form = document.querySelector('[data-form="audio"]'); const selected = form.elements.output.value;
    await command(action); form.elements.output.innerHTML = option('', t('跟随系统默认设备'), selected) + snapshot.devices.map(device => option(device.name, `${device.name}${device.is_default ? t('（系统默认）') : ''}`, selected)).join(''); mountSelects(form); showToast(t('设备列表已刷新')); return;
  }
  if (action === 'audio.reconnect') {
    await command('preferences.save', { preferences: {}, reopen_output: true, confirmed: true }, { success: t('音频输出已重新连接') });
    renderSettings();
    return;
  }
  if (action === 'onboarding.reset') {
    if (!await confirmAction(t('重新打开初次设置？'), t('已有声音、规则和素材会保留。'), t('重新设置'), false)) return;
    await cancelQr(); await command(action); settingsDialog.close(); editor = null; setStep('welcome'); return;
  }
  if (action === 'migration.cancel') { await command(action); migrationPreview = null; renderSettings(); return; }
  if (action === 'data.clear') {
    if (!await confirmAction(t('清除全部应用数据？'), t('将删除本机保存的账号和语音服务凭据、声音预设、播报规则、界面设置、已导入的音效及应用备份。\n当前接收和播报会停止，随后回到首次设置。'), t('清除应用数据'))) return;
    stopQrPolling();
    await command('data.clear', { confirmed: true });
    unmountAutosaves(); formDrafts.clear(); tabEditors.clear();
    editor = null; migrationPreview = null; settingsTab = 'voices'; settingsDirty = false; setupTts = true;
    settingsDialog.close(); settingsDialog.replaceChildren();
    showToast(t('应用数据已清除')); setStep('welcome'); return;
  }
  if (action === 'reconnect') return boot();
}

function eventFromForm(data) {
  const uid = data.get('user_id');
  if (uid && !validUid(uid)) throw new Error(t('观众 UID 需要是有效的正整数。'));
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
  if (!form.checkValidity()) { form.reportValidity(); throw new Error(t('请填好音色名称、参考音频、语速和音量。')); }
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
  if (!connection || !voiceId || !name) throw new Error(t('请重新选择 dots.tts 服务并填写音色名称。'));
  if (!Number.isFinite(speed) || speed < .5 || speed > 2 || !Number.isFinite(volume) || volume < 0 || volume > 2) throw new Error(t('语速须在 0.5–2，音量须在 0–2 之间。'));
  if (!audioPath && (!id || currentReference({ kind: 'dots', role: voiceId }))) throw new Error(t('请重新选择参考音频原文件。'));
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
  if (!savedId) throw new Error(t('无法确认音色编号；请重新打开声音设置核对。'));
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
  if (!presetForm || !presetForm.checkValidity()) throw new Error(t('请先填写角色名称和声音预设。'));
  scheduleAutosave(presetForm, true);
  await autosaves.get(presetForm)?.queue.flush();
  const connection_id = presetForm.elements.connection_id.value;
  const provider = snapshot.connections.find(item => item.id === connection_id)?.settings.provider;
  const role = provider === 'dots'
    ? { kind: 'dots', role: presetForm.elements.voice_id.value.trim() }
    : provider === 'gpt_sovits'
      ? { kind: 'gpt_sovits', gpt_weights_path: presetForm.elements.gpt_weights_path.value.trim(), sovits_weights_path: presetForm.elements.sovits_weights_path.value.trim() }
      : null;
  if (!role || (role.kind === 'gpt_sovits' && (!role.gpt_weights_path || !role.sovits_weights_path))) throw new Error(t('请先选择成对的角色模型。'));
  const path = value('audio_path');
  if (!path) throw new Error(t('请先选择参考音频。'));
  if (provider === 'gpt_sovits' && !checked('text_free') && !value('reference_text')) throw new Error(t('请填写参考音频原文，或开启无参考文本模式。'));
  const profile = { connection_id, role, audio_path: path, reference_text: value('reference_text'), reference_language: provider === 'gpt_sovits' ? value('reference_language') : '', text_language: provider === 'gpt_sovits' ? value('text_language') : '', text_free: provider === 'gpt_sovits' && checked('text_free') };
  await command('references.save', { profile }, { quiet: true, silent: true });
  if (editor?.makePreferred) {
    const id = presetForm.dataset.id;
    if (!id) throw new Error(t('音色尚未创建成功，请重试。'));
    await command('presets.default', { id }, { quiet: true, silent: true });
    editor.makePreferred = false;
    const record = autosaves.get(presetForm);
    if (record?.editor) record.editor.makePreferred = false;
  }
  const listed = await command('references.list', { connection_id }, { quiet: true });
  referenceProfiles = Array.isArray(listed.result) ? listed.result : [];
  delete form.dataset.dirty;
  showToast(t('角色参考设置已保存'));
}

async function handleForm(form, submitter) {
  const type = form.dataset.form;
  if (type === 'broadcast-room') return saveBroadcastForm(form);
  const data = new FormData(form);
  const value = key => String(data.get(key) ?? '').trim();
  const number = key => Number(data.get(key));
  const checked = key => data.has(key);
  const id = form.dataset.id || '';
  if (type === 'language') { await changeLanguage(value('language')); return; }
  if (type === 'anonymous' || type === 'room-uid') {
    const uid = value('uid');
    if (!validUid(uid)) throw new Error(t('请输入有效的主播 UID。'));
    await cancelQr(); await command('onboarding.anonymous', { uid });
    if (type === 'anonymous') setStep('tts'); else { renderSettings(); showToast(t('直播间已保存')); }
    return;
  }
  if (type === 'voice-audition') {
    const preset = snapshot.presets.find(item => item.id === value('preset_id') && item.provider === form.dataset.provider);
    const text = value('text');
    if (!preset) throw new Error(t('请先选择这个服务的音色。'));
    if (!text) throw new Error(t('请输入试听文字。'));
    if (!await saveVoiceAuditionChoice(form)) return;
    await command('audition', { preset_id: preset.id, text }, { success: t('试听已加入播放队列') });
    return;
  }
  if (type === 'gift-merge') {
    const gift_merge = { enabled: checked('enabled'), initial_seconds: number('initial_seconds'), increment_seconds: number('increment_seconds'), maximum_seconds: number('maximum_seconds') };
    if (gift_merge.maximum_seconds < gift_merge.initial_seconds) throw new Error(t('最长等待不能小于初始等待。'));
    await command('live.save', { gift_merge }, { success: t('礼物合并设置已保存') });
  } else if (type === 'service-local') {
    const provider = form.dataset.provider;
    if (!['dots', 'gpt_sovits'].includes(provider)) throw new Error(t('本地服务类型无效。'));
    const directory = value('directory');
    const existing = serviceConnection(provider);
    const endpoint = existing?.settings?.endpoint || providerEndpoint[provider];
    await command('connections.save', { connection: { id: existing?.id || '', name: providerLabel(provider), settings: { provider, endpoint, timeout_secs: Math.min(existing?.settings?.timeout_secs ?? providerTimeout[provider], 30) }, has_credential: false } });
    await command('local_services.save', { provider, directory }, { success: t('本地服务设置已保存') });
    if (!snapshot.network_disabled) await command('local_services.check', { provider }, { quiet: true });
  } else if (type === 'service-fish') {
    await connectFishCredential(value('credential'), form);
  } else if (type === 'fish-settings') {
    const connectionId = form.dataset.connectionId;
    if (!snapshot.connections.some(connection => connection.id === connectionId && connection.settings.provider === 'fish_audio' && connection.has_credential)) throw new Error(t('请先连接 Fish Audio 账号。'));
    const settings = { model: value('model'), latency: value('latency'), volume_db: number('volume_db'), temperature: number('temperature'), top_p: number('top_p'), streaming: true };
    if (!Number.isFinite(settings.volume_db) || settings.volume_db < -20 || settings.volume_db > 20 || ![settings.temperature, settings.top_p].every(item => Number.isFinite(item) && item >= 0 && item <= 1)) throw new Error(t('合成音量须在 -20–20 dB，温度与 Top P 须在 0–1 之间。'));
    await command('fish.settings.save', { connection_id: connectionId, settings }, { success: t('Fish Audio 生成设置已保存') });
  } else if (type === 'fish-voice') {
    const connectionId = form.dataset.connectionId;
    if (!snapshot.connections.some(connection => connection.id === connectionId && connection.settings.provider === 'fish_audio' && connection.has_credential)) throw new Error(t('请先连接 Fish Audio 账号。'));
    const idOrUrl = value('id_or_url');
    if (!idOrUrl) throw new Error(t('请填写音色页面链接或 32 位音色 ID。'));
    let name = value('name');
    if (!name) {
      const found = await command('fish.voice.lookup', { connection_id: connectionId, id_or_url: idOrUrl }, { quiet: true });
      name = String(found.result?.name || '').slice(0, 100).trim();
      if (!name) throw new Error(t('未查到音色名称，请自行填写收藏名称。'));
    }
    const saved = await command('fish.voice.save', { connection_id: connectionId, id_or_url: idOrUrl, name }, { success: t('Fish 音色已收藏') });
    if (editor?.makePreferred) await command('presets.default', { id: saved.result.id });
    editor = null;
  } else if (type === 'fish-preset') {
    const existing = snapshot.presets.find(preset => preset.id === id && preset.provider === 'fish_audio' && preset.connection_id === form.dataset.connectionId);
    if (!existing) throw new Error(t('Fish 音色不存在，请重新打开设置。'));
    const preset = { ...existing, name: value('name'), speed: number('speed'), volume: number('volume') };
    if (!preset.name || !Number.isFinite(preset.speed) || preset.speed < .5 || preset.speed > 2 || !Number.isFinite(preset.volume) || preset.volume < 0 || preset.volume > 2) throw new Error(t('请填写名称；语速须在 0.5–2，音量须在 0–2 之间。'));
    await command('presets.save', { preset }, { success: t('Fish 音色已保存') });
    editor = null;
  } else if (type === 'preset') {
    const connection = snapshot.connections.find(item => item.id === value('connection_id'));
    if (!connection) throw new Error(t('请先选择有效的服务连接。'));
    const name = value('name') || defaultPresetName(connection.settings.provider, value('voice_id'), id);
    const preset = { id, name, connection_id: connection.id, provider: connection.settings.provider, voice_id: value('voice_id'), speed: number('speed'), volume: number('volume'), sovits: null };
    if (preset.provider === 'gpt_sovits') preset.sovits = { model_selection: value('model_selection'), gpt_weights_path: value('gpt_weights_path') || null, sovits_weights_path: value('sovits_weights_path') || null, reference_text: value('reference_text'), reference_text_free: checked('reference_text_free'), reference_language: value('reference_language'), text_language: value('text_language'), split: value('split'), top_k: number('top_k'), top_p: number('top_p'), temperature: number('temperature'), sample_steps: number('sample_steps'), super_sampling: checked('super_sampling'), fragment_interval_secs: number('fragment_interval_secs') };
    await command('presets.save', { preset }, { success: t('声音预设已保存') }); editor = null;
  } else if (type === 'dots-preset') {
    await saveDotsPresetForm(form);
    editor = null;
    renderSettings();
    showToast(t('音色已保存'));
    return;
  } else if (type === 'reference') {
    await saveReferenceForm(form);
    renderSettings();
    return;
  } else if (type === 'binding') {
    const envelope = collectAutosave(form);
    await command(envelope.action, envelope.payload, { success: t('观众声音已保存') }); editor = null;
  } else if (type === 'tts-toggle') {
    await command('preferences.save', { preferences: { tts_enabled: checked('tts_enabled') } }, { success: t('播报开关已保存') });
  } else if (type === 'alias') {
    const aliasEditor = editor;
    const from = value('from');
    const to = value('to');
    if (!from || !to) throw new Error(t('请填写播报别名。'));
    const rules = structuredClone(snapshot.rules);
    const index = rules.user_words.findIndex(row => row.from === from);
    if (index >= 0) rules.user_words[index] = { from, to };
    else rules.user_words.push({ from, to });
    await command('rules.save', { rules }, { success: t('播报别名已保存') });
    // A late save must not close a newly opened editor or change its page.
    if (editor === aliasEditor && settingsDialog.open) {
      delete form.dataset.dirty;
      if (aliasReturnContext) restoreAliasNavigation();
      else { editor = null; tabEditors.delete(settingsTab); settingsDirty = false; renderSettings(); }
    }
    return;
  } else if (type === 'rules') {
    const rules = structuredClone(snapshot.rules);
    for (const key of ['danmaku_on', 'filter_bilibili_emoticons', 'gift_on', 'free_gift_on', 'super_chat_on', 'guard_on']) rules.events[key] = checked(key);
    for (const key of ['gift_threshold_yuan', 'super_chat_threshold_yuan']) rules.events[key] = number(key);
    for (const key of ['danmaku', 'gift', 'super_chat', 'guard']) rules.templates[key] = value(`template_${key}`);
    for (const type of ['user_words', 'message_words']) rules[type] = [...form.querySelectorAll(`[data-dictionary="${type}"] .dict-row`)].map(row => ({ from: row.querySelector('[data-key="from"]').value, to: row.querySelector('[data-key="to"]').value }));
    await command('rules.save', { rules }, { success: t('播报规则已保存') });
  } else if (type === 'sound-words') {
    const rules = structuredClone(snapshot.rules);
    rules.sounds = [...form.querySelectorAll('[data-dictionary="sounds"] .dict-row')].map(row => ({ trigger: row.querySelector('[data-key="from"]').value, asset_id: row.querySelector('[data-key="to"]').value }));
    await command('rules.save', { rules }, { success: t('关键词音效已保存') });
  } else if (type === 'preview') {
    const event = eventFromForm(data);
    const next = await command('rules.preview', { event });
    const preview = next.result;
    const node = document.querySelector('#preview-result');
    node.innerHTML = `<div class="notice">${preview.filtered_reason ? ui`已过滤：${esc(preview.filtered_reason)}` : ui`${esc(preview.final_text || t('没有可播报的文字'))}<br>声音：${esc(preview.voice?.name || t('未指定默认声音'))}${preview.pending_legacy_binding ? t('<br>同名旧绑定待确认 UID，尚未应用。') : ''}`}</div><pre class="code-output">${esc(JSON.stringify(preview.parts, null, 2))}</pre>`;
    return;
  } else if (type === 'asset') {
    if (id && !await confirmAction(t('替换这份音效？'), t('今后的播报使用新音频；已经排队的消息仍可能使用旧文件。'), t('替换'))) return;
    await command(id ? 'assets.replace' : 'assets.import', id ? { id, path: value('path'), confirmed: true } : { path: value('path'), name: value('name') }, { success: id ? t('素材已替换') : t('素材已导入') }); editor = null;
  } else if (type === 'audio') {
    const output = value('output') ? { named: value('output') } : 'default';
    const needsConfirm = JSON.stringify(output) !== JSON.stringify(snapshot.preferences.output);
    if (needsConfirm && !await confirmAction(t('应用新的音频输出？'), t('当前播放和待播队列会停止。'), t('应用并停止播放'), false)) return;
    await command('preferences.save', { preferences: { output }, confirmed: needsConfirm }, { success: t('音频设置已保存') });
  } else if (type === 'appearance') {
    await command('preferences.save', { preferences: { appearance: value('appearance'), scale: number('scale') } }, { success: t('外观已保存') });
  } else if (type === 'startup') {
    await command('startup.set', { enabled: checked('enabled') }, { success: t('启动选项已保存') });
  } else if (type === 'export') {
    const next = await command('configuration.export', { path: value('path') }, { success: t('配置已导出，不含登录凭据') }); renderResult('#operation-result', next.result || t('导出完成')); settingsDirty = false; return;
  } else if (type === 'migration-preview') {
    const next = await command('migration.preview', { path: value('path') }); migrationPreview = next.result; settingsDirty = false; document.querySelector('#migration-preview').innerHTML = renderMigrationPreview(); return;
  } else if (type === 'migration-apply') {
    const options = { selected_sound_ids: data.getAll('selected_sound_ids') };
    for (const key of ['import_rules', 'import_live_settings', 'import_connections', 'import_pending_bindings', 'replace_existing_rules', 'replace_existing_live_settings']) options[key] = checked(key);
    if (!options.import_rules && options.selected_sound_ids.length) throw new Error(t('导入音效时，请同时勾选播报规则和词典。'));
    if (!options.import_rules && !options.import_live_settings && !options.import_connections && !options.import_pending_bindings) throw new Error(t('请至少选择一项要导入的内容。'));
    const selected = [['import_rules', t('播报规则和词典')], ['import_live_settings', t('直播间设置')], ['import_connections', t('服务连接与声音预设')], ['import_pending_bindings', t('待确认 UID 的绑定')]].filter(([key]) => options[key]).map(([, label]) => label);
    if (!await confirmAction(t('确认导入这些内容？'), ui`${selected.join(t('、'))}，以及 ${options.selected_sound_ids.length} 个音效文件。\n${options.replace_existing_rules || options.replace_existing_live_settings ? t('已选择允许覆盖当前对应设置。\n') : ''}会先备份当前数据库，不导入登录凭据。`, t('备份并导入'), false)) return;
    const next = await command('migration.apply', { confirmed: true, options }); migrationPreview = null; renderSettings(); renderResult('#operation-result', next.result); showToast(t('导入完成，请查看结果')); return;
  }
  settingsDirty = false;
  renderSettings();
}

document.addEventListener('click', async event => {
  const ttsMenu = document.querySelector('#tts-menu');
  if (ttsMenu && !ttsMenu.hidden && !ttsMenu.contains(event.target) && !event.target.closest('[data-action="tts.open"]')) closeVoicePanel();
  const queuePanel = document.querySelector('#queue-panel');
  if (queuePanel && !queuePanel.hidden && !queuePanel.contains(event.target) && !event.target.closest('[data-action="queue.toggle"]')) {
    closeQueuePanel();
  }
  const onAirPanel = document.querySelector('#onair-panel');
  if (onAirPanel && !onAirPanel.hidden && !onAirPanel.contains(event.target) && !event.target.closest('.select-menu, #onair, #confirmation')) {
    if (!onAirPanel.querySelector('form[data-dirty]')) closeOnAirPanel();
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

document.addEventListener('compositionstart', event => {
  if (event.target.id === 'viewer-alias') composingInputs.add(event.target);
});
document.addEventListener('compositionend', event => {
  if (event.target.id === 'viewer-alias') { composingInputs.delete(event.target); scheduleViewerAlias(event.target.value); }
});

document.addEventListener('input', event => {
  const broadcastForm = event.target.closest?.('form[data-form="broadcast-room"]');
  if (broadcastForm) {
    broadcastForm.dataset.dirty = 'true';
    if (event.target.name === 'title') {
      const count = broadcastForm.querySelector('[data-title-count]');
      const length = Array.from(event.target.value.trim()).length;
      if (count) { count.textContent = `${length}/40`; count.classList.toggle('over', length > 40 || !length); }
    }
    return;
  }
  if (event.target.id === 'viewer-alias') { if (!event.isComposing && !composingInputs.has(event.target)) scheduleViewerAlias(event.target.value); return; }
  if (event.target.id !== 'main-volume-range') return;
  volumeDraft = Number(event.target.value);
  updateVolumeControls();
});

document.addEventListener('change', event => {
  if (event.target.name === 'parent_area_id' && event.target.closest('form[data-form="broadcast-room"]')) {
    const form = event.target.closest('form');
    const parent = snapshot.broadcast?.areas?.find(item => String(item.id) === event.target.value);
    form.elements.area_id.innerHTML = (parent?.children || []).map(child => option(child.id, child.name, '')).join('');
    form.dataset.dirty = 'true';
    mountSelects(form); return;
  }
  if (event.target.closest?.('form[data-form="broadcast-room"]')) { event.target.closest('form').dataset.dirty = 'true'; return; }
  if (event.target.id !== 'main-volume-range') return;
  volumeDraft = Number(event.target.value);
  volumeSave.schedule(volumeDraft, { immediate: true });
});

// Pointer clicks on chat lines must not focus-scroll the feed; keyboard focus still works.
document.addEventListener('mousedown', event => {
  if (event.target.closest?.('.chat-hit')) event.preventDefault();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || settingsDialog.open || confirmationDialog.open) return;
  if (viewerContext) { event.preventDefault(); void closeViewerDrawer().catch(showError); return; }
  const ttsMenu = document.querySelector('#tts-menu');
  if (ttsMenu && !ttsMenu.hidden) { closeVoicePanel(); document.querySelector('#tts-switch')?.focus(); return; }
  const queuePanel = document.querySelector('#queue-panel');
  if (queuePanel && !queuePanel.hidden) { closeQueuePanel(true); return; }
  if (!document.querySelector('#onair-panel')?.hidden) void handleAction('onair.close').catch(showError);
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
  if (form?.dataset.form === 'overlay') updateOverlayPreview();
  if (event.target.dataset?.template) {
    const preview = event.target.parentElement?.querySelector('[data-template-preview]');
    if (preview) preview.textContent = templatePreview(event.target.dataset.template, event.target.value);
  }
  settingsDirty = true;
  if (form?.dataset.form === 'reference') form.dataset.dirty = 'true';
  if (form?.dataset.form === 'dots-preset') { form.dataset.dirty = 'true'; rememberDotsDraft(form); }
  if (form && manualSaveFormTypes.has(form.dataset.form)) form.dataset.dirty = 'true';
  if (form && autoFormTypes.has(form.dataset.form)) scheduleAutosave(form, false, event.target.name === 'uid', event.isComposing || composingInputs.has(event.target));
});
settingsDialog.addEventListener('change', async event => {
  if (event.target.closest('[data-form="broadcast-room"]')) return;
  if (event.target.matches?.('[data-broadcast-enable]')) {
    const toggle = event.target;
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      broadcastRefreshAccount = ''; broadcastRefreshError = '';
      await command('preferences.save', { preferences: { broadcast_console: enabled } }, { quiet: true });
      showToast(t(enabled ? '已启用开播台，主界面右上角可以开播和下播' : '已关闭开播台'));
    } catch (error) { showError(error); }
    finally { toggle.disabled = false; toggle.checked = broadcastEnabled(); updateBroadcastSettings(); }
    return;
  }
  if (event.target.name === 'language') {
    const selected = event.target.value;
    const radios = event.target.type === 'radio' ? [...event.target.closest('form').querySelectorAll('input[name="language"]')] : [event.target];
    for (const input of radios) input.disabled = true;
    try { await changeLanguage(selected); }
    catch (error) { showError(error); }
    finally {
      // Show the saved language again; a failed save must not leave the new choice selected.
      const saved = snapshot.preferences?.language || 'zh-CN';
      for (const input of radios.filter(item => item.isConnected)) {
        if (input.type === 'radio') input.checked = input.value === saved;
        else { input.value = saved; mountSelects(input.closest('form')); }
        input.disabled = false;
      }
    }
    return;
  }
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
      showToast(t('请先保存参考设置，再切换模型。'), true);
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
        showToast(t('更换语音服务请新建音色。'), true);
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
window.addEventListener('pagehide', () => { disposed = true; clearFoldingRows(); stopQrPolling(); closeSelect(); clearTimeout(snapshotTimer); clearTimeout(fallbackStatusTimer); });
function refreshVisibility() {
  const active = uiIsActive(nativeActive, windowFocused, document.hidden);
  if (active === effectiveActive) return;
  effectiveActive = active;
  const inactive = String(!active);
  if (document.documentElement.dataset.inactive !== inactive) document.documentElement.dataset.inactive = inactive;
  if (boot.polling) scheduleSnapshotPolling(active);
  if (!active) {
    clearTimeout(qrTimer);
    if (foldingRows.size) {
      clearFoldingRows();
      feedSignature = 'motion-paused';
      renderFeed([...feedEvents.values()], [...feedEvents.keys()]);
    }
  }
  else if (qrProvider && !qrBusy && !qrFailure && ['waiting', 'scanned'].includes(snapshot?.qr?.status)) scheduleQrPoll(qrProvider, qrGeneration);
}
window.addEventListener('focus', () => { windowFocused = true; refreshVisibility(); });
window.addEventListener('blur', () => { windowFocused = false; refreshVisibility(); });
document.addEventListener('visibilitychange', refreshVisibility);
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
  if (!event.matches || !foldingRows.size) return;
  clearFoldingRows();
  feedSignature = 'motion-reduced';
  renderFeed([...feedEvents.values()], [...feedEvents.keys()]);
});

function scheduleSnapshotPolling(immediate = false) {
  clearTimeout(snapshotTimer);
  if (disposed || !uiIsActive(nativeActive, windowFocused, document.hidden)) return;
  const policy = snapshotPollingPolicy(snapshot, { step, hidden: document.hidden, focused: nativeActive ?? windowFocused, busy: pendingCommands > 0, settingsOpen: settingsDialog.open && settingsTab === 'voices' });
  if (!policy.poll && !pendingCommands) return;
  snapshotTimer = setTimeout(pollSnapshot, immediate ? 0 : policy.delay);
}

async function pollSnapshot() {
  if (disposed) return;
  const policy = snapshotPollingPolicy(snapshot, { step, hidden: document.hidden, focused: nativeActive ?? windowFocused, busy: pendingCommands > 0, settingsOpen: settingsDialog.open && settingsTab === 'voices' });
  if (policy.poll) {
    try { acceptSnapshot(await invoke('snapshot', { configRevision: snapshot?.config_revision })); }
    catch (error) { try { acceptSnapshot(await invoke('snapshot')); } catch { showError(error); } }
  }
  void refreshLocalServices();
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
        catch (error) { showToast(ui`退出前停止播报失败：${error?.message || error}`, true); }
      });
    }
    acceptSnapshot(await invoke('snapshot'));
    if (step === 'login') await startQr('bilibili');
    if (!boot.polling) { boot.polling = true; scheduleSnapshotPolling(); }
  } catch (error) {
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = ui`<main class="disconnected">${mark}<h1>桌面连接不可用</h1><p>请重新打开超绝可爱弹幕姬，或点击重试。</p><p class="quiet-note">${esc(errorMessage(error, 'DV-UI02'))}</p>${button(t('重试连接'), 'reconnect', { class: 'small' })}</main>`;
  }
}

void boot();
