/**
 * Single-flight lock per session and project-level lock for merge serialization.
 *
 * Session locks prevent concurrent prompt executions on the same session.
 * Project locks serialize squash merge operations across sessions within
 * the same project, ensuring only one squash merge targets main at a time.
 *
 * Both use in-memory Maps — if a lock is already held, callers receive
 * an immediate rejection rather than queuing.
 */

import { createLogger, type Logger } from "./logging";
import { getGlobalSingleton } from "./global-singleton";

/* ------------------------------------------------------------------ */
/*  LockManager interface and factory                                 */
/* ------------------------------------------------------------------ */

export interface LockManager {
  isProjectLocked(projectPath: string): boolean;
  acquireProjectLock(projectPath: string): () => void;
  isSessionBusy(projectPath: string, sessionName: string): boolean;
  acquireSessionLock(projectPath: string, sessionName: string): () => void;
  forceReleaseSessionLock(projectPath: string, sessionName: string): boolean;
  getHeldSessionLocks(): Array<{
    projectPath: string;
    sessionName: string;
  }>;
}

/** Create an isolated LockManager instance with its own lock state. */
export function createLockManager(
  log: Logger = createLogger("lock"),
): LockManager {
  const sessionLocks = new Map<string, Promise<void>>();
  const projectLocks = new Map<string, true>();

  function lockKey(projectPath: string, sessionName: string): string {
    return `${projectPath}::${sessionName}`;
  }

  return {
    isProjectLocked(projectPath: string): boolean {
      return projectLocks.has(projectPath);
    },

    acquireProjectLock(projectPath: string): () => void {
      if (projectLocks.has(projectPath)) {
        log.warn("project-lock.rejected", { projectPath });
        throw new Error(
          "Project is locked — a squash merge is already in progress",
        );
      }

      projectLocks.set(projectPath, true);
      log.debug("project-lock.acquired", { projectPath });

      return () => {
        projectLocks.delete(projectPath);
        log.debug("project-lock.released", { projectPath });
      };
    },

    isSessionBusy(projectPath: string, sessionName: string): boolean {
      return sessionLocks.has(lockKey(projectPath, sessionName));
    },

    acquireSessionLock(projectPath: string, sessionName: string): () => void {
      const key = lockKey(projectPath, sessionName);

      if (sessionLocks.has(key)) {
        log.warn("lock.rejected", { projectPath, sessionName });
        throw new Error("Session is busy — a prompt is already running");
      }

      let releaseFn: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });

      sessionLocks.set(key, promise);
      log.debug("lock.acquired", { projectPath, sessionName });

      return () => {
        sessionLocks.delete(key);
        releaseFn?.();
        log.debug("lock.released", { projectPath, sessionName });
      };
    },

    forceReleaseSessionLock(projectPath: string, sessionName: string): boolean {
      const key = lockKey(projectPath, sessionName);
      if (!sessionLocks.has(key)) return false;
      sessionLocks.delete(key);
      log.warn("lock.force_released", { projectPath, sessionName });
      return true;
    },

    getHeldSessionLocks(): Array<{
      projectPath: string;
      sessionName: string;
    }> {
      return Array.from(sessionLocks.keys()).map((key) => {
        const sep = key.indexOf("::");
        return {
          projectPath: key.slice(0, sep),
          sessionName: key.slice(sep + 2),
        };
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Global singleton instance (HMR-safe, backward-compatible)         */
/* ------------------------------------------------------------------ */

const LOCK_MANAGER_KEY = "__cc_lock_manager" as const;

function getDefaultLockManager(): LockManager {
  return getGlobalSingleton(LOCK_MANAGER_KEY, () => createLockManager());
}

/** Check whether a project-level merge lock is currently held */
export function isProjectLocked(projectPath: string): boolean {
  return getDefaultLockManager().isProjectLocked(projectPath);
}

/**
 * Acquire a project-level lock for serializing squash merge operations.
 * Returns a release closure if the lock was acquired.
 * Throws immediately if a lock is already held for this project.
 */
export function acquireProjectLock(projectPath: string): () => void {
  return getDefaultLockManager().acquireProjectLock(projectPath);
}

/** Check whether a session currently has a running prompt */
export function isSessionBusy(
  projectPath: string,
  sessionName: string,
): boolean {
  return getDefaultLockManager().isSessionBusy(projectPath, sessionName);
}

/**
 * Acquire a single-flight lock for a session.
 * Returns a release function if the lock was acquired.
 * Throws if the session is already busy.
 */
export function acquireSessionLock(
  projectPath: string,
  sessionName: string,
): () => void {
  return getDefaultLockManager().acquireSessionLock(projectPath, sessionName);
}

/**
 * Force-release a session lock (for recovery of orphaned locks).
 * Returns true if a lock was released, false if none was held.
 */
export function forceReleaseSessionLock(
  projectPath: string,
  sessionName: string,
): boolean {
  return getDefaultLockManager().forceReleaseSessionLock(
    projectPath,
    sessionName,
  );
}

/** List all currently held session locks (for diagnostics). */
export function getHeldSessionLocks(): Array<{
  projectPath: string;
  sessionName: string;
}> {
  return getDefaultLockManager().getHeldSessionLocks();
}
