// Offline rendering regression only: no native app, credentials or TTS requests.
// The served test copy exposes snapshot delivery and pauses folding animations;
// production files and production IPC remain untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `${name} requires a path`);
  return process.argv[index + 1];
}
const uiRoot = path.resolve(argument('--ui-root', path.join(__dirname, '../crates/desktop/ui')));
const output = path.resolve(argument('--output', path.join(__dirname, '../dist/spotlight-transition-tests')));
const scenarios = [];
const errors = [];
const calls = [];
const emoteUrl = 'https://i0.hdslb.com/bfs/emote/offline-transition-test.png';
const pixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrVsAAAAASUVORK5CYII=', 'base64');

function event(id, user, message, extra = {}) {
  return {
    room_id: 123, platform_event_id: `transition-${id}`, observed_at_ms: 1_795_000_000_000 + id * 1000,
    kind: 'danmaku', user_id: user, user_name: `观众${user}`, message,
    gift_name: '', quantity: 1, price_yuan: 0, guard_name: '', ...extra,
  };
}

const keyFor = line => `${JSON.stringify([line.room_id, line.platform_event_id])}:0`;
const jobFor = line => line ? { id: `job-${line.platform_event_id}`, origin: 'live', user_name: line.user_name, text: `${line.user_name}：${line.message}` } : null;

function snapshotFor(events, current) {
  return {
    config_revision: 1, onboarding_done: true, network_disabled: true,
    preferences: { language: 'zh-CN', appearance: 'dark', scale: 1, master_volume: 1, tts_enabled: true },
    setup: { room_id: 123, tts_enabled: true, mode: 'anonymous', uid: 42 },
    live_settings: { gift_merge: { enabled: false } },
    live: { running: true, state: 'connected', room_id: 123, events },
    queue: { current: jobFor(current), pending: [], history: [] },
    rules: { default_preset_id: 'offline-voice', preferred_presets: {}, user_words: [] },
    connections: [{ id: 'offline-service', name: '离线渲染夹具', settings: { provider: 'gpt_sovits' }, has_credential: false }],
    presets: [{ id: 'offline-voice', name: '离线渲染音色', connection_id: 'offline-service', provider: 'gpt_sovits', voice_id: 'offline', speed: 1, volume: 1 }],
    local_services: { gpt_sovits: { state: 'ready', owned: false } },
    bindings: [], assets: [], devices: [], account: null, qr: { status: 'idle' }, status: {},
  };
}

