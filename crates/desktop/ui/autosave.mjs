/**
 * A DOM-independent queue for one editable form. It owns neither rendering nor
 * navigation. The caller validates drafts, patches newly created IDs in onSaved,
 * and awaits flush() before replacing the form.
 *
 * Only the newest pending draft is kept. Writes and onSaved callbacks are serial.
 * prepare runs immediately before each write, so it can inject an ID assigned by
 * the preceding write. A failed draft remains dirty; it is never retried silently.
 */
export function createAutosaveQueue({
  save,
  prepare = payload => payload,
  onSaved = () => {},
  onError = () => {},
  onState = () => {},
  delay = 600,
} = {}) {
  if (typeof save !== 'function') throw new TypeError('Autosave requires a save callback.');
  if (!Number.isFinite(delay) || delay < 0) throw new TypeError('Autosave delay must be non-negative.');

  let revision = 0;
  let cancelledThrough = 0;
  let pending = null;
  let current = null;
  let failed = null;
  let timer = null;
  let flushers = 0;
  let disposed = false;
  let lastResult;

  const dirty = () => !!(pending || current || failed);
  const error = () => failed?.error ?? null;
  const requireActive = () => {
    if (disposed) throw new Error('This autosave queue has been disposed.');
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  // Status/error observers must not interrupt persistence or strand flush().
  const observe = (callback, ...args) => {
    try { callback(...args); } catch { /* Persistence is independent of observers. */ }
  };
  const publish = () => observe(onState, { dirty: dirty(), saving: !!current, error: error() });

  function pump() {
    if (disposed || current || !pending || !pending.ready) return;
    clearTimer();
    const entry = pending;
    pending = null;
    current = { entry, promise: null };
    // Defer callbacks so the current promise exists before a callback can flush.
    current.promise = Promise.resolve().then(() => run(entry));
    publish();
  }

  async function run(entry) {
    let prepared = entry.retry?.prepared;
    let result = entry.retry?.result;
    let committed = entry.retry?.committed ?? false;
    try {
      if (!committed) {
        prepared = await prepare(structuredClone(entry.payload));
        result = await save(prepared);
        committed = true;
      }
      // Await ID reconciliation before preparing the next queued draft.
      await onSaved(result, prepared);
      lastResult = result;
      if (!failed || failed.entry.revision <= entry.revision) failed = null;
    } catch (failure) {
      if (entry.revision > cancelledThrough) {
        failed = { entry, prepared, result, committed, error: failure };
        observe(onError, failure, prepared ?? entry.payload);
      }
    } finally {
      current = null;
      if (pending && flushers) pending.ready = true;
      publish();
      pump();
    }
  }

  function enqueue(payload, { immediate = false } = {}, retry = null) {
    requireActive();
    // Capture this edit now, not a mutable object subsequently edited by the UI.
    const captured = structuredClone(payload);
    clearTimer();
    revision += 1;
    pending = { revision, payload: captured, ready: immediate || flushers > 0, retry };
    failed = null;
    if (!pending.ready) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) pending.ready = true;
        pump();
      }, delay);
    }
    publish();
    pump();
    return revision;
  }

  async function flush() {
    requireActive();
    flushers += 1;
    clearTimer();
    try {
      for (;;) {
        if (pending) pending.ready = true;
        pump();
        if (current) {
          await current.promise;
          continue;
        }
        if (pending) continue;
        if (failed) throw failed.error;
        return lastResult;
      }
    } finally {
      flushers -= 1;
    }
  }

  function cancel() {
    requireActive();
    clearTimer();
    cancelledThrough = revision;
    pending = null;
    failed = null;
    // A dispatched persistence operation cannot be undone. Its onSaved still
    // runs so the caller can retain the created ID, but abandoned errors do not
    // make a discarded draft dirty again.
    publish();
  }

  return {
    schedule: enqueue,
    flush,
    cancel,
    retry() {
      requireActive();
      if (!failed) return null;
      const previous = failed;
      // If the write succeeded but ID reconciliation failed, retry only the
      // reconciliation callback: do not create the same entity a second time.
      return enqueue(previous.entry.payload, { immediate: true }, previous);
    },
    dispose() {
      requireActive();
      if (dirty()) throw new Error('Flush or cancel pending edits before disposing the autosave queue.');
      clearTimer();
      disposed = true;
    },
    get dirty() { return dirty(); },
    get saving() { return !!current; },
    get error() { return error(); },
  };
}
