// Visual parity evidence against the user's actual exported Lake design.
// Only this local HTTP test server installs fictional IPC and deterministic dates.
// Neither fixture data nor reference demo logic is bundled into the desktop app.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {createHash} = require('node:crypto');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const repo = path.resolve(__dirname, '..');
const uiRoot = path.join(repo, 'crates/desktop/ui');
const referenceRoot = path.join(repo, 'target/lake-reference/interactive');
const referenceFontRoot = path.resolve(process.env.DV_REFERENCE_FONT_CACHE || path.join(repo, 'target/lake-reference/font-cache'));
const priorVoiceMeasurementsPath = path.join(repo, 'target/persistence-chat-fix/lake-parity/actual-measurements.json');
const priorVoiceMeasurementsSha256 = '129ed0e1bbc5ce133cb168103ca35802bfa35d8f99b1c69993755a732b07df18';
const output = path.resolve(process.env.DV_PARITY_OUTPUT || path.join(repo, 'target/lake-parity'));
const longTexts = Object.fromEntries([17,26,27,160].map(length => [`length${length}`, '湖'.repeat(length)]));
const modes = ['live', 'calm', 'empty', 'editor', 'area-parent', 'area-child', 'card', 'toast', 'audience', 'history', 'voice', 'offair', 'face', 'ended', 'emote', ...Object.keys(longTexts)];
const errors = [];
const fixedNow = Date.parse('2026-10-06T14:24:00.000Z');
const fixturePackIcons = ['https://i0.hdslb.com/bfs/emote/parity-pack-text.png', 'https://i0.hdslb.com/bfs/emote/parity-pack-greeting.png'];
const fixtureItemIcons = ['https://i0.hdslb.com/bfs/emote/parity-item-goodnight.png', 'https://i0.hdslb.com/bfs/emote/parity-item-applause.png'];
const fixtureTextEmotes = ['晚上好', '好听', '晚安', '鼓掌', '加油', '谢谢', '月亮', '星星', '爱心', '喝水', '开心', '欢呼', '赞', '抱抱', '期待', '听歌', '来了', '支持', '再见', ...Array.from({length: 20}, (_, index) => `图标${index + 1}`)];
const referenceSelectors = {
  titlebar: '.tb', brand: '.tb-brand', logo: '.tb-logo',
  themeButton: '.tb-tools .tb-btn:first-child', settingsButton: '.tb-tools .tb-btn:nth-child(2)', windowMin: '.tb-win[aria-label="最小化"]', windowMax: '.tb-win[aria-label="最大化"]', windowClose: '.tb-win[aria-label="关闭"]', composeForm: '.lin',
  toast: '.toast', toastButton: '.toast button',
  sky: '.sky', stars: '.stars', cloud1: '.cloud', cloud2: '.cloud:nth-of-type(2)',
  orb: '.orb', ridge1: '.ridge', ridge2: '.ridge2', horizon: '.horizon', water: '.water', path: '.path', waveform: '.hwave', wave: '.wv',
  daypart: '.daytxt', daypartFirst: '.daytxt>span:first-child', date: '.date', titleRow: '.ttl-row', title: '.ttl', audience: '.watch',
  currentMeta: '.who', currentText: '.line', currentFirstLine: '.line .ln', currentName: '.who .nm', currentTime: '.who em', still: '.still',
  history: '.sunk', historyFirst: '.sunk .s1', historyText: '.sunk .s1 span:last-child', historyLink: '.more',
  onair: '.right', footer: '.foot', dock: '.vm', compose: '.lin', composeInput: '.lin input', composeSend: '.lin button:last-child',
  editor: '.edit', editorKicker: '.edit .ed-k', editorInput: '.edit .ei.big input', editorArea: '.edit .area', editorSave: '.edit .pbtn', areaMenu: '.alist',
  viewer: '.sheet', viewerName: '.vw-name', viewerBody: '.vw-body', viewerAvatar: '.vw-top .ava', aliasField: '.sheet .fld', aliasInput: '.sheet .fld input', voiceChips: '.sheet .chips', muteDurations: '.sheet .durs', muteButton: '.sheet .rose', blockButton: '.sheet .line-btn', viewerQuick: '.vw-q', viewerQuickButton: '.vw-q button', viewerSaid: '.sheet .said', viewerSubtitle: '.vw-sub', adminSwitch: '.sheet .sw', voiceChip: '.sheet .chip',
  audiencePanel: '.pop-aud', audienceCount: '.aud-n b', audienceList: '.aud-list',
  historyPanel: '.sheet', historyHeading: '.hs-h', historyPanelList: '.hs-list', voicePanel: '.pop-voice', voiceHeading: '.pop-voice .kk', facePanel: '.modal', faceTitle: '.modal h3', faceNote: '.modal p', faceQr: '.modal .qr', faceButton: '.modal .pbtn', emotePanel: '.pop-emo',
  cloud1: '.cloud:nth-child(4)', cloud2: '.cloud:nth-child(5)', cloud3: '.cloud:nth-child(6)',
  shooting: '.shoot', ripple1: '.ripple:nth-of-type(8)', bird1: '.bird:nth-of-type(6)',
};
const appSelectors = {
  titlebar: '#titlebar', brand: '.titlebar-brand', logo: '.titlebar-brand img',
  themeButton: '#titlebar-actions [data-action="theme.toggle"]', settingsButton: '#titlebar-actions [data-action="settings.open"]', windowMin: '#titlebar [data-window="minimize"]', windowMax: '#titlebar [data-window="maximize"]', windowClose: '#titlebar [data-window="close"]', composeForm: '#chat-compose form',
  toast: '#toast:not([hidden])', toastButton: '#toast [data-action="toast.undo"]',
  sky: '.lake-sky', stars: '.lake-stars', cloud1: '.lake-cloud.cloud-one', cloud2: '.lake-cloud.cloud-two',
  orb: '.lake-orb', ridge1: '.lake-ridge.ridge-far', ridge2: '.lake-ridge.ridge-near', horizon: '.lake-horizon', water: '.lake-water', path: '.lake-reflection', waveform: '.lake-waves', wave: '.lake-wave',
  daypart: '#lake-daypart', daypartFirst: '#lake-daypart>span:first-child', date: '#lake-date-time', titleRow: '.lake-room-row', title: '#lake-title', audience: '#audience-count',
  currentMeta: '#lake-current .lake-message-meta', currentText: '#lake-current .lake-message-text', currentFirstLine: '#lake-current .lake-text-line', currentName: '#lake-current .lake-message-name', currentTime: '#lake-current time', still: '.lake-state-still',
  history: '#lake-history', historyFirst: '#lake-history .lake-message:first-child', historyText: '#lake-history .lake-message:first-child .lake-message-text', historyLink: '.lake-history-open',
  onair: '#onair', footer: '.lake-foot', dock: '#tts-switch', compose: '#chat-compose', composeInput: '#chat-message', composeSend: '#chat-compose button[type="submit"]',
  editor: '#onair-panel[data-mode="info"]', editorKicker: '.lake-edit-kicker', editorInput: '#onair-panel input[name="title"]', editorArea: '.onair-areas', editorSave: '.onair-save', areaMenu: '.select-menu',
  viewer: '.viewer-sheet', viewerName: '.viewer-name', viewerBody: '.viewer-body', viewerAvatar: '.viewer-head .avatar', aliasField: '.viewer-alias-field', aliasInput: '#viewer-alias', voiceChips: '#viewer-voices', muteDurations: '.viewer-durations', muteButton: '.viewer-mute-action', blockButton: '.viewer-block-row .viewer-line-button', viewerQuick: '.viewer-quick', viewerQuickButton: '.viewer-quick button', viewerSaid: '.viewer-said p', viewerSubtitle: '.viewer-uid', adminSwitch: '.viewer-admin-switch', voiceChip: '#viewer-voices button',
  audiencePanel: '#audience-dialog', audienceCount: '#audience-total', audienceList: '#audience-list',
  historyPanel: '#lake-history-dialog', historyHeading: '.lake-drawer-head i', historyPanelList: '#chat-feed', voicePanel: '#tts-menu', voiceHeading: '#tts-menu .panel-kicker', facePanel: '#onair-panel[data-mode="face"]', faceTitle: '#onair-panel[data-mode="face"] h3', faceNote: '.lake-face-note', faceQr: '.onair-face-qr', faceButton: '#onair-panel[data-mode="face"] .onair-go', emotePanel: '#chat-emoticon-picker',
};

