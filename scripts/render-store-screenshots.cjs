// Renders Microsoft Store and README screenshots from the production UI module
// in headless Edge. The fictional IPC, viewers and voices exist only in this
// script; all external traffic is blocked, nothing signs in and no speech is
// synthesized. Output: <DV_STORE_OUTPUT or "Claude outputs/store-screenshots">.
//
//   $env:NODE_PATH = (npm root -g); node scripts/render-store-screenshots.cjs
//
// Every capture is checked for platform and provider names that the Microsoft
// Store listing must not show (see docs/STORE-LISTING.md).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const repo = path.resolve(__dirname, '..');
const uiRoot = path.join(repo, 'crates/desktop/ui');
const output = path.resolve(process.env.DV_STORE_OUTPUT || path.join(repo, 'Claude outputs/store-screenshots'));
const rawDir = path.join(output, 'raw');
const banned = /豆包|哔哩哔哩|B站|b站|bilibili|doubao/i;
// Fixed clocks keep the evening/afternoon headings and timestamps believable.
const night = Date.parse('2026-10-16T21:36:00+08:00');
const afternoon = Date.parse('2026-10-17T15:20:00+08:00');
let now = night;
const minute = 60000;
const appVersion = require('node:fs').readFileSync(path.join(repo, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];

// ---------- fictional data ----------
const copy = {
  'zh-CN': {
    streamer: '柚子不加糖', title: '深夜电台 · 陪你聊到困', area: ['娱乐', '聊天电台'],
    viewers: ['momo酱', '今天也要早睡', 'Lumi', '小蘑菇', '晚风', '橘子汽水', '星河入梦', '阿杰'],
    lines: [
      [0, '我又来啦，昨天的回放看完了'], [3, '刚刚那段高音好稳'], [6, '主播今天的声音好温柔'],
      [1, '打卡第 37 天'], [2, '可以点一首晴天吗'], [7, '第一次来，已经关注了'],
      [3, '哈哈哈哈哈'], [2, '下一首想听慢一点的歌～'], [1, '晚安前记得多喝水'],
      [0, '这首歌的前奏也太好听了吧'],
    ],
    gift: [4, '小花花', 10], superChat: [5, '祝直播顺利！今晚也辛苦啦', 30],
    reading: [0, '这首歌的前奏也太好听了吧'],
    voices: [
      ['fish-gentle', '温柔姐姐', 'fish'], ['fish-sunny', '元气少女', 'fish'], ['sovits-moon', '月见', 'gpt_sovits'],
      ['fish-narrator', '沉稳旁白', 'fish'], ['dots-radio', '晚安电台', 'dots'],
    ],
    userWords: [['momo酱', '莫莫酱'], ['Lumi', '露米'], ['今天也要早睡', '早睡同学']],
    messageWords: [['yyds', '永远的神'], ['awsl', '啊我死了'], ['233', '哈哈哈']],
    emoteWords: [['[doge]', '狗头']],
    sample: '晚上好，欢迎来到直播间。',
    overlayTitle: '深夜电台', overlayTagline: '陪你聊到困',
  },
  en: {
    streamer: 'Yuzu', title: 'Late-night radio · stay till sleepy', area: ['Entertainment', 'Chat radio'],
    viewers: ['momo', 'EarlyBird', 'Lumi', 'Mushroom', 'Evening Breeze', 'Orange Soda', 'Stardust', 'Jay'],
    lines: [
      [0, "I'm back, finished last night's replay"], [3, 'That high note was so steady'], [6, 'Your voice sounds so gentle today'],
      [1, 'Day 37 check-in'], [2, 'Can we hear Sunny Day next?'], [7, 'First time here, just followed'],
      [3, 'hahaha'], [2, 'Something slower next, please~'], [1, 'Drink some water before bed'],
      [0, 'This intro is so good'],
    ],
    gift: [4, 'Little Flower', 10], superChat: [5, 'Have a great stream, thanks for tonight!', 30],
    reading: [0, 'This intro is so good'],
    voices: [
      ['fish-gentle', 'Gentle Sister', 'fish'], ['fish-sunny', 'Sunny Girl', 'fish'], ['sovits-moon', 'Tsukimi', 'gpt_sovits'],
      ['fish-narrator', 'Calm Narrator', 'fish'], ['dots-radio', 'Goodnight Radio', 'dots'],
    ],
    userWords: [['momo', 'Momo'], ['Lumi', 'Loo-mee'], ['EarlyBird', 'Early Bird']],
    messageWords: [['gg', 'good game'], ['lol', 'laugh out loud'], ['brb', 'be right back']],
    emoteWords: [['[doge]', 'doge']],
    sample: 'Good evening, welcome to the stream.',
    overlayTitle: 'Late-night radio', overlayTagline: 'stay till sleepy',
  },
};

function fixture(language, appearance) {
  const c = copy[language];
  const uid = index => 7100 + index;
  const event = (id, viewer, extra) => ({
    platform_event_id: `store-${id}`, room_id: 22333, observed_at_ms: now - (40 - id) * 37000,
    kind: 'danmaku', user_id: uid(viewer), user_name: c.viewers[viewer], avatar_url: null, ...extra,
  });
  const events = [];
  c.lines.forEach(([viewer, message], index) => {
    events.push(event(index * 2 + 1, viewer, { message }));
    if (index === 3) events.push(event(index * 2 + 2, c.gift[0], { kind: 'gift', message: '', gift_name: c.gift[1], quantity: c.gift[2], price_yuan: 1 }));
    if (index === 6) events.push(event(index * 2 + 2, c.superChat[0], { kind: 'super_chat', message: c.superChat[1], price_yuan: c.superChat[2] }));
  });
  const reading = events.find(item => item.kind === 'danmaku' && item.message === c.reading[1]);
  const providerOf = { fish: 'fish_audio', gpt_sovits: 'gpt_sovits', dots: 'dots' };
  return {
    config_revision: 1, onboarding_done: true, network_disabled: false, app_version: appVersion,
    preferences: { language, appearance, scale: 1, master_volume: 0.72, muted: false, tts_enabled: true, broadcast_console: true },
    setup: { room_id: 22333, tts_enabled: true, mode: 'account', uid: 42 },
    live_settings: { room_id: 22333, gift_merge: { enabled: true, initial_seconds: 1.5, increment_seconds: 0.5, maximum_seconds: 5 } },
    live: {
      running: true, state: 'connected', room_id: 22333, received: events.length, events,
      audience: { active: true, live_status: 1, loading: false, error: null, rank_count: 52, rank_count_text: '52', watched_count: 386, updated_at_ms: now, page: 1, has_more: false, users: [] },
    },
    live_history: { session_id: 'store-session', room_id: 22333, started_at_ms: now - (2 * 60 + 14) * minute, messages: 386, unique_viewers: 52 },
    queue: { current: { id: 900, origin: 'live', user_name: reading.user_name, text: reading.message }, pending: [], history: [] },
    playback: { job_id: 900, played_ms: 1500, queued_ms: 3600 },
    rules: {
      default_preset_id: 'fish-gentle', preferred_presets: {},
      events: { danmaku_on: true, filter_bilibili_emoticons: true, gift_on: true, free_gift_on: false, super_chat_on: true, guard_on: true, gift_threshold_yuan: 5, super_chat_threshold_yuan: 30 },
      templates: { danmaku: '{user_name}说：{message}', gift: '{user_name}赠送了{gift_num}个{gift_name}', super_chat: '{user_name}留言：{message}', guard: '感谢{user_name}赠送的{guard_name}' },
      user_words: c.userWords.map(([from, to]) => ({ from, to })),
      message_words: c.messageWords.map(([from, to]) => ({ from, to })),
      emote_words: c.emoteWords.map(([from, to]) => ({ from, to })),
      sounds: [],
    },
    connections: [
      { id: 'fish', settings: { provider: 'fish_audio' }, has_credential: true },
      { id: 'gpt_sovits', settings: { provider: 'gpt_sovits', endpoint: 'http://127.0.0.1:9880' }, has_credential: false },
      { id: 'dots', settings: { provider: 'dots', endpoint: 'http://127.0.0.1:9881' }, has_credential: false },
    ],
    presets: c.voices.map(([id, name, connection]) => ({ id, name, connection_id: connection, provider: providerOf[connection], voice_id: `${id}-voice`, speed: 1, volume: 1, sovits: null })),
    bindings: [{ id: 'bind-regular', binding: { platform: 'bilibili', user_id: null, user_name: c.viewers[0], legacy_user_name: null, preset_id: 'fish-sunny', enabled: true } }],
    assets: [], devices: [],
    local_services: { gpt_sovits: { state: 'ready', directory: 'D:/Voices/GPT-SoVITS' }, dots: { state: 'stopped', directory: 'D:/Voices/dots' } },
    account: { user_id: 42, name: c.streamer }, qr: { status: 'idle' }, status: {}, startup_enabled: true,
    broadcast: {
      room: { room_id: 22333, title: c.title, parent_area_id: 1, area_id: 10, live_status: 1, live_since: Math.floor(now / 1000) - (134 * 60 + 10) },
      areas: [{ id: 1, name: c.area[0], children: [{ id: 10, name: c.area[1] }] }],
      busy: false, has_stream_key: false, face_image: null, session_active: true,
      last_session: { started_at: Math.floor(now / 1000) - 86400 - 8040, observed_started_at: Math.floor(now / 1000) - 86400 - 8040, ended_observed_at: Math.floor(now / 1000) - 86400, messages: 386, seconds: 8040 },
    },
    obs: { settings: { enabled: true, host: '127.0.0.1', port: 4455, auto_launch: true }, has_password: true, local: true, detected: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
      status: { state: 'ok', obs_version: '31.0', streaming: true, overlay_sync: { state: 'ready', scene: language === 'en' ? 'Live' : '直播', width: 1920, height: 1080 } } },
    overlay: {
      settings: { enabled: true, style: 'spine', corner: 'top_left', offset_x: 64, offset_y: 64, scale: 1, vignette: 0.6, title: c.overlayTitle, tagline: c.overlayTagline,
        show_danmaku: true, show_gift: true, show_super_chat: true, show_guard: true, names: 'special', merge_duplicates: true, linger_seconds: 14, port: 47823, token: '0'.repeat(32) },
      running: true, clients: [], obs_clients: 1,
      preview: {
        items: events.filter(item => item.kind === 'danmaku').slice(-4).map((item, index) => ({ seq: index + 1, kind: 'danmaku', name: item.user_name, message: item.message, at: item.observed_at_ms, job_id: index === 3 ? 900 : null })),
        reading: { job_id: 900, played_ms: 1500, queued_ms: 3600 },
      },
    },
    chat_send: { busy: false, error: null, account_id: 42, room_id: 22333, message_limit: 20, emoticons: [] },
    moderation: { busy: false, user_id: null, room_id: null, can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null, message: null },
  };
}

// ---------- harness ----------
let state;
const archive = () => state.live.events.map((event, index) => ({ sequence: index + 1, event })).reverse();
async function invoke(command, args) {
  if (command === 'ui_activity') return true;
  if (command === 'snapshot') return structuredClone(state);
  if (command === 'check_update') return { available: false };
  assert.equal(command, 'dispatch');
  const { action, payload } = args;
  let result;
  if (action === 'live.history') {
    const all = archive().filter(item => !payload.viewer || `uid:${item.event.user_id}` === payload.viewer);
    const items = all.filter(item => !payload.before || item.sequence < payload.before).slice(0, payload.limit || 100);
    result = { ...state.live_history, items, before: items.at(-1)?.sequence || null, has_more: false, viewer_messages: payload.viewer ? Math.max(all.length, 14) : null };
  } else if (action === 'bili.moderation.refresh') {
    state.moderation = { busy: false, user_id: payload.user_id, room_id: 22333, can_moderate: true, can_blacklist: true, can_manage_admins: true, muted: false, blacklisted: false, is_admin: false, message: null };
  } else if (action === 'obs.bitrate.get') {
    result = { bitrate_kbps: 6000, output_mode: 'simple', editable: true, outputs_active: false, applies_next_stream: false, reason: null };
  } else if (action === 'preferences.save') Object.assign(state.preferences, payload.preferences);
  // Reads, refreshes and cancels need no fixture change.
  return { ...structuredClone(state), result };
}

async function main() {
  await fs.mkdir(rawDir, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const base = pathname.startsWith('/__out/') ? output : uiRoot;
      const target = path.resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname.replace(/^\/__out/, '')));
      if (!target.startsWith(base + path.sep)) return response.writeHead(403).end();
      let body = await fs.readFile(target).catch(() => fs.readFile(path.join(uiRoot, 'fonts', path.basename(target))));
      if (pathname === '/app.js') body = body.toString() + '\n// Screenshot instrumentation, never installed in production.\nwindow.__storePush = acceptSnapshot;\nwindow.__storeStopPoll = () => { clearTimeout(snapshotTimer); boot.polling = false; };';
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(target)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
  const captured = [];
  try {
    for (const language of process.argv.includes('--compose-only') ? [] : ['zh-CN', 'en']) {
      for (const scene of scenes) {
        now = scene.appearance === 'light' ? afternoon : night;
        state = fixture(language, scene.appearance || 'dark');
        scene.prepare?.(state, language);
        const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, deviceScaleFactor: 2, reducedMotion: 'reduce', locale: language, timezoneId: 'Asia/Shanghai' });
        await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.clock.setFixedTime(now);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(8000);
        await page.exposeFunction('__storeInvoke', invoke);
        await page.addInitScript(appearance => {
          window.__TAURI__ = { core: { invoke: (command, args) => window.__storeInvoke(command, args) }, event: { listen: async () => () => {} } };
        }, scene.appearance || 'dark');
        await page.goto(origin);
        await page.locator(scene.ready || '#live-shell').waitFor();
        await page.evaluate(() => window.__storeStopPoll());
        await page.evaluate(() => document.fonts.ready);
        await scene.run(page, language);
        await page.mouse.move(scene.mouse?.[0] ?? 1030, scene.mouse?.[1] ?? 60);
        if (scene.hover) await page.mouse.move(...scene.hover);
        await page.waitForTimeout(scene.settle ?? 900);
        const text = await page.evaluate(() => document.body.innerText + ' ' + [...document.querySelectorAll('[aria-label],[title],[placeholder]')].map(node => node.getAttribute('aria-label') + ' ' + node.getAttribute('title') + ' ' + node.getAttribute('placeholder')).join(' '));
        const file = path.join(rawDir, `${scene.id}-${language}.png`);
        await page.screenshot({ path: file });
        const visible = await page.evaluate(() => {
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode; const parent = node.parentElement;
            if (!node.textContent.trim() || !parent) continue;
            const style = getComputedStyle(parent); const box = parent.getBoundingClientRect();
            if (style.visibility === 'hidden' || style.display === 'none' || +style.opacity === 0 || !box.width || box.bottom < 0 || box.top > innerHeight) continue;
            out.push(node.textContent.trim());
          }
          return out.join(' | ');
        });
        const hit = visible.match(banned);
        assert.equal(hit, null, `${scene.id}-${language} shows a name the Store listing must not show: ${hit?.[0]} in ${visible}`);
        if (language === 'en') {
          assert.doesNotMatch(visible.replace(/[\u3000-\u303f\uff00-\uffef]/g, ''), /[\u4e00-\u9fff]/, `${scene.id}-en shows Chinese UI text: ${visible}`);
          assert.doesNotMatch(visible, /@ TA\b|\b1 hours\b|\b1 minutes\b/, `${scene.id}-en shows untranslated or unpluralized copy: ${visible}`);
        }
        assert.deepEqual(errors, [], `${scene.id}-${language} page errors`);
        captured.push({ id: scene.id, language, file, hiddenTextMentions: (text.match(banned) || [])[0] || null });
        console.log(`ok ${scene.id}-${language}`);
        await context.close();
      }
    }
    if (captured.length) await fs.writeFile(path.join(rawDir, 'captures.json'), JSON.stringify(captured, null, 2));
    await compose(browser, origin);
  } finally {
    await browser.close();
    server.close();
  }
}

