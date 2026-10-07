// Exact production connection code plus a real HTML/native EventSource fixture.
// All data is fictional and all browser requests outside loopback are blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const before = process.argv.includes('--before');
const vmOnly = process.argv.includes('--vm-only');
const htmlArgument = process.argv.indexOf('--overlay-html');
const output = path.resolve(process.env.DV_TEST_OUTPUT || path.join(__dirname, '../target/obs-resume-fix/overlay-reconnect'));
const pagePath = htmlArgument >= 0 ? path.resolve(process.argv[htmlArgument + 1]) : path.resolve(__dirname, '../crates/desktop/overlay/overlay.html');
const fontRoot = path.resolve(__dirname, '../crates/desktop/ui/fonts');
const hash = value => createHash('sha256').update(value).digest('hex');
const results = [];
const check = (name, run) => {
  try { run(); results.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
};

function fixture(code, token = 'fictional-overlay-token') {
  let time = 0, serial = 0, maximumActive = 0;
  const timers = new Map(), events = new Map(), sources = [], trace = [];
  const timer = (fn, delay, interval = false) => { const id = ++serial; timers.set(id, { fn, at: time + delay, delay, interval }); return id; };
  const advance = amount => {
    const end = time + amount;
    for (let count = 0; ; count++) {
      if (count > 10000) throw new Error('timer loop did not settle');
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, value] = next; time = value.at;
      if (value.interval) value.at += value.delay; else timers.delete(id);
      value.fn();
    }
    time = end;
  };
  class Source {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) {
      this.url = url; this.readyState = Source.CONNECTING; this.listeners = new Map(); this.closes = 0;
      sources.push(this); maximumActive = Math.max(maximumActive, sources.filter(source => source.readyState !== Source.CLOSED).length);
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closes++; this.readyState = Source.CLOSED; }
    emit(name, value = {}) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
    error(state = Source.CLOSED) { this.readyState = state; this.onerror?.({}); }
  }
  const classes = new Set();
  const state = { status: { connection: 'stopped' }, config: {}, items: new Map(), tickets: new Map(), lastSeq: 0, instance: '' };
  const sandbox = {
    URLSearchParams, location: { search: token ? `?token=${token}` : '' }, innerWidth: 1920, innerHeight: 1080, EventSource: Source,
    now: () => time, performance: { now: () => time }, Date,
    state, ov: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    setTimeout: (fn, delay) => timer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, true), clearInterval: id => timers.delete(id),
    addEventListener: (name, fn) => events.set(name, fn), fit: () => {}, clock: () => {},
    refreshTagline: () => trace.push('tagline'), lingerMs: () => 30000,
    applyConfig: value => { state.config = value; trace.push('config'); },
    receive: value => { state.lastSeq = value.seq; trace.push('item'); },
    restoreItem: value => { state.lastSeq = value.seq; trace.push('item'); },
    retainsRows: () => state.config.style !== 'card',
    readingRecord: () => null, setSpot: () => trace.push('spot'),
    clearOverlay: () => trace.push('clear'),
    setReading: value => { state.reading = value; trace.push('reading'); }, remove: () => trace.push('clear'), dropTicket: () => trace.push('clear'),
  };
  vm.createContext(sandbox); vm.runInContext(code, sandbox, { filename: 'production-overlay-connection.js' });
  const hello = source => { source.readyState = Source.OPEN; source.emit('hello', { instance: 'fixture', heartbeat_ms: 15000, config: {}, status: { connection: 'connected' }, items: [], reading: null }); };
  return { sources, state, trace, classes, advance, hello, fire: (name, value = {}) => events.get(name)?.(value), active: () => sources.filter(source => source.readyState !== Source.CLOSED).length, maximumActive: () => maximumActive, time: () => time };
}

