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

export interface QuerySemaphoreDeps {
  readConfig(): Promise<{ maxConcurrentQueries?: number }>;
}
let deps: QuerySemaphoreDeps = { readConfig };
export function setQuerySemaphoreDeps(value: QuerySemaphoreDeps): void {
  deps = value;
}
export function resetQuerySemaphoreDeps(): void {
  deps = { readConfig };
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The stable marker for "this call never got a slot".
 *
 * Embedded in the message as well as carried by the error type because the
 * rejection crosses boundaries that keep only the text — a workflow task run
 * surfaces its failure as a string — and the distinction it encodes matters
 * most on the far side of those boundaries.
 */
export const QUERY_SLOT_ADMISSION_TIMEOUT_CODE = "QUERY_SLOT_ADMISSION_TIMEOUT";

/**
 * Waiting for a slot expired before one opened. Deliberately its own type: a
 * caller retrying work needs to tell queue pressure — where nothing ran and
 * nothing is known to be wrong — apart from a run that started and failed.
 */
export class QuerySlotAdmissionTimeoutError extends Error {
  readonly code = QUERY_SLOT_ADMISSION_TIMEOUT_CODE;

  constructor(label: string, timeoutMs: number) {
    super(
      `Query semaphore timeout after ${timeoutMs}ms waiting for slot (label: ${label}) [${QUERY_SLOT_ADMISSION_TIMEOUT_CODE}]`,
    );
    this.name = "QuerySlotAdmissionTimeoutError";
  }
}

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
export async function acquireQuerySlot(
  label: string,
  options?: { signal?: AbortSignal },
): Promise<() => void> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const state = getState();

  // Lazy-load limit from config on first call
  await refreshLimit();
  signal?.throwIfAborted();

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

  const release = await new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const index = state.queue.indexOf(waiter);
      if (index !== -1) state.queue.splice(index, 1);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => {
      logger.info("semaphore.cancelled", {
        label,
        active: state.active,
        waiting: state.queue.length,
      });
      fail(new DOMException("Query slot acquisition cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      // Remove from queue on timeout
      logger.error("semaphore.timeout", {
        label,
        active: state.active,
        waiting: state.queue.length,
      });
      fail(new QuerySlotAdmissionTimeoutError(label, DEFAULT_QUEUE_TIMEOUT_MS));
    }, DEFAULT_QUEUE_TIMEOUT_MS);

    const waiter: Waiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        cleanup();
        state.active++;
        logger.info("semaphore.acquired_from_queue", {
          label,
          active: state.active,
          limit: state.limit,
          waiting: state.queue.length,
        });
        resolve(createRelease(label));
      },
      reject: fail,
      timer,
      label,
    };
    state.queue.push(waiter);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  if (signal?.aborted) {
    release();
    signal.throwIfAborted();
  }
  return release;
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
    const config = await deps.readConfig();
    return config.maxConcurrentQueries ?? DEFAULT_MAX_CONCURRENT;
  } catch {
    return DEFAULT_MAX_CONCURRENT;
  }
}

/** Read the configured limit from config (lazy, best-effort). */
async function refreshLimit(): Promise<void> {
  try {
    const config = await deps.readConfig();
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