const openSettings = async (page, tab) => {
  await page.locator('[data-action="settings.open"]').click();
  await page.locator('#settings[open]').waitFor();
  if (tab) {
    if (!await page.locator(`#settings [data-action="settings.tab"][data-id="${tab}"]`).count()) await page.locator('#settings [data-action="settings.tab"][data-id="home"]').click();
    await page.locator(`#settings [data-action="settings.tab"][data-id="${tab}"]`).click();
  }
  await page.waitForTimeout(700);
};

const scenes = [
  { id: '01-reflection', ready: '#lake-current .lake-message', run: async () => {} },
  { id: '02-voices', ready: '#lake-current .lake-message', run: async page => {
    await page.locator('#tts-switch').click();
    await page.waitForTimeout(500);
  } },
  { id: '03-viewer', ready: '#lake-current .lake-message', run: async page => {
    await page.locator('#lake-current [data-action="viewer.open"]').first().click();
    await page.waitForTimeout(800);
  } },
  { id: '04-history', ready: '#lake-current .lake-message', run: async page => {
    await page.mouse.move(400, 650); await page.mouse.wheel(0, 250);
    await page.locator('#lake-deep').waitFor();
    await page.waitForTimeout(800);
  }, mouse: [1030, 400] },
  { id: '05-voice-settings', ready: '#lake-current .lake-message', run: async page => openSettings(page, 'voices') },
  { id: '06-readings', ready: '#lake-current .lake-message', run: async page => openSettings(page, 'readings') },
  { id: '07-obs', ready: '#lake-current .lake-message', run: async page => {
    await openSettings(page, 'overlay');
    await page.locator('[data-obs-view="preview"]').waitFor();
    await page.waitForTimeout(600);
  } },
  { id: '08-day-offair', appearance: 'light', prepare: (s, language) => {
    Object.assign(s.broadcast.room, { title: language === 'en' ? 'Afternoon songs' : '午后电台 · 一起听歌', live_status: 0, live_since: null }); s.broadcast.session_active = false;
    s.live.events = []; s.queue.current = null; s.playback = null; s.live.received = 0;
    s.live_history = { session_id: 'store-session-2', room_id: 22333, started_at_ms: now, messages: 0, unique_viewers: 0 };
  }, run: async () => {} },
  { id: '09-settings-home', ready: '#lake-current .lake-message', run: async page => openSettings(page) },
  { id: '10-welcome', ready: '#setup-shell .setup-welcome-actions', prepare: s => {
    s.onboarding_done = false; s.account = null; s.setup = { room_id: null, tts_enabled: true, mode: 'account', uid: null };
    s.live = { running: false, state: 'stopped', events: [], received: 0 }; s.queue.current = null; s.playback = null;
  }, run: async () => {} },
];

