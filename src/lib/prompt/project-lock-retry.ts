/**
 * Shared retry helper for acquiring the project-level squash-merge lock.
 *
 * `acquireProjectLock` throws synchronously when the lock is already held.
 * The publish step of Smart Merge (machine actor) and the graph fan-in
 * squash actor both want to wait briefly for a competing merge to finish
 * rather than fail immediately; this helper centralises that polling loop
 * so the two call sites can't drift.
 */

import { createLogger } from "@/lib/logging";

const logger = createLogger("project-lock-retry");

export const DEFAULT_MAX_WAIT_MS = 30_000;
export const DEFAULT_RETRY_MS = 100;

export interface AcquireProjectLockOptions {
  acquireProjectLock: (projectPath: string) => () => void;
  projectPath: string;
  maxWaitMs?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Diagnostic label included in the timeout log; defaults to "publish". */
  callerLabel?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to acquire the project lock, polling every `retryMs` for up to
 * `maxWaitMs`. Returns the release closure once acquired; throws the same
 * "Another merge is in progress" error the underlying lock throws if the
 * wait expires without success.
 */
export async function acquireProjectLockWithRetry(
  options: AcquireProjectLockOptions,
): Promise<() => void> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      return options.acquireProjectLock(options.projectPath);
    } catch {
      await sleep(retryMs);
    }
  }

  logger.warn("project_lock_timeout", {
    projectPath: options.projectPath,
    maxWaitMs,
    callerLabel: options.callerLabel ?? "publish",
  });
  throw new Error(
    "Another merge is in progress for this project. Please retry.",
  );
}
