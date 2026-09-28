import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const directory = new URL('.', import.meta.url);
const html = readFileSync(new URL('index.html', directory), 'utf8');
const script = readFileSync(new URL('startup-theme.js', directory), 'utf8');

test('startup theme runs before the stylesheet and the application', () => {
  const bootstrap = html.indexOf('src="./startup-theme.js"');
  assert.ok(bootstrap > 0);
  assert.ok(bootstrap < html.indexOf('href="./styles.css"'));
  assert.ok(bootstrap < html.indexOf('src="./app.js"'));
});

for (const [appearance, systemDark, expected] of [
  ['dark', false, 'dark'],
  ['light', true, 'light'],
  ['system', true, 'dark'],
  ['system', false, 'light'],
]) {
  test(`${appearance} preference starts ${expected} with system dark=${systemDark}`, () => {
    const document = { documentElement: { dataset: {} } };
    const window = { __DANMAKUVOICE_STARTUP_THEME__: { appearance, session: 'current' } };
    runInNewContext(script, { document, window, matchMedia: () => ({ matches: systemDark }) });
    assert.equal(document.documentElement.dataset.theme, expected);
  });
}

test('a preference saved in this session is used before a reload paints', () => {
  const document = { documentElement: { dataset: {} } };
  const window = {
    __DANMAKUVOICE_STARTUP_THEME__: { appearance: 'light', session: 'current' },
    sessionStorage: { getItem: () => JSON.stringify({ appearance: 'dark', session: 'current' }) },
  };
  runInNewContext(script, { document, window, matchMedia: () => ({ matches: false }) });
  assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('a previous process cannot override the saved native preference', () => {
  const document = { documentElement: { dataset: {} } };
  const window = {
    __DANMAKUVOICE_STARTUP_THEME__: { appearance: 'dark', session: 'current' },
    sessionStorage: { getItem: () => JSON.stringify({ appearance: 'light', session: 'previous' }) },
  };
  runInNewContext(script, { document, window, matchMedia: () => ({ matches: false }) });
  assert.equal(document.documentElement.dataset.theme, 'dark');
});