// ---------- composition: headline beside the real window capture ----------
// Store order and captions; docs/STORE-LISTING.md repeats these captions.
const shots = [
  ['01-reflection', {
    'zh-CN': ['倒影朗读', '把弹幕，\n读成声音', '正在读的那一句浮在湖面上。水里的倒影随播放进度逐字亮起。'],
    en: ['Reflections', 'Hear your chat,\nread aloud', 'The line being read floats above the lake, and its reflection lights up progressively with playback.'] }],
  ['02-voices', {
    'zh-CN': ['声音面板', '换个声音，\n点一下就好', '点右下角的声音名字，切换音色、开关播报。名字下面那条水线就是音量，滚轮一拨就好。'],
    en: ['Voice panel', 'A new voice\nin one click', 'Click the voice name to switch voices or turn speech on and off. The waterline beneath it is the volume: just scroll.'] }],
  ['03-viewer', {
    'zh-CN': ['观众卡片', '熟悉的观众，\n熟悉的声音', '点一下弹幕，设置这位观众的名字怎么读、用哪个声音。'],
    en: ['Viewer card', 'Every regular,\ntheir own voice', 'Click a message to set how a viewer’s name is read and which voice reads them.'] }],
  ['04-history', {
    'zh-CN': ['湖底历史', '往下滚，\n翻看今晚', '本场的弹幕都沉在湖里。往下滚潜进水下，礼物和醒目留言一眼就能找到。'],
    en: ['Tonight’s history', 'Scroll down\nthrough tonight', 'Every message from this session rests in the lake. Scroll down to dive in; gifts and Super Chats stand out.'] }],
  ['05-voice-settings', {
    'zh-CN': ['声音', '云端或本地，\n都能接', '连接支持的云端语音服务，或你自己部署的本地服务。所有声音一张列表，原地试听和编辑。'],
    en: ['Voices', 'Cloud or local,\nyour choice', 'Connect supported cloud speech services or your own self-hosted service. All voices sit in one list, auditioned and edited in place.'] }],
  ['06-readings', {
    'zh-CN': ['记住的读法', '名字和词，\n都读得对', '观众名字、正文用词和表情的读法收在一页，搜索和添加都在原地完成。'],
    en: ['Saved readings', 'Every name,\nread right', 'Viewer names, words and emoticons share one page, with search and editing right there.'] }],
  ['07-obs', {
    'zh-CN': ['OBS 叠加层', '弹幕，也放进\n直播画面', '连接 OBS 后点一下添加，再直接拖动叠加层摆放位置，改动自动同步。'],
    en: ['OBS overlay', 'Put your chat\non stream', 'Connect OBS, add the overlay with one click and drag it into place. Changes sync automatically.'] }],
  ['08-day-offair', {
    'zh-CN': ['晨雾与夜幕', '开播之前，\n先写好标题', '点太阳或月亮切换晨雾和夜幕。登录后在主界面开播、下播，原地修改标题。'],
    en: ['Mist and night', 'Set the title,\nthen go live', 'Click the sun or moon to switch themes. Once signed in, go live, end the stream and edit the title from the main screen.'] }],
  ['10-welcome', {
    'zh-CN': ['简单上手', '一分钟，\n开始播报', '扫码登录自己的直播间，选好声音就能开始。关掉播报时，弹幕照常显示。'],
    en: ['Easy start', 'Ready in\na minute', 'Scan to sign in to your own live room, pick a voice and start. Chat stays on screen when speech is off.'] }],
];
const footer = { 'zh-CN': ['免费', '开源', '无广告', 'Windows'], en: ['Free', 'Open source', 'No ads', 'Windows'] };
const brand = { 'zh-CN': ['超绝可爱弹幕姬', '把直播弹幕，读成你喜欢的声音'], en: ['DanmakuVoice', 'Hear your live chat in the voice you love'] };
const esc = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fontFaces = `@font-face{font-family:"DV Serif";src:url(/fonts/DanmakuVoiceSerifSC-Bold.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:"DV Numeral";src:url(/fonts/InstrumentSerif-Italic.woff2) format("woff2");font-style:italic}`;
const backdrop = `background:radial-gradient(900px 620px at 78% 34%,rgba(200,182,240,.13),transparent 70%),radial-gradient(760px 520px at 10% 92%,rgba(242,167,195,.10),transparent 70%),linear-gradient(160deg,#17142c 0%,#0e0c1a 55%,#0a0912 100%)`;
const windowFrame = 'border-radius:10px;border:1px solid rgba(255,255,255,.14);box-shadow:0 48px 120px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.35);overflow:hidden';