function vmChecks(code) {
  check('CLOSED errors rebuild once after backoff', () => {
    const f = fixture(code), old = f.sources[0]; old.error(); old.error(); f.advance(999); assert.equal(f.sources.length, 1);
    f.advance(1); assert.equal(f.sources.length, 2); assert.equal(f.maximumActive(), 1);
    old.error(); f.advance(999); assert.equal(f.sources.length, 2);
  });
  check('CONNECTING errors preserve native retry', () => {
    const f = fixture(code); f.sources[0].error(0); f.advance(120000); assert.equal(f.sources.length, 1);
    f.hello(f.sources[0]); assert.equal(f.classes.has('ready'), true);
  });
  check('a CLOSED source without an error callback is found by the watchdog', () => {
    const f = fixture(code); f.sources[0].readyState = 2; f.advance(5000);
    assert.equal(f.sources.length, 1); f.advance(1000); assert.equal(f.sources.length, 2);
  });
  check('repeated failures back off to a bounded 30 seconds', () => {
    const f = fixture(code);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = f.sources.length; f.sources.at(-1).error(); f.advance(delay - 1); assert.equal(f.sources.length, count);
      f.advance(1); assert.equal(f.sources.length, count + 1);
    }
    assert.equal(f.maximumActive(), 1);
    f.hello(f.sources.at(-1)); f.sources.at(-1).error(); const count = f.sources.length;
    f.advance(1000); assert.equal(f.sources.length, count + 1);
  });
  check('late callbacks from a replaced source cannot mutate or revoke the new source', () => {
    const f = fixture(code), old = f.sources[0]; f.hello(old); f.fire('resize'); f.advance(800);
    const fresh = f.sources.at(-1); assert.notEqual(fresh, old); f.hello(fresh);
    const length = f.trace.length;
    for (const name of ['hello', 'config', 'status', 'item', 'reading', 'clear', 'reset', 'heartbeat']) old.emit(name, { instance: 'stale', seq: 99, connection: 'stopped' });
    old.error(); assert.equal(f.trace.length, length); assert.equal(fresh.closes, 0); assert.equal(f.state.instance, 'fixture');
    f.advance(1000); assert.equal(f.sources.length, 2);
  });
  check('token reset cancels pending recovery and forbids resize or pageshow reconnect', () => {
    const f = fixture(code), old = f.sources[0]; f.hello(old); old.error(); old.emit('reset');
    f.fire('resize'); f.fire('pagehide'); f.fire('pageshow', { persisted: true }); f.advance(120000);
    assert.equal(f.sources.length, 1); assert.equal(f.active(), 0); assert.equal(f.classes.has('ready'), false);
  });
  check('page exit cancels retries and persisted return resumes once', () => {
    const f = fixture(code); f.sources[0].error(); f.fire('resize'); f.fire('pagehide'); f.advance(120000);
    assert.equal(f.sources.length, 1); assert.equal(f.active(), 0);
    f.fire('pageshow', { persisted: true }); assert.equal(f.sources.length, 2); assert.equal(f.active(), 1);
    f.fire('pageshow', { persisted: true }); assert.equal(f.sources.length, 2);
  });
  check('advertised heartbeats keep healthy OPEN connections alive and a stalled OPEN recovers', () => {
    const f = fixture(code); f.hello(f.sources[0]);
    for (let i = 0; i < 8; i++) { f.advance(15000); f.sources[0].emit('heartbeat'); }
    assert.equal(f.sources.length, 1); f.advance(45000); assert.equal(f.active(), 0);
    f.advance(1000); assert.equal(f.sources.length, 2); assert.equal(f.maximumActive(), 1);
  });
  check('OPEN without hello recovers while an old server without heartbeat capability stays quiet', () => {
    const stuck = fixture(code); stuck.sources[0].readyState = 1; stuck.advance(45000); stuck.advance(1000); assert.equal(stuck.sources.length, 2);
    const old = fixture(code); old.sources[0].readyState = 1;
    old.sources[0].emit('hello', { instance: 'old-server', config: {}, status: { connection: 'connected' }, items: [] });
    old.advance(120000); assert.equal(old.sources.length, 1);
  });
  check('all normal frames count as activity and tokenless resize cannot open a connection', () => {
    const f = fixture(code); f.hello(f.sources[0]);
    for (const name of ['config', 'status', 'item', 'reading', 'clear']) { f.advance(30000); f.sources[0].emit(name, { seq: 1 }); }
    assert.equal(f.sources.length, 1);
    const empty = fixture(code, ''); empty.fire('resize'); empty.advance(120000); assert.equal(empty.sources.length, 0);
  });
}

