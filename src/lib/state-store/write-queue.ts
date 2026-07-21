/**
 * FIFO async serialization for write operations against the structured store.
 *
 * Pure scheduling primitive — decoupled from any file path or DB connection.
 * Each call appends to a chained-promise tail so callbacks run exactly once
 * the previous tick has settled. A rejection in the callback propagates to
 * the caller but does not poison the chain — subsequent ticks still run.
 */

import { createLogger, type Logger } from "@/lib/logging";
// Imported from the context submodule (not the `@/lib/logging` barrel) so the
// many tests that stub the barrel with a partial `vi.mock("@/lib/logging")`
// keep working without each having to add a `getTraceContext` export.
import { getTraceContext } from "@/lib/logging/context";
import { getGlobalSingleton } from "../shared/global-singleton";

const logger = createLogger("state-store.write-queue");

const WRITE_QUEUE_KEY = "__cc_state_store_write_queue" as const;

/**
 * Compile-time guard for the synchronous entry point. When a callback's return
 * type `T` has *any* `PromiseLike` constituent (an `async` callback, one that
 * returns a Promise, or a union like `number | Promise<number>` from a
 * `cond ? sync : externalWork()` body), this resolves to a one-element tuple,
 * turning `...guard` into a REQUIRED extra argument the caller cannot supply —
 * so the call fails to typecheck. A genuinely synchronous callback yields an
 * empty tuple and compiles cleanly.
 *
 * `Extract<T, PromiseLike<unknown>>` distributes over unions, keeping only the
 * PromiseLike members; a whole-type `[T] extends [PromiseLike<unknown>]` check
 * would miss a mixed union (the union as a whole is not assignable to
 * PromiseLike) and let the queue await the Promise branch while holding the
 * lock. `Extract<never, …>` is `never`, so an always-throwing callback (return
 * type `never`) is still treated as synchronous and allowed. This makes "await
 * external work while holding the global write lock" unrepresentable at the sync
 * entry (Design 3.3, no-slow-work-in-critical-section).
 */
type RejectAsyncSyncCallback<T> = [Extract<T, PromiseLike<unknown>>] extends [
  never,
]
  ? []
  : [
      error: "withWriteQueueSync callback must be synchronous — pass an async callback to withWriteQueue instead",
    ];

export interface WriteQueue {
  /**
   * Async-callback entry point. Retained only for callers whose awaits are
   * queue-internal by design — the async Immer mutators `mutateConversation`
   * runs, where the await never escapes the critical section to external I/O.
   * Its call sites are pinned by a shrink-only ratchet (see
   * `write-queue.async-ratchet.test.ts`); prefer `withWriteQueueSync`.
   */
  withWriteQueue<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Synchronous-callback entry point — the default reach for queue writes.
   *
   * `fn` runs inside the same FIFO chain as `withWriteQueue`, but is typed
   * `() => T` (not a Promise) to make the queue's core invariant a compile-time
   * one: the callback MUST be synchronous and pure — no I/O, no awaits, nothing
   * that can block. A queue critical section is a repo write plus pure
   * computation and nothing else. The returned Promise resolves once this call
   * has acquired the queue and `fn` has run; it never blocks on external work.
   *
   * A callback whose return type is a Promise (an `async` callback, or one that
   * returns a Promise) is a COMPILE ERROR via the `...reject` guard — use
   * `withWriteQueue` for async work.
   */
  withWriteQueueSync<T>(
    label: string,
    fn: () => T,
    ...reject: RejectAsyncSyncCallback<T>
  ): Promise<T>;
  tryWithWriteQueue<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  _resetForTesting(): void;
}

/** Identity of an in-flight writer, so a waiter can name the holder it blocks on. */
interface QueueOwner {
  label: string;
  traceId: string | undefined;
}

/** Hold time above which a callback trips the loud-invariant budget log. */
const DEFAULT_HOLD_BUDGET_MS = 500;

export interface WriteQueueOptions {
  /**
   * Hold-time ceiling in ms. A callback that holds the queue longer than this
   * emits an error-level `hold_budget_exceeded` event (telemetry only — the
   * write is never aborted). Defaults to 500ms; injectable for tests.
   */
  holdBudgetMs?: number;
  /** Monotonic clock for timing; injectable for deterministic tests. */
  now?: () => number;
  /**
   * Timing/attribution logger; injectable so the release-before-logging
   * ordering test can probe queue state from inside the emit. Defaults to the
   * module logger in production.
   */
  logger?: Logger;
}