function storePage(language, index, [eyebrow, headline, description], raw) {
  const en = language === 'en';
  return `<!doctype html><html lang="${language}"><meta charset="utf-8"><style>${fontFaces}
*{box-sizing:border-box;margin:0}html,body{width:1920px;height:1080px}body{${backdrop};color:#f5f2f8;font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;position:relative;overflow:hidden}
.brand{position:absolute;left:120px;top:96px;display:flex;align-items:center;gap:16px;font:600 24px/1 "DV Serif",serif;color:rgba(245,242,248,.72);letter-spacing:${en ? '.02em' : '.12em'}}
.brand img{width:44px;height:44px;border-radius:11px}
.copy{position:absolute;left:120px;top:0;bottom:0;width:${en ? 530 : 470}px;display:flex;flex-direction:column;justify-content:center}
.eyebrow{display:flex;align-items:baseline;gap:14px;margin-bottom:26px}.eyebrow i{font:italic 34px/1 "DV Numeral",serif;color:rgba(245,242,248,.42)}
.eyebrow span{font-size:21px;letter-spacing:${en ? '.18em' : '.32em'};color:#f2a7c3;${en ? 'text-transform:uppercase;font-size:18px;' : ''}}
h1{font:800 ${en ? 58 : 76}px/1.2 "DV Serif",serif;letter-spacing:${en ? '-.005em' : '.02em'};white-space:pre-line}
.rule{width:104px;height:2px;margin:40px 0 34px;background:linear-gradient(90deg,#f2a7c3,#c8b6f0)}
p{font-size:${en ? 24 : 25}px;line-height:1.75;color:rgba(245,242,248,.68);text-wrap:pretty}
.foot{position:absolute;left:120px;bottom:88px;font-size:19px;letter-spacing:.16em;color:rgba(245,242,248,.42)}.foot b{font-weight:400;margin:0 .7em;color:rgba(242,167,195,.6)}
.window{position:absolute;right:100px;top:131px;width:1150px;height:818px;${windowFrame}}.window img{display:block;width:100%;height:100%}
</style><body><div class="brand"><img src="/logo.png" alt="">${esc(brand[language][0])}</div>
<div class="copy"><div class="eyebrow"><i>${String(index + 1).padStart(2, '0')}</i><span>${esc(eyebrow)}</span></div><h1>${esc(headline)}</h1><i class="rule"></i><p>${esc(description)}</p></div>
<div class="foot">${footer[language].map(esc).join('<b>·</b>')}</div><div class="window"><img src="/__out/raw/${raw}" alt=""></div></body></html>`;
}

