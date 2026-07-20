/**
 * FIFO async serialization for write operations against the structured store.
 *
 * Pure scheduling primitive — decoupled from any file path or DB connection.
 * Each call appends to a chained-promise tail so callbacks run exactly once
 * the previous tick has settled. A rejection in the callback propagates to
 * the caller but does not poison the chain — subsequent ticks still run.
 */

import { createLogger } from "@/lib/logging";
import { getGlobalSingleton } from "../shared/global-singleton";

const logger = createLogger("state-store.write-queue");

const WRITE_QUEUE_KEY = "__cc_state_store_write_queue" as const;

export interface WriteQueue {
  withWriteQueue<T>(label: string, fn: () => Promise<T>): Promise<T>;
  tryWithWriteQueue<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  _resetForTesting(): void;
}

export function createWriteQueue(): WriteQueue {
  let tail: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  async function withWriteQueue<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    pendingCount += 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const predecessor = tail;
    tail = gate;

    const enqueuedAt = performance.now();
    await predecessor;
    const acquiredAt = performance.now();

    try {
      return await fn();
    } finally {
      const releasedAt = performance.now();
      logger.info("state-store.write_queue.timing", {
        label,
        durationMs: +(releasedAt - enqueuedAt).toFixed(2),
        waitMs: +(acquiredAt - enqueuedAt).toFixed(2),
        holdMs: +(releasedAt - acquiredAt).toFixed(2),
      });
      pendingCount -= 1;
      release();
    }
  }

  async function tryWithWriteQueue<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (pendingCount > 0) {
      logger.info("state-store.write_queue.try_contended", { label });
      return { acquired: false };
    }

    pendingCount += 1;
    const startedAt = performance.now();
    try {
      return { acquired: true, value: await fn() };
    } finally {
      pendingCount -= 1;
      logger.info("state-store.write_queue.try_timing", {
        label,
        durationMs: +(performance.now() - startedAt).toFixed(2),
      });
    }
  }

  return {
    withWriteQueue,
    tryWithWriteQueue,
    _resetForTesting() {
      tail = Promise.resolve();
      pendingCount = 0;
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

export function tryWithWriteQueue<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return getSharedQueue().tryWithWriteQueue(label, fn);
}

export function _resetForTesting(): void {
  getSharedQueue()._resetForTesting();
}
