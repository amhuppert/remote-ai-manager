import { createLogger } from "@/lib/logging";
import {
  acquireSessionLock as defaultAcquireSessionLock,
  type LockManager,
} from "@/lib/lock";

const logger = createLogger("graph-workflow-session-git-lock");

const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_RETRY_MS = 100;

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

export interface SessionGitLockDeps {
  /**
   * Either a full LockManager (preferred — exposes acquireSessionLock) or
   * a bare `acquireSessionLock` function. Defaults to the global lock manager
   * adapter so production callers share state with user commit/merge jobs.
   */
  lockManager?: Pick<LockManager, "acquireSessionLock">;
  acquireSessionLock?: (projectPath: string, sessionName: string) => () => void;
  /** Bounded retry budget while another holder owns the same session lock. */
  maxWaitMs?: number;
  /** Backoff between retry attempts. */
  retryMs?: number;
  /** For tests: override the sleep used between retries. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionGitLock(
  deps: SessionGitLockDeps = {},
): SessionGitLock {
  const acquire =
    deps.acquireSessionLock ??
    deps.lockManager?.acquireSessionLock.bind(deps.lockManager) ??
    defaultAcquireSessionLock;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const sleep = deps.sleep ?? defaultSleep;

  return {
    async withSessionGitLock<T>(
      key: SessionGitLockKey,
      fn: () => Promise<T>,
    ): Promise<T> {
      const start = Date.now();
      let release: (() => void) | undefined;

      while (Date.now() - start < maxWaitMs) {
        try {
          release = acquire(key.projectPath, key.sessionName);
          break;
        } catch {
          await sleep(retryMs);
        }
      }

      if (!release) {
        logger.warn("acquire_timeout", {
          projectPath: key.projectPath,
          sessionName: key.sessionName,
          maxWaitMs,
        });
        throw new Error(
          `Timed out waiting for session git lock on ${key.projectPath}::${key.sessionName} after ${maxWaitMs}ms`,
        );
      }

      logger.debug("acquired", {
        projectPath: key.projectPath,
        sessionName: key.sessionName,
      });

      try {
        return await fn();
      } finally {
        release();
        logger.debug("released", {
          projectPath: key.projectPath,
          sessionName: key.sessionName,
        });
      }
    },
  };
}