function heroPage(language) {
  const en = language === 'en';
  const chips = footer[language].map(item => `<span>${esc(item)}</span>`).join('');
  return `<!doctype html><html lang="${language}"><meta charset="utf-8"><style>${fontFaces}
*{box-sizing:border-box;margin:0}html,body{width:2400px;height:1200px}body{${backdrop};color:#f5f2f8;font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;position:relative;overflow:hidden}
.copy{position:absolute;left:150px;top:0;bottom:0;width:820px;display:flex;flex-direction:column;justify-content:center}
.copy img{width:132px;height:132px;border-radius:30px;box-shadow:0 18px 48px rgba(0,0,0,.45);margin-bottom:54px}
h1{font:900 ${en ? 100 : 104}px/1.1 "DV Serif",serif;letter-spacing:${en ? '-.01em' : '.03em'}}
.rule{width:124px;height:3px;margin:46px 0 40px;background:linear-gradient(90deg,#f2a7c3,#c8b6f0)}
p{font-size:${en ? 38 : 42}px;color:rgba(245,242,248,.72);letter-spacing:${en ? '0' : '.06em'}}
.chips{display:flex;gap:16px;margin-top:56px}.chips span{padding:14px 28px;border:1px solid rgba(255,255,255,.18);border-radius:999px;font-size:26px;color:rgba(245,242,248,.8);background:rgba(255,255,255,.04)}
.window{position:absolute;${windowFrame}}.window img{display:block;width:100%;height:100%}
.back{left:1290px;top:84px;width:960px;height:683px;opacity:.94}.front{left:1000px;top:372px;width:1040px;height:740px}
</style><body><div class="copy"><img src="/logo.png" alt=""><h1>${esc(brand[language][0])}</h1><i class="rule"></i><p>${esc(brand[language][1])}</p><div class="chips">${chips}</div></div>
<div class="window back"><img src="/__out/raw/08-day-offair-${language}.png" alt=""></div><div class="window front"><img src="/__out/raw/01-reflection-${language}.png" alt=""></div></body></html>`;
}

