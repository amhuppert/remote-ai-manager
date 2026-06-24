/**
 * Counting semaphore to limit concurrent SDK query() calls.
 *
 * Prevents OOM crashes by ensuring at most N Claude Code child processes
 * run simultaneously. When the limit is reached, new queries wait in a
 * FIFO queue until a slot opens.
 *
 * HMR-safe via globalThis singleton (same pattern as lock.ts, sse-broadcaster.ts).
 */

import { readConfig } from "../config/loader";
import { createLogger } from "../logging";
import { getGlobalSingleton } from "./global-singleton";

const logger = createLogger("query-semaphore");

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

interface SemaphoreState {
  active: number;
  queue: Waiter[];
  limit: number;
}

const GLOBAL_KEY = "__cc_query_semaphore" as const;

function getState(): SemaphoreState {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () =>
      ({
        active: 0,
        queue: [] as Waiter[],
        limit: DEFAULT_MAX_CONCURRENT,
      }) satisfies SemaphoreState,
  );
}

/**
 * Acquire a semaphore slot. Returns a release function.
 * If at capacity, waits in a FIFO queue until a slot opens or timeout expires.
 *
 * @param label - Descriptive label for logging (e.g. "prompt:sessionName")
 */
export async function acquireQuerySlot(label: string): Promise<() => void> {
  const state = getState();

  // Lazy-load limit from config on first call
  await refreshLimit();

  if (state.active < state.limit) {
    state.active++;
    logger.info("semaphore.acquired", {
      label,
      active: state.active,
      limit: state.limit,
      waiting: state.queue.length,
    });
    return createRelease(label);
  }

  // At capacity — enqueue
  logger.warn("semaphore.queued", {
    label,
    active: state.active,
    limit: state.limit,
    waiting: state.queue.length + 1,
  });

  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove from queue on timeout
      const idx = state.queue.findIndex((w) => w.timer === timer);
      if (idx !== -1) state.queue.splice(idx, 1);
      logger.error("semaphore.timeout", {
        label,
        active: state.active,
        waiting: state.queue.length,
      });
      reject(
        new Error(
          `Query semaphore timeout after ${DEFAULT_QUEUE_TIMEOUT_MS}ms waiting for slot (label: ${label})`,
        ),
      );
    }, DEFAULT_QUEUE_TIMEOUT_MS);

    const waiter: Waiter = {
      resolve: () => {
        clearTimeout(timer);
        state.active++;
        logger.info("semaphore.acquired_from_queue", {
          label,
          active: state.active,
          limit: state.limit,
          waiting: state.queue.length,
        });
        resolve(createRelease(label));
      },
      reject,
      timer,
      label,
    };

    state.queue.push(waiter);
  });
}

function createRelease(label: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;

    const state = getState();
    state.active--;

    logger.info("semaphore.released", {
      label,
      active: state.active,
      limit: state.limit,
      waiting: state.queue.length,
    });

    // Unblock next waiter
    if (state.queue.length > 0) {
      const next = state.queue.shift()!;
      next.resolve();
    }
  };
}

/**
 * Resolve the SDK query-concurrency limit from config — the same value the
 * semaphore enforces. Never throws: returns DEFAULT_MAX_CONCURRENT on a config
 * read failure so callers can use it to size work without guarding. This is the
 * single source of truth for the configured limit shared with consumers (e.g.
 * the graph-workflow execution loop, which bounds each parallel scheduling pass
 * to it so the workflow never over-subscribes this semaphore).
 */
export async function getConfiguredQueryConcurrency(): Promise<number> {
  try {
    const config = await readConfig();
    return config.maxConcurrentQueries ?? DEFAULT_MAX_CONCURRENT;
  } catch {
    return DEFAULT_MAX_CONCURRENT;
  }
}

/** Read the configured limit from config (lazy, best-effort). */
async function refreshLimit(): Promise<void> {
  try {
    const config = await readConfig();
    const state = getState();
    state.limit = config.maxConcurrentQueries ?? DEFAULT_MAX_CONCURRENT;
  } catch {
    // Keep existing limit on config read failure
  }
}

/** Get current semaphore status for diagnostics. */
export function getQuerySemaphoreStatus(): {
  active: number;
  waiting: number;
  limit: number;
} {
  const state = getState();
  return {
    active: state.active,
    waiting: state.queue.length,
    limit: state.limit,
  };
}
