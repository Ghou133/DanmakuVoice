// Round-three visual acceptance uses production assets with isolated, fictional
// IPC responses. No external requests, real account, audio or OBS is exercised.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deflateSync, inflateSync } = require('node:zlib');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../crates/desktop/ui');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/lake-round3'));
const checks = [], screenshots = [], measurements = [], calls = [], errors = [];
const dimensions = [{ width: 780, height: 580 }, { width: 900, height: 640 }, { width: 1040, height: 740 }];
const auditedAssets = ['app.js', 'index.html', 'helpers.mjs', 'i18n-en.mjs', 'lake-scene.mjs', 'styles.css', 'lake.css', 'lake-drawers.css', 'lake-redesign-main.css', 'lake-redesign-settings.css', 'lake-redesign-voices.css', 'lake-redesign-obs.css'];
const hashes = async () => Object.fromEntries(await Promise.all(auditedAssets.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
const check = name => { checks.push(name); console.log(`ok ${name}`); };

// Tiny PNG codec keeps screenshot sampling dependency-free. Screenshots from
// Edge are 8-bit RGB/RGBA; all five PNG row filters are decoded explicitly.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function png(width, height, pixel) {
  const chunk = (name, bytes) => { const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scan = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(scan, y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
function decodePng(buffer) {
  let width, height, channels; const chunks = [];
  for (let cursor = 8; cursor < buffer.length;) {
    const length = buffer.readUInt32BE(cursor), name = buffer.toString('ascii', cursor + 4, cursor + 8), data = buffer.subarray(cursor + 8, cursor + 8 + length);
    if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.ok([2, 6].includes(data[9])); channels = data[9] === 6 ? 4 : 3; assert.equal(data[12], 0); }
    if (name === 'IDAT') chunks.push(data);
    cursor += length + 12;
  }
  const scan = inflateSync(Buffer.concat(chunks)), stride = width * channels, decoded = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const type = scan[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? decoded[y * stride + x - channels] : 0, above = y ? decoded[(y - 1) * stride + x] : 0, corner = y && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0;
      const p = left + above - corner, pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - corner);
      const filters = [0, left, above, Math.floor((left + above) / 2), pa <= pb && pa <= pc ? left : pb <= pc ? above : corner];
      assert.ok(type <= 4); decoded[y * stride + x] = (scan[y * (stride + 1) + 1 + x] + filters[type]) & 255;
    }
  }
  return { width, height, pixel: (x, y) => [...decoded.subarray(Math.floor(y) * stride + Math.floor(x) * channels, Math.floor(y) * stride + Math.floor(x) * channels + 3)] };
}
const avatarUrl = 'https://i0.hdslb.com/bfs/face/fictional-lake-round3.png';
const avatar = png(64, 64, (x, y) => x > 18 && x < 46 && y > 16 && y < 49 ? [238, 188, 122] : [112, 87, 157]);
const emoteUrl = 'https://i0.hdslb.com/bfs/emote/fictional-lake-round3.png';
const emote = png(64, 64, (x, y) => {
  if ((x - 32) ** 2 + (y - 32) ** 2 > 28 ** 2) return [120, 172, 202];
  if (y >= 23 && y <= 29 && (x >= 19 && x <= 24 || x >= 40 && x <= 45) || y >= 40 && y <= 44 && x >= 23 && x <= 41) return [57, 43, 76];
  return [245, 212, 133];
});
const qrImage = png(116, 116, (x, y) => {
  const a = Math.floor(x / 4) - 4, b = Math.floor(y / 4) - 4;
  if (a < 0 || b < 0 || a > 20 || b > 20) return [255, 255, 255];
  for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]]) if (a >= ox && a <= ox + 6 && b >= oy && b <= oy + 6) { const dx = a - ox, dy = b - oy; return (dx === 0 || dx === 6 || dy === 0 || dy === 6 || dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) ? [24, 20, 32] : [255, 255, 255]; }
  return (a * 7 + b * 11 + a * b) % 3 === 0 ? [24, 20, 32] : [255, 255, 255];
}).toString('base64');
const event = number => ({ platform_event_id: `fictional-round3-${number}`, room_id: 999, observed_at_ms: Date.now() - (9 - number) * 60000, kind: 'danmaku', user_id: 501, user_name: '虚构观众', message: `湖边的第${number}句问候`, avatar_url: avatarUrl });
const state = {
  config_revision: 1, onboarding_done: true, network_disabled: false, app_version: '0.3.2',
  preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: .72, muted: false, tts_enabled: true, broadcast_console: true },
  setup: { room_id: 999, tts_enabled: true, mode: 'account', uid: 42 }, live_settings: { room_id: 999, gift_merge: { enabled: false } },
  live: { running: true, state: 'connected', room_id: 999, received: 8, events: Array.from({ length: 8 }, (_, i) => event(i + 1)), audience: { active: true, live_status: 1, loading: false, error: null, rank_count: 128, rank_count_text: '128', watched_count: 1024, updated_at_ms: Date.now(), users: [{ user_id: 501, user_name: '虚构观众', avatar_url: avatarUrl, rank: 1 }] } },
  queue: { current: null, pending: [], history: [] },
  rules: { default_preset_id: 'voice-a', preferred_presets: {}, user_words: [], events: {}, templates: {}, sounds: [], message_words: [], emote_words: [] },
  connections: [{ id: 'cloud', has_credential: true, settings: { provider: 'doubao' } }, { id: 'fish', has_credential: true, settings: { provider: 'fish_audio' } }],
  presets: [{ id: 'voice-a', name: '温柔桃子', provider: 'doubao', connection_id: 'cloud', voice_id: 'catalog-a', speed: 1, volume: 1 }, { id: 'voice-b', name: '晴天', provider: 'fish_audio', connection_id: 'fish', voice_id: 'f'.repeat(32), speed: 1, volume: 1 }],
  doubao_voices: [{ id: 'catalog-a', name: '温柔桃子' }, { id: 'catalog-b', name: '明亮晴天' }, { id: 'catalog-c', name: '沉稳声音' }],
  bindings: [], assets: [], devices: [], local_services: {}, account: { user_id: 42, name: '虚构主播' }, qr: { status: 'idle' }, status: {},
  broadcast: { room: { room_id: 999, title: '水月 · 湖边的夜晚', parent_area_id: 1, area_id: 10, live_status: 0, live_since: null }, areas: [{ id: 1, name: '娱乐', children: [{ id: 10, name: '视频唱见' }] }], busy: false, has_stream_key: false, face_image: null, last_session: null, session_active: false },
  obs: { settings: { enabled: false, host: '127.0.0.1', port: 4455 }, has_password: false, status: { state: 'idle' }, local: true },
  overlay: { settings: { enabled: false, title: 'Tonight' }, running: false, clients: [] },
  chat_send: { busy: false, error: null, account_id: 42, room_id: 999, message_limit: 20, emoticons: [] },
  moderation: { busy: false, user_id: null, room_id: null, can_moderate: false, can_blacklist: false, can_manage_admins: false, muted: null, blacklisted: null, is_admin: null, message: null },
};
let page, browser, server, testedAssets, failNextQr = false, broadcastFailure = '';
const snapshot = () => structuredClone(state);
const push = async () => { state.config_revision++; await page.evaluate(next => window.__round3Push(next), snapshot()); await page.waitForTimeout(80); };

// Background tabs can leave CSS entrance animations at their initial keyframe.
// This style is injected only into the browser fixture, never the shipped UI.
const finalAnimationStyle = `*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
  #lake-current .lake-letter,#lake-text-reflection .lake-letter{opacity:1!important;transform:none!important;filter:none!important}
  .step-enter,.setup-lake-drawer.entering{opacity:1!important;transform:none!important}`;
