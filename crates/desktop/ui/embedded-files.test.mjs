import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'));
// Tauri serves every frontendDist file at the root under its file name: ui/fonts/x.woff2 is ./x.woff2.
const basename = path => path.split('/').pop();
const served = new Map(config.build.frontendDist.map(path => [basename(path), path.replace(/^ui\//, '')]));

test('embedded files keep distinct names because Tauri flattens frontendDist', () => {
  assert.equal(served.size, config.build.frontendDist.length, 'two frontendDist entries share a file name');
});

// Tauri embeds only the files listed in frontendDist. A module the page imports but the
// list omits loads in a browser fixture yet leaves the real window stuck on the boot screen.
test('every file the page loads is embedded by Tauri', () => {
  const pending = ['index.html'];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(served.has(file), `${file} is loaded by the page but missing from tauri.conf.json frontendDist`);
    const source = readFileSync(new URL(`./${served.get(file)}`, import.meta.url), 'utf8');
    const references = file.endsWith('.html')
      ? [...source.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)].map(match => match[1])
      : file.endsWith('.css')
        ? [...source.matchAll(/url\(["']?\.\/([^"')?#]+)["']?\)/g)].map(match => match[1])
        : [...source.matchAll(/^\s*import[^'"]*['"]\.\/([^'"]+)['"]/gm)].map(match => match[1]);
    for (const reference of references) {
      assert.doesNotMatch(reference, /\//, `${file} references ${reference}, but Tauri serves embedded files without folders`);
      if (/\.(m?js|css|html)$/.test(reference)) pending.push(reference);
      // Fonts and other binary assets referenced by CSS must also be embedded.
      else assert.ok(served.has(reference), `${reference} is referenced by ${file} but missing from tauri.conf.json frontendDist`);
    }
  }
  assert.ok(seen.has('i18n-en.mjs'));
  assert.equal(served.get('OFL.txt'), 'fonts/OFL.txt', 'the bundled serif font ships with its OFL license');
  assert.equal(served.get('OFL-InstrumentSerif.txt'), 'fonts/OFL-InstrumentSerif.txt');
});

test('every font the OBS overlay asks for is embedded and allowed by the overlay server', () => {
  const page = readFileSync(new URL('../overlay/overlay.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/overlay.rs', import.meta.url), 'utf8');
  const fonts = [...page.matchAll(/url\(["']?\/overlay\/fonts\/([^"')]+)["']?\)/g)].map(match => match[1]);
  assert.ok(fonts.length >= 4);
  for (const font of fonts) {
    assert.ok(served.has(font), `${font} is used by the overlay but not embedded`);
    assert.ok(server.includes(`"${font}"`), `${font} is used by the overlay but not served`);
  }
});

test('scene and overlay preserve original Google font weight matching', () => {
  for (const file of ['./styles.css', '../overlay/overlay.html']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const [name, weight] of [['Medium', 500], ['Bold', 700], ['Black', 900]]) {
      const rule = [...source.matchAll(/@font-face\{([^}]+)\}/g)]
        .find(match => match[1].includes(`DanmakuVoiceSerifSC-${name}.woff2`))?.[1];
      assert.ok(rule, `${file} embeds the ${name} face`);
      assert.match(rule, new RegExp(`font-weight:${weight}(?:;|$)`), `${file} matches the original exact ${weight} declaration`);
    }
  }
});
