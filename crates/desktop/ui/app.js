import { t, ui, getLanguage, setLanguage } from './i18n.mjs';
import { localizeDiagnostic } from './i18n-diagnostics.mjs';
import { errorMessage, escapeHtml as esc, mergeSnapshot, headerIdentity, initial, identityColor, eventText, eventKeys, validUid, numericId, playbackIssue, runtimeIssue, liveConnectionView, snapshotPollingPolicy, createSnapshotSequencer, truncateUtf16, uiIsActive, safeQrUrl, safeMediaUrl, messageParts, soloEmote, playbackCaption, playbackFallbackNotice, startingStep, providerLabel, deviceValue, normalizedEvents, qrLabel, qrNeedsRoomFallback, audienceUsers, audienceDisplayCount, broadcastSessionSummary, createLakePresentationLedger } from './helpers.mjs';
import { createAutosaveQueue } from './autosave.mjs';
import { mountSelects, closeSelect, stripSelects } from './select.mjs';
import { lakeSceneMarkup } from './lake-scene.mjs';

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
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
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
const autoFormTypes = new Set(['gift-merge', 'tts-toggle', 'rules', 'sound-words', 'audio', 'appearance', 'startup', 'service-local', 'fish-settings', 'overlay', 'obs', 'obs-link']);
const manualSaveFormTypes = new Set(['service-fish']);
const autosaves = new Map();
const formDrafts = new Map();
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
let snapshot = null;
let updateInfo = null;
let updateBusy = false;
let updateError = "";
let step = null;
let replaySetup = window.__DANMAKUVOICE_STARTUP_THEME__?.setup === true;
let setupTts = true;
let settingsTab = 'voices';
let settingsDirty = false;
let editor = null;
let disposed = false;
let pendingCommands = 0;
let qrGeneration = 0;
let qrProvider = null;
let qrTimer = null;
let qrFailure = '';
let qrBusy = false;
let errorText = '';
let toastTimer;
let toastUndo = null;
let feedSignature = '';
let lakeTranscriptSignature = '';
let lakeClockTimer = null;
let lakeEnded = false;
let lakePreviousBroadcastLive = false;
let lakeSessionSummary = null;
let lakeSessionAccount = '';
const lakeMessageNodes = new Map();
const lakeMessageContents = new WeakMap();
const lakePresentationIdentities = new WeakMap();
let lakePresentationLedger = null;
let lakePresentationContext = '';
let lakePresentationFrame = 0;
let lakeLetterFlip = false;
const feedEvents = new Map();
let viewerContext = null;
let viewerModerationBusy = false;
let viewerModerationAccount = '';
let audienceQuery = '';
let audienceMoreAt = 0;
let audienceCloseTimer = null;
let audienceFinishTimer = null;
let audiencePinned = false;
let audienceSignature = '';
let audienceReturn = false;
const audienceEntries = new Map();
let volumeDraft = null;
const voiceAuditionDraft = { provider: '', presetId: '', text: '你好，欢迎来到直播间。', customText: false };
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
let chatSendBusy = false;
let chatMessageDraft = '';
let chatEmoticonsOpen = false;
let chatMetadataContext = '';
let chatEmoteContext = '';
let chatMetadataLoadedContext = '';
let chatEmotePackIndex = 0;
let chatEmotePackKey = '';
let chatEmotePackTokens = [];
let chatContextRevision = 0;
let chatRequestSequence = 0;
let chatEmoticonError = '';

function syncChatEmoticonContext() {
  const context = `${snapshot.account?.user_id || ''}:${snapshot.setup?.room_id || ''}`;
  if (context === chatEmoteContext) return;
  chatEmoteContext = context;
  chatMetadataContext = '';
  chatMetadataLoadedContext = '';
  chatEmotePackIndex = 0;
  chatEmotePackKey = '';
  chatEmotePackTokens = [];
  chatEmoticonError = '';
  chatEmoticonsOpen = false;
  chatSendBusy = false;
  ++chatContextRevision;
  ++chatRequestSequence;
  const picker = document.querySelector('#chat-emoticon-picker');
  if (picker) { picker.hidden = true; patchMarkup(picker, ''); }
}

function chatEmoticonView() {
  const view = snapshot.chat_send || {};
  const owned = String(view.account_id || '') === String(snapshot.account?.user_id || '') && !!snapshot.account?.user_id;
  return owned && chatMetadataLoadedContext === chatEmoteContext ? view : {
    ...view, emoticons: [], warnings: [], message_limit: 20, busy: owned && view.busy, error: owned ? view.error || chatEmoticonError : chatEmoticonError || null,
  };
}

function chatEmoticonPackKey(pack) {
  // The official component exposes name/type/cover, but does not expose a
  // verified package ID. Cover updates must not reset the selected package.
  return JSON.stringify([String(pack?.source || 'live'), pack?.pkg_type ?? null, String(pack?.name || '')]);
}

function chatEmoticonWarnings(view) {
  return [...new Set((Array.isArray(view.warnings) ? view.warnings : []).filter(warning => typeof warning === 'string' && warning.trim()).map(warning => localizeDiagnostic(warning)))];
}

function chatEmoticonPackTokens(pack) {
  return (Array.isArray(pack?.emoticons) ? pack.emoticons : []).map(item => String(item.kind === 'text' ? item.text || item.emoji || '' : item.emoticon_unique || ''));
}

function chatEmoticonImageFallback() {
  return '<svg class="lake-emote-fallback" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"></rect><circle cx="8" cy="8" r="1.5"></circle><path d="m4 17 5-5 3 3 3-4 5 6"></path></svg>';
}