async function freeze() {
  await page.evaluate(css => { let style = document.querySelector('#round3-final-animation'); if (!style) { style = document.createElement('style'); style.id = 'round3-final-animation'; document.head.append(style); } style.textContent = css; document.querySelectorAll('svg').forEach(svg => svg.pauseAnimations?.()); }, finalAnimationStyle);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(50);
}
async function unfreeze() { await page.locator('#round3-final-animation').evaluateAll(nodes => nodes.forEach(node => node.remove())); }
async function capture(file, tasks, description, settle = true) {
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 12000 });
  if (settle) await freeze();
  const pixels = await page.screenshot({ path: path.join(output, file) });
  screenshots.push({ file, tasks, description, sha256: createHash('sha256').update(pixels).digest('hex'), viewport: page.viewportSize(), theme: await page.locator('html').getAttribute('data-theme'), frame: settle ? 'settled fixture' : 'actual production animation at measured time' });
}
async function openPage() { await page.goto(origin); await page.waitForFunction(() => typeof window.__round3Push === 'function'); await page.evaluate(() => window.__round3StopPoll()); await freeze(); }
async function theme(value) { state.preferences.appearance = value; await push(); await page.waitForFunction(value => document.documentElement.dataset.theme === value, value); }
async function inside(selector, label = selector) {
  const box = await page.locator(selector).boundingBox(), viewport = page.viewportSize();
  assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${label} must fit viewport: ${JSON.stringify(box)}`);
  return box;
}
async function visibleHistoryLabel(count, label) {
  await page.mouse.move(20, 200); await freeze();
  assert.equal(await page.locator('#lake-history-total').textContent(), String(count));
  assert.equal(await page.locator('#lake-history-label').textContent(), label);
  assert.equal(await page.locator('#lake-history-label').isVisible(), true, 'F5 the translated count label must actually be visible');
  const box = await inside('#lake-history-label', 'F5 visible history label');
  assert.ok(box.width > 0 && box.height > 0, 'F5 the history label has a nonzero rendered box');
  const rendered = await page.locator('.lake-history-open').evaluate(node => {
    let opacity = 1; for (let current = node; current; current = current.parentElement) opacity *= Number(getComputedStyle(current).opacity);
    return { text: node.innerText.replace(/\s+/g, ' ').trim(), opacity };
  });
  assert.equal(rendered.text, `${count} ${label} ↓`, 'F5 the complete number, translated label and arrow render together');
  assert.ok(rendered.opacity >= .99, 'F5 visible count evidence is taken outside the intentional water-hover fade');
  return { count, label, box, rendered };
}
async function separated(first, second, label, task = 'T7') {
  const a = await page.locator(first).boundingBox(), b = await page.locator(second).boundingBox();
  assert.ok(a && b, `${label}: both elements must be visible`);
  const overlaps = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > .5 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > .5;
  assert.equal(overlaps, false, `${label}: ${JSON.stringify({ a, b })}`);
  measurements.push({ task, label, viewport: page.viewportSize(), a, b });
}
async function orbHitTest() {
  const box = await inside('#lake-orb');
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#lake-orb')?.id, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.equal(hit, 'lake-orb', 'orb center must receive the click');
}
const luminance = rgb => rgb.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
async function contrast(selector, property, label) {
  await freeze();
  const target = page.locator(selector).first(); await target.waitFor({ state: 'visible' });
  const spec = await target.evaluate((node, property) => {
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    let opacity = 1; for (let parent = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    return { color: style[property], opacity, box: { x: box.x, y: box.y, width: box.width, height: box.height }, previous: node.getAttribute('style') };
  }, property);
  const rgba = spec.color.match(/[\d.]+/g).map(Number); assert.ok(rgba.length >= 3, `readable RGB color for ${label}`);
  await target.evaluate(node => node.style.setProperty('visibility', 'hidden', 'important'));
  const backdrop = decodePng(await page.screenshot());
  await target.evaluate((node, previous) => previous === null ? node.removeAttribute('style') : node.setAttribute('style', previous), spec.previous);
  const points = [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75]];
  const samples = points.map(([x, y]) => {
    const background = backdrop.pixel(spec.box.x + spec.box.width * x, spec.box.y + spec.box.height * y), alpha = (rgba[3] ?? 1) * spec.opacity;
    const foreground = rgba.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
    const foregroundL = luminance(foreground), backgroundL = luminance(background);
    return { background, foreground, ratio: (Math.max(foregroundL, backgroundL) + .05) / (Math.min(foregroundL, backgroundL) + .05) };
  });
  const minimum = Math.min(...samples.map(sample => sample.ratio));
  measurements.push({ task: 'T4', label, selector, property, color: spec.color, opacity: spec.opacity, minimum, samples, method: 'CSS ink composited over screenshot-sampled background at five positions with only this graphic temporarily hidden; ancestor opacity included' });
  assert.ok(minimum >= 3, `${label} contrast ${minimum.toFixed(3)}:1 must be >= 3:1`);
}
async function reflection(label, expectedSize) {
  const measured = await page.evaluate(() => {
    const source = document.querySelector('#lake-current .lake-message-text'), copy = document.querySelector('#lake-text-reflection');
    const original = source.getBoundingClientRect(), reflected = copy.getBoundingClientRect();
    const read = node => { const css = getComputedStyle(node); return { text: node.textContent, size: node.dataset.size, fontSize: css.fontSize, lineHeight: css.lineHeight, letterSpacing: css.letterSpacing, width: node.getBoundingClientRect().width }; };
    const letters = [...source.querySelectorAll('.lake-letter')], mirror = [...copy.querySelectorAll('.lake-letter')];
    const errors = letters.map((letter, index) => { const a = letter.getBoundingClientRect(), b = mirror[index].getBoundingClientRect(); return { letter: letter.textContent, x: Math.abs(a.x - b.x), y: Math.abs((a.y - original.y) - (reflected.bottom - b.bottom) / .78), width: Math.abs(a.width - b.width), height: Math.abs(a.height - b.height / .78), row: a.y }; });
    const images = [...source.querySelectorAll('.message-emote')], reflectedImages = [...copy.querySelectorAll('.message-emote')];
    const emotes = images.map((image, index) => {
      const mirror = reflectedImages[index], a = image.getBoundingClientRect(), b = mirror.getBoundingClientRect(), css = getComputedStyle(image), reflectedCss = getComputedStyle(mirror);
      return { label: image.getAttribute('aria-label'), large: image.classList.contains('large'), loaded: image.naturalWidth > 0 && mirror.naturalWidth > 0, sourceUrl: image.src, reflectionUrl: mirror.src,
        source: { width: a.width, height: a.height, cssWidth: css.width, cssHeight: css.height, verticalAlign: css.verticalAlign },
        reflection: { width: b.width, height: b.height / .78, cssWidth: reflectedCss.width, cssHeight: reflectedCss.height, verticalAlign: reflectedCss.verticalAlign },
        errors: { x: Math.abs(a.x - b.x), y: Math.abs((a.y - original.y) - (reflected.bottom - b.bottom) / .78), width: Math.abs(a.width - b.width), height: Math.abs(a.height - b.height / .78) } };
    });
    return { source: read(source), reflection: read(copy), errors, emotes, rows: new Set(errors.map(item => item.row.toFixed(2))).size };
  });
  assert.equal(measured.source.size, expectedSize); assert.deepEqual(measured.source, measured.reflection, `${label}: reflected typography must match source`);
  assert.ok(measured.errors.every(item => item.x <= .25 && item.y <= .25 && item.width <= .25 && item.height <= .25), `${label}: each reflected glyph must align before the intended vertical mirror: ${JSON.stringify(measured.errors)}`);
  for (const image of measured.emotes) {
    assert.ok(image.loaded); assert.equal(image.sourceUrl, image.reflectionUrl);
    assert.equal(image.source.cssWidth, image.reflection.cssWidth); assert.equal(image.source.cssHeight, image.reflection.cssHeight); assert.equal(image.source.verticalAlign, image.reflection.verticalAlign);
    assert.ok(Object.values(image.errors).every(error => error <= .25), `${label}: image position and actual size must mirror the caption: ${JSON.stringify(image)}`);
  }
  measurements.push({ task: 'T2', label, viewport: page.viewportSize(), ...measured });
  return measured;
}
async function longWordAcceptance() {
  // F8 measures every glyph even if an ancestor would clip it. Grouping the
  // actual glyph boxes by Y catches overflow that line/block boxes can hide.
  const overflow = [];
  const phrases = [['digits20', '6'.repeat(20)], ['digits30', '6'.repeat(30)], ['digits40', '6'.repeat(40)], ['letters31', 'h'.repeat(31)]];
  await theme('dark'); state.broadcast.room.live_status = 1;
  for (const size of [dimensions[0], dimensions[2]]) {
    await page.setViewportSize(size);
    for (const [name, message] of phrases) {
      state.live.events[state.live.events.length - 1] = { ...event(8), platform_event_id: `fictional-followup-f8-${name}-${size.width}`, observed_at_ms: Date.now(), message };
      await push(); await freeze();
      const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(message)].map(item => item.segment), widthUnits = graphemes.length * .55;
      const mirrored = await reflection(`F8-${name}-${size.width}`, widthUnits <= 16 ? 'normal' : widthUnits <= 26 ? 'medium' : 'small');
      const geometry = await page.evaluate(() => {
        const read = selector => {
          const node = document.querySelector(selector), box = node.getBoundingClientRect();
          const letters = [...node.querySelectorAll('.lake-letter')].map(letter => { const glyph = letter.getBoundingClientRect(), css = getComputedStyle(letter); return { text: letter.textContent, left: glyph.left, right: glyph.right, top: glyph.top, width: glyph.width, height: glyph.height, opacity: Number(css.opacity), visibility: css.visibility, delay: letter.style.getPropertyValue('--letter-delay') }; });
          const rows = [];
          for (const letter of letters) {
            let row = rows.find(item => Math.abs(item.top - letter.top) < .25);
            if (!row) { row = { top: letter.top, left: letter.left, right: letter.right, text: '' }; rows.push(row); }
            row.left = Math.min(row.left, letter.left); row.right = Math.max(row.right, letter.right); row.text += letter.text;
          }
          const words = [...node.querySelectorAll('.lake-word')].map(word => { const wordBox = word.getBoundingClientRect(), glyphs = [...word.querySelectorAll('.lake-letter')].map(letter => letter.getBoundingClientRect()); return { text: word.textContent, width: wordBox.width, naturalGlyphWidth: glyphs.reduce((sum, glyph) => sum + glyph.width, 0), rows: new Set(glyphs.map(glyph => glyph.top.toFixed(2))).size }; });
          return { box: { left: box.left, right: box.right, width: box.width }, letters, rows, words };
        };
        return { source: read('#lake-current .lake-message-text'), mirror: read('#lake-text-reflection') };
      });
      for (const [copy, measured] of Object.entries(geometry)) {
        assert.deepEqual(measured.letters.map(letter => letter.text), graphemes, `F8 ${copy} preserves all original graphemes`);
        assert.equal(measured.words.length, 1); assert.equal(measured.words[0].text, message);
        for (const [index, letter] of measured.letters.entries()) {
          assert.ok(letter.width > 0 && letter.height > 0 && letter.opacity === 1 && letter.visibility === 'visible', 'F8 no glyph is removed or individually hidden to avoid overflow');
          assert.equal(letter.delay, `${index * 160}ms`, 'F8 reveal order still advances for every original grapheme');
          if (letter.right > measured.box.right + .25 || letter.left < measured.box.left - .25) overflow.push({ name, viewport: size, copy, kind: 'glyph', index, text: letter.text, left: letter.left, right: letter.right, box: measured.box });
        }
        for (const [index, row] of measured.rows.entries()) if (row.right > measured.box.right + .25 || row.left < measured.box.left - .25) overflow.push({ name, viewport: size, copy, kind: 'visible row', index, ...row, box: measured.box });
        const word = measured.words[0];
        if (word.naturalGlyphWidth <= measured.box.width + .25) assert.equal(word.rows, 1, `F8 ${name} fits at its actual ${word.naturalGlyphWidth}px width and must remain whole`);
        else if (word.rows < 2) overflow.push({ name, viewport: size, copy, kind: 'overwide word did not wrap', word, box: measured.box });
        if (name === 'digits20') { assert.ok(word.naturalGlyphWidth <= measured.box.width + .25, 'F8 the 20-digit control demonstrably fits inside the actual body width'); assert.equal(word.rows, 1, 'F8 the fitting 20-digit control remains one intact word'); }
      }
      if (name === 'digits40') await capture(`F8-text-digits40-${size.width}x${size.height}.png`, ['F8'], 'Forty digits wrap only within their oversized word; every original glyph and reflected position is measured');
      await page.emulateMedia({ reducedMotion: 'no-preference' }); await unfreeze();
      const reveal = await page.evaluate(() => {
        const read = selector => [...document.querySelectorAll(selector + ' .lake-letter')].map(letter => {
          const animation = letter.getAnimations().find(item => item.effect?.target === letter);
          if (!animation) return { missing: true, text: letter.textContent };
          animation.pause(); animation.currentTime = 640;
          const timing = animation.effect.getTiming(); return { delay: timing.delay, duration: timing.duration, opacity: Number(getComputedStyle(letter).opacity) };
        });
        return { time: 640, source: read('#lake-current .lake-message-text'), mirror: read('#lake-text-reflection') };
      });
      for (const [index, letter] of reveal.source.entries()) {
        assert.equal(letter.missing, undefined); assert.equal(reveal.mirror[index].missing, undefined);
        assert.equal(letter.delay, index * 160); assert.equal(letter.duration, 900);
        assert.equal(letter.delay, reveal.mirror[index].delay); assert.equal(letter.duration, reveal.mirror[index].duration);
        assert.ok(Math.abs(letter.opacity - reveal.mirror[index].opacity) <= .01, 'F8 both copies reveal the same original grapheme together');
      }
      assert.ok(reveal.source[0].opacity > 0 && reveal.source.at(-1).opacity === 0, 'F8 the real reveal frame retains visible and not-yet-visible graphemes');
      await page.emulateMedia({ reducedMotion: 'reduce' }); await freeze();
      state.queue.current = { id: `fictional-followup-f8-${name}`, origin: 'live', user_name: state.live.events.at(-1).user_name, text: message };
      const progress = [];
      for (const ratio of [.25, .75]) {
        state.playback = { job_id: state.queue.current.id, played_ms: ratio * 4000, queued_ms: 4000 }; await push();
        const classes = await page.evaluate(() => ['#lake-current .lake-message-text', '#lake-text-reflection'].map(selector => [...document.querySelectorAll(selector + ' .lake-letter')].map(letter => letter.classList.contains('lake-unread'))));
        assert.deepEqual(classes[0], classes[1]); assert.deepEqual(classes[0], graphemes.map((_, index) => index >= Math.ceil(graphemes.length * ratio)), 'F8 playback progress still counts every original grapheme');
        progress.push({ ratio, unread: classes[0] });
      }
      measurements.push({ task: 'F8', name, message, widthUnits, viewport: size, actualSize: mirrored.source.size, actualRows: mirrored.rows, geometry, reveal, progress });
      console.log(`F8 ${name} ${size.width}x${size.height}: natural=${geometry.source.words[0].naturalGlyphWidth.toFixed(3)}px body=${geometry.source.box.width.toFixed(3)}px rows=${geometry.source.rows.length} maxRight=${Math.max(...geometry.source.letters.map(letter => letter.right)).toFixed(3)}px bodyRight=${geometry.source.box.right.toFixed(3)}px`);
      state.queue.current = null; delete state.playback; await push();
    }
  }
  measurements.push({ task: 'F8', scenario: 'Per-glyph and visible-row bounds across all eight cases', overflow });
  assert.deepEqual(overflow, [], 'F8 every original glyph and visible row must fit the body; clipping is not a passing substitute for wrapping');
  check('F8 eight long-word views wrap only oversized words, preserve fitting words, and retain every glyph, reveal, reading progress and mirrored position');
}
async function moon() {
  return page.evaluate(() => Object.fromEntries(['#lake-orb', '.lake-reflection'].map(selector => {
    const css = getComputedStyle(document.querySelector(selector));
    const brightness = Number(css.filter.match(/brightness\(([\d.]+)\)/)?.[1] || 1);
    return [selector, { opacity: Number(css.opacity), filter: css.filter, brightness, strength: Number(css.opacity) * brightness, transitionProperty: css.transitionProperty, transitionDuration: css.transitionDuration }];
  })));
}
async function setupSceneGeometry() {
  return page.evaluate(() => {
    const read = selector => {
      const node = document.querySelector(selector), box = node.getBoundingClientRect(), css = getComputedStyle(node);
      const geometryAnimations = node.getAnimations().filter(animation => animation.effect?.getKeyframes().some(frame => ['left', 'top', 'width', 'height'].some(key => key in frame))).map(animation => ({ type: animation.constructor.name, property: animation.transitionProperty, animationName: animation.animationName, duration: animation.effect.getTiming().duration, playState: animation.playState, currentTime: animation.currentTime, pseudoElement: animation.effect.pseudoElement, frames: animation.effect.getKeyframes() }));
      return { x: box.x, y: box.y, width: box.width, height: box.height, centerX: box.x + box.width / 2, transitionProperty: css.transitionProperty, geometryAnimations };
    };
    return { orb: read('#lake-orb'), reflection: read('#setup-shell .lake-reflection'), moving: document.querySelector('#setup-shell').classList.contains('setup-scene-moving') };
  });
}
async function pauseSetupScene() {
  // Pause only the test clock's JS cleanup timer. Geometry comes from the real
  // browser transitions, which are paused and sampled at their own currentTime.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  return page.evaluate(() => {
    const records = [];
    window.__round3SceneAnimations = [];
    for (const selector of ['#lake-orb', '#setup-shell .lake-reflection', '#setup-shell .lake-orb-tip', '#setup-shell .setup-lake-drawer']) {
      const node = document.querySelector(selector); if (!node) continue;
      for (const animation of node.getAnimations()) {
        const frames = animation.effect?.getKeyframes() || [];
        if (!frames.some(frame => ['left', 'top', 'width', 'height', 'transform'].some(key => key in frame))) continue;
        animation.pause(); window.__round3SceneAnimations.push(animation);
        const timing = animation.effect.getTiming(); records.push({ selector, duration: timing.duration, delay: timing.delay, properties: [...new Set(frames.flatMap(frame => Object.keys(frame)))], frames });
      }
    }
    return records;
  });
}
async function setupSceneFrame(time) {
  await page.evaluate(time => window.__round3SceneAnimations.forEach(animation => { animation.currentTime = time; }), time);
  const geometry = await setupSceneGeometry();
  assert.ok(Math.abs(geometry.orb.centerX - geometry.reflection.centerX) <= 1, `F2 moonlight stays underneath the moon at ${time}ms: ${JSON.stringify(geometry)}`);
  return { time, ...geometry };
}
async function finishSetupSceneClock() { await page.clock.runFor(750); await page.clock.resume(); }
let origin;
(async () => {
  await fs.mkdir(output, { recursive: true }); testedAssets = await hashes();
  server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
      let content = await fs.readFile(target).catch(() => fs.readFile(path.join(root, 'fonts', path.basename(target))));
      if (pathname === '/app.js') content = content.toString() + '\n// Isolated test-server instrumentation.\nwindow.__round3Push = acceptSnapshot; window.__round3RefreshBroadcast = () => refreshBroadcast(true); window.__round3StopPoll = () => { clearTimeout(snapshotTimer); boot.polling = false; };';
      response.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', executablePath: process.env.DV_BROWSER_PATH || undefined, headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: dimensions[2], reducedMotion: 'reduce', deviceScaleFactor: 1 });
    await context.route('**/*', route => [avatarUrl, emoteUrl].includes(route.request().url()) ? route.fulfill({ status: 200, contentType: 'image/png', body: route.request().url() === avatarUrl ? avatar : emote }) : route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); await page.clock.install();
    await page.exposeFunction('__round3Invoke', async (command, args) => {
      if (command === 'ui_activity') return true;
      if (command === 'snapshot') return snapshot();
      assert.equal(command, 'dispatch'); calls.push(structuredClone(args));
      const { action, payload } = args;
      if (action === 'preferences.save') { Object.assign(state.preferences, payload.preferences); state.config_revision++; }
      else if (action === 'bili.broadcast.refresh') { if (broadcastFailure) throw new Error(broadcastFailure); }
      else if (action === 'bili.broadcast.start') Object.assign(state.broadcast.room, { live_status: 1, live_since: Math.floor(Date.now() / 1000) - 1 });
      else if (action === 'bili.broadcast.stop') { Object.assign(state.broadcast.room, { live_status: 0, live_since: null }); state.broadcast.last_session = { started_at: 1792231200, observed_started_at: 1792231200, ended_observed_at: 1792239240, messages: 128, seconds: 8040, unique_viewers: 20 }; }
      else if (action === 'bili.moderation.refresh') state.moderation = { busy: false, user_id: payload.user_id, room_id: 999, can_moderate: true, can_blacklist: true, can_manage_admins: true, muted: false, blacklisted: false, is_admin: false, message: null };
      else if (action === 'bili.qr.begin' || action === 'doubao.qr.begin') {
        if (failNextQr) { failNextQr = false; throw new Error('Fictional QR generation failed [DV-X01]'); }
        state.qr = { provider: action === 'bili.qr.begin' ? 'bilibili' : 'doubao', status: 'scanned', image_data_url: `data:image/png;base64,${qrImage}` };
      }
      else if (action === 'onboarding.finish') { state.onboarding_done = true; state.setup.tts_enabled = payload.tts_enabled; }
      else if (!['bili.chat.emoticons.refresh', 'bili.broadcast.refresh', 'bili.qr.cancel', 'doubao.qr.cancel', 'bili.qr.poll', 'doubao.qr.poll', 'audition', 'audition.catalog', 'local_services.check', 'obs.refresh'].includes(action)) throw new Error(`Unexpected fixture action ${action}`);
      return snapshot();
    });
    await page.addInitScript(() => { window.__round3Listeners = {}; window.__TAURI__ = { core: { invoke: (command, args) => window.__round3Invoke(command, args) }, event: { listen: async (name, listener) => { window.__round3Listeners[name] = listener; return () => {}; } } }; });
    await openPage(); await page.locator('#live-shell').waitFor();

    // T1: edit geometry is measured independently of screenshot pixels.
    for (const appearance of ['dark', 'light']) {
      await theme(appearance);
      for (const size of dimensions) {
        await page.setViewportSize(size); await freeze();
        await page.locator('#lake-current [data-action="onair.info"]').click();
        const field = page.locator('#onair-panel .onair-input'), actions = page.locator('#onair-panel .onair-panel-foot');
        const a = await field.boundingBox(), b = await actions.boundingBox(), gap = b.x - a.x - a.width;
        assert.ok(gap >= 12 - .25, `T1 ${appearance} ${size.width}: input/action gap ${gap}px`);
        const styles = await field.evaluate(node => { const css = getComputedStyle(node), input = getComputedStyle(node.querySelector('input')), save = getComputedStyle(document.querySelector('#onair-panel .onair-save')); return { underline: css.borderBottomColor, after: getComputedStyle(node, '::after').backgroundImage, caret: input.caretColor, buttonBackground: save.backgroundColor, buttonImage: save.backgroundImage }; });
        const lilac = appearance === 'dark' ? 'rgb(200, 182, 240)' : 'rgb(106, 88, 176)';
        assert.equal(styles.underline, lilac); assert.equal(styles.caret, lilac); assert.equal(styles.buttonImage, 'none');
        assert.equal(styles.buttonBackground, appearance === 'dark' ? 'rgb(245, 242, 248)' : 'rgb(42, 35, 64)');
        measurements.push({ task: 'T1', appearance, viewport: size, gap, styles });
        await capture(`T1-title-edit-${appearance}-${size.width}.png`, ['T1'], 'Title edit: lilac underline/caret, solid primary action, minimum 12px separation');
        await page.locator('#onair-panel [data-action="onair.close"]').click();
      }
    }
    check('T1 title edit: 780/900/1040, night/day, >=12px gap and lilac/solid-primary styles');

    // T2: each actual grapheme is compared before the intentional Y mirror.
    await theme('dark'); state.broadcast.room.live_status = 1;
    const phrases = [['short', '湖边晚安', 'normal'], ['three-line-medium', '晚风吹过水面大家一起听听今天的故事', 'medium'], ['three-line-long', '微风经过湖边我们一起听着温柔的声音让每一句问候慢慢落在水面上', 'small']];
    for (const size of [dimensions[0], dimensions[2]]) {
      await page.setViewportSize(size);
      for (const [name, message, textSize] of phrases) {
        state.live.events.at(-1).message = message; await push(); await freeze();
        const measured = await reflection(`${name}-${size.width}`, textSize);
        assert.equal(measured.rows, name === 'short' ? 1 : 3, `${name} must show intended line count`);
        await capture(`T2-reflection-${name}-${size.width}x${size.height}.png`, ['T2'], `${textSize} text and reflection, ${measured.rows} line(s), glyph coordinates verified`);
      }
      for (const large of [false, true]) {
        const name = large ? 'large-emote' : 'normal-emote';
        state.live.events.at(-1).message = '晚风[湖]吹过湖面一起说声晚安'; state.live.events.at(-1).emotes = [{ text: '[湖]', url: emoteUrl, large }];
        await push(); await freeze();
        await page.waitForFunction(() => { const images = [...document.querySelectorAll('#lake-current .message-emote,#lake-text-reflection .message-emote')]; return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0); });
        const measured = await reflection(`${name}-${size.width}`, 'normal');
        assert.equal(measured.emotes.length, 1); assert.equal(measured.emotes[0].large, large);
        await capture(`T2-reflection-${name}-${size.width}x${size.height}.png`, ['T2'], `Mixed text and ${large ? 'large-flagged' : 'normal'} image: actual image dimensions, baseline and all glyph positions match the reflection`);
        delete state.live.events.at(-1).emotes;
      }
    }
    check('T2 all three text sizes and normal/large mixed emotes match reflection glyph/image geometry at 780x580 and 1040x740');

    // F1: preserve the exact text, including spaces, word boundaries and the
    // individual graphemes used by both the reveal and real playback progress.
    // F7 changes the size/row input from grapheme count to visual width. These
    // are explicit acceptance examples; the pure-CJK rows remain unchanged.
    const spacedPhrases = [
      { name: 'english', message: 'Good evening by the lake', widthUnits: 13.2, rows: ['Good evening', 'by the lake'], originalF1: true },
      { name: 'mixed-spaces', message: '主播 晚上好 Hello lake', widthUnits: 11.6, rows: ['主播 晚上好', 'Hello lake'], originalF1: true },
      { name: 'cjk', message: '微风经过湖边我们一起听着温柔的声音', widthUnits: 17, rows: ['微风经过湖边', '我们一起听着', '温柔的声音'], originalF1: true },
      { name: 'digits-ten', message: '6666666666 哈哈哈哈哈', widthUnits: 11.05, rows: ['6666666666', '哈哈哈哈哈'], atomicWords: ['6666666666'] },
      { name: 'digits-sixteen', message: '2333333333333333 笑死', widthUnits: 11.35, rows: ['2333333333333333', '笑死'], atomicWords: ['2333333333333333'] },
      { name: 'alphanumeric', message: 'AWSL2333 晚上好', widthUnits: 7.95, rows: ['AWSL2333 晚上好'], atomicWords: ['AWSL2333'] },
      { name: 'other-script', message: 'Привет друзья', widthUnits: 7.15, rows: ['Привет друзья'], atomicWords: ['Привет', 'друзья'] },
    ];
    const chineseHistoryLabel = await visibleHistoryLabel(8, '句沉在湖里');
    measurements.push({ task: 'F5', scenario: 'Chinese history label is visibly rendered', ...chineseHistoryLabel });
    for (const size of [dimensions[0], dimensions[2]]) {
      await page.setViewportSize(size);
      for (const phrase of spacedPhrases) {
        const { name, message, widthUnits } = phrase;
        state.live.events[state.live.events.length - 1] = { ...event(8), platform_event_id: `fictional-followup-${name}-${size.width}`, observed_at_ms: Date.now(), message };
        await push(); await freeze();
        const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(message)].map(item => item.segment);
        const mirrored = await reflection(`F1-F7-${name}-${size.width}`, widthUnits <= 16 ? 'normal' : widthUnits <= 26 ? 'medium' : 'small');
        assert.equal(mirrored.rows, widthUnits <= 8 ? 1 : widthUnits <= 16 ? 2 : 3, `F7 ${name}: rendered row count follows visual-width thresholds`);
        const textGeometry = await page.evaluate(() => {
          const read = selector => [...document.querySelectorAll(selector + ' .lake-letter')].map(letter => {
            const box = letter.getBoundingClientRect();
            return { text: letter.textContent, width: box.width, y: box.y, delay: letter.style.getPropertyValue('--letter-delay') };
          });
          const bodyWidth = document.querySelector('#lake-current .lake-message-text').getBoundingClientRect().width;
          return { source: read('#lake-current .lake-message-text'), mirror: read('#lake-text-reflection'), lines: [...document.querySelectorAll('#lake-current .lake-text-line')].map(line => line.textContent.trim()), bodyWidth, wordGroups: [...document.querySelectorAll('#lake-current .lake-word')].map(word => ({ text: word.textContent, width: word.getBoundingClientRect().width, naturalGlyphWidth: [...word.querySelectorAll('.lake-letter')].reduce((sum, letter) => sum + letter.getBoundingClientRect().width, 0), rows: [...new Set([...word.querySelectorAll('.lake-letter')].map(letter => letter.getBoundingClientRect().y))] })) };
        });
        assert.deepEqual(textGeometry.lines, phrase.rows, `F7 ${name}: exact accepted line balance`);
        assert.deepEqual(textGeometry.source.map(letter => letter.text), graphemes, 'F1 source preserves every original grapheme and space');
        assert.deepEqual(textGeometry.mirror.map(letter => letter.text), graphemes, 'F1 reflection preserves every original grapheme and space');
        for (const [index, letter] of textGeometry.source.entries()) {
          if (/^\s+$/u.test(letter.text)) assert.ok(letter.width > 0, 'F1 spaces have a real rendered width');
          assert.equal(letter.delay, `${index * 160}ms`, 'F1 reveal order still advances for every grapheme');
          assert.equal(letter.delay, textGeometry.mirror[index].delay, 'F1 mirror uses the same reveal delay');
        }
        for (const word of message.matchAll(/\p{Script=Latin}+/gu)) {
          const start = [...message.slice(0, word.index)].length, letters = textGeometry.source.slice(start, start + [...word[0]].length);
          assert.equal(new Set(letters.map(letter => letter.y)).size, 1, `F1 Latin word ${word[0]} must not split across lines`);
        }
        for (const word of phrase.atomicWords || []) {
          const start = [...message.slice(0, message.indexOf(word))].length, letters = textGeometry.source.slice(start, start + [...word].length);
          assert.equal(letters.map(letter => letter.text).join(''), word);
          assert.equal(new Set(letters.map(letter => letter.y)).size, 1, `F7 the complete non-CJK word ${word} stays on one line`);
        }
        for (const word of textGeometry.wordGroups) {
          assert.equal(word.rows.length, 1, 'F1 a word wrapper stays on one rendered row');
          assert.ok(word.naturalGlyphWidth <= textGeometry.bodyWidth + .25 && word.width <= textGeometry.bodyWidth + .25, 'F8 the existing fitting-word controls stay whole at their actual measured widths');
        }
        if (phrase.originalF1) await capture(`F1-text-${name}-${size.width}x${size.height}.png`, ['F1', 'F7', 'T2'], 'Exact spaces and intact words; visual-width line balance and every reflected glyph verified');
        if (['english', 'mixed-spaces'].includes(name)) await capture(`F7-text-${name === 'mixed-spaces' ? 'mixed' : name}-${size.width}x${size.height}.png`, ['F7'], `${widthUnits} visual-width units give normal text in exactly two balanced lines; original graphemes and reflection retained`);

        await page.emulateMedia({ reducedMotion: 'no-preference' }); await unfreeze();
        const reveal = await page.evaluate(() => {
          const read = selector => [...document.querySelectorAll(selector + ' .lake-letter')].map(letter => {
            const animation = letter.getAnimations().find(item => item.effect?.target === letter);
            if (!animation) return { missing: true, text: letter.textContent };
            animation.pause(); animation.currentTime = 640;
            const timing = animation.effect.getTiming();
            return { delay: timing.delay, duration: timing.duration, opacity: Number(getComputedStyle(letter).opacity) };
          });
          return { time: 640, source: read('#lake-current .lake-message-text'), mirror: read('#lake-text-reflection') };
        });
        for (const [index, letter] of reveal.source.entries()) {
          assert.equal(letter.missing, undefined, 'F1 every fresh source grapheme has a real reveal animation');
          assert.equal(reveal.mirror[index].missing, undefined, 'F1 every reflected grapheme has a real reveal animation');
          assert.equal(letter.delay, index * 160); assert.equal(letter.duration, 900);
          assert.equal(letter.delay, reveal.mirror[index].delay); assert.equal(letter.duration, reveal.mirror[index].duration);
          assert.ok(Math.abs(letter.opacity - reveal.mirror[index].opacity) <= .01, 'F1 source and reflection reveal the same grapheme at the same time');
        }
        assert.ok(reveal.source[0].opacity > 0 && reveal.source.at(-1).opacity === 0, 'F1 measured reveal frame has both visible and not-yet-visible graphemes');
        await page.emulateMedia({ reducedMotion: 'reduce' }); await freeze();
        state.queue.current = { id: `fictional-followup-${name}`, origin: 'live', user_name: state.live.events.at(-1).user_name, text: message };
        const progress = [];
        for (const ratio of [.25, .75]) {
          state.playback = { job_id: state.queue.current.id, played_ms: ratio * 4000, queued_ms: 4000 }; await push();
          const classes = await page.evaluate(() => ['#lake-current .lake-message-text', '#lake-text-reflection'].map(selector => [...document.querySelectorAll(selector + ' .lake-letter')].map(letter => letter.classList.contains('lake-unread'))));
          assert.deepEqual(classes[0], classes[1], 'F1 both copies share the real playback progress');
          assert.deepEqual(classes[0], graphemes.map((_, index) => index >= Math.ceil(graphemes.length * ratio)), 'F1 reading highlights each original grapheme at the measured playback fraction');
          progress.push({ ratio, unread: classes[0] });
        }
        measurements.push({ task: phrase.originalF1 ? 'F1' : 'F7', relatedTask: 'F7', name, message, widthUnits, expectedRows: phrase.rows, actualSize: mirrored.source.size, actualRows: mirrored.rows, viewport: size, geometry: textGeometry, reveal, progress });
        state.queue.current = null; delete state.playback; await push();
      }
    }
    check('F1 six EN/mixed/CJK views preserve spaces, intact words, sequential reveal, playback progress and mirrored glyphs');
    check('F7 visual widths produce exact balanced EN/mixed lines, unchanged CJK rows and intact numeric/alphanumeric/other-script words at both widths');
    await longWordAcceptance();

    // T3: normal-motion duration and reduced-motion bypass are both inspected.
    state.broadcast.room.live_status = 0; await push(); await page.locator('[data-action="lake.prepare"]').click();
    await page.setViewportSize(dimensions[2]); await page.emulateMedia({ reducedMotion: 'no-preference' }); await unfreeze();
    const readyMoon = await moon();
    for (const value of Object.values(readyMoon)) assert.ok(value.transitionDuration.split(',').some(duration => parseFloat(duration) >= .6 && parseFloat(duration) <= 1), 'moon and moonlight should transition for 0.6-1 seconds');
    await capture('T3-night-01-ready.png', ['T3'], 'Ready before the session');
    await page.locator('#onair [data-action="broadcast.start"]').click(); await page.locator('#onair [data-action="broadcast.stop"]').click();
    await unfreeze(); await page.waitForTimeout(1100); const endedMoon = await moon();
    for (const selector of Object.keys(readyMoon)) { const ratio = endedMoon[selector].strength / readyMoon[selector].strength; assert.ok(ratio >= .5 && ratio <= .7, `${selector} ended brightness ratio ${ratio}`); }
    await capture('T3-night-02-ended.png', ['T3'], 'Ended session with dimmed moon and moonlight');
    await page.locator('[data-action="lake.prepare"]').click(); await unfreeze(); await page.waitForTimeout(1100); const restoredMoon = await moon();
    for (const selector of Object.keys(readyMoon)) assert.equal(restoredMoon[selector].strength, readyMoon[selector].strength);
    await capture('T3-night-03-ready-again.png', ['T3'], 'Return to ready restores moon and moonlight');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await unfreeze(); const reducedMoon = await moon();
    for (const value of Object.values(reducedMoon)) assert.ok(value.transitionDuration.split(',').every(duration => parseFloat(duration) === 0), 'reduced motion disables moon transitions');
    measurements.push({ task: 'T3', readyMoon, endedMoon, restoredMoon, reducedMoon }); await freeze();
    check('T3 moon and moonlight dim to 50-70%, restore, transition for 0.6-1s and honor reduced motion');

    state.broadcast.room.live_status = 1; state.live.events.at(-1).message = '湖边晚安'; await push(); await theme('light');
    await page.locator('#tts-switch').click();
    await contrast('#tts-menu .lake-voice-wave.active .lake-voice-bars i', 'backgroundColor', 'voice-panel current voice bars');
    await capture('T4-voice-panel-day.png', ['T4'], 'Day voice panel, active bars contrast measured');
    await page.locator('#tts-switch').click();
    await page.locator('#lake-current [data-action="viewer.open"]').first().click();
    await contrast('#viewer-voices .lake-voice-wave.active .lake-voice-bars i', 'backgroundColor', 'viewer current voice bars');
    await capture('T4-viewer-day.png', ['T4'], 'Day viewer card, active voice bars contrast measured');
    await page.locator('[data-action="viewer.close"]').click({ position: { x: 10, y: 10 } });
    await page.locator('[data-action="settings.open"]').click(); await page.locator('#settings [data-action="settings.tab"][data-id="voices"]').click();
    if (await page.locator('.voice-service-dot:not(.off)').count()) await contrast('.voice-service-dot:not(.off)', 'backgroundColor', 'voice service connected dot');
    await page.locator('[data-action="voice.add"]').click();
    await contrast('.voice-tab-dot:not(.off)', 'backgroundColor', 'add voice connected service dot');
    await capture('T4-add-voice-day.png', ['T4'], 'Day add-voice page, connected service dot contrast measured');
    await page.locator('[data-action="settings.close"]').click();
    check('T4 day voice/viewer bars and connected-service dots meet 3:1 against rendered backgrounds');

    // F6 uses a fictional connected OBS snapshot only to reach the actual
    // advanced page; no OBS endpoint, reset action or credential is exercised.
    const originalObs = structuredClone(state.obs), originalOverlay = structuredClone(state.overlay);
    state.obs.status = { state: 'ok', obs_version: 'fictional', streaming: false };
    state.overlay.settings = { ...state.overlay.settings, style: 'spine', corner: 'top_left', offset_x: 0, offset_y: 0, scale: 1, tagline: '', vignette: .6, linger_seconds: 14, show_danmaku: true, show_gift: true, show_super_chat: true, show_guard: false, names: 'special', merge_duplicates: true, port: 47823 };
    await theme('dark'); await page.setViewportSize(dimensions[2]);
    await page.locator('[data-action="settings.open"]').click();
    if (!await page.locator('#settings [data-action="settings.tab"][data-id="overlay"]').count()) await page.locator('#settings [data-action="settings.tab"][data-id="home"]').click();
    await page.locator('#settings [data-action="settings.tab"][data-id="overlay"]').click();
    await page.locator('[data-obs-view="preview"]').waitFor();
    await page.locator('[data-action="lake.obs.advanced"]').click();
    await page.locator('[data-obs-view="advanced"]').waitFor(); await freeze();
    assert.equal(await page.locator('[data-action="overlay.token.reset"]').count(), 0, 'F6 the OBS advanced page exposes no token-reset action');
    assert.equal(await page.locator('.lake-obs-advanced-foot').count(), 0, 'F6 the former reset footer is removed completely');
    await page.locator('#settings .settings-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const advancedEnding = await page.locator('[data-obs-view="advanced"]').evaluate(node => {
      const last = node.lastElementChild, rootBox = node.getBoundingClientRect(), lastBox = last.getBoundingClientRect(), scroller = node.closest('.settings-content'), box = scroller.getBoundingClientRect(), css = getComputedStyle(node);
      return { lastTag: last.tagName, lastClass: last.className, finalForm: last.querySelector('form')?.dataset.form, children: [...node.children].map(child => ({ tag: child.tagName, className: child.className, text: child.textContent.trim() })), paddingBottom: parseFloat(css.paddingBottom), rootBottom: rootBox.bottom, lastBottom: lastBox.bottom, remainingMinHeightSpace: rootBox.bottom - lastBox.bottom, scrollerBottom: box.bottom, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
    });
    assert.equal(advancedEnding.lastTag, 'SECTION'); assert.equal(advancedEnding.finalForm, 'obs-link', 'F6 the page ends with the existing OBS link settings');
    assert.ok(advancedEnding.children.every(child => child.tag === 'SECTION' && child.text.length > 0), 'F6 no empty block remains after the settings sections');
    assert.equal(advancedEnding.paddingBottom, 0, 'F6 no footer padding remains on the advanced page');
    assert.ok(advancedEnding.lastBottom <= advancedEnding.scrollerBottom + 1, 'F6 the final settings row is visible at the natural scroll end');
    assert.equal(calls.filter(call => call.action === 'overlay.token.reset').length, 0);
    measurements.push({ task: 'F6', scenario: 'OBS advanced page ends with OBS link settings and no reset footer', viewport: page.viewportSize(), ...advancedEnding });
    await capture('F6-obs-advanced-night.png', ['F6'], 'Night OBS advanced page ends with broadcast linkage settings; the token-reset button and its entire footer are absent');
    await page.locator('[data-action="settings.close"]').click();
    state.obs = originalObs; state.overlay = originalOverlay; await push();
    check('F6 OBS advanced page has no token-reset control, footer or empty trailing block');

    // T7 and T10 keep intentional fading of older history; avatar filter itself
    // must agree with the viewer card instead of acquiring an extra dark filter.
    await theme('dark');
    for (const size of dimensions) {
      await page.setViewportSize(size); await freeze();
      const water = await page.locator('#lake-water-hover').boundingBox(); await page.mouse.move(water.x + 20, water.y + 20); await freeze();
      assert.equal(await page.locator('#lake-peek').evaluate(node => getComputedStyle(node).opacity), '1');
      await separated('#lake-peek', '.lake-foot', 'recent messages / voice and compose');
      state.status.error = '虚构离线连接错误：暂时无法连接直播间，请稍后再试。'; await push();
      await page.locator('#live-error').waitFor({ state: 'visible' });
      await separated('#live-error', '#lake-orb', 'live error / theme orb'); await orbHitTest();
      await capture(`T7-main-${size.width}x${size.height}.png`, ['T7'], 'Recent three, lower-right controls and connection error do not overlap the theme orb');
      delete state.status.error; await push();
    }
    check('T7 recent messages / lower-right controls and connection error / orb remain separate at all three sizes');
    await page.setViewportSize(dimensions[2]);
    const avatarValues = { dark: {}, light: {} };
    const avatarRecord = async (appearance, name, selector) => {
      await freeze(); await page.locator(selector + ' img').first().waitFor({ state: 'visible' });
      await page.locator(selector).first().scrollIntoViewIfNeeded();
      await page.locator(selector).first().evaluate(node => { if (node.closest('#chat-scroll')) node.scrollIntoView({ block: 'center', inline: 'nearest' }); });
      const value = await page.locator(selector).first().evaluate(node => {
        const photo = node.querySelector('img'), ancestors = [];
        for (let current = photo; current; current = current.parentElement) ancestors.push({ tag: current.tagName, id: current.id, className: current.className, opacity: Number(getComputedStyle(current).opacity) });
        const box = photo.getBoundingClientRect();
        const scroll = node.closest('#chat-scroll'), scrollBox = scroll?.getBoundingClientRect();
        return { filter: getComputedStyle(node).filter, photo: photo.getAttribute('src'), loaded: photo.naturalWidth > 0, ancestors, effectiveOpacity: ancestors.reduce((opacity, ancestor) => opacity * ancestor.opacity, 1), center: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, scrollMask: scroll ? { css: getComputedStyle(scroll).maskImage, top: scrollBox.top, height: scrollBox.height, firstStop: Number(getComputedStyle(scroll).maskImage.match(/([\d.]+)%/)?.[1]) / 100 } : null };
      });
      assert.ok(value.loaded); assert.equal(value.filter, 'none', 'F3 no extra night-only brightness filter');
      if (value.scrollMask) assert.ok(value.center.y >= value.scrollMask.top && value.center.y <= value.scrollMask.top + value.scrollMask.height * value.scrollMask.firstStop - 1, 'F3 pixel sample remains in the existing scroll mask\'s fully opaque region at the same row depth');
      const pixels = decodePng(await page.screenshot());
      value.centerPixel = pixels.pixel(value.center.x, value.center.y);
      const previous = await page.locator(selector).first().getAttribute('style');
      await page.locator(selector).first().evaluate(node => node.style.setProperty('visibility', 'hidden', 'important'));
      const backdrop = decodePng(await page.screenshot());
      await page.locator(selector).first().evaluate((node, style) => style === null ? node.removeAttribute('style') : node.setAttribute('style', style), previous);
      value.backgroundPixel = backdrop.pixel(value.center.x, value.center.y);
      value.sourcePixel = [238, 188, 122];
      value.expectedPixel = value.sourcePixel.map((channel, index) => channel * value.effectiveOpacity + value.backgroundPixel[index] * (1 - value.effectiveOpacity));
      value.pixelErrors = value.centerPixel.map((channel, index) => Math.abs(channel - value.expectedPixel[index]));
      assert.ok(value.pixelErrors.every(error => error <= 2), `F3 ${appearance}/${name}: avatar pixels equal the same unfiltered photo composited at its actual row depth: ${JSON.stringify(value)}`);
      avatarValues[appearance][name] = value;
    };
    for (const appearance of ['dark', 'light']) {
      await theme(appearance); await page.mouse.move(20, 200); await avatarRecord(appearance, 'surface', '#lake-current .avatar');
      if (appearance === 'dark') await capture('T10-avatar-surface-night.png', ['T10', 'F3'], 'Unfiltered fictional avatar at the surface depth');
      const water = await page.locator('#lake-water-hover').boundingBox(); await page.mouse.move(water.x + 20, water.y + 20);
      for (const [name, row] of [['peek', 1], ['peek-second', 2], ['peek-third', 3]]) await avatarRecord(appearance, name, `#lake-peek .lake-peek-entry:nth-child(${row}) .avatar`);
      if (appearance === 'dark') await capture('T10-avatar-peek-night.png', ['T10', 'F3'], 'The same unfiltered avatar fades together with each of the three rows');
      await page.locator('[data-action="history.open"]').click(); await page.mouse.move(20, 200);
      for (const [name, row] of [['history', 1], ['history-fourth', 4], ['history-seventh', 7]]) await avatarRecord(appearance, name, `#chat-feed .lake-history-entry:nth-child(${row}) .avatar`);
      if (appearance === 'dark') await capture('T10-avatar-history-night.png', ['T10', 'F3'], 'Older history rows fade as a whole, including their unfiltered avatar');
      await page.locator('[data-action="lake.surface"]').click(); await page.locator('#lake-current [data-action="viewer.open"]').first().click(); await page.mouse.move(20, 200);
      await avatarRecord(appearance, 'viewer', '.viewer-head .avatar');
      if (appearance === 'dark') await capture('T10-avatar-viewer-night.png', ['T10', 'F3'], 'Unfiltered reference photo in the viewer card');
      for (const value of Object.values(avatarValues[appearance])) {
        assert.equal(value.filter, avatarValues[appearance].viewer.filter); assert.equal(value.photo, avatarValues[appearance].viewer.photo);
      }
      const rows = avatarValues[appearance];
      assert.ok(rows.peek.effectiveOpacity > rows['peek-second'].effectiveOpacity && rows['peek-second'].effectiveOpacity > rows['peek-third'].effectiveOpacity, 'F3 recent rows, including avatars, fade with depth');
      assert.ok(rows.history.effectiveOpacity > rows['history-fourth'].effectiveOpacity && rows['history-fourth'].effectiveOpacity > rows['history-seventh'].effectiveOpacity, 'F3 older history rows, including avatars, fade with depth');
      await page.locator('[data-action="viewer.close"]').click({ position: { x: 10, y: 10 } });
    }
    for (const name of Object.keys(avatarValues.dark)) assert.equal(avatarValues.dark[name].effectiveOpacity, avatarValues.light[name].effectiveOpacity, `F3 ${name} uses the same row depth in both themes`);
    measurements.push({ task: 'F3', originalTask: 'T10', method: 'Actual row opacity is preserved. Center RGB is compared with the same source photo composited over its measured hidden-photo background at that depth; matching depths must use matching alpha in both themes.', avatars: avatarValues });
    check('T10/F3 unfiltered avatar pixels match their actual row depth and both themes retain the same decreasing row-opacity sequence');

    // T4/T7/T8: use the real onboarding transitions and real hit-testing.
    state.onboarding_done = false; state.setup = { tts_enabled: false }; state.account = null; state.qr = { status: 'idle' }; state.preferences.appearance = 'dark';
    await openPage(); await page.locator('[data-action="setup.start"]').waitFor();
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await unfreeze();
    const welcomeScene = await setupSceneGeometry();
    await page.locator('[data-action="setup.start"]').click();
    const enteringAnimations = await pauseSetupScene();
    for (const selector of ['#lake-orb', '#setup-shell .lake-reflection', '#setup-shell .setup-lake-drawer']) {
      const actual = enteringAnimations.filter(animation => animation.selector === selector);
      assert.ok(actual.length > 0, `F2 ${selector} has a real movement animation`);
      assert.ok(actual.every(animation => animation.duration >= 600 && animation.duration <= 800), `F2 ${selector} moves for 0.6-0.8s`);
    }
    const enteringFrames = [];
    for (const [name, time] of [['start', 0], ['middle', 350], ['end', 700]]) {
      const frame = await setupSceneFrame(time); enteringFrames.push(frame);
      assert.ok(frame.orb.transitionProperty.includes('opacity') && frame.orb.transitionProperty.includes('filter'), 'F2 original opacity/filter transitions remain present');
      await capture(`F2-setup-enter-${name}.png`, ['F2'], `Actual step-entry transitions sampled at ${time}ms; moon and moonlight move together`, false);
    }
    assert.ok(Math.abs(enteringFrames[0].orb.x - welcomeScene.orb.x) <= 1 && Math.abs(enteringFrames[0].orb.y - welcomeScene.orb.y) <= 1, 'F2 entry starts exactly at the previous welcome position');
    assert.ok(enteringFrames[1].orb.x < enteringFrames[0].orb.x - 2 && enteringFrames[1].orb.x > enteringFrames[2].orb.x + 2, 'F2 a real intermediate moon position lies between start and finish');
    await finishSetupSceneClock();
    await page.locator('[data-action="setup.back"]').click();
    const returningAnimations = await pauseSetupScene();
    assert.ok(returningAnimations.some(animation => animation.selector === '#lake-orb'), 'F2 returning also creates a real geometry transition');
    const returningFrames = [];
    for (const time of [0, 350, 700]) returningFrames.push(await setupSceneFrame(time));
    assert.ok(returningFrames[1].orb.x > returningFrames[0].orb.x + 2 && returningFrames[1].orb.x < returningFrames[2].orb.x - 2, 'F2 return moves in the reverse direction');
    assert.ok(Math.abs(returningFrames[2].orb.x - welcomeScene.orb.x) <= 1, 'F2 return ends at the welcome position');
    await capture('F2-setup-return-welcome.png', ['F2'], 'Actual reverse transition completes at the original welcome position', false);
    await finishSetupSceneClock();
    measurements.push({ task: 'F2 phase', phase: 'entry and reverse animation', welcomeScene, enteringAnimations, enteringFrames, returningAnimations, returningFrames });

    await page.locator('[data-action="setup.start"]').click(); await pauseSetupScene(); await setupSceneFrame(350);
    await page.setViewportSize(dimensions[0]);
    const resized = await setupSceneGeometry();
    measurements.push({ task: 'F2 phase', phase: 'resize after sampled middle frame', resized });
    assert.equal(resized.moving, false, 'F2 resize cancels the step-only geometry transition');
    assert.equal(resized.orb.geometryAnimations.length, 0); assert.equal(resized.reflection.geometryAnimations.length, 0);
    await page.clock.runFor(120);
    const resizedLater = await setupSceneGeometry();
    assert.deepEqual([resized.orb.x, resized.orb.y, resized.orb.width, resized.reflection.x], [resizedLater.orb.x, resizedLater.orb.y, resizedLater.orb.width, resizedLater.reflection.x], 'F2 resized geometry arrives immediately and does not trail');
    assert.ok(Math.abs(resized.orb.centerX - resized.reflection.centerX) <= 1);
    await page.clock.resume();
    // Also resize an unpaused transition, so cancellation is proven during
    // ordinary playback as well as the deterministic screenshot sampling path.
    await page.locator('[data-action="setup.back"]').click(); await page.waitForTimeout(750); await page.setViewportSize(dimensions[2]);
    await page.locator('[data-action="setup.start"]').click(); await page.waitForTimeout(100);
    const runningBeforeResize = await setupSceneGeometry();
    assert.equal(runningBeforeResize.moving, true); assert.ok(runningBeforeResize.orb.geometryAnimations.length > 0 && runningBeforeResize.reflection.geometryAnimations.length > 0);
    await page.setViewportSize(dimensions[0]);
    const runningResized = await setupSceneGeometry();
    measurements.push({ task: 'F2 phase', phase: 'resize during normal unpaused motion', runningBeforeResize, runningResized });
    assert.equal(runningResized.moving, false); assert.equal(runningResized.orb.geometryAnimations.length, 0); assert.equal(runningResized.reflection.geometryAnimations.length, 0);
    await page.waitForTimeout(120);
    const runningResizedLater = await setupSceneGeometry();
    assert.deepEqual([runningResized.orb.x, runningResized.orb.y, runningResized.orb.width, runningResized.reflection.x], [runningResizedLater.orb.x, runningResizedLater.orb.y, runningResizedLater.orb.width, runningResizedLater.reflection.x], 'F2 ordinary unpaused resize does not leave a trailing moonlight transition');
    assert.ok(Math.abs(runningResized.orb.centerX - runningResized.reflection.centerX) <= 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-action="setup.back"]').click();
    const reducedWelcome = await setupSceneGeometry();
    assert.equal(reducedWelcome.orb.geometryAnimations.length, 0); assert.equal(reducedWelcome.reflection.geometryAnimations.length, 0);
    await page.locator('[data-action="setup.start"]').click();
    const reducedEntered = await setupSceneGeometry();
    assert.equal(reducedEntered.orb.geometryAnimations.length, 0); assert.equal(reducedEntered.reflection.geometryAnimations.length, 0);
    await page.waitForTimeout(100);
    const reducedLater = await setupSceneGeometry();
    assert.deepEqual([reducedEntered.orb.x, reducedEntered.orb.y, reducedEntered.reflection.x], [reducedLater.orb.x, reducedLater.orb.y, reducedLater.reflection.x], 'F2 reduced motion arrives immediately without a delayed move');
    assert.ok(Math.abs(reducedEntered.orb.centerX - reducedEntered.reflection.centerX) <= 1);
    measurements.push({ task: 'F2', method: 'Only the test JS clock is paused to retain production timers; actual CSS transitions are paused and sampled at their native currentTime. No final-animation style is present during the four screenshots. Resize is also checked during ordinary unpaused motion.', welcomeScene, enteringAnimations, enteringFrames, returningAnimations, returningFrames, resized, resizedLater, runningBeforeResize, runningResized, runningResizedLater, reducedWelcome, reducedEntered, reducedLater });
    check('F2 actual 0/350/700ms entry and reverse movement keep moonlight aligned, preserve opacity/filter, and stop immediately for resize or reduced motion');
    await page.locator('[data-action="setup.back"]').click(); await page.setViewportSize(dimensions[2]); await freeze();
    const setupBothThemes = async (name, tasks) => {
      await theme('dark'); await orbHitTest(); await capture(`T8-setup-${name}-night.png`, tasks, `Onboarding ${name}: unobstructed moon`);
      await page.locator('#lake-orb').click(); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light'); await orbHitTest();
      await capture(`T8-setup-${name}-day.png`, tasks, `Onboarding ${name}: unobstructed sun; switched by real pointer click`);
    };
    await setupBothThemes('welcome', ['T8']); await page.locator('[data-action="setup.start"]').click(); await page.locator('[data-qr-provider="bilibili"]').waitFor();
    await setupBothThemes('01-login', ['T4', 'T8']);
    await page.setViewportSize(dimensions[0]); await freeze(); await page.locator('#lake-orb').focus(); await page.keyboard.press('Tab');
    const backFocus = await page.evaluate(() => {
      const button = document.activeElement, drawer = document.querySelector('.setup-lake-drawer'), css = getComputedStyle(button), box = button.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(button);
      return { action: button.dataset.action, width: box.width, contentWidth: range.getBoundingClientRect().width, drawerWidth: drawer.getBoundingClientRect().width, outlineWidth: css.outlineWidth, outlineColor: css.outlineColor, outlineStyle: css.outlineStyle };
    });
    assert.equal(backFocus.action, 'setup.back', 'F5 a real Tab key focuses the back button');
    assert.ok(backFocus.width <= backFocus.contentWidth + 12 && backFocus.width < backFocus.drawerWidth / 2, 'F5 back focus outline follows the button content');
    assert.equal(backFocus.outlineWidth, '1px'); assert.equal(backFocus.outlineColor, 'rgb(106, 88, 176)'); assert.notEqual(backFocus.outlineStyle, 'none');
    measurements.push({ task: 'F5', scenario: 'compact back-button keyboard focus', ...backFocus });
    await capture('F5-back-focus-780x580.png', ['F5', 'T8'], 'Real Tab focus follows the compact back-button content at the minimum viewport');
    check('F5 back-button focus is a content-width lilac outline at 780x580');
    assert.equal(await page.locator('.qr-retry').count(), 0, 'duplicate QR retry control removed');
    await contrast('.qr-status .status-dot.online', 'backgroundColor', 'setup scanned QR status dot');
    for (const size of dimensions) {
      await page.setViewportSize(size); await freeze();
      await page.locator('.setup-lake-drawer').evaluate(node => { node.scrollTop = 0; });
      const foot = await inside('.setup-qr-foot [data-action="qr.retry"]', 'QR refresh without scrolling');
      const drawer = await page.locator('.setup-lake-drawer').boundingBox();
      assert.ok(foot.y + foot.height <= drawer.y + drawer.height - 1, 'QR refresh lies inside the visible drawer');
      const clipped = await page.locator('.setup-qr-foot [data-action="qr.retry"]').evaluate(node => { const r = node.getBoundingClientRect(); return !node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
      assert.equal(clipped, false, 'QR refresh must be clickable before any scroll'); await orbHitTest();
      await capture(`T7-qr-${size.width}x${size.height}.png`, ['T7'], 'QR refresh visible and clickable at scrollTop 0; orb reachable');
    }
    check('T7 QR refresh remains visible without scrolling at 780x580, 900x640, 1040x740');
    for (const size of [{ width: 780, height: 641 }, { width: 900, height: 680 }, { width: 900, height: 700 }, { width: 1040, height: 720 }, { width: 780, height: 721 }]) {
      await page.setViewportSize(size); await freeze();
      await page.locator('.setup-lake-drawer').evaluate(node => { node.scrollTop = 0; });
      const geometry = await page.evaluate(() => {
        const drawer = document.querySelector('.setup-lake-drawer'), retry = document.querySelector('.setup-qr-foot [data-action="qr.retry"]'), frame = document.querySelector('.qr-frame');
        const d = drawer.getBoundingClientRect(), r = retry.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          drawer: { top: d.top, bottom: d.bottom, left: d.left, right: d.right, scrollTop: drawer.scrollTop, scrollHeight: drawer.scrollHeight, clientHeight: drawer.clientHeight },
          retry: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
          frameHeight: frame.getBoundingClientRect().height,
          hit: retry.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
        };
      });
      measurements.push({ task: 'T7', scenario: 'QR compact-layout breakpoint', ...geometry });
      assert.equal(geometry.drawer.scrollTop, 0, 'QR boundary check starts before scrolling');
      assert.ok(geometry.retry.top >= geometry.drawer.top + 1 && geometry.retry.bottom <= geometry.drawer.bottom - 1 && geometry.retry.left >= geometry.drawer.left + 1 && geometry.retry.right <= geometry.drawer.right - 1, `QR refresh fits the visible drawer at ${size.width}x${size.height}: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.retry.top >= 0 && geometry.retry.bottom <= size.height && geometry.retry.left >= 0 && geometry.retry.right <= size.width, 'QR refresh fits the viewport at each breakpoint sample');
      assert.equal(geometry.hit, true, 'QR refresh receives pointer input before scrolling at each breakpoint sample');
      await orbHitTest();
    }
    check('T7 QR refresh fits and receives pointer input before scrolling at 780x641, 900x680, 900x700, 1040x720, 780x721');
    await page.setViewportSize(dimensions[0]); await freeze();
    const qrRequests = () => calls.filter(call => call.action === 'bili.qr.begin').length;
    const qrRetry = page.locator('#setup-shell .setup-qr-foot [data-action="qr.retry"]');
    const qrBefore = await inside('#setup-shell .setup-qr-foot [data-action="qr.retry"]'), requestsBefore = qrRequests();
    failNextQr = true; await qrRetry.click();
    await page.waitForFunction(() => document.querySelector('.qr-frame')?.textContent.includes('暂时无法生成二维码'));
    assert.equal(qrRequests(), requestsBefore + 1, 'one retry click makes one generation request');
    assert.equal(await page.locator('#setup-shell [data-action="qr.retry"]').count(), 1, 'failed generation keeps one retry entry');
    assert.equal(await page.locator('.setup-lake-drawer').count(), 1, 'failed generation stays in the same drawer');
    const qrFailed = await inside('#setup-shell .setup-qr-foot [data-action="qr.retry"]');
    assert.ok(Math.abs(qrFailed.x - qrBefore.x) <= 1 && Math.abs(qrFailed.y - qrBefore.y) <= 1, 'failure must preserve the QR retry position');
    assert.equal(await page.locator('.setup-lake-drawer').evaluate(node => node.scrollTop), 0, 'failure must not scroll to reach retry');
    await capture('T8-qr-failure-780x580.png', ['T7', 'T8'], 'Failed QR generation retains the single refresh action at the same visible position');
    await qrRetry.click(); await page.locator('.qr-frame img').waitFor({ state: 'visible' });
    assert.equal(qrRequests(), requestsBefore + 2, 'recovery click makes exactly one new generation request');
    assert.equal(await page.locator('#setup-shell [data-action="qr.retry"]').count(), 1); assert.equal(await page.locator('.setup-lake-drawer').count(), 1);
    const qrRecovered = await inside('#setup-shell .setup-qr-foot [data-action="qr.retry"]');
    assert.ok(Math.abs(qrRecovered.x - qrBefore.x) <= 1 && Math.abs(qrRecovered.y - qrBefore.y) <= 1);
    measurements.push({ task: 'T8', scenario: 'QR generation failure and same-position recovery', requestsBefore, requestsAfter: qrRequests(), before: qrBefore, failed: qrFailed, recovered: qrRecovered });
    check('T8 failed QR generation retries once through the same visible action and drawer at the native minimum size');
    await page.setViewportSize(dimensions[2]);
    state.setup = { room_id: 999, uid: 42, mode: 'account', tts_enabled: false }; state.account = { user_id: 42, name: '虚构主播' }; await openPage(); await page.locator('[data-action="setup.silent"]').waitFor();
    await setupBothThemes('02-voices', ['T4', 'T8']);
    await contrast('.setup-steps .done i', 'color', 'setup completed-step tick');
    await contrast('.setup-choice-icon:not(.silent) .voice-wave i', 'backgroundColor', 'setup read-aloud waveform');
    await contrast('.setup-choice-icon.silent .voice-wave', 'borderTopColor', 'setup receive-only flat waveform');
    await page.locator('[data-action="setup.doubao"]').click(); await page.locator('[data-qr-provider="doubao"]').waitFor(); await setupBothThemes('02-doubao-qr', ['T8']);
    await page.locator('[data-action="setup.silent"]').click(); await page.locator('[data-action="setup.finish"]').waitFor();
    await setupBothThemes('03-ready', ['T4', 'T8']); await contrast('.setup-steps .done i', 'color', 'setup ready-step tick');
    assert.match(await page.locator('.setup-summary').textContent(), /暂时只看弹幕/);
    await page.locator('#lake-orb').focus(); await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => { const node = document.activeElement, css = getComputedStyle(node); return { tag: node.tagName, action: node.dataset.action, outlineColor: css.outlineColor, outlineWidth: css.outlineWidth, outlineStyle: css.outlineStyle }; });
    assert.equal(focus.outlineWidth, '1px'); assert.equal(focus.outlineColor, 'rgb(106, 88, 176)'); assert.notEqual(focus.outlineStyle, 'none');
    measurements.push({ task: 'T8', focus }); await capture('T8-keyboard-focus-day.png', ['T8'], 'Real Tab key focus: lilac 1px outline');
    check('T4/T8 all onboarding phases have clickable theme orbs, readable day glyphs, single QR retry and lilac keyboard focus');

    await page.locator('[data-action="setup.finish"]').click(); await page.locator('#live-shell').waitFor(); state.preferences.language = 'en'; state.live.events = [{ ...event(8), user_name: 'Sample viewer', message: 'Good evening by the lake' }]; state.account.name = 'Sample host'; state.presets[0].name = 'Peach'; state.presets[1].name = 'Sunny'; await push();
    await page.locator('#tts-switch').click();
    await page.locator('[data-action="voice.audition"][data-id="voice-a"]').click();
    const audition = calls.findLast(call => call.action === 'audition'); assert.ok(audition?.payload.text); assert.doesNotMatch(audition.payload.text, /[\u3400-\u9fff]/);
    assert.equal(await page.locator('#lake-pop-scrim').getAttribute('aria-label'), 'Dismiss');
    const singularHistoryLabel = await visibleHistoryLabel(1, 'message rests in the lake');
    await capture('T11-english-interface.png', ['T11', 'F5'], 'English UI and audition sample; one message uses the singular history label');
    check('T11 English screenshot, translated popover label and English audition request');
    const oneMessage = structuredClone(state.live.events);
    state.live.events.push({ ...event(9), user_name: 'Another viewer', message: 'Hello lake' }); await push();
    const pluralHistoryLabel = await visibleHistoryLabel(2, 'messages rest in the lake');
    state.live.events = oneMessage; await push();
    const singularRestored = await visibleHistoryLabel(1, 'message rests in the lake');
    measurements.push({ task: 'F5', scenario: 'Visible English history count', singularHistoryLabel, pluralHistoryLabel, singularRestored });
    check('F5 Chinese history label is visible and English visibly changes between one message and two messages');
    await page.locator('#tts-switch').click(); await page.setViewportSize(dimensions[0]);
    broadcastFailure = 'Fictional upstream timed out [DV-B04]'; state.broadcast.room = null; await push();
    await page.evaluate(() => window.__round3RefreshBroadcast()); await page.locator('#onair .onair-failure').waitFor({ state: 'visible' });
    const failureText = await page.locator('#onair .onair-failure').textContent(), failureTitle = await page.locator('#onair .onair-failure').getAttribute('title');
    assert.equal(failureText, 'Could not read broadcast status'); assert.match(failureTitle, /Fictional upstream timed out \[DV-B04\]/);
    await inside('#onair'); await inside('#onair .onair-failure'); await inside('#onair [data-action="broadcast.refresh"]');
    await separated('#onair .onair-copy', '#onair .onair-actions', 'English broadcast failure / retry', 'T6');
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth, reason: document.querySelector('#onair .onair-failure').scrollWidth - document.querySelector('#onair .onair-failure').clientWidth }));
    assert.ok(overflow.page <= 1 && overflow.reason <= 1, `English failed status must not overflow: ${JSON.stringify(overflow)}`);
    measurements.push({ task: 'T6', scenario: 'English read failure at 780x580', visibleText: failureText, title: failureTitle, overflow });
    await capture('T6-broadcast-failure-english-780x580.png', ['T6', 'T11'], 'English short failure reason, full title diagnostic, and existing retry fit the minimum width');
    check('T6 English broadcast read failure exposes the short reason and complete title without overlap or overflow at 780x580');
    assert.deepEqual(errors, [], 'production-page JavaScript errors'); assert.deepEqual(await hashes(), testedAssets, 'frontend must stay frozen throughout screenshot acceptance');
    const results = { passed: true, evidence: 'Offline Edge with production assets and isolated test-only IPC; no real account, broadcast, synthesis, audio or OBS acceptance', checks, screenshots, measurements, tested_assets_sha256: testedAssets, actions: calls };
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`${checks.length} round-three acceptance groups passed; ${screenshots.length} screenshots`);
  } catch (error) {
    const failure = `failure-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (page) await page.screenshot({ path: path.join(output, `${failure}.png`) }).catch(() => {});
    await fs.writeFile(path.join(output, `${failure}.json`), JSON.stringify({ checks, screenshots, measurements, errors, error: error.stack, calls, tested_assets_sha256: testedAssets }, null, 2));
    throw error;
  } finally { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
