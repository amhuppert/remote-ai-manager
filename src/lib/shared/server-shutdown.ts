import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "./errors";

const logger = createLogger("server-shutdown");

const DEFAULT_DEADLINE_MS = 15_000;
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
type ShutdownSignal = keyof typeof EXIT_CODES;

export interface ServerShutdownDeps {
  source: {
    once(signal: ShutdownSignal, listener: () => void): unknown;
  };
  /** Ends open event streams; returns how many were closed. */
  closeEventStreams(): number;
  /** Must not keep the event loop alive (production unrefs the timer). */
  armExitTimer(callback: () => void, ms: number): void;
  exit(code: number): void;
  deadlineMs?: number;
}

/**
 * Makes a terminating signal actually end the server process.
 *
 * `next start` exits only after `server.close()` completes, which waits for
 * every in-flight response. Long-lived responses (SSE) never finish on their
 * own, so the process would stop listening yet live on, still owning the state
 * database and blocking the next server's startup. On the signal this closes
 * the event streams so Next's drain can finish, and arms a deadline that
 * force-exits if anything else holds the drain open. The timer is unref'd, so
 * a clean drain exits long before it fires.
 */
export function installServerShutdownGuard(deps: ServerShutdownDeps): void {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    deps.source.once(signal, () => {
      try {
        const closedStreams = deps.closeEventStreams();
        logger.info("server_shutdown.event_streams_closed", {
          signal,
          closedStreams,
        });
      } catch (err: unknown) {
        logger.error("server_shutdown.event_streams_close_failed", {
          signal,
          error: getErrorMessage(err),
        });
      }
      deps.armExitTimer(() => {
        logger.warn("server_shutdown.deadline_exceeded", {
          signal,
          deadlineMs,
        });
        deps.exit(EXIT_CODES[signal]);
      }, deadlineMs);
    });
  }
}

export function installServerShutdownGuardForProcess(
  closeEventStreams: () => number,
): void {
  installServerShutdownGuard({
    source: process,
    closeEventStreams,
    armExitTimer: (callback, ms) => {
      setTimeout(callback, ms).unref();
    },
    exit: (code) => process.exit(code),
  });
}