function fixture(theme, mode) {
  const users = [
    [501, '晚风吹过小卖部'], [502, '橘子汽水'], [503, '今天也要早睡'], [504, 'Lumi'], [505, '不吃香菜'],
    [506, 'momo_酱'], [507, '夜航船'], [508, '小蘑菇'], [509, '月亮邮差'], [510, '一只路过的猫'], [511, 'Ezreal'],
  ].map(([user_id, user_name], index) => ({ user_id, user_name, rank: index + 1, avatar_url: null }));
  const event = (id, uid, text, time, price) => ({ platform_event_id: `parity-${id}`, room_id: 999, kind: price ? 'super_chat' : 'danmaku', user_id: uid, user_name: users.find(user => user.user_id === uid).user_name, message: text, observed_at_ms: Date.parse(`2026-10-06T${time}:00+08:00`), avatar_url: null, ...(price ? { price_yuan: price } : {}) });
  const phrase = longTexts[mode] || '这首歌的前奏也太好听了吧';
  const events = mode === 'empty' ? [] : [event(1, 504, '晚上好呀', '21:52'), event(2, 502, '来了来了', '21:58'), event(3, 507, '晚安前记得多喝水', '22:11', 30), event(4, 505, '刚刚那段高音好稳', '22:19'), event(5, 503, phrase, '22:24')];
  return {
    config_revision: 1, onboarding_done: true, network_disabled: false,
    preferences: { language: 'zh-CN', appearance: theme === 'night' ? 'dark' : 'light', scale: 1, master_volume: 0.72, tts_enabled: true, broadcast_console: true },
    setup: { room_id: 999, tts_enabled: true, mode: 'account', uid: 42 }, live_settings: { room_id: 999, gift_merge: { enabled: false } },
    live: { running: true, state: 'connected', room_id: 999, received: 5, events, audience: { active: true, live_status: 1, loading: false, error: null, rank_count: 128, rank_count_text: '128', watched_count: 128, updated_at_ms: fixedNow, page: 1, has_more: false, users } },
    queue: { current: !['calm', 'empty', 'offair', 'face', 'ended'].includes(mode) ? { id: 'parity-current', origin: 'live', user_name: '今天也要早睡', text: `今天也要早睡：${phrase}` } : null, pending: [], history: [] },
    rules: { default_preset_id: 'v1', preferred_presets: {}, user_words: [] },
    presets: [{ id: 'v1', name: '温柔女声', provider: 'doubao', voice_id: 'parity1' }, { id: 'v2', name: '元气少女', provider: 'doubao', voice_id: 'parity2' }, { id: 'v3', name: '低音旁白', provider: 'fish_audio', voice_id: 'parity3' }],
    connections: [], bindings: [], assets: [], devices: [], local_services: {}, account: { user_id: 42, name: '柚子不加糖' }, qr: { status: 'idle' }, status: {},
    broadcast: { last_session: ['offair', 'face'].includes(mode) ? { started_at: Date.parse('2026-10-05T21:00:00+08:00') / 1000, observed_started_at: Date.parse('2026-10-05T21:00:00+08:00') / 1000, ended_observed_at: Date.parse('2026-10-05T23:14:00+08:00') / 1000, messages: 386, seconds: 8040 } : null, room: { room_id: 999, title: '今晚一起听歌，顺便聊聊天', parent_area_id: 1, area_id: 10, live_status: ['offair', 'face'].includes(mode) ? 0 : 1, live_since: Math.floor(fixedNow / 1000) + (mode === 'calm' ? 360 : 0) - 5028 }, areas: [['娱乐', ['视频唱见', '聊天电台', '舞见', '萌宠', '户外']], ['网游', ['英雄联盟', '无畏契约', '最终幻想14']], ['手游', ['原神', '王者荣耀', '明日方舟']], ['单机游戏', ['独立游戏', '主机游戏', '恐怖游戏']], ['知识', ['科技', '人文历史', '学习打卡']], ['生活', ['美食', '手工绘画', '日常']]].map(([name, children], index) => ({id: index + 1, name, children: children.map((name, child) => ({id: (index + 1) * 10 + child, name}))})), busy: false, has_stream_key: false, face_image: null },
    obs: { settings: { enabled: false, host: '127.0.0.1', port: 4455 }, has_password: false, status: { state: 'idle' }, local: true }, overlay: { settings: { enabled: false, title: '今晚的弹幕' }, running: false, clients: [] },
    chat_send: { busy: false, error: null, account_id: 42, room_id: 999, message_limit: 40, warnings: [], emoticons: mode === 'emote' ? [{source: 'account', pkg_type: 2, name: '常用文字', icon: fixturePackIcons[0], emoticons: fixtureTextEmotes.map((emoji, index) => ({emoticon_unique: `parity-emote-${index}`, kind: 'text', emoji, text: `[${emoji}]`, allowed: true, url: fixtureItemIcons[index] || null}))}, {source: 'live', pkg_type: 3, name: '问候', icon: fixturePackIcons[1], emoticons: [{emoticon_unique: 'parity-greet', kind: 'text', emoji: '你好', text: '你好', allowed: true, url: null}]}] : [] },
    moderation: { busy: false, user_id: null, room_id: null, can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null, message: null },
  };
}

function comparePixels(referenceBuffer, actualBuffer) {
  const ref = PNG.sync.read(referenceBuffer), actual = PNG.sync.read(actualBuffer);
  assert.equal(actual.width, ref.width); assert.equal(actual.height, ref.height);
  const diff = new PNG({ width: ref.width, height: ref.height }); let mismatch = 0; let total = 0; let delta = 0;
  // The desktop window's real titlebar and rounded export canvas corners are intentional integration differences.
  for (let y = 40; y < ref.height - 12; y++) for (let x = 12; x < ref.width - 12; x++) {
    const i = (y * ref.width + x) * 4; let maximum = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(ref.data[i + c] - actual.data[i + c]); maximum = Math.max(maximum, d); delta += d; }
    if (maximum > 4) mismatch++;
    total++; diff.data[i] = maximum > 4 ? 255 : ref.data[i]; diff.data[i + 1] = maximum > 4 ? 0 : ref.data[i + 1]; diff.data[i + 2] = maximum > 4 ? 80 : ref.data[i + 2]; diff.data[i + 3] = 255;
  }
  return { mismatch, pixels: total, mismatchRatio: mismatch / total, meanChannelDelta: delta / (total * 3), diff: PNG.sync.write(diff) };
}

function titlebarPixels(referenceBuffer, actualBuffer) {
  const reference = PNG.sync.read(referenceBuffer), actual = PNG.sync.read(actualBuffer); let maximum = 0, samples = 0;
  // No brand glyphs, toolbar icon pixels, or the rounded export corners are in this background strip.
  for (let y = 0; y < 40; y++) for (let x = 240; x < 760; x++) for (let channel = 0; channel < 3; channel++) {
    const offset = (y * reference.width + x) * 4 + channel;
    maximum = Math.max(maximum, Math.abs(reference.data[offset] - actual.data[offset])); samples++;
  }
  return {maximumChannelDelta: maximum, samples};
}

function referenceProps(theme, mode) {
  return { theme, scene: ['live', 'calm', 'empty', 'offair', 'face', 'ended'].includes(mode) ? mode : 'live', pop: mode === 'voice' ? 'voice' : mode === 'emote' ? 'emote' : 'none', card: mode === 'card' || mode === 'toast', hist: mode === 'history', edit: ['editor', 'area-parent', 'area-child'].includes(mode), aud: mode === 'audience', areaOpen: mode === 'area-parent' ? 'p' : mode === 'area-child' ? 'c' : 'none', frozen: true, w: 1040, h: 740 };
}

async function inspector(page, selectors) {
  return page.evaluate(selectors => {
    const out = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const node = document.querySelector(selector);
      if (!node || !node.getClientRects().length) continue;
      const box = node.getBoundingClientRect(); const css = getComputedStyle(node);
      out[name] = { selector, text: (node.textContent || '').trim(), rect: { x: box.x, y: box.y, width: box.width, height: box.height }, font: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, fontStyle: css.fontStyle, lineHeight: css.lineHeight, letterSpacing: css.letterSpacing, color: css.color, background: css.background, border: css.border, borderRadius: css.borderRadius, padding: css.padding, textAlign: css.textAlign, outline: css.outline, cursor: css.cursor, boxShadow: css.boxShadow, opacity: css.opacity, filter: css.filter, backdropFilter: css.backdropFilter, transform: css.transform, maxHeight: css.maxHeight, overflow: css.overflow, whiteSpace: css.whiteSpace, transitionProperty: css.transitionProperty, transitionDuration: css.transitionDuration, transitionTimingFunction: css.transitionTimingFunction, animationName: css.animationName, animationDuration: css.animationDuration, animationDelay: css.animationDelay, animationTimingFunction: css.animationTimingFunction, animationIterationCount: css.animationIterationCount, animationDirection: css.animationDirection, animationFillMode: css.animationFillMode };
    }
    return out;
  }, selectors);
}

