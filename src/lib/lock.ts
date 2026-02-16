/**
 * Single-flight lock per session.
 *
 * Prevents concurrent prompt executions on the same session.
 * Uses an in-memory Map of promises — if a session is already
 * executing a prompt, callers receive a "busy" rejection rather
 * than queuing a second invocation.
 */

import { createLogger } from "./logging";

const logger = createLogger("lock");

const activeLocks = new Map<string, Promise<void>>();

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
  return activeLocks.has(lockKey(projectPath, sessionName));
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

  if (activeLocks.has(key)) {
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

  activeLocks.set(key, promise);
  logger.debug("lock.acquired", { projectPath, sessionName });

  return () => {
    activeLocks.delete(key);
    releaseFn?.();
    logger.debug("lock.released", { projectPath, sessionName });
  };
}