async function frame(page, key) {
  return page.evaluate(wanted => {
    const nodes = [...document.querySelectorAll('#chat-feed [data-key]')].filter(node => node.dataset.key === wanted);
    const line = nodes.find(node => node.classList.contains('run-line'));
    const article = line?.closest('article');
    const rect = node => {
      if (!node) return null;
      const value = node.getBoundingClientRect();
      return { top: value.top, left: value.left, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
    };
    const style = line ? getComputedStyle(line) : null;
    const surface = article?.querySelector('.spot-fold-surface');
    return {
      keyedCopies: nodes.length, ghostCount: document.querySelectorAll('.spot-ghost').length,
      afterglowCount: document.querySelectorAll('#chat-feed .afterglow').length,
      folding: !!article?.classList.contains('folding'),
      fontSize: style ? parseFloat(style.fontSize) : null,
      opacity: style ? parseFloat(style.opacity) : null,
      visibility: style?.visibility, display: style?.display,
      articleOpacity: article ? parseFloat(getComputedStyle(article).opacity) : null,
      line: rect(line), avatar: rect(article?.querySelector('.avatar')),
      name: rect(article?.querySelector('.run-user-name')), hit: rect(article?.querySelector('.chat-hit')),
      avatarCount: article?.querySelectorAll('.avatar').length ?? 0,
      surface: rect(surface), surfaceOpacity: surface ? parseFloat(getComputedStyle(surface).opacity) : null,
      emotes: line?.querySelectorAll('img').length ?? 0,
      foldAnimations: window.__foldAnimations.filter(record => record.target.isConnected && record.target.closest('.chat-run') === article).map(record => ({
        target: record.target.className, currentTime: record.animation.currentTime,
        duration: record.animation.effect.getTiming().duration, playState: record.animation.playState,
      })),
    };
  }, key);
}

function near(actual, expected, label, tolerance = 3) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} differs from ${expected}`);
}

function assertVisible(value, label) {
  assert.equal(value.keyedCopies, 1, `${label}: completed message was duplicated or disappeared`);
  assert.equal(value.ghostCount, 0, `${label}: cloned spotlight text is still present`);
  assert.equal(value.afterglowCount, 0, `${label}: opacity afterglow hides the completed row`);
  assert.equal(value.avatarCount, 1, `${label}: completed row has duplicate avatars`);
  assert.equal(value.visibility, 'visible', `${label}: completed text is hidden`);
  assert.notEqual(value.display, 'none', `${label}: completed text was removed from layout`);
  assert.ok(value.line?.width > 0 && value.line.height > 0, `${label}: completed text has no visible rectangle`);
  assert.ok(value.opacity >= 0.95, `${label}: completed text fades out`);
  assert.ok(value.articleOpacity >= 0.3, `${label}: completed row fades out`);
}

async function seekFold(page, key, fraction) {
  return page.evaluate(({ wanted, progress }) => {
    const line = [...document.querySelectorAll('#chat-feed .run-line')].find(node => node.dataset.key === wanted);
    const article = line?.closest('article');
    const records = window.__foldAnimations.filter(record => record.target.isConnected && record.target.closest('.chat-run') === article);
    const duration = Math.max(...records.map(record => Number(record.animation.effect.getTiming().duration)), 0);
    if (!records.length || !duration) throw new Error('No folding animations were created for ' + wanted);
    const elapsed = duration * progress;
    window.__transitionClock = window.__foldClockStart + elapsed;
    for (const record of records) record.animation.currentTime = Math.min(elapsed, Number(record.animation.effect.getTiming().duration));
    return duration;
  }, { wanted: key, progress: fraction });
}

async function finishFold(page, key) {
  await page.evaluate(async wanted => {
    const line = [...document.querySelectorAll('#chat-feed .run-line')].find(node => node.dataset.key === wanted);
    const article = line?.closest('article');
    const records = window.__foldAnimations.filter(record => record.target.isConnected && record.target.closest('.chat-run') === article);
    for (const record of records) record.animation.finish();
    await Promise.all(records.map(record => record.animation.finished.catch(() => {})));
    await Promise.resolve();
  }, key);
  await page.waitForFunction(wanted => {
    const line = [...document.querySelectorAll('#chat-feed .run-line')].find(node => node.dataset.key === wanted);
    return line && !line.closest('article').classList.contains('folding');
  }, key);
}

async function deliver(page, value, begin = false, freezeClock = true) {
  await page.evaluate(({ next, start, freeze }) => {
    if (freeze && window.__transitionClock === null) window.__transitionClock = performance.now();
    if (start) window.__foldClockStart = performance.now();
    window.__acceptOfflineSnapshot(next);
  }, { next: value, start: begin, freeze: freezeClock });
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const target = path.resolve(uiRoot, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(uiRoot + path.sep)) { response.writeHead(403).end(); return; }
      let content = await fs.readFile(target);
      if (path.basename(target) === 'app.js') content = Buffer.concat([content, Buffer.from('\n// Test server instrumentation only.\nglobalThis.__acceptOfflineSnapshot = acceptSnapshot;\nglobalThis.__stopOfflineSnapshotPoll = () => { clearTimeout(snapshotTimer); boot.polling = false; };\n')]);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(target)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const makePage = async (events, current, reducedMotion = 'no-preference', pauseFolds = true) => {
      const state = snapshotFor(events, current);
      const context = await browser.newContext({ viewport: { width: 1040, height: 740 }, reducedMotion });
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin + '/')) return route.continue();
        if (url === emoteUrl) return route.fulfill({ status: 200, contentType: 'image/png', body: pixelPng });
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('__offlineInvoke', async (command, args) => {
        calls.push(command === 'dispatch' ? args.action : command);
        if (command === 'ui_activity') return true;
        if (command === 'snapshot') return structuredClone(state);
        throw new Error('Unexpected offline action ' + command);
      });
      await page.addInitScript(options => {
        window.__offlineListeners = {};
        window.__TAURI__ = { core: { invoke: (command, args) => window.__offlineInvoke(command, args) }, event: { listen: async (name, listener) => { window.__offlineListeners[name] = listener; return () => {}; } } };
        window.__foldAnimations = [];
        window.__transitionClock = null;
        window.__foldClockStart = 0;
        const nativeNow = performance.now.bind(performance);
        performance.now = () => window.__transitionClock ?? nativeNow();
        const nativeAnimate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          const animation = nativeAnimate.apply(this, args);
          if (this.closest('.chat-run.folding')) {
            if (options.pauseFolds) {
              animation.pause();
              animation.currentTime = 0;
            }
            window.__foldAnimations.push({ target: this, animation });
          }
          return animation;
        };
      }, { pauseFolds });
      await page.goto(origin);
      await page.waitForFunction(() => typeof window.__acceptOfflineSnapshot === 'function' && document.querySelector('#chat-feed .chat-spot'));
      await page.waitForTimeout(reducedMotion === 'reduce' ? 30 : 710);
      // Delivering test snapshots is synchronous; the poller would restore the boot fixture.
      await page.evaluate(() => window.__stopOfflineSnapshotPoll());
      return { page, context };
    };

    const a = event(1, 101, '眼睛漂亮');
    const b = event(2, 102, '猫猫冲撞');
    for (const [name, events, next] of [['completed-to-next', [a, b], b], ['completed-to-idle', [a], null]]) {
      const { page, context } = await makePage(events, a);
      const source = await page.locator('.chat-spot').evaluate(node => {
        const rect = child => { const r = child.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; };
        return { line: rect(node.querySelector('.spot-text')), avatar: rect(node.querySelector('.avatar')), name: rect(node.querySelector('.spot-name')), hit: rect(node.querySelector('.chat-hit')) };
      });
      await deliver(page, snapshotFor(events, next), true);
      const start = await frame(page, keyFor(a));
      await fs.writeFile(path.join(output, name + '-geometry.json'), JSON.stringify({ source, start }, null, 2));
      assertVisible(start, name + ' frame 0');
      assert.equal(start.folding, true);
      near(start.fontSize, 22, name + ' initial text size', 0.2);
      for (const part of ['line', 'avatar', 'name']) {
        near(start[part].top, source[part].top, `${name} ${part} top continuity`);
        near(start[part].left, source[part].left, `${name} ${part} left continuity`);
      }
      assert.ok(start.surface, name + ': missing background fold surface');
      near(start.surface.width, source.hit.width, name + ' initial background width');
      near(start.surface.height, source.hit.height, name + ' initial background height');
      await page.screenshot({ path: path.join(output, name + '-start.png') });
      const duration = await seekFold(page, keyFor(a), 0.45);
      const middle = await frame(page, keyFor(a));
      assertVisible(middle, name + ' middle');
      assert.ok(middle.fontSize > 15 && middle.fontSize < 22, name + ': text does not interpolate its size');
      assert.ok(middle.surface.height < start.surface.height, name + ': card background does not shrink');
      await page.screenshot({ path: path.join(output, name + '-middle.png') });
      await seekFold(page, keyFor(a), 0.95);
      assertVisible(await frame(page, keyFor(a)), name + ' near end');
      await finishFold(page, keyFor(a));
      const end = await frame(page, keyFor(a));
      assertVisible(end, name + ' end');
      near(end.fontSize, 15, name + ' final text size', 0.05);
      assert.equal(end.surface, null);
      await page.screenshot({ path: path.join(output, name + '-end.png') });
      scenarios.push({ name, duration, start, middle, end });
      await context.close();
    }

    {
      const { page, context } = await makePage([a, b], a);
      await deliver(page, snapshotFor([a, b], b), true);
      const duration = await seekFold(page, keyFor(a), 0.42);
      const before = await frame(page, keyFor(a));
      const c = event(3, 103, '过渡期间新来的弹幕');
      await deliver(page, snapshotFor([a, b, c], b));
      const after = await frame(page, keyFor(a));
      assertVisible(after, 'new message during fold');
      near(after.fontSize, before.fontSize, 'fold progress survived feed rebuild', 0.1);
      assert.ok(after.foldAnimations.length > 0);
      assert.ok(after.foldAnimations.every(animation => animation.duration < duration * 0.65), 'fold restarted its full duration when a new message arrived');
      await finishFold(page, keyFor(a));
      assertVisible(await frame(page, keyFor(a)), 'rebuild end');
      scenarios.push({ name: 'new-message-keeps-fold-progress', before, after });
      await context.close();
    }

    {
      const same = [event(11, 111, '同一位观众第一句'), event(12, 111, '同一位观众第二句'), event(13, 111, '同一位观众第三句')];
      const { page, context } = await makePage(same, same[0]);
      const frames = [];
      for (let index = 0; index < same.length; index++) {
        await deliver(page, snapshotFor(same, same[index + 1] || null), true);
        const value = await frame(page, keyFor(same[index]));
        assertVisible(value, `same viewer line ${index + 1}`);
        near(value.fontSize, 22, 'same viewer initial size', 0.2);
        await seekFold(page, keyFor(same[index]), 0.5);
        assertVisible(await frame(page, keyFor(same[index])), 'same viewer middle');
        await finishFold(page, keyFor(same[index]));
        frames.push(await frame(page, keyFor(same[index])));
      }
      await deliver(page, snapshotFor(same, null));
      assert.equal(await page.locator('#chat-feed .chat-run').count(), 1, 'finished consecutive messages did not rejoin the normal viewer group');
      assert.equal(await page.locator('#chat-feed .run-line').count(), 3);
      scenarios.push({ name: 'consecutive-same-viewer-regroups', frames });
      await context.close();
    }

    {
      const history = Array.from({ length: 28 }, (_, index) => event(40 + index, 140 + index, `历史弹幕 ${index + 1}：向上浏览时保持所在位置。`));
      const current = history[12];
      const next = history[13];
      const { page, context } = await makePage(history, current);
      const before = await page.evaluate(() => {
        const scroll = document.querySelector('#chat-scroll');
        const spot = document.querySelector('.chat-spot');
        scroll.scrollTo({ top: scroll.scrollTop + spot.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 55, behavior: 'instant' });
        const text = spot.querySelector('.spot-text').getBoundingClientRect();
        return { scrollTop: scroll.scrollTop, distanceFromEnd: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight, textTop: text.top, textLeft: text.left };
      });
      assert.ok(before.distanceFromEnd > 120, 'history-scroll fixture is still pinned to the latest message');
      await deliver(page, snapshotFor(history, next), true);
      const start = await frame(page, keyFor(current));
      assertVisible(start, 'history scroll start');
      near(start.line.top, before.textTop, 'history scroll text top continuity');
      near(start.line.left, before.textLeft, 'history scroll text left continuity');
      near(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), before.scrollTop, 'history scroll offset preserved', 1);
      await seekFold(page, keyFor(current), 0.45);
      const middle = await frame(page, keyFor(current));
      assertVisible(middle, 'history scroll middle');
      const newLine = event(70, 170, '浏览历史期间到达的新弹幕');
      await deliver(page, snapshotFor([...history, newLine], next));
      const continued = await frame(page, keyFor(current));
      assertVisible(continued, 'history scroll new message');
      near(continued.fontSize, middle.fontSize, 'history scroll folding progress retained', 0.1);
      near(await page.locator('#chat-scroll').evaluate(node => node.scrollTop), before.scrollTop, 'new message preserved history scroll offset', 1);
      assert.equal(await page.locator('#new-messages').isVisible(), true, 'new-message affordance missing while history is being viewed');
      await finishFold(page, keyFor(current));
      await page.screenshot({ path: path.join(output, 'history-scroll-preserved.png') });
      scenarios.push({ name: 'history-scroll-preserved-during-fold-and-new-message', before, start, middle, continued });
      await context.close();
    }

    {
      const multiline = event(21, 121, '第一行弹幕[笑]\n第二行有换行与表情，长句需要自动折行。' + '保持完整文字和表情。'.repeat(5), { emotes: [{ text: '[笑]', url: emoteUrl }] });
      const { page, context } = await makePage([multiline], multiline);
      await deliver(page, snapshotFor([multiline], null), true);
      const start = await frame(page, keyFor(multiline));
      assertVisible(start, 'multiline start');
      assert.equal(start.emotes, 1, 'inline emote was lost while folding');
      assert.ok(start.line.height > 60, 'multiline text was clipped into a single line');
      await seekFold(page, keyFor(multiline), 0.5);
      const middle = await frame(page, keyFor(multiline));
      assertVisible(middle, 'multiline middle');
      assert.equal(middle.emotes, 1);
      await page.screenshot({ path: path.join(output, 'multiline-emote-middle.png') });
      await finishFold(page, keyFor(multiline));
      const end = await frame(page, keyFor(multiline));
      assertVisible(end, 'multiline end');
      assert.equal(end.emotes, 1);
      near(end.fontSize, 15, 'multiline final size', 0.05);
      scenarios.push({ name: 'multiline-and-inline-emote', start, middle, end });
      await context.close();
    }

    {
      const { page, context } = await makePage([a, b], a, 'reduce');
      await deliver(page, snapshotFor([a, b], b), true);
      const value = await frame(page, keyFor(a));
      assertVisible(value, 'reduced motion');
      assert.equal(value.folding, false);
      assert.equal(value.surface, null);
      assert.equal(value.foldAnimations.length, 0);
      near(value.fontSize, 15, 'reduced motion normal size', 0.05);
      scenarios.push({ name: 'reduced-motion-immediate-normal-row', frame: value });
      await context.close();
    }

    {
      const { page, context } = await makePage([a], a, 'no-preference', false);
      await deliver(page, snapshotFor([a], null), true, false);
      const start = await frame(page, keyFor(a));
      assertVisible(start, 'natural event loop start');
      assert.equal(start.folding, true);
      assert.ok(start.fontSize > 18 && start.fontSize <= 22);
      assert.ok(start.foldAnimations.every(animation => animation.playState === 'running'), 'natural case unexpectedly paused animations');
      await page.waitForTimeout(160);
      const middle = await frame(page, keyFor(a));
      assertVisible(middle, 'natural event loop middle');
      assert.ok(middle.fontSize > 15 && middle.fontSize < start.fontSize);
      await page.waitForFunction(wanted => {
        const line = [...document.querySelectorAll('#chat-feed .run-line')].find(node => node.dataset.key === wanted);
        return line && !line.closest('article').classList.contains('folding');
      }, keyFor(a));
      const elapsed = await page.evaluate(() => performance.now() - window.__foldClockStart);
      const end = await frame(page, keyFor(a));
      assertVisible(end, 'natural event loop end');
      near(end.fontSize, 15, 'natural event loop final size', 0.05);
      assert.equal(end.surface, null);
      assert.ok(elapsed >= 450 && elapsed < 1600, 'natural fold did not settle within its intended duration');
      assert.equal(await page.locator('#chat-feed .run-body, #chat-feed .run-name, #chat-feed .run-line').evaluateAll(nodes => nodes.some(node => node.style.height !== '')), false, 'natural fold left temporary fixed heights behind');
      await page.screenshot({ path: path.join(output, 'natural-event-loop-end.png') });
      scenarios.push({ name: 'natural-event-loop-animation-and-layout-settle', elapsed, start, middle, end });
      await context.close();
    }

    for (const interruption of ['reduced-motion-enabled-mid-fold', 'window-backgrounded-mid-fold']) {
      const { page, context } = await makePage([a, b], a);
      await deliver(page, snapshotFor([a, b], b), true);
      await seekFold(page, keyFor(a), 0.3);
      assertVisible(await frame(page, keyFor(a)), interruption + ' before');
      if (interruption.startsWith('reduced-motion')) await page.emulateMedia({ reducedMotion: 'reduce' });
      else await page.evaluate(() => window.__offlineListeners['resource-mode']({ payload: false }));
      await page.waitForFunction(wanted => {
        const line = [...document.querySelectorAll('#chat-feed .run-line')].find(node => node.dataset.key === wanted);
        return line && !line.closest('article').classList.contains('folding');
      }, keyFor(a));
      const end = await frame(page, keyFor(a));
      assertVisible(end, interruption + ' after');
      near(end.fontSize, 15, interruption + ' final size', 0.05);
      assert.equal(end.surface, null);
      assert.equal(end.foldAnimations.length, 0);
      scenarios.push({ name: interruption, frame: end });
      await context.close();
    }

    assert.deepEqual(errors, [], 'browser JavaScript errors');
    assert.equal(calls.some(call => !['snapshot', 'ui_activity'].includes(call)), false, 'fixture dispatched a real action');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, headless: true, browser: 'Microsoft Edge', nativeWebView2: false, realTts: false, externalNetwork: false, scenarios, errors, calls }, null, 2));
    console.log(`Spotlight transition browser regression passed: ${scenarios.length} cases, visible single message, text/avatar/name/background interpolation, continued progress, grouping, multiline/emotes and reduced motion.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
