import test from 'node:test';
import assert from 'node:assert/strict';
import { broadcastSessionSummary } from './helpers.mjs';

test('absent and malformed prior session data cannot produce zero or unknown placeholder statistics', () => {
  for (const last_session of [undefined, null, {}, { messages: -1, seconds: 1, ended_observed_at: 1791268200 },
    { messages: 3, seconds: -1, ended_observed_at: 1791268200 },
    { messages: 3, seconds: 1, ended_observed_at: 0 },
    { messages: '3', seconds: 1, ended_observed_at: 1791268200 }]) {
    assert.equal(broadcastSessionSummary({ last_session }), null);
  }
});

test('persisted session counts survive view reconstruction without using the display buffer', () => {
  const last_session = { started_at: 1791260000, observed_started_at: 1791260020, ended_observed_at: 1791268200, messages: 151, seconds: 8200 };
  const view = broadcastSessionSummary(JSON.parse(JSON.stringify({ last_session })));
  assert.deepEqual(view, { messages: 151, seconds: 8200, endedAt: 1791268200 });
});

test('a real zero-message session is retained while an unknown ending time never creates a duration', () => {
  assert.deepEqual(broadcastSessionSummary({ last_session: { messages: 0, seconds: null, ended_observed_at: 1791268200 } }),
    { messages: 0, seconds: null, endedAt: 1791268200 });
});
