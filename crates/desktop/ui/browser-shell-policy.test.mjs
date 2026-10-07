import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));

// Browser acceptance must not register test pages as Explorer-owned tabs in
// OBS window lists, including tests that open the main page and the overlay.
test('every checked-in Chromium regression launch disables Shell tab registration', () => {
  let launches = 0;
  for (const filename of readdirSync(scripts).filter(name => name.endsWith('.cjs'))) {
    const source = readFileSync(`${scripts}/${filename}`, 'utf8');
    for (const match of source.matchAll(/chromium\.launch\s*\(/g)) {
      let depth = 1;
      let quote = '';
      let escaped = false;
      let end = match.index + match[0].length;
      const start = end;
      for (; end < source.length && depth; end++) {
        const character = source[end];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === quote) quote = '';
        } else if ('"\'`'.includes(character)) quote = character;
        else if (character === '(') depth++;
        else if (character === ')') depth--;
      }
      assert.equal(depth, 0, `${filename}: unterminated Chromium launch`);
      const launch = source.slice(start, end);
      assert.match(launch, /--disable-features=[^'"`\s]*msWindowTabManagerPublic/, `${filename}: browser launch could create Shell proxy windows`);
      launches++;
    }
  }
  assert.ok(launches >= 16, `expected regression launches, found ${launches}`);
});
