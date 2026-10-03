import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Tauri embeds only the files listed in frontendDist. A module the page imports but the
// list omits loads in a browser fixture yet leaves the real window stuck on the boot screen.
test('every file the page loads is embedded by Tauri', () => {
  const config = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'));
  const embedded = new Set(config.build.frontendDist.map(path => path.replace(/^ui\//, '')));
  const pending = ['index.html'];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(embedded.has(file), `${file} is loaded by the page but missing from tauri.conf.json frontendDist`);
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const references = file.endsWith('.html')
      ? [...source.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)].map(match => match[1])
      : [...source.matchAll(/^\s*import[^'"]*['"]\.\/([^'"]+)['"]/gm)].map(match => match[1]);
    for (const reference of references) if (/\.(m?js|css|html)$/.test(reference)) pending.push(reference);
  }
  assert.ok(seen.has('i18n-en.mjs'));
});
