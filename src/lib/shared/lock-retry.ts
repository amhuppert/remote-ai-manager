/**
 * Shared bounded-poll retry for CC's synchronous keyed locks.
 *
 * Both the project-level squash-merge lock and the per-session git lock throw
 * synchronously when already held. Callers that want to wait briefly for a
 * competing holder to finish — the Smart Merge publish step, the graph fan-in
 * squash actor, and graph git operations sharing a session with user
 * commit/merge jobs — poll through this module so the retry constants and
 * loop cannot drift between call sites.
 */

import { createLogger } from "@/lib/logging";
import { sleep } from "@/lib/shared/sleep";

const logger = createLogger("lock-retry");

export const DEFAULT_MAX_WAIT_MS = 30_000;
export const DEFAULT_RETRY_MS = 100;

export interface LockRetryPolicy {
  /** Bounded retry budget while another holder owns the lock. */
  maxWaitMs?: number;
  /** Backoff between retry attempts. */
  retryMs?: number;
  /** For tests: override the sleep used between retries. */
  sleep?(ms: number): Promise<void>;
}

/** Single synchronous attempt; undefined while the lock is held. */
function tryAcquire(acquire: () => () => void): (() => void) | undefined {
  try {
    return acquire();
  } catch {
    return undefined;
  }
}

/**
 * Retry loop entered after a failed first attempt: sleeps `retryMs`, then
 * retries, until `maxWaitMs` has elapsed since `start`. Returns the release
 * closure once acquired, or undefined when the wait expires so the caller
 * can shape its own timeout error. The deadline is rechecked after each
 * sleep, before the attempt, so an acquire never lands past `maxWaitMs`
 * even when a sleep overshoots the remaining budget.
 *
 * The first attempt stays outside this loop (see the `tryAcquire(...) ??`
 * pattern at the call sites) so an uncontended acquire completes without
 * suspending — callers that enter a critical section in the same tick as
 * the call rely on that.
 */
async function pollAcquire(
  acquire: () => () => void,
  policy: LockRetryPolicy,
  start: number,
): Promise<(() => void) | undefined> {
  const maxWaitMs = policy.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryMs = policy.retryMs ?? DEFAULT_RETRY_MS;
  const wait = policy.sleep ?? sleep;

  while (Date.now() - start < maxWaitMs) {
    await wait(retryMs);
    if (Date.now() - start >= maxWaitMs) {
      return undefined;
    }
    const release = tryAcquire(acquire);
    if (release) {
      return release;
    }
  }

  return undefined;
}

export interface AcquireProjectLockOptions extends LockRetryPolicy {
  acquireProjectLock(projectPath: string): () => void;
  projectPath: string;
  /** Diagnostic label included in the timeout log; defaults to "publish". */
  callerLabel?: string;
}

/**
 * Try to acquire the project lock, polling until acquired. Returns the
 * release closure once acquired; throws the same "Another merge is in
 * progress" error the underlying lock throws if the wait expires without
 * success.
 */
export async function acquireProjectLockWithRetry(
  options: AcquireProjectLockOptions,
): Promise<() => void> {
  const acquire = () => options.acquireProjectLock(options.projectPath);
  const start = Date.now();
  const release =
    tryAcquire(acquire) ?? (await pollAcquire(acquire, options, start));
  if (release) {
    return release;
  }

  logger.warn("project_lock_timeout", {
    projectPath: options.projectPath,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    callerLabel: options.callerLabel ?? "publish",
  });
  throw new Error(
    "Another merge is in progress for this project. Please retry.",
  );
}

export interface SessionGitLockKey {
  projectPath: string;
  sessionName: string;
}

export interface SessionGitLock {
  withSessionGitLock<T>(
    key: SessionGitLockKey,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface SessionGitLockDeps extends LockRetryPolicy {
  /**
   * Production callers must pass the global lock manager's
   * `acquireSessionLock` so graph git operations share state with user
   * commit/merge jobs on the same session.
   */
  acquireSessionLock(projectPath: string, sessionName: string): () => void;
}

export function createSessionGitLock(deps: SessionGitLockDeps): SessionGitLock {
  return {
    async withSessionGitLock<T>(
      key: SessionGitLockKey,
      fn: () => Promise<T>,
    ): Promise<T> {
      const acquire = () =>
        deps.acquireSessionLock(key.projectPath, key.sessionName);
      const start = Date.now();
      const release =
        tryAcquire(acquire) ?? (await pollAcquire(acquire, deps, start));

      if (!release) {
        const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
        logger.warn("session_lock_timeout", {
          projectPath: key.projectPath,
          sessionName: key.sessionName,
          maxWaitMs,
        });
        throw new Error(
          `Timed out waiting for session git lock on ${key.projectPath}::${key.sessionName} after ${maxWaitMs}ms`,
        );
      }

      logger.debug("session_lock_acquired", {
        projectPath: key.projectPath,
        sessionName: key.sessionName,
      });

      try {
        return await fn();
      } finally {
        release();
        logger.debug("session_lock_released", {
          projectPath: key.projectPath,
          sessionName: key.sessionName,
        });
      }
    },
  };
}