function renderChatEmoticons(picker, view, disabled) {
  const previousPackKey = chatEmotePackKey;
  const previousScrollTop = picker.querySelector?.('#chat-emote-page')?.scrollTop || 0;
  const packs = Array.isArray(view.emoticons) ? view.emoticons : [];
  if (chatEmotePackKey) {
    const previousTokens = new Set(chatEmotePackTokens);
    const matching = packs.map((pack, index) => ({ index, key: chatEmoticonPackKey(pack), overlap: chatEmoticonPackTokens(pack).filter(token => previousTokens.has(token)).length })).filter(pack => pack.key === chatEmotePackKey);
    if (matching.length) chatEmotePackIndex = matching.reduce((best, candidate) => candidate.overlap > best.overlap ? candidate : best).index;
  }
  chatEmotePackIndex = Math.max(0, Math.min(chatEmotePackIndex, packs.length - 1));
  const pack = packs[chatEmotePackIndex];
  chatEmotePackKey = pack ? chatEmoticonPackKey(pack) : '';
  chatEmotePackTokens = chatEmoticonPackTokens(pack);
  const items = Array.isArray(pack?.emoticons) ? pack.emoticons : [];
  const tabs = packs.map((item, index) => {
    const cover = safeMediaUrl(item.icon) || (Array.isArray(item.emoticons) ? item.emoticons.map(emote => safeMediaUrl(emote.url)).find(Boolean) : '');
    return `<button type="button" role="tab" id="chat-emote-tab-${index}" data-action="chat.emoticon.pack" data-id="${index}" aria-label="${esc(item.name)}" aria-selected="${index === chatEmotePackIndex}" aria-controls="chat-emote-page" tabindex="${index === chatEmotePackIndex ? 0 : -1}">${cover ? `<img class="lake-emote-pack-icon" src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : chatEmoticonImageFallback()}</button>`;
  }).join('');
  const emoteButtonMarkup = item => {
    const url = safeMediaUrl(item.url);
    return `<button type="button" class="lake-emote-sticker" data-action="chat.emoticon.send" data-id="${esc(item.emoticon_unique)}" aria-label="${esc(item.emoji)}"${!item.allowed ? ` aria-description="${esc(item.description || t('当前账号不可发送'))}"` : ''}${disabled || !item.allowed || !item.emoticon_unique ? ' disabled' : ''}>${url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : chatEmoticonImageFallback()}</button>`;
  };
  const emptyLabel = chatSendBusy || view.busy ? t('正在读取表情包…') : view.error ? localizeDiagnostic(view.error) : t('暂无可发送的表情包');
  const content = items.length ? `<div class="lake-emote-stickers">${items.map(emoteButtonMarkup).join('')}</div>` : `<div class="lake-emote-empty" role="status">${chatSendBusy || view.busy ? '<span class="spinner" aria-hidden="true"></span>' : chatEmoticonImageFallback()}<span class="sr-only">${esc(emptyLabel)}</span></div>`;
  const warnings = chatEmoticonWarnings(view);
  const warning = warnings.length ? `<div class="lake-emote-warning" role="status"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7v6m0 3h.01"></path></svg><span class="sr-only">${warnings.map(esc).join(' · ')}</span></div>` : '';
  patchMarkup(picker, `${packs.length ? `<div class="lake-emote-tabs" role="tablist" aria-label="${esc(t('表情包'))}">${tabs}</div>` : ''}${warning}<div id="chat-emote-page" role="tabpanel"${pack ? ` aria-labelledby="chat-emote-tab-${chatEmotePackIndex}"` : ''} data-pack-index="${chatEmotePackIndex}" data-item-count="${items.length}" data-room-id="${esc(view.room_id || '')}">${content}</div>`);
  const scrollBody = picker.querySelector?.('#chat-emote-page');
  if (scrollBody && previousPackKey === chatEmotePackKey) scrollBody.scrollTop = previousScrollTop;
}

function updateChatCompose() {
  const host = document.querySelector('#chat-compose');
  if (!host) return;
  syncChatEmoticonContext();
  const enabled = step === 'main';
  host.hidden = !enabled;
  document.querySelector('#live-shell')?.classList.toggle('chat-compose-mode', enabled);
  if (!enabled) { chatEmoticonsOpen = false; chatMetadataContext = ''; return; }
  if (!host.querySelector('form')) {
    host.innerHTML = `<div class="chat-compose-note" role="status" hidden></div><form data-form="chat-send" class="lake-compose-line"><label class="sr-only" for="chat-message">${esc(t('发送弹幕'))}</label><input id="chat-message" name="message" autocomplete="off" placeholder="${esc(t('说点什么…'))}"><span class="lake-compose-count" hidden></span><button type="button" data-action="chat.emoticons" aria-label="${esc(t('表情包'))}" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M8.6 14.2c.9 1.2 2.1 1.9 3.4 1.9s2.5-.7 3.4-1.9"></path><path d="M9.2 9.8h.01M14.8 9.8h.01" style="stroke-width:2.6"></path></svg></button><button type="submit" aria-label="${esc(t('发送'))}">${icon('arrowRight')}</button></form>`;
    host.querySelector('#chat-message').value = chatMessageDraft;
    host.querySelector('#chat-message').addEventListener('input', inputEvent => {
      const count = host.querySelector('.lake-compose-count');
      count.hidden = !inputEvent.target.value;
      count.textContent = `${inputEvent.target.value.length}/${inputEvent.target.maxLength}`;
      updateChatCompose();
    });
  }
  const view = chatEmoticonView();
  const warnings = chatEmoticonWarnings(view);
  const disabled = !snapshot.account?.user_id || snapshot.network_disabled || chatSendBusy || view.busy;
  for (const control of host.querySelectorAll('form input, form button')) control.disabled = !!disabled;
  const input = host.querySelector('#chat-message');
  input.maxLength = view.message_limit || 20;
  const diagnostic = [view.error ? localizeDiagnostic(view.error) : '', ...warnings].filter(Boolean).join('\n');
  const note = !snapshot.account?.user_id ? t('请先扫码登录 B站账号') : snapshot.network_disabled ? t('离线测试窗口不可发送弹幕') : diagnostic;
  input.title = note;
  const noteHost = host.querySelector('.chat-compose-note');
  noteHost.textContent = diagnostic;
  noteHost.hidden = !diagnostic;
  host.classList.toggle('has-note', !!diagnostic);
  const count = host.querySelector('.lake-compose-count');
  count.hidden = !input.value;
  // maxlength and the platform limit both count UTF-16 units; so does the counter.
  count.textContent = `${input.value.length}/${input.maxLength}`;
  const emoteButton = host.querySelector('[data-action="chat.emoticons"]');
  emoteButton.setAttribute('aria-expanded', String(chatEmoticonsOpen));
  emoteButton.classList.toggle('on', chatEmoticonsOpen);
  const submit = host.querySelector('button[type="submit"]');
  submit.disabled = !!disabled || !input.value.trim();
  const sending = chatSendBusy || view.busy;
  if (submit.dataset.sending !== String(!!sending)) {
    submit.dataset.sending = String(!!sending);
    submit.innerHTML = sending ? '<span class="spinner" aria-hidden="true"></span>' : icon('arrowRight');
  }
  host.querySelector('form').classList.toggle('sending', !!sending);
  const picker = document.querySelector('#chat-emoticon-picker');
  if (!picker) return;
  picker.hidden = !chatEmoticonsOpen;
  // Load this account/room's actual text limit once; failed reads are retried
  // only by explicitly opening the picker. Switching windows keeps the draft.
  const context = chatEmoteContext;
  if (!disabled && !document.hidden && chatMetadataContext !== context) {
    chatMetadataContext = context;
    if (chatMetadataLoadedContext !== context) { void refreshChatEmoticons(true).catch(() => {}); return; }
  }
  if (!chatEmoticonsOpen) return;
  renderChatEmoticons(picker, view, disabled);
}

// Busy requests disable the composer, which drops keyboard focus. Return it to
// the same control (or the field) unless the person has moved focus elsewhere.
function composerFocus() {
  const active = document.activeElement;
  return active && document.querySelector('#chat-compose form')?.contains(active) ? active : null;
}

function restoreComposerFocus(previous) {
  const active = document.activeElement;
  if (!previous || (active && active !== document.body && active !== previous)) return;
  const target = previous.isConnected && !previous.disabled ? previous : document.querySelector('#chat-message');
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

async function refreshChatEmoticons(automatic = false) {
  syncChatEmoticonContext();
  if (chatSendBusy || !snapshot.account?.user_id || snapshot.network_disabled) return;
  const context = chatEmoteContext;
  const sequence = ++chatRequestSequence;
  const focused = composerFocus();
  chatSendBusy = true;
  updateChatCompose();
  try {
    const next = await command('bili.chat.emoticons.refresh', {}, { quiet: true, silent: automatic, accept: chatResponseGuard() });
    if (next && sequence === chatRequestSequence && context === chatEmoteContext && String(next.chat_send?.account_id || '') === String(snapshot.account?.user_id || '') && next.chat_send?.room_id) { chatMetadataLoadedContext = context; chatEmoticonError = ''; }
  } catch (error) {
    if (sequence === chatRequestSequence && context === chatEmoteContext) chatEmoticonError = errorMessage(error);
    throw error;
  }
  finally { if (sequence === chatRequestSequence) chatSendBusy = false; updateChatCompose(); restoreComposerFocus(focused); }
}

async function sendChatMessage(emoticon_unique = '') {
  syncChatEmoticonContext();
  if (chatSendBusy || !snapshot.account?.user_id || snapshot.network_disabled) return;
  if (composingInputs.has(document.querySelector('#chat-message'))) return;
  const message = chatMessageDraft.trim();
  if (!emoticon_unique && !message) throw new Error(t('请输入弹幕内容'));
  const account = String(snapshot.account.user_id);
  const room = String(snapshot.setup?.room_id || '');
  const submittedDraft = chatMessageDraft;
  const sequence = ++chatRequestSequence;
  const focused = composerFocus();
  if (emoticon_unique) chatEmoticonsOpen = false;
  chatSendBusy = true;
  updateChatCompose();
  try {
    const next = await command(emoticon_unique ? 'bili.chat.emoticon.send' : 'bili.chat.send', emoticon_unique ? { emoticon_unique, confirmed: true } : { message, confirmed: true }, { quiet: true, accept: chatResponseGuard() });
    if (!next) return;
    if (!emoticon_unique && String(snapshot.account?.user_id) === account && String(snapshot.setup?.room_id || '') === room && chatMessageDraft === submittedDraft) {
      chatMessageDraft = '';
      const input = document.querySelector('#chat-message');
      if (input) input.value = '';
    }
    if (String(snapshot.account?.user_id) === account && String(snapshot.setup?.room_id || '') === room) showToast(t('已发送'));
  } finally { if (sequence === chatRequestSequence) chatSendBusy = false; updateChatCompose(); restoreComposerFocus(focused); }
}

function chatResponseGuard() {
  const account = String(snapshot.account?.user_id || '');
  const room = String(snapshot.setup?.room_id || '');
  const revision = chatContextRevision;
  return next => revision === chatContextRevision && !snapshot.network_disabled && !next.network_disabled
    && String(snapshot.account?.user_id || '') === account && String(next.account?.user_id || '') === account
    && String(snapshot.setup?.room_id || '') === room && String(next.setup?.room_id || '') === room;
}

function selectChatEmoticonPack(index, focus = false) {
  const packs = chatEmoticonView().emoticons || [];
  if (!Number.isSafeInteger(index) || index < 0 || index >= packs.length) return;
  chatEmotePackIndex = index;
  chatEmotePackKey = chatEmoticonPackKey(packs[index]);
  chatEmotePackTokens = chatEmoticonPackTokens(packs[index]);
  updateChatCompose();
  document.querySelector('#chat-emote-page')?.scrollTo({ top: 0 });
  const tab = document.querySelector(`#chat-emote-tab-${index}`);
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focus) tab?.focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  const tab = event.target.closest?.('.lake-emote-tabs [role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const count = chatEmoticonView().emoticons?.length || 0;
  if (!count) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (Number(tab.dataset.id) + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
  selectChatEmoticonPack(index, true);
});

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

// Lake surfaces are styled by id, so a ghost copy would lose its look. They play
// their own .leaving animation and hide afterwards; reopening cancels the exit.
const leaveTimers = new WeakMap();
function leaveThenHide(node, ms, done) {
  if (!node || node.hidden) { done?.(); return; }
  if (leaveTimers.has(node)) return;
  if (!motionAllowed()) { node.hidden = true; done?.(); return; }
  node.classList.add('leaving');
  leaveTimers.set(node, setTimeout(() => { leaveTimers.delete(node); node.classList.remove('leaving'); node.hidden = true; done?.(); }, ms));
}
function cancelLeave(node) {
  if (!node || !leaveTimers.has(node)) return;
  clearTimeout(leaveTimers.get(node)); leaveTimers.delete(node); node.classList.remove('leaving');
}
const isLeaving = node => !!node && leaveTimers.has(node);

// The new theme spreads as a circle from the button that was pressed. Resolves
// once the old frame is captured, so a save that re-applies the stored
// appearance cannot switch the theme underneath the transition.
function revealTheme(next, origin) {
  const root = document.documentElement;
  if (typeof document.startViewTransition !== 'function' || !motionAllowed()) { root.dataset.theme = next; return Promise.resolve(); }
  const rect = origin?.getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 80;
  const y = rect ? rect.top + rect.height / 2 : 20;
  root.style.setProperty('--reveal-x', `${x}px`);
  root.style.setProperty('--reveal-y', `${y}px`);
  root.style.setProperty('--reveal-r', '160vmax');
  // From the sun / moon, the old body sets while the new one rises. It is named
  // only for this transition so it never paints over a dialog later.
  const orb = origin?.id === 'lake-orb' ? origin : null;
  if (orb) orb.style.viewTransitionName = 'lake-orb';
  let applied = false;
  try {
    const transition = document.startViewTransition(() => {
      applied = true;
      root.dataset.theme = next;
      return new Promise(resolve => setTimeout(resolve, 50));
    });
    const release = () => { if (orb) orb.style.viewTransitionName = ''; };
    transition.finished.then(release, release);
    setTimeout(() => { if (!applied) root.dataset.theme = next; }, 300);
    return Promise.race([transition.updateCallbackDone, new Promise(resolve => setTimeout(resolve, 300))]).catch(() => {});
  } catch { root.dataset.theme = next; if (orb) orb.style.viewTransitionName = ''; return Promise.resolve(); }
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
// Unsaved viewer aliases by user name. Every write carries all of them, so a
// failed alias stays recoverable after another viewer's alias is edited.
const viewerAliasDrafts = new Map();
const viewerAliasSave = createAutosaveQueue({
  delay: 600,
  save: drafts => {
    const rules = structuredClone(snapshot.rules);
    for (const [name, to] of drafts) {
      rules.user_words = (rules.user_words || []).filter(row => row.from !== name);
      if (to && to !== name) rules.user_words.push({ from: name, to });
    }
    return command('rules.save', { rules }, { quiet: true, silent: true });
  },
  onSaved: (_, drafts) => { for (const [name, to] of drafts) if (viewerAliasDrafts.get(name) === to) viewerAliasDrafts.delete(name); },
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
const snapshotSequence = createSnapshotSequencer();
let windowFocused = document.hasFocus();
let nativeActive = null;
let effectiveActive = null;
const invoke = (command, args) => {
  if (!window.__TAURI__?.core?.invoke) return Promise.reject(new Error(t('桌面连接不可用，请从超绝可爱弹幕姬程序打开。 [DV-UI02]')));
  return window.__TAURI__.core.invoke(command, args).catch(error => { throw new Error(errorMessage(error, command === 'snapshot' ? 'DV-X12' : command === 'check_update' ? 'DV-U01' : 'DV-UI02')); });
};

function showToast(message, isError = false, undo = null) {
  const target = document.querySelector('#toast');
  clearTimeout(toastTimer);
  cancelLeave(target);
  target.classList.add('toast');
  target.textContent = String(message);
  toastUndo = typeof undo === 'function' ? undo : null;
  if (toastUndo) target.innerHTML = `<span>${esc(String(message))}</span><button type="button" data-action="toast.undo">${esc(t('撤销'))}</button>`;
  target.classList.toggle('error', isError);
  target.hidden = false;
  toastTimer = setTimeout(() => { toastUndo = null; if (step !== 'main') { leaveGhost(target, 260); target.hidden = true; } else leaveThenHide(target, 240); }, isError ? 8000 : step === 'main' ? 3600 : 3000);
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
  if (changed && !voiceAuditionDraft.customText) voiceAuditionDraft.text = t('你好，欢迎来到直播间。');
  if (document.documentElement.lang !== getLanguage()) document.documentElement.lang = getLanguage();
  const title = t('超绝可爱弹幕姬');
  if (document.title !== title) document.title = title;
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
  if (!step) { step = replaySetup ? 'welcome' : startingStep(snapshot); setupTts = snapshot.setup?.tts_enabled ?? true; renderApp(); }
  else if (languageChanged) renderApp();
  if (languageChanged && settingsDialog.open) renderSettings();
  if (snapshot.onboarding_done && !replaySetup && step !== 'main') { stopQrPolling(); step = 'main'; renderApp(); }
  if (step === 'main') updateLive();
  if (settingsDialog.open) { updateVoiceSettings(); updateServiceIndicators(); updateOverlayStatus(); updateObsSettings(); }
  updateQr();
}

async function command(action, payload = {}, options = {}) {
  if (!options.quiet) clearError();
  pendingCommands++;
  try {
    const next = await invoke('dispatch', { action, payload });
    if (options.accept && !options.accept(next)) return null;
    acceptSnapshot(next);
    if (options.success) showToast(options.success);
    return next;
  } catch (error) {
    try {
      const next = await invoke('snapshot');
      if (options.accept && !options.accept(next)) return null;
      acceptSnapshot(next);
    } catch { /* Preserve the original command error. */ }
    if (!options.silent) showError(error);
    throw error;
  } finally { pendingCommands--; snapshotSequence.settled(); if (boot.polling) scheduleSnapshotPolling(); }
}

let setupRescan = false;
function setStep(next) {
  step = ['uid', 'connect'].includes(next) ? 'login' : next;
  if (step !== 'login') setupRescan = false;
  clearError();
  renderApp();
  if (next === 'login') void startQr('bilibili');
}

function errorSlot() { return '<div id="step-error" class="inline-error" role="alert" hidden></div>'; }

function renderChatBody(item) {
  return messageParts(item).map(part => part.type === 'emote'
    ? `<img class="message-emote${part.large ? ' large' : ''}" src="${esc(part.url)}" alt="" aria-label="${esc(part.text)}" loading="lazy" referrerpolicy="no-referrer">`
    : esc(part.text)).join('');
}


function qrMarkup(provider, inSettings = false) {
  return ui`<div class="${inSettings ? 'settings-qr' : ''}" data-qr-provider="${provider}"><div class="qr-frame"><div class="qr-placeholder"><span class="spinner" aria-hidden="true"></span><span>正在生成二维码</span></div></div><div class="qr-status" role="status" aria-live="polite"><span class="status-dot pulse"></span><span data-qr-label>正在生成二维码</span></div></div>`;
}

function updateThemeControl() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = t(dark ? '切换到日间' : '切换到夜间');
  const orb = document.querySelector('#lake-orb');
  if (orb && orb.getAttribute('aria-label') !== label) {
    orb.setAttribute('aria-label', label);
    const tip = document.querySelector('.lake-orb-tip');
    if (tip) tip.textContent = t(dark ? '日间 · afternoon' : '夜间 · evening');
  }
  const control = document.querySelector('#titlebar-actions [data-action="theme.toggle"]');
  if (!control) return;
  if (control.title === label && control.dataset.iconTheme === String(dark)) return;
  control.dataset.iconTheme = String(dark);
  control.title = label;
  control.setAttribute('aria-label', label);
  control.innerHTML = dark ? icon('moon') : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>';
}

function updateLakeClock() {
  const part = document.querySelector('#lake-daypart');
  const clock = document.querySelector('#lake-date-time');
  if (!part || !clock || document.documentElement.dataset.inactive === 'true') return;
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  // Match the evening and afternoon captions in the two reference scenes.
  const daypart = document.documentElement.dataset.theme === 'dark' ? 'evening' : 'afternoon';
  const label = `${weekday} ${daypart}`;
  if (part.dataset.label !== label) {
    part.dataset.label = label;
    part.innerHTML = `<span>${esc(weekday)}</span> <span>${daypart}</span>`;
  }
  const time = `${now.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }).toUpperCase()} · ${clockLabel(now.getTime())}`;
  if (clock.textContent !== time) clock.textContent = time;
}

function lakeLettersHtml(parts) {
  const graphemes = new Intl.Segmenter(getLanguage(), { granularity: 'grapheme' });
  const words = new Intl.Segmenter(getLanguage(), { granularity: 'word' });
  const cjk = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;
  // These common Chinese punctuation marks use one full unit in every context.
  const fullWidth = /[\u2014\u2018\u2019\u201c\u201d\u2026\u3000-\u303f\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u20e3]|\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
  // Integer hundredths keep visual-width thresholds exact; reveal/read positions
  // remain one letter per original grapheme, independent of its estimated width.
  const graphemeWidth = segment => cjk.test(segment) || fullWidth.test(segment) ? 100 : 55;
  const groups = [];
  for (const part of parts) {
    if (part.type === 'emote') {
      groups.push({ letters: [`<img class="message-emote${part.large ? ' large' : ''}" src="${esc(part.url)}" alt="" aria-label="${esc(part.text)}" loading="lazy" referrerpolicy="no-referrer">`], width: 100, word: false });
      continue;
    }
    for (const token of words.segment(part.text)) {
      const segments = [...graphemes.segment(token.segment)].map(({ segment }) => segment);
      const letters = segments.map(segment => esc(segment));
      const widths = segments.map(graphemeWidth);
      const width = widths.reduce((total, value) => total + value, 0);
      // Preserve every non-CJK word, including numbers and other scripts. CJK
      // tokens still have a break opportunity at each original grapheme.
      if (token.isWordLike && !cjk.test(token.segment)) groups.push({ letters, width, word: true });
      // A space belongs to the preceding group at a manual line break, but keeps
      // its own letter node, normal width, animation delay and reading position.
      else if (/^\s+$/u.test(token.segment) && groups.length) { groups.at(-1).letters.push(...letters); groups.at(-1).width += width; }
      else groups.push(...letters.map((letter, index) => ({ letters: [letter], width: widths[index], word: false })));
    }
  }
  const width = groups.reduce((total, group) => total + group.width, 0);
  const lineCount = width <= 800 ? 1 : width <= 1600 ? 2 : 3;
  // Round to a whole visual unit exactly as the former CJK character count did.
  const per = Math.max(100, Math.ceil(width / (lineCount * 100)) * 100);
  const lines = [];
  let next = 0;
  let index = 0;
  while (next < groups.length) {
    const row = [];
    let length = 0;
    while (next < groups.length) {
      const group = groups[next];
      const added = length + group.width;
      if (row.length && lines.length < lineCount - 1 && added > per && Math.abs(added - per) > Math.abs(length - per)) break;
      row.push(group); next++; length = added;
      if (lines.length < lineCount - 1 && length >= per) break;
    }
    lines.push(`<span class="lake-text-line">${row.map(group => {
      const html = group.letters.map(letter => `<span class="lake-letter ${lakeLetterFlip ? 'a' : 'b'}" style="--letter-delay:${index++ * 160}ms">${letter}</span>`).join('');
      return group.word ? `<span class="lake-word">${html}</span>` : html;
    }).join('')}</span>`);
  }
  return { size: width <= 1600 ? 'normal' : width <= 2600 ? 'medium' : 'small', html: lines.join('') };
}

function lakeMessageTime(observedAt, now = Date.now()) {
  const age = now - Number(observedAt);
  return Number(observedAt) > 0 && age >= 0 && age < 60_000 ? 'just now' : clockLabel(observedAt);
}

function lakeMessageHtml(event, key) {
  const text = lakeLettersHtml(messageParts(event));
  const price = event.price_yuan ? `<span class="lake-message-price">¥${esc(event.price_yuan)}</span>` : '';
  const open = `data-action="viewer.open" data-id="${esc(key)}"`;
  return `<div class="chat-hit"><span class="lake-message-meta"><button type="button" class="lake-avatar-button" ${open} aria-label="${esc(event.user_name || t('访客'))}">${viewerAvatar(event)}</button><button type="button" class="lake-message-name" ${open}>${esc(event.user_name || t('访客'))}</button>${price}<time datetime="${new Date(Number(event.observed_at_ms) || 0).toISOString()}"><span class="lake-relative">${esc(lakeMessageTime(event.observed_at_ms))}</span></time></span><span class="lake-message-text" data-size="${text.size}">${text.html}</span>${price ? `<em class="lake-history-price">¥${esc(event.price_yuan)}</em>` : ''}</div>`;
}

function updateLakePeek(host, rows) {
  const retained = new Map([...host.children].map(node => [node.dataset.id, node]));
  const keys = new Set(rows.map(([key]) => key));
  for (const node of [...host.children]) if (!keys.has(node.dataset.id)) node.remove();
  for (let index = 0; index < rows.length; index++) {
    const [key, event] = rows[index];
    let node = retained.get(key);
    if (!node) {
      node = document.createElement('button'); node.type = 'button'; node.className = 'lake-peek-entry'; node.dataset.action = 'viewer.open'; node.dataset.id = key;
      node.innerHTML = `${viewerAvatar(event)}<span class="lake-peek-text"></span>`;
    }
    patchMarkup(node.querySelector('.lake-peek-text'), renderChatBody(event));
    if (host.children[index] !== node) host.insertBefore(node, host.children[index] || null);
  }
}

function lakeLedger() {
  if (!lakePresentationLedger) {
    let storage;
    try { storage = window.sessionStorage; } catch { /* Recovery storage is optional. */ }
    lakePresentationLedger = createLakePresentationLedger(storage, window.__DANMAKUVOICE_STARTUP_THEME__?.session || '');
  }
  return lakePresentationLedger;
}

function lakePresentationIsVisible() {
  return step === 'main' && !settingsDialog.open && uiIsActive(nativeActive, windowFocused, document.hidden);
}

function rememberLakePresentation() {
  if (lakePresentationFrame || !lakePresentationIsVisible()) return;
  const context = lakePresentationContext;
  const pending = [...lakeMessageNodes.values()].filter(node => node.isConnected && node.getClientRects().length && !lakeLedger().has(context, lakePresentationIdentities.get(node)));
  if (!pending.length) return;
  // The second frame records a surface that had a chance to paint in the first.
  // Background snapshots and nodes replaced before that paint remain unseen.
  lakePresentationFrame = requestAnimationFrame(() => {
    lakePresentationFrame = requestAnimationFrame(() => {
      lakePresentationFrame = 0;
      if (context !== lakePresentationContext || !lakePresentationIsVisible()) return;
      const painted = pending.filter(node => node.isConnected && node.getClientRects().length);
      if (painted.length) lakeLedger().mark(context, painted.map(node => lakePresentationIdentities.get(node)));
      rememberLakePresentation();
    });
  });
}

function restoreLakePresentation() {
  if (!lakePresentationIsVisible()) return;
  for (const node of lakeMessageNodes.values()) {
    if (lakeLedger().has(lakePresentationContext, lakePresentationIdentities.get(node))) node.classList.add('lake-restored');
  }
  if (document.querySelector('#lake-current .lake-restored')) document.querySelector('#lake-text-reflection')?.classList.add('lake-restored');
  rememberLakePresentation();
}

let lakeDeep = false;
let lakeDeepSeen = new Set();
let lakeDeepSeenTotal = 0;
let lakeHistoryArchive = null;
let lakeVolumeHintTimer = null;
let lakeWake = null;

function currentLakeHistory() {
  const stats = snapshot.live_history;
  if (!stats?.session_id || !Number.isSafeInteger(stats.messages)) return null;
  const context = `${snapshot.account?.user_id || ''}:${stats.session_id}`;
  if (lakeHistoryArchive?.context !== context) {
    lakeHistoryArchive = { context, session: stats.session_id, items: new Map(), before: null, hasMore: true, headTotal: -1, headRevision: -1, headBusy: false, olderBusy: false, error: '', stats, viewers: new Map() };
    lakeDeepSeenTotal = stats.messages;
  }
  return lakeHistoryArchive;
}

function lakeObservedStats(events) {
  const archive = currentLakeHistory();
  const stats = archive && archive.stats.messages > snapshot.live_history.messages ? archive.stats : snapshot.live_history;
  const since = Number(snapshot.broadcast?.room?.live_since || (stats?.started_at_ms ? stats.started_at_ms / 1000 : snapshot.live?.started_at) || 0);
  const seconds = since > 0 ? Math.max(0, Math.floor(Date.now() / 1000 - since)) : null;
  return { messages: stats?.messages ?? events.length, people: stats?.unique_viewers ?? new Set(events.filter(event => ['danmaku', 'super_chat'].includes(event.kind)).map(viewerIdentity).filter(Boolean)).size, seconds };
}

function lakeDuration(seconds) {
  if (seconds == null) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (getLanguage() === 'en') return `${hours} ${hours === 1 ? 'hour' : 'hours'} ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return `${hours} ${t('小时')} ${minutes} ${t('分')}`;
}

async function requestLakeHistory(archive, payload = {}) {
  const result = await invoke('dispatch', { action: 'live.history', payload: { session_id: archive.session, limit: 100, ...payload } });
  const page = result.result;
  if (!page || page.session_id !== archive.session || !Array.isArray(page.items)) throw new Error(t('历史弹幕读取失败，请重试'));
  return page;
}

function redrawLakeHistory(archive) {
  if (archive !== currentLakeHistory() || step !== 'main') return;
  const events = normalizedEvents(snapshot);
  renderLakeHistory(events, eventKeys(events));
}

async function loadLakeHistory(older = false) {
  const archive = currentLakeHistory();
  if (!archive || (older ? archive.olderBusy || archive.headBusy || !archive.hasMore : archive.headBusy)) return;
  const flag = older ? 'olderBusy' : 'headBusy';
  archive[flag] = true; archive.error = '';
  const refreshMetadata = Number(snapshot.live_history.metadata_revision || 0) > archive.headRevision;
  const previousNewest = archive.items.size ? refreshMetadata
    ? [...archive.items.keys()].reduce((min, value) => Math.min(min, value), Infinity)
    : [...archive.items.keys()].reduce((max, value) => Math.max(max, value), 0) : 0;
  let before = older ? archive.before : undefined;
  redrawLakeHistory(archive);
  try {
    // Catch up in stable pages if more than 100 lines arrived while submerged.
    // Older-page cursors remain fixed while new lines arrive at the surface.
    do {
      const page = await requestLakeHistory(archive, before == null ? {} : { before });
      if (archive !== currentLakeHistory() || Number(page.metadata_revision || 0) < archive.headRevision) return;
      const oldest = archive.items.size ? [...archive.items.keys()].reduce((min, value) => Math.min(min, value), Infinity) : Infinity;
      for (const item of page.items) archive.items.set(item.sequence, item.event);
      archive.stats = page;
      if (!older) { archive.headTotal = Math.max(archive.headTotal, page.messages); archive.headRevision = Number(page.metadata_revision || 0); }
      if (page.before == null || page.before < oldest) { archive.before = page.before; archive.hasMore = page.has_more; }
      before = page.before;
      if (older || !previousNewest || !page.has_more || before <= previousNewest) break;
    } while (before != null);
  } catch (error) {
    if (archive === currentLakeHistory()) { archive.error = errorMessage(error); archive.errorOlder = older; }
  } finally { archive[flag] = false; redrawLakeHistory(archive); }
}

function lakeHistoryMessageLabel(count, expanded = false) {
  if (getLanguage() === 'en' && count === 1) return 'message rests in the lake';
  return t(expanded ? '句弹幕沉在湖里' : '句沉在湖里');
}

function renderLakeHistory(events, keys) {
  const feed = document.querySelector('#chat-feed');
  if (!feed) return;
  const archive = currentLakeHistory();
  feedEvents.clear(); keys.forEach((key, index) => feedEvents.set(key, events[index]));
  const stats = lakeObservedStats(events);
  const total = document.querySelector('#lake-history-total');
  if (total) total.textContent = String(stats.messages);
  patchMarkup(document.querySelector('#lake-history-label'), esc(lakeHistoryMessageLabel(stats.messages)));
  const reading = snapshot.queue?.current;
  const newCount = lakeDeep ? archive ? Math.max(0, stats.messages - lakeDeepSeenTotal) : keys.filter(key => !lakeDeepSeen.has(key)).length : 0;
  const newButton = document.querySelector('#lake-deep-new');
  patchMarkup(newButton, newCount ? `${newCount} ${esc(t('句新弹幕'))}` : '');
  if (newButton) newButton.hidden = !newCount;
  patchMarkup(document.querySelector('#lake-deep-reading'), reading && reading.origin !== 'audition' ? `${esc(t('正在读'))} · ${esc(reading.user_name || '')}${esc(t('：'))}${esc(jobDisplayText(reading, events))}` : '');
  patchMarkup(document.querySelector('#lake-deep-stats'), `<strong>${stats.messages}</strong><span>${esc(lakeHistoryMessageLabel(stats.messages, true))}</span><p>${stats.seconds == null ? '' : `${esc(t('今晚'))} ${esc(lakeDuration(stats.seconds))}<br>`}${stats.people} ${esc(t('位朋友说过话'))}</p>`);
  if (!lakeDeep) return;
  if (archive && !archive.error && (snapshot.live_history.messages > archive.headTotal || Number(snapshot.live_history.metadata_revision || 0) > archive.headRevision) && !archive.headBusy) void loadLakeHistory();
  const items = archive?.items.size ? [...archive.items].sort(([a], [b]) => a - b).map(([sequence, event]) => ({ key: `history:${archive.session}:${sequence}`, event })) : events.map((event, index) => ({ key: keys[index], event }));
  for (const item of items) feedEvents.set(item.key, item.event);
  patchMarkup(document.querySelector('#lake-history-more'), archive ? archive.error ? `<span role="status">${esc(archive.error)}</span><button type="button" data-action="lake.history.retry">${esc(t('重试'))}</button>` : archive.headBusy || archive.olderBusy ? `<span role="status">${esc(t('正在读取更深处的弹幕'))}</span>` : archive.hasMore ? `<button type="button" data-action="lake.history.more">${esc(t('再往深处看看'))}</button>` : '' : '');
  const signature = JSON.stringify([items.map(item => [item.key, messageParts(item.event)]), viewerOpenIdentity, getLanguage()]);
  if (signature === feedSignature) return;
  const scroll = document.querySelector('#chat-scroll');
  const scrollTop = scroll?.getBoundingClientRect().top;
  const anchor = scroll?.scrollTop > 0 ? [...feed.children].find(entry => entry.getBoundingClientRect().bottom > scrollTop) : null;
  const anchorKey = anchor?.dataset.id;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - scrollTop : 0;
  patchMarkup(feed, items.map(({ event, key }) => {
    const gold = ['gift', 'super_chat', 'guard'].includes(event.kind);
    return `<button type="button" class="lake-history-entry${gold ? ' gold' : ''}${viewerIdentity(event) === viewerOpenIdentity ? ' selected' : ''}" data-action="viewer.open" data-id="${esc(key)}"><span class="lake-history-meta">${viewerAvatar(event)}<span>${esc(event.user_name || t('访客'))}</span><time>${esc(clockLabel(event.observed_at_ms))}</time></span><span class="lake-history-body">${renderChatBody(event)}${event.price_yuan ? `<em>¥${esc(event.price_yuan)}</em>` : ''}</span></button>`;
  }).reverse().join(''));
  feedSignature = signature;
  const moved = anchor && [...feed.children].find(entry => entry.dataset.id === anchorKey);
  if (moved) scroll.scrollTop += moved.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchorOffset;
}

function renderLakeTranscript(events, keys) {
  const current = document.querySelector('#lake-current');
  const peek = document.querySelector('#lake-peek');
  if (!current || !peek) return;
  const enabled = broadcastEnabled();
  const room = snapshot.broadcast?.room;
  const live = enabled && broadcastLive(room);
  const account = broadcastAccount();
  const presentationContext = JSON.stringify([account, String(snapshot.live?.room_id || snapshot.setup?.room_id || '')]);
  if (presentationContext !== lakePresentationContext) {
    cancelAnimationFrame(lakePresentationFrame); lakePresentationFrame = 0;
    for (const node of lakeMessageNodes.values()) node.remove();
    lakeMessageNodes.clear(); lakeTranscriptSignature = ''; lakePresentationContext = presentationContext;
    lakeDeepSeen = new Set(keys); lakeDeep = false;
  }
  const sessionContext = `${account}:${room?.room_id || ''}`;
  if (sessionContext !== lakeSessionAccount) { lakeSessionAccount = sessionContext; lakePreviousBroadcastLive = false; lakeEnded = false; }
  lakeSessionSummary = enabled && account && room ? broadcastSessionSummary(snapshot.broadcast) : null;
  if (live) lakeEnded = false;
  else if (enabled && lakePreviousBroadcastLive) lakeEnded = true;
  lakePreviousBroadcastLive = live;
  if (!enabled) lakeEnded = false;
  const prepared = enabled && !!room && !live;
  const face = enabled && !!snapshot.broadcast?.face_image && onAirPanelMode === 'face';
  const speaking = !!(snapshot.setup?.tts_enabled ?? snapshot.preferences?.tts_enabled) && snapshot.queue?.current;
  const featured = !prepared ? spotlightKey(events, keys, speaking) || keys.at(-1) : '';
  const index = keys.indexOf(featured);
  const scene = face ? 'face' : prepared ? lakeEnded ? 'ended' : 'offair' : !events.length ? 'empty' : speaking ? 'live' : 'calm';
  const shell = document.querySelector('#live-shell');
  shell.dataset.scene = scene; shell.classList.toggle('lake-deep', lakeDeep);
  const deep = document.querySelector('#lake-deep');
  if (deep) deep.hidden = !lakeDeep;
  const identity = index >= 0 ? JSON.stringify([featured, events[index].observed_at_ms]) : '';
  const signature = JSON.stringify([identity, index >= 0 ? messageParts(events[index]) : null, keys.slice(-4), events.slice(-4).map(messageParts), scene, room?.title, !!lakeObsTitle(), lakeSessionSummary, getLanguage(), viewerOpenIdentity]);
  if (signature !== lakeTranscriptSignature) {
    for (const [key, node] of lakeMessageNodes) if (key !== featured) { node.remove(); lakeMessageNodes.delete(key); }
    current.querySelector('.lake-state')?.remove();
    if (index >= 0) {
      let node = lakeMessageNodes.get(featured);
      if (node && lakePresentationIdentities.get(node) !== identity) { node.remove(); node = null; }
      const restored = lakeLedger().has(presentationContext, identity);
      const fresh = !node;
      if (!node) {
        lakeLetterFlip = !lakeLetterFlip; node = document.createElement('article'); node.dataset.key = featured;
        lakeMessageNodes.set(featured, node); lakePresentationIdentities.set(node, identity);
      }
      const content = JSON.stringify(messageParts(events[index]));
      if (lakeMessageContents.get(node) !== content) {
        const body = node.querySelector('.lake-message-text');
        if (body) {
          const text = lakeLettersHtml(messageParts(events[index]));
          body.dataset.size = text.size; body.innerHTML = text.html;
          if (restored) node.classList.add('lake-restored');
        } else node.innerHTML = lakeMessageHtml(events[index], featured);
        lakeMessageContents.set(node, content);
      }
      // A scene/status change must not end an already running letter animation.
      // Only recovered nodes and late enrichment of seen text become static.
      const staticPresentation = fresh ? restored : node.classList.contains('lake-restored');
      node.className = `lake-message lake-featured${staticPresentation ? ' lake-restored' : ''}${viewerIdentity(events[index]) === viewerOpenIdentity ? ' selected' : ''}`;
      if (node.parentElement !== current) current.append(node);
    } else {
      const text = prepared ? lakeEnded ? t('今晚辛苦啦') : room.title || '' : 'waiting for the first word…';
      const title = lakeLettersHtml([{ type: 'text', text }]);
      // The OBS overlay title sits where the category was, so it can be set for
      // tonight without opening settings; it opens the same in-place editor as
      // the room title. Without an overlay the kicker is just a label.
      const obsTitle = lakeObsTitle();
      const obs = obsTitle ? ` <em>— OBS · <button type="button" class="lake-obs-title" data-action="onair.obs" data-lake-obs-title title="${esc(t('OBS 叠加层主标题'))}">${esc(obsTitle)}</button></em>` : '';
      const kicker = prepared && !lakeEnded ? `<span class="lake-title-kicker">TONIGHT’S TITLE${obs}</span>` : '';
      current.innerHTML = `<div class="lake-state${prepared ? '' : ' lake-waiting'}">${kicker}<${prepared && !lakeEnded ? `button type="button" data-action="onair.info" title="${esc(t('改标题'))}"` : 'span'} class="lake-state-title lake-message-text" data-size="${title.size}">${prepared ? title.html : esc(text)}</${prepared && !lakeEnded ? 'button' : 'span'}></div>`;
    }
    const recent = keys.map((key, i) => [key, events[i]]).filter(([key]) => key !== featured).slice(-3).reverse();
    updateLakePeek(peek, prepared ? [] : recent);
    let summary = [];
    if (prepared && lakeSessionSummary) {
      const session = snapshot.broadcast.last_session;
      const people = Number.isSafeInteger(session?.unique_viewers) ? `${session.unique_viewers} ${t('位朋友说过话')}` : '';
      const date = new Date(lakeSessionSummary.endedAt * 1000);
      summary = lakeEnded
        ? [`${lakeSessionSummary.messages} ${t('句弹幕沉进了湖里')}`, people, 'see you next time.']
        : [`${t('上一场')} · ${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}${lakeSessionSummary.seconds == null ? '' : ` · ${lakeDuration(lakeSessionSummary.seconds)}`}`, `${lakeSessionSummary.messages} ${t('句弹幕')}${people ? ` · ${people}` : ''}`];
    }
    patchMarkup(document.querySelector('#lake-session'), summary.filter(Boolean).map(line => `<p>${esc(line)}</p>`).join(''));
    const reflection = document.querySelector('#lake-text-reflection');
    const source = current.querySelector('.lake-message-text');
    if (reflection && source) { reflection.innerHTML = source.innerHTML; reflection.dataset.size = source.dataset.size || 'normal'; reflection.classList.toggle('lake-waiting', !prepared && index < 0); reflection.classList.toggle('lake-restored', !!source.closest('.lake-restored')); }
    lakeTranscriptSignature = signature;
  }
  // A saved OBS title changes only its own words: no redraw, no replayed letters.
  const obsNode = current.querySelector('[data-lake-obs-title]'), obsText = lakeObsTitle();
  if (obsNode && obsText && obsNode.textContent !== obsText) obsNode.textContent = obsText;
  const relative = current.querySelector('.lake-relative');
  if (relative && index >= 0) {
    const label = lakeMessageTime(events[index].observed_at_ms);
    if (relative.textContent !== label) relative.textContent = label;
  }
  syncLakeReadingProgress();
  const more = document.querySelector('.lake-history-open');
  if (more) more.hidden = prepared || !events.length;
  rememberLakePresentation();
}

function syncLakeReadingProgress() {
  const playback = snapshot.playback || snapshot.queue?.playback;
  const job = snapshot.queue?.current;
  // Both copies use the same measured playback fraction. Without a matching
  // audio clock, show the whole phrase rather than inventing word timing.
  const matched = job && playback && String(playback.job_id) === String(job.id) && Number(playback.queued_ms) > 0;
  const ratio = matched ? Math.min(1, Math.max(0, Number(playback.played_ms) / Number(playback.queued_ms))) : 1;
  for (const parent of document.querySelectorAll('#lake-current .lake-message-text, #lake-text-reflection')) {
    const letters = parent.querySelectorAll('.lake-letter');
    letters.forEach((letter, index) => letter.classList.toggle('lake-unread', matched && index >= Math.ceil(letters.length * ratio)));
  }
}

function setLakeDepth(deep) {
  if (lakeDeep === deep) return;
  lakeDeep = deep;
  const apply = () => {
    const events = normalizedEvents(snapshot); const keys = eventKeys(events);
    if (deep) { closeVoicePanel(); closeQueuePanel(); lakeDeepSeen = new Set(keys); lakeDeepSeenTotal = lakeObservedStats(events).messages; }
    document.querySelector('#live-shell')?.classList.toggle('lake-deep', deep);
    const panel = document.querySelector('#lake-deep'); if (panel) panel.hidden = !deep;
    feedSignature = ''; renderLakeHistory(events, keys);
    if (deep) { document.querySelector('#chat-scroll').scrollTop = 0; document.querySelector('[data-action="lake.surface"]')?.focus({ preventScroll: true, focusVisible: false }); }
    else {
      const visible = node => node && node !== document.body && node !== document.documentElement && !node.disabled && !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const link = document.querySelector('.lake-history-open');
      const target = visible(link) ? link : visible(document.activeElement) ? document.activeElement : document.querySelector('#tts-switch');
      target?.focus({ preventScroll: true, focusVisible: false });
    }
  };
  apply();
  // Diving moves the horizon at once; the new layer settles in from the direction of travel.
  const shell = document.querySelector('#live-shell');
  if (!shell || !motionAllowed()) return;
  shell.classList.remove('lake-dive-in', 'lake-surface-in'); void shell.offsetWidth;
  shell.classList.add(deep ? 'lake-dive-in' : 'lake-surface-in');
  clearTimeout(lakeDiveTimer);
  lakeDiveTimer = setTimeout(() => shell.classList.remove('lake-dive-in', 'lake-surface-in'), 520);
}
let lakeDiveTimer = null;

function closeLakeHistory() { setLakeDepth(false); }

function lakeVolumeValue() {
  const stored = Math.round(Number(snapshot.preferences?.master_volume ?? 1) * 100);
  return volumeDraft ?? (snapshot.preferences?.muted ? 0 : stored);
}

function adjustLakeVolume(value) {
  volumeDraft = Math.max(0, Math.min(100, value));
  renderDockVoice(); updateVolumeControls(); volumeSave.schedule(volumeDraft);
  const control = document.querySelector('.lake-voice-control'); control?.classList.add('adjusting');
  clearTimeout(lakeVolumeHintTimer); lakeVolumeHintTimer = setTimeout(() => control?.classList.remove('adjusting'), 1200);
}

function installLakeMainEvents() {
  const shell = document.querySelector('#live-shell');
  if (!shell || shell.dataset.mainEvents) return;
  shell.dataset.mainEvents = 'true';
  document.querySelector('#chat-scroll')?.addEventListener('scroll', event => {
    const scroll = event.currentTarget;
    if (lakeDeep && scroll.scrollTop > 0 && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 240) void loadLakeHistory(true);
  });
  shell.addEventListener('wheel', event => {
    if (event.target.closest('.lake-voice-control')) {
      event.preventDefault();
      adjustLakeVolume(lakeVolumeValue() + (event.deltaY < 0 ? 5 : -5));
      return;
    }
    if (settingsDialog.open || viewerContext || event.target.closest('.voice-panel,.audience-dialog,.onair-panel,.chat-emoticon-picker,.lake-foot')) return;
    if (!lakeDeep && event.deltaY > 12 && normalizedEvents(snapshot).length) { event.preventDefault(); setLakeDepth(true); }
    else if (lakeDeep && event.deltaY < -12 && (document.querySelector('#chat-scroll')?.scrollTop || 0) <= 1) { event.preventDefault(); setLakeDepth(false); }
  }, { passive: false });
  shell.addEventListener('keydown', event => {
    if (event.target.matches('.lake-volume-waterline') && ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const value = event.key === 'Home' ? 0 : event.key === 'End' ? 100 : lakeVolumeValue() + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -5 : 5);
      adjustLakeVolume(value); return;
    }
    if (event.target.matches('input,textarea,select') || event.target.closest('[contenteditable]')) return;
    if (event.key === 'PageDown' && !lakeDeep && normalizedEvents(snapshot).length) { event.preventDefault(); setLakeDepth(true); }
    if ((event.key === 'Escape' || event.key === 'PageUp') && lakeDeep && !viewerContext) { event.preventDefault(); setLakeDepth(false); }
  });
}

async function handleLakeMainAction(action, id, target) {
  if (action === 'lake.prepare') { lakeEnded = false; lakeTranscriptSignature = ''; onAirSignature = ''; liveRenderSignature = ''; updateLive(); return true; }
  if (action === 'history.open') { setLakeDepth(true); return true; }
  if (action === 'lake.surface') { setLakeDepth(false); return true; }
  if (action === 'lake.new') { lakeDeepSeen = new Set(eventKeys(normalizedEvents(snapshot))); lakeDeepSeenTotal = lakeObservedStats(normalizedEvents(snapshot)).messages; document.querySelector('#chat-scroll').scrollTop = 0; renderLakeHistory(normalizedEvents(snapshot), eventKeys(normalizedEvents(snapshot))); return true; }
  if (action === 'lake.history.more' || action === 'lake.history.retry') { await loadLakeHistory(action === 'lake.history.more' || !!currentLakeHistory()?.errorOlder); return true; }
  if (action === 'lake.viewer.history.retry') { void loadViewerSaid(viewerContext, true); return true; }
  if (action === 'lake.voices') { closeVoicePanel(); await openViewerSettings('voices'); return true; }
  if (action === 'lake.voices.add') { closeVoicePanel(); await openViewerSettings('voices'); await selectLakeVoiceProvider(defaultVoiceTab()); return true; }
  if (action === 'lake.voice.wake') {
    const preset = snapshot.presets?.find(item => item.id === id);
    if (!preset || lakeWake) return true;
    const connection = snapshot.connections?.find(item => item.id === preset.connection_id);
    if (!connection || !['dots', 'gpt_sovits'].includes(preset.provider)) return true;
    const service = localServiceState(preset.provider, connection);
    if (!service.directory) { closeVoicePanel(); await openViewerSettings('voices', { type: 'service', provider: preset.provider }); return true; }
    lakeWake = { id, provider: preset.provider, connection: connection.id, room: String(snapshot.live?.room_id || ''), selecting: false };
    renderVoicePanel();
    try { await command('local_services.start', { provider: preset.provider, connection_id: connection.id }, { quiet: true }); await settleLakeWake(); }
    catch (error) { lakeWake = null; renderVoicePanel(); throw error; }
    return true;
  }
  if (action === 'lake.viewer.mute') { await moderateViewer('mute', Number(id)); return true; }
  return false;
}

async function settleLakeWake() {
  const pending = lakeWake;
  if (!pending || pending.selecting) return;
  const preset = snapshot.presets?.find(item => item.id === pending.id && item.connection_id === pending.connection);
  if (!preset || String(snapshot.live?.room_id || '') !== pending.room) { lakeWake = null; return; }
  const connection = snapshot.connections?.find(item => item.id === pending.connection);
  const service = localServiceState(pending.provider, connection);
  if (service.state === 'failed') { lakeWake = null; renderVoicePanel(); return; }
  if (service.state !== 'ready') return;
  pending.selecting = true;
  try { await command('presets.default', { id: pending.id }, { quiet: true }); }
  finally { if (lakeWake === pending) lakeWake = null; renderVoicePanel(); }
}

function updateLakePopScrim() {
  const scrim = document.querySelector('#lake-pop-scrim');
  if (!scrim) return;
  const voice = document.querySelector('#tts-menu');
  scrim.hidden = !(voice && !voice.hidden || chatEmoticonsOpen || audiencePinned && document.querySelector('#audience-dialog')?.open || onAirPanelMode === 'info');
}

function renderApp() {
  clearFoldingRows();
  app.setAttribute('aria-busy', 'false');
  document.documentElement.dataset.step = step || '';
  const titlebarActions = document.querySelector('#titlebar-actions');
  // On the lake the sun / moon itself switches day and night.
  if (titlebarActions) titlebarActions.innerHTML = step ? iconButton('settings', t('打开设置'), 'settings.open') : '';
  updateTitlebar();
  if (step === 'main') {
    stopSetupSceneMotion();
    app.innerHTML = ui`<div class="app-shell live-shell lake-mode" id="live-shell">${lakeSceneMarkup()}${snapshot.network_disabled ? t('<div class="test-mode-note" role="status">离线测试窗口 · 独立测试数据</div>') : ''}<main class="chat-main live-stage lake-content"><header class="masthead lake-header"><div class="lake-date"><span id="lake-daypart"></span><time id="lake-date-time"></time></div><div class="lake-room-row"><div class="masthead-kicker" id="masthead-kicker"><span id="connection-dot" class="status-dot"></span><span id="room-caption" class="sr-only"></span></div><h1 class="masthead-title"><button type="button" id="lake-title" data-action="onair.info"><span class="lake-room-name"><span id="masthead-name" class="masthead-name"></span><span id="masthead-suffix" class="masthead-suffix"></span></span><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"></path></svg></button></h1><button type="button" id="audience-count" class="audience-byline" data-action="audience.open" aria-haspopup="dialog" aria-controls="audience-dialog" aria-expanded="false" hidden></button></div></header><div id="live-error" class="live-error" role="status" hidden><span></span>${button(t('查看'), 'settings.room', { class: 'quiet small' })}</div><div class="lake-body" id="lake-transcript"><div id="lake-current" class="lake-current" role="log" aria-label="此刻这一句" aria-live="polite" aria-relevant="additions"></div><div id="lake-text-reflection" class="lake-text-reflection" aria-hidden="true"></div><div id="lake-water-hover"><div id="lake-peek" aria-label="刚沉下去的弹幕"></div></div><div id="lake-session" class="lake-session"></div><button type="button" class="lake-history-open" data-action="history.open"><i id="lake-history-total">0</i> <span id="lake-history-label">句沉在湖里</span> ↓</button></div></main><div class="onair-wrap" data-broadcast-scope="main"><div id="onair" class="onair" role="group" aria-label="开播" hidden></div><div id="onair-panel" class="onair-panel" role="dialog" aria-label="开播" hidden></div></div><div class="lake-foot"><div class="lake-voice-control"><button type="button" id="tts-switch" class="dock-voice" data-action="tts.open" aria-haspopup="dialog" aria-expanded="false"></button><button type="button" class="lake-volume-waterline" data-action="audio.mute" role="slider" aria-label="播报音量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" aria-valuetext="100%"><i></i></button><span class="lake-volume-hint"><i id="main-volume-value"></i><small>滚轮调节</small></span></div><div id="chat-compose" class="chat-compose" hidden></div></div><div id="chat-emoticon-picker" class="chat-emoticon-picker" hidden></div><div id="tts-menu" class="voice-panel" role="dialog" aria-label="播报声音" hidden></div><span id="queue-sep" hidden></span><button type="button" id="queue-pill" class="sr-only" data-action="queue.toggle" aria-expanded="false" hidden></button><div id="queue-panel" class="queue-panel" role="list" aria-label="待读弹幕" hidden></div><div id="viewer-drawer" class="viewer-layer" hidden></div><section id="lake-deep" class="lake-deep-content" aria-label="历史弹幕" hidden><header class="lake-deep-head"><button type="button" data-action="lake.surface">⌃ 回到水面</button><button type="button" id="lake-deep-new" data-action="lake.new" hidden></button><span id="lake-deep-reading"></span></header><aside id="lake-deep-stats"></aside><div id="chat-scroll" class="chat-scroll" tabindex="0" aria-label="收到的弹幕"><div id="chat-empty" class="chat-empty"></div><div id="chat-feed" class="chat-feed" aria-label="历史弹幕"></div><div id="lake-history-more" class="lake-history-more"></div></div><button id="new-messages" hidden></button></section></div>`;
    const queueShortcut = document.querySelector('#queue-pill');
    if (queueShortcut) queueShortcut.tabIndex = -1;
    lakeDeep = false; lakeTranscriptSignature = ''; lakeMessageNodes.clear(); updateThemeControl(); updateLakeClock();
    clearInterval(lakeClockTimer); lakeClockTimer = setInterval(() => { if (!snapshot || !uiIsActive(nativeActive, windowFocused, document.hidden)) return; updateLakeClock(); if (!settingsDialog.open) renderLakeTranscript(normalizedEvents(snapshot), eventKeys(normalizedEvents(snapshot))); }, 1000);
    installLakeMainEvents();
    feedSignature = ''; feedLastKey = ''; onAirSignature = ''; onAirPanelMode = ''; feedEvents.clear(); viewerContext = null; viewerOpenIdentity = ''; liveMainSignature = ''; liveRenderSignature = ''; queueSignature = '';
    audienceSignature = ''; audienceReturn = false; audiencePinned = false; audienceMoreAt = 0; audienceEntries.clear(); clearTimeout(audienceCloseTimer);
    document.querySelector('#live-shell').insertAdjacentHTML('beforeend', `<button type="button" id="lake-pop-scrim" data-action="lake.pop.close" aria-label="${esc(t('收起'))}" hidden></button>`);
    document.querySelector('#live-shell').insertAdjacentHTML('beforeend', '<dialog id="audience-dialog" class="audience-dialog" aria-labelledby="audience-title"></dialog>');
    document.querySelector('#audience-dialog').addEventListener('cancel', event => { event.preventDefault(); closeAudience(); });
    const watching = document.querySelector('#audience-count');
    const audienceDialog = document.querySelector('#audience-dialog');
    watching.addEventListener('mouseenter', () => {
      clearTimeout(audienceCloseTimer);
      const leaving = audienceDialog.classList.contains('closing');
      if (!watching.hidden && (!audienceDialog.open || leaving) && !settingsDialog.open && !viewerContext && !onAirPanelMode) openAudience(false);
    });
    watching.addEventListener('mouseleave', () => {
      clearTimeout(audienceCloseTimer);
      audienceCloseTimer = setTimeout(() => { if (!audiencePinned) closeAudience(false); }, 350);
    });
    audienceDialog.addEventListener('mouseenter', () => clearTimeout(audienceCloseTimer));
    audienceDialog.addEventListener('mouseleave', () => { if (!audiencePinned) closeAudience(false); });
    document.querySelector('#audience-dialog').addEventListener('click', event => {
      if (event.target.id !== 'audience-dialog') return;
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeAudience();
    });
    document.querySelector('#chat-scroll').addEventListener('scroll', event => {
      const node = event.currentTarget;
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 70) document.querySelector('#new-messages').hidden = true;
      updateFeedDepth();
    }, { passive: true });
    updateLive();
    return;
  }
  clearInterval(lakeClockTimer); lakeClockTimer = null;
  const phase = ['connect', 'login'].includes(step) ? 1 : ['tts', 'doubaoQr'].includes(step) ? 2 : 3;
  const rail = [t('连接直播间'), t('语音播报'), t('完成')].map((title, index) => `<li class="${index + 1 === phase ? 'active' : index + 1 < phase ? 'done' : ''}"><i>${index + 1 < phase ? '✓' : index + 1}</i><span>${esc(title)}</span></li>`).join('');
  const setupMarkup = ui`<div class="app-shell lake-mode lake-setup" id="setup-shell">${lakeSceneMarkup()}${snapshot.network_disabled ? t('<div class="test-mode-note" role="status">离线测试窗口 · 独立测试数据</div>') : ''}<section class="setup-brand"><i>welcome</i><h1>超绝可爱弹幕姬</h1><p>把直播间的弹幕，用你喜欢的声音读出来。</p>${step === 'welcome' ? `<div class="setup-welcome-actions">${button(t('开始'), 'setup.start', { class: 'primary' })}<span>${esc(t('大约一分钟'))}</span></div>` : ''}</section>${step !== 'welcome' ? `<main class="setup-lake-drawer"><ol class="setup-steps">${rail}</ol><section class="setup-card" aria-label="${esc(t('初次设置'))}">${renderStep()}</section>${['login', 'doubaoQr'].includes(step) ? '' : `<footer>${esc(t('登录和密钥只存在这台电脑上，不会跟着备份导出。'))}</footer>`}</main>` : ''}</div>`;
  patchSetupShell(setupMarkup);
  updateThemeControl();
  updateQr();
}

// Moving between first-run steps replaces the brand and the drawer only, so the
// clouds, birds and waves keep drifting. The drawer slides in the first time it
// appears; after that each step's card fades in where the last one was.
let setupSceneMotionTimer = null;
function stopSetupSceneMotion() {
  clearTimeout(setupSceneMotionTimer); setupSceneMotionTimer = null;
  document.querySelector('#setup-shell')?.classList.remove('setup-scene-moving');
}

function patchSetupShell(markup) {
  const shell = app.querySelector(':scope > #setup-shell');
  if (!shell?.querySelector(':scope > .lake-scenery')) { stopSetupSceneMotion(); app.innerHTML = markup; return; }
  const template = document.createElement('template'); template.innerHTML = markup;
  const next = template.content.firstElementChild;
  const scene = node => node.matches('.lake-filters, .lake-scenery, #lake-orb, .lake-orb-tip');
  const hadDrawer = !!shell.querySelector(':scope > .setup-lake-drawer');
  const hasDrawer = !!next.querySelector(':scope > .setup-lake-drawer');
  const moveScene = hadDrawer !== hasDrawer && motionAllowed();
  if (moveScene) {
    clearTimeout(setupSceneMotionTimer);
    shell.classList.add('setup-scene-moving');
    void shell.offsetWidth;
  } else if (!motionAllowed()) stopSetupSceneMotion();
  const before = [...shell.children].filter(node => !scene(node));
  const after = [...next.children].filter(node => !scene(node));
  before.forEach((node, index) => { if (after[index]?.outerHTML === node.outerHTML) after[index] = node; else node.remove(); });
  // Kept nodes stay where they are (moving them would restart their animations).
  let cursor = null;
  for (const node of after) {
    if (!node.isConnected) { const kept = after.find(item => item.isConnected); if (cursor) cursor.after(node); else if (kept) kept.before(node); else shell.append(node); }
    cursor = node;
  }
  const drawer = shell.querySelector(':scope > .setup-lake-drawer');
  if (drawer && motionAllowed()) (hadDrawer ? drawer.querySelector('.setup-card') : drawer)?.classList.add(hadDrawer ? 'step-enter' : 'entering');
  if (moveScene) {
    void shell.offsetWidth;
    setupSceneMotionTimer = setTimeout(() => { shell.classList.remove('setup-scene-moving'); setupSceneMotionTimer = null; }, 700);
  }
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
  const back = ui`<button type="button" class="back-button" data-action="setup.back">${icon('back')}返回</button>`;
  if ((step === 'login' || step === 'connect') && snapshot.account?.user_id && snapshot.setup?.room_id && !setupRescan) return `${back}<i class="setup-eyebrow">sign in</i><h1>${esc(t('连接直播间'))}</h1><p class="setup-description">${esc(t('已经登录了，可以直接继续。'))}</p><dl class="setup-summary"><div><dt>${esc(t('直播间'))}</dt><dd>${esc(snapshot.account.name || t('我的直播间'))}<i>${esc(snapshot.setup.room_id)}</i></dd></div></dl><button type="button" class="button primary setup-enter" data-action="setup.continue">${esc(t('继续'))}${icon('arrow')}</button><button type="button" class="text-button setup-switch-account" data-action="setup.rescan">${esc(t('换一个账号'))}</button>${errorSlot()}`;
  if (step === 'login' || step === 'connect') return ui`${back}<i class="setup-eyebrow">sign in</i><h1>连接直播间</h1><p class="setup-description">用哔哩哔哩 App 扫码，自动找到你的直播间。</p>${qrMarkup('bilibili')}<ol class="qr-steps"><li><span>1</span>打开哔哩哔哩 App，扫描二维码</li><li><span>2</span>在手机上确认登录</li></ol><p class="setup-qr-foot">二维码两分钟后会过期 · <button type="button" class="text-button" data-action="qr.retry">换一张</button></p>${errorSlot()}`;
  if (step === 'tts') return ui`${back}<i class="setup-eyebrow">voices</i><h1>要读出弹幕吗？</h1><p class="setup-description">其他语音服务可以稍后在设置中添加。</p><div class="setup-voice-choices"><button type="button" data-action="setup.doubao"><span class="setup-choice-icon">${voiceWaveMarkup(false)}</span><strong>用豆包播报</strong><span>扫码连接豆包，使用默认音色播报新弹幕。</span></button><button type="button" data-action="setup.silent"><span class="setup-choice-icon silent">${voiceWaveMarkup(true)}</span><strong>暂时只看弹幕</strong><span>不需要音频设备，随时可以在设置中开启。</span></button></div>${errorSlot()}`;
  if (step === 'doubaoQr') return ui`${back}<i class="setup-eyebrow">connect</i><h1>扫码连接豆包</h1>${qrMarkup('doubao')}<ol class="qr-steps"><li><span>1</span>打开豆包 App，扫描二维码</li><li><span>2</span>在手机上确认登录</li></ol><div class="setup-qr-foot"><button type="button" class="text-button" data-action="qr.retry">换一张</button><button type="button" class="text-button" data-action="setup.silent">暂时只看弹幕</button></div>${errorSlot()}`;
  const room = snapshot.setup?.room_id;
  const preferred = snapshot.presets?.find(p => p.id === snapshot.rules?.default_preset_id);
  const voice = setupTts ? preferred ? presetLabel(preferred) : t('豆包') : t('暂时只看弹幕');
  return ui`${back}<i class="setup-eyebrow">ready</i><h1>准备好了</h1><p class="setup-description">接下来，就让弹幕落在湖面上。</p><dl class="setup-summary"><div><dt>直播间</dt><dd>${esc(snapshot.account?.name || t('我的直播间'))}<i>${esc(room || '')}</i></dd></div><div><dt>声音</dt><dd>${esc(voice)}</dd></div></dl><button type="button" class="button primary setup-enter" data-action="setup.finish">进入直播间${icon('arrow')}</button><p class="setup-description">OBS 可以稍后在设置里连接。</p>${errorSlot()}`;
}

function updateQr() {
  for (const retry of document.querySelectorAll('[data-action="qr.retry"]')) retry.disabled = !!snapshot?.network_disabled || qrBusy;
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
      if (needsRoom) frame.innerHTML = ui`<div class="qr-placeholder">${icon('check')}<span>账号已登录<br>请先开通直播间</span></div>`;
      else if (qrFailure) frame.innerHTML = ui`<div class="qr-placeholder">${icon('qr')}<span>暂时无法生成二维码<br>请稍后重新尝试</span></div>`;
      else if (qr.status === 'expired') frame.innerHTML = ui`<div class="qr-placeholder">${icon('refresh')}<span>二维码已过期<br>重新生成后再扫码</span></div>`;
      else if (qr.status === 'complete') frame.innerHTML = ui`<div class="qr-placeholder">${icon('check')}<span>已完成登录</span></div>`;
      else if (url) { const image = document.createElement('img'); image.src = url; image.alt = container.dataset.qrProvider === 'bilibili' ? t('哔哩哔哩登录二维码') : t('豆包登录二维码'); frame.replaceChildren(image); }
      else frame.innerHTML = '<div class="qr-placeholder"><span class="spinner" aria-hidden="true"></span></div>';
    }
    container.querySelector('[data-qr-label]').textContent = needsRoom ? t('未找到本账号直播间，请先在 B站开通直播间后重新扫码') : qrFailure || qrLabel(qr);
    container.querySelector('.status-dot').className = `status-dot ${qrFailure ? '' : qr.status === 'waiting' || qr.status === 'idle' ? 'pulse' : 'online'}`;
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
    await command(`${provider === 'bilibili' ? 'bili' : 'doubao'}.qr.begin`, connectionId ? { connection_id: connectionId } : {}, { silent: true });
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
          editor = provider === 'doubao' && editor.returnTo === 'voice-add' ? { type: 'voice-add', provider: 'doubao', connectionId: serviceConnection('doubao')?.id } : null;
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

// The byline keeps the signed-in user's identity, independently of the live title.
function mastheadView(snapshot) {
  const identity = headerIdentity(snapshot);
  const room = snapshot.live?.room_id || snapshot.setup?.room_id;
  if (identity.loggedIn) return { name: identity.name, suffix: t('的直播间') };
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
  const bindings = snapshot.bindings || [];
  const byUid = validUid(event?.user_id) && bindings.find(entry => entry.binding.user_id && String(entry.binding.user_id) === String(event.user_id));
  return byUid || bindings.find(entry => !entry.binding.user_id && entry.binding.user_name && entry.binding.user_name === event?.user_name);
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
  const service = preferred ? providerLabel(preferred.provider) : '';
  const signature = `${title}\u0000${service}`;
  if (switcher.dataset.label !== signature) {
    switcher.dataset.label = signature;
    switcher.innerHTML = `<span class="lake-voice-name">${esc(title)}</span><em class="lake-voice-service">${esc(service)}</em><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14l5-5 5 5"></path></svg>`;
    switcher.setAttribute('aria-label', `${t('播报声音')}${t('：')}${title} · ${service}`);
  }
  updateVolumeControls();
}

const lakeVolumeIcon = muted => muted ? icon('muted') : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l5 4V6L7 10H4z"></path><path d="M16 9.5a3.5 3.5 0 0 1 0 5"></path></svg>';

function lakeVoiceReady(preset) {
  const connection = snapshot.connections?.find(item => item.id === preset.connection_id);
  return ['dots', 'gpt_sovits'].includes(preset.provider)
    ? localServiceState(preset.provider, connection).state === 'ready' : !!connection?.has_credential;
}

function lakeVoiceWave(active = false, asleep = false) {
  return `<span class="lake-voice-wave${active ? ' active' : ''}${asleep ? ' asleep' : ''}" aria-hidden="true"><svg viewBox="0 0 24 16"><path class="wave-flat" d="M2 8h20"></path><path class="wave-curve" d="M2 8c2-5 4-5 6 0s4 5 6 0 4-5 8 0"></path></svg><span class="lake-voice-bars"><i></i><i></i><i></i><i></i></span></span>`;
}

async function voicePanelAuditionText(preset) {
  if (voiceAuditionDraft.customText && voiceAuditionDraft.text) return voiceAuditionDraft.text;
  if (getLanguage() !== 'en' || preset.provider !== 'gpt_sovits') return t('你好，欢迎来到直播间。');
  // A saved reference can override the preset's text language, just as in playback.rs.
  let language = preset.sovits?.text_language || 'all_zh';
  const role = referenceRole(preset.provider, preset);
  if (role?.gpt_weights_path && role?.sovits_weights_path) {
    const listed = await command('references.list', { connection_id: preset.connection_id }, { quiet: true, silent: true });
    const profile = listed.result?.find(entry => entry.profile?.role?.kind === role.kind
      && String(entry.profile.role.gpt_weights_path).toLowerCase() === String(role.gpt_weights_path).toLowerCase()
      && String(entry.profile.role.sovits_weights_path).toLowerCase() === String(role.sovits_weights_path).toLowerCase())?.profile;
    if (profile) language = profile.text_language;
  }
  return ['auto', 'en'].includes(language) ? t('你好，欢迎来到直播间。') : '你好，欢迎来到直播间。';
}

function renderVoicePanel() {
  const panel = document.querySelector('#tts-menu');
  if (!panel) return;
  const preferred = snapshot.presets?.find(item => item.id === snapshot.rules?.default_preset_id);
  const enabled = !!(snapshot.setup?.tts_enabled ?? snapshot.preferences?.tts_enabled);
  const rows = (snapshot.presets || []).map(preset => {
    const on = preset.id === preferred?.id;
    const ready = lakeVoiceReady(preset);
    const local = ['dots', 'gpt_sovits'].includes(preset.provider);
    const waking = lakeWake?.id === preset.id;
    const action = !ready && local ? 'lake.voice.wake' : 'voice.pick';
    return `<div class="lake-voice-row${on ? ' on' : ''}${!ready ? ' sleeping' : ''}${waking ? ' waking' : ''}"><button type="button" class="lake-voice-select" data-action="${action}" data-id="${esc(preset.id)}" aria-pressed="${on}"${waking ? ' disabled' : ''}>${lakeVoiceWave(on && ready || waking, !ready && !waking)}<span class="lake-voice-copy"><b>${esc(presetLabel(preset))}</b></span><small class="lake-voice-provider">${esc(providerLabel(preset.provider))}</small>${!ready && local ? '<em class="lake-wake-label">tap to wake</em>' : ''}</button>${ready ? `<button type="button" class="lake-voice-preview" data-action="voice.audition" data-id="${esc(preset.id)}" aria-label="${esc(t('试听'))} ${esc(presetLabel(preset))}">▷</button>` : ''}</div>`;
  }).join('') || `<div class="lake-voice-empty"><p>${esc(t('还没有声音'))}</p></div>`;
  patchMarkup(panel, `<div class="lake-voice-head"><span class="panel-kicker">NOW READING</span><button type="button" id="speech-switch" class="lake-speech-switch${enabled ? ' on' : ''}" role="switch" data-action="speech.toggle" aria-label="${esc(t('播报'))}" aria-checked="${enabled}"><span>${esc(t('播报'))}</span><span class="lake-switch-track"></span></button></div><div class="lake-voice-list">${rows}</div><div class="lake-voice-foot"><button type="button" class="lake-voice-manage" data-action="lake.voices">${esc(t('管理声音'))} ›</button><button type="button" class="lake-voice-add" data-action="lake.voices.add">${icon('plus')}${esc(t('添加声音'))}</button></div>`);
}

function closeVoicePanel() {
  const panel = document.querySelector('#tts-menu');
  document.querySelector('#tts-switch')?.setAttribute('aria-expanded', 'false');
  leaveThenHide(panel, 180, updateLakePopScrim);
}

function pendingLiveJobs() {
  return (snapshot.queue?.pending || []).filter(job => job.origin !== 'audition');
}

function queueJobEvent(job) {
  const event = job.origin === 'live' && job.event;
  return event && typeof event === 'object' && !Array.isArray(event) && typeof event.kind === 'string' && typeof event.message === 'string' ? event : null;
}

function renderQueuePanel(events) {
  const panel = document.querySelector('#queue-panel');
  if (!panel) return;
  const pending = pendingLiveJobs();
  const signature = JSON.stringify(pending.slice(0, 8).map(job => [job.id, job.user_name, job.text, queueJobEvent(job) ? messageParts(job.event) : null]).concat([pending.length, getLanguage()]));
  if (queueSignature === signature) return;
  queueSignature = signature;
  panel.innerHTML = pending.slice(0, 8).map((job, index) => {
    const name = job.user_name || t('访客');
    const text = jobDisplayText(job, events);
    const body = queueJobEvent(job) ? renderChatBody(job.event) : esc(text);
    return `<button type="button" class="queue-item" role="listitem" data-action="queue.jump" data-id="${esc(job.id)}" aria-label="${esc(`${t('立即播报')}${t('：')}${name}${t('：')}${text}`)}" title="${esc(t('立即播报'))}" style="--queue-opacity:${Math.max(0.55, 1 - index * 0.1).toFixed(2)}"><span class="queue-index">${index + 1}</span><span class="queue-text"><span class="queue-name">${esc(name)}</span><span class="queue-line">${body}</span></span><span class="queue-play" aria-hidden="true">${icon('play')}</span></button>`;
  }).join('') + (pending.length > 8 ? `<p class="queue-more">+${pending.length - 8} ${esc(t('条'))}</p>` : '');
}

function viewerChipsHtml(event) {
  const record = viewerBinding(event);
  const bound = record?.binding?.enabled ? record.binding.preset_id : '';
  const canBind = validUid(event.user_id) || !!String(event.user_name || '').trim();
  return `<button type="button" class="voice-chip${bound ? '' : ' on'}" data-action="viewer.bind" data-id="" aria-pressed="${!bound}"${canBind ? '' : ' disabled'}>${lakeVoiceWave(!bound)}<span>${esc(t('跟随默认'))}</span></button>`
    + (snapshot.presets || []).map(preset => `<button type="button" class="voice-chip${bound === preset.id ? ' on' : ''}" data-action="viewer.bind" data-id="${esc(preset.id)}" aria-pressed="${bound === preset.id}"${canBind ? '' : ' disabled'}>${lakeVoiceWave(bound === preset.id, !lakeVoiceReady(preset))}<span>${esc(presetLabel(preset))}</span><small>${esc(providerLabel(preset.provider))}</small></button>`).join('');
}

function updateViewerVoices(event) {
  const host = document.querySelector('#viewer-voices');
  if (!host || !event) return;
  const body = host.closest('.viewer-body');
  const scrollTop = body?.scrollTop || 0;
  const active = host.contains(document.activeElement) ? document.activeElement.closest('[data-action="viewer.bind"]')?.dataset.id : undefined;
  patchMarkup(host, viewerChipsHtml(event));
  if (body) body.scrollTop = scrollTop;
  if (active !== undefined) [...host.querySelectorAll('[data-action="viewer.bind"]')].find(button => button.dataset.id === active && !button.disabled)?.focus({ preventScroll: true });
}

async function loadViewerSaid(event, retry = false) {
  const archive = currentLakeHistory();
  if (!archive || !event) return;
  const identity = viewerIdentity(event);
  const previous = archive.viewers.get(identity);
  const total = Math.max(snapshot.live_history.messages, archive.stats.messages);
  const revision = Math.max(Number(snapshot.live_history.metadata_revision || 0), Number(archive.stats.metadata_revision || 0));
  if (previous?.busy || !retry && previous && (previous.total >= total && previous.revision >= revision || previous.error)) return;
  const query = { ...previous, busy: true, total, revision, error: '' };
  archive.viewers.set(identity, query);
  try {
    const page = await requestLakeHistory(archive, { limit: 3, viewer: identity });
    if (archive !== currentLakeHistory()) return;
    Object.assign(query, { items: page.items.map(item => item.event), count: page.viewer_messages, total: page.messages, revision: Number(page.metadata_revision || 0) });
  } catch (error) { query.error = errorMessage(error); }
  finally {
    query.busy = false;
    if (archive === currentLakeHistory() && viewerIdentity(viewerContext) === identity) updateViewerSaid(viewerContext);
  }
}

function viewerSaidMarkup(event) {
  const archive = currentLakeHistory();
  const cached = archive?.viewers.get(viewerIdentity(event));
  if (archive) void loadViewerSaid(event);
  const all = normalizedEvents(snapshot).filter(item => viewerIdentity(item) === viewerIdentity(event) && ['danmaku', 'super_chat'].includes(item.kind) && eventText(item));
  const recent = cached?.items || all.slice(-3).reverse();
  const lines = recent.length ? recent.map(item => `<p><span>${renderChatBody(item)}</span><time>${esc(clockLabel(item.observed_at_ms))}</time></p>`).join('') : `<p>${esc(t('今晚还没说过话'))}</p>`;
  const error = cached?.error ? `<p class="lake-history-error">${esc(cached.error)} <button type="button" data-action="lake.viewer.history.retry">${esc(t('重试'))}</button></p>` : '';
  return { count: archive ? cached?.count ?? (cached?.error ? '—' : '…') : all.length, html: lines + error };
}

function updateViewerSaid(event) {
  const host = document.querySelector('#viewer-drawer .viewer-said');
  if (!host || !event) return;
  const said = viewerSaidMarkup(event);
  patchMarkup(host, said.html);
  const count = document.querySelector('#viewer-drawer .viewer-uid');
  if (count && count.textContent !== `said ${said.count} tonight`) count.textContent = `said ${said.count} tonight`;
}

function renderViewerDrawer() {
  const layer = document.querySelector('#viewer-drawer');
  if (!layer) return;
  const event = viewerContext;
  if (!event) {
    const returnFocus = layer.viewerReturnFocus;
    layer.viewerReturnFocus = null;
    leaveThenHide(layer, 280, () => { if (!viewerContext) layer.innerHTML = ''; });
    if (returnFocus) requestAnimationFrame(() => {
      const usable = returnFocus.isConnected && !returnFocus.disabled && returnFocus.getClientRects().length && !returnFocus.closest('[hidden], dialog:not([open])');
      (usable ? returnFocus : document.querySelector('#tts-switch'))?.focus({ preventScroll: true });
    });
    return;
  }
  cancelLeave(layer);
  if (layer.hidden) layer.viewerReturnFocus = document.activeElement;
  const alias = viewerAliasValue(event);
  const voiceMarkup = viewerChipsHtml(event);
  const mentionDisabled = !snapshot.account?.user_id || snapshot.network_disabled || !String(event.user_name || '').trim();
  const saidView = viewerSaidMarkup(event);
  const said = `<section class="viewer-section viewer-said" aria-label="${esc(t('收到的弹幕'))}">${saidView.html}</section>`;
  layer.innerHTML = `<button type="button" class="viewer-scrim" data-action="viewer.close" aria-label="${esc(t('关闭观众卡片'))}"></button><aside class="viewer-sheet" role="dialog" aria-modal="true" aria-label="${esc(t('观众设置'))}"><header class="viewer-head">${viewerAvatar(event, true)}<div class="viewer-name"${validUid(event.user_id) ? ` title="UID ${esc(event.user_id)}"` : ''}>${esc(event.user_name || t('访客'))}</div><span class="viewer-uid">said ${saidView.count} tonight</span><div class="viewer-quick"><button type="button" class="viewer-quick-button" data-action="viewer.at"${mentionDisabled ? ' disabled' : ''}>${esc(t('@ TA'))}</button></div></header><div class="viewer-body">${said}<section class="viewer-section viewer-voice-settings"><label class="viewer-alias-field" for="viewer-alias"><span>${esc(t('读作'))}</span><input id="viewer-alias" class="viewer-alias" maxlength="40" autocomplete="off" placeholder="${esc(event.user_name || t('访客'))}" value="${esc(alias)}"${String(event.user_name || '').trim() ? '' : ' disabled'}><button type="button" class="viewer-alias-preview" data-action="viewer.audition" aria-label="${esc(t('试听称呼'))}">▷</button></label><span class="viewer-settings-label">${esc(t('TA 的声音'))}</span><div id="viewer-voices" class="voice-chips" role="group" aria-label="${esc(t('观众声音'))}">${voiceMarkup}</div></section><section id="viewer-moderation" class="viewer-section"></section></div></aside>`;
  markupCache.set(layer.querySelector('#viewer-voices'), voiceMarkup);
  markupCache.set(layer.querySelector('.viewer-said'), saidView.html);
  layer.hidden = false;
  updateViewerModeration();
  if (currentLakeHistory()) void loadViewerSaid(event);
  layer.querySelector('.viewer-sheet').addEventListener('keydown', key => {
    if (key.key !== 'Tab') return;
    const controls = [...layer.querySelectorAll('.viewer-sheet button:enabled, .viewer-sheet input:enabled, .viewer-sheet [tabindex="0"]')].filter(node => node.getClientRects().length && (node.type !== 'radio' || node.checked));
    const first = controls[0];
    const last = controls.at(-1);
    if (key.shiftKey && document.activeElement === first) { key.preventDefault(); last?.focus(); }
    else if (!key.shiftKey && document.activeElement === last) { key.preventDefault(); first?.focus(); }
  });
  requestAnimationFrame(() => {
    const sheet = layer.querySelector('.viewer-sheet');
    if (sheet) { sheet.tabIndex = -1; sheet.focus({ preventScroll: true }); }
  });
}

function viewerModerationTarget() {
  const event = viewerContext;
  return event && !event.mystery && validUid(event.user_id) ? String(event.user_id) : '';
}

function updateViewerModeration() {
  const host = document.querySelector('#viewer-moderation');
  if (!host || !viewerContext) return;
  host.hidden = !broadcastEnabled(); if (host.hidden) return;
  const target = viewerModerationTarget();
  const account = snapshot.account?.user_id;
  const view = snapshot.moderation || {};
  const matching = target && String(view.user_id) === target;
  const ready = matching && !!account && viewerModerationAccount === String(account) && String(account) !== target && !view.busy && !viewerModerationBusy && !snapshot.network_disabled;
  const self = target && String(account) === target;
  const note = !target ? t('该用户没有公开 UID，无法管理。') : !account ? t('扫码登录后可管理直播间用户') : self ? t('不能禁言或拉黑自己') : snapshot.network_disabled ? t('离线测试窗口不可管理直播间') : matching && view.message ? localizeDiagnostic(view.message) : matching && view.busy ? t('正在读取管理权限…') : t('仅主播或获授权的房管可操作');
  const mute = ready && view.can_moderate && typeof view.muted === 'boolean';
  const blacklist = ready && view.can_blacklist && typeof view.blacklisted === 'boolean';
  const admin = ready && view.can_manage_admins && typeof view.is_admin === 'boolean';
  const muted = !!(matching && view.muted); const blocked = !!(matching && view.blacklisted); const appointed = !!(matching && view.is_admin);
  const blockArmed = !blocked && host.dataset.blockArmed === target && host.dataset.blockArmAccount === String(account);
  const permissionVisible = !ready || !(view.can_moderate || view.can_blacklist || view.can_manage_admins);
  patchMarkup(host, `<span class="viewer-settings-label">${esc(t('直播间管理'))}</span><div class="viewer-room-controls"><p class="viewer-hint viewer-permissions" role="status"${permissionVisible ? '' : ' hidden'}>${esc(note)}</p><div class="viewer-moderation-row"><span class="viewer-control-copy"><strong>${esc(t('禁言'))}</strong>${muted ? `<small>${esc(t('已禁言'))}</small>` : ''}</span>${muted ? `<button type="button" class="viewer-line-button" data-action="viewer.moderation.unmute"${mute ? '' : ' disabled'}>${esc(t('解除'))}</button>` : `<span class="lake-mute-durations">${[[10, '10 分钟'], [60, '1 小时'], [1440, '1 天']].map(([minutes, label]) => `<button type="button" data-action="lake.viewer.mute" data-id="${minutes}"${minutes === 10 ? ` disabled title="${esc(t('B站目前只能按小时禁言'))}"` : mute ? '' : ' disabled'}>${esc(t(label))}</button>`).join('')}</span>`}</div><div class="viewer-moderation-row viewer-block-row"><span class="viewer-control-copy"><strong>${esc(t('直播间拉黑'))}</strong><small>${esc(t(blocked ? '已在直播间黑名单' : blockArmed ? '再点一次确认' : '不能再进入你的直播间'))}</small></span><button type="button" class="viewer-line-button${blocked ? '' : ' risk'}${blockArmed ? ' armed' : ''}" data-action="${blocked ? 'viewer.moderation.unblacklist' : 'viewer.moderation.blacklist'}"${blacklist ? '' : ' disabled'}>${esc(t(blocked ? '解除' : blockArmed ? '确认拉黑' : '拉黑'))}</button></div><div class="viewer-moderation-row viewer-admin-row"><span class="viewer-control-copy"><strong>${esc(t('房管'))}</strong><small>${esc(t(appointed ? '可以帮你禁言' : '让 TA 帮你管理弹幕'))}</small></span><button type="button" class="viewer-admin-switch${appointed ? ' on' : ''}" data-action="${appointed ? 'viewer.moderation.dismiss' : 'viewer.moderation.appoint'}" role="switch" aria-checked="${appointed}" aria-label="${esc(t(appointed ? '撤销房管' : '设为房管'))}"${admin ? '' : ' disabled'}><span class="viewer-switch-track"></span></button></div></div>`);
}

async function refreshViewerModeration() {
  const user_id = viewerModerationTarget();
  if (!broadcastEnabled() || !user_id || !snapshot.account?.user_id || snapshot.network_disabled || viewerModerationBusy || String(snapshot.account.user_id) === user_id) return;
  viewerModerationBusy = true;
  const account = String(snapshot.account.user_id);
  viewerModerationAccount = account;
  updateViewerModeration();
  try { await command('bili.moderation.refresh', { user_id }, { quiet: true, silent: true, accept: moderationResponseGuard() }); }
  finally {
    viewerModerationBusy = false;
    updateViewerModeration();
    if (viewerModerationTarget() && (viewerModerationTarget() !== user_id || String(snapshot.account?.user_id || '') !== account)) void refreshViewerModeration().catch(() => updateViewerModeration());
  }
}

async function moderateViewer(action, minutes = 60) {
  const user_id = viewerModerationTarget();
  const view = snapshot.moderation;
  if (!broadcastEnabled() || !user_id || !snapshot.account?.user_id || viewerModerationAccount !== String(snapshot.account.user_id) || snapshot.network_disabled || viewerModerationBusy || String(snapshot.account.user_id) === user_id || String(view?.user_id) !== user_id || view.busy) return;
  const payload = { user_id, room_id: view.room_id, confirmed: true };
  const account = String(snapshot.account.user_id);
  const viewerName = viewerContext.user_name || t('访客');
  if ((action === 'mute' || action === 'unmute') && (!view.can_moderate || typeof view.muted !== 'boolean')) return;
  if ((action === 'appoint' || action === 'dismiss') && (!view.can_manage_admins || typeof view.is_admin !== 'boolean')) return;
  if ((action === 'blacklist' || action === 'unblacklist') && (!view.can_blacklist || typeof view.blacklisted !== 'boolean')) return;
  const host = document.querySelector('#viewer-moderation');
  if (action === 'blacklist' && !view.blacklisted && host) {
    if (host.dataset.blockArmed !== user_id || host.dataset.blockArmAccount !== account) {
      host.dataset.blockArmed = user_id;
      host.dataset.blockArmAccount = account;
      updateViewerModeration();
      host.querySelector('[data-action="viewer.moderation.blacklist"]')?.focus({ preventScroll: true });
      return;
    }
    delete host.dataset.blockArmed;
    delete host.dataset.blockArmAccount;
  }
  if (action === 'mute') {
    if (![60, 1440].includes(minutes)) return;
    payload.hours = minutes / 60;
  }
  viewerModerationBusy = true;
  updateViewerModeration();
  let applied = false;
  try { applied = !!await command(`bili.moderation.${action}`, payload, { quiet: true, accept: moderationResponseGuard() }); }
  finally {
    viewerModerationBusy = false;
    updateViewerModeration();
    if (viewerModerationTarget() && (viewerModerationTarget() !== user_id || String(snapshot.account?.user_id || '') !== account)) void refreshViewerModeration().catch(() => updateViewerModeration());
  }
  if (applied && broadcastEnabled() && viewerModerationTarget() === user_id && String(snapshot.account?.user_id || '') === account && String(snapshot.moderation?.room_id || '') === String(payload.room_id)) {
    if (action === 'mute') {
      const duration = t(minutes === 10 ? '10 分钟' : minutes === 60 ? '1 小时' : '1 天');
      showToast(ui`已禁言 ${viewerName} · ${duration}`, false, () => undoLakeMute({ account, user_id, room_id: payload.room_id }));
    } else if (action === 'appoint') showToast(ui`已任命 ${viewerName} 为房管`);
    else showToast(t({ unmute: '已解除禁言', blacklist: '已加入直播间黑名单', unblacklist: '已解除直播间拉黑', dismiss: '已撤销房管' }[action]));
  }
}

async function undoLakeMute(context) {
  const sameRoom = next => broadcastEnabled() && !snapshot.network_disabled && String(snapshot.account?.user_id || '') === context.account && String(snapshot.broadcast?.room?.room_id || '') === String(context.room_id) && next?.preferences?.broadcast_console && String(next.account?.user_id || '') === context.account && String(next.moderation?.user_id || '') === context.user_id && String(next.moderation?.room_id || '') === String(context.room_id);
  if (!broadcastEnabled() || snapshot.network_disabled || viewerModerationBusy || String(snapshot.account?.user_id || '') !== context.account || String(snapshot.broadcast?.room?.room_id || '') !== String(context.room_id)) return;
  viewerModerationBusy = true;
  updateViewerModeration();
  try {
    const refreshed = await command('bili.moderation.refresh', { user_id: context.user_id }, { quiet: true, accept: sameRoom });
    if (!refreshed || !refreshed.moderation?.can_moderate || refreshed.moderation.muted !== true) return;
    const restored = await command('bili.moderation.unmute', { user_id: context.user_id, room_id: context.room_id, confirmed: true }, { quiet: true, accept: sameRoom });
    if (restored) showToast(t('已解除禁言'));
  } finally {
    viewerModerationBusy = false; updateViewerModeration();
    if (viewerContext && viewerModerationTarget() !== context.user_id) void refreshViewerModeration().catch(() => updateViewerModeration());
  }
}

function moderationResponseGuard() {
  const account = String(snapshot.account?.user_id || '');
  const roomOf = view => String(view.live?.room_id || view.setup?.room_id || '');
  const room = roomOf(snapshot);
  return next => broadcastEnabled() && next?.preferences?.broadcast_console
    && String(snapshot.account?.user_id || '') === account && String(next.account?.user_id || '') === account
    && roomOf(snapshot) === room && roomOf(next) === room;
}

async function closeViewerDrawer() {
  if (!viewerContext) return;
  await flushViewerAlias();
  viewerContext = null;
  viewerOpenIdentity = '';
  renderViewerDrawer();
  feedSignature = '';
  if (step === 'main') { liveRenderSignature = ''; updateLive(); }
  if (audienceReturn) { audienceReturn = false; openAudience(); }
}

// The byline follows the room's broadcast status, separately from reception.
// Its displayed rank count excludes our account only when its UID is in the list.
function audienceView() {
  const live = snapshot.live || {};
  const audience = live.audience || {};
  const active = !!(audience.active && live.running && !snapshot.network_disabled);
  const count = audienceDisplayCount(snapshot);
  return { audience, active, count };
}

function updateAudience() {
  const control = document.querySelector('#audience-count');
  if (!control) return;
  const { audience, active, count } = audienceView();
  control.hidden = !active || count === '0';
  const faces = active ? audienceUsers(snapshot).filter(user => !user.mystery).slice(0, 3) : [];
  const pending = active && count == null && !!audience.loading && !faces.length;
  const facesMarkup = pending ? '<span class="audience-face ghost"></span>'.repeat(3) : faces.map(user => `<span class="audience-face">${viewerAvatar(user)}</span>`).join('');
  const markup = `${facesMarkup ? `<span class="audience-faces${pending ? ' pending' : ''}" aria-hidden="true">${facesMarkup}</span>` : ''}<span class="audience-now"><b>${esc(count ?? '—')}</b>${esc(t('人在看'))}</span>`;
  patchMarkup(control, markup);
  const label = `${count ?? '—'} ${t('人在看')}`;
  if (control.getAttribute('aria-label') !== label) control.setAttribute('aria-label', label);
  control.title = t('查看在看的观众');
  const dialog = document.querySelector('#audience-dialog');
  if (dialog?.open) { renderAudience(); placeAudience(); }
}

function placeAudience() {
  const dialog = document.querySelector('#audience-dialog');
  const anchor = document.querySelector('#audience-count');
  if (!dialog || !anchor || anchor.hidden) return;
  dialog.style.setProperty('--audience-top', `${Math.min(190, Math.max(52, window.innerHeight - 200))}px`);
  dialog.style.setProperty('--audience-left', `${Math.max(12, Math.min(92, window.innerWidth - 362))}px`);
}

function openAudience(pinned = true) {
  const dialog = document.querySelector('#audience-dialog');
  if (!dialog) return;
  closeVoicePanel(); closeQueuePanel();
  clearTimeout(audienceCloseTimer); clearTimeout(audienceFinishTimer); audienceFinishTimer = null;
  dialog.classList.remove('closing');
  audienceSignature = '';
  renderAudience();
  placeAudience();
  audiencePinned = pinned;
  if (!dialog.open) {
    const focus = document.activeElement;
    dialog.show();
    if (!pinned) focus?.focus({ preventScroll: true });
  }
  document.querySelector('#audience-count')?.setAttribute('aria-expanded', 'true');
  updateLakePopScrim();
  maybeLoadMoreAudience();
}

function closeAudience(restoreFocus = true) {
  audienceReturn = false;
  audiencePinned = false;
  const dialog = document.querySelector('#audience-dialog');
  if (!dialog?.open) return;
  document.querySelector('#audience-count')?.setAttribute('aria-expanded', 'false');
  clearTimeout(audienceCloseTimer);
  if (dialog.classList.contains('closing')) return;
  const finish = () => { audienceFinishTimer = null; dialog.classList.remove('closing'); if (dialog.open) dialog.close(); updateLakePopScrim(); };
  if (!motionAllowed()) finish();
  else { dialog.classList.add('closing'); audienceFinishTimer = setTimeout(finish, 190); }
  if (restoreFocus) document.querySelector('#audience-count')?.focus();
}

function audienceRow(user, index) {
  const key = `rank:${index}`;
  audienceEntries.set(key, user);
  const rank = Number(user.rank);
  const podium = rank >= 1 && rank <= 3 ? ` podium-${rank}` : '';
  const guard = [null, t('总督'), t('提督'), t('舰长')][user.guard_level];
  const tag = guard || user.medal_name || '';
  const details = [validUid(user.user_id) ? `UID ${user.user_id}` : '', guard,
    user.medal_name ? `${user.medal_name}${user.medal_level ? ` ${user.medal_level}` : ''}` : '',
    user.score != null && String(user.score) !== '0' ? `${t('贡献值')} ${user.score}` : '',
  ].filter(Boolean).join(' · ');
  return `<button type="button" class="audience-user${podium}${user.mystery ? ' mystery' : ''}" data-action="audience.viewer" data-id="${key}"${details ? ` title="${esc(details)}"` : ''}${user.mystery ? ' disabled' : ''}><span class="audience-rank">${esc(user.rank ?? '')}</span>${viewerAvatar(user)}<span class="audience-user-name">${esc(user.user_name || t('访客'))}</span>${tag ? `<span class="audience-tag">${esc(tag)}</span>` : ''}</button>`;
}

function renderAudience() {
  const dialog = document.querySelector('#audience-dialog');
  if (!dialog) return;
  if (!dialog.querySelector('#audience-search')) {
    dialog.innerHTML = `<header class="audience-head"><h2 id="audience-title" class="sr-only">${esc(t('在看的观众'))}</h2><span class="audience-kicker" aria-hidden="true">WATCHING NOW <span id="audience-clock"></span></span><p class="audience-total"><strong id="audience-total"></strong><span>${esc(t('人在看'))}</span></p></header><input id="audience-search" type="search" maxlength="100" autocomplete="off" spellcheck="false" aria-label="${esc(t('搜索用户名或 UID'))}" hidden><p id="audience-status" class="audience-status" role="status"></p><div id="audience-scroll" class="audience-scroll"><div id="audience-list" class="audience-list" role="list" aria-labelledby="audience-title"></div></div><div id="audience-tail" class="audience-tail"></div>`;
    dialog.querySelector('#audience-search').value = audienceQuery;
    dialog.querySelector('#audience-search').addEventListener('input', event => { audienceQuery = event.target.value; audienceSignature = ''; renderAudience(); });
    dialog.querySelector('#audience-scroll').addEventListener('scroll', () => maybeLoadMoreAudience(), { passive: true });
  }
  const { audience, active, count } = audienceView();
  const users = audienceUsers(snapshot, audienceQuery);
  const signature = JSON.stringify([audience, active, count, audienceQuery, users, getLanguage()]);
  if (signature === audienceSignature) return;
  audienceSignature = signature;
  dialog.dataset.state = !active || audience.live_status !== 1 ? 'off' : audience.error ? 'error' : 'live';
  dialog.querySelector('#audience-total').textContent = count ?? '—';
  dialog.querySelector('#audience-clock').textContent = active && audience.updated_at_ms ? `· ${clockLabel(audience.updated_at_ms)}` : '';
  const status = dialog.querySelector('#audience-status');
  const note = !active ? t('请先连接直播间') : audience.error ? `${t('观众数据获取失败')}${audience.updated_at_ms ? ` · ${t('显示上次获取的名单')}` : ''} · ${localizeDiagnostic(audience.error)}` : audience.live_status === 0 ? t('未开播') : audience.live_status === 2 ? t('轮播中') : audience.live_status !== 1 ? t('正在获取直播状态…') : '';
  status.textContent = note;
  status.hidden = !note;
  const list = dialog.querySelector('#audience-list');
  list.setAttribute('aria-busy', String(!!audience.loading));
  audienceEntries.clear();
  const searching = !!audienceQuery.trim();
  const markup = users.map(audienceRow).join('') || `<p class="audience-empty">${esc(searching ? t('没有匹配的用户') : audience.loading ? t('正在获取观众数据…') : active ? t('暂时没有公开的在线观众') : t('请先连接直播间'))}</p>`;
  const scroll = dialog.querySelector('#audience-scroll');
  const position = scroll.scrollTop;
  patchMarkup(list, markup);
  scroll.scrollTop = position;
  const tail = !searching && active && audience.has_more ? `<span class="audience-loader${audience.loading ? ' busy' : ''}" aria-hidden="true"><i></i><i></i><i></i></span>` : `<small>${esc(audience.limit_reached ? t('仅显示前 1000 位') : t('B站只公开部分在线观众'))}</small>`;
  patchMarkup(dialog.querySelector('#audience-tail'), tail);
  if ((audience.page || 0) <= 1 && (audience.users || []).length < audienceMoreAt) audienceMoreAt = 0;
  maybeLoadMoreAudience();
}

// Later pages arrive as the list nears its end; there is no button to press.
function maybeLoadMoreAudience() {
  const scroll = document.querySelector('#audience-scroll');
  const { audience, active } = audienceView();
  const loaded = (audience.users || []).length;
  if (!scroll || !scroll.clientHeight || !document.querySelector('#audience-dialog')?.open || !active || audience.loading || !audience.has_more || audienceQuery.trim() || loaded <= audienceMoreAt) return;
  if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 180) return;
  audienceMoreAt = loaded;
  void command('live.audience.more', {}, { quiet: true }).catch(() => { audienceMoreAt = 0; });
}

function scheduleViewerAlias(value) {
  const event = viewerContext;
  if (!event) return;
  const spoken = document.querySelector('#viewer-spoken');
  if (spoken) spoken.textContent = value.trim() || event.user_name || t('访客');
  const name = String(event.user_name || '');
  if (!name) return;
  viewerAliasDrafts.set(name, value.trim());
  viewerAliasSave.schedule([...viewerAliasDrafts]);
}

function viewerAliasValue(event) {
  const name = String(event?.user_name || '');
  return viewerAliasDrafts.has(name) ? viewerAliasDrafts.get(name) : viewerAlias(event);
}

// A failed save must not trap the viewer card or settings. Its error is shown;
// the draft stays in the card and is written again by the next flush.
async function flushViewerAlias() {
  if (viewerAliasSave.error) viewerAliasSave.retry();
  try { await viewerAliasSave.flush(); return true; }
  catch { return false; }
}

// Chips for one viewer save in order: a choice made while the first binding is
// still being created must update that binding instead of creating another.
const viewerBindings = new Map();
function bindViewerVoice(presetId) {
  const event = viewerContext;
  if (!event) return;
  const identity = viewerIdentity(event);
  const saved = (viewerBindings.get(identity) || Promise.resolve()).then(() => saveViewerVoice(event, presetId));
  const settled = saved.catch(() => {});
  viewerBindings.set(identity, settled);
  void settled.then(() => { if (viewerBindings.get(identity) === settled) viewerBindings.delete(identity); });
  return saved;
}

async function saveViewerVoice(event, presetId) {
  const hasUid = validUid(event.user_id);
  if (!hasUid && !String(event.user_name || '').trim()) throw new Error(t('这条弹幕没有可用用户名或 UID，无法指定声音。'));
  const record = viewerBinding(event);
  if (!presetId) {
    if (record) await command('bindings.delete', { id: record.id, confirmed: true }, { quiet: true });
  } else {
    await command('bindings.save', { id: record?.id || '', binding: { platform: 'bilibili', user_id: hasUid ? numericId(event.user_id) : null, user_name: hasUid ? null : event.user_name, legacy_user_name: record?.binding.legacy_user_name || null, preset_id: presetId, enabled: true } }, { quiet: true });
  }
  updateViewerVoices(viewerContext);
}

function updateLive() {
  // The lake remains live beneath the translucent settings drawer.
  const scroll = document.querySelector('#chat-scroll');
  if (!scroll || !snapshot) return;
  updateChatCompose();
  updateOnAir();
  updateAudience();
  updateThemeControl();
  updateLakeClock();
  void settleLakeWake().catch(showError);
  syncLakeReadingProgress();
  const notice = updateFallbackStatus(snapshot.queue || {});
  const renderSignature = JSON.stringify([snapshot.live, snapshot.live_history, snapshot.queue, snapshot.setup, snapshot.account, snapshot.broadcast, snapshot.preferences?.broadcast_console, snapshot.bindings, snapshot.rules?.user_words, snapshot.preferences?.tts_enabled, snapshot.preferences?.master_volume, snapshot.preferences?.muted, volumeDraft, snapshot.rules?.default_preset_id, snapshot.presets, snapshot.connections, snapshot.local_services, snapshot.status, notice, viewerOpenIdentity, lakeObsTitle()]);
  if (viewerContext) updateViewerModeration();
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
  const ownRoom = broadcastEnabled() && snapshot.broadcast?.room;
  const lakeTitle = document.querySelector('#lake-title');
  if (lakeTitle) { lakeTitle.disabled = !ownRoom; lakeTitle.title = ownRoom ? t('修改直播标题和分区') : masthead.name; }
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
  renderLakeHistory(events, keys);
  renderLakeTranscript(events, keys);
  // Transcript resolves the ended-session state used by this control.
  updateOnAir();
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
    updateViewerSaid(viewerContext);
    updateViewerVoices(viewerContext);
  }
  updateVolumeControls();
  updateLakePopScrim();
}

