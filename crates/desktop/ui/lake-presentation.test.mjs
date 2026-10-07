import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLakePresentationLedger, eventKeys } from './helpers.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
function storage(initial = null) {
  const writes = [];
  return { value: initial, writes, getItem() { return this.value; }, setItem(key, value) { assert.equal(key, 'danmakuvoice.lakePresented'); this.value = value; writes.push(JSON.parse(value)); } };
}

test('presentation recovery persists only SHA-256 identities including UTF-8 and multi-block fallback keys', () => {
  const disk = storage();
  const session = '原生窗口😀';
  const scope = JSON.stringify(['account-42', 'room-999']);
  const event = { room_id: 999, observed_at_ms: 1791288000000, kind: 'danmaku', user_id: 7, user_name: '用户名', message: '隐私弹幕正文👩🏽‍🚀'.repeat(24) };
  const key = JSON.stringify([eventKeys([event])[0], event.observed_at_ms]);
  const ledger = createLakePresentationLedger(disk, session);
  assert.equal(ledger.has(scope, key), false);
  ledger.mark(scope, [key]);
  assert.equal(ledger.has(scope, key), true);
  assert.deepEqual(JSON.parse(disk.value), { version: 1, session: hash(session), contexts: [[hash(scope), [hash(key)]]] });
  assert.ok(!disk.value.includes('隐私') && !disk.value.includes('用户名') && !disk.value.includes('account-42'));
  const reopened = createLakePresentationLedger(disk, session);
  assert.equal(reopened.has(scope, key), true);
  assert.equal(reopened.has('another-account-same-room', key), false);
  assert.equal(reopened.has('same-account-another-room', key), false);
  assert.equal(createLakePresentationLedger(disk, 'new-native-window-session').has(scope, key), false);
  // Already-seen periodic updates do not repeatedly write the browser store.
  reopened.mark(scope, [key]); assert.equal(disk.writes.length, 1);
});

test('presentation records bound both retained scopes and identities and recover the latest records', () => {
  const disk = storage();
  const ledger = createLakePresentationLedger(disk, 'bounded');
  ledger.mark('scope-0', Array.from({ length: 600 }, (_, index) => `message-${index}`));
  assert.equal(ledger.has('scope-0', 'message-0'), false);
  assert.equal(ledger.has('scope-0', 'message-87'), false);
  assert.equal(ledger.has('scope-0', 'message-88'), true);
  for (let index = 1; index <= 8; index++) ledger.mark(`scope-${index}`, [`new-${index}`]);
  assert.equal(ledger.has('scope-0', 'message-599'), false);
  const saved = JSON.parse(disk.value);
  assert.equal(saved.contexts.length, 8);
  assert.ok(saved.contexts.every(([, keys]) => keys.length <= 512));
  const reopened = createLakePresentationLedger(disk, 'bounded');
  assert.equal(reopened.has('scope-8', 'new-8'), true);
  assert.equal(reopened.has('scope-0', 'message-599'), false);
  // Duplicate identities within a batch stay unique and do not evict entries.
  reopened.mark('scope-8', Array(700).fill('new-8'));
  assert.equal(JSON.parse(disk.value).contexts.at(-1)[1].length, 1);
});

test('corrupt, oversized and unavailable recovery storage cannot interrupt the UI', () => {
  const scope = 'scope', key = 'message';
  for (const raw of ['{', 'x'.repeat(300001), JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, session: hash('session'), contexts: [['raw-scope', ['raw-message']]] })]) {
    const disk = storage(raw), ledger = createLakePresentationLedger(disk, 'session');
    assert.equal(ledger.has(scope, key), false);
    ledger.mark(scope, [key]); assert.equal(ledger.has(scope, key), true);
    assert.equal(JSON.parse(disk.value).contexts.length, 1);
  }
  const denied = createLakePresentationLedger({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } }, 'session');
  denied.mark(scope, [key]); assert.equal(denied.has(scope, key), true);
  const unavailable = createLakePresentationLedger(undefined, 'session');
  unavailable.mark(scope, [key]); assert.equal(unavailable.has(scope, key), true);
});

test('carried observations remain seen through reconnect while reused IDs at a new observation time remain new', () => {
  const ledger = createLakePresentationLedger(storage(), 'session');
  const scope = '[42,999]';
  const original = { platform_event_id: 'same-platform-id', room_id: 999, observed_at_ms: 1000 };
  const key = eventKeys([original])[0];
  ledger.mark(scope, [JSON.stringify([key, original.observed_at_ms])]);
  assert.equal(ledger.has(scope, JSON.stringify([key, original.observed_at_ms])), true);
  assert.equal(ledger.has(scope, JSON.stringify([key, 2000])), false);
});