async function compose(browser, origin) {
  const pages = path.join(output, 'pages');
  await fs.mkdir(pages, { recursive: true });
  await fs.mkdir(path.join(output, 'readme'), { recursive: true });
  const render = async (name, html, width, height, target, scale = 1) => {
    await fs.writeFile(path.join(pages, `${name}.html`), html);
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${origin}/__out/pages/${name}.html`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth));
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, banned, `${name} caption names a platform or provider`);
    await page.screenshot({ path: target });
    await context.close();
    console.log(`composed ${path.relative(repo, target)}`);
  };
  for (const language of ['zh-CN', 'en']) {
    const tag = language === 'en' ? 'en' : 'zh-CN';
    for (const [index, [raw, captions]] of shots.entries()) {
      await render(`store-${tag}-${index + 1}`, storePage(language, index, captions[language], `${raw}-${language}.png`), 1920, 1080, path.join(output, `store-${tag}-${String(index + 1).padStart(2, '0')}.png`));
    }
    await render(`hero-${tag}`, heroPage(language), 2400, 1200, path.join(output, 'readme', `hero-${tag}.png`));
  }
  // README feature images: the same compositions at 1440 x 810, Chinese only.
  for (const [name, index] of [['reflection', 0], ['voices', 1], ['viewer', 2], ['obs', 6]]) {
    const [raw, captions] = shots[index];
    await render(`readme-${name}`, storePage('zh-CN', index, captions['zh-CN'], `${raw}-zh-CN.png`), 1920, 1080, path.join(output, 'readme', `feature-${name}.png`), 0.75);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