async function browserChecks(html) {
  const { chromium } = require('playwright');
  let accepting = false, requests = 0, browser;
  const responses = new Set(), intervals = new Set(), browserResults = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/overlay/events') {
      requests++;
      if (!accepting) return response.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      responses.add(response);
      const item = { seq: 1, at: Date.now(), kind: 'danmaku', viewer: 'fictional', name: '虚构观众', message: '断线恢复验证', job_id: null };
      response.write(`retry: 2000\n\nevent: hello\ndata: ${JSON.stringify({ instance: 'fictional-instance', heartbeat_ms: 15000, config: {}, status: { connection: 'connected', tts: false, words: 1 }, items: [item], reading: null })}\n\n`);
      const interval = setInterval(() => response.write('event: heartbeat\ndata: {}\n\n'), 300); intervals.add(interval);
      response.on('close', () => { responses.delete(response); clearInterval(interval); intervals.delete(interval); });
      return;
    }
    if (url.pathname.startsWith('/overlay/fonts/')) {
      try { return response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(await fs.readFile(path.join(fontRoot, path.basename(url.pathname)))); }
      catch { return response.writeHead(404).end(); }
    }
    if (url.pathname === '/overlay') return response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(html);
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ channel: process.env.DV_BROWSER_CHANNEL || 'msedge', executablePath: process.env.DV_BROWSER_PATH || undefined, headless: true, args: ['--disable-features=msWindowTabManagerPublic'] });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const Native = EventSource; window.__overlaySources = [];
      window.EventSource = class extends Native {
        constructor(url) { super(url); this.fixtureCloses = 0; window.__overlaySources.push(this); }
        close() { this.fixtureCloses++; return super.close(); }
      };
    });
    await page.goto(`${origin}/overlay?token=fictional-overlay-token`);
    await page.waitForFunction(() => window.__overlaySources[0]?.readyState === EventSource.CLOSED);
    accepting = true;
    if (before) {
      await page.waitForTimeout(1800);
      const sourceCount = await page.evaluate(() => window.__overlaySources.length);
      assert.equal(sourceCount, 1); assert.equal(requests, 1);
      browserResults.push({ name: 'native HTTP 204 CLOSED remains stranded after endpoint recovery', observedFailure: true, sourceCount, requests });
    } else {
      await page.waitForFunction(() => document.querySelector('#ov').classList.contains('ready'), { timeout: 8000 });
      await page.locator('.item .text').filter({ hasText: '断线恢复验证' }).waitFor();
      assert.equal(await page.evaluate(() => window.__overlaySources.length), 2);
      assert.equal(await page.evaluate(() => window.__overlaySources.filter(source => source.readyState !== EventSource.CLOSED).length), 1);
      browserResults.push({ name: 'native HTTP 204 CLOSED recovers and renders through the real HTML', passed: true, requests });
      const constructors = await page.evaluate(() => window.__overlaySources.length), previousRequests = requests;
      for (const response of responses) response.destroy();
      await page.waitForFunction(() => window.__overlaySources.at(-1).readyState === EventSource.CONNECTING);
      await page.waitForFunction(() => window.__overlaySources.at(-1).readyState === EventSource.OPEN);
      assert.equal(await page.evaluate(() => window.__overlaySources.length), constructors); assert.ok(requests > previousRequests);
      assert.equal(await page.evaluate(() => window.__overlaySources.filter(source => source.readyState !== EventSource.CLOSED).length), 1);
      assert.equal(await page.locator('.item').count(), 1);
      browserResults.push({ name: 'native EOF retry preserves the source and avoids duplicate replay items', passed: true });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForFunction(count => window.__overlaySources.length > count, constructors);
      await page.waitForFunction(() => window.__overlaySources.at(-1).readyState === EventSource.OPEN);
      await page.evaluate(() => window.__overlaySources[1].dispatchEvent(new MessageEvent('reset', { data: '{}' })));
      assert.equal(await page.evaluate(() => window.__overlaySources.at(-1).readyState), 1);
      assert.equal(await page.evaluate(() => window.__overlaySources.filter(source => source.readyState !== EventSource.CLOSED).length), 1);
      browserResults.push({ name: 'queued reset from the replaced native source cannot close the resized connection', passed: true });
      const count = await page.evaluate(() => window.__overlaySources.length), requestCount = requests;
      for (const response of responses) response.write('event: reset\ndata: {}\n\n');
      await page.waitForFunction(() => !document.querySelector('#ov').classList.contains('ready'));
      await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(1800);
      assert.equal(await page.evaluate(() => window.__overlaySources.length), count); assert.equal(requests, requestCount);
      browserResults.push({ name: 'real reset stops native source and resize cannot reconnect a revoked token', passed: true });
    }
    assert.deepEqual(errors, []);
    return browserResults;
  } finally {
    await browser?.close(); for (const interval of intervals) clearInterval(interval); for (const response of responses) response.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const html = await fs.readFile(pagePath, 'utf8');
  const connection = html.slice(html.indexOf('// ---------------------------------------------------------------- connection'), html.indexOf('</script>', html.indexOf('// ---------------------------------------------------------------- connection')));
  assert.ok(connection.startsWith('// ---------------------------------------------------------------- connection'));
  if (before) await fs.writeFile(path.join(output, 'before-overlay.html'), html);
  vmChecks(connection);
  const report = { phase: before ? 'before' : 'after', fictionalData: true, externalNetwork: false, nativeOBS: false, pageSha256: hash(html), connectionSha256: hash(connection), vm: results, browser: [] };
  let browserFailure;
  if (!vmOnly) try { report.browser = await browserChecks(html); } catch (error) { browserFailure = error; report.browserError = error.stack; }
  await fs.writeFile(path.join(output, `${report.phase}${vmOnly ? '-vm' : ''}.json`), JSON.stringify(report, null, 2));
  if (browserFailure) throw browserFailure;
  if (before) {
    for (const name of ['CLOSED errors rebuild once after backoff', 'token reset cancels pending recovery and forbids resize or pageshow reconnect', 'late callbacks from a replaced source cannot mutate or revoke the new source']) assert.equal(results.find(result => result.name === name).passed, false, `baseline must reproduce ${name}`);
    console.log('before failures preserved');
  } else assert.equal(results.every(result => result.passed), true, 'connection regression failed');
})().catch(error => { console.error(error); process.exitCode = 1; });
