// Geometry/style parity against the October 17 design.html artboards.
// The earlier October 6 parity evidence remains in target; its four-line surface
// and history drawer are superseded. This suite does not claim full pixel identity.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const repo = path.resolve(__dirname, '..');
const uiRoot = path.join(repo, 'crates/desktop/ui');
const referenceRoot = path.join(repo, 'target/design-reference/direct-html');
const output = path.resolve(process.env.DV_PARITY_OUTPUT || path.join(repo, 'target/lake-parity'));
const fixedNow = Date.parse('2026-10-06T14:24:00.000Z');
const longTexts = {};
const fixturePackIcons = [], fixtureTextEmotes = [], fixtureItemIcons = [];
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
const checks = [], measurements = [], errors = [];
let browser, server, actual, reference, state;
const styles = ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'transform', 'paddingBottom', 'borderRadius', 'boxSizing'];
async function measure(page, selector) {
  return page.locator(selector).first().evaluate((node, props) => {
    const r = node.getBoundingClientRect(), css = getComputedStyle(node);
    return { x: r.x, y: r.y, width: r.width, height: r.height, ...Object.fromEntries(props.map(key => [key, css[key]])) };
  }, styles);
}
function same(label, a, b, fields, epsilon = .6) {
  measurements.push({ label, actual: a, reference: b });
  for (const field of fields) {
    if (typeof b[field] === 'number') assert.ok(Math.abs(a[field] - b[field]) <= epsilon, `${label}.${field}: ${a[field]} != ${b[field]}`);
    else assert.equal(a[field], b[field], `${label}.${field}`);
    checks.push(`${label}.${field}`);
  }
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const sources = {};
  for (const id of ['01', '03', '04', '05', '35']) sources[id] = await fs.readFile(path.join(referenceRoot, `${id}-source.html`), 'utf8');
  const referenceHashes = Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, createHash('sha256').update(source).digest('hex')]));
  const assetNames = ['app.js','index.html','lake.css','lake-drawers.css','lake-redesign-main.css'];
  const hashes = async () => Object.fromEntries(await Promise.all(assetNames.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(uiRoot, file))).digest('hex')])));
  const initialHashes = await hashes();
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const id = pathname.match(/^\/reference\/(\d+)$/)?.[1];
      if (id) {
        // Source data/canvas support scripts are irrelevant to the static boards.
        // Load the same installed fonts locally; block all remote assets.
        const fonts = `<style>body{margin:0}x-dc{display:block}@font-face{font-family:'Noto Serif SC';src:url('/fonts/DanmakuVoiceSerifSC-Bold.woff2');font-weight:100 900}@font-face{font-family:'Instrument Serif';src:url('/fonts/InstrumentSerif-Regular.woff2')}@font-face{font-family:'Instrument Serif';src:url('/fonts/InstrumentSerif-Italic.woff2');font-style:italic}</style>`;
        const source = sources[id].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/@font-face\s*\{[^}]*\}/g, '') + fonts;
        return res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end(source);
      }
      const target = path.resolve(uiRoot, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(uiRoot + path.sep)) return res.writeHead(403).end();
      let source = await fs.readFile(target);
      if (pathname === '/app.js') source = source.toString() + '\nwindow.__parityPush=acceptSnapshot;window.__parityStop=()=>{clearTimeout(snapshotTimer);boot.polling=false};';
      const type = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.png':'image/png' }[path.extname(target)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control':'no-store' }).end(source);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', executablePath: process.env.DV_BROWSER_PATH || undefined, headless:true, args:['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport:{width:1040,height:740}, reducedMotion:'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    actual = await context.newPage(); reference = await context.newPage();
    actual.on('pageerror', error => errors.push(error.message));
    await actual.exposeFunction('__parityInvoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return structuredClone(state);
      if (args.action === 'bili.moderation.refresh') state.moderation = { user_id:args.payload.user_id, room_id:999, can_moderate:true, can_blacklist:true, can_manage_admins:true, muted:false, blacklisted:false, is_admin:false };
      else if (!['bili.broadcast.refresh','bili.chat.emoticons.refresh'].includes(args.action)) throw new Error(`Unexpected parity action ${args.action}`);
      return structuredClone(state);
    });
    await actual.addInitScript(() => { window.__TAURI__ = { core:{invoke:(command,args)=>window.__parityInvoke(command,args)}, event:{listen:async()=>()=>{}} }; });
    for (const theme of ['night','day']) {
      state = fixture(theme, 'live');
      state.broadcast.room.live_since = Math.floor(Date.now()/1000)-5028;
      const phrase = '晚上好呀，今天也来听你读弹幕';
      state.live.events.at(-1).message = phrase;
      state.queue.current.text = phrase;
      state.preferences.tts_enabled = true; state.setup.tts_enabled = true;
      await actual.goto(origin); await actual.locator('#lake-current .lake-letter').first().waitFor();
      await actual.evaluate(() => window.__parityStop());
      await reference.goto(`${origin}/reference/${theme === 'night' ? '01' : '35'}`);
      await Promise.all([actual.evaluate(()=>document.fonts.ready), reference.evaluate(()=>document.fonts.ready)]);
      same(`${theme} reflected type and scale`, await measure(actual,'#lake-text-reflection'), await measure(reference,'.refl'), ['x','width','fontSize','fontWeight','lineHeight','letterSpacing','transform','paddingBottom']);
      assert.equal(await actual.locator('#lake-current .lake-message-text').textContent(), await actual.locator('#lake-text-reflection').textContent());
      checks.push(`${theme} reflection is a copy of the actual phrase`);
      await actual.bringToFront(); await actual.emulateMedia({reducedMotion:'no-preference'}); await actual.waitForTimeout(100);
      const reflection = await actual.locator('#lake-text-reflection').evaluate(node=>({filter:getComputedStyle(node).filter,mask:getComputedStyle(node).maskImage,origin:getComputedStyle(node).transformOrigin}));
      assert.match(reflection.filter,/lake-caption-ripple.*blur\(0.6px\)/); assert.match(reflection.mask,/repeating-linear-gradient/); checks.push(`${theme} reflected text has a live ripple and intersected fading mask`);
      await actual.emulateMedia({reducedMotion:'reduce'});
      const phraseBox = await actual.locator('#lake-current .lake-message-text').boundingBox();
      const horizon = await actual.locator('.lake-horizon').boundingBox();
      assert.ok(Math.abs(horizon.y-phraseBox.y-phraseBox.height-16)<1); checks.push(`${theme} phrase rests exactly 16px above the waterline`);
      await actual.screenshot({path:path.join(output,`${theme}-actual.png`)}); await reference.locator('.dv').screenshot({path:path.join(output,`${theme}-reference.png`)});
    }
    state.preferences.appearance='dark'; await actual.evaluate(value=>window.__parityPush(value),state);
    await actual.locator('#tts-switch').click(); await reference.goto(`${origin}/reference/04`);
    same('voice panel',await measure(actual,'#tts-menu'),await measure(reference,'.pop'),['x','width','borderRadius','boxSizing']);
    assert.equal(await actual.locator('#tts-menu .lake-voice-row').count(),state.presets.length); checks.push('voice rows use actual saved presets');
    await actual.screenshot({path:path.join(output,'voice-actual.png')}); await reference.locator('.dv').screenshot({path:path.join(output,'voice-reference.png')});
    await actual.keyboard.press('Escape');
    await actual.locator('#lake-current .lake-message-name').click(); await reference.goto(`${origin}/reference/05`);
    same('viewer drawer',await measure(actual,'.viewer-sheet'),await measure(reference,'.drawer'),['x','y','width','height','borderRadius','boxSizing']);
    assert.equal(await actual.locator('#viewer-voices .lake-voice-wave').count(),state.presets.length+1); checks.push('viewer wave choices include default and actual saved voices');
    await actual.screenshot({path:path.join(output,'viewer-actual.png')}); await reference.locator('.dv').screenshot({path:path.join(output,'viewer-reference.png')});
    await actual.keyboard.press('Escape'); await actual.locator('[data-action="history.open"]').click(); await reference.goto(`${origin}/reference/03`);
    assert.equal(await actual.locator('#lake-deep').isVisible(),true);
    assert.equal(await actual.locator('#lake-history-dialog,#lake-history').count(),0);
    assert.equal(await actual.locator('#chat-feed .lake-history-entry').count(),state.live.events.length);
    const deepHorizon=await actual.locator('.lake-horizon').boundingBox(); assert.ok(Math.abs(deepHorizon.y-96)<1); checks.push('underwater shifts the horizon to source 96px and exposes retained real history');
    await actual.screenshot({path:path.join(output,'underwater-actual.png')}); await reference.locator('.dv').screenshot({path:path.join(output,'underwater-reference.png')});
    assert.deepEqual(errors,[]); assert.deepEqual(await hashes(),initialHashes,'rerun parity after production assets stop changing');
    await fs.writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,evidence:'Headless Edge production module against design.html static artboards; selected geometry/style assertions and paired screenshots, not a full-pixel or native/live acceptance claim.',checked_at:new Date().toISOString(),reference_sha256:referenceHashes,assets_sha256:initialHashes,checks,measurements,errors},null,2));
    console.log(`${checks.length} current-design parity checks passed`);
  } catch(error) {
    if(actual) await actual.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({passed:false,checks,measurements,errors,error:error.stack},null,2)); throw error;
  } finally { if(browser) await browser.close(); if(server) await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1});