async function voiceLayoutInspector(page, containerSelector, itemSelector) {
  return page.evaluate(({containerSelector, itemSelector}) => {
    const container = document.querySelector(containerSelector);
    const cssValues = (node, properties) => {
      const css = getComputedStyle(node);
      return Object.fromEntries(properties.map(property => [property, css[property]]));
    };
    const boxValues = node => {
      const box = node.getBoundingClientRect();
      return {x: box.x, y: box.y, width: box.width, height: box.height};
    };
    return {
      container: cssValues(container, ['display', 'flexWrap', 'gap', 'marginTop', 'padding', 'maxHeight', 'overflow', 'whiteSpace']),
      items: [...document.querySelectorAll(itemSelector)].map(node => ({
        text: node.textContent.trim(), rect: boxValues(node),
        style: cssValues(node, ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'color', 'background', 'border', 'borderRadius', 'padding', 'textAlign', 'boxShadow', 'opacity', 'filter', 'transform', 'maxHeight', 'overflow', 'whiteSpace', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction']),
      })),
    };
  }, {containerSelector, itemSelector});
}

const motionSelectors = {
  stars: ['.stars', '.lake-stars'], shooting: ['.shoot', '.lake-shooting-star'], orb: ['.orb', '.lake-orb'],
  clouds: ['.cloud', '.lake-cloud'], birds: ['.bird', '.lake-bird'], flaps: ['.bird svg', '.lake-bird svg'], mist: ['.mist', '.lake-mist'],
  path: ['.path', '.lake-reflection'], ripples: ['.ripple', '.lake-ripple'], waves: ['.wv', '.lake-wave'],
  letters: ['.line .ch', '#lake-current .lake-letter'], history: ['.sunk .s', '#lake-history .lake-message'],
  equalizer: ['.bars i', '.lake-voice-bars i'], editor: ['.edit', '#onair-panel[data-mode="info"]'],
  sheet: ['.sheet', '.viewer-sheet,#lake-history-dialog[open]'], pop: ['.pop', '#audience-dialog[open],#tts-menu:not([hidden]),#chat-emoticon-picker:not([hidden])'], scrim: ['.scrim:not(.clear)', '.viewer-scrim,#lake-history-dialog[open]::backdrop'], air: ['.air i', '.onair-dot'], spinner: ['.spin', '.spinner,.onair-go.working i'], toast: ['.toast', '#toast:not([hidden])'],
};

async function motionInspector(page, side) {
  return page.evaluate(({ selectors, side }) => {
    const out = {};
    const animationData = animation => {
      const timing = animation.effect.getTiming();
      return { duration: timing.duration, delay: timing.delay, endDelay: timing.endDelay, iterations: String(timing.iterations), iterationStart: timing.iterationStart, direction: timing.direction, fill: timing.fill, easing: timing.easing,
        keyframes: animation.effect.getKeyframes().map(frame => Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'computedOffset').sort(([a], [b]) => a.localeCompare(b)))) };
    };
    for (const [name, pair] of Object.entries(selectors)) out[name] = [...document.querySelectorAll(pair[side])].filter(node => node.getClientRects().length).map(node => {
      const css = getComputedStyle(node); const box = node.getBoundingClientRect();
      return { rect: { x: box.x, y: box.y, width: box.width, height: box.height }, cssHeight: css.height, opacity: css.opacity, transform: css.transform,
        animations: node.getAnimations().filter(animation => animation.effect?.target === node && !animation.effect?.pseudoElement).map(animationData) };
    });
    const history = side === 1 && document.querySelector('#lake-history-dialog[open]');
    if (history) {
      const css = getComputedStyle(history, '::backdrop');
      out.scrim.push({ rect: {x: 0,y: 40,width: innerWidth,height: innerHeight - 40}, cssHeight: css.height, opacity: css.opacity, transform: css.transform,
        animations: document.getAnimations().filter(animation => animation.effect?.target === history && animation.effect?.pseudoElement === '::backdrop').map(animationData) });
    }
    return out;
  }, { selectors: motionSelectors, side });
}

async function settle(page) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(80);
  await page.evaluate(() => { for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 10000; } });
  await page.waitForTimeout(30);
}

async function themeMotion(page, selector) {
  await page.locator(selector).click();
  await page.waitForFunction(() => document.getAnimations().some(animation => /vtReveal|lake-theme-reveal/.test(animation.animationName || '')));
  return page.evaluate(selector => {
    const node = document.querySelector(selector), rect = node.getBoundingClientRect();
    const animation = document.getAnimations().find(animation => /vtReveal|lake-theme-reveal/.test(animation.animationName || ''));
    animation.pause();
    const timing = animation.effect.getTiming();
    return { origin: {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2},
      timing: Object.fromEntries(['duration', 'delay', 'endDelay', 'iterations', 'iterationStart', 'direction', 'fill', 'easing'].map(name => [name, String(timing[name])])),
      frames: animation.effect.getKeyframes().map(frame => Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'computedOffset').sort(([a], [b]) => a.localeCompare(b)))) };
  }, selector);
}

async function relativeMotion(page, selector) {
  return page.locator(selector).evaluate(node => {
    const animation = node.getAnimations().find(animation => animation.effect?.target === node && !animation.effect.pseudoElement);
    if (!animation) return null;
    const timing = animation.effect.getTiming(), duration = Number(timing.duration);
    animation.pause(); animation.currentTime = duration;
    const end = node.getBoundingClientRect();
    const frames = [0, .25, .5, .75, 1].map(progress => {
      animation.currentTime = duration * progress; const box = node.getBoundingClientRect();
      return {progress, rect: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number((box[key] - end[key]).toFixed(4))])), opacity: Number(getComputedStyle(node).opacity)};
    });
    animation.currentTime = 10000;
    return {duration, delay: timing.delay, fill: timing.fill, iterations: timing.iterations,
      keyframes: animation.effect.getKeyframes().map(frame => ({offset: frame.offset, easing: frame.easing, opacity: frame.opacity})), frames};
  });
}

