/**
 * Promise-chain async mutex for serializing state read-modify-write cycles.
 *
 * Uses a globalThis singleton for HMR-safe interval management.
 * Each caller chains onto the tail promise, ensuring FIFO ordering.
 */

import { createLogger } from "./logging";

const logger = createLogger("state-mutex");

// ============================================================
// HMR-safe Singleton
// ============================================================

const MUTEX_KEY = "__csm_state_mutex" as const;

interface MutexState {
  /** The tail of the promise chain. New operations chain onto this. */
  tail: Promise<void>;
  /** Counter for debug logging — how many operations have been serialized. */
  operationCount: number;
}

function getMutexState(): MutexState {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[MUTEX_KEY]) {
    g[MUTEX_KEY] = {
      tail: Promise.resolve(),
      operationCount: 0,
    } satisfies MutexState;
  }
  return g[MUTEX_KEY] as MutexState;
}

// ============================================================
// Public API
// ============================================================

/**
 * Acquire the state mutex, execute `fn`, then release.
 * Operations are serialized in FIFO order via promise chaining.
 *
 * @param label Identifies the operation for structured logging
 * @param fn The async function to execute while holding the lock
 * @returns Whatever `fn` returns
 */
export async function withStateLock<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const mutex = getMutexState();
  mutex.operationCount++;
  const opId = mutex.operationCount;

  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });

  // Capture the current tail, then immediately replace it
  // with our gate so the next caller waits for us.
  const predecessor = mutex.tail;
  mutex.tail = gate;

  // Wait for the previous operation to finish
  await predecessor;

  logger.debug("state-mutex.acquired", { label, opId });
  const start = Date.now();

  try {
    const result = await fn();
    return result;
  } finally {
    const durationMs = Date.now() - start;
    logger.debug("state-mutex.released", { label, opId, durationMs });
    resolve(); // Release the next waiter
  }
}

/** Reset state for testing — clears the promise chain */
export function _resetForTesting(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g[MUTEX_KEY] = {
    tail: Promise.resolve(),
    operationCount: 0,
  } satisfies MutexState;
}
