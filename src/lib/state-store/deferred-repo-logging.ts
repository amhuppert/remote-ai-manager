/**
 * Hold a repository's own log lines until the serialized write section it was
 * called from has ended.
 *
 * `createLogger` writes to disk synchronously. A repository that logs from
 * inside `BEGIN IMMEDIATE` therefore holds SQLite's write lock across a
 * filesystem write, and on the lease reservation — the one path every launch in
 * every process serializes on — that lock is the whole system's bottleneck.
 * Repositories still describe what they did; the emission simply waits.
 *
 * Synchronous by construction, with no async-context tracking, because the
 * sections this guards are synchronous: better-sqlite3 transactions and
 * `withWriteQueueSync` callbacks both run to completion without yielding. A
 * deferred emit therefore always belongs to the capture that is open when it is
 * queued.
 */

type DeferredEmit = () => void;

/** The open capture's queue, or null when logging passes straight through. */
let buffer: DeferredEmit[] | null = null;

/** Lines from a capture whose section threw, so no `flush` reached its caller. */
let orphaned: DeferredEmit[] = [];

/**
 * Emit now, or queue for the open capture. Repositories call this instead of
 * their logger directly.
 */
export function emitOrDeferRepositoryLog(emit: DeferredEmit): void {
  if (buffer === null) {
    emit();
    return;
  }
  buffer.push(emit);
}

/**
 * Run `fn` with repository logging deferred, and hand back a `flush` the caller
 * invokes once the critical section is over.
 *
 * `flush` is returned rather than run here so the caller can release the write
 * queue first — flushing inside would only move the I/O, not remove it from the
 * section.
 *
 * Nested captures deliberately do NOT open a second buffer: the outermost
 * section owns the release point, so an inner one returns a no-op flush and
 * lets its lines ride out with the outer's.
 */
export function captureRepositoryLogs<T>(fn: () => T): {
  value: T;
  flush: () => void;
} {
  if (buffer !== null) {
    return { value: fn(), flush: () => {} };
  }
  const own: DeferredEmit[] = [];
  buffer = own;
  let value: T;
  try {
    value = fn();
  } catch (err) {
    // The buffer is cleared on EVERY exit, or a later log in this process would
    // queue into an abandoned array and never be seen. A throwing section never
    // receives its `flush`, so its lines move somewhere a caller can still
    // drain them: losing the timing of the operation that failed is exactly the
    // wrong trade.
    buffer = null;
    orphaned.push(...own);
    throw err;
  }
  buffer = null;
  let flushed = false;
  return {
    value,
    flush: () => {
      if (flushed) return;
      flushed = true;
      for (const emit of own) emit();
    },
  };
}

/** Emit the lines of any capture whose section threw. */
export function releaseDeferredRepositoryLogs(): void {
  if (orphaned.length === 0) return;
  const pending = orphaned;
  orphaned = [];
  for (const emit of pending) emit();
}