export function createWriteQueue(options?: WriteQueueOptions): WriteQueue {
  const now = options?.now ?? (() => performance.now());
  const holdBudgetMs = options?.holdBudgetMs ?? DEFAULT_HOLD_BUDGET_MS;
  const queueLogger = options?.logger ?? logger;

  let tail: Promise<void> = Promise.resolve();
  // In-flight writers in FIFO order: the front (`owners[0]`) is the mutation
  // currently *holding* the queue, and every writer behind it is waiting. Each
  // enqueue pushes itself synchronously; each release shifts itself off the
  // front. Because the promise chain forces strict FIFO acquire-and-release
  // (a successor's `await predecessor` can't resolve until its predecessor's
  // `finally` has run), the releaser is always the front element, so `shift()`
  // removes the correct writer. `owners.length` is the pending count.
  //
  // A waiter attributes its wait to `owners[0]` at enqueue time — the holder,
  // NOT the tail it happens to queue directly behind. In a deep queue
  // (A holds, B waits, C arrives) C must name A, the mutation actually blocking
  // the whole queue (Design 6.2 culprit attribution). During a handoff — the
  // window after a departing owner shifts itself off but before its successor's
  // continuation runs — `owners[0]` is that reserved-next successor, so a writer
  // arriving mid-handoff still names a real in-flight owner, never a null gap.
  const owners: QueueOwner[] = [];

  // Loud invariant, not a kill switch (Design 3.5): a callback that holds the
  // queue past the budget is logged at error level with the label and the stack
  // captured where the write was enqueued (the release-time stack would only
  // show queue internals). `enqueueError` is captured cheaply per call and
  // `.stack` is formatted lazily, only on the rare violation.
  function reportHoldBudget(
    label: string,
    holdMs: number,
    enqueueError: Error,
  ): void {
    if (holdMs <= holdBudgetMs) return;
    queueLogger.error("state-store.write_queue.hold_budget_exceeded", {
      label,
      holdMs: +holdMs.toFixed(2),
      budgetMs: holdBudgetMs,
      stack: enqueueError.stack,
    });
  }

  /** A reserved FIFO slot: the predecessor to await, plus release/timing state. */
  interface QueueTicket {
    predecessor: Promise<void>;
    release: () => void;
    blockedBy: QueueOwner | null;
    enqueueError: Error;
    enqueuedAt: number;
  }

  // Reserve the tail synchronously, capturing the waiter's ambient trace and its
  // blocker before enqueuing. The timing event auto-stamps this same traceId from
  // AsyncLocalStorage (naming the request suffering the wait); `blockedBy` names
  // the request causing it — the queue's current holder (`owners[0]`), captured
  // before we push ourselves. An empty queue means we wait on no one.
  function reserve(label: string): QueueTicket {
    const traceId = getTraceContext()?.traceId;
    const blockedBy = owners.length > 0 ? owners[0]! : null;
    // Captured here so a budget violation points at the caller, not the queue.
    const enqueueError = new Error();

    owners.push({ label, traceId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const predecessor = tail;
    tail = gate;

    return { predecessor, release, blockedBy, enqueueError, enqueuedAt: now() };
  }

  // Leave the queue FIRST, then log: shift ourselves off the front (exposing our
  // successor as the new holder) and release its gate BEFORE emitting the timing
  // event or the budget check. The timing/budget logs are synchronous
  // `appendFileSync` I/O in the production logger; emitting them before release
  // would hold the queue across that write (no-slow-work-in-critical-section) and
  // fold the log's duration into the next waiter's wait. `holdMs` is captured at
  // release, so it measures only the callback's run, never the trailing log
  // write. This matches `tryWithWriteQueue`'s existing release-then-log ordering.
  function settle(
    label: string,
    ticket: QueueTicket,
    acquiredAt: number,
  ): void {
    const releasedAt = now();
    const holdMs = releasedAt - acquiredAt;
    owners.shift();
    ticket.release();
    queueLogger.info("state-store.write_queue.timing", {
      label,
      durationMs: +(releasedAt - ticket.enqueuedAt).toFixed(2),
      waitMs: +(acquiredAt - ticket.enqueuedAt).toFixed(2),
      holdMs: +holdMs.toFixed(2),
      blockedByLabel: ticket.blockedBy?.label,
      blockedByTraceId: ticket.blockedBy?.traceId,
    });
    reportHoldBudget(label, holdMs, ticket.enqueueError);
  }

  // Async entry: `run` may await queue-internal work (the async Immer mutators
  // `mutateConversation` runs), so `await run()` keeps us in the critical section
  // until it settles. The one microtask hop between `run()` returning and release
  // is inherent to awaiting; the async form is pinned by a ratchet for exactly
  // this reason.
  async function enqueue<T>(label: string, run: () => Promise<T>): Promise<T> {
    const ticket = reserve(label);
    await ticket.predecessor;
    const acquiredAt = now();
    try {
      return await run();
    } finally {
      settle(label, ticket, acquiredAt);
    }
  }

  // Sync entry: the callback is invoked and released in a SINGLE continuation.
  // Crucially it is `return fn()`, never `await fn()` — awaiting even an already
  // resolved value defers `settle()` to a later microtask, during which the queue
  // stays held and any unrelated microtask that runs is charged to (and extends)
  // the critical section. `return fn()` runs `settle()` synchronously the instant
  // `fn` returns or throws, so the hold spans only `fn`'s own synchronous run —
  // the whole point of the sync entry (no-slow-work-in-critical-section).
  async function enqueueSync<T>(label: string, fn: () => T): Promise<T> {
    const ticket = reserve(label);
    await ticket.predecessor;
    const acquiredAt = now();
    try {
      return fn();
    } finally {
      settle(label, ticket, acquiredAt);
    }
  }

  function withWriteQueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return enqueue(label, fn);
  }

  function withWriteQueueSync<T>(
    label: string,
    fn: () => T,
    ...reject: RejectAsyncSyncCallback<T>
  ): Promise<T> {
    // `reject` is a compile-time-only guard (empty at every valid call site);
    // reference it so it is not flagged unused. Run through the sync-specific
    // path so the queue releases in the same continuation `fn` returns in — a
    // synchronous throw becomes a rejected promise, matching withWriteQueue's
    // error propagation, without ever awaiting between `fn` and release.
    void reject;
    return enqueueSync(label, fn);
  }

  async function tryWithWriteQueue<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (owners.length > 0) {
      queueLogger.info("state-store.write_queue.try_contended", { label });
      return { acquired: false };
    }

    const traceId = getTraceContext()?.traceId;
    const enqueueError = new Error();

    // Reserve the tail exactly as withWriteQueue does. The idle check above only
    // proves the queue is empty *now*; without swapping `tail` here a
    // withWriteQueue call arriving while this callback is in flight would chain
    // onto the already-resolved predecessor and run a second writer
    // concurrently. Owning the tail forces that queued write to wait for our
    // gate to release. Pushing ourselves onto `owners` records us as the holder,
    // so a withWriteQueue enqueuing against us reads `owners[0]` and names us.
    owners.push({ label, traceId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const predecessor = tail;
    tail = gate;

    await predecessor;
    const startedAt = now();
    try {
      return { acquired: true, value: await fn() };
    } finally {
      const holdMs = now() - startedAt;
      owners.shift();
      release();
      reportHoldBudget(label, holdMs, enqueueError);
      queueLogger.info("state-store.write_queue.try_timing", {
        label,
        durationMs: +holdMs.toFixed(2),
      });
    }
  }

  return {
    withWriteQueue,
    withWriteQueueSync,
    tryWithWriteQueue,
    _resetForTesting() {
      tail = Promise.resolve();
      owners.length = 0;
    },
  };
}

function getSharedQueue(): WriteQueue {
  return getGlobalSingleton(WRITE_QUEUE_KEY, () => createWriteQueue());
}

export function getSharedWriteQueue(): WriteQueue {
  return getSharedQueue();
}

export function withWriteQueue<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  return getSharedQueue().withWriteQueue(label, fn);
}

export function withWriteQueueSync<T>(
  label: string,
  fn: () => T,
  ...reject: RejectAsyncSyncCallback<T>
): Promise<T> {
  return getSharedQueue().withWriteQueueSync(label, fn, ...reject);
}

export function tryWithWriteQueue<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return getSharedQueue().tryWithWriteQueue(label, fn);
}

export function _resetForTesting(): void {
  getSharedQueue()._resetForTesting();
}
