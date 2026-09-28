import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaveQueue } from './autosave.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('text edits debounce and persist only the newest captured draft', async () => {
  const writes = [];
  const queue = createAutosaveQueue({ delay: 30, save: async payload => writes.push(payload) });
  queue.schedule({ name: 'a' });
  const latest = { name: 'ab' };
  queue.schedule(latest);
  latest.name = 'changed elsewhere';
  assert.equal(queue.dirty, true);
  await wait(10);
  assert.equal(writes.length, 0);
  await wait(50);
  assert.deepEqual(writes, [{ name: 'ab' }]);
  assert.equal(queue.dirty, false);
  queue.dispose();
});

test('switches can save immediately and flush bypasses a pending text debounce', async () => {
  const writes = [];
  const started = deferred();
  const queue = createAutosaveQueue({ delay: 60_000, save: async payload => { writes.push(payload); started.resolve(); return payload; } });
  queue.schedule({ enabled: true }, { immediate: true });
  await started.promise;
  assert.equal(writes.length, 1);
  await queue.flush();
  queue.schedule({ name: 'final' });
  assert.deepEqual(await queue.flush(), { name: 'final' });
  assert.deepEqual(writes, [{ enabled: true }, { name: 'final' }]);
  queue.dispose();
});

test('writes are serial and the next draft receives the newly created ID', async () => {
  const firstWrite = deferred();
  const firstStarted = deferred();
  const reconcile = deferred();
  const reconcileStarted = deferred();
  const writes = [];
  let recordId = '';
  const queue = createAutosaveQueue({
    prepare: payload => ({ ...payload, id: recordId }),
    save: async payload => {
      writes.push(payload);
      if (writes.length === 1) { firstStarted.resolve(); return firstWrite.promise; }
      return { id: recordId };
    },
    onSaved: async result => {
      if (!recordId) { reconcileStarted.resolve(); await reconcile.promise; }
      recordId = result.id;
    },
  });
  queue.schedule({ name: 'first' }, { immediate: true });
  await firstStarted.promise;
  queue.schedule({ name: 'second' }, { immediate: true });
  queue.schedule({ name: 'latest' }, { immediate: true });
  const flushed = queue.flush();
  firstWrite.resolve({ id: 'created-42' });
  await reconcileStarted.promise;
  assert.equal(writes.length, 1);
  reconcile.resolve();
  await flushed;
  assert.deepEqual(writes, [{ name: 'first', id: '' }, { name: 'latest', id: 'created-42' }]);
  assert.equal(queue.dirty, false);
});

test('flush includes edits arriving while an earlier save is in flight', async () => {
  const first = deferred();
  const began = deferred();
  const writes = [];
  const queue = createAutosaveQueue({ delay: 60_000, save: async payload => { writes.push(payload); if (writes.length === 1) { began.resolve(); return first.promise; } return payload; } });
  queue.schedule(1);
  const flushed = queue.flush();
  await began.promise;
  queue.schedule(2);
  first.resolve(1);
  assert.equal(await flushed, 2);
  assert.deepEqual(writes, [1, 2]);
});

test('failed latest edits stay dirty and are retried only explicitly', async () => {
  const failure = new Error('Disk unavailable');
  const errors = [];
  const states = [];
  let attempts = 0;
  const queue = createAutosaveQueue({ save: async payload => { attempts++; if (attempts === 1) throw failure; return payload; }, onError: error => errors.push(error), onState: state => states.push(state) });
  queue.schedule({ name: 'saved after retry' }, { immediate: true });
  await assert.rejects(queue.flush(), failure);
  await wait(15);
  assert.equal(attempts, 1);
  assert.equal(queue.dirty, true);
  assert.equal(queue.error, failure);
  assert.equal(errors.length, 1);
  assert.equal(states.at(-1).saving, false);
  queue.retry();
  await queue.flush();
  assert.equal(attempts, 2);
  assert.equal(queue.dirty, false);
  assert.equal(queue.error, null);
});

test('newer corrected draft supersedes an in-flight failure and flush succeeds', async () => {
  const first = deferred();
  const began = deferred();
  const writes = [];
  const queue = createAutosaveQueue({ save: async payload => { writes.push(payload); if (writes.length === 1) { began.resolve(); return first.promise; } return payload; } });
  queue.schedule({ value: 'old' }, { immediate: true });
  await began.promise;
  queue.schedule({ value: 'corrected' }, { immediate: true });
  const flushed = queue.flush();
  first.reject(new Error('Old revision rejected'));
  assert.deepEqual(await flushed, { value: 'corrected' });
  assert.equal(writes.length, 2);
  assert.equal(queue.dirty, false);
});

test('ID reconciliation retry does not duplicate a successful server write', async () => {
  let writes = 0;
  let reconciliations = 0;
  const queue = createAutosaveQueue({ save: async () => { writes++; return { id: 'unique' }; }, onSaved: async () => { reconciliations++; if (reconciliations === 1) throw new Error('UI reconciliation failed'); } });
  queue.schedule({ name: 'new' }, { immediate: true });
  await assert.rejects(queue.flush(), /reconciliation/);
  queue.retry();
  assert.deepEqual(await queue.flush(), { id: 'unique' });
  assert.equal(writes, 1);
  assert.equal(reconciliations, 2);
});

test('cancel drops a queued draft; disposing a dirty form is refused', async () => {
  let writes = 0;
  const queue = createAutosaveQueue({ delay: 20, save: async () => writes++ });
  queue.schedule({ draft: true });
  assert.throws(() => queue.dispose(), /Flush or cancel/);
  queue.cancel();
  assert.equal(queue.dirty, false);
  await wait(40);
  assert.equal(writes, 0);
  queue.dispose();
  assert.throws(() => queue.schedule({ draft: true }), /disposed/);
});

test('cancel cannot undo an in-flight write and still reconciles its created ID', async () => {
  const running = deferred();
  const started = deferred();
  const saved = [];
  const queue = createAutosaveQueue({ save: async () => { started.resolve(); return running.promise; }, onSaved: result => saved.push(result) });
  queue.schedule({ draft: true }, { immediate: true });
  await started.promise;
  queue.cancel();
  assert.equal(queue.saving, true);
  assert.throws(() => queue.dispose(), /Flush or cancel/);
  running.resolve({ id: 'persisted' });
  await queue.flush();
  assert.deepEqual(saved, [{ id: 'persisted' }]);
  assert.equal(queue.dirty, false);
});

test('state and error observer exceptions cannot strand persistence', async () => {
  const queue = createAutosaveQueue({ save: async () => { throw new Error('write failed'); }, onState: () => { throw new Error('observer failed'); }, onError: () => { throw new Error('observer failed'); } });
  queue.schedule({}, { immediate: true });
  await assert.rejects(queue.flush(), /write failed/);
  queue.cancel();
  queue.dispose();
});
