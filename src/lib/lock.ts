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

import { createLogger } from "./logging";
import { getGlobalSingleton } from "./global-singleton";

const logger = createLogger("lock");

/* ------------------------------------------------------------------ */
/*  Session-level lock (HMR-safe via globalThis singleton)            */
/* ------------------------------------------------------------------ */

const SESSION_LOCK_KEY = "__cc_session_locks" as const;

function getSessionLocks(): Map<string, Promise<void>> {
  return getGlobalSingleton(
    SESSION_LOCK_KEY,
    () => new Map<string, Promise<void>>(),
  );
}

/* ------------------------------------------------------------------ */
/*  Project-level lock (HMR-safe via globalThis singleton)            */
/* ------------------------------------------------------------------ */

const PROJECT_LOCK_KEY = "__cc_project_locks" as const;

function getProjectLocks(): Map<string, true> {
  return getGlobalSingleton(PROJECT_LOCK_KEY, () => new Map<string, true>());
}

/** Check whether a project-level merge lock is currently held */
export function isProjectLocked(projectPath: string): boolean {
  return getProjectLocks().has(projectPath);
}

/**
 * Acquire a project-level lock for serializing squash merge operations.
 * Returns a release closure if the lock was acquired.
 * Throws immediately if a lock is already held for this project.
 */
export function acquireProjectLock(projectPath: string): () => void {
  const locks = getProjectLocks();

  if (locks.has(projectPath)) {
    logger.warn("project-lock.rejected", { projectPath });
    throw new Error(
      "Project is locked — a squash merge is already in progress",
    );
  }

  locks.set(projectPath, true);
  logger.debug("project-lock.acquired", { projectPath });

  return () => {
    locks.delete(projectPath);
    logger.debug("project-lock.released", { projectPath });
  };
}

/**
 * Build a canonical lock key for a session.
 * Uses projectPath + sessionName to guarantee uniqueness.
 */
function lockKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

/** Check whether a session currently has a running prompt */
export function isSessionBusy(
  projectPath: string,
  sessionName: string,
): boolean {
  return getSessionLocks().has(lockKey(projectPath, sessionName));
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
  const key = lockKey(projectPath, sessionName);
  const locks = getSessionLocks();

  if (locks.has(key)) {
    logger.warn("lock.rejected", {
      projectPath,
      sessionName,
    });
    throw new Error("Session is busy — a prompt is already running");
  }

  let releaseFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  locks.set(key, promise);
  logger.debug("lock.acquired", { projectPath, sessionName });

  return () => {
    locks.delete(key);
    releaseFn?.();
    logger.debug("lock.released", { projectPath, sessionName });
  };
}

/**
 * Force-release a session lock (for recovery of orphaned locks).
 * Returns true if a lock was released, false if none was held.
 */
export function forceReleaseSessionLock(
  projectPath: string,
  sessionName: string,
): boolean {
  const key = lockKey(projectPath, sessionName);
  const locks = getSessionLocks();
  if (!locks.has(key)) return false;
  locks.delete(key);
  logger.warn("lock.force_released", { projectPath, sessionName });
  return true;
}

/** List all currently held session locks (for diagnostics). */
export function getHeldSessionLocks(): Array<{
  projectPath: string;
  sessionName: string;
}> {
  const locks = getSessionLocks();
  return Array.from(locks.keys()).map((key) => {
    const sep = key.indexOf("::");
    return {
      projectPath: key.slice(0, sep),
      sessionName: key.slice(sep + 2),
    };
  });
}