function updateVolumeControls() {
  const stored = Math.round((snapshot.preferences?.master_volume ?? 1) * 100);
  const muted = volumeDraft === null ? (!!snapshot.preferences?.muted || stored === 0) : volumeDraft === 0;
  const volume = volumeDraft ?? (muted ? 0 : stored);
  const host = document.querySelector('.lake-voice-control');
  host?.classList.toggle('muted', muted);
  const output = document.querySelector('#main-volume-value'); if (output) output.textContent = String(volume);
  const control = document.querySelector('.lake-volume-waterline');
  if (control) {
    control.style.setProperty('--volume', `${Math.min(100, volume)}%`);
    control.setAttribute('aria-label', t('播报音量'));
    control.setAttribute('aria-valuemax', String(Math.max(100, volume)));
    control.setAttribute('aria-valuenow', String(volume));
    control.setAttribute('aria-valuetext', `${volume}%${muted ? ` · ${t('已静音')}` : ''}`);
    control.title = t(muted ? '取消静音' : '静音');
  }
}

const tabs = [['home', 'settings', '设置'], ['room', 'navRoom', '直播间'], ['voices', 'navVoice', '声音'], ['overlay', 'navOverlay', 'OBS'], ['readings', 'navRules', '记住的读法'], ['general', 'navGeneral', '通用'], ['advanced', 'navRules', '高级']];
const legacyTabs = { rules: 'advanced', assets: 'advanced', audio: 'general', appearance: 'general', about: 'general', data: 'general', broadcast: 'overlay', live: 'overlay' };
const settingsTabId = id => legacyTabs[id] || (tabs.some(([tab]) => tab === id) ? id : 'home');
// 开播台 and 叠加层 share the OBS 与开播 page; the old tab IDs open their panel.
const livePanels = ['broadcast', 'overlay'];
let livePanel = 'broadcast';
const chooseLivePanel = id => { if (livePanels.includes(id)) livePanel = id; };
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
  const lakeEnvelope = collectLakeSettingsAutosave(form);
  if (lakeEnvelope) return lakeEnvelope;
  if (!form.checkValidity()) throw new Error(t('请检查未填或格式不正确的项目'));
  const type = form.dataset.form;
  const data = new FormData(form);
  const value = key => String(data.get(key) ?? '').trim();
  const number = key => Number(data.get(key));
  const checked = key => data.has(key);
  const id = form.dataset.id || '';
  if (type === 'lake-voice-edit') {
    const existing = snapshot.presets.find(preset => preset.id === id);
    if (!existing) throw new Error(t('请重新打开声音设置。'));
    return { action: 'presets.save', payload: { preset: { ...existing, name: value('name'), speed: number('speed'), volume: number('volume') } } };
  }
  if (type === 'room-uid') {
    if (!validUid(value('uid'))) throw new Error(t('请输入有效的主播 UID'));
    throw new Error(t('请扫码登录哔哩哔哩后接收弹幕'));
  }
  if (type === 'gift-merge') {
    const gift_merge = { enabled: checked('enabled'), initial_seconds: number('initial_seconds'), increment_seconds: number('increment_seconds'), maximum_seconds: number('maximum_seconds') };
    if (gift_merge.maximum_seconds < gift_merge.initial_seconds) throw new Error(t('最长等待不能小于初始等待'));
    return { action: 'live.save', payload: { gift_merge } };
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
  // Consent to stop playback is asked when this draft is written (confirmOutputChange).
  if (type === 'audio') return { action: 'preferences.save', payload: { preferences: { output: value('output') ? { named: value('output') } : 'default' } } };
  if (type === 'appearance') return { action: 'preferences.save', payload: { preferences: { appearance: value('appearance'), scale: number('scale') } } };
  if (type === 'startup') return { action: 'startup.set', payload: { enabled: checked('enabled') } };
  if (type === 'overlay') {
    const current = snapshot.overlay?.settings;
    if (!current) throw new Error(t('暂时无法保存此项设置，请重新打开页面'));
    const settings = { ...current, style: 'spine', linger_seconds: 14 };
    for (const key of ['corner', 'title', 'tagline', 'names']) if (form.elements[key]) settings[key] = value(key);
    for (const key of ['offset_x', 'offset_y', 'scale', 'vignette', 'history_opacity']) if (form.elements[key]) settings[key] = number(key);
    for (const key of ['enabled', 'show_danmaku', 'show_gift', 'show_super_chat', 'show_guard', 'merge_duplicates']) if (form.elements[key]) settings[key] = checked(key);
    if (!settings.title || [...settings.title].length > 24 || /[\u0000-\u001f\u007f-\u009f]/u.test(settings.title)) throw new Error(t('请填写 1 到 24 字的叠加层主标题'));
    if (![settings.offset_x, settings.offset_y].every(value => Number.isInteger(value) && Math.abs(value) <= 8192)) throw new Error(t('位置偏移需为 -8192 到 8192 之间的整数'));
    // Absent readability values keep the stored or default ones (Rust fills them).
    for (const [key, min] of [['vignette', 0], ['history_opacity', .3]]) if (settings[key] != null && !(settings[key] >= min && settings[key] <= 1)) throw new Error(t('暂时无法保存此项设置，请重新打开页面'));
    if (!Number.isInteger(settings.linger_seconds) || settings.linger_seconds < 3 || settings.linger_seconds > 120) throw new Error(t('停留时间需在 3 到 120 秒之间'));
    return { action: 'overlay.save', payload: { settings } };
  }
  // Each OBS form sends only its own fields; Rust keeps the rest as saved.
  if (type === 'obs') {
    const host = value('host');
    const port = number('port');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host) || host.includes('..')) throw new Error(t('请填写 OBS 所在电脑的地址，例如 127.0.0.1'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('端口需在 1 到 65535 之间'));
    return { action: 'obs.save', payload: { settings: { host, port, executable: value('executable') || null } } };
  }
  if (type === 'obs-link') return { action: 'obs.save', payload: { settings: { enabled: checked('enabled'), auto_launch: checked('auto_launch') } } };
  throw new Error(t('暂时无法保存此项设置，请重新打开页面'));
}

