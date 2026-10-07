// Verify the generated offline review itself in actual headless Edge.
// This checks existing evidence files; it does not rerun production UI parity.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');

const output = path.resolve(process.env.DV_PARITY_OUTPUT || path.join(__dirname, '../target/lake-parity'));
const checkedAt = new Date().toISOString();
const checks = [], errors = [], resourceErrors = [], images = new Map();
const check = (name, passed, detail) => checks.push({name, passed: !!passed, detail});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let browser, server, browserVersion, bindings, states;

(async () => {
  const reportBytes = await fs.readFile(path.join(output, 'parity-results.json'));
  const measuredBytes = await fs.readFile(path.join(output, 'reference-measurements.json'));
  const assetBytes = await fs.readFile(path.join(output, 'ui-assets-verification.json'));
  const reviewBytes = await fs.readFile(path.join(output, 'review.html'));
  const report = JSON.parse(reportBytes), measured = JSON.parse(measuredBytes);
  const sourceMotion = JSON.parse(await fs.readFile(path.join(output, 'animation-measurements.json'), 'utf8'));
  bindings = {
    output,
    'review.html': sha256(reviewBytes),
    'parity-results.json': sha256(reportBytes),
    'reference-measurements.json': sha256(measuredBytes),
    'ui-assets-verification.json': sha256(assetBytes),
  };
  states = Object.keys(measured.measurements);
  check('source review binds passing current parity and asset reports', report.passed && JSON.parse(assetBytes).passed, {output, parityGates: report.gates.length, assetCount: JSON.parse(assetBytes).assetCount});
  check('source evidence has exactly 38 unique states', states.length === 38 && new Set(states).size === 38, states);

  server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/favicon.ico') return response.writeHead(204).end();
      const name = pathname === '/' ? 'review.html' : pathname.slice(1);
      const target = path.resolve(output, name);
      if (!target.startsWith(output + path.sep)) return response.writeHead(403).end();
      const bytes = await fs.readFile(target);
      response.writeHead(200, {'Content-Type': name.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({channel: process.env.DV_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--disable-features=msWindowTabManagerPublic']});
  browserVersion = browser.version();
  const context = await browser.newContext({viewport: {width: 1500, height: 1000}});
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push({kind: 'pageerror', message: error.message}));
  page.on('console', message => { if (message.type() === 'error') errors.push({kind: 'console', message: message.text()}); });
  page.on('requestfailed', request => resourceErrors.push({url: request.url(), failure: request.failure()}));
  page.on('response', response => { if (response.status() >= 400) resourceErrors.push({url: response.url(), status: response.status()}); });
  page.setDefaultTimeout(10000);
  await page.goto(origin + '/review.html');
  await page.locator('#state option').last().waitFor({state: 'attached'});
  const actualStates = await page.locator('#state option').evaluateAll(options => options.map(option => option.value));
  check('review offers every source state in original order', JSON.stringify(actualStates) === JSON.stringify(states), {expected: states, actual: actualStates});
  check('review headline shows the actual passing gate count', (await page.locator('#overall').innerText()).includes(`${report.gates.length} / ${report.gates.length}`), await page.locator('#overall').innerText());

  for (const state of states) {
    await page.locator('#state').selectOption(state);
    await page.waitForFunction(state => ['reference', 'actual', 'back', 'front'].every(id => {
      const image = document.getElementById(id);
      const side = id === 'reference' || id === 'back' ? 'reference' : 'actual';
      return image.getAttribute('src') === `${side}-${state}.png` && image.complete && image.naturalWidth === 1040 && image.naturalHeight === 740;
    }), state);
    const loaded = await page.locator('#reference,#actual,#back,#front').evaluateAll(nodes => nodes.map(image => ({id: image.id, src: image.getAttribute('src'), complete: image.complete, width: image.naturalWidth, height: image.naturalHeight})));
    for (const image of loaded) images.set(image.src, image);
    check(`${state} selects and loads both full-sized evidence images`, (await page.locator('#state').inputValue()) === state && loaded.every(image => image.complete && image.width === 1040 && image.height === 740), loaded);
    const expectedGates = report.gates.filter(gate => gate.name.startsWith(state + ' ')).map(gate => gate.name);
    const visibleGates = await page.locator('#gates tbody tr td:first-child').allTextContents();
    check(`${state} shows exactly its own gates`, JSON.stringify(visibleGates) === JSON.stringify(expectedGates), {expectedCount: expectedGates.length, actualCount: visibleGates.length});
    const expectedMotion = Object.entries(sourceMotion.reference[state]).filter(([, entries]) => Array.isArray(entries)).map(([name]) => name);
    const visibleMotion = await page.locator('#motion tbody tr td:first-child').allTextContents();
    check(`${state} switches its original motion table`, JSON.stringify(visibleMotion) === JSON.stringify(expectedMotion), {expected: expectedMotion, actual: visibleMotion});
  }
  check('all 76 distinct original/production screenshots loaded', images.size === 76, {count: images.size, width: 1040, height: 740});

  check('review initially shows paired images and hides overlay controls', await page.locator('#pairs').isVisible() && !await page.locator('#overlay').isVisible() && !await page.locator('#alpha-label').isVisible(), 'unchecked blend checkbox');
  await page.locator('#blend').check();
  check('blend checkbox shows overlay and opacity control', !await page.locator('#pairs').isVisible() && await page.locator('#overlay').isVisible() && await page.locator('#alpha-label').isVisible(), 'real checkbox change');
  const range = page.locator('#alpha');
  await range.focus();
  await range.press('Home');
  check('opacity keyboard minimum updates overlay to zero', await range.inputValue() === '0' && await page.locator('#front').evaluate(image => getComputedStyle(image).opacity) === '0', 'real Home key/input event');
  for (let index = 0; index < 25; index++) await range.press('ArrowRight');
  check('opacity keyboard quarter updates overlay to 0.25', await range.inputValue() === '25' && await page.locator('#front').evaluate(image => getComputedStyle(image).opacity) === '0.25', '25 real ArrowRight key/input events');
  await range.press('End');
  check('opacity keyboard maximum updates overlay to one', await range.inputValue() === '100' && await page.locator('#front').evaluate(image => getComputedStyle(image).opacity) === '1', 'real End key/input event');
  await page.locator('#state').selectOption('day-emote');
  await page.waitForFunction(() => document.querySelector('#front').complete && document.querySelector('#front').getAttribute('src') === 'actual-day-emote.png');
  check('state changes while overlay remains active', await page.locator('#overlay').isVisible() && await page.locator('#front').getAttribute('src') === 'actual-day-emote.png' && await page.locator('#back').getAttribute('src') === 'reference-day-emote.png', 'actual state select while blended');
  await page.locator('#blend').uncheck();
  check('unchecking blend restores paired view', await page.locator('#pairs').isVisible() && !await page.locator('#overlay').isVisible() && !await page.locator('#alpha-label').isVisible(), 'real checkbox change');

  await page.locator('details:has(#search) > summary').click();
  for (const query of ['night-live', 'NIGHT-LIVE', 'image-only', 'no-matching-review-gate-91a5', '']) {
    await page.locator('#search').fill(query);
    const expected = report.gates.filter(gate => gate.name.toLowerCase().includes(query.toLowerCase())).map(gate => gate.name);
    const actual = await page.locator('#all-gates tbody tr td:first-child').allTextContents();
    check(`review search ${JSON.stringify(query)} filters all gates correctly`, JSON.stringify(expected) === JSON.stringify(actual), {query, expectedCount: expected.length, actualCount: actual.length});
  }
  await page.locator('#state').selectOption('night-live');
  await page.locator('#state').scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(output, 'review-browser-check.png')});
  check('no browser script or console errors', errors.length === 0, errors);
  check('no failed local evidence requests or external network', resourceErrors.length === 0, resourceErrors);
  for (const [name, expected] of Object.entries(bindings).filter(([name]) => name !== 'output')) {
    check(`${name} remains unchanged during review check`, sha256(await fs.readFile(path.join(output, name))) === expected, expected);
  }
})().catch(error => {
  errors.push({kind: 'fatal', message: error.stack || String(error)});
}).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  const result = {checkedAt, evidence: 'Actual headless Edge review artifact verification only; state selection, 76 PNG loads, full state gate/motion tables, checkbox overlap, keyboard opacity and search exercised. Existing production parity is not rerun. All external requests blocked.', output, browserVersion, bindings, stateCount: states?.length || 0, imageCount: images.size, images: [...images.values()], passed: errors.length === 0 && resourceErrors.length === 0 && checks.every(check => check.passed), checks, errors, resourceErrors};
  const target = path.join(output, 'review-browser-check.json');
  const previous = await fs.readFile(target).catch(() => null);
  if (previous && !JSON.parse(previous).passed) await fs.writeFile(path.join(output, `review-browser-check-preserved-failure-${Date.now()}.json`), previous);
  await fs.writeFile(target, JSON.stringify(result, null, 2));
  if (!result.passed) await fs.writeFile(path.join(output, `review-browser-check-failed-${Date.now()}.json`), JSON.stringify(result, null, 2));
  console.log(`${checks.filter(check => check.passed).length}/${checks.length} review browser checks passed; ${result.stateCount} states, ${result.imageCount} PNG files; ${target}`);
  assert.equal(result.passed, true, JSON.stringify({errors, resourceErrors, failures: checks.filter(check => !check.passed)}));
}).catch(error => { console.error(error); process.exitCode = 1; });
