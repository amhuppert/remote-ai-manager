/**
 * Whole-process event-loop stall sentinel.
 *
 * A slow state-store read whose own SQLite queries were fast was blocked by
 * something outside its own call stack. This sampler is the instrument that can
 * say so: it schedules a fixed-interval timer and measures how far past its
 * scheduled fire time the callback actually ran. That overshoot is time the loop
 * spent unable to run anything — GC, a synchronous block, or host CPU
 * contention. Every emitted line runs inside its own trace, so a stall can be
 * joined against the read timings that share its wall-clock window.
 *
 * THRESHOLD DISCIPLINE. The logger writes each line with a synchronous
 * `appendFileSync`, so an instrument that emitted on every small overshoot would
 * add synchronous filesystem work to the exact path it reports as starved. Two
 * rules keep it cheap: the threshold defaults far above ordinary timer jitter,
 * and a run of consecutive stalled ticks emits at its onset and once more when
 * it ends (carrying `consecutiveTicks` and the largest overshoot in the run)
 * rather than once per tick.
 *
 * Configuration:
 * - `CC_EVENT_LOOP_SENTINEL_MS` (default 1000) — sampling interval
 * - `CC_EVENT_LOOP_STALL_MS` (default 250) — minimum overshoot that is a stall
 *
 * Nothing here runs at import time: the interval exists only after
 * `startEventLoopStallSentinel()`, which server startup calls.
 */

import { setInterval as scheduleInterval, clearInterval } from "node:timers";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { runAsTrace } from "./context";
import { createLogger, type Logger } from "./logger";

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_THRESHOLD_MS = 250;

const STALL_EVENT = "runtime.event_loop.stall";
const STALL_TRACE_ACTION = "sentinel:event-loop";

const logger = createLogger("runtime");

let cachedIntervalMs: number | undefined;
let cachedThresholdMs: number | undefined;

function readNumberEnv(
  name: string,
  defaultValue: number,
  min: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return defaultValue;
  return parsed;
}

/** Sampling interval in milliseconds (`CC_EVENT_LOOP_SENTINEL_MS`). */
export function getEventLoopSentinelIntervalMs(): number {
  if (cachedIntervalMs === undefined) {
    // A zero or negative interval would busy-spin the loop this sampler exists
    // to observe, so it falls back to the default rather than honouring it.
    cachedIntervalMs = readNumberEnv(
      "CC_EVENT_LOOP_SENTINEL_MS",
      DEFAULT_INTERVAL_MS,
      1,
    );
  }
  return cachedIntervalMs;
}

/** Minimum overshoot counted as a stall (`CC_EVENT_LOOP_STALL_MS`). */
export function getEventLoopStallThresholdMs(): number {
  if (cachedThresholdMs === undefined) {
    cachedThresholdMs = readNumberEnv(
      "CC_EVENT_LOOP_STALL_MS",
      DEFAULT_THRESHOLD_MS,
      0,
    );
  }
  return cachedThresholdMs;
}

/**
 * The scheduler handle. `unref` is optional so a test scheduler need not model
 * it; production hands over a `NodeJS.Timeout`, which has one.
 */
export interface EventLoopStallTimerHandle {
  unref?(): void;
}

export interface EventLoopStallSentinelDeps<
  THandle extends EventLoopStallTimerHandle,
> {
  logger: Logger;
  setInterval(callback: () => void, ms: number): THandle;
  clearInterval(handle: THandle): void;
  now(): number;
  intervalMs: number;
  thresholdMs: number;
}

export interface EventLoopStallSentinel {
  /** Begin sampling. A second call while running is a no-op. */
  start(): void;
  /** Cancel sampling. Safe to call when not running. */
  stop(): void;
}

export function createEventLoopStallSentinel<
  THandle extends EventLoopStallTimerHandle,
>(deps: EventLoopStallSentinelDeps<THandle>): EventLoopStallSentinel {
  const { logger: sentinelLogger, now, intervalMs, thresholdMs } = deps;

  let handle: THandle | undefined;
  let expectedAt = 0;
  let consecutiveTicks = 0;
  let maxLagMs = 0;

  function emit(lagMs: number, ticks: number): void {
    runAsTrace(STALL_TRACE_ACTION, () => {
      sentinelLogger.info(STALL_EVENT, {
        lagMs,
        consecutiveTicks: ticks,
        intervalMs,
        thresholdMs,
      });
    });
  }

  function tick(): void {
    const firedAt = now();
    const lagMs = firedAt - expectedAt;
    // Next expectation rides on when this tick actually ran: a single long
    // stall must not make every later tick look late.
    expectedAt = firedAt + intervalMs;

    if (lagMs >= thresholdMs) {
      consecutiveTicks += 1;
      maxLagMs = Math.max(maxLagMs, lagMs);
      // Only the onset is reported live; the rest of the run is summarized when
      // it ends, so a multi-minute stall costs two lines rather than hundreds.
      if (consecutiveTicks === 1) emit(lagMs, consecutiveTicks);
      return;
    }

    if (consecutiveTicks > 1) emit(maxLagMs, consecutiveTicks);
    consecutiveTicks = 0;
    maxLagMs = 0;
  }

  return {
    start() {
      if (handle !== undefined) return;
      expectedAt = now() + intervalMs;
      consecutiveTicks = 0;
      maxLagMs = 0;
      handle = deps.setInterval(tick, intervalMs);
      // A diagnostic sampler must never be a reason for the process to stay
      // alive: an un-unref'd interval hangs `next build` and any Vitest worker
      // that imports the starter.
      handle.unref?.();
    },
    stop() {
      if (handle === undefined) return;
      deps.clearInterval(handle);
      handle = undefined;
    },
  };
}

interface EventLoopStallSentinelHost {
  sentinel: EventLoopStallSentinel | null;
}

function hostState(): EventLoopStallSentinelHost {
  return getGlobalSingleton<EventLoopStallSentinelHost>(
    "__cc_event_loop_stall_sentinel",
    () => ({ sentinel: null }),
  );
}

/** Start the process-wide sentinel. Idempotent. */
export function startEventLoopStallSentinel(): void {
  const host = hostState();
  if (host.sentinel) return;
  const sentinel = createEventLoopStallSentinel<NodeJS.Timeout>({
    logger,
    setInterval: (callback, ms) => scheduleInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle),
    // Monotonic: a wall-clock jump would otherwise read as a stall.
    now: () => performance.now(),
    intervalMs: getEventLoopSentinelIntervalMs(),
    thresholdMs: getEventLoopStallThresholdMs(),
  });
  sentinel.start();
  host.sentinel = sentinel;
}

/** Test-only: the globalThis-hosted state, for identity checks. */
export function _eventLoopStallSentinelHostForTesting(): EventLoopStallSentinelHost {
  return hostState();
}

/** Test-only: stop the sentinel, drop it, and clear cached env reads. */
export function _resetEventLoopStallSentinelForTesting(): void {
  const host = hostState();
  host.sentinel?.stop();
  host.sentinel = null;
  cachedIntervalMs = undefined;
  cachedThresholdMs = undefined;
}