// A new output device stops current playback and clears the queue. Ask first
// when something would be lost; declining restores the device still in use.
// Exit stops playback anyway and must not wait on a prompt.
let exitFlushing = false;
async function confirmOutputChange(form, payload) {
  if (JSON.stringify(payload.preferences.output) === JSON.stringify(snapshot.preferences?.output)) return true;
  const playing = !!(snapshot.queue?.current || snapshot.queue?.pending?.length);
  if (!playing || exitFlushing || await confirmAction(t('应用新的音频输出？'), t('当前播放和待播队列会停止。'), t('应用并停止播放'), false)) {
    payload.confirmed = true;
    return true;
  }
  const select = form.elements.output;
  if (select) { select.value = deviceValue(snapshot.preferences?.output); mountSelects(form); }
  return false;
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

function mountAutosaves() {
  for (let form of settingsDialog.querySelectorAll('[data-form]')) {
    const key = `${settingsTab}:${form.dataset.form}:${form.dataset.id || form.dataset.provider || form.dataset.connectionId || 'new'}`;
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
      save: async ({ action, payload }) => {
        if (form.dataset.form === 'service-local') return saveLocalDirectory(payload.provider, payload.directory);
        if (form.dataset.form === 'audio' && !await confirmOutputChange(form, payload)) return snapshot;
        return command(action, payload, { quiet: true, silent: true });
      },
      onSaved: async (_result, envelope) => {
        const oldKey = record.key;
        if (form.elements.credential && envelope.payload.credential && form.elements.credential.value.trim() === envelope.payload.credential) form.elements.credential.value = '';
        if (record.revision === envelope.revision) {
          record.touched = false; record.invalid = ''; formDrafts.delete(record.key); formDrafts.delete(oldKey);
          try { record.baseline = JSON.stringify(collectAutosave(form)); record.lastScheduled = record.baseline; } catch { /* May become invalid only after a concurrent edit. */ }
          showAutoState(form);
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
  if (composing || deferUid) {
    record.queue.cancel();
    record.lastScheduled = '';
    showAutoState(form);
    return;
  }
  record.lastScheduled = signature;
  record.queue.schedule({ ...envelope, revision: record.revision }, { immediate });
}

// Leaving a page, a section or a voice row never waits on an unfinished field:
// what is complete is saved, and the rest is put down with no question asked.
async function flushAutosaves(leaving = false) {
  if ([...settingsDialog.querySelectorAll('input,textarea,[contenteditable="true"]')].some(input => composingInputs.has(input))) {
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
  if (leaving) {
    for (const [form, record] of autosaves) if (record.touched && record.invalid) { record.queue.cancel(); record.touched = false; record.invalid = ''; formDrafts.delete(record.key); showAutoState(form); }
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

function renderSettings() {
  closeSelect();
  unmountAutosaves();
  settingsDirty = false;
  settingsTab = settingsTabId(settingsTab);
  const isObs = settingsTab === 'overlay';
  const obsAdvanced = isObs && typeof lakeObsPage !== 'undefined' && lakeObsPage === 'advanced';
  const voiceEditor = settingsTab === 'voices' && editor;
  const title = obsAdvanced ? t('OBS 高级') : voiceEditor ? t('添加声音') : t(tabs.find(([id]) => id === settingsTab)?.[2] || '设置');
  const subtitle = obsAdvanced ? 'advanced' : voiceEditor ? 'new voice' : ({ home: 'settings', voices: 'voices', room: 'room', overlay: 'overlay', readings: 'readings', general: 'general', advanced: 'advanced' })[settingsTab];
  const backToAdd = voiceEditor && ['service', 'qr'].includes(editor.type) && editor.provider !== 'bilibili';
  const backAction = obsAdvanced ? 'lake.obs.back' : backToAdd ? 'voice.provider' : editor ? 'editor.cancel' : 'settings.tab';
  settingsDialog.classList.add('lake-settings');
  settingsDialog.classList.toggle('lake-settings-wide', isObs && typeof isLakeObsWide === 'function' && isLakeObsWide());
  settingsDialog.dataset.page = settingsTab;
  // Re-rendering the same page (an accordion, an inline editor) keeps the reader's place.
  const keepScroll = settingsDialog.open && lastSettingsTab === settingsViewKey() ? settingsDialog.querySelector('#settings-content')?.scrollTop || 0 : 0;
  settingsDialog.innerHTML = `<div class="settings-shell"><header class="lake-settings-heading">${settingsTab !== 'home' ? iconButton('back', editor ? t('返回') : t('返回设置'), backAction, backAction === 'settings.tab' ? 'home' : backToAdd ? editor.provider : '') : ''}<h2 id="settings-title"><span>${esc(title)}</span><i>${subtitle}</i></h2>${iconButton('close', t('关闭设置'), 'settings.close')}</header><div id="settings-error" class="settings-status" role="alert" hidden></div><section class="settings-content" id="settings-content" tabindex="-1">${renderSettingsPage()}</section></div>`;
  settleSettingsMotion();
  if (keepScroll) { const content = settingsDialog.querySelector('#settings-content'); if (content) content.scrollTop = keepScroll; }
  mountAutosaves();
  for (const node of settingsDialog.querySelectorAll('[data-lake-template]')) node.innerHTML = lakeTemplateMarkup(node.closest('form').elements[`template_${node.dataset.lakeTemplate}`].value);
  updateVoiceSettings();
  updateServiceIndicators();
  updateOverlayStatus();
  updateOverlayPreview();
  updateObsSettings();
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

// The OBS page counts its connect / stage / advanced views as separate pages.
const settingsViewKey = () => `${settingsTab}|${editor?.type || ''}|${editor?.id || editor?.provider || ''}|${settingsTab === 'overlay' && typeof lakeObsViewKind === 'function' ? lakeObsViewKind() : ''}`;
const settingsViewDepth = () => settingsTab === 'home' ? 0 : editor || (settingsTab === 'overlay' && typeof lakeObsPage !== 'undefined' && lakeObsPage === 'advanced') ? 2 : 1;
let lastSettingsDepth = 0;

// Deeper pages come in from the right and shallower ones from the left; a page that
// only changes state (OBS connecting) fades. Opening the drawer keeps the rise.
function settleSettingsMotion() {
  const view = settingsViewKey();
  const depth = settingsViewDepth();
  const changed = lastSettingsTab !== view || !settingsDialog.open;
  const direction = !settingsDialog.open ? '' : depth > lastSettingsDepth ? 'fwd' : depth < lastSettingsDepth ? 'back' : 'swap';
  lastSettingsTab = view; lastSettingsDepth = depth;
  const motion = motionAllowed();
  if (changed && motion) {
    if (direction) settingsDialog.dataset.nav = direction; else delete settingsDialog.dataset.nav;
    settingsDialog.querySelector('#settings-content')?.classList?.add('tab-enter');
    if (direction) settingsDialog.querySelector('.lake-settings-heading')?.classList?.add('lake-heading-enter');
  }
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

// Used by legacy setup screens; the lake settings drawer keeps the real title bar visible.
const windowControls = () => document.querySelector('#titlebar .titlebar-controls')?.outerHTML || '';

function renderSettingsPage() {
  if (!snapshot) return empty(t('桌面连接不可用。'));
  if (settingsTab === 'home') return renderLakeSettingsHome();
  if (settingsTab === 'room') return renderRoomSettings();
  if (settingsTab === 'voices') return renderVoicesSettings();
  if (settingsTab === 'readings') return renderLakeReadings();
  if (settingsTab === 'advanced') return renderRulesSettings();
  if (settingsTab === 'overlay') return renderLiveSettings();
  return renderLakeGeneral();
}

function renderRoomSettings() {
  const loggedIn = !!snapshot.account?.user_id;
  const expired = snapshot.live?.state === 'session_expired';
  const scanning = editor?.type === 'qr' && editor.provider === 'bilibili';
  const needsRoom = qrNeedsRoomFallback(snapshot);
  const identity = headerIdentity(snapshot);
  const name = loggedIn ? identity.name : t('未登录');
  const state = expired ? t('登录已失效') : loggedIn ? t('已登录') : t('未登录');
  const note = expired ? t('重新扫码登录后即可继续接收弹幕。') : loggedIn ? '' : t('用哔哩哔哩 App 扫码，自动找到自己的直播间。');
  const avatar = `<span class="s-avatar large color-${identityColor(snapshot.account?.user_id || name)}" aria-hidden="true">${loggedIn ? `<span>${esc(initial(name))}</span>` : icon('person')}${identity.avatar ? `<img src="${esc(identity.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
  const heroActions = loggedIn
    ? expired ? button(t('重新扫码'), 'bili.begin', { class: 'small lake-gold-outline', icon: 'qr' }) : button(t('换一个账号'), 'bili.begin', { class: 'quiet' })
    : button(t('扫码登录'), 'bili.begin', { class: 'primary small', icon: 'qr' });
  const hero = scanning
    ? `<section class="lake-room-qr">${qrMarkup('bilibili', true)}<p class="lake-note">${esc(t('用哔哩哔哩 App 扫一扫'))}<br>${esc(t('在手机上确认登录'))}</p><p class="lake-note">${esc(t('二维码两分钟后会过期'))} · <button type="button" class="text-button" data-action="qr.retry">${esc(t('换一张'))}</button></p>${button(t('取消扫码'), 'editor.cancel', { class: 'small quiet' })}</section>`
    : ui`<section class="lake-room-account">${avatar}<div class="s-account-text"><strong>${esc(name)}</strong><span class="${expired ? 'lake-gold' : ''}">哔哩哔哩账号 · ${esc(state)}</span>${note ? `<small>${esc(note)}</small>` : ''}</div><div class="s-hero-actions">${heroActions}</div></section>`;
  const card = `<div class="lake-room-number"><span>${esc(t('直播间号'))}</span><div>${lakeRoomNumberField()}</div><small>${esc(t('现在'))} · ${esc(snapshot.broadcast?.room?.live_status === 1 ? t('直播中') : t('还没开播'))}</small></div>`;
  const targetNote = needsRoom ? t('未找到本账号直播间，请先在 B站开通直播间后重新扫码') : '';
  return `<div class="lake-settings-page lake-room">${hero}${scanning ? '' : card}${targetNote ? `<p class="lake-note lake-gold">${esc(targetNote)}</p>` : ''}<footer class="lake-settings-footer">${loggedIn ? button(t('退出这个账号'), 'bili.logout', { class: 'quiet' }) : ''}</footer></div>`;
}

// The room number changes where it stands, like the room title on the lake:
// 换一个 turns the number into its own field and the rest of the page steps
// back. Enter or leaving the field saves it (a running room reconnects);
// Escape puts it back. An empty, unchanged or impossible number just goes back.
let lakeRoomSave = null;

function lakeRoomNumberField(editing = false) {
  const room = snapshot.setup?.room_id || snapshot.live_settings?.room_id;
  return editing
    ? `<input class="lake-room-input" value="${esc(room || '')}" inputmode="numeric" maxlength="16" autocomplete="off" spellcheck="false" aria-label="${esc(t('直播间号'))}">`
    : `<strong>${room ? esc(room) : '—'}</strong>${button(t('换一个'), 'lake.room.edit', { class: 'quiet small' })}`;
}

function showLakeRoomNumber(editing) {
  const card = settingsDialog.querySelector('.lake-room-number');
  if (!card) return;
  const focused = card.contains(document.activeElement);
  card.classList.toggle('editing', editing);
  card.querySelector('div').innerHTML = lakeRoomNumberField(editing);
  const input = card.querySelector('input');
  if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }
  else if (focused) card.querySelector('button')?.focus({ preventScroll: true });
}

function commitLakeRoomNumber() {
  const input = settingsDialog.querySelector('.lake-room-number.editing input');
  if (!input) return Promise.resolve();
  lakeRoomSave ||= saveLakeRoomNumber(input).finally(() => { lakeRoomSave = null; });
  return lakeRoomSave;
}

async function saveLakeRoomNumber(input) {
  const value = input.value.trim();
  const saved = String(snapshot.setup?.room_id || snapshot.live_settings?.room_id || '');
  if (value !== saved && validUid(value) && Number.isSafeInteger(Number(value))) {
    const reconnect = !!snapshot.live?.running;
    input.readOnly = true;
    try {
      if (reconnect) await command('live.disconnect');
      await command('live.save', { room_id: numericId(value) });
    } finally {
      input.readOnly = false;
      // Reception picks up on the saved room, or on the old one if the change failed.
      if (reconnect) await command('live.connect').catch(() => { /* command() already showed it. */ });
    }
  }
  if (input.isConnected) showLakeRoomNumber(false);
}

// ---- 开播 (experimental) ----
// The console manages the signed-in account's own room only; chat reception, speech and
// OBS media output stay independent. Push credentials never enter snapshots or drafts.
const BROADCAST_REFRESH_MS = 60000;
let broadcastRefreshAt = 0;
let broadcastRefreshAccount = '';
let broadcastRefreshError = '';
let broadcastRefreshing = false;
let broadcastRefreshSequence = 0;
let broadcastObservedAccount = '';
let onAirPanelMode = '';
let onAirClockTimer = null;
let onAirSignature = '';
const onAirDrafts = new Map();

const broadcastEnabled = () => !!snapshot?.preferences?.broadcast_console;
const broadcastAccount = () => String(snapshot?.account?.user_id || '');
const broadcastLive = room => room?.live_status === 1;

function syncBroadcastAccount() {
  const account = broadcastAccount();
  if (broadcastObservedAccount !== account) {
    broadcastObservedAccount = account;
    ++broadcastRefreshSequence;
    broadcastRefreshAt = 0;
    broadcastRefreshAccount = '';
    broadcastRefreshError = '';
    broadcastRefreshing = false;
    if (onAirPanelMode) closeOnAirPanel();
    else onAirDrafts.clear();
  }
  return account;
}

// The OBS overlay title shown in the main screen's title kicker, once the
// overlay is in use.
function lakeObsTitle() {
  const settings = snapshot.overlay?.settings;
  return settings?.enabled ? settings.title || t('今晚的弹幕') : '';
}

// The OBS title saves itself when it is done (Enter or clicking away); an empty
// field simply keeps the saved title. Escape closes without saving.
async function saveOverlayTitleForm(form) {
  const value = String(form?.elements.title?.value || '').replace(/\s+/g, ' ').trim();
  const saved = lakeObsTitle();
  if (onAirPanelMode === 'obs') closeOnAirPanel();
  if (!value || value === saved || !snapshot.overlay?.settings?.enabled) return;
  await command('overlay.title.save', { title: value });
}

function lakeOverlayTitleFields() {
  const title = lakeObsTitle();
  const id = `overlay-title-${++broadcastFieldSequence}`;
  return `<span class="lake-edit-kicker">TONIGHT’S TITLE<em>— OBS</em></span><div class="onair-field"><label class="sr-only" for="${id}">${esc(t('OBS 叠加层主标题'))}</label><span class="onair-input"><input id="${id}" name="title" value="${esc(title)}" maxlength="24" required autocomplete="off" spellcheck="false"><output class="onair-count" data-title-count><span data-count-number>${Array.from(title).length}</span><i> / 24</i></output></span></div>`;
}

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
  const account = syncBroadcastAccount();
  if (!broadcastEnabled() || !account || snapshot.network_disabled || broadcastBusy || broadcastRefreshing || snapshot.broadcast?.busy) return;
  const visible = step === 'main' && !settingsDialog.open;
  if (!visible || !uiIsActive(nativeActive, windowFocused, document.hidden)) return;
  const due = force || broadcastRefreshAccount !== account || Date.now() - broadcastRefreshAt > BROADCAST_REFRESH_MS;
  if (!due) return;
  const sequence = ++broadcastRefreshSequence;
  broadcastRefreshing = true;
  broadcastRefreshAt = Date.now();
  broadcastRefreshAccount = account;
  updateBroadcastViews();
  try {
    // Background reads must not suspend snapshot polling, or a login/logout
    // while this read waits cannot invalidate the previous account's reply.
    const next = await invoke('dispatch', { action: 'bili.broadcast.refresh', payload: {} });
    if (sequence !== broadcastRefreshSequence || broadcastAccount() !== account || !broadcastEnabled()) return;
    if (String(next.account?.user_id || '') !== account) return;
    if (Number.isSafeInteger(next.config_revision) && Number.isSafeInteger(snapshot.config_revision) && next.config_revision < snapshot.config_revision) return;
    acceptSnapshot(next);
    broadcastRefreshError = '';
  } catch (error) {
    if (sequence === broadcastRefreshSequence && broadcastAccount() === account) broadcastRefreshError = errorMessage(error);
  } finally {
    if (sequence === broadcastRefreshSequence) {
      broadcastRefreshing = false;
      updateBroadcastViews();
    }
  }
}

function updateBroadcastViews() {
  updateOnAir();
  updateObsSettings();
}

async function runBroadcastAction(action, payload = {}, options = {}) {
  if (broadcastBusy) return;
  broadcastBusy = true;
  // An earlier room read may already have finished on the server while its
  // reply is still in transit. Explicit operations supersede that old result.
  ++broadcastRefreshSequence;
  broadcastRefreshing = false;
  const scopes = [...document.querySelectorAll('[data-broadcast-scope]')];
  const controls = scopes.flatMap(scope => [...scope.querySelectorAll('button, input, select')]).map(node => [node, node.disabled]);
  controls.forEach(([node]) => { node.disabled = true; });
  for (const scope of scopes) scope.classList.add('broadcast-busy');
  for (const go of document.querySelectorAll('[data-onair-go]')) go.classList.add('working');
  try { return await command(`bili.broadcast.${action}`, payload, options); }
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
  const inMainPanel = !!form.closest('#onair-panel');
  const { title, area_id } = broadcastFormValues(form);
  await runBroadcastAction('update', { confirmed: true, title, area_id });
  delete form.dataset.dirty;
  onAirDrafts.delete('broadcast-room');
  if (inMainPanel) closeOnAirPanel();
  updateBroadcastViews();
  showToast(t(inMainPanel ? '直播标题已保存到 B站' : '直播标题与分区已更新'));
  return true;
}

// A changed title or category is submitted first, so the room opens with what is on screen.
let lakeFaceAttempt = null;
let lakeFaceTimer = null;
let lakeFaceError = '';

function cancelLakeFaceWait() {
  clearTimeout(lakeFaceTimer); lakeFaceTimer = null; lakeFaceAttempt = null;
}

function beginLakeFaceWait() {
  cancelLakeFaceWait(); lakeFaceError = '';
  lakeFaceAttempt = { account: broadcastAccount(), room: String(snapshot.broadcast?.room?.room_id || ''), until: Date.now() + 120000 };
  scheduleLakeFaceWait(lakeFaceAttempt);
}

function scheduleLakeFaceWait(attempt) {
  clearTimeout(lakeFaceTimer);
  lakeFaceTimer = setTimeout(async () => {
    const same = () => lakeFaceAttempt === attempt && broadcastEnabled() && broadcastAccount() === attempt.account && String(snapshot.broadcast?.room?.room_id || '') === attempt.room && !snapshot.network_disabled;
    if (!same() || broadcastLive(snapshot.broadcast?.room)) { cancelLakeFaceWait(); if (onAirPanelMode === 'face') closeOnAirPanel(); return; }
    if (Date.now() >= attempt.until) {
      lakeFaceError = t('验证等待已超时，请重新开播。'); cancelLakeFaceWait(); renderOnAirPanel(); return;
    }
    if (broadcastBusy || snapshot.broadcast?.busy) { scheduleLakeFaceWait(attempt); return; }
    try {
      const next = await runBroadcastAction('start', { confirmed: true, area_id: snapshot.broadcast.room.area_id }, {
        quiet: true, silent: true,
        accept: next => same() && String(next.account?.user_id || '') === attempt.account && String(next.broadcast?.room?.room_id || '') === attempt.room,
      });
      if (!same()) return;
      if (next && !snapshot.broadcast?.face_image && broadcastLive(snapshot.broadcast?.room)) {
        cancelLakeFaceWait(); closeOnAirPanel();
        showToast(t(next.result?.obs?.outcome === 'started' ? '已开播，OBS 已开始推流' : '已开播，请在 OBS 中开始推流'));
      } else scheduleLakeFaceWait(attempt);
    } catch (error) {
      if (same()) { lakeFaceError = errorMessage(error); cancelLakeFaceWait(); renderOnAirPanel(); }
    }
  }, 5000);
}

async function startBroadcast() {
  if (broadcastBusy) return;
  if (!snapshot.broadcast?.room) await runBroadcastAction('refresh');
  const room = snapshot.broadcast?.room;
  if (!room) return;
  const form = document.querySelector('[data-broadcast-scope] form[data-form="broadcast-room"][data-dirty]');
  if (form && !await saveBroadcastForm(form)) return;
  const next = await runBroadcastAction('start', { confirmed: true, area_id: snapshot.broadcast.room.area_id });
  if (snapshot.broadcast?.face_image) {
    beginLakeFaceWait();
    if (step === 'main' && !settingsDialog.open) openOnAirPanel('face');
    else showToast(t('请先扫码完成人脸验证'));
    return;
  }
  // With the OBS link on, Rust already handed the push target to OBS; the panel is only a fallback.
  const obs = next?.result?.obs;
  if (obs?.outcome === 'started' || obs?.outcome === 'starting') { showToast(t(obs.outcome === 'started' ? '已开播，OBS 已开始推流' : '已开播，OBS 正在开始推流')); return; }
  if (obs?.outcome === 'already_streaming') { showToast(t('已开播。OBS 原本就在推流，没有改动它的推流设置')); return; }
  closeOnAirPanel();
  if (obs?.error) showToast(`${t('已开播，但 OBS 没能自动推流，请检查「设置 → OBS」：')}${errorMessage(obs.error)}`, true);
  else showToast(t('已开播，请在 OBS 中开始推流'));
}

// No confirmation: ending is one click. With the OBS link on, Rust stops OBS before closing the room.
async function stopBroadcast() {
  cancelLakeFaceWait();
  closeOnAirPanel();
  const next = await runBroadcastAction('stop', { confirmed: true });
  const obs = next?.result?.obs;
  if (obs?.error) { showToast(`${t('已下播，但 OBS 没能停止推流，请在 OBS 里手动停止：')}${errorMessage(obs.error)}`, true); return; }
  showToast(t(obs?.outcome === 'stopped' ? '已下播，OBS 已停止推流' : obs?.outcome === 'stopping' ? '已下播，OBS 正在停止推流' : '已下播'));
}

// Shared markup ---------------------------------------------------------------------------
let broadcastFieldSequence = 0;
function lakeBroadcastInfoFields(view, room) {
  const areas = view.areas || [];
  const parent = areas.find(item => item.children.some(child => child.id === room.area_id)) || areas.find(item => item.id === room.parent_area_id) || areas[0];
  const id = `broadcast-title-${++broadcastFieldSequence}`;
  return `<div class="onair-field"><label class="sr-only" for="${id}">${esc(t('直播标题'))}</label><span class="onair-input"><input id="${id}" name="title" value="${esc(room.title)}" maxlength="40" required autocomplete="off" spellcheck="false"><output class="onair-count" data-title-count><span data-count-number>${Array.from(room.title || '').length}</span><i> / 40</i></output></span></div><div class="onair-areas"><span>${esc(t('分区'))}</span><select name="parent_area_id" aria-label="${esc(t('直播分区'))}">${areas.map(item => option(item.id, item.name, parent?.id)).join('')}</select><span class="lake-area-slash">/</span><select name="area_id" aria-label="${esc(t('直播子分区'))}" required>${(parent?.children || []).map(child => option(child.id, child.name, room.area_id)).join('')}</select></div>`;
}

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
  const account = syncBroadcastAccount();
  shell?.classList.toggle('onair-mode', enabled);
  shell?.classList.toggle('on-air', enabled && !!account && broadcastLive(room));
  if (!enabled) {
    if (!host.hidden) { host.hidden = true; host.innerHTML = ''; onAirSignature = ''; }
    closeOnAirPanel();
    return;
  }
  void refreshBroadcast();
  const area = broadcastAreaPath(view, room);
  // Keep existing room controls while the background read starts/finishes.
  // Only data visible in this header belongs to its DOM signature.
  const faceWaiting = onAirPanelMode === 'face' && !!view.face_image;
  const pendingStart = !broadcastLive(room) && (broadcastBusy || !!view.busy);
  const signature = JSON.stringify([account, room && [room.room_id, room.title, room.live_status, room.live_since], area, view.face_image, faceWaiting, pendingStart, lakeEnded, getLanguage(), !!snapshot.network_disabled, !room && [broadcastRefreshing, broadcastRefreshError]]);
  const syncActions = () => {
    const busy = !room || broadcastBusy || !!view.busy || faceWaiting;
    for (const button of host.querySelectorAll('.onair-go')) {
      button.classList.toggle('working', busy);
      button.disabled = busy || !!snapshot.network_disabled;
    }
  };
  syncActions();
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
    copy = `${kicker('OFF AIR', failed ? `<span class="onair-failure" title="${esc(broadcastRefreshError)}">${esc(t('没读到开播状态'))}</span>` : '')}<span class="onair-title static${failed ? ' error' : ' loading'}">${esc(failed ? t('读取开播状态失败') : t('正在读取开播状态…'))}</span>`;
    actions = failed ? onAirSideButton(t('重试'), 'broadcast.refresh', 'refresh') : onAirGoButton(room, { ...view, busy: true });
  } else {
    const state = live ? 'ON AIR' : faceWaiting || broadcastBusy || view.busy ? 'GOING LIVE' : lakeEnded ? 'WRAPPED' : room.live_status === 2 ? 'REPLAY' : 'OFF AIR';
    copy = `${kicker(state, onAirClock(room))}`;
    // The sky keeps the reference's disabled waiting indicator; the QR carries the real retry action.
    actions = faceWaiting ? `<button type="button" class="onair-go working" disabled><i aria-hidden="true"></i><span>${esc(t('等待验证'))}</span></button>` : lakeEnded && !live ? `<button type="button" class="onair-go live" data-action="lake.prepare">${esc(t('回到准备'))}</button>` : onAirGoButton(room, view, !live && (broadcastBusy || view.busy) ? t('打开直播间') : '');
  }
  host.innerHTML = `<div class="onair-copy">${copy}</div><div class="onair-actions">${actions}</div>`;
  syncActions();
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
  const content = onAirPanelMode === 'info' ? [room.title, room.parent_area_id, room.area_id, view.areas]
    : onAirPanelMode === 'obs' ? [lakeObsTitle()]
      : [view.face_image, room.live_status, view.busy, broadcastBusy, lakeFaceError];
  const signature = JSON.stringify([onAirPanelMode, content, getLanguage()]);
  if (panel.dataset.signature === signature && !panel.hidden) return;
  const active = panel.contains(document.activeElement) ? document.activeElement : null;
  const focus = active ? { id: active.id, name: active.name, start: active.selectionStart, end: active.selectionEnd } : null;
  for (const form of panel.querySelectorAll('form[data-dirty]')) {
    onAirDrafts.set(form.dataset.form, Object.fromEntries([...form.elements].filter(field => field.name).map(field => [field.name, field.value])));
  }
  panel.dataset.signature = signature;
  if (onAirPanelMode === 'info') {
    panel.innerHTML = `<div class="lake-edit-halo" aria-hidden="true"></div><form data-form="broadcast-room" class="onair-info lake-title-form" novalidate><span class="lake-edit-kicker">TONIGHT’S TITLE<em>— ${esc(t('B站直播间'))}</em></span>${lakeBroadcastInfoFields(view, room)}<div class="onair-panel-foot"><button type="button" class="onair-text-button" data-action="onair.close">${esc(t('取消'))}</button><button type="submit" class="onair-save">${esc(t('好了'))}</button></div></form>`;
  } else if (onAirPanelMode === 'obs') {
    panel.innerHTML = `<div class="lake-edit-halo" aria-hidden="true"></div><form data-form="overlay-title" class="onair-info lake-title-form" novalidate>${lakeOverlayTitleFields()}</form>`;
  } else if (onAirPanelMode === 'face' && view.face_image) {
    panel.innerHTML = `<span class="lake-face-kicker">FACE CHECK</span><h3>${esc(t('开播前需要验证本人'))}</h3><div class="onair-face-qr"><img src="${esc(safeQrUrl(view.face_image))}" alt="${esc(t('开播人脸验证二维码'))}"></div><p class="lake-face-note">${esc(t('用哔哩哔哩 App 扫一扫，完成验证后会自动开播。'))}</p><div class="onair-panel-foot">${lakeFaceError ? `<span role="alert">${esc(lakeFaceError)}</span><button type="button" class="onair-text-button" data-action="broadcast.start">${esc(t('重试'))}</button>` : `<span class="lake-face-waiting" role="status">${esc(t('等待验证…'))}</span>`}</div>`;
  }
  panel.dataset.mode = onAirPanelMode;
  for (const form of panel.querySelectorAll('form')) {
    const draft = onAirDrafts.get(form.dataset.form);
    if (!draft) continue;
    if (form.dataset.form === 'broadcast-room') {
      const parent = view.areas?.find(area => String(area.id) === draft.parent_area_id);
      if (parent) form.elements.area_id.innerHTML = parent.children.map(child => option(child.id, child.name, draft.area_id)).join('');
    }
    for (const [name, value] of Object.entries(draft)) if (form.elements[name]) form.elements[name].value = value;
    const counter = form.querySelector('[data-title-count]');
    if (counter) {
      const digits = counter.querySelector('[data-count-number]');
      if (digits) digits.textContent = String(Array.from(form.elements.title.value).length);
      else counter.textContent = `${Array.from(form.elements.title.value.trim()).length}/40`;
    }
    form.dataset.dirty = 'true';
  }
  mountSelects(panel);
  if (focus?.id) {
    const field = (focus.name && panel.querySelector(`[name="${focus.name}"]`)) || panel.querySelector(`#${focus.id}`);
    field?.focus({ preventScroll: true });
    if (focus.start != null && field?.setSelectionRange) field.setSelectionRange(focus.start, focus.end);
  }
}

function openOnAirPanel(mode) {
  const panel = document.querySelector('#onair-panel');
  if (!panel || !snapshot.broadcast?.room) return;
  closeVoicePanel(); closeQueuePanel();
  if (!panel.hidden && onAirPanelMode === mode) return handleAction('onair.close', '', null);
  onAirPanelMode = mode;
  panel.dataset.signature = '';
  renderOnAirPanel();
  panel.hidden = false;
  document.querySelector('#live-shell')?.classList.toggle('lake-editing', mode === 'info' || mode === 'obs');
  document.querySelector('#live-shell')?.classList.toggle('lake-editing-obs', mode === 'obs');
  if (mode === 'info' || mode === 'obs') panel.querySelector('input[name="title"]')?.focus({ preventScroll: true });
  if (mode === 'face') { renderLakeTranscript(normalizedEvents(snapshot), eventKeys(normalizedEvents(snapshot))); updateOnAir(); }
}

function closeOnAirPanel(focus = false) {
  const panel = document.querySelector('#onair-panel');
  const wasFace = onAirPanelMode === 'face';
  if (wasFace) cancelLakeFaceWait();
  onAirPanelMode = '';
  document.querySelector('#live-shell')?.classList.remove('lake-editing', 'lake-editing-obs');
  onAirDrafts.clear();
  if (!panel || panel.hidden) { updateLakePopScrim(); return; }
  closeSelect();
  panel.hidden = true;
  updateLakePopScrim();
  panel.innerHTML = '';
  if (panel.dataset) panel.dataset.signature = '';
  if (focus) document.querySelector('#onair .onair-go')?.focus();
  if (wasFace) { renderLakeTranscript(normalizedEvents(snapshot), eventKeys(normalizedEvents(snapshot))); updateOnAir(); }
}

// ---- OBS 与开播 (experimental) ----
// One page for both OBS features. Rust owns the obs-websocket connection, the DPAPI-protected
// password and starting OBS; the page edits choices, submits a new password once and shows the
// OBS reachability and browser-source readiness are separate. Only the visible,
// active OBS settings page periodically reads reachability; it never saves a form.
let obsBusy = '';
let obsDetailsOpen = null;
let obsRefreshing = false;
let obsRefreshAt = 0;
let obsRefreshKey = '';
let obsRefreshTimer = null;
const OBS_REFRESH_MS = 15000;

const obsConnectionKey = () => JSON.stringify([snapshot?.obs?.settings?.host, snapshot?.obs?.settings?.port, snapshot?.obs?.has_password]);
const obsPageActive = () => !disposed && !!snapshot && !snapshot.network_disabled && settingsDialog.open && ['overlay', 'live'].includes(settingsTab) && !editor && !!settingsDialog.querySelector('[data-obs-root]') && uiIsActive(nativeActive, windowFocused, document.hidden);

function acceptObsObservation(next, key) {
  if (disposed || key !== obsConnectionKey() || !next?.obs) return false;
  if (Number.isSafeInteger(next.config_revision) && Number.isSafeInteger(snapshot.config_revision) && next.config_revision < snapshot.config_revision) return false;
  acceptSnapshot(next);
  return true;
}

function scheduleObsRefresh() {
  if (obsRefreshTimer || !obsPageActive()) return;
  obsRefreshTimer = setTimeout(() => {
    obsRefreshTimer = null;
    void refreshObsStatus();
  }, OBS_REFRESH_MS);
}

async function refreshObsStatus() {
  if (!obsPageActive() || obsBusy || obsRefreshing) return;
  const key = obsConnectionKey();
  if (key === obsRefreshKey && Date.now() - obsRefreshAt < OBS_REFRESH_MS) { scheduleObsRefresh(); return; }
  obsRefreshKey = key;
  obsRefreshAt = Date.now();
  obsRefreshing = true;
  updateObsSettings();
  try {
    const next = await invoke('dispatch', { action: 'obs.refresh', payload: {} });
    if (!acceptObsObservation(next, key)) return;
    if (obsPageActive() && !obsBusy && snapshot.obs?.status?.state === 'ok' && snapshot.overlay?.running && !['syncing', 'ready', 'updated', 'paused'].includes(snapshot.obs?.status?.overlay_sync?.state)) {
      // Rebind only an existing managed source after OBS becomes available.
      // Creating/adding/enabling a source remains the explicit Add to OBS action.
      const synced = await invoke('dispatch', { action: 'obs.overlay.sync', payload: { automatic: true } });
      acceptObsObservation(synced, key);
    }
  } catch {
    // Rust records the readable failure in its snapshot. Automatic checks do not
    // interrupt editing or create repeated toast/alert messages.
    try {
      const next = await invoke('snapshot', { configRevision: snapshot?.config_revision });
      acceptObsObservation(next, key);
    } catch { /* The next bounded observation can retry. */ }
  } finally {
    obsRefreshing = false;
    updateObsSettings();
    updateOverlayStatus();
    scheduleObsRefresh();
  }
}

let lakeObsPage = 'preview';
let lakeObsDrag = null;
let lakeObsSaveTimer = null;
let lakeObsEventsInstalled = false;
const lakeObsPasswordSaves = new WeakMap();
// Once OBS has been reached (or the overlay was added, or broadcasts drive OBS), a
// closed OBS is only "not running": the page stays the stage instead of asking for
// the connection again. Wrong passwords and too-old versions still need the form.
const lakeObsReachedKey = 'dv.obs.reached';
function lakeObsConfigured() {
  if (snapshot?.overlay?.settings?.enabled || snapshot?.obs?.settings?.enabled) return true;
  try { return localStorage.getItem(lakeObsReachedKey) === '1'; } catch { return false; }
}
function rememberLakeObsReached() {
  if (snapshot?.obs?.status?.state !== 'ok') return;
  try { localStorage.setItem(lakeObsReachedKey, '1'); } catch { /* Only a layout hint. */ }
}
const lakeObsNeedsSetup = () => snapshot?.obs?.status?.state === 'error' && /DV-OB0[234]/.test(snapshot.obs.status.message || '');
const lakeObsViewKind = () => lakeObsPage === 'advanced' ? 'advanced' : snapshot?.obs?.status?.state === 'ok' ? 'preview' : lakeObsConfigured() && !lakeObsNeedsSetup() ? 'offline' : 'connect';
const isLakeObsWide = () => ['preview', 'offline'].includes(lakeObsViewKind());

function renderLiveSettings() {
  const kind = lakeObsViewKind();
  if (kind === 'advanced') return `<div class="lake-obs lake-obs-advanced" data-obs-root data-obs-view="advanced">${renderObsConnection()}${renderOverlayAdvanced()}${renderObsLinkSection()}</div>`;
  rememberLakeObsReached();
  if (kind === 'preview' || kind === 'offline') return `<div class="lake-obs lake-obs-connected" data-obs-root data-obs-view="${kind}">${renderOverlayPanel()}</div>`;
  return `<div class="lake-obs lake-obs-setup" data-obs-root data-obs-view="connect"><section class="lake-obs-intro"><div class="lake-obs-connect-symbol" aria-hidden="true"><i class="lake-obs-app-dot"></i><span></span><i class="lake-obs-orbit">${icon('navOverlay')}</i></div><h3>${esc(t('还没连上 OBS'))}</h3><p>${esc(t('在 OBS 里打开「工具 › WebSocket 服务器设置」，勾上「开启 WebSocket 服务器」，把端口和密码填在下面。'))}</p></section>${renderObsConnection()}<div class="lake-obs-setup-foot"><span class="s-ovl-thumb spine" aria-hidden="true"><i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i><i class="e"></i><i class="f"></i></span><p>${esc(t('连上以后，抽屉会变宽，让你直接在画面上摆放弹幕。'))}</p></div></div>`;
}

function liveTabState(id) {
  if (id === 'broadcast') {
    if (!broadcastEnabled()) return { tone: 'idle', text: t('未启用') };
    const room = snapshot.broadcast?.room;
    if (broadcastLive(room)) return { tone: 'live', text: t('直播中') };
    return { tone: 'ready', text: snapshot.obs?.settings?.enabled ? t('已启用 · 同步控制 OBS') : t('已启用') };
  }
  const view = snapshot.overlay || {};
  if (!view.settings?.enabled) return { tone: 'idle', text: t('未启用') };
  if (view.error) return { tone: 'error', text: t('地址不可用') };
  if (snapshot.obs?.status?.overlay_sync?.state === 'error' && !overlayObsClientCount()) return { tone: 'error', text: t('来源同步失败') };
  return overlayObsClientCount() ? { tone: 'ready', text: t('OBS 正在显示') } : { tone: 'pending', text: t('等待 OBS 显示') };
}

function liveTab(id) {
  const state = liveTabState(id);
  const name = id === 'broadcast' ? t('开播台') : t('叠加层');
  const note = id === 'broadcast' ? t('开播、下播、标题与推流') : t('弹幕画进直播画面');
  return `<button type="button" class="s-live-tab" id="live-tab-${id}" role="tab" data-action="live.panel" data-id="${id}" aria-selected="${livePanel === id}"><span class="s-live-tab-icon" aria-hidden="true">${icon(id === 'broadcast' ? 'navBroadcast' : 'navOverlay')}</span><span class="s-live-tab-text"><strong>${esc(name)}</strong><small>${esc(note)}</small></span><span class="s-live-tab-state" data-live-state="${id}"><span class="service-light ${state.tone}" aria-hidden="true"></span><span>${esc(state.text)}</span></span></button>`;
}

function updateLiveTabs() {
  const page = settingsDialog.open ? settingsDialog.querySelector('.s-live') : null;
  if (!page) return;
  for (const id of livePanels) {
    const node = page.querySelector(`[data-live-state="${id}"]`);
    if (!node) continue;
    const state = liveTabState(id);
    const light = node.querySelector('.service-light');
    if (light && light.className !== `service-light ${state.tone}`) light.className = `service-light ${state.tone}`;
    const text = node.querySelector('span:last-child');
    if (text && text.textContent !== state.text) text.textContent = state.text;
  }
}

function obsStatusView(view = snapshot.obs || {}) {
  const status = view.status || {};
  const address = `${view.settings?.host || '127.0.0.1'}:${view.settings?.port || 4455}`;
  if (obsBusy === 'launch') return { tone: 'pending', text: t('正在启动 OBS…'), detail: t('等 OBS 打开 WebSocket，最多约 45 秒') };
  if (obsBusy) return { tone: 'pending', text: t('正在连接 OBS…'), detail: address };
  if (status.state === 'checking' || (obsRefreshing && (!status.state || status.state === 'idle'))) return { tone: 'pending', text: t('正在检测 OBS…'), detail: address };
  if (status.state === 'error' && /DV-OB01/.test(status.message || '')) return { tone: 'error', text: t('没能连上：OBS 没打开，或者 WebSocket 服务器没开启'), detail: '', reason: errorMessage(status.message || '') };
  if (status.state === 'error') return { tone: 'error', text: t('没能连上 OBS'), detail: errorMessage(status.message || '') };
  if (status.state === 'ok') {
    const stream = status.streaming === true ? t('正在推流') : status.streaming === false ? t('未在推流') : '';
    return { tone: 'ready', text: status.obs_version ? ui`已连接 OBS ${status.obs_version}` : t('已连接 OBS'), detail: [address, stream].filter(Boolean).join(' · ') };
  }
  return { tone: 'idle', text: t('尚未检测 OBS'), detail: address };
}

const obsPasswordHint = view => view.has_password ? t('已加密保存在本机。输入新密码可替换。') : t('OBS 开启了“身份验证”时填写；在 OBS 的“显示连接信息”里可以看到。');
const obsProgramHint = view => view.settings?.executable ? t('已手动选择。点“自动查找”恢复默认。') : view.detected ? t('已自动找到。Steam 版或便携版可以手动选择 obs64.exe。') : t('没有找到 OBS。请选择 OBS 安装目录 bin\\64bit 下的 obs64.exe。');

// Shared OBS connection: status line on top, connection details folded underneath.
function renderObsConnection(view = snapshot.obs || {}) {
  const s = view.settings || { host: '127.0.0.1', port: 4455 };
  const status = obsStatusView(view);
  const id = `obs-connect-${++fieldSequence}`;
  const program = s.executable || view.detected || '';
  const programName = program ? program.split(/[\\/]/).at(-1) : t('选择 obs64.exe');
  return `<section class="lake-obs-connection" aria-label="${esc(t('连接设置'))}">${lakeObsPage === 'advanced' ? `<h3 class="lake-obs-connection-heading">${esc(t('连接'))}</h3>` : ''}<form data-form="obs" class="lake-obs-form" novalidate><label class="lake-obs-field" for="${id}-host"><span>${esc(t('地址'))}</span><input id="${id}-host" name="host" value="${esc(s.host || '127.0.0.1')}" required maxlength="253" spellcheck="false" autocomplete="off"></label><label class="lake-obs-field" for="${id}-port"><span>${esc(t('端口'))}</span><input id="${id}-port" name="port" value="${esc(s.port || 4455)}" type="number" min="1" max="65535" step="1" required></label><div class="lake-obs-field"><label for="${id}-password">${esc(t('密码'))}</label><input id="${id}-password" data-obs-secret type="password" autocomplete="new-password" maxlength="256" spellcheck="false" placeholder="${view.has_password ? '••••••••' : esc(t('未设置'))}"><button type="button" class="lake-obs-eye" data-action="lake.obs.password.show" aria-label="${esc(t('显示密码'))}" aria-pressed="false">${icon('eye')}</button></div><div class="lake-obs-program"><span>${esc(t('OBS 程序'))}</span><span data-lake-obs-program title="${esc(program)}">${esc(!s.executable && view.detected ? t('已自动找到 obs64.exe') : programName)}</span><input type="hidden" name="executable" value="${esc(s.executable || '')}"><button type="button" data-action="obs.pick_executable">${esc(t('更改'))}</button></div>${autoStatus()}</form><div class="lake-obs-connect-actions">${button(t('连接'), 'lake.obs.connect', { class: 'primary' })}${view.local === false ? '' : button(t('先打开 OBS'), 'lake.obs.launch', { class: 'quiet' })}</div><p class="lake-obs-connection-status" role="status" data-obs-status-text title="${esc(status.reason || '')}"${status.tone === 'idle' ? ' hidden' : ''}>${esc(status.text)}</p><p class="lake-obs-connection-detail" data-obs-status-detail${status.tone === 'error' && status.detail ? '' : ' hidden'}>${esc(status.detail)}</p></section>`;
}

function renderObsLinkSection(view = snapshot.obs || {}) {
  const s = view.settings || { enabled: false, auto_launch: true };
  return `<section class="lake-obs-section"><h3>${esc(t('开播联动'))}</h3><form data-form="obs-link" novalidate>${sSwitch('enabled', t('开播、下播时同步控制 OBS 推流'), s.enabled)}${sSwitch('auto_launch', t('OBS 没开时先自动启动'), s.auto_launch !== false, view.local === false ? t('OBS 设在其他电脑上，无法自动启动。') : '')}${autoStatus()}</form></section>`;
}

// Snapshots only touch visibility, hints, buttons and status text, never typed values.
function updateObsSettings() {
  if (!settingsDialog.open) return;
  const root = settingsDialog.querySelector('[data-obs-root]');
  if (!root) return;
  const view = snapshot.obs || {};
  const status = obsStatusView(view);
  root.dataset.tone = status.tone;
  const statusText = root.querySelector('[data-obs-status-text]');
  if (statusText) { statusText.textContent = status.text; statusText.title = status.reason || ''; statusText.hidden = status.tone === 'idle' || (root.dataset.obsView === 'advanced' && status.tone === 'ready'); }
  const connectionActions = root.querySelector('.lake-obs-connect-actions');
  if (connectionActions) connectionActions.hidden = root.dataset.obsView === 'advanced' && status.tone === 'ready';
  const detail = root.querySelector('[data-obs-status-detail]');
  if (detail) { detail.textContent = status.detail; detail.hidden = status.tone !== 'error' || !status.detail; }
  const password = root.querySelector('[data-obs-secret]');
  if (password) password.placeholder = view.has_password ? '••••••••' : t('未设置');
  for (const node of root.querySelectorAll('[data-action="lake.obs.connect"], [data-action="lake.obs.launch"], [data-action="overlay.obs_add"]')) node.disabled = !!obsBusy;
  const autoLaunch = root.querySelector('input[name="auto_launch"]');
  if (autoLaunch) autoLaunch.disabled = view.local === false;
  rememberLakeObsReached();
  const desired = lakeObsViewKind();
  if (root.dataset.obsView !== desired && !obsBusy && !lakeObsDrag) { renderSettings(); return; }
  void refreshObsStatus();
}

async function flushObsForm() {
  const form = settingsDialog.querySelector('form[data-form="obs"]');
  const record = form && autosaves.get(form);
  if (record?.touched) { scheduleAutosave(form, true); await record.queue.flush(); }
}

// Explicit OBS actions share one busy flag so the status line tells one story.
async function runObs(kind, action, payload = {}) {
  if (obsBusy) return null;
  obsBusy = kind;
  updateObsSettings();
  updateOverlayStatus();
  try {
    await flushObsForm();
    return (await command(action, payload, { quiet: true, silent: true }))?.result || {};
  } catch (error) {
    showToast(errorMessage(error), true);
    return null;
  } finally { obsRefreshKey = obsConnectionKey(); obsRefreshAt = Date.now(); obsBusy = ''; updateObsSettings(); updateOverlayStatus(); }
}

async function testObs() {
  const found = await runObs('test', 'obs.test');
  if (found) showToast(ui`OBS 连接正常 · ` + (found.streaming ? t('正在推流') : t('未在推流')));
}

async function launchObs() {
  const found = await runObs('launch', 'obs.launch');
  if (found) showToast(found.launched ? t('OBS 已启动并连上') : t('OBS 已经在运行，连接正常'));
}

async function addOverlayToObs() {
  if (!await flushAutosaves()) return;
  const settings = snapshot.overlay?.settings;
  if (!settings) return;
  if (!settings.enabled) await command('overlay.save', { settings: { ...settings, enabled: true, style: 'spine', linger_seconds: 14 } }, { quiet: true });
  const placed = await runObs('overlay', 'obs.overlay.add');
  if (!placed) return;
  const where = `“${placed.scene}” · ${placed.width} × ${placed.height}`;
  showToast(placed.created ? ui`已添加到 OBS · ${where}` : placed.added_to_scene ? ui`已放进当前场景 · ${where}` : ui`OBS 里的叠加层已更新 · ${where}`);
}

function renderGiftMerge() {
  const merge = snapshot.live_settings?.gift_merge || { enabled: false, initial_seconds: 1.5, increment_seconds: .5, maximum_seconds: 5 };
  return `<form data-form="gift-merge" class="s-card s-merge">${sSwitch('enabled', t('合并连续赠送的礼物'), merge.enabled)}<div class="s-row s-grid3">${field('initial_seconds', t('初始等待（秒）'), merge.initial_seconds, 'type="number" min="0.1" max="30" step="0.1" required')}${field('increment_seconds', t('每次延长（秒）'), merge.increment_seconds, 'type="number" min="0" max="30" step="0.1" required')}${field('maximum_seconds', t('最长等待（秒）'), merge.maximum_seconds, 'type="number" min="0.1" max="60" step="0.1" required')}</div>${autoStatus()}</form>`;
}

let lakeVoiceEditId = '';
let lakeVoiceQuery = '';
let lakeVoiceChoice = '';
function voiceWaveMarkup(flat = false) {
  return flat ? '<span class="voice-wave flat" aria-hidden="true"></span>' : `<span class="voice-wave" aria-hidden="true">${[5,12,18,9,15,6].map(h => `<i style="--height:${h}px"></i>`).join('')}</span>`;
}
function voiceIsSleeping(preset) {
  return ['gpt_sovits', 'dots'].includes(preset.provider) && !['ready', 'external'].includes(localServiceState(preset.provider).state);
}
function voiceWaterline(name, label, value, min, max, suffix) {
  const shown = suffix === '×' ? `${Number(value).toFixed(1)}×` : `${Math.round(Number(value) * 100)}`;
  return `<label class="voice-waterline"><span>${esc(label)}</span><input type="range" name="${name}" min="${min}" max="${max}" step="0.05" value="${Number(value)}" style="--fill:${100 * (Number(value) - min) / (max - min)}%" data-waterline-suffix="${suffix}" aria-label="${esc(label)}"><output>${shown}</output></label>`;
}
function renderVoiceAudition(presets, preferred) {
  if (!preferred) return `<div class="voice-default"><p class="voice-kicker">${esc(t('弹幕默认用'))}</p><h2>${esc(t('还没选择默认声音'))}</h2><p class="quiet-note">${esc(t('在下面选一个声音，设为默认。'))}</p><div id="voice-playback-error" class="inline-error" role="alert" hidden></div></div>`;
  const playing = snapshot.queue?.current?.origin === 'audition';
  return `<section class="voice-default" aria-label="${esc(t('默认声音'))}"><p class="voice-kicker">${esc(t('弹幕默认用'))}</p><form data-form="voice-audition" data-provider="${esc(preferred.provider)}"><input type="hidden" name="preset_id" value="${esc(preferred.id)}"><div class="voice-default-head"><div><h2 style="--name-len:${[...presetLabel(preferred)].length}" title="${esc(presetLabel(preferred))}" data-default-voice-name>${esc(presetLabel(preferred))}</h2><p><span data-default-voice-provider>${esc(providerLabel(preferred.provider))}</span> · <i data-default-voice-speed>${Number(preferred.speed ?? 1).toFixed(1)}×</i> ${esc(t('语速'))}</p></div><button type="submit" class="voice-round-preview" aria-label="${esc(t('试听'))}">${icon('play')}</button></div><div class="voice-default-wave${playing ? ' playing' : ''}" aria-hidden="true">${Array.from({length:54},(_,i)=>`<i style="--height:${5 + Math.round(Math.abs(Math.sin(i * .63) * Math.cos(i * .31)) * 29)}px;--delay:${i * -29}ms"></i>`).join('')}</div><textarea id="voice-audition-text" class="voice-sample" name="text" maxlength="2000" rows="2" required aria-label="${esc(t('试听文字'))}">${esc(voiceAuditionDraft.text)}</textarea></form><div id="voice-playback-error" class="inline-error" role="alert" hidden></div></section>`;
}
function updateVoiceSettings() {
  if (settingsTab !== 'voices' || editor) return;
  let form = settingsDialog.querySelector('[data-form="voice-audition"]');
  const preferred = snapshot.presets.find(preset => preset.id === snapshot.rules?.default_preset_id);
  if (!form && preferred) {
    const placeholder = settingsDialog.querySelector('.voice-default');
    if (placeholder) placeholder.outerHTML = renderVoiceAudition(snapshot.presets, preferred);
    form = settingsDialog.querySelector('[data-form="voice-audition"]');
  }
  if (form && preferred) {
    form.elements.preset_id.value = preferred.id;
    form.dataset.provider = preferred.provider;
    const name = form.querySelector('[data-default-voice-name]');
    name.textContent = presetLabel(preferred); name.title = presetLabel(preferred);
    name.style.setProperty('--name-len', String([...presetLabel(preferred)].length));
    form.querySelector('[data-default-voice-provider]').textContent = providerLabel(preferred.provider);
    form.querySelector('[data-default-voice-speed]').textContent = `${Number(preferred.speed ?? 1).toFixed(1)}×`;
    form.querySelector('.voice-default-wave').classList.toggle('playing', snapshot.queue?.current?.origin === 'audition');
  }
  // Editing controls and the sample sentence survive background snapshots.
  const list = settingsDialog.querySelector('#voice-management');
  const signature = JSON.stringify([snapshot.presets, snapshot.local_services, getLanguage()]);
  if (list && !lakeVoiceEditId && list.dataset.signature && list.dataset.signature !== signature) list.innerHTML = renderVoiceManagement(snapshot.presets, preferred, true);
  if (list) {
    list.dataset.signature = signature;
    for (const row of list.querySelectorAll('[data-voice-id]')) {
      const isDefault = row.dataset.voiceId === preferred?.id;
      const mark = row.querySelector('.voice-default-mark');
      if (mark) mark.hidden = !isDefault;
      const button = row.querySelector('[data-action="voice.default"]');
      if (button) button.hidden = isDefault;
      const said = row.querySelector('.voice-edit-default');
      if (said) said.hidden = !isDefault;
    }
  }
}
function renderVoiceManagement(presets, preferred, bodyOnly = false) {
  const rows = presets.map(preset => {
    const sleeping = voiceIsSleeping(preset);
    const editing = lakeVoiceEditId === preset.id;
    const isDefault = preferred?.id === preset.id;
    return `<div class="lake-voice-row${sleeping ? ' sleeping' : ''}${editing ? ' editing' : ''}${lakeVoiceFlash === preset.id ? ' flash' : ''}" data-voice-id="${esc(preset.id)}"><button type="button" class="voice-row-main" data-action="voice.edit" data-id="${esc(preset.id)}" aria-expanded="${editing}"><span class="voice-initial" data-provider="${esc(preset.provider)}">${sleeping ? voiceWaveMarkup(true) : esc(initial(presetLabel(preset)))}</span><span class="voice-row-name">${esc(presetLabel(preset))}<small>${esc(providerLabel(preset.provider))}</small></span></button><span class="voice-row-actions"><span class="voice-default-mark"${isDefault ? '' : ' hidden'}>${esc(t('默认'))}</span>${iconButton('play', t('试听'), 'voice.preview', preset.id)}</span>${editing ? renderVoiceInlineEdit(preset, isDefault) : ''}</div>`;
  }).join('');
  lakeVoiceFlash = '';
  const body = `<div class="voice-section-heading"><p class="voice-kicker">${esc(t('全部声音'))}<i>${presets.length}</i></p>${iconButton('plus', t('添加声音'), 'voice.add')}</div><div class="lake-voice-list">${rows}</div>`;
  return bodyOnly ? body : `<section class="voice-all" id="voice-management">${body}</section>`;
}
function renderVoicesSettings() {
  if (['voice-add', 'service', 'qr'].includes(editor?.type)) return renderLakeVoiceAdd();
  const presets = snapshot.presets || [];
  const preferred = presets.find(item => item.id === snapshot.rules?.default_preset_id);
  if (!presets.length) return `<div class="lake-voices-page"><section class="voice-empty"><span class="voice-empty-line" aria-hidden="true"></span><h2>${esc(t('还没有声音'))}</h2><p>${esc(t('挑一个你喜欢的声音，让弹幕有声音。'))}</p>${button(t('添加声音'), 'voice.add', { class: 'primary' })}</section><p class="voice-page-foot with-action"><span>${esc(t('不读弹幕也能照常显示。'))}</span>${button(t('播放测试音'), 'audio.test', { class: 'quiet' })}</p></div>`;
  return `<div class="lake-voices-page">${renderVoiceAudition(presets, preferred)}${renderVoiceManagement(presets, preferred)}</div>`;
}
function lakeVoiceCatalog(provider) {
  const connection = serviceConnection(provider);
  if (provider === 'doubao') return (snapshot.doubao_voices || []).map(voice => ({key:voice.id || voice.voice_id || voice.value,name:voice.name || voice.label,provider,connectionId:connection?.id}));
  if (provider === 'gpt_sovits') return (modelScan.pairs || []).map((pair,index) => ({key:String(index),name:pair.name,provider,connectionId:connection?.id,pair}));
  if (provider === 'dots') return referenceProfiles.filter(entry => entry.profile?.role?.kind === 'dots').map(entry => ({key:entry.profile.role.role,name:entry.profile.role.role,provider,connectionId:connection?.id}));
  return (snapshot.presets || []).filter(preset => preset.provider === provider).map(preset => ({key:preset.voice_id,name:presetLabel(preset),provider,connectionId:connection?.id,preset}));
}
function lakeCatalogAdded(item) {
  return (snapshot.presets || []).find(preset => preset.provider === item.provider && preset.connection_id === item.connectionId && (item.pair ? preset.sovits?.gpt_weights_path === item.pair.gpt_path && preset.sovits?.sovits_weights_path === item.pair.sovits_path : preset.voice_id === item.key));
}
// ---------- Voices: one add page with the four services as tabs ----------
// A service that is not connected yet is connected in place, and adding continues
// on the same page; nothing sends the streamer back to a list to start over.
const voiceProviders = ['doubao', 'fish_audio', 'gpt_sovits', 'dots'];
let lakeVoiceTab = '';
let lakeVoiceDraft = {};
let lakeVoiceFlash = '';
let lakeFishLookupTimer = null;
let lakeFishLookupRevision = 0;
let lakeReferenceLoad = 0;

function lakeProviderConfigured(provider) {
  const connection = serviceConnection(provider);
  if (!connection) return false;
  if (provider === 'doubao' || provider === 'fish_audio') return !!connection.has_credential;
  const service = localServiceState(provider, connection);
  return !!service.directory || (!!service.state && !['unconfigured', 'unknown'].includes(service.state));
}

function lakeProviderRunning(provider) {
  return !['gpt_sovits', 'dots'].includes(provider) || ['ready', 'external'].includes(localServiceState(provider).state);
}

function defaultVoiceTab() {
  if (voiceProviders.includes(lakeVoiceTab)) return lakeVoiceTab;
  const preferred = (snapshot.presets || []).find(item => item.id === snapshot.rules?.default_preset_id);
  if (preferred && voiceProviders.includes(preferred.provider)) return preferred.provider;
  return voiceProviders.find(lakeProviderConfigured) || 'doubao';
}

function renderVoiceProviderTabs(current) {
  const dot = provider => !lakeProviderConfigured(provider) ? '' : `<i class="voice-tab-dot${lakeProviderRunning(provider) ? '' : ' off'}" aria-hidden="true"></i>`;
  return `<nav class="voice-provider-tabs" role="tablist" aria-label="${esc(t('声音服务'))}">${voiceProviders.map(provider => `<button type="button" role="tab" aria-selected="${provider === current}" data-action="voice.provider" data-id="${provider}">${esc(providerLabel(provider))}${dot(provider)}</button>`).join('')}</nav>`;
}

function renderLakeVoiceAdd() {
  const provider = voiceProviders.includes(editor?.provider) ? editor.provider : defaultVoiceTab();
  lakeVoiceTab = provider;
  const connection = serviceConnection(provider);
  const connecting = editor?.type === 'qr' || editor?.type === 'service' || !lakeProviderConfigured(provider);
  const body = connecting ? renderVoiceConnect(provider, connection)
    : provider === 'doubao' ? renderVoiceAddDoubao(connection)
      : provider === 'fish_audio' ? renderVoiceAddFish()
        : provider === 'gpt_sovits' ? renderVoiceAddSovits(connection)
          : renderVoiceAddDots();
  return `<div class="lake-voices-page voice-add-page" data-provider="${provider}">${renderVoiceProviderTabs(provider)}${body}</div>`;
}

function renderVoiceAddHead(title, provider) {
  return `<header class="voice-add-head"><h2>${esc(title)}</h2>${button(t('连接设置'), 'service.configure', { id: provider, class: 'quiet' })}</header>`;
}

function renderReferenceFile(path, id) {
  const name = path ? String(path).split(/[\\/]/).at(-1) : '';
  return `<button type="button" class="voice-file-row${name ? ' chosen' : ''}" data-action="voice.reference.pick" data-id="${esc(id)}" title="${esc(path || '')}">${voiceWaveMarkup(!name)}<span class="voice-file-text"><small>${esc(t('参考音频'))}</small><span>${esc(name || t('选一段参考音频'))}</span></span><span class="voice-file-action">${esc(t(name ? '更换' : '选择'))}</span></button>`;
}

function renderVoiceNameField(value) {
  return `<label class="voice-field"><small>${esc(t('名字'))}</small><input data-voice-draft="name" value="${esc(value)}" maxlength="100" spellcheck="false"></label>`;
}

// Doubao: listening is a click on the row, adding is the word on its right.
function renderVoiceAddDoubao(connection) {
  const catalog = lakeVoiceCatalog('doubao');
  const query = lakeVoiceQuery.toLocaleLowerCase();
  const rows = catalog.map(item => {
    const added = lakeCatalogAdded(item);
    const hidden = query && !`${item.name || ''} ${item.key}`.toLocaleLowerCase().includes(query);
    return `<div class="voice-catalog-row${added ? ' added' : ''}"${hidden ? ' hidden' : ''}><button type="button" class="voice-catalog-pick" data-action="voice.catalog.preview" data-id="${esc(item.key)}" title="${esc(t('试听'))}">${voiceWaveMarkup()}<span>${esc(item.name || item.key)}</span></button>${added ? `<small>${esc(t('已添加'))}</small>` : button(t('添加'), 'voice.catalog.add', { id: item.key })}</div>`;
  }).join('');
  const search = catalog.length > 8 ? `<label class="voice-search">${icon('search')}<input type="search" data-voice-search value="${esc(lakeVoiceQuery)}" placeholder="${esc(t('搜索声音'))}" aria-label="${esc(t('搜索声音'))}"></label>` : '';
  return `<section class="voice-add">${renderVoiceAddHead(t('挑一个声音'), 'doubao')}${search}<div class="voice-catalog-list">${rows || `<div class="voice-add-empty">${voiceWaveMarkup(true)}<p>${esc(t('豆包还没有返回可用的声音，稍后再试。'))}</p></div>`}</div></section>`;
}

// Fish Audio has no browsable list here: a voice page link is pasted, its name is
// looked up as soon as it looks complete, and it can be heard before adding.
function renderVoiceAddFish() {
  return `<section class="voice-add">${renderVoiceAddHead(t('收藏一个 Fish 声音'), 'fish_audio')}<p class="voice-add-lead">${esc(t('在 Fish Audio 找到喜欢的声音，把页面链接贴到这里。'))} ${button(t('去找声音'), 'fish.open_discovery', { class: 'quiet', icon: 'external' })}</p><label class="voice-field"><small>${esc(t('声音链接或 ID'))}</small><input data-voice-draft="fish" value="${esc(lakeVoiceDraft.fish || '')}" placeholder="https://fish.audio/m/…" autocomplete="off" spellcheck="false"></label><div class="voice-fish-result" data-fish-result>${renderFishResult()}</div></section>`;
}

function renderFishResult() {
  const draft = lakeVoiceDraft;
  if (draft.fishState === 'looking') return `<p class="voice-status waking"><i aria-hidden="true"></i>${esc(t('正在查找…'))}</p>`;
  if (draft.fishState === 'error') return `<p class="voice-status error">${esc(draft.fishError || '')}</p>`;
  if (!draft.fishFound) return '';
  return `<div class="voice-found">${voiceWaveMarkup()}<span>${esc(draft.fishFound.name)}</span>${iconButton('play', t('试听'), 'voice.fish.preview')}</div>${renderVoiceNameField(draft.name ?? draft.fishFound.name)}<div class="voice-add-actions">${button(t('添加'), 'voice.fish.add', { class: 'primary' })}</div>`;
}

// GPT-SoVITS: pick a model, then the reference audio right under it.
function renderVoiceAddSovits(connection) {
  const pairs = modelScan.pairs || [];
  const rows = pairs.map((pair, index) => {
    const item = { provider: 'gpt_sovits', connectionId: connection?.id, pair, key: String(index) };
    const added = lakeCatalogAdded(item);
    const chosen = !added && lakeVoiceChoice === String(index);
    return `<div class="voice-catalog-row${chosen ? ' selected' : ''}${added ? ' added' : ''}"><button type="button" class="voice-catalog-pick" data-action="${added ? 'voice.added.edit' : 'voice.catalog.pick'}" data-id="${added ? esc(added.id) : index}" aria-expanded="${chosen}">${voiceWaveMarkup()}<span>${esc(pair.name)}<small>${esc(pair.version || '')}</small></span></button>${added ? `<small>${esc(t('已添加'))}</small>` : ''}${chosen ? renderSovitsDraft(pair) : ''}</div>`;
  }).join('');
  const empty = modelScan.error
    ? `<p class="voice-status error">${esc(modelScan.error)}</p>`
    : `<div class="voice-add-empty">${voiceWaveMarkup(true)}<p>${esc(t('安装目录里还没找到成对的模型。'))}</p></div>`;
  return `<section class="voice-add"><header class="voice-add-head"><h2>${esc(t('选一个角色模型'))}</h2>${button(t('重新查找'), 'voice.models.refresh', { class: 'quiet', icon: 'refresh' })}</header><div class="voice-catalog-list">${rows || empty}</div><footer class="voice-add-foot">${button(t('连接设置'), 'service.configure', { id: 'gpt_sovits', class: 'quiet' })}</footer></section>`;
}

function sovitsDraftReady() {
  const draft = lakeVoiceDraft;
  return !!draft.audio_path && (draft.text_free || !!String(draft.reference_text || '').trim()) && !!String(draft.name || '').trim();
}

function renderSovitsDraft(pair) {
  const draft = lakeVoiceDraft;
  return `<div class="voice-draft">${renderReferenceFile(draft.audio_path, '')}<label class="voice-field"><small>${esc(t('参考文本'))}</small><input data-voice-draft="reference_text" value="${esc(draft.reference_text || '')}" placeholder="${esc(t('参考音频里说的话'))}" maxlength="8192"${draft.text_free ? ' disabled' : ''}></label><label class="voice-check"><input type="checkbox" data-voice-draft="text_free"${draft.text_free ? ' checked' : ''}><span>${esc(t('不用参考文本'))}</span></label>${renderVoiceNameField(draft.name ?? pair.name)}<div class="voice-add-actions">${button(t('添加'), 'voice.sovits.add', { class: 'primary', disabled: !sovitsDraftReady() })}</div></div>`;
}

// dots.tts: one recording makes a voice.
function dotsDraftReady() { return !!lakeVoiceDraft.audio_path && !!String(lakeVoiceDraft.name || '').trim(); }
function renderVoiceAddDots() {
  const draft = lakeVoiceDraft;
  return `<section class="voice-add">${renderVoiceAddHead(t('用一段录音做一个声音'), 'dots')}<p class="voice-add-lead">${esc(t('选一段几秒钟、只有一个人说话的录音。'))}</p><div class="voice-draft">${renderReferenceFile(draft.audio_path, '')}<label class="voice-field"><small>${esc(t('参考文本（可选）'))}</small><input data-voice-draft="reference_text" value="${esc(draft.reference_text || '')}" placeholder="${esc(t('录音里说的话'))}" maxlength="8192"></label>${renderVoiceNameField(draft.name || '')}<div class="voice-add-actions">${button(t('添加'), 'voice.dots.add', { class: 'primary', disabled: !dotsDraftReady() })}</div></div></section>`;
}

function renderVoiceConnect(provider, connection) {
  if (provider === 'doubao') {
    const scanning = editor?.type === 'qr';
    return `<section class="voice-connect"><h2>${esc(t('连接豆包'))}</h2><p class="voice-add-lead">${esc(t('用豆包 App 扫码，在手机上确认登录。'))}</p>${scanning ? `${qrMarkup('doubao', true)}<p class="lake-note"><button type="button" class="text-button" data-action="qr.retry">${esc(t('换一张'))}</button></p>` : `<div class="voice-add-actions">${button(t('扫码连接'), 'voice.doubao.connect', { id: connection?.id || '', class: 'primary' })}</div>`}<p class="voice-note">${esc(t('登录只存在这台电脑上，不会跟着备份导出。'))}</p></section>`;
  }
  if (provider === 'fish_audio') {
    return `<section class="voice-connect"><h2>${esc(t('连接 Fish Audio'))}</h2><p class="voice-add-lead">${esc(t('在 Fish Audio 新建一个 API 密钥，复制到这里。'))} ${button(t('打开密钥页面'), 'fish.open_keys', { class: 'quiet', icon: 'external' })}</p><form data-form="service-fish">${field('credential', t('API 密钥'), '', 'type="password" required autocomplete="off" spellcheck="false"')}<p class="voice-note">${esc(t('只存在这台电脑上，不会被导出。'))}</p><div class="voice-add-actions">${saveButton(t('连接'))}</div></form></section>`;
  }
  // A local service needs its install folder; connecting starts it and lists its voices.
  const service = localServiceState(provider, connection);
  const directory = service.directory || '';
  const starting = service.state === 'starting';
  const failed = service.state === 'failed' && service.message;
  return `<section class="voice-connect"><h2>${esc(t('连接'))} ${esc(providerLabel(provider))}</h2><p class="voice-add-lead">${esc(t('选一下它在这台电脑上的安装目录。'))}</p><form data-form="service-local" data-provider="${provider}">${pathField('directory', t('安装目录'), directory, 'service.pick_directory', t('选择安装目录'))}${autoStatus()}</form><div class="voice-add-actions">${button(t(starting ? '正在启动…' : '连接'), 'voice.local.connect', { id: provider, class: 'primary', disabled: !directory || starting })}</div>${failed ? `<p class="voice-status error" data-service-message>${esc(service.message)}</p>` : ''}</section>`;
}

// Inline edit: what matters first (the name, and for local voices the reference
// recording), then speed and volume as quiet waterlines, then two word actions.
function renderVoiceReference(preset) {
  const role = referenceRole(preset.provider, preset, null);
  const profile = currentReference(role)?.profile || {};
  const text = profile.text_free ? '' : profile.reference_text ?? preset.sovits?.reference_text ?? '';
  return `<div class="voice-reference" data-reference-preset="${esc(preset.id)}">${renderReferenceFile(profile.audio_path || '', preset.id)}${preset.provider === 'gpt_sovits' ? `<label class="voice-field"><small>${esc(t('参考文本'))}</small><input data-reference-text value="${esc(text)}" placeholder="${esc(profile.text_free ? t('不用参考文本') : t('参考音频里说的话'))}" maxlength="8192" spellcheck="false"></label>` : ''}</div>`;
}

function renderVoiceInlineEdit(preset, isDefault) {
  const local = ['gpt_sovits', 'dots'].includes(preset.provider);
  return `<form data-form="lake-voice-edit" data-id="${esc(preset.id)}" class="voice-inline-edit"><label class="voice-field"><small>${esc(t('名字'))}</small><input name="name" value="${esc(presetLabel(preset))}" required maxlength="100" spellcheck="false"></label>${local ? renderVoiceReference(preset) : ''}<div class="voice-tuning">${voiceWaterline('speed', t('语速'), preset.speed ?? 1, .5, 2, '×')}${voiceWaterline('volume', t('音量'), preset.volume ?? 1, 0, 2, '')}</div>${autoStatus()}<div class="voice-edit-actions"><span class="voice-edit-default"${isDefault ? '' : ' hidden'}>${esc(t('这是默认声音'))}</span><button type="button" class="button" data-action="voice.default" data-id="${esc(preset.id)}"${isDefault ? ' hidden' : ''}>${esc(t('设为默认'))}</button>${button(t('删除这个声音'), 'voice.remove', { id: preset.id, class: 'danger' })}</div></form>`;
}

async function loadReferenceProfiles(connectionId) {
  const load = ++lakeReferenceLoad;
  const listed = await command('references.list', { connection_id: connectionId }, { quiet: true, silent: true });
  if (load !== lakeReferenceLoad) return false;
  referenceProfiles = Array.isArray(listed.result) ? listed.result : [];
  return true;
}

// The file name of a GPT-SoVITS reference usually is its transcript ("角色_今天也要加油哦.wav").
function referenceTextFromFile(path) {
  const stem = String(path).split(/[\\/]/).at(-1).replace(/\.[^.]+$/, '');
  const text = stem.includes('_') ? stem.slice(stem.lastIndexOf('_') + 1) : stem;
  return /[㐀-鿿]/u.test(text) ? text.trim() : '';
}

async function pickReferenceAudio() {
  const pick = window.__TAURI__?.dialog?.open;
  if (!pick) throw new Error(t('文件选择器不可用，请重新打开应用。'));
  const path = await pick({ multiple: false, title: t('选择参考音频'), filters: [{ name: t('音频'), extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }] });
  return typeof path === 'string' ? path : '';
}

// Keep changes to the same voice in order, including edits made while a save
// is still running. Each write starts from the preceding saved profile.
const voiceReferenceSaves = new Map();
function saveVoiceReference(preset, changes) {
  const previous = voiceReferenceSaves.get(preset.id) || Promise.resolve();
  const captured = { ...changes };
  const identity = { id: preset.id, provider: preset.provider, connection_id: preset.connection_id, role: referenceRole(preset.provider, preset, null) };
  const operation = previous.catch(() => {}).then(() => persistVoiceReference(identity, captured));
  voiceReferenceSaves.set(preset.id, operation);
  return operation.finally(() => {
    if (voiceReferenceSaves.get(preset.id) === operation) voiceReferenceSaves.delete(preset.id);
  });
}

async function persistVoiceReference(identity, changes) {
  // A queued recording edit must keep names and tuning saved while it waited,
  // and must never recreate a voice deleted or moved to another role meanwhile.
  const preset = snapshot.presets.find(item => item.id === identity.id);
  const role = preset && referenceRole(preset.provider, preset, null);
  if (!preset || preset.provider !== identity.provider || preset.connection_id !== identity.connection_id || JSON.stringify(role) !== JSON.stringify(identity.role)) throw new Error(t('请重新打开声音设置。'));
  if (!role) throw new Error(t('找不到这个声音的模型，请重新添加。'));
  const current = currentReference(role)?.profile || {};
  const profile = { connection_id: preset.connection_id, role, audio_path: current.audio_path || '', reference_text: current.reference_text || '', reference_language: current.reference_language || (preset.provider === 'gpt_sovits' ? 'auto' : ''), text_language: current.text_language || (preset.provider === 'gpt_sovits' ? 'auto' : ''), text_free: preset.provider === 'gpt_sovits' && !!current.text_free, ...changes };
  if (!profile.audio_path) throw new Error(t('请先选择参考音频。'));
  if (preset.provider === 'dots') await command('dots.voice.save', { preset, profile, make_preferred: false }, { quiet: true, silent: true });
  else await command('references.save', { profile }, { quiet: true, silent: true });
  await loadReferenceProfiles(preset.connection_id);
}

function refreshVoiceDraftState() {
  const sovits = settingsDialog.querySelector('[data-action="voice.sovits.add"]');
  if (sovits) sovits.disabled = !sovitsDraftReady();
  const dots = settingsDialog.querySelector('[data-action="voice.dots.add"]');
  if (dots) dots.disabled = !dotsDraftReady();
  const text = settingsDialog.querySelector('.voice-draft [data-voice-draft="reference_text"]');
  if (text && editor?.provider === 'gpt_sovits') text.disabled = !!lakeVoiceDraft.text_free;
}

function scheduleFishLookup() {
  clearTimeout(lakeFishLookupTimer);
  const value = String(lakeVoiceDraft.fish || '').trim();
  const revision = ++lakeFishLookupRevision;
  const result = () => settingsDialog.querySelector('[data-fish-result]');
  if (!/fish\.audio\/|^[0-9a-f]{32}$/i.test(value)) {
    lakeVoiceDraft.fishState = ''; lakeVoiceDraft.fishFound = null;
    const node = result(); if (node) node.innerHTML = '';
    return;
  }
  lakeFishLookupTimer = setTimeout(async () => {
    lakeVoiceDraft.fishState = 'looking'; lakeVoiceDraft.fishFound = null;
    const node = result(); if (node) node.innerHTML = renderFishResult();
    try {
      const found = await command('fish.voice.lookup', { connection_id: serviceConnection('fish_audio')?.id, id_or_url: value }, { quiet: true, silent: true });
      if (revision !== lakeFishLookupRevision) return;
      const name = String(found.result?.name || '').slice(0, 100).trim();
      lakeVoiceDraft.fishFound = { voice_id: found.result?.voice_id || value, name: name || t('Fish 声音') };
      lakeVoiceDraft.name = lakeVoiceDraft.fishFound.name;
      lakeVoiceDraft.fishState = '';
    } catch (error) {
      if (revision !== lakeFishLookupRevision) return;
      lakeVoiceDraft.fishState = 'error'; lakeVoiceDraft.fishError = errorMessage(error);
    }
    const next = result(); if (next) next.innerHTML = renderFishResult();
  }, 450);
}

async function finishVoiceAdd(id, name) {
  lakeVoiceDraft = {}; lakeVoiceChoice = ''; lakeVoiceFlash = id || '';
  editor = null; lakeVoiceEditId = '';
  renderSettings();
  showToast(ui`已添加「${name}」`);
}
async function selectLakeVoiceProvider(provider) {
  if (!await allowLeaveSettings()) return;
  if (qrProvider) await cancelQr();
  const connection = serviceConnection(provider);
  lakeVoiceQuery = ''; lakeVoiceChoice = ''; lakeVoiceDraft = {}; lakeVoiceTab = provider;
  editor = { type: 'voice-add', provider, connectionId: connection?.id };
  if (['gpt_sovits', 'dots'].includes(provider) && lakeProviderConfigured(provider)) {
    referenceProfiles = []; modelScan = { pairs: [], issues: [] }; renderSettings();
    if (!await loadVoiceEditorData(connection.id)) return;
  }
  renderSettings();
}

async function handleLakeVoiceAction(action, id, target) {
  if (action === 'voice.add') {
    if (!await allowLeaveSettings()) return true;
    lakeVoiceEditId = '';
    await selectLakeVoiceProvider(defaultVoiceTab());
    return true;
  }
  if (action === 'voice.provider') { await selectLakeVoiceProvider(id); return true; }
  if (action === 'voice.edit' || action === 'voice.added.edit') {
    if (!await flushAutosaves(true)) return true;
    const preset = snapshot.presets.find(item => item.id === id);
    const opening = action === 'voice.added.edit' || lakeVoiceEditId !== id;
    editor = null; lakeVoiceEditId = opening ? id : '';
    if (opening && preset && ['gpt_sovits', 'dots'].includes(preset.provider)) {
      try { await loadReferenceProfiles(preset.connection_id); } catch { /* The row still opens; the recording shows as not chosen. */ }
    }
    renderSettings();
    if (opening) settingsDialog.querySelector(`[data-voice-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (action === 'voice.preview') { if (!await flushAutosaves()) return true; if (!snapshot.presets.some(p => p.id === id)) return true; await command('audition', { preset_id: id, text: voiceAuditionDraft.text }, { success: t('试听已加入播放队列') }); return true; }
  if (action === 'voice.default') { if (!await flushAutosaves()) return true; await settleVoiceAuditionChoice(); await command('presets.default', { id }); updateVoiceSettings(); return true; }
  if (action === 'voice.remove') {
    if (!await flushAutosaves()) return true;
    if (!await confirmAction(t('删除这个声音？'), t('观众绑定和播报规则仍在使用时，需要先解除引用。'), t('删除'))) return true;
    await command('presets.remove', { id, confirmed: true }); lakeVoiceEditId = ''; renderSettings(); return true;
  }
  if (action === 'voice.catalog.pick') {
    const pair = (modelScan.pairs || [])[Number(id)];
    if (lakeVoiceChoice === id) { lakeVoiceChoice = ''; renderSettings(); return true; }
    lakeVoiceChoice = id;
    // A model that already has a remembered recording starts from it.
    const saved = pair ? currentReference(referenceRole('gpt_sovits', {}, pair))?.profile : null;
    lakeVoiceDraft = { name: pair?.name || '', audio_path: saved?.audio_path || '', reference_text: saved?.reference_text || '', text_free: !!saved?.text_free };
    renderSettings(); return true;
  }
  if (action === 'voice.catalog.add' || action === 'voice.catalog.preview') {
    const item = lakeVoiceCatalog(editor?.provider).find(entry => entry.key === id); if (!item) return true;
    const added = lakeCatalogAdded(item);
    if (action.endsWith('.preview')) {
      if (added) await command('audition', { preset_id: added.id, text: voiceAuditionDraft.text });
      else await command('audition.catalog', { connection_id: item.connectionId, voice_id: item.key, text: voiceAuditionDraft.text });
      return true;
    }
    if (added) return true;
    const saved = await command('presets.save', { preset: { id: '', name: item.name, connection_id: item.connectionId, provider: item.provider, voice_id: item.key, speed: 1, volume: 1, sovits: null } });
    // Several Doubao voices are often added in a row, so the list stays open.
    renderSettings();
    showToast(ui`已添加「${item.name}」`);
    return true;
  }
  if (action === 'voice.models.refresh') {
    const connection = serviceConnection('gpt_sovits');
    if (connection && await loadVoiceEditorData(connection.id)) renderSettings();
    return true;
  }
  if (action === 'voice.reference.pick') {
    const path = await pickReferenceAudio(); if (!path) return true;
    if (id) {
      const preset = snapshot.presets.find(item => item.id === id); if (!preset) return true;
      const changes = { audio_path: path };
      const text = settingsDialog.querySelector(`[data-reference-preset="${CSS.escape(id)}"] [data-reference-text]`)?.value.trim();
      if (preset.provider === 'gpt_sovits') {
        const guess = text || referenceTextFromFile(path);
        if (guess) { changes.reference_text = guess; changes.text_free = false; }
      }
      await saveVoiceReference(preset, changes);
      renderSettings();
      showToast(t('参考音频已更换'));
      return true;
    }
    lakeVoiceDraft.audio_path = path;
    if (!String(lakeVoiceDraft.reference_text || '').trim()) lakeVoiceDraft.reference_text = referenceTextFromFile(path);
    if (editor?.provider === 'dots' && !String(lakeVoiceDraft.name || '').trim()) lakeVoiceDraft.name = String(path).split(/[\\/]/).at(-1).replace(/\.[^.]+$/, '').slice(0, 100);
    renderSettings(); return true;
  }
  if (action === 'voice.sovits.add') {
    const pair = (modelScan.pairs || [])[Number(lakeVoiceChoice)];
    const connection = serviceConnection('gpt_sovits');
    if (!pair || !connection || !sovitsDraftReady()) return true;
    const draft = lakeVoiceDraft;
    const name = String(draft.name).trim();
    const reference_text = draft.text_free ? '' : String(draft.reference_text || '').trim();
    const saved = await command('presets.save', { preset: { id: '', name, connection_id: connection.id, provider: 'gpt_sovits', voice_id: pair.name, speed: 1, volume: 1, sovits: { model_selection: 'per_request_atomic', gpt_weights_path: pair.gpt_path, sovits_weights_path: pair.sovits_path, reference_text, reference_text_free: !!draft.text_free } } }, { quiet: true, silent: true });
    await command('references.save', { profile: { connection_id: connection.id, role: { kind: 'gpt_sovits', gpt_weights_path: pair.gpt_path, sovits_weights_path: pair.sovits_path }, audio_path: draft.audio_path, reference_text, reference_language: 'auto', text_language: 'auto', text_free: !!draft.text_free } }, { quiet: true, silent: true });
    await finishVoiceAdd(saved?.result?.id, name);
    return true;
  }
  if (action === 'voice.fish.preview') {
    const found = lakeVoiceDraft.fishFound; const connection = serviceConnection('fish_audio');
    if (found && connection) await command('audition.catalog', { connection_id: connection.id, voice_id: found.voice_id, text: voiceAuditionDraft.text });
    return true;
  }
  if (action === 'voice.fish.add') {
    const found = lakeVoiceDraft.fishFound; const connection = serviceConnection('fish_audio');
    if (!found || !connection) return true;
    const name = String(lakeVoiceDraft.name || found.name).trim().slice(0, 100) || found.name;
    const saved = await command('fish.voice.save', { connection_id: connection.id, id_or_url: lakeVoiceDraft.fish.trim(), name }, { quiet: true, silent: true });
    await finishVoiceAdd(saved?.result?.id, name);
    return true;
  }
  if (action === 'voice.dots.add') {
    const connection = serviceConnection('dots');
    if (!connection || !dotsDraftReady()) return true;
    const draft = lakeVoiceDraft;
    const name = String(draft.name).trim();
    const voiceId = `dots-${crypto.randomUUID()}`;
    const preset = { id: '', name, connection_id: connection.id, provider: 'dots', voice_id: voiceId, speed: 1, volume: 1, sovits: null };
    const profile = { connection_id: connection.id, role: { kind: 'dots', role: voiceId }, audio_path: draft.audio_path, reference_text: String(draft.reference_text || '').trim(), reference_language: '', text_language: '', text_free: false };
    const saved = await command('dots.voice.save', { preset, profile, make_preferred: false }, { quiet: true, silent: true });
    await finishVoiceAdd(saved?.result?.id, name);
    return true;
  }
  if (action === 'voice.doubao.connect') {
    editor = { type: 'qr', provider: 'doubao', id: id || '', returnTo: 'voice-add' };
    renderSettings(); await startQr('doubao', id || undefined); return true;
  }
  if (action === 'voice.local.connect') {
    if (!await flushAutosaves()) return true;
    await command('local_services.start', { provider: id, connection_id: serviceConnection(id)?.id });
    await selectLakeVoiceProvider(id); return true;
  }
  return false;
}

function installLakeVoiceEvents() {
  autoFormTypes.add('lake-voice-edit');
  document.addEventListener('input', event => {
    const input = event.target;
    if (input.matches('[data-waterline-suffix]')) {
      input.style.setProperty('--fill', `${100 * (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))}%`);
      input.parentElement.querySelector('output').textContent = input.dataset.waterlineSuffix === '×' ? `${Number(input.value).toFixed(1)}×` : String(Math.round(Number(input.value) * 100));
    }
    if (input.matches('[data-voice-search]')) {
      lakeVoiceQuery = input.value;
      const query = lakeVoiceQuery.toLocaleLowerCase();
      const catalog = lakeVoiceCatalog(editor?.provider);
      for (const row of settingsDialog.querySelectorAll('.voice-catalog-row')) {
        const key = row.querySelector('.voice-catalog-pick')?.dataset.id;
        const item = catalog.find(entry => entry.key === key);
        row.hidden = !!query && !`${item?.name || ''} ${key}`.toLocaleLowerCase().includes(query);
      }
    }
    if (input.matches('[data-voice-draft]')) {
      const key = input.dataset.voiceDraft;
      lakeVoiceDraft[key] = input.type === 'checkbox' ? input.checked : input.value;
      if (key === 'fish') scheduleFishLookup();
      refreshVoiceDraftState();
    }
  });
  settingsDialog.addEventListener('change', event => {
    const input = event.target;
    if (!input.matches('[data-reference-text]')) return;
    const preset = snapshot.presets.find(item => item.id === input.closest('[data-reference-preset]')?.dataset.referencePreset);
    if (!preset) return;
    const reference_text = input.value.trim();
    void saveVoiceReference(preset, { reference_text, text_free: !reference_text && !!currentReference(referenceRole(preset.provider, preset, null))?.profile?.text_free })
      .then(() => showToast(t('参考文本已保存')))
      .catch(error => showToast(errorMessage(error), true));
  });
}

function updateVoiceAudition(form) {
  const provider = form.dataset.provider;
  const voices = (snapshot.presets || []).filter(preset => preset.provider === provider);
  const voice = form.elements.preset_id;
  voice.disabled = !voices.length;
  voiceAuditionDraft.provider = provider;
  voiceAuditionDraft.presetId = voice.value;
  if (voiceAuditionDraft.text !== form.elements.text.value) voiceAuditionDraft.customText = true;
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
  const pending = voiceAuditionDefaultSave;
  try {
    await pending;
    return true;
  } catch {
    return false;
  } finally {
    if (voiceAuditionDefaultSave === pending) {
      voiceAuditionDefaultSave = Promise.resolve();
      voiceAuditionRevision++;
    }
  }
}

async function flushExitEdits() {
  // Exit is one action: flush pending automatic saves, but never prompt about
  // an unsubmitted form or keep an owned service running because a save failed.
  exitFlushing = true;
  try { await Promise.allSettled([volumeSave.flush(), flushViewerAlias(), settleVoiceAuditionChoice(), flushAutosaves()]); }
  finally { exitFlushing = false; }
  return true;
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

let voiceEditorLoadRevision = 0;
async function loadVoiceEditorData(connectionId) {
  const revision = ++voiceEditorLoadRevision;
  const openedEditor = editor;
  const selectedConnection = editor?.connectionId;
  const opened = settingsDialog.open;
  const tab = settingsTab;
  const current = () => revision === voiceEditorLoadRevision && editor === openedEditor
    && editor?.connectionId === selectedConnection && settingsDialog.open === opened && settingsTab === tab;
  modelScan = { pairs: [], issues: [] };
  referenceProfiles = [];
  const connection = snapshot.connections.find(item => item.id === connectionId);
  if (!connection || !['dots', 'gpt_sovits'].includes(connection.settings.provider)) return true;
  const profiles = await command('references.list', { connection_id: connectionId }, { quiet: true });
  if (!current()) return false;
  referenceProfiles = Array.isArray(profiles.result) ? profiles.result : [];
  if (connection.settings.provider === 'gpt_sovits') {
    const directory = snapshot.local_services?.gpt_sovits?.directory;
    if (directory) {
      try {
        const scan = await command('models.scan', { path: directory }, { quiet: true, silent: true });
        if (!current()) return false;
        modelScan = scan.result || modelScan;
      } catch (error) { if (!current()) return false; modelScan.error = errorMessage(error); }
    }
  }
  return current();
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

let lakeAdvancedSection = '';
let lakeReadingsSearch = '';
let lakeTemplateRange = null;
const lakeTemplateDefaults = { danmaku: '"{user_name}"说:"{message}"', gift: '"{user_name}"赠送了{gift_num}个{gift_name}', super_chat: '"{user_name}"发送了一条醒目留言，他说"{message}"', guard: '感谢"{user_name}"赠送的{guard_name}' };
const lakeTokenLabels = { user_name: '名字', message: '内容', gift_name: '礼物', gift_num: '数量', price: '金额', guard_name: '舰长' };

function lakeMiniWave() { return '<svg class="lake-mini-wave" viewBox="0 0 40 20" aria-hidden="true"><path d="M1 10h5m2 0 3-6 4 12 4-14 4 16 4-12 4 8 3-4h5"/></svg>'; }

function lakeReadingRows() {
  const bindings = snapshot.bindings || [];
  const used = new Set();
  const rows = (snapshot.rules.user_words || []).map(row => {
    const record = bindings.find(item => !item.binding.user_id && item.binding.user_name === row.from);
    if (record) used.add(record.id);
    return { kind: 'user_words', ...row, bindingId: record?.id, binding: record?.binding };
  });
  for (const record of bindings) if (!used.has(record.id)) rows.push({ kind: 'user_words', from: record.binding.user_name || record.binding.legacy_user_name || `UID ${record.binding.user_id}`, to: '', bindingId: record.id, binding: record.binding });
  for (const kind of ['message_words', 'emote_words']) for (const row of snapshot.rules[kind] || []) rows.push({ kind, ...row });
  return rows;
}

// Store installs are updated by Microsoft Store on its own, so their version line is
// only a version. The portable GitHub build has no other way to hear about a new
// release: its line doubles as the update check, and the result stays on the line.
function lakeVersionState() {
  if (snapshot.update_channel === 'store') return { state: 'store', hint: t('由 Microsoft Store 自动更新'), title: '' };
  if (updateBusy) return { state: 'checking', hint: t('正在检查…'), action: 'update.check', disabled: true, title: '' };
  if (updateInfo?.status === 'available' && updateInfo.download_url) return { state: 'available', hint: `${ui`发现新版本 ${updateInfo.latest_version}`} · ${t('下载新版')}`, action: 'external.open', id: 'update_download', title: t('下载后解压 ZIP，退出程序，再用新版 EXE 替换原文件，设置会保留。') };
  const offline = !!snapshot.network_disabled;
  if (updateError) return { state: 'error', hint: t('没查到，再试一次'), action: 'update.check', disabled: offline, title: updateError };
  if (['up_to_date', 'no_release'].includes(updateInfo?.status)) return { state: 'current', hint: updateInfo.status === 'no_release' ? t('暂无正式发布版本') : t('已是最新版本'), action: 'update.check', disabled: offline, title: '' };
  return { state: 'idle', hint: t('检查更新'), action: 'update.check', disabled: offline, title: '' };
}

function lakeVersionRow(logo = false) {
  const view = lakeVersionState();
  const inner = `${logo ? '<img src="./logo.png" width="28" height="28" alt="" draggable="false">' : ''}<span class="lake-version-name">${esc(t('超绝可爱弹幕姬'))}<i>${esc(snapshot.app_version || '—')}</i></span><span class="lake-version-hint" role="status">${esc(view.hint)}</span>`;
  if (!view.action) return `<div class="lake-version" data-state="${view.state}">${inner}</div>`;
  return `<button type="button" class="lake-version" data-state="${view.state}" data-action="${view.action}"${view.id ? ` data-id="${view.id}"` : ''}${view.disabled ? ' disabled' : ''} title="${esc(view.title)}">${inner}</button>`;
}

function updateLakeVersionRows() {
  if (!settingsDialog.open) return;
  const view = lakeVersionState();
  if (!view.action) return;
  for (const node of settingsDialog.querySelectorAll('button.lake-version')) {
    node.dataset.state = view.state; node.dataset.action = view.action; node.disabled = !!view.disabled; node.title = view.title;
    if (view.id) node.dataset.id = view.id; else delete node.dataset.id;
    const hint = node.querySelector('.lake-version-hint');
    if (hint && hint.textContent !== view.hint) hint.textContent = view.hint;
  }
}

function renderLakeSettingsHome() {
  const identity = headerIdentity(snapshot);
  const voice = snapshot.presets.find(item => item.id === snapshot.rules?.default_preset_id);
  const count = lakeReadingRows().length;
  const row = (id, graphic, title, detail) => `<button type="button" class="lake-home-row" data-action="settings.tab" data-id="${id}"><span class="lake-home-graphic">${graphic}</span><span class="lake-home-text"><strong>${esc(t(title))}</strong><small>${esc(detail)}</small></span>${icon('arrow')}</button>`;
  const minor = (id, title) => `<button type="button" class="lake-home-minor" data-action="settings.tab" data-id="${id}"><span>${esc(t(title))}</span>${icon('arrow')}</button>`;
  const avatar = `<span class="s-avatar color-${identityColor(identity.name)}">${esc(initial(identity.name))}${identity.avatar ? `<img src="${esc(identity.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
  const obsConnected = snapshot.obs?.status?.state === 'ok' || !!snapshot.obs?.status?.connected;
  const obsDetail = obsConnected ? t('已连接') : lakeObsConfigured() ? t('OBS 还没打开') : t('还没连上');
  const warning = snapshot.live?.state === 'session_expired' ? `<button type="button" class="lake-settings-warning" data-action="lake.room.relogin">${esc(t('哔哩哔哩登录已失效 · 重新扫码'))}${icon('arrow')}</button>` : '';
  return `<div class="lake-settings-page lake-home">${warning}<nav class="lake-home-primary" aria-label="${esc(t('设置分类'))}">${row('room', avatar, '直播间', snapshot.account?.user_id ? identity.name : t('还没登录'))}${row('voices', lakeMiniWave(), '声音', `${voice ? presetLabel(voice) : t('还没有默认声音')} · ${snapshot.presets.length}`)}${row('overlay', `<span class="lake-overlay-mini${obsConnected ? ' on' : ''}"><i></i><b></b><b></b><b></b></span>`, 'OBS', obsDetail)}${row('readings', `<i class="lake-home-count">${count}</i>`, '记住的读法', t('观众名字、词和表情'))}</nav><div class="lake-home-foot"><nav class="lake-home-secondary" aria-label="${esc(t('更多设置'))}">${minor('general', '通用')}${minor('advanced', '高级')}</nav><footer class="lake-settings-footer">${lakeVersionRow()}</footer></div></div>`;
}

// 记住的读法 is a single page. A row is edited where it is: no editor page, no
// kind tabs, no save or cancel. It saves itself once complete, on Enter or when
// focus leaves it; Escape puts it back. Nothing ever asks to discard a draft.
const lakeReadingKinds = [['user_words', '观众', '添加观众'], ['message_words', '词', '添加词'], ['emote_words', '表情', '添加表情']];
const lakeReadingCommits = new WeakMap();

function renderLakeReadings() {
  const rows = lakeReadingRows();
  const intro = rows.length ? '' : `<div class="lake-readings-empty"><h3>${esc(t('还没有记住的读法'))}</h3><p>${esc(t('教它几个名字、词和表情，下次就会这样读。'))}</p><div aria-hidden="true"><span>Kinoko7</span>→<strong>${esc(t('蘑菇七'))}</strong><span>yyds</span>→<strong>${esc(t('永远的神'))}</strong><span>☺ doge</span>→<strong>${esc(t('狗头'))}</strong></div></div>`;
  const groups = lakeReadingKinds.map(([kind, label, add]) => {
    const items = rows.filter(row => row.kind === kind);
    return `<section class="lake-reading-group" data-reading-group="${kind}"><h3><span>${esc(t(label))}</span><i data-reading-count>${items.length}</i>${iconButton('plus', t(add), 'lake.reading.add', kind)}</h3>${items.map(lakeReadingRowHtml).join('')}</section>`;
  }).join('');
  return `<div class="lake-settings-page"><div class="lake-readings-search">${icon('search')}<input id="lake-readings-search" type="search" value="${esc(lakeReadingsSearch)}" placeholder="${esc(t('找一个名字、词或表情'))}" aria-label="${esc(t('找一个名字、词或表情'))}"></div>${intro}<div class="lake-reading-list">${groups}</div></div>`;
}

function lakeReadingFind(kind, from) { return lakeReadingRows().find(row => row.kind === kind && row.from === from) || null; }

function lakeReadingMarker(row) {
  if (row.kind === 'user_words') return row.from ? `<i class="lake-reading-dot color-${identityColor(row.from)}"></i>` : '';
  if (row.kind !== 'emote_words') return '';
  const emote = normalizedEvents(snapshot).flatMap(item => item.emotes || []).find(item => item.text === row.from);
  const image = emote && safeMediaUrl(emote.url);
  return image ? `<img src="${esc(image)}" alt="" referrerpolicy="no-referrer">` : '<span>☺</span>';
}

function lakeReadingRowHtml(row) {
  const preset = snapshot.presets.find(item => item.id === row.binding?.preset_id);
  const query = lakeReadingsSearch.toLocaleLowerCase();
  const search = `${row.from} ${row.to} ${preset ? presetLabel(preset) : ''}`.toLocaleLowerCase();
  return `<div class="lake-reading-row" data-kind="${row.kind}" data-from="${esc(row.from)}" data-reading-search="${esc(search)}"${query && !search.includes(query) ? ' hidden' : ''}><button type="button" data-action="lake.reading.edit" aria-label="${esc(t('编辑读法'))}: ${esc(row.from)}"><span class="lake-reading-mark">${lakeReadingMarker(row)}</span><span class="lake-reading-from">${esc(row.from)}</span><span class="lake-reading-arrow">→</span><span class="lake-reading-to">${esc(row.to)}${preset ? `<small>${lakeMiniWave()}${esc(presetLabel(preset))}</small>` : ''}</span></button>${iconButton('close', t('删除这条'), 'lake.reading.delete')}</div>`;
}

// The same four columns as a shown row; only what can change becomes a field.
// A viewer's name and an emote's marker are the row's identity, so an existing
// row only edits its reading (and a viewer's voice).
function lakeReadingEditHtml(row) {
  const fresh = !!row.fresh;
  const named = { user_words: '观众名字', message_words: '原文', emote_words: '[表情名]' }[row.kind];
  const from = fresh || row.kind === 'message_words'
    ? `<input class="lake-reading-input" name="from" value="${esc(row.from)}" placeholder="${esc(t(named))}" aria-label="${esc(t(named))}" maxlength="160" autocomplete="off" spellcheck="false">`
    : `<span class="lake-reading-from">${esc(row.from)}</span>`;
  const voices = row.kind === 'user_words' ? `<select name="preset_id" aria-label="${esc(t('TA 的声音'))}">${option('', t('跟随默认'), row.binding?.preset_id || '')}${snapshot.presets.map(preset => option(preset.id, presetLabel(preset), row.binding?.preset_id)).join('')}</select>` : '';
  return `<div class="lake-reading-row editing" data-kind="${row.kind}" data-from="${esc(fresh ? '' : row.from)}"${fresh ? ' data-new' : ''}><div class="lake-reading-edit"><span class="lake-reading-mark">${fresh ? '' : lakeReadingMarker(row)}</span>${from}<span class="lake-reading-arrow">→</span><span class="lake-reading-to"><input class="lake-reading-input" name="to" value="${esc(row.to)}" placeholder="${esc(t('读法'))}" aria-label="${esc(t('读法'))}" maxlength="500" autocomplete="off" spellcheck="false">${voices}</span></div><span class="lake-reading-tail" aria-hidden="true"></span></div>`;
}

function lakeReadingElement(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return holder.firstElementChild;
}

function updateLakeReadingCounts() {
  for (const group of settingsDialog.querySelectorAll('[data-reading-group]')) {
    const count = group.querySelector('[data-reading-count]');
    const value = String(group.querySelectorAll('.lake-reading-row:not([data-new])').length);
    if (count && count.textContent !== value) count.textContent = value;
  }
}

function closeLakeReadingRow(element, row) {
  if (!element.isConnected) return;
  const focused = element.contains(document.activeElement);
  if (!row) { element.remove(); updateLakeReadingCounts(); return; }
  const next = lakeReadingElement(lakeReadingRowHtml(row));
  element.replaceWith(next);
  if (focused) next.querySelector('button')?.focus({ preventScroll: true });
  updateLakeReadingCounts();
}

async function openLakeReadingRow(element) {
  if (!element?.isConnected) return;
  const kind = element.dataset.kind, from = element.dataset.from;
  await commitLakeReadingRows();
  const row = lakeReadingFind(kind, from);
  const current = [...settingsDialog.querySelectorAll('.lake-reading-row:not(.editing)')].find(node => node.dataset.kind === kind && node.dataset.from === from);
  if (!row || !current) return;
  const next = lakeReadingElement(lakeReadingEditHtml(row));
  current.replaceWith(next);
  mountSelects(next);
  const input = next.querySelector('[name="to"]');
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

async function addLakeReadingRow(kind) {
  const group = settingsDialog.querySelector(`[data-reading-group="${kind}"]`);
  if (!group) return;
  const draft = group.querySelector('.lake-reading-row[data-new]');
  if (draft) { draft.querySelector('input')?.focus({ preventScroll: true }); return; }
  await commitLakeReadingRows();
  const next = lakeReadingElement(lakeReadingEditHtml({ kind, from: '', to: '', fresh: true }));
  group.querySelector('h3').after(next);
  mountSelects(next);
  next.querySelector('[name="from"]').focus({ preventScroll: true });
}

function commitLakeReadingRow(element, leaving = false) {
  if (!lakeReadingCommits.has(element)) lakeReadingCommits.set(element, saveLakeReadingRow(element, leaving).finally(() => lakeReadingCommits.delete(element)));
  return lakeReadingCommits.get(element);
}

async function commitLakeReadingRows(leaving = false) {
  for (const element of [...settingsDialog.querySelectorAll('.lake-reading-row.editing')]) {
    try { await commitLakeReadingRow(element, leaving); } catch { /* The command already showed its error; the draft stays. */ }
  }
}

async function saveLakeReadingRow(element, leaving) {
  const kind = element.dataset.kind, fresh = element.hasAttribute('data-new');
  const original = fresh ? null : lakeReadingFind(kind, element.dataset.from);
  const field = name => element.querySelector(`[name="${name}"]`);
  const from = (field('from') ? field('from').value : element.dataset.from).trim();
  const to = field('to').value.trim();
  const presetId = kind === 'user_words' ? field('preset_id')?.value || '' : '';
  if (!from || (!to && !presetId)) {
    // Unfinished: an existing row keeps what it had; a new line stays where it
    // is until the page is left, and an untouched one simply goes away.
    if (!fresh) return closeLakeReadingRow(element, original);
    if (leaving || (!from && !to && !presetId)) { element.remove(); updateLakeReadingCounts(); }
    return;
  }
  const sameVoice = (original?.binding?.preset_id || '') === presetId;
  if (original && original.from === from && (original.to || '') === to && sameVoice) return closeLakeReadingRow(element, original);
  const rules = structuredClone(snapshot.rules);
  const list = rules[kind] || [];
  const at = original ? list.findIndex(item => item.from === original.from) : -1;
  const next = list.filter(item => item.from !== from && item.from !== original?.from);
  // An edited line keeps its place; a new one goes first, where it was typed.
  if (to) next.splice(at >= 0 ? Math.min(at, next.length) : 0, 0, { from, to });
  rules[kind] = next;
  if (JSON.stringify(next) !== JSON.stringify(snapshot.rules[kind] || [])) await command('rules.save', { rules });
  if (kind === 'user_words' && !sameVoice) {
    const uid = original?.binding?.user_id ?? null;
    if (presetId) await command('bindings.save', { id: original?.bindingId || '', binding: { platform: 'bilibili', user_id: uid, user_name: uid ? null : from, legacy_user_name: null, preset_id: presetId, enabled: true } });
    else if (original?.bindingId) await command('bindings.delete', { id: original.bindingId, confirmed: true });
  }
  // The same original text elsewhere in the group was just replaced.
  for (const other of settingsDialog.querySelectorAll(`[data-reading-group="${kind}"] .lake-reading-row:not(.editing)`)) if (other.dataset.from === from) other.remove();
  closeLakeReadingRow(element, lakeReadingFind(kind, from));
}

function lakeTemplateMarkup(value) {
  return esc(value).replace(/\{(user_name|message|gift_name|gift_num|price|guard_name)\}/g, (_, key) => `<span class="lake-template-token" contenteditable="false" data-token="${key}">${esc(t(lakeTokenLabels[key]))}</span>`);
}

function renderRulesSettings() {
  const rules = snapshot.rules;
  const events = rules.events;
  const amount = (name, value, label) => `<span class="lake-amount">${esc(t('至少'))} ¥<input name="${name}" type="number" min="0" step="0.1" required value="${esc(displayNumber(value))}" aria-label="${esc(t(label))}"></span>`;
  const thresholds = `<form data-form="lake-thresholds">${sSwitch('danmaku_on', t('弹幕'), events.danmaku_on)}${sSwitch('gift_on', t('礼物'), events.gift_on, '', amount('gift_threshold_yuan', events.gift_threshold_yuan, '礼物最低金额（元）'))}<div class="lake-indented">${sSwitch('free_gift_on', t('免费礼物也读'), events.free_gift_on)}</div>${sSwitch('super_chat_on', t('醒目留言'), events.super_chat_on, '', amount('super_chat_threshold_yuan', events.super_chat_threshold_yuan, '醒目留言最低金额（元）'))}${sSwitch('guard_on', t('大航海'), events.guard_on)}${autoStatus()}</form>`;
  const templates = `<form data-form="lake-templates">${[['danmaku', '弹幕'], ['gift', '礼物'], ['super_chat', '醒目留言'], ['guard', '大航海']].map(([key, label]) => `<div class="lake-template-row"><label id="lake-template-label-${key}">${esc(t(label))}</label><div class="lake-template-edit" data-lake-template="${key}" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="lake-template-label-${key}">${lakeTemplateMarkup(rules.templates[key] || '')}</div><input type="hidden" name="template_${key}" value="${esc(rules.templates[key] || '')}"><div class="lake-template-tools"><span>${esc(t('插入'))}:</span>${Object.entries(lakeTokenLabels).map(([token, label]) => `<button type="button" data-action="lake.template.insert" data-id="${token}">${esc(t(label))}</button>`).join('')}<button type="button" data-action="lake.template.reset" data-id="${key}">${esc(t('恢复这句'))}</button></div></div>`).join('')}${autoStatus()}</form>`;
  const section = (key, label, detail, body) => `<section class="lake-accordion"><button type="button" class="lake-accordion-toggle" data-action="lake.advanced.section" data-id="${key}" aria-expanded="${lakeAdvancedSection === key}" aria-controls="lake-advanced-${key}"><span>${esc(t(label))}</span><small>${esc(detail)}</small>${icon(lakeAdvancedSection === key ? 'up' : 'down')}</button><div id="lake-advanced-${key}" class="lake-accordion-body"${lakeAdvancedSection === key ? '' : ' hidden'}>${body}</div></section>`;
  const merge = snapshot.live_settings?.gift_merge || { enabled: false, initial_seconds: 1.5, increment_seconds: .5, maximum_seconds: 5 };
  const giftMerge = `<form data-form="gift-merge" class="lake-merge">${sSwitch('enabled', t('合并连续赠送的礼物'), merge.enabled)}${['initial_seconds', 'increment_seconds', 'maximum_seconds'].map(key => `<input type="hidden" name="${key}" value="${esc(merge[key])}">`).join('')}${autoStatus()}</form>`;
  return `<div class="lake-settings-page lake-advanced">${section('messages', '播报哪些消息', '', thresholds)}${section('templates', '播报模板', '4', templates)}${section('sounds', '关键词音效', (rules.sounds || []).map(row => row.trigger).slice(0, 2).join('、'), renderAssetsSettings())}${giftMerge}<footer class="lake-settings-footer lake-reset-note"><span>${esc(t('这些一般不用动，改乱了可以一键恢复。'))}</span>${button(t('恢复默认'), 'lake.advanced.reset', { class: 'quiet small' })}</footer></div>`;
}

function renderAssetsSettings() {
  const sounds = snapshot.rules.sounds || [];
  return `<form data-form="sound-words" class="lake-sound-words"><div data-dictionary="sounds">${sounds.map(row => `<div class="dict-row lake-sound-row"><input data-key="from" aria-label="${esc(t('关键词'))}" placeholder="${esc(t('关键词'))}" value="${esc(row.trigger)}" required><span class="lake-sound-arrow" aria-hidden="true">→</span><select data-key="to" aria-label="${esc(t('音效'))}" required>${option('', t('选择音效'), row.asset_id)}${snapshot.assets.map(asset => option(asset.id, asset.name, row.asset_id)).join('')}</select>${iconButton('play', t('试听音效'), 'lake.sound.audition', row.asset_id)}${iconButton('close', t('删除这条'), 'dictionary.remove')}</div>`).join('')}</div>${button(t('添加关键词'), 'lake.sound.add', { class: 'quiet small', icon: 'plus' })}${autoStatus()}</form><div class="lake-sound-library"><p>${esc(t('用过的音效'))}</p>${snapshot.assets.map(asset => `<div><span>${esc(asset.name)}</span>${iconButton('play', t('试听音效'), 'lake.sound.audition', asset.id)}</div>`).join('')}${button(t('从电脑选择音频'), 'lake.sound.pick', { class: 'quiet small', icon: 'folder' })}</div>`;
}

function renderLakeGeneral() {
  const language = snapshot.preferences?.language || 'zh-CN';
  return `<div class="lake-settings-page lake-general"><form data-form="language" class="s-row"><span>${esc(t('语言'))}</span><div class="lake-language">${[['zh-CN', '简体中文'], ['en', 'English']].map(([id, label]) => `<label><input type="radio" name="language" value="${id}"${id === language ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div></form><form data-form="startup">${sSwitch('enabled', t('开机时启动'), snapshot.startup_enabled)}${autoStatus()}</form><section class="lake-backups"><h3>${esc(t('备份与迁移'))}</h3><p class="lake-note">${esc(t('登录和密钥不会导出。音效文件需要另行保留。'))}</p><div class="actions">${button(t('导出备份'), 'lake.backup.export', { class: 'small' })}${button(t('从备份恢复'), 'lake.backup.import', { class: 'small' })}</div><div id="operation-result" class="form-result" role="status"></div></section><footer class="lake-settings-footer lake-general-version">${lakeVersionRow(true)}</footer></div>`;
}

function collectLakeSettingsAutosave(form) {
  if (!['lake-thresholds', 'lake-templates'].includes(form.dataset.form)) return null;
  const data = new FormData(form);
  const rules = structuredClone(snapshot.rules);
  rules.events.filter_bilibili_emoticons = true;
  if (form.dataset.form === 'lake-thresholds') {
    for (const key of ['danmaku_on', 'gift_on', 'free_gift_on', 'super_chat_on', 'guard_on']) rules.events[key] = data.has(key);
    for (const key of ['gift_threshold_yuan', 'super_chat_threshold_yuan']) rules.events[key] = Number(data.get(key));
  } else for (const key of ['danmaku', 'gift', 'super_chat', 'guard']) rules.templates[key] = String(data.get(`template_${key}`) || '');
  return { action: 'rules.save', payload: { rules } };
}

function lakeTemplateText(node) {
  return [...node.childNodes].map((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent;
    if (child.dataset?.token) return `{${child.dataset.token}}`;
    if (child.tagName === 'BR') return '\n';
    const content = lakeTemplateText(child);
    return ['DIV', 'P'].includes(child.tagName) ? content === '\n' ? '\n' : `${index ? '\n' : ''}${content}` : content;
  }).join('');
}

function syncLakeTemplate(node) {
  const form = node.closest('form');
  form.elements[`template_${node.dataset.lakeTemplate}`].value = lakeTemplateText(node);
  scheduleAutosave(form, false, false, composingInputs.has(node));
}

async function handleLakeSettingsAction(action, id, target) {
  if (!action.startsWith('lake.')) return false;
  if (!['lake.room.relogin', 'lake.room.edit', 'lake.reading.add', 'lake.reading.edit', 'lake.reading.delete', 'lake.advanced.section', 'lake.advanced.reset', 'lake.template.insert', 'lake.template.reset', 'lake.sound.add', 'lake.sound.pick', 'lake.sound.audition', 'lake.backup.export', 'lake.backup.import'].includes(action)) return false;
  if (action === 'lake.room.relogin') { await openSettings('room'); await handleAction('bili.begin', '', target); return true; }
  if (action === 'lake.room.edit') { showLakeRoomNumber(true); return true; }
  if (action === 'lake.reading.edit') { await openLakeReadingRow(target.closest('.lake-reading-row')); return true; }
  if (action === 'lake.reading.add') { await addLakeReadingRow(id); return true; }
  if (action === 'lake.reading.delete') {
    if (!await flushAutosaves()) return true;
    const element = target.closest('.lake-reading-row');
    const row = element && lakeReadingFind(element.dataset.kind, element.dataset.from); if (!row) return true;
    const rules = structuredClone(snapshot.rules);
    rules[row.kind] = (rules[row.kind] || []).filter(item => item.from !== row.from);
    await command('rules.save', { rules });
    if (row.bindingId) await command('bindings.delete', { id: row.bindingId, confirmed: true });
    element.remove(); updateLakeReadingCounts(); return true;
  }
  if (action === 'lake.advanced.section') {
    if (!await flushAutosaves(true)) return true;
    lakeAdvancedSection = lakeAdvancedSection === id ? '' : id; renderSettings(); return true;
  }
  if (action === 'lake.advanced.reset') {
    if (!await flushAutosaves()) return true;
    if (!await confirmAction(t('恢复高级设置的默认值？'), t('播报消息、模板、关键词音效和礼物合并会恢复默认。声音和记住的读法会保留。'), t('恢复默认'), false)) return true;
    const rules = structuredClone(snapshot.rules);
    rules.events = { danmaku_on: true, filter_bilibili_emoticons: true, gift_on: true, free_gift_on: false, super_chat_on: true, guard_on: true, gift_threshold_yuan: 5, super_chat_threshold_yuan: 30 };
    rules.templates = { ...lakeTemplateDefaults }; rules.sounds = [];
    await command('rules.save', { rules });
    await command('live.save', { gift_merge: { enabled: false, initial_seconds: 1.5, increment_seconds: .5, maximum_seconds: 5 } });
    renderSettings(); return true;
  }
  if (action === 'lake.template.reset' || action === 'lake.template.insert') {
    const node = target.closest('.lake-template-row').querySelector('[data-lake-template]');
    if (action === 'lake.template.reset') node.innerHTML = lakeTemplateMarkup(lakeTemplateDefaults[id]);
    else {
      const token = document.createElement('span'); token.className = 'lake-template-token'; token.contentEditable = 'false'; token.dataset.token = id; token.textContent = t(lakeTokenLabels[id]);
      const selection = getSelection();
      const range = lakeTemplateRange && node.contains(lakeTemplateRange.commonAncestorContainer) ? lakeTemplateRange : document.createRange();
      if (!lakeTemplateRange || !node.contains(range.commonAncestorContainer)) { range.selectNodeContents(node); range.collapse(false); }
      range.deleteContents(); range.insertNode(token); range.setStartAfter(token); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); lakeTemplateRange = range.cloneRange();
    }
    node.focus(); syncLakeTemplate(node); return true;
  }
  if (action === 'lake.sound.audition') {
    const assetId = target.closest('.lake-sound-row')?.querySelector('[data-key="to"]')?.value || id;
    if (assetId) await command('assets.audition', { id: assetId }, { quiet: true }); return true;
  }
  if (action === 'lake.sound.pick') {
    const pick = window.__TAURI__?.dialog?.open;
    if (!pick) throw new Error(t('文件选择器不可用，请重新打开应用。'));
    const path = await pick({ multiple: false, title: t('选择音效'), filters: [{ name: t('音频'), extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }] });
    if (typeof path !== 'string') return true;
    if (!await flushAutosaves()) return true;
    await command('assets.import', { path, name: path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') });
    renderSettings(); return true;
  }
  if (action === 'lake.sound.add') {
    if (!snapshot.assets.length) { await handleLakeSettingsAction('lake.sound.pick', '', target); if (!snapshot.assets.length) return true; }
    const list = settingsDialog.querySelector('[data-dictionary="sounds"]');
    list.insertAdjacentHTML('beforeend', `<div class="dict-row lake-sound-row"><span>「</span><input data-key="from" aria-label="${esc(t('关键词'))}" required><span>」→</span><select data-key="to" aria-label="${esc(t('音效'))}">${snapshot.assets.map(asset => option(asset.id, asset.name, snapshot.assets[0]?.id)).join('')}</select>${iconButton('play', t('试听音效'), 'lake.sound.audition')}${iconButton('close', t('删除这条'), 'dictionary.remove')}</div>`);
    // An empty line is not a draft yet: it saves itself once its keyword is typed.
    mountSelects(list); list.lastElementChild.querySelector('input').focus(); return true;
  }
  if (action === 'lake.backup.export' || action === 'lake.backup.import') {
    if (!await allowLeaveSettings()) return true;
    const exporting = action.endsWith('.export');
    const picker = exporting ? window.__TAURI__?.dialog?.save : window.__TAURI__?.dialog?.open;
    if (!picker) throw new Error(t('文件选择器不可用，请重新打开应用。'));
    const path = await picker({ title: t(exporting ? '导出备份' : '从备份恢复'), filters: [{ name: 'JSON', extensions: ['json'] }], ...(exporting ? { defaultPath: 'danmakuvoice-backup.json' } : { multiple: false }) });
    if (typeof path !== 'string') return true;
    if (!exporting && !await confirmAction(t('从这份备份恢复？'), t('当前接收和播报会停止。会先备份当前数据，再恢复声音、读法和规则；登录和密钥不会被导入。'), t('恢复'), false)) return true;
    const next = await command(exporting ? 'configuration.export' : 'configuration.import', { path, confirmed: !exporting });
    renderResult('#operation-result', next.result || t('已完成')); return true;
  }
  return false;
}

function installLakeSettingsEvents() {
  for (const type of ['lake-thresholds', 'lake-templates']) autoFormTypes.add(type);
  // Pages slide in sideways; focus landing mid-slide must not leave the page scrolled sideways.
  settingsDialog.addEventListener('scroll', event => { if (event.target.id === 'settings-content' && event.target.scrollLeft) event.target.scrollLeft = 0; }, true);
  const scrim = document.createElement('button'); scrim.type = 'button'; scrim.className = 'lake-settings-scrim'; scrim.hidden = true; scrim.tabIndex = -1; scrim.setAttribute('aria-label', t('关闭设置')); document.body.append(scrim);
  scrim.addEventListener('click', () => { void closeSettings(); });
  const syncOpen = () => { scrim.hidden = !settingsDialog.open; document.body.classList.toggle('lake-settings-open', settingsDialog.open); };
  new MutationObserver(syncOpen).observe(settingsDialog, { attributes: true, attributeFilter: ['open'] }); syncOpen();
  settingsDialog.addEventListener('input', event => {
    if (event.target.id === 'lake-readings-search') {
      lakeReadingsSearch = event.target.value;
      const search = lakeReadingsSearch.toLocaleLowerCase();
      for (const row of settingsDialog.querySelectorAll('[data-reading-search]')) row.hidden = !row.dataset.readingSearch.includes(search);
    }
    const template = event.target.closest('[data-lake-template]');
    if (template) syncLakeTemplate(template);
  }, true);
  // A reading row being edited: Enter saves it, Escape puts it back (and does not
  // close the drawer), leaving the row saves it. An open voice menu keeps its keys.
  settingsDialog.addEventListener('keydown', event => {
    const element = event.target.closest?.('.lake-reading-row.editing');
    if (!element || !['Enter', 'Escape'].includes(event.key) || event.isComposing || event.keyCode === 229 || composingInputs.has(event.target)) return;
    if (event.target.closest('.select-control') && (event.key === 'Enter' || event.target.getAttribute('aria-expanded') === 'true')) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') { void commitLakeReadingRow(element).catch(() => {}); return; }
    if (element.hasAttribute('data-new')) { const add = element.closest('[data-reading-group]')?.querySelector('h3 .icon-button'); element.remove(); updateLakeReadingCounts(); add?.focus({ preventScroll: true }); return; }
    closeLakeReadingRow(element, lakeReadingFind(element.dataset.kind, element.dataset.from));
  }, true);
  settingsDialog.addEventListener('focusout', event => {
    const element = event.target.closest?.('.lake-reading-row.editing');
    if (!element || (event.relatedTarget && element.contains(event.relatedTarget))) return;
    setTimeout(() => { if (element.isConnected && !element.contains(document.activeElement)) void commitLakeReadingRow(element).catch(() => {}); });
  });
  // The room number being changed: the same keys, and leaving the field saves it.
  settingsDialog.addEventListener('keydown', event => {
    const card = event.target.closest?.('.lake-room-number.editing');
    if (!card || !['Enter', 'Escape'].includes(event.key) || event.isComposing || event.keyCode === 229 || composingInputs.has(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') void commitLakeRoomNumber().catch(() => {});
    else if (!lakeRoomSave) showLakeRoomNumber(false);
  }, true);
  settingsDialog.addEventListener('focusout', event => {
    const input = event.target.closest?.('.lake-room-number.editing input');
    if (input) setTimeout(() => { if (input.isConnected && document.activeElement !== input) void commitLakeRoomNumber().catch(() => {}); });
  });
  settingsDialog.addEventListener('pointerdown', event => {
    // Collapsing the focused row's tools on pointerdown would move later
    // controls before pointerup and swallow their click.
    if (event.target.closest('button') && document.activeElement?.closest('.lake-template-row')) event.preventDefault();
  });
  document.addEventListener('selectionchange', () => {
    const selection = getSelection();
    if (selection?.rangeCount && selection.anchorNode?.parentElement?.closest('[data-lake-template]')) lakeTemplateRange = selection.getRangeAt(0).cloneRange();
  });
  settingsDialog.addEventListener('paste', event => {
    const node = event.target.closest('[data-lake-template]'); if (!node) return;
    event.preventDefault(); const text = event.clipboardData?.getData('text/plain') || '';
    const selection = getSelection(); if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0); range.deleteContents(); const plain = document.createTextNode(text); range.insertNode(plain); range.setStartAfter(plain); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); syncLakeTemplate(node);
  });
  document.addEventListener('keydown', event => {
    if (!settingsDialog.open || confirmationDialog.open) return;
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); void closeSettings(); }
    if (event.key !== 'Tab') return;
    const controls = [...document.querySelectorAll('#titlebar button, #settings button, #settings input, #settings select, #settings textarea, #settings [contenteditable="true"]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    const index = controls.indexOf(document.activeElement);
    if (controls.length && (event.shiftKey ? index <= 0 : index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus(); }
  });
}


// ---------- OBS overlay: real feed preview and canvas placement ----------
const overlayDefaultTagline = "say a word — it'll be read aloud.";
const overlayWeekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function overlayMaskedUrl(url, token) {
  if (!url || !token) return '';
  return url.replace(token, `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-4)}`);
}

function overlayPreviewSize() {
  const status = snapshot.obs?.status || {};
  const sync = snapshot.obs?.status?.overlay_sync || {};
  const client = (snapshot.overlay?.clients || [])[0];
  const known = status.canvas_width > 0 && status.canvas_height > 0 ? { width: status.canvas_width, height: status.canvas_height } : sync.width > 0 && sync.height > 0 ? sync : client;
  return known ? { width: known.width, height: known.height, note: t('来自 OBS') } : { width: 1920, height: 1080, note: t('连上 OBS 后按实际画布显示') };
}

function overlayObsClientCount() {
  const view = snapshot.overlay || {};
  return Number.isSafeInteger(view.obs_clients) && view.obs_clients >= 0 ? view.obs_clients : (view.clients || []).length;
}

function overlayBindingStatus() {
  const sync = snapshot.obs?.status?.overlay_sync || {};
  if (sync.state === 'syncing') return { tone: 'pending', text: t('正在同步到 OBS…') };
  if (sync.state === 'error' || sync.state === 'paused') return { tone: 'error', text: errorMessage(sync.message || '') };
  if (sync.state === 'ready' || sync.state === 'updated') return { tone: 'ready', text: sync.scene ? ui`已放进场景「${sync.scene}」` : t('叠加层已放进场景') };
  return null;
}

function overlayStatus() {
  if (snapshot.overlay?.error) return { tone: 'error', text: errorMessage(snapshot.overlay.error) };
  return overlayBindingStatus() || { tone: 'pending', text: t('叠加层还没放进场景') };
}

function renderOverlayAdvanced() {
  const s = snapshot.overlay?.settings;
  if (!s) return '';
  const choice = (name, value, label, checked, type = 'radio') => `<label class="lake-obs-choice"><input type="${type}" name="${name}" value="${value}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  return `<section class="lake-obs-section"><h3>${esc(t('叠加层显示'))}</h3><form data-form="overlay" novalidate><div class="lake-obs-option-row"><span>${esc(t('显示哪些'))}</span><div class="lake-obs-choices">${[['danmaku', '弹幕'], ['gift', '礼物'], ['super_chat', '醒目留言'], ['guard', '大航海']].map(([kind, label]) => choice(`show_${kind}`, 'on', t(label), s[`show_${kind}`], 'checkbox')).join('')}</div></div><div class="lake-obs-option-row"><span>${esc(t('观众名字'))}</span><div class="lake-obs-choices">${[['none', '不显示'], ['special', '仅礼物'], ['all', '全部']].map(([value, label]) => choice('names', value, t(label), s.names === value)).join('')}</div></div>${sSwitch('merge_duplicates', t('重复的话合成一条'), s.merge_duplicates)}${autoStatus()}</form></section>`;
}

function renderOverlayPanel() {
  const s = snapshot.overlay?.settings;
  if (!s) return empty(t('桌面连接不可用。'));
  const hidden = ['corner', 'offset_x', 'offset_y', 'scale', 'title', 'tagline'].map(name => `<input type="hidden" name="${name}" value="${esc(s[name] ?? (name.startsWith('offset_') ? 0 : ''))}">`).join('');
  const edit = name => `data-ovp-edit="${name}" tabindex="0" role="textbox" aria-label="${esc(t(name === 'title' ? '双击编辑主标题' : '双击编辑副标题'))}" aria-readonly="true" spellcheck="false" title="${esc(t('双击文字编辑，回车保存'))}"`;
  return `<form data-form="overlay" class="lake-obs-preview" novalidate>${hidden}<div class="lake-obs-binding"><span class="lake-obs-link" aria-hidden="true"><i></i><b></b><i></i></span><span data-overlay-status-text></span><small data-overlay-binding-detail></small>${button(t('添加到 OBS'), 'overlay.obs_add', { class: 'primary', icon: 'plus' })}${button(t('打开 OBS'), 'lake.obs.launch', { class: 'primary', icon: 'play' })}${button(t('重新连接'), 'lake.obs.connect', { class: 'quiet' })}</div><div class="lake-obs-preview-frame"><div class="ovp lake-obs-canvas" data-style="spine" data-corner="${esc(s.corner)}" data-backdrop="dark"><div class="ovp-stage"><svg class="lake-obs-scene" viewBox="0 0 640 360" preserveAspectRatio="none" aria-hidden="true"><path d="M0 360V250C60 236 110 214 170 222C230 230 260 200 320 196C380 192 420 222 480 226C540 230 590 208 640 214V360Z" fill="#151326"></path><path d="M0 360V292C80 280 150 300 230 290C320 278 380 262 460 272C540 282 600 290 640 284V360Z" fill="#0c0b15"></path></svg><i class="lake-obs-guide-x" hidden></i><i class="lake-obs-guide-y" hidden></i><div class="lake-obs-superchat" data-ovp-superchat></div><div class="ovp-block" data-ovp-drag tabindex="0" role="group" aria-label="${esc(t('拖动摆放叠加层，也可用方向键微调'))}"><i class="ovp-vig"></i><i class="ovp-spine"></i><div class="ovp-mast"><div class="ovp-kicker"><i class="ovp-dot"></i><span class="ovp-live">LIVE</span><span class="ovp-sep">·</span><span data-ovp-day></span><span class="ovp-time" data-ovp-time></span></div><div class="ovp-title" data-ovp-title ${edit('title')}></div><div class="ovp-tagrow"><i class="ovp-rule"></i><span class="ovp-tagline" data-ovp-tagline ${edit('tagline')}></span></div></div><div class="ovp-list" data-ovp-items></div><button type="button" class="lake-obs-resize" data-ovp-resize tabindex="0" aria-label="${esc(t('拖动缩放，也可用方向键调整大小'))}"></button></div></div></div></div><div class="lake-obs-preview-foot"><span>${esc(t('拖动摆放，拖右下角缩放，靠近四角会自动贴合'))}</span><span class="lake-obs-canvas-size">${esc(t('OBS 画布'))} <em data-ovp-size></em></span><i aria-hidden="true"></i><button type="button" data-action="lake.obs.advanced">${esc(t('高级'))}${icon('arrow')}</button></div><div class="lake-obs-looks">${lakeObsLook('vignette', t('暗角深浅'), s.vignette ?? .6, 0, t('在亮的游戏画面上调深一些，文字更清楚。'))}${lakeObsLook('history_opacity', t('历史弹幕清晰度'), s.history_opacity ?? .72, .3, t('上面几条旧弹幕的清楚程度'))}</div>${autoStatus()}</form>`;
}

function updateOverlayStatus() {
  if (!settingsDialog.open) return;
  const root = settingsDialog.querySelector?.('[data-obs-root]');
  if (!root) return;
  // Only a transition between connection, preview and advanced replaces DOM.
  updateObsSettings();
  if (!root.isConnected || !snapshot.overlay) return;
  const offline = root.dataset.obsView === 'offline';
  const local = snapshot.obs?.local !== false;
  const status = overlayStatus();
  const sync = snapshot.obs?.status?.overlay_sync || {};
  const bound = ['ready', 'updated'].includes(sync.state);
  // Until the first check answers, the stage says it is looking. After that, periodic
  // checks keep the closed state steady; only an explicit launch or connect wakes the link.
  const unknown = offline && !obsBusy && !['error', 'ok'].includes(snapshot.obs?.status?.state);
  const waking = offline && (!!obsBusy || unknown);
  const bar = root.querySelector('.lake-obs-binding');
  if (bar) bar.dataset.link = offline ? waking ? 'waking' : 'off' : 'on';
  const text = root.querySelector('[data-overlay-status-text]');
  const title = offline ? waking ? obsBusy === 'launch' ? t('正在打开 OBS…') : obsBusy ? t('正在连接 OBS…') : t('正在检测 OBS…') : t('OBS 还没打开') : bound ? status.text : t('已连接 OBS');
  if (text && text.textContent !== title) text.textContent = title;
  const detail = root.querySelector('[data-overlay-binding-detail]');
  if (detail) {
    detail.textContent = offline ? unknown ? '' : local ? t('打开后会自动连上，在这里摆好的位置会同步过去') : t('OBS 在另一台电脑上，它开着就会自动连上') : bound ? t('之后的改动会自动同步到 OBS') : status.text;
    detail.classList.toggle('field-error', !offline && status.tone === 'error');
  }
  const add = root.querySelector('[data-action="overlay.obs_add"]');
  if (add) { add.hidden = offline || bound; add.disabled = !!obsBusy; }
  const launch = root.querySelector('.lake-obs-binding [data-action="lake.obs.launch"]');
  if (launch) { launch.hidden = !offline || !local; launch.disabled = !!obsBusy; }
  const reconnect = root.querySelector('.lake-obs-binding [data-action="lake.obs.connect"]');
  if (reconnect) { reconnect.hidden = !offline || local; reconnect.disabled = !!obsBusy; }
  updateOverlayPreview();
}

// Readability under the preview: how dark the shade behind the corner is and
// how clearly the older lines stay. Both apply to OBS as they move.
function lakeObsLook(name, label, value, min, tip) {
  const number = Math.min(1, Math.max(min, Number(value)));
  return `<label class="lake-obs-option-row lake-obs-look" title="${esc(tip)}"><span>${esc(label)}</span><input type="range" name="${name}" min="${min}" max="1" step="0.01" value="${number}" style="--fill:${100 * (number - min) / (1 - min)}%"><output data-ovp-out="${name}">${Math.round(number * 100)}%</output></label>`;
}

function lakeOverlayItems() {
  const feed = snapshot.overlay?.preview || {};
  const source = feed.items || [];
  const settings = snapshot.overlay?.settings || {};
  const items = [];
  for (const item of source) {
    if (settings[`show_${item.kind}`] === false) continue;
    const previous = items.at(-1);
    if (settings.merge_duplicates && previous && previous.kind === item.kind && previous.message === item.message && previous.name === item.name && previous.gift === item.gift && item.kind === 'danmaku') {
      previous.count = (previous.count || 1) + 1; previous.job_id = item.job_id ?? previous.job_id;
    } else items.push({ ...item });
  }
  return { ...feed, items };
}

function updateOverlayPreview() {
  const frame = settingsDialog.querySelector?.('.lake-obs-canvas');
  const form = frame?.closest('form');
  if (!frame || !form) return;
  const field = name => form.elements[name];
  const scale = Math.min(2, Math.max(.5, Number(field('scale')?.value) || 1));
  frame.dataset.style = 'spine'; frame.dataset.corner = field('corner')?.value || 'top_left';
  const look = (name, min, fallback) => { const value = Number(field(name)?.value); return Number.isFinite(value) ? Math.min(1, Math.max(min, value)) : fallback; };
  const vignette = look('vignette', 0, .6), history = look('history_opacity', .3, .72);
  frame.style.setProperty('--ovp-scale', String(scale)); frame.style.setProperty('--ovp-vig', String(vignette));
  frame.style.setProperty('--ovp-vig-boost', String(Math.round(Math.max(0, (vignette - .6) / .4) * 1000) / 1000));
  // Same fade as the overlay page: the oldest line at the chosen opacity, the one between closer to full.
  frame.style.setProperty('--ovp-near', String(Math.round((1 - (1 - history) * 3 / 7) * 1000) / 1000)); frame.style.setProperty('--ovp-old', String(history));
  for (const [name, value, min] of [['vignette', vignette, 0], ['history_opacity', history, .3]]) {
    const out = form.querySelector(`[data-ovp-out="${name}"]`), label = `${Math.round(value * 100)}%`;
    if (out && out.textContent !== label) out.textContent = label;
    field(name)?.style.setProperty('--fill', `${100 * (value - min) / (1 - min)}%`);
  }
  const size = overlayPreviewSize();
  frame.style.setProperty('--ovp-ratio', `${size.width} / ${size.height}`);
  frame.style.setProperty('--ovp-aspect', String(size.width / size.height));
  for (const [name, dimension] of [['offset_x', size.width], ['offset_y', size.height]]) frame.style.setProperty(`--ovp-${name.replace('_', '-')}`, `${(Number(field(name)?.value) || 0) / dimension * 100}${name === 'offset_x' ? 'cqw' : 'cqh'}`);
  const now = new Date();
  const values = { '[data-ovp-title]': field('title')?.value || t('今晚的弹幕'), '[data-ovp-tagline]': field('tagline')?.value || overlayDefaultTagline, '[data-ovp-day]': overlayWeekdays[now.getDay()], '[data-ovp-time]': `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, '[data-ovp-size]': `${size.width} × ${size.height}` };
  for (const [selector, value] of Object.entries(values)) { const node = form.querySelector(selector); if (node && node.contentEditable !== 'true' && node.textContent !== value) node.textContent = value; }
  if (lakeObsDrag) return;
  const feed = lakeOverlayItems();
  const current = feed.reading;
  const ordinary = feed.items.filter(item => item.kind !== 'super_chat').slice(-5);
  const renderItem = (item, index) => {
    const reading = current?.job_id != null && item.job_id === current.job_id;
    const progress = reading ? Math.min(100, 100 * (Number(current.played_ms) || 0) / Math.max(Number(current.queued_ms) || 0, 500)) : 100;
    const event = { ...item, gift_name: item.gift, guard_name: item.guard, user_name: item.name, avatar_url: item.avatar, is_bilibili_emoticon: item.sticker };
    const avatar = safeMediaUrl(item.avatar);
    const solo = soloEmote(event);
    const body = solo ? `<img class="message-emote ovp-sticker" src="${esc(solo.url)}" alt="" aria-label="${esc(solo.text)}" loading="lazy" referrerpolicy="no-referrer">` : renderChatBody(event);
    return `<div class="ovp-item ${reading || index === ordinary.length - 1 ? 'spot' : index === ordinary.length - 2 ? 'recent' : 'older'}${item.kind !== 'danmaku' ? ' special' : ''}${solo ? ' solo' : ''}"><span class="ovp-av">${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer">` : '<i class="ovp-face"></i>'}</span><span class="ovp-text">${item.name ? `<span class="ovp-name">${esc(item.name)}</span>` : ''}<span class="ovp-live-words${reading ? ' reading' : ''}" style="--read:${progress}%">${body}</span>${item.count > 1 ? `<small class="ovp-repeat">×${item.count}</small>` : ''}</span></div>`;
  };
  const list = form.querySelector('[data-ovp-items]');
  const markup = ordinary.length ? ordinary.map(renderItem).join('') : `<span class="lake-obs-waiting">waiting for the first word…</span>`;
  if (list && list.innerHTML !== markup) list.innerHTML = markup;
  const special = feed.items.filter(item => item.kind === 'super_chat' && Date.now() - Number(item.at) < 14000).at(-1);
  const sc = form.querySelector('[data-ovp-superchat]');
  if (sc) { const content = special ? `<span>${esc(special.name || t('醒目留言'))}</span><strong>${esc(special.message || '')}</strong>` : ''; if (sc.innerHTML !== content) sc.innerHTML = content; sc.hidden = !special; }
}

// Positions and offsets are in OBS source pixels. Artwork margins scale with the
// design, while offset_x/offset_y deliberately do not (matching overlay.html).
// Each axis snaps to its own margin line, so sliding along an edge sticks to it and
// a corner is simply both. With `follow`, the block anchors to the nearer of top and
// bottom, so new lines grow away from that edge instead of off the canvas. Right-side
// corners mirror the layout, so left/right only changes when an edge is reached.
function lakeOverlayPlacement({ x, y, width, height, canvasWidth, canvasHeight, scale, corner, snap = 0, follow = false }) {
  const unit = Math.min(canvasWidth / 1920, canvasHeight / 1080) * scale;
  const marginX = 72 * unit, marginY = 48 * unit;
  const left = marginX, right = canvasWidth - width - marginX, top = marginY, bottom = canvasHeight - height - marginY;
  let snapX = '', snapY = '';
  if (snap > 0) {
    if (Math.abs(x - left) <= snap) { x = left; snapX = 'left'; } else if (Math.abs(x - right) <= snap) { x = right; snapX = 'right'; }
    if (Math.abs(y - top) <= snap) { y = top; snapY = 'top'; } else if (Math.abs(y - bottom) <= snap) { y = bottom; snapY = 'bottom'; }
  }
  const [cornerY = 'top', cornerX = 'left'] = String(corner || '').split('_');
  if (follow || (snapX && snapY)) corner = `${snapY || (follow ? (y + height / 2 > canvasHeight / 2 ? 'bottom' : 'top') : cornerY)}_${snapX || cornerX}`;
  const anchors = { top_left: [left, top], top_right: [right, top], bottom_left: [left, bottom], bottom_right: [right, bottom] };
  const anchor = anchors[corner] || anchors.top_left;
  return { corner: anchors[corner] ? corner : 'top_left', offset_x: Math.max(-8192, Math.min(8192, Math.round(x - anchor[0]))), offset_y: Math.max(-8192, Math.min(8192, Math.round(y - anchor[1]))), scale, snapX, snapY, snapped: !!(snapX && snapY) };
}

function lakeOverlayMeasure(frame, block) {
  const canvas = frame.querySelector('.ovp-stage').getBoundingClientRect(), rect = block.getBoundingClientRect(), size = overlayPreviewSize();
  const ratio = size.width / canvas.width;
  return { x: (rect.left - canvas.left) * ratio, y: (rect.top - canvas.top) * ratio, width: rect.width * ratio, height: rect.height * ratio, canvasWidth: size.width, canvasHeight: size.height, ratio, canvas };
}

function lakeOverlayApply(form, placement, immediate = false) {
  for (const key of ['corner', 'offset_x', 'offset_y', 'scale']) if (form.elements[key]) form.elements[key].value = String(placement[key]);
  updateOverlayPreview();
  const frame = form.querySelector('.lake-obs-canvas'), block = frame?.querySelector('[data-ovp-drag]');
  if (frame && block) {
    const guideX = frame.querySelector('.lake-obs-guide-x'), guideY = frame.querySelector('.lake-obs-guide-y');
    guideX.hidden = !placement.snapX; guideY.hidden = !placement.snapY;
    if (placement.snapX || placement.snapY) { const a = frame.getBoundingClientRect(), b = block.getBoundingClientRect(); guideX.style.left = `${(placement.snapX === 'right' ? b.right : b.left) - a.left}px`; guideY.style.top = `${(placement.snapY === 'bottom' ? b.bottom : b.top) - a.top}px`; }
  }
  if (immediate) { clearTimeout(lakeObsSaveTimer); lakeObsSaveTimer = null; scheduleAutosave(form, true); }
  else if (!lakeObsSaveTimer) lakeObsSaveTimer = setTimeout(() => { lakeObsSaveTimer = null; if (form.isConnected) scheduleAutosave(form, true); }, 120);
}

async function saveLakeObsPassword(root = settingsDialog) {
  const input = root.querySelector('[data-obs-secret]');
  if (!input || !input.dataset.changed) return;
  const pending = lakeObsPasswordSaves.get(input);
  if (pending) {
    await pending;
    return saveLakeObsPassword(root);
  }
  const password = input.value;
  const saving = (async () => {
    await command('obs.password', { password }, { quiet: true, silent: true });
    if (input.value === password) { input.value = ''; delete input.dataset.changed; }
  })();
  lakeObsPasswordSaves.set(input, saving);
  try { await saving; }
  finally { lakeObsPasswordSaves.delete(input); }
}

async function handleLakeObsAction(action, id, target) {
  if (!action.startsWith('lake.obs.')) return false;
  if (action === 'lake.obs.advanced' || action === 'lake.obs.preview' || action === 'lake.obs.back') {
    if (!await flushAutosaves(true)) return true;
    await saveLakeObsPassword();
    lakeObsPage = action.endsWith('advanced') ? 'advanced' : 'preview'; renderSettings();
  } else if (action === 'lake.obs.password.show') {
    const input = target.closest('.lake-obs-field')?.querySelector('[data-obs-secret]');
    if (input) { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; target.setAttribute('aria-pressed', String(show)); target.setAttribute('aria-label', t(show ? '隐藏密码' : '显示密码')); }
  } else if (action === 'lake.obs.connect' || action === 'lake.obs.launch') {
    await saveLakeObsPassword(); await flushObsForm();
    if (action.endsWith('launch')) await launchObs(); else await testObs();
  }
  return true;
}

function installLakeObsEvents() {
  if (lakeObsEventsInstalled) return; lakeObsEventsInstalled = true;
  settingsDialog.addEventListener('input', event => {
    if (event.target.matches('[data-obs-secret]')) event.target.dataset.changed = 'true';
    if (event.target.matches('.lake-obs-program input[name="executable"]')) { const label = event.target.closest('.lake-obs-program').querySelector('[data-lake-obs-program]'); if (label) label.textContent = event.target.value.split(/[\\/]/).at(-1) || t('已自动找到 obs64.exe'); }
  });
  settingsDialog.addEventListener('change', event => {
    if (event.target.matches('[data-obs-secret]')) void saveLakeObsPassword().catch(error => showToast(errorMessage(error), true));
  });
  settingsDialog.addEventListener('pointerdown', event => {
    const block = event.target.closest('[data-ovp-drag]');
    if (!block || event.button !== 0 || event.target.closest('[contenteditable="true"]')) return;
    const frame = block.closest('.lake-obs-canvas'), form = block.closest('form');
    const measure = lakeOverlayMeasure(frame, block);
    lakeObsDrag = { ...measure, block, frame, form, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, scale: Number(form.elements.scale.value) || 1, corner: form.elements.corner.value, resizing: !!event.target.closest('[data-ovp-resize]'), moved: false };
    if (!event.target.closest('[data-ovp-edit]')) event.preventDefault();
  });
  settingsDialog.addEventListener('pointermove', event => {
    const d = lakeObsDrag; if (!d || d.pointer !== event.pointerId) return;
    const dx = (event.clientX - d.startX) * d.ratio, dy = (event.clientY - d.startY) * d.ratio;
    if (!d.moved && Math.hypot(dx, dy) < 3 * d.ratio) return;
    if (!d.moved) { d.block.setPointerCapture(event.pointerId); d.block.classList.add('dragging'); }
    d.moved = true; event.preventDefault();
    let scale = d.scale, width = d.width, height = d.height, x = d.x + dx, y = d.y + dy;
    if (d.resizing) { const factor = 1 + (dx * d.width + dy * d.height) / (d.width * d.width + d.height * d.height); scale = Math.max(.5, Math.min(2, Math.round(d.scale * factor * 100) / 100)); width *= scale / d.scale; height *= scale / d.scale; x = d.x; y = d.y; }
    const inset = 18 * d.ratio;
    x = Math.max(inset, Math.min(d.canvasWidth - width - inset, x)); y = Math.max(inset, Math.min(d.canvasHeight - height - inset, y));
    const placement = lakeOverlayPlacement({ ...d, x, y, width, height, scale, snap: d.resizing ? 0 : 12 * d.ratio, follow: !d.resizing });
    lakeOverlayApply(d.form, placement);
  });
  const finish = event => {
    const d = lakeObsDrag; if (!d || d.pointer !== event.pointerId) return;
    lakeObsDrag = null; d.block.classList.remove('dragging');
    for (const guide of d.frame.querySelectorAll('.lake-obs-guide-x, .lake-obs-guide-y')) guide.hidden = true;
    if (d.block.hasPointerCapture(event.pointerId)) d.block.releasePointerCapture(event.pointerId);
    if (d.moved) { clearTimeout(lakeObsSaveTimer); lakeObsSaveTimer = null; scheduleAutosave(d.form, true); }
  };
  settingsDialog.addEventListener('pointerup', finish); settingsDialog.addEventListener('pointercancel', finish);
  const beginEdit = node => {
    if (node.contentEditable === 'true') return;
    node.dataset.original = node.textContent; node.contentEditable = 'true'; node.setAttribute('aria-readonly', 'false'); node.focus();
    // The lilac caret waits at the end, as in every in-place edit; nothing is painted with a selection.
    const range = document.createRange(); range.selectNodeContents(node); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  };
  settingsDialog.addEventListener('dblclick', event => { const node = event.target.closest('[data-ovp-edit]'); if (node) { event.preventDefault(); beginEdit(node); } });
  settingsDialog.addEventListener('focusout', event => {
    const node = event.target.closest('[data-ovp-edit]'); if (!node || node.contentEditable !== 'true') return;
    const name = node.dataset.ovpEdit, form = node.closest('form'), value = String(node.textContent || '').trim();
    const limit = name === 'title' ? 24 : 64;
    // An emptied title simply goes back, as it does on the lake.
    if (node.dataset.cancelled || (name === 'title' && !value)) { node.textContent = node.dataset.original; delete node.dataset.cancelled; }
    else if ([...value].length > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) { node.textContent = node.dataset.original; showToast(t(name === 'title' ? '请填写 1 到 24 字的叠加层主标题' : '副标题最多 64 个字'), true); }
    else { form.elements[name].value = value; scheduleAutosave(form, true); }
    node.contentEditable = 'false'; node.setAttribute('aria-readonly', 'true'); delete node.dataset.original; updateOverlayPreview();
  });
  settingsDialog.addEventListener('keydown', event => {
    const node = event.target.closest('[data-ovp-edit]');
    if (node && ['Enter', 'Escape'].includes(event.key) && !event.isComposing) { event.preventDefault(); if (node.contentEditable !== 'true') { if (event.key === 'Enter') beginEdit(node); } else { if (event.key === 'Escape') node.dataset.cancelled = 'true'; node.blur(); } return; }
    if (event.target.closest('[contenteditable="true"]')) return;
    const block = event.target.closest('[data-ovp-drag]'); if (!block || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(event.key)) return;
    event.preventDefault(); const form = block.closest('form'), frame = block.closest('.lake-obs-canvas'); const m = lakeOverlayMeasure(frame, block);
    let scale = Number(form.elements.scale.value) || 1;
    const oldScale = scale, resizing = event.target.matches('[data-ovp-resize]') || ['+', '-', '='].includes(event.key);
    if (resizing) scale = Math.max(.5, Math.min(2, Math.round((scale + (['ArrowLeft', 'ArrowDown', '-'].includes(event.key) ? -.05 : .05)) * 100) / 100));
    else {
      const amount = event.shiftKey ? 10 : 1;
      // Exact pixel nudges must not round-trip through subpixel CSS layout.
      lakeOverlayApply(form, { corner: form.elements.corner.value, scale, offset_x: (Number(form.elements.offset_x.value) || 0) + (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0), offset_y: (Number(form.elements.offset_y.value) || 0) + (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0) }, true);
      return;
    }
    lakeOverlayApply(form, lakeOverlayPlacement({ ...m, width: m.width * scale / oldScale, height: m.height * scale / oldScale, scale, corner: form.elements.corner.value }), true);
  });
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
  await commitLakeReadingRows(true);
  await commitLakeRoomNumber().catch(() => { /* The command already showed its error. */ });
  if (!await flushAutosaves(true)) return false;
  // This app never asks to discard a draft: what saves itself is saved by now,
  // and an unfinished form is simply left behind.
  for (const form of settingsDialog.querySelectorAll('[data-form][data-dirty]')) if (manualSaveFormTypes.has(form.dataset.form)) delete form.dataset.dirty;
  return true;
}

async function closeSettings() {
  if (!await allowLeaveSettings()) return;
  if (!await settleVoiceAuditionChoice()) return;
  closeSelect();
  if (editor?.type === 'qr') await cancelQr();
  if (editor?.type === 'qr') editor = null;
  tabEditors.set(settingsTab, editor);
  settingsDirty = false;
  closeSettingsDialog(() => {
    if (step === 'main') updateLive();
    if (step === 'login' && !qrProvider) void startQr('bilibili');
    if (step === 'doubaoQr' && !qrProvider) void startQr('doubao');
  });
}

// The drawer and its veil slide back out before the dialog closes. Opening again
// mid-way finishes the close first, so the drawer always enters from the side.
let settingsLeaving = null;
function finishSettingsLeave() {
  const leaving = settingsLeaving;
  if (!leaving) return;
  settingsLeaving = null; clearTimeout(leaving.timer);
  settingsDialog.classList.remove('lake-leaving'); document.querySelector('.lake-settings-scrim')?.classList.remove('lake-leaving');
  if (settingsDialog.open) settingsDialog.close();
  leaving.after?.();
}
function closeSettingsDialog(after) {
  if (settingsLeaving) return;
  if (!settingsDialog.open || !motionAllowed() || !settingsDialog.classList.contains('lake-settings')) { if (settingsDialog.open) settingsDialog.close(); after?.(); return; }
  settingsDialog.classList.add('lake-leaving'); document.querySelector('.lake-settings-scrim')?.classList.add('lake-leaving');
  settingsLeaving = { after, timer: setTimeout(finishSettingsLeave, 220) };
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
  finishSettingsLeave();
  if (settingsDialog.open && !await allowLeaveSettings()) return;
  if (qrProvider) await cancelQr();
  if (!tab && !settingsDialog.open) { settingsTab = 'home'; editor = null; }
  if (tab) { chooseLivePanel(tab); tab = settingsTabId(tab); }
  if (tab && tab !== settingsTab) { tabEditors.set(settingsTab, editor); settingsTab = tab; editor = tabEditors.get(tab) || null; renderSettings(); }
  else if (!settingsDialog.open || !settingsDialog.querySelector('.settings-shell')) renderSettings();
  if (!settingsDialog.open) settingsDialog.show();
  placeSettingsInk();
  updateObsSettings();
  void refreshLocalServices(true);
}

async function openViewerSettings(tab, nextEditor) {
  finishSettingsLeave();
  if (qrProvider) await cancelQr();
  tabEditors.set(settingsTab, editor);
  settingsTab = settingsTabId(tab);
  editor = nextEditor;
  renderSettings();
  if (!settingsDialog.open) settingsDialog.show();
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
  if (await handleLakeMainAction(action, id, target)) return;
  if (await handleLakeSettingsAction(action, id, target)) return;
  if (typeof handleLakeObsAction === 'function' && await handleLakeObsAction(action, id, target)) return;
  if (await handleLakeVoiceAction(action, id, target)) return;
  if (action === 'toast.undo') {
    const undo = toastUndo; toastUndo = null; clearTimeout(toastTimer);
    document.querySelector('#toast').hidden = true;
    if (undo) await undo();
    return;
  }
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
    // onError already reverted the slider to the saved gain; a stale failure
    // must not block every later mute click.
    if (volumeSave.error) volumeSave.cancel();
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
    updateLakeVersionRows();
    try { updateInfo = await invoke('check_update'); }
    catch (error) { updateError = errorMessage(error, 'DV-U01'); }
    finally { updateBusy = false; updateLakeVersionRows(); }
    return;
  }
  if (settingsDialog.open && !['settings.close', 'settings.tab', 'editor.cancel', 'autosave.retry', 'autosave.discard', 'overlay.preview', 'overlay.copy', 'live.panel', 'obs.auto_detect'].includes(action) && !action.startsWith('dictionary.')) {
    const replacesSettings = ['room.anonymous', 'bili.use_account', 'bili.logout', 'bili.begin', 'doubao.begin', 'fish.restore_builtin', 'service.configure', 'onboarding.reset'].includes(action);
    if (!await (replacesSettings ? allowLeaveSettings() : flushAutosaves())) return;
  }
  if (action === 'settings.tab') await settleVoiceAuditionChoice();
  if (action === 'tts.open') {
    const menu = document.querySelector('#tts-menu');
    if (!menu.hidden && !isLeaving(menu)) { closeVoicePanel(); return; }
    cancelLeave(menu);
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
    await settleVoiceAuditionChoice();
    const preset = snapshot.presets.find(item => item.id === id);
    if (!preset) return;
    if (preset.id === snapshot.rules?.default_preset_id) return;
    if (preset.provider === 'doubao' && !doubaoConnection(preset)?.has_credential) { closeVoicePanel(); return guideDoubaoLogin(preset.id); }
    await command('presets.default', { id: preset.id }, { quiet: true });
    showToast(getLanguage() === 'en' ? `Future chat will use “${presetLabel(preset)}”.` : `之后的弹幕用「${presetLabel(preset)}」播报`);
    renderVoicePanel();
    return;
  }
  if (action === 'voice.audition') {
    auditionPresetId = id; auditionStartedAt = Date.now(); renderVoicePanel();
    const preset = snapshot.presets.find(item => item.id === id);
    if (!preset) return;
    await command('audition', { preset_id: id, text: await voicePanelAuditionText(preset) }, { quiet: true });
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
    await revealTheme(next, target);
    updateThemeControl(); updateLakeClock();
    await command('preferences.save', { preferences: { appearance: next } }, { quiet: true });
    for (const choice of settingsDialog.querySelectorAll('input[name="appearance"]')) choice.checked = choice.value === next;
    return;
  }
  if (action === 'lake.prepare') { lakeEnded = false; lakeTranscriptSignature = ''; onAirSignature = ''; updateLive(); return; }
  if (action === 'history.open') {
    closeVoicePanel(); closeQueuePanel();
    const dialog = document.querySelector('#lake-history-dialog');
    if (!dialog.open) dialog.showModal();
    const events = normalizedEvents(snapshot);
    renderLakeHistory(events, eventKeys(events));
    const scroll = document.querySelector('#chat-scroll');
    setScrollTop(scroll, 0);
    return;
  }
  if (action === 'audience.open') {
    const dialog = document.querySelector('#audience-dialog');
    if (dialog?.open && audiencePinned) { closeAudience(); return; }
    audienceReturn = false; await closeViewerDrawer(); closeVoicePanel(); chatEmoticonsOpen = false; updateChatCompose(); openAudience(); return;
  }
  if (action === 'lake.pop.close') {
    closeVoicePanel(); closeAudience(false); chatEmoticonsOpen = false; updateChatCompose();
    if (onAirPanelMode === 'info') closeOnAirPanel();
    updateLakePopScrim(); return;
  }
  if (action === 'audience.close') return closeAudience();
  if (action === 'viewer.open' || action === 'audience.viewer') {
    const item = action === 'audience.viewer' ? audienceEntries.get(id) : feedEvents.get(id);
    if (!item) return;
    closeVoicePanel();
    document.querySelector('#queue-panel')?.setAttribute('hidden', '');
    await flushViewerAlias();
    if (action === 'audience.viewer') { closeAudience(false); audienceReturn = false; }
    else audienceReturn = false;
    viewerContext = item;
    document.querySelector('#lake-history-dialog')?.close();
    viewerOpenIdentity = viewerIdentity(item);
    renderViewerDrawer();
    void refreshViewerModeration().catch(() => updateViewerModeration());
    feedSignature = '';
    liveRenderSignature = '';
    updateLive();
    return;
  }
  if (action === 'viewer.close') return closeViewerDrawer();
  if (action === 'viewer.at') {
    if (!viewerContext || !snapshot.account?.user_id || snapshot.network_disabled) return;
    const name = String(viewerContext.user_name || '').trim();
    if (!name) return;
    await flushViewerAlias();
    const limit = snapshot.chat_send?.message_limit || 20;
    chatMessageDraft = truncateUtf16(`@${name} ${chatMessageDraft}`, limit);
    await closeViewerDrawer();
    updateChatCompose();
    const input = document.querySelector('#chat-message');
    if (input) { input.value = chatMessageDraft; input.focus({ preventScroll: true }); }
    return;
  }
  if (action === 'chat.emoticons') { chatEmoticonsOpen = !chatEmoticonsOpen; updateChatCompose(); if (chatEmoticonsOpen) return refreshChatEmoticons(); return; }
  if (action === 'chat.emoticon.pack') return selectChatEmoticonPack(Number(id), true);
  if (action === 'chat.emoticon.send') return sendChatMessage(id);
  if (action === 'viewer.moderation.refresh') return refreshViewerModeration();
  if (action.startsWith('viewer.moderation.')) return moderateViewer(action.slice('viewer.moderation.'.length));
  if (action === 'viewer.bind') return bindViewerVoice(id || '');
  if (action === 'viewer.audition') {
    const event = viewerContext;
    if (!event) return;
    const presetId = (viewerBinding(event)?.binding?.enabled && viewerBinding(event).binding.preset_id) || snapshot.rules?.default_preset_id;
    if (!presetId) throw new Error(t('请先添加一个声音预设'));
    await flushViewerAlias();
    const spoken = viewerAliasValue(event) || event.user_name || t('访客');
    return command('audition', { preset_id: presetId, text: `${spoken}${t('：')}${eventText(event) || t('你好，欢迎来到直播间。')}` }, { quiet: true });
  }
  if (action === 'viewer.manage') {
    await flushViewerAlias();
    viewerContext = null; viewerOpenIdentity = ''; audienceReturn = false; renderViewerDrawer();
    return openSettings('voices');
  }
  if (action === 'autosave.retry') { const form = target.closest('form'); scheduleAutosave(form, true); await autosaves.get(form)?.queue.flush(); return; }
  if (action === 'autosave.discard') {
    const form = target.closest('form'); const record = autosaves.get(form);
    if (record) { record.touched = false; record.queue.cancel(); await record.queue.flush(); formDrafts.delete(record.key); renderSettings(); }
    return;
  }
  if (action === 'settings.open' || action === 'settings.room') {
    closeVoicePanel();
    const aliasSaved = !viewerContext || await flushViewerAlias();
    if (viewerContext) { viewerContext = null; viewerOpenIdentity = ''; renderViewerDrawer(); }
    await openSettings(action === 'settings.room' ? 'room' : 'home');
    // The failure toast sits beneath modal settings; repeat it inside them.
    if (!aliasSaved && viewerAliasSave.error) showError(viewerAliasSave.error);
    return;
  }
  if (action === 'settings.close') return closeSettings();
  if (action === 'broadcast.refresh') {
    // Refreshing is asking for B站's title and category, so it replaces the fields.
    const form = document.querySelector('[data-broadcast-scope] form[data-form="broadcast-room"][data-dirty]');
    if (form) delete form.dataset.dirty;
    return runBroadcastAction('refresh');
  }
  if (action === 'live.panel') {
    if (!livePanels.includes(id) || id === livePanel) return;
    livePanel = id;
    for (const tab of settingsDialog.querySelectorAll('[data-action="live.panel"]')) tab.setAttribute('aria-selected', String(tab.dataset.id === id));
    for (const panel of settingsDialog.querySelectorAll('[data-live-panel]')) panel.hidden = panel.dataset.livePanel !== id;
    if (id === 'broadcast') void refreshBroadcast();
    else { updateOverlayStatus(); updateOverlayPreview(); }
    return;
  }
  if (action === 'obs.test') return testObs();
  if (action === 'obs.launch') return launchObs();
  if (action === 'overlay.obs_add') return addOverlayToObs();
  if (action === 'obs.pick_executable' || action === 'obs.auto_detect') {
    const input = target.closest('form')?.elements.executable;
    if (!input) return;
    let path = '';
    if (action === 'obs.pick_executable') {
      const pick = window.__TAURI__?.dialog?.open;
      if (!pick) throw new Error(t('文件选择器不可用，请重新打开应用。'));
      path = await pick({ multiple: false, title: t('选择 obs64.exe'), filters: [{ name: 'OBS Studio', extensions: ['exe'] }] });
      if (typeof path !== 'string') return;
      if (!/(^|[\\/])obs64\.exe$/i.test(path)) throw new Error(t('请选择 OBS 的 obs64.exe'));
      setPickedPath(input, path);
    } else {
      input.value = '';
      const label = input.closest('.path-field')?.querySelector('[data-path-value]');
      const detected = snapshot.obs?.detected;
      if (label) { label.textContent = detected ? ui`自动：${detected}` : t('点击选择 obs64.exe'); label.classList.add('placeholder'); }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const form = input.closest('form');
    form.querySelector('[data-action="obs.auto_detect"]')?.toggleAttribute('hidden', !input.value);
    await flushObsForm();
    return;
  }
  if (action === 'obs.password.clear') {
    await command('obs.password', { password: '' }, { success: t('已清除 OBS 密码') });
    return;
  }
  if (action === 'broadcast.start') return startBroadcast();
  if (action === 'broadcast.stop') return stopBroadcast();
  if (action === 'onair.info') return openOnAirPanel('info');
  if (action === 'onair.obs') return openOnAirPanel('obs');
  if (action === 'onair.close') return closeOnAirPanel(true);
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
  if (action === 'overlay.test') {
    await command('overlay.test', { kind: id === 'super_chat' ? 'super_chat' : 'danmaku' }, { quiet: true });
    return;
  }
  if (action === 'settings.tab') {
    if (!await allowLeaveSettings()) return;
    if (editor?.type === 'qr') await cancelQr();
    tabEditors.delete(settingsTab);
    tabEditors.delete(settingsTabId(id));
    chooseLivePanel(id);
    settingsTab = settingsTabId(id); editor = null; renderSettings();
    void refreshLocalServices(true);
    document.querySelector('#settings-content').focus({ preventScroll: true }); return;
  }
  if (action === 'setup.start') return setStep('login');
  if (action === 'setup.qr') return setStep('login');
  if (action === 'setup.back') {
    await cancelQr();
    const previous = { connect: 'welcome', login: 'welcome', tts: 'login', doubaoQr: 'tts', ready: 'tts' };
    return setStep(previous[step] || 'welcome');
  }
  if (action === 'setup.continue') return setStep('tts');
  if (action === 'setup.rescan') { setupRescan = true; renderApp(); return startQr('bilibili'); }
  if (action === 'setup.doubao') { setStep('doubaoQr'); return startQr('doubao'); }
  if (action === 'setup.silent') { await cancelQr(); setupTts = false; return setStep('ready'); }
  if (action === 'setup.finish') { await command('onboarding.finish', { tts_enabled: setupTts, connect: true }); replaySetup = false; step = 'main'; renderApp(); return; }
  if (action === 'qr.retry') {
    const inSettings = settingsDialog.open && editor?.type === 'qr';
    return startQr(inSettings ? editor.provider : step === 'doubaoQr' ? 'doubao' : 'bilibili', inSettings ? editor.id : undefined);
  }
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
  if (action === 'room.anonymous' || action === 'setup.uid') throw new Error(t('请扫码登录哔哩哔哩后接收弹幕'));
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
  if (action === 'service.configure') { editor = { type: 'service', provider: id }; renderSettings(); return; }
  if (action === 'service.pick_directory') {
    const pick = window.__TAURI__?.dialog?.open;
    if (!pick) throw new Error(t('目录选择器不可用，请重新打开应用。'));
    const directory = await pick({ directory: true, multiple: false, title: t('选择 TTS 安装目录') });
    if (typeof directory === 'string') {
      const input = target.closest('form').elements.directory;
      setPickedPath(input, directory);
      if (await flushAutosaves()) {
        const connect = settingsDialog.querySelector('[data-action="voice.local.connect"]');
        if (connect) connect.disabled = !directory.trim();
      }
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
    if (!await allowLeaveSettings()) return;
    if (editor?.type === 'qr') await cancelQr();
    editor = null; tabEditors.delete(settingsTab); renderSettings(); return;
  }
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
  if (action === 'reconnect') return boot();
}

function eventFromForm(data) {
  const uid = data.get('user_id');
  if (uid && !validUid(uid)) throw new Error(t('观众 UID 需要是有效的正整数。'));
  return { room_id: snapshot.setup?.room_id || 1, user_id: uid ? numericId(uid) : null, user_name: String(data.get('user_name')), kind: String(data.get('kind')), message: String(data.get('message') || ''), gift_name: String(data.get('gift_name') || ''), quantity: Number(data.get('quantity') || 1), price_yuan: Number(data.get('price_yuan') || 0), coin_type: String(data.get('coin_type') || 'gold'), guard_name: String(data.get('guard_name') || ''), platform_event_id: null, observed_at_ms: 0 };
}

async function handleForm(form, submitter) {
  const type = form.dataset.form;
  if (type === 'chat-send') return sendChatMessage();
  if (type === 'broadcast-room') return saveBroadcastForm(form);
  if (type === 'obs-password') {
    const input = form.elements.password;
    if (!input.value) throw new Error(t('请输入 OBS WebSocket 密码'));
    try { await command('obs.password', { password: input.value }, { success: t('OBS 密码已加密保存') }); }
    finally { input.value = ''; }
    updateObsSettings();
    return;
  }
  const data = new FormData(form);
  const value = key => String(data.get(key) ?? '').trim();
  const number = key => Number(data.get(key));
  const checked = key => data.has(key);
  const id = form.dataset.id || '';
  if (type === 'language') { await changeLanguage(value('language')); return; }
  if (type === 'anonymous' || type === 'room-uid') throw new Error(t('请扫码登录哔哩哔哩后接收弹幕'));
  if (type === 'voice-audition') {
    if (!await flushAutosaves()) return;
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
    editor = { type: 'voice-add', provider: 'fish_audio' };
  } else if (type === 'fish-settings') {
    const connectionId = form.dataset.connectionId;
    if (!snapshot.connections.some(connection => connection.id === connectionId && connection.settings.provider === 'fish_audio' && connection.has_credential)) throw new Error(t('请先连接 Fish Audio 账号。'));
    const settings = { model: value('model'), latency: value('latency'), volume_db: number('volume_db'), temperature: number('temperature'), top_p: number('top_p'), streaming: true };
    if (!Number.isFinite(settings.volume_db) || settings.volume_db < -20 || settings.volume_db > 20 || ![settings.temperature, settings.top_p].every(item => Number.isFinite(item) && item >= 0 && item <= 1)) throw new Error(t('合成音量须在 -20–20 dB，温度与 Top P 须在 0–1 之间。'));
    await command('fish.settings.save', { connection_id: connectionId, settings }, { success: t('Fish Audio 生成设置已保存') });
  } else if (type === 'tts-toggle') {
    await command('preferences.save', { preferences: { tts_enabled: checked('tts_enabled') } }, { success: t('播报开关已保存') });
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
    node.innerHTML = `<div class="notice">${preview.filtered_reason ? ui`已过滤：${esc(t(preview.filtered_reason))}` : ui`${esc(preview.final_text || t('没有可播报的文字'))}<br>声音：${esc(preview.voice?.name || t('未指定默认声音'))}${preview.pending_legacy_binding ? t('<br>同名旧绑定待确认 UID，尚未应用。') : ''}`}</div><pre class="code-output">${esc(JSON.stringify(preview.parts, null, 2))}</pre>`;
    return;
  } else if (type === 'audio') {
    const output = value('output') ? { named: value('output') } : 'default';
    const needsConfirm = JSON.stringify(output) !== JSON.stringify(snapshot.preferences.output);
    if (needsConfirm && !await confirmAction(t('应用新的音频输出？'), t('当前播放和待播队列会停止。'), t('应用并停止播放'), false)) return;
    await command('preferences.save', { preferences: { output }, confirmed: needsConfirm }, { success: t('音频设置已保存') });
  } else if (type === 'appearance') {
    await command('preferences.save', { preferences: { appearance: value('appearance'), scale: number('scale') } }, { success: t('外观已保存') });
  } else if (type === 'startup') {
    await command('startup.set', { enabled: checked('enabled') }, { success: t('启动选项已保存') });
  }
  settingsDirty = false;
  renderSettings();
}

document.addEventListener('click', async event => {
  if (event.target.id === 'chat-message' && chatEmoticonsOpen) { chatEmoticonsOpen = false; updateChatCompose(); updateLakePopScrim(); }
  const ttsMenu = document.querySelector('#tts-menu');
  if (ttsMenu && !ttsMenu.hidden && !ttsMenu.contains(event.target) && !event.target.closest('[data-action="tts.open"]')) closeVoicePanel();
  const queuePanel = document.querySelector('#queue-panel');
  if (queuePanel && !queuePanel.hidden && !queuePanel.contains(event.target) && !event.target.closest('[data-action="queue.toggle"]')) {
    closeQueuePanel();
  }
  const onAirPanel = document.querySelector('#onair-panel');
  if (onAirPanel && !onAirPanel.hidden && !onAirPanel.contains(event.target) && !event.target.closest('.select-menu, #onair, #lake-title, #confirmation')) {
    if (onAirPanelMode === 'obs') void saveOverlayTitleForm(onAirPanel.querySelector('form[data-form="overlay-title"]')).catch(showError);
    else if (onAirPanelMode !== 'face') closeOnAirPanel();
  }
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) { updateLakePopScrim(); return; }
  const wasDisabled = target.disabled;
  target.disabled = true;
  try { await handleAction(target.dataset.action, target.dataset.id, target); }
  catch (error) { showError(error); }
  finally {
    updateLakePopScrim();
    if (target.isConnected) {
      target.disabled = wasDisabled;
      if (['service.start', 'service.stop', 'service.check'].includes(target.dataset.action)) updateServiceIndicators();
      if (target.dataset.action.startsWith('chat.emoticon')) updateChatCompose();
    }
  }
});

document.addEventListener('compositionstart', event => {
  if (event.target.id === 'viewer-alias' || event.target.id === 'chat-message') composingInputs.add(event.target);
  if (event.target.closest?.('#onair-panel:is([data-mode="info"],[data-mode="obs"])')) composingInputs.add(event.target);
});
document.addEventListener('compositionend', event => {
  if (event.target.closest?.('#onair-panel:is([data-mode="info"],[data-mode="obs"])')) composingInputs.delete(event.target);
  if (event.target.id === 'viewer-alias') { composingInputs.delete(event.target); scheduleViewerAlias(event.target.value); }
  if (event.target.id === 'chat-message') { composingInputs.delete(event.target); chatMessageDraft = event.target.value; }
});

document.addEventListener('input', event => {
  if (event.target.id === 'chat-message') { chatMessageDraft = event.target.value; return; }
  const overlayTitleForm = event.target.closest?.('form[data-form="overlay-title"]');
  if (overlayTitleForm) {
    overlayTitleForm.dataset.dirty = 'true';
    const digits = overlayTitleForm.querySelector('[data-count-number]');
    if (digits) digits.textContent = String(Array.from(event.target.value).length);
    return;
  }
  const broadcastForm = event.target.closest?.('form[data-form="broadcast-room"]');
  if (broadcastForm) {
    broadcastForm.dataset.dirty = 'true';
    if (event.target.name === 'title') {
      const count = broadcastForm.querySelector('[data-title-count]');
      const length = Array.from(event.target.value.trim()).length;
      if (count) {
        const digits = count.querySelector('[data-count-number]');
        if (digits) digits.textContent = String(Array.from(event.target.value).length);
        else count.textContent = `${length}/40`;
        count.classList.toggle('over', length > 40 || !length);
      }
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
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('.chat-hit[role="button"]')) { event.preventDefault(); event.target.click(); return; }
  if (event.target.closest?.('#onair-panel[data-mode="info"]') && event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || composingInputs.has(event.target))) { event.preventDefault(); return; }
  if (event.target.closest?.('#onair-panel[data-mode="info"]') && event.key === 'Enter' && !event.target.closest('.select-menu') && !event.isComposing && event.keyCode !== 229 && !composingInputs.has(event.target)) {
    event.preventDefault();
    const form = event.target.closest('form[data-form="broadcast-room"]');
    if (form && !broadcastBusy) void saveBroadcastForm(form).catch(showError);
    return;
  }
  if (event.target.closest?.('#onair-panel[data-mode="obs"]') && event.key === 'Enter') {
    event.preventDefault();
    if (event.isComposing || event.keyCode === 229 || composingInputs.has(event.target)) return;
    void saveOverlayTitleForm(event.target.closest('form[data-form="overlay-title"]')).catch(showError);
    return;
  }
  if (event.target.id === 'chat-message' && event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || composingInputs.has(event.target))) { event.preventDefault(); return; }
  if (event.key !== 'Escape' || settingsDialog.open || confirmationDialog.open) return;
  if (document.querySelector('#audience-dialog')?.open) { event.preventDefault(); closeAudience(); return; }
  if (chatEmoticonsOpen) { event.preventDefault(); chatEmoticonsOpen = false; updateChatCompose(); updateLakePopScrim(); return; }
  if (viewerContext) { event.preventDefault(); void closeViewerDrawer().catch(showError); return; }
  const ttsMenu = document.querySelector('#tts-menu');
  if (ttsMenu && !ttsMenu.hidden) { closeVoicePanel(); updateLakePopScrim(); document.querySelector('#tts-switch')?.focus(); return; }
  const queuePanel = document.querySelector('#queue-panel');
  if (queuePanel && !queuePanel.hidden) { closeQueuePanel(true); return; }
  const onAirPanel = document.querySelector('#onair-panel');
  if (onAirPanel && !onAirPanel.hidden) void handleAction('onair.close').then(updateLakePopScrim).catch(showError);
});

document.addEventListener('error', event => {
  if (event.target.classList?.contains('avatar-photo') || event.target.classList?.contains('account-photo')) event.target.remove();
  else if (event.target.classList?.contains('message-emote')) {
    const fallback = document.createElement('span');
    fallback.className = `${event.target.className} emote-unavailable`;
    fallback.setAttribute('role', 'img');
    fallback.setAttribute('aria-label', event.target.getAttribute('aria-label') || t('表情包'));
    fallback.innerHTML = chatEmoticonImageFallback();
    event.target.replaceWith(fallback);
  }
}, true);

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.form === 'chat-send' && composingInputs.has(form.querySelector('#chat-message'))) return;
  if (form.dataset.form === 'overlay-title') return;
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
  finally {
    delete form.dataset.busy;
    form.removeAttribute('aria-busy');
    if (submitter?.isConnected) submitter.disabled = false;
    if (form.dataset.form === 'chat-send') updateChatCompose();
  }
});

settingsDialog.addEventListener('cancel', event => { event.preventDefault(); void closeSettings(); });
settingsDialog.addEventListener('compositionstart', event => { composingInputs.add(event.target); });
// Remember the person's own unfolding of the OBS connection details across re-renders.
// (A details element rendered open also fires "toggle", so only summary clicks count.)
settingsDialog.addEventListener('click', event => {
  const details = event.target.closest?.('[data-obs-more] > summary')?.parentElement;
  if (details) obsDetailsOpen = !details.open;
});
settingsDialog.addEventListener('compositionend', event => {
  composingInputs.delete(event.target);
  const form = event.target.closest('[data-form]');
  if (event.target.matches?.('[data-lake-template]')) form.elements[`template_${event.target.dataset.lakeTemplate}`].value = lakeTemplateText(event.target);
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
  if (form && manualSaveFormTypes.has(form.dataset.form)) form.dataset.dirty = 'true';
  if (form && autoFormTypes.has(form.dataset.form)) scheduleAutosave(form, false, event.target.name === 'uid', event.isComposing || composingInputs.has(event.target));
});
settingsDialog.addEventListener('change', async event => {
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
  const form = event.target.closest('[data-form]');
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
window.addEventListener('pagehide', () => { disposed = true; cancelAnimationFrame(lakePresentationFrame); lakePresentationFrame = 0; clearInterval(lakeClockTimer); clearFoldingRows(); stopQrPolling(); closeSelect(); clearTimeout(snapshotTimer); clearTimeout(fallbackStatusTimer); });
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
  else {
    restoreLakePresentation();
    if (qrProvider && !qrBusy && !qrFailure && ['waiting', 'scanned'].includes(snapshot?.qr?.status)) scheduleQrPoll(qrProvider, qrGeneration);
  }
}
window.addEventListener('resize', () => { stopSetupSceneMotion(); if (document.querySelector('#audience-dialog')?.open) placeAudience(); }, { passive: true });
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
  const policy = snapshotPollingPolicy(snapshot, { step, hidden: document.hidden, focused: nativeActive ?? windowFocused, settingsOpen: settingsDialog.open && settingsTab === 'voices' });
  if (!policy.poll && !pendingCommands) return;
  snapshotTimer = setTimeout(pollSnapshot, immediate ? 0 : policy.delay);
}

async function pollSnapshot() {
  if (disposed) return;
  const policy = snapshotPollingPolicy(snapshot, { step, hidden: document.hidden, focused: nativeActive ?? windowFocused, settingsOpen: settingsDialog.open && settingsTab === 'voices' });
  if (policy.poll) {
    // Polls continue while commands run; a reply that could predate the latest
    // command reply or a newer poll is dropped instead of rolling state back.
    const poll = async args => { const ticket = snapshotSequence.poll(); const next = await invoke('snapshot', args); if (!snapshotSequence.fresh(ticket)) return; snapshotSequence.accept(ticket); acceptSnapshot(next); };
    try { await poll({ configRevision: snapshot?.config_revision }); }
    catch (error) { try { await poll(); } catch { showError(error); } }
  }
  void refreshLocalServices();
  scheduleSnapshotPolling();
}

async function boot() {
  if (!boot.lakeInstalled) {
    installLakeVoiceEvents();
    installLakeSettingsEvents();
    if (typeof installLakeObsEvents === 'function') installLakeObsEvents();
    boot.lakeInstalled = true;
  }
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