async function hoverStyles(page, pairs, side) {
  await page.bringToFront();
  const measurements = {};
  for (const [name, pair] of Object.entries(pairs)) {
    const selector = pair[side]; await page.locator(selector).first().hover(); await page.waitForTimeout(50);
    const box = await page.locator(selector).first().boundingBox(); await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2 + 1); await page.waitForTimeout(600);
    measurements[name] = await page.locator(selector).first().evaluate(node => {
      const css = getComputedStyle(node);
      return {hovered: node.matches(':hover'), ...Object.fromEntries(['background', 'border', 'borderRadius', 'color', 'opacity', 'filter', 'transform', 'boxShadow', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction'].map(name => [name, css[name]]))};
    });
    assert.equal(measurements[name].hovered, true, `source/app hover must be active on the current node: ${selector}`);
  }
  await page.mouse.move(5, 400); await page.waitForTimeout(400);
  return measurements;
}

async function assetHashes() {
  const runtime = (await fs.readdir(uiRoot)).filter(name => /\.(html|css|js|mjs)$/.test(name) && !name.includes('.test.'));
  const reference = ['Lake.dc.html', 'support.js', 'vendor/react.js', 'vendor/react-dom.js', 'assets/87bd4387ec741ab171bb6e0b4a6179a4.png'];
  const out = {};
  for (const [prefix, base, files] of [['app', uiRoot, runtime], ['reference', referenceRoot, reference]]) for (const name of files) out[`${prefix}/${name}`] = createHash('sha256').update(await fs.readFile(path.join(base, name))).digest('hex');
  for (const name of (await fs.readdir(path.join(uiRoot, 'fonts'))).filter(name => name.endsWith('.woff2'))) out[`fonts/${name}`] = createHash('sha256').update(await fs.readFile(path.join(uiRoot, 'fonts', name))).digest('hex');
  for (const name of ['manifest.json', 'NotoSerifSC-original.ttf', 'InstrumentSerif-Regular-original.woff2', 'InstrumentSerif-Italic-original.woff2']) out[`reference-fonts/${name}`] = createHash('sha256').update(await fs.readFile(path.join(referenceFontRoot, name))).digest('hex');
  out['prior-production-voice/actual-measurements.json'] = createHash('sha256').update(await fs.readFile(priorVoiceMeasurementsPath)).digest('hex');
  const config = JSON.parse(await fs.readFile(path.join(repo, 'crates/desktop/tauri.conf.json'), 'utf8'));
  for (const relative of config.build.frontendDist) out[`bundled/${relative}`] = createHash('sha256').update(await fs.readFile(path.join(repo, 'crates/desktop', relative))).digest('hex');
  return out;
}

async function bundledAssetsReport(captured) {
  const config = JSON.parse(await fs.readFile(path.join(repo, 'crates/desktop/tauri.conf.json'), 'utf8'));
  const assets = await Promise.all(config.build.frontendDist.map(async relative => {
    const bytes = await fs.readFile(path.join(repo, 'crates/desktop', relative));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const parityRunCapturedSha256 = captured[`bundled/${relative}`];
    return {path: `crates/desktop/${relative}`, bytes: bytes.length, sha256, parityRunCapturedSha256, unchangedSinceParityRun: sha256 === parityRunCapturedSha256};
  }));
  const logoMatchesCapturedReference = assets.find(asset => asset.path.endsWith('/logo.png'))?.sha256 === captured['reference/assets/87bd4387ec741ab171bb6e0b4a6179a4.png'];
  return {capturedAt: new Date().toISOString(), evidence: 'All configured Tauri frontendDist assets captured before the complete parity run and rehashed afterwards, including logo and both license texts. Original reference logo independently agrees. No production mutation, native app launch, network POST or executable inspection.', passed: assets.every(asset => asset.unchangedSinceParityRun) && logoMatchesCapturedReference, assetCount: assets.length, capturedAssets: assets.length, logoMatchesCapturedReference, assets};
}

async function independentReferenceFonts() {
  const manifest = JSON.parse(await fs.readFile(path.join(referenceFontRoot, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(referenceFontRoot, file.name))).digest('hex'), file.sha256, `Independent original font cache changed: ${file.name}`);
  assert.equal(manifest.files.find(file => file.name === 'NotoSerifSC-original.ttf')?.sha256, '050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9');
  const rules = [500,700,900].map(weight => `@font-face{font-family:"Noto Serif SC";src:url("/reference-fonts/NotoSerifSC-original.ttf") format("truetype");font-weight:${weight};font-style:normal;font-display:swap}`);
  for (const style of ['Regular', 'Italic']) rules.push(`@font-face{font-family:"Instrument Serif";src:url("/reference-fonts/InstrumentSerif-${style}-original.woff2") format("woff2");font-weight:400;font-style:${style === 'Italic' ? 'italic' : 'normal'};font-display:swap}`);
  return {manifest, rules: rules.join('\n')};
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const priorVoiceBytes = await fs.readFile(priorVoiceMeasurementsPath);
  assert.equal(createHash('sha256').update(priorVoiceBytes).digest('hex'), priorVoiceMeasurementsSha256, 'Prior production voice presentation baseline must remain unchanged');
  const priorVoiceMeasurements = JSON.parse(priorVoiceBytes).measurements;
  const voicePresentationBaseline = {
    path: path.relative(repo, priorVoiceMeasurementsPath).replaceAll('\\', '/'), sha256: priorVoiceMeasurementsSha256,
    evidence: 'The prior production voice capsules seen by the user retain hidden/nowrap long-name ellipsis protection. These two fields are compared to the pinned prior production measurements, not claimed equal to exported HTML. All other voice styles and geometry remain original HTML comparisons.',
    themes: Object.fromEntries(['night', 'day'].map(theme => [theme, Object.fromEntries(['overflow', 'whiteSpace'].map(property => [property, priorVoiceMeasurements[`${theme}-card`].voiceChip[property]]))])),
  };
  for (const theme of ['night', 'day']) assert.deepEqual(voicePresentationBaseline.themes[theme], {overflow: 'hidden', whiteSpace: 'nowrap'});
  const referenceFonts = await independentReferenceFonts();
  const originalHashes = await assetHashes();
  await fs.writeFile(path.join(output, 'source-hashes.json'), JSON.stringify({capturedAt: new Date().toISOString(), hashes: originalHashes}, null, 2));
  const fontRules = referenceFonts.rules;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1'); const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/reference-fonts/')) {
        const name = pathname.slice('/reference-fonts/'.length);
        if (!referenceFonts.manifest.files.some(file => file.name === name)) return response.writeHead(404).end();
        return response.writeHead(200, {'Content-Type': name.endsWith('.ttf') ? 'font/ttf' : 'font/woff2'}).end(await fs.readFile(path.join(referenceFontRoot, name)));
      }
      const base = pathname.startsWith('/reference/') ? referenceRoot : uiRoot;
      const relative = pathname.startsWith('/reference/') ? pathname.slice('/reference/'.length) : pathname === '/' ? 'index.html' : pathname.slice(1);
      let target = path.resolve(base, relative);
      if (!target.startsWith(base + path.sep)) return response.writeHead(403).end();
      let source = await fs.readFile(target).catch(() => fs.readFile(path.join(uiRoot, 'fonts', path.basename(target))));
      if (pathname === '/reference/Lake.dc.html') {
        const props = referenceProps(url.searchParams.get('theme') || 'night', url.searchParams.get('mode') || 'live');
        source = source.toString().replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]+>/, `<style>${fontRules}</style>`).replace(/data-props='([^']+)'/, (_, json) => {
          const metadata = JSON.parse(json); for (const [name, value] of Object.entries(props)) metadata[name].default = value;
          return `data-props='${JSON.stringify(metadata)}'`;
        });
        const phrase = longTexts[url.searchParams.get('mode')];
        if (phrase) source = source.replaceAll('这首歌的前奏也太好听了吧', phrase);
        // Match only dynamic backend session data; unique viewer counts aren't measured.
        source = source.replaceAll('386 句弹幕 · 52 位朋友说过话', '386 句弹幕');
        // This one text span is now explicitly the signed-in owner's byline.
        // Keep the original room title/state and editor values untouched.
        const byline = `${fixture(props.theme, url.searchParams.get('mode') || 'live').account.name}的直播间`;
        source = source.replace('<span class="tt">{{title}}</span>', `<span class="tt">${byline}</span>`);
      }
      if (pathname === '/app.js') source = source.toString() + '\n// Parity test-only instrumentation.\nwindow.__lakeParityPush = acceptSnapshot; window.__lakeParityStop = () => { clearTimeout(snapshotTimer); clearInterval(lakeClockTimer); boot.polling = false; };';
      response.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(source);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, timezoneId: 'Asia/Singapore', reducedMotion: 'no-preference' });
    const fixtureIconPixels = await fs.readFile(path.join(uiRoot, 'logo.png'));
    const fixtureIconRequests = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if ([...fixturePackIcons, ...fixtureItemIcons].includes(url)) { fixtureIconRequests.push(url); return route.fulfill({status: 200, contentType: 'image/png', body: fixtureIconPixels}); }
      return url.startsWith(origin + '/') ? route.continue() : route.abort();
    });
    const reference = await context.newPage(); reference.on('pageerror', error => errors.push(`reference: ${error.message}`));
    const measurements = {}, referenceMotion = {}, referenceVoiceLayouts = {};
    for (const theme of ['night', 'day']) for (const mode of modes) {
      await reference.goto(`${origin}/reference/Lake.dc.html?theme=${theme}&mode=${mode}`);
      await reference.locator('.dv').waitFor();
      if (mode === 'toast') await reference.locator('.sheet .rose').click();
      await settle(reference);
      const name = `${theme}-${mode}`;
      await reference.screenshot({ path: path.join(output, `reference-${name}.png`) });
      measurements[name] = await inspector(reference, referenceSelectors);
      if (mode === 'card') referenceVoiceLayouts[name] = await voiceLayoutInspector(reference, '.sheet .chips', '.sheet .chip');
      referenceMotion[name] = await motionInspector(reference, 0);
      if (mode === 'face') referenceMotion[name].faceNormalized = await relativeMotion(reference, '.modal');
      assert.equal(await reference.locator('.wv').count(), 148);
      assert.equal(await reference.locator('.dv').getAttribute('class'), `dv ${theme}${['calm', 'empty', 'offair', 'face', 'ended'].includes(mode) ? ' calm' : ' reading'}${['editor', 'area-parent', 'area-child'].includes(mode) ? ' editing' : ''}`);
      console.log(`reference ${name}`);
    }
    assert.deepEqual(errors, [], 'reference JavaScript errors');
    await fs.writeFile(path.join(output, 'reference-measurements.json'), JSON.stringify({ evidence: 'Actual exported Lake.dc.html rendered with its own DC runtime; external Google font URL replaced by independently cached unmodified official Noto Serif SC 2.003-H1 variable TTF and original Google CDN Instrument Serif Latin files; no production font faces injected. Defaults and dynamic backend session text unified; only the masthead .tt text span is substituted with the fictional current account name plus 的直播间, reflecting the latest explicit content change while preserving original layout, room title, editor and prepared-scene title. The original offair/face tonight’s title label remains in reference screenshots as an approved removed element. Long fixtures replace only latest demo text; animations frozen at 10000 ms.', fontSources: referenceFonts.manifest, viewport: { width: 1040, height: 740 }, referenceRoot, measurements }, null, 2));
    console.log(`Reference ground truth: ${output}`);
    if (process.argv.includes('--reference-only')) return;

    const actual = await context.newPage(); actual.on('pageerror', error => errors.push(`app: ${error.message}`));
    let state; const calls = [];
    await actual.exposeFunction('__parityInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      assert.equal(command, 'dispatch'); const { action, payload } = args; calls.push({ action, payload });
      if (action === 'preferences.save') { Object.assign(state.preferences, payload.preferences); state.config_revision++; }
      else if (action === 'bili.moderation.refresh') Object.assign(state.moderation, { user_id: payload.user_id, room_id: 999, can_moderate: true, can_blacklist: true, can_manage_admins: true, muted: false, blacklisted: false, is_admin: false });
      else if (action === 'bili.moderation.mute') { assert.equal(payload.confirmed, true); assert.equal(payload.hours, 1); assert.equal(payload.user_id, '503'); state.moderation.muted = true; }
      else if (action === 'bili.broadcast.start') { state.broadcast.face_image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yN+UAAAAASUVORK5CYII='; return { ...structuredClone(state), result: { obs: { outcome: 'needs_face' } } }; }
      else if (action === 'obs.bitrate.get') return { ...structuredClone(state), result: { bitrate_kbps: 6000, output_mode: 'simple', editable: true, outputs_active: false, applies_next_stream: false, reason: null } };
      else if (action === 'bili.chat.emoticon.send') { assert.equal(payload.confirmed, true); assert.ok(state.chat_send.emoticons.some(pack => pack.emoticons.some(item => item.emoticon_unique === payload.emoticon_unique && item.allowed)), 'emote direct-send uses a current actual fixture item ID'); }
      else assert.ok(['bili.broadcast.refresh', 'bili.qr.cancel', 'doubao.qr.cancel', 'bili.chat.emoticons.refresh'].includes(action), `Unexpected parity fixture command: ${action}`);
      return structuredClone(state);
    });
    await actual.addInitScript(({ fixedNow }) => {
      const NativeDate = Date; const mode = new URL(location.href).searchParams.get('mode'); const now = fixedNow + (mode === 'calm' ? 360000 : 0);
      class FixedDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
      window.Date = FixedDate;
      const query = new URL(location.href).searchParams;
      window.__DANMAKUVOICE_STARTUP_THEME__ = { session: `parity:${query.get('theme')}:${mode}`, appearance: query.get('theme') === 'day' ? 'light' : 'dark', language: 'zh-CN' };
      window.__parityListeners = {};
      window.__TAURI__ = { core: { invoke: (command, args) => window.__parityInvoke(command, args) }, event: { listen: async (name, listener) => { window.__parityListeners[name] = listener; return () => {}; } } };
    }, { fixedNow });
    actual.setDefaultTimeout(8000);
    const actualMeasurements = {}, actualMotion = {}, actualVoiceLayouts = {}; const failures = []; const gates = []; const scenic = {};
    const gate = (name, passed, detail) => { gates.push({ name, passed, detail }); if (!passed) failures.push(`${name}: ${detail}`); };
    for (const theme of ['night', 'day']) for (const mode of modes) {
      const completeState = fixture(theme, mode);
      const deliverLatest = completeState.live.events.length && !['offair', 'face', 'ended'].includes(mode);
      state = structuredClone(completeState);
      if (deliverLatest) state.live.events = state.live.events.slice(0, -1);
      await actual.goto(`${origin}/?mode=${mode}&theme=${theme}`);
      await actual.locator('#live-shell.lake-mode').waitFor();
      await actual.evaluate(() => window.__lakeParityStop());
      // Compare the source's incoming message/sink motion with an actual new
      // arrival. Hydrated old history intentionally has no entry replay now.
      // Each case is a fresh native session; reload recovery has its own suite.
      if (deliverLatest) { state = completeState; await actual.evaluate(next => window.__lakeParityPush(next), structuredClone(state)); }
      if (mode === 'ended') { state.broadcast.last_session = { started_at: state.broadcast.room.live_since, observed_started_at: state.broadcast.room.live_since, ended_observed_at: Math.floor(fixedNow / 1000), messages: 5, seconds: 5028 }; state.broadcast.room.live_status = 0; state.broadcast.room.live_since = null; await actual.evaluate(next => window.__lakeParityPush(next), structuredClone(state)); }
      if (mode === 'face') { await actual.locator('#onair [data-action="broadcast.start"]').click(); await actual.locator('#onair-panel[data-mode="face"]').waitFor(); }
      if (mode === 'emote') { await actual.locator('#chat-message').fill('晚安～ '); await actual.locator('[data-action="chat.emoticons"]').click(); await actual.locator('#chat-emoticon-picker').waitFor(); await actual.locator('.lake-emote-pack-icon').first().waitFor(); await actual.waitForFunction(() => [...document.querySelectorAll('.lake-emote-pack-icon')].every(image => image.complete && image.naturalWidth > 0)); }
      if (['editor', 'area-parent', 'area-child'].includes(mode)) { await actual.locator('#lake-title').click(); await actual.locator('#onair-panel[data-mode="info"]').waitFor(); }
      if (mode === 'area-parent' || mode === 'area-child') { await actual.locator(`#onair-panel .select-control:has(select[name="${mode === 'area-parent' ? 'parent_area_id' : 'area_id'}"]) .select-trigger`).click(); await actual.locator('.select-menu').waitFor(); }
      if (mode === 'card' || mode === 'toast') { await actual.locator('#lake-current .lake-message-name').click(); await actual.locator('#viewer-alias').waitFor(); }
      if (mode === 'toast') { await actual.locator('.viewer-mute-action:not([disabled])').waitFor(); await actual.locator('.viewer-mute-action').click(); await actual.locator('#toast [data-action="toast.undo"]').waitFor(); }
      if (mode === 'audience') { await actual.locator('#audience-count').click(); await actual.locator('#audience-dialog').waitFor(); }
      if (mode === 'history') { await actual.locator('[data-action="history.open"]').click(); await actual.locator('#lake-history-dialog').waitFor(); }
      if (mode === 'voice') { await actual.locator('.lake-orb').click(); await actual.locator('#tts-menu:not([hidden]),#lake-sound-panel:not([hidden])').waitFor(); }
      await actual.mouse.move(5, 400);
      if (mode === 'face') await actual.locator('#toast').waitFor({state: 'hidden'});
      await settle(actual);
      const name = `${theme}-${mode}`; actualMeasurements[name] = await inspector(actual, appSelectors);
      actualMotion[name] = await motionInspector(actual, 1);
      if (mode === 'card') actualVoiceLayouts[name] = await voiceLayoutInspector(actual, '#viewer-voices', '#viewer-voices button');
      if (mode === 'face') actualMotion[name].faceNormalized = await relativeMotion(actual, '#onair-panel[data-mode="face"]');
      await actual.screenshot({ path: path.join(output, `actual-${name}.png`) });
      const ref = measurements[name], app = actualMeasurements[name], editing = ['editor', 'area-parent', 'area-child'].includes(mode);
      const exactRects = ['sky', 'orb', 'ridge1', 'ridge2', 'horizon', 'water', 'path', 'waveform'];
      exactRects.push('titlebar', 'brand', 'logo', 'daypart', 'date', 'dock', 'compose', 'composeInput', 'composeSend', 'onair');
      if (!editing) exactRects.push('title');
      if (!editing && !['offair', 'face', 'ended'].includes(mode)) exactRects.push('audience');
      if (mode === 'live' || mode === 'calm' || longTexts[mode]) exactRects.push('currentText', 'currentFirstLine', 'currentMeta', 'currentName', 'currentTime', 'historyFirst', 'historyLink');
      if (['offair', 'face', 'ended'].includes(mode)) exactRects.push('currentText', 'currentFirstLine');
      if (mode === 'ended') exactRects.push('currentMeta', 'currentName');
      if (mode === 'empty') exactRects.push('still');
      // The user restored the original voice capsules and redesigned only
      // moderation below them. Keep voices and the unchanged upper card exact;
      // dedicated viewer-layout acceptance covers the changed moderation area.
      if (mode === 'card') exactRects.push('viewer', 'viewerAvatar', 'viewerName', 'viewerBody', 'aliasField', 'aliasInput', 'voiceChips', 'voiceChip', 'viewerQuick', 'viewerQuickButton', 'viewerSubtitle', 'viewerSaid');
      if (mode === 'history') exactRects.push('historyPanel');
      if (mode === 'audience') exactRects.push('audiencePanel');
      if (mode === 'voice') exactRects.push('voicePanel');
      if (mode === 'area-parent' || mode === 'area-child') exactRects.push('areaMenu');
      if (mode === 'face') exactRects.push('facePanel', 'faceTitle', 'faceNote', 'faceQr', 'faceButton');
      if (mode === 'toast') exactRects.push('toast', 'toastButton');
      for (const key of exactRects) {
        const expected = ref[key], found = app[key];
        const delta = expected && found ? Object.fromEntries(['x', 'y', 'width', 'height'].map(property => [property, Number((found.rect[property] - expected.rect[property]).toFixed(3))])) : null;
        gate(`${name} ${key} geometry`, !!delta && Object.values(delta).every(value => Math.abs(value) <= .25), JSON.stringify(delta || { expected: !!expected, found: !!found }));
      }
      if (longTexts[mode]) {
        const props = ['maxHeight', 'overflow', 'whiteSpace'];
        const mismatch = props.filter(property => ref.currentText[property] !== app.currentText[property]).map(property => `${property}: ${ref.currentText[property]} -> ${app.currentText[property]}`);
        gate(`${name} full phrase source clipping`, mismatch.length === 0, mismatch.join('; ') || 'no additional max-height or overflow clipping beyond the original source canvas');
        gate(`${name} explicit source line count`, await actual.locator('#lake-current .lake-text-line').count() === 3, 'source explicit split for all four 17/26/27/160-character fixtures is three lines');
      }
      const typeKeys = ['brand', 'daypart', 'daypartFirst', 'date', 'composeInput'];
      if (!editing) typeKeys.push('title');
      if (mode !== 'empty') typeKeys.push('currentText');
      if (!['empty', 'offair', 'face'].includes(mode)) typeKeys.push('currentName');
      if (!['empty', 'offair', 'face', 'ended'].includes(mode)) typeKeys.push('currentTime');
      if (editing) typeKeys.push('editorKicker', 'editorInput');
      if (mode === 'empty') typeKeys.push('still');
      if (mode === 'card') typeKeys.push('viewerName', 'aliasField', 'aliasInput', 'voiceChip', 'viewerQuickButton', 'viewerSubtitle', 'viewerSaid');
      if (mode === 'history') typeKeys.push('historyHeading');
      if (mode === 'face') typeKeys.push('faceTitle', 'faceNote', 'faceButton');
      if (mode === 'toast') typeKeys.push('toast', 'toastButton');
      for (const key of typeKeys) {
        const expected = ref[key], found = app[key]; const props = ['fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'color'];
        const mismatch = expected && found ? props.filter(property => expected[property] !== found[property]).map(property => `${property}: ${expected[property]} -> ${found[property]}`) : ['missing source or app element'];
        if (expected && found && expected.font.split(',')[0] !== found.font.split(',')[0]) mismatch.push(`font: ${expected.font} -> ${found.font}`);
        gate(`${name} ${key} typography`, mismatch.length === 0, mismatch.join('; ') || 'same font, size, weight, style, line height, spacing and color');
      }
      for (const key of ['titlebar', 'brand', 'logo']) {
        const expected = ref[key], found = app[key], props = key === 'titlebar' ? ['border', 'borderRadius', 'color'] : ['background', 'border', 'borderRadius', 'color'];
        const mismatch = expected && found ? props.filter(property => expected[property] !== found[property]).map(property => `${property}: ${expected[property]} -> ${found[property]}`) : ['missing source or app element'];
        gate(`${name} ${key} titlebar style`, mismatch.length === 0, mismatch.join('; ') || 'same original titlebar/brand/logo surfaces and color');
      }
      const barPixels = titlebarPixels(await fs.readFile(path.join(output, `reference-${name}.png`)), await fs.readFile(path.join(output, `actual-${name}.png`)));
      gate(`${name} titlebar background pixels`, barPixels.maximumChannelDelta <= 1, JSON.stringify(barPixels));
      if (mode === 'card') for (const key of ['viewer', 'aliasField', 'voiceChip']) {
        const expected = ref[key], found = app[key], props = ['background', 'border', 'borderRadius', 'boxShadow', 'outline', 'textAlign'];
        const mismatch = expected && found ? props.filter(property => expected[property] !== found[property]).map(property => `${property}: ${expected[property]} -> ${found[property]}`) : ['missing source or app element'];
        gate(`${name} ${key} surface`, mismatch.length === 0, mismatch.join('; ') || 'same fill, border and rounding');
      }
      if (mode === 'card') {
        const expected = referenceVoiceLayouts[name], found = actualVoiceLayouts[name], mismatch = [];
        for (const property of Object.keys(expected.container)) if (expected.container[property] !== found.container[property]) mismatch.push(`container ${property}: ${expected.container[property]} -> ${found.container[property]}`);
        if (expected.items.length !== found.items.length) mismatch.push(`item count ${expected.items.length} -> ${found.items.length}`);
        for (let index = 0; index < Math.min(expected.items.length, found.items.length); index++) {
          const original = expected.items[index], actualItem = found.items[index];
          if (original.text !== actualItem.text) mismatch.push(`item ${index + 1} text differs`);
          for (const property of Object.keys(original.rect)) if (Math.abs(original.rect[property] - actualItem.rect[property]) > .25) mismatch.push(`item ${index + 1} ${property}: ${original.rect[property]} -> ${actualItem.rect[property]}`);
          for (const property of Object.keys(original.style).filter(property => !['overflow', 'whiteSpace'].includes(property))) if (original.style[property] !== actualItem.style[property]) mismatch.push(`item ${index + 1} ${property}: ${original.style[property]} -> ${actualItem.style[property]}`);
        }
        gate(`${name} restored complete original voice capsules`, mismatch.length === 0, mismatch.join('; ') || 'original natural wrap, gap, margin, no container clipping, all capsule geometry and exact selected/unselected typography, surfaces and transitions; two existing label-clipping fields separately checked against prior production');
        const clippingMismatch = found.items.flatMap((item, index) => Object.entries(voicePresentationBaseline.themes[theme]).filter(([property, value]) => item.style[property] !== value).map(([property, value]) => `item ${index + 1} ${property}: prior production ${value} -> ${item.style[property]}`));
        gate(`${name} retained prior production long-name clipping`, clippingMismatch.length === 0, clippingMismatch.join('; ') || JSON.stringify({baseline: voicePresentationBaseline.path, sha256: voicePresentationBaseline.sha256, expected: voicePresentationBaseline.themes[theme], scope: 'existing real-preset label protection, not exported HTML equality'}));
      }
      const panelKey = {audience: 'audiencePanel', voice: 'voicePanel', history: 'historyPanel', emote: 'emotePanel', 'area-parent': 'areaMenu', 'area-child': 'areaMenu'}[mode];
      if (panelKey) {
        // The user's later image-only picker request changes its grid width and
        // interior spacing; retain every original glass material comparison.
        const expected = ref[panelKey], found = app[panelKey], props = ['background', 'border', 'borderRadius', ...(mode === 'emote' ? [] : ['padding']), 'boxShadow', 'backdropFilter'];
        const mismatch = expected && found ? props.filter(property => expected[property] !== found[property]).map(property => `${property}: ${expected[property]} -> ${found[property]}`) : ['missing source or app element'];
        gate(`${name} ${panelKey} glass surface`, mismatch.length === 0, mismatch.join('; ') || `same glass fill, border, rounding, ${mode === 'emote' ? 'shadow and blur; compact picker padding is an approved later change' : 'padding, shadow and blur'}`);
      }
      if (mode === 'emote') {
        const expected = ref.emotePanel?.rect, found = app.emotePanel?.rect;
        gate(`${name} emote original bottom/right anchor`, !!expected && !!found && Math.abs(expected.x + expected.width - found.x - found.width) <= .25 && Math.abs(expected.y + expected.height - found.y - found.height) <= .25, JSON.stringify({expected, found, layout: 'later user request: compact image-only grid, continuous scrolling, no pagination; width and interior padding intentionally change'}));
        const packageNames = await actual.locator('.lake-emote-tabs [role="tab"]').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')));
        const packageIcons = await actual.locator('.lake-emote-tabs .lake-emote-pack-icon').evaluateAll(images => images.map(image => ({src: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth})));
        gate(`${name} user extension: real package names retained as accessible labels`, JSON.stringify(packageNames) === JSON.stringify(state.chat_send.emoticons.map(pack => pack.name)), JSON.stringify({expected: state.chat_send.emoticons.map(pack => pack.name), found: packageNames, source: 'account-owned metadata retained in aria-label; user now requests no visible package labels'}));
        gate(`${name} user extension: original metadata icon sources loaded`, JSON.stringify(packageIcons.map(image => image.src)) === JSON.stringify(fixturePackIcons) && packageIcons.every(image => image.complete && image.naturalWidth > 0), JSON.stringify({icons: packageIcons, source: 'safe account-panel url / live current_cover metadata URLs; test-only HTTP route supplies existing local PNG bytes, no external network'}));
        const picker = await actual.locator('#chat-emoticon-picker').evaluate(node => {
          const page = node.querySelector('#chat-emote-page'), grid = node.querySelector('.lake-emote-stickers'), styles = getComputedStyle(node), gridStyle = getComputedStyle(grid), pageStyle = getComputedStyle(page);
          const items = [...node.querySelectorAll('.lake-emote-sticker')];
          return {
            visibleText: node.innerText.trim(), tooltips: node.querySelectorAll('[title]').length,
            pagination: node.querySelectorAll('[data-action="chat.emoticon.page"],.lake-emote-pagination,[data-emote-page],#chat-emote-page[data-page]').length,
            width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, padding: styles.padding, maxHeight: styles.maxHeight,
            itemCount: items.length, declaredItemCount: page.dataset.itemCount, columns: gridStyle.gridTemplateColumns.split(/\s+/).length, overflowY: pageStyle.overflowY, scrollHeight: page.scrollHeight, clientHeight: page.clientHeight,
            items: items.map(item => {
              const style = getComputedStyle(item), image = item.querySelector('img'), fallback = item.querySelector('svg.lake-emote-fallback'), imageStyle = image && getComputedStyle(image);
              return {id: item.dataset.id, label: item.getAttribute('aria-label'), text: item.innerText.trim(), border: style.borderWidth, background: style.backgroundColor,
                image: image && {src: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth, width: imageStyle.width, height: imageStyle.height, objectFit: imageStyle.objectFit},
                fallback: fallback && {viewBox: fallback.getAttribute('viewBox'), hidden: fallback.getAttribute('aria-hidden'), shapes: fallback.querySelectorAll('rect,circle,path').length}};
            }),
          };
        });
        gate(`${name} user extension: image-only picker has no visible labels or tooltips`, picker.visibleText === '' && picker.tooltips === 0 && picker.items.every(item => item.text === ''), JSON.stringify({visibleText: picker.visibleText, tooltips: picker.tooltips, evidence: 'package names and item meanings remain accessible labels; no EMOTES/count/name/item caption/title tooltip'}));
        gate(`${name} user extension: all items rendered without pagination`, picker.pagination === 0 && picker.itemCount === state.chat_send.emoticons[0].emoticons.length && Number(picker.declaredItemCount) === picker.itemCount && picker.overflowY === 'auto' && picker.scrollHeight > picker.clientHeight && picker.clientHeight > 0, JSON.stringify({pagination: picker.pagination, itemCount: picker.itemCount, declaredItemCount: picker.declaredItemCount, overflowY: picker.overflowY, scrollHeight: picker.scrollHeight, clientHeight: picker.clientHeight, fixture: '39 items, including items beyond the former 18-item boundary, in one continuous scroll panel'}));
        gate(`${name} user extension: compact five-column transparent image grid`, picker.width === 360 && picker.height === 380 && picker.padding === '12px' && picker.columns === 5 && picker.items.every(item => item.border === '0px' && item.background === 'rgba(0, 0, 0, 0)'), JSON.stringify({width: picker.width, height: picker.height, padding: picker.padding, maxHeight: picker.maxHeight, columns: picker.columns, evidence: 'latest authorized picker layout; original glass palette, anchor and popup motion still compared independently'}));
        gate(`${name} user extension: item image URLs preserved with legal SVG fallback`, picker.items.every((item, index) => {
          const expected = state.chat_send.emoticons[0].emoticons[index];
          return item.id === expected.emoticon_unique && item.label === expected.emoji && (expected.url ? item.image?.src === expected.url && item.image.complete && item.image.naturalWidth > 0 && item.image.width === '48px' && item.image.height === '48px' && item.image.objectFit === 'contain' && !item.fallback : !item.image && item.fallback?.viewBox === '0 0 24 24' && item.fallback.hidden === 'true' && item.fallback.shapes === 3);
        }), JSON.stringify({images: picker.items.filter(item => item.image), fallbackCount: picker.items.filter(item => item.fallback).length, evidence: 'fictional backend image URLs fulfilled locally; missing text-item images use the production SVG placeholder rather than visible text'}));
      }
      for (const key of ['composeInput', 'composeSend']) {
        const expected = ref[key], found = app[key], props = ['padding', 'opacity'];
        const mismatch = expected && found ? props.filter(property => expected[property] !== found[property]).map(property => `${property}: ${expected[property]} -> ${found[property]}`) : ['missing source or app element'];
        gate(`${name} ${key} details`, mismatch.length === 0, mismatch.join('; ') || 'same input padding and empty/sending opacity');
      }
      const controls = ['title', 'audience', 'orb', 'themeButton', 'settingsButton', 'windowMin', 'windowMax', 'windowClose', 'composeForm', ...(mode === 'card' ? ['viewerQuickButton', 'voiceChip'] : []), ...(editing ? ['editorSave'] : [])];
      for (const key of controls) {
        const expected = ref[key], found = app[key]; if (!expected || !found) continue;
        const props = ['transitionProperty', 'transitionDuration', 'transitionTimingFunction'];
        const mismatch = props.filter(property => expected[property] !== found[property]).map(property => `${property}: ${expected[property]} -> ${found[property]}`);
        gate(`${name} ${key} control transition`, mismatch.length === 0, mismatch.join('; ') || 'same interactive transition properties, durations and easing');
      }
      for (const key of ['daypart', 'date', ...(mode === 'live' || mode === 'calm' || longTexts[mode] ? ['currentText', 'currentName', 'currentTime'] : [])]) {
        gate(`${name} ${key} content`, ref[key]?.text === app[key]?.text, `${ref[key]?.text} -> ${app[key]?.text}`);
      }
      if (!editing) gate(`${name} user change: masthead uses account identity`, app.title?.text === `${state.account.name}的直播间` && ref.title?.text === app.title?.text, JSON.stringify({expected: `${state.account.name}的直播间`, found: app.title?.text, roomTitleRetained: state.broadcast.room.title, referencePolicy: 'only .ttl .tt text fixture matched; original header geometry, type, pen and hover retained'}));
      if (editing) gate(`${name} user change: title editor still uses actual room title`, await actual.locator('#onair-panel input[name="title"]').inputValue() === state.broadcast.room.title, 'account byline does not replace the current room title or editor draft');
      if (['offair', 'face'].includes(mode)) gate(`${name} user change: prepared scene has no tonight title label`, await actual.locator('#lake-current .lake-message-meta').count() === 0 && !!ref.currentMeta, 'latest user request removes the original metadata label only; original title position and fonts are still compared');
      for (const key of Object.keys(motionSelectors)) {
        const expected = referenceMotion[name][key], found = actualMotion[name][key];
        const mismatch = [];
        if (found.length !== expected.length) mismatch.push(`element count ${expected.length} -> ${found.length}`);
        for (let index = 0; index < Math.min(found.length, expected.length); index++) {
          if (JSON.stringify(expected[index].animations) !== JSON.stringify(found[index].animations)) mismatch.push(`element ${index + 1} timing/keyframes differ`);
        }
        gate(`${name} ${key} motion`, mismatch.length === 0, mismatch.slice(0, 6).join('; ') || 'matching durations, delays, repeat count, direction, fill, easing and complete keyframe values');
      }
      if (mode === 'face') {
        const expected = referenceMotion[name].faceNormalized, found = actualMotion[name].faceNormalized;
        const metadata = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'frames'));
        const same = expected && found && JSON.stringify(metadata(expected)) === JSON.stringify(metadata(found)) && expected.frames.every((frame, index) => Math.abs(frame.opacity - found.frames[index].opacity) <= .0001 && Object.keys(frame.rect).every(key => Math.abs(frame.rect[key] - found.frames[index].rect[key]) <= .1));
        gate(`${name} face complete relative motion`, !!same, JSON.stringify({expected, found}));
      }
      if (mode === 'live' || mode === 'calm') {
        await reference.goto(`${origin}/reference/Lake.dc.html?theme=${theme}&mode=${mode}`); await reference.locator('.dv').waitFor(); await settle(reference);
        await reference.addStyleTag({ content: '.tb,.daytxt,.date,.ttl-row,.who,.line,.still,.sunk,.right,.foot,.orb-tip{visibility:hidden!important}' });
        await actual.addStyleTag({ content: '#titlebar,.lake-header,.lake-body,.onair-wrap,.lake-foot,.dock-wrap,#chat-compose,.lake-orb-tip{visibility:hidden!important}' });
        const referenceBuffer = await reference.screenshot({ path: path.join(output, `reference-scenery-${name}.png`) });
        const actualBuffer = await actual.screenshot({ path: path.join(output, `actual-scenery-${name}.png`) });
        const pixels = comparePixels(referenceBuffer, actualBuffer); await fs.writeFile(path.join(output, `scene-diff-${name}.png`), pixels.diff); delete pixels.diff;
        scenic[name] = pixels;
        gate(`${name} scenic pixels`, pixels.mismatchRatio <= 0.002, `${(pixels.mismatchRatio * 100).toFixed(4)}% pixels differ by >4 RGB levels; mean channel delta ${pixels.meanChannelDelta.toFixed(4)}`);
      }
      if (mode === 'emote') {
        const draft = await actual.locator('#chat-message').inputValue();
        const firstId = state.chat_send.emoticons[0].emoticons[0].emoticon_unique;
        const before = calls.length;
        await actual.locator('[data-action="chat.emoticon.send"]').first().click();
        await actual.waitForFunction(() => !document.querySelector('#chat-message').disabled);
        const sent = calls.slice(before).filter(call => call.action === 'bili.chat.emoticon.send');
        gate(`${name} user change: image click sends separately and retains draft`, sent.length === 1 && sent[0].payload.emoticon_unique === firstId && sent[0].payload.confirmed === true && await actual.locator('#chat-message').inputValue() === draft && !calls.slice(before).some(call => call.action === 'bili.chat.send'), JSON.stringify({draft, sent, evidence: 'fictional IPC only; no API POST or local receive echo'}));
      }
      console.log(`app ${name}`);
    }
    const hoverPairs = {
      live: {title: ['.ttl', '#lake-title'], orb: ['.orb', '.lake-orb'], audience: ['.watch', '#audience-count']},
      card: {quick: ['.vw-q button', '.viewer-quick button'], voice: ['.sheet .chip', '#viewer-voices button']},
    };
    const hover = {reference: {}, actual: {}};
    for (const mode of ['live', 'card']) {
      await reference.goto(`${origin}/reference/Lake.dc.html?theme=night&mode=${mode}`); await reference.locator('.dv').waitFor(); await settle(reference);
      state = fixture('night', mode); await actual.goto(origin); await actual.locator('#live-shell.lake-mode').waitFor(); await actual.evaluate(() => window.__lakeParityStop());
      if (mode === 'card') { await actual.locator('#lake-current .lake-message-name').click(); await actual.locator('.viewer-mute-action:not([disabled])').waitFor(); }
      await settle(actual);
      hover.reference[mode] = await hoverStyles(reference, hoverPairs[mode], 0); hover.actual[mode] = await hoverStyles(actual, hoverPairs[mode], 1);
      for (const key of Object.keys(hoverPairs[mode])) {
        const expected = hover.reference[mode][key], found = hover.actual[mode][key], mismatch = Object.keys(expected).filter(property => expected[property] !== found[property]).map(property => `${property}: ${expected[property]} -> ${found[property]}`);
        gate(`${mode} ${key} actual hover`, mismatch.length === 0, mismatch.join('; ') || 'same actual hovered colors, shape, transform, shadow and transitions');
      }
    }
    await fs.writeFile(path.join(output, 'hover-measurements.json'), JSON.stringify(hover, null, 2));
    await reference.goto(`${origin}/reference/Lake.dc.html?theme=night&mode=live`); await reference.locator('.dv').waitFor(); await settle(reference);
    const referenceTheme = await themeMotion(reference, '.tb-tools .tb-btn:first-child');
    state = fixture('night', 'live'); await actual.goto(origin); await actual.locator('#live-shell.lake-mode').waitFor(); await actual.evaluate(() => window.__lakeParityStop()); await settle(actual);
    const actualTheme = await themeMotion(actual, '#titlebar-actions [data-action="theme.toggle"]');
    gate('theme toggle full motion', JSON.stringify(referenceTheme) === JSON.stringify(actualTheme), JSON.stringify({reference: referenceTheme, actual: actualTheme}));
    await fs.writeFile(path.join(output, 'theme-motion.json'), JSON.stringify({reference: referenceTheme, actual: actualTheme}, null, 2));
    state = fixture('night', 'live'); state.preferences.broadcast_console = false;
    await actual.goto(origin); await actual.locator('#live-shell.lake-mode').waitFor(); await actual.evaluate(() => window.__lakeParityStop());
    gate('user exception: disabled broadcast has no start/stop buttons', await actual.locator('#live-shell [data-action="broadcast.start"],#live-shell [data-action="broadcast.stop"]').count() === 0, 'existing broadcaster preference controls visibility');
    gate('user exception: exactly day/night and settings toolbar tools', JSON.stringify(await actual.locator('#titlebar-actions button').evaluateAll(nodes => nodes.map(node => node.dataset.action))) === JSON.stringify(['theme.toggle', 'settings.open']), 'two actual working controls');
    gate('user change: sending controls available with broadcast mode disabled', await actual.locator('#chat-compose').isVisible() && await actual.locator('#chat-message').isEnabled() && await actual.locator('[data-action="chat.emoticons"]').isEnabled(), 'current valid logged-in fixture account and network still required; no broadcast-console gate');
    state.live.audience.rank_count = 0; state.live.audience.rank_count_text = '0'; state.live.audience.watched_count = 0;
    await actual.evaluate(next => window.__lakeParityPush(next), structuredClone(state));
    gate('user change: zero audience hides the whole byline', !await actual.locator('#audience-count').isVisible() && await actual.locator('#audience-count').getAttribute('hidden') !== null, 'no visible 0 人在看 text or overlapping avatars');
    gate('no browser errors', errors.length === 0, JSON.stringify(errors));
    gate('user extension: package and item icon fixtures resolved locally', [...fixturePackIcons, ...fixtureItemIcons].every(url => fixtureIconRequests.includes(url)), JSON.stringify({requests: fixtureIconRequests, evidence: 'only four fictional metadata/image URLs fulfilled locally; all other external network remains blocked'}));
    gate('runtime and original reference bytes stable during comparison', JSON.stringify(originalHashes) === JSON.stringify(await assetHashes()), 'SHA256 of all non-test HTML/CSS/JS/MJS, bundled font binaries, original DC runtime/HTML/logo unchanged throughout the full run');
    const bundledAssets = await bundledAssetsReport(originalHashes);
    await fs.writeFile(path.join(output, 'ui-assets-verification.json'), JSON.stringify(bundledAssets, null, 2));
    gate('all configured bundled assets bind the completed parity run', bundledAssets.passed, JSON.stringify({assetCount: bundledAssets.assetCount, capturedAssets: bundledAssets.capturedAssets, logoMatchesCapturedReference: bundledAssets.logoMatchesCapturedReference}));
    const evidence = 'Actual production app module paired with actual exported Lake.dc.html in headless Edge; independent original Google fonts loaded from verified untouched source cache, production loads its own renamed subset. Matched fictional test-only IPC/session data and deterministic dates; reference layout/runtime preserved. The large Tuesday night/date masthead is unchanged. Only reference .ttl .tt byline text is fixture-matched to the current account name plus 的直播间; the room title, editor and prepared-scene title remain original. The original prepared-scene tonight’s title label is intentionally absent only in production, and a zero-count audience byline is hidden. The user-authorized emote picker uses only images, accessible package/item names, a compact transparent five-column grid and every selected-pack item in one continuous scroll panel, with no visible labels, tooltips or pagination. Its glass material, bottom/right anchor and popup motion still match the original; its width and interior spacing intentionally change. All image-backed emote cards send their actual item IDs separately, preserving the composer draft; sending no longer depends on broadcast mode. The latest user clarified that the original voice selection should remain: its natural wrapping capsules, spacing and gradient selected state are restored and compared directly to the original, including every item, typography, surfaces, transitions and hover. Existing hidden/nowrap protection for real preset labels is separately verified against the pinned prior production measurements seen by the user, rather than claimed equal to exported HTML. Only moderation below the voice choices intentionally uses a unified glass group with aligned compact actions; test-ui-viewer-layout.cjs replaces source comparisons only for that moderation area. The original sheet, header/avatar/name/quick actions, said messages and alias geometry/typography, as well as sheet/scrim motion, retain exact source gates. All unchanged scenery/font/motion tolerances remain unchanged. This fictional IPC evidence verifies only browser behavior, not platform POST/received-image rendering. External network blocked; no native WebView2, real account, broadcast or audio acceptance.';
    await fs.writeFile(path.join(output, 'actual-measurements.json'), JSON.stringify({ evidence, measurements: actualMeasurements }, null, 2));
    await fs.writeFile(path.join(output, 'animation-measurements.json'), JSON.stringify({ reference: referenceMotion, actual: actualMotion }, null, 2));
    await fs.writeFile(path.join(output, 'voice-restoration-measurements.json'), JSON.stringify({ voicePresentationBaseline, reference: referenceVoiceLayouts, actual: actualVoiceLayouts }, null, 2));
    await fs.writeFile(path.join(output, 'parity-results.json'), JSON.stringify({ passed: failures.length === 0, evidence, voicePresentationBaseline, fontSources: referenceFonts.manifest, gatePolicy: { geometryTolerancePx: .25, typography: 'exact computed styles outside the latest explicitly redesigned viewer moderation controls; original voice choices fully compared', scenicPixelTolerance: 'at least 99.8 percent of pixels within 4 RGB levels' }, presentationPolicy: 'Each case uses a fresh native session and delivers the final new message through production acceptSnapshot, preserving complete first-presentation letters and same-node sink comparisons. Previously displayed messages recover statically and hydrated history has no entry replay; separate final 15-scenario recovery acceptance verifies this authorized behavior.', approvedExceptions: ['live controls hidden when broadcast mode is disabled; message and emote sending remain available to the valid account', 'OBS overlay title editor removed', 'toolbar has working day/night and settings buttons', 'large Tuesday night and adjacent date/time retained; time-under-header byline always uses the current account name plus 的直播间, independent of room title', 'prepared-scene tonight’s title label removed, with the actual room title and its original position retained', 'zero audience hides the complete X 人在看 control', 'image-only emote picker, compact five-column transparent grid, no visible labels/tooltips/pagination, all selected-pack items scroll continuously; picker width and padding intentionally differ', 'emote card clicks send separate actual-ID messages directly and retain the typed draft', 'latest clarification restores the original voice capsules, natural wrap, spacing and gradient selection; their complete source geometry, typography, surfaces, transitions and hover are compared again. Only the moderation group below them uses a new compact aligned layout; its internal geometry, styles, control transitions and hover are replaced by dedicated viewer-layout acceptance. Unchanged sheet/header/avatar/name/quick/said/alias and sheet/scrim motion remain compared to source'], dynamicDataPolicy: ['production avatars, room titles, account names, voice presets and live events retain real values; only reference .ttl .tt dynamic byline text is fixture-matched, while original editor and prepared-scene titles remain untouched', 'moderation controls preserve actual permission state and supported durations; the existing moderation and alias browser suites still verify actual fixture IPC, account/target isolation, confirmation, failures, drafts and keyboard focus after the moderation redesign and original voice restoration', 'face verification QR comes from the real backend', 'available Bilibili emote packages determine panel content and height', 'account comment/purchased and live packages supply real covers/images; package and item names remain accessible labels, missing item images use a legal SVG placeholder; source warnings remain accessible; backend freshly resolves each item ID and uses its actual text marker or standalone live token', 'session summaries show backend records only; missing histories and unknown durations are omitted'], replacementEvidence: {lowerViewerLayout: 'scripts/test-ui-viewer-layout.cjs', moderationBehavior: 'scripts/test-ui-moderation.cjs', aliasBehavior: 'scripts/test-ui-emotes-alias.cjs', scope: 'Source equality is intentionally excluded only for newly authorized viewer moderation controls. Original voice capsules retain complete source appearance comparisons, with only their existing hidden/nowrap label-clipping fields pinned to prior production measurements; dedicated browser outputs additionally verify saved voices and focus behavior and are separately recorded and bound to final production assets.'}, gates, scenic, failures, errors, actions: calls.map(call => call.action) }, null, 2));
    console.log(`${gates.length - failures.length}/${gates.length} source parity gates passed; evidence ${output}`);
    if (failures.length) console.log(failures.join('\n'));
    if (!process.env.DV_PARITY_RECORD) assert.deepEqual(failures, [], 'Reference visual parity gates failed; inspect parity-results.json and paired screenshots');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
