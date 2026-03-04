/**
 * Workflow snapshot persistence utilities.
 *
 * XState actors produce JSON-serializable snapshots via `getPersistedSnapshot()`.
 * This module handles saving those snapshots to the CC state file and restoring
 * them on startup for workflow recovery.
 *
 * Persistence is debounced to avoid excessive disk writes during rapid transitions.
 */

import type { Snapshot } from "xstate";
import { mutateSession, readState } from "@/lib/state";
import { createLogger } from "@/lib/logging";

const logger = createLogger("workflow-persistence");

/** Debounce timers keyed by `projectPath::sessionName`. */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Persist a workflow snapshot to the session's state.
 * Debounced to avoid excessive writes during rapid state transitions.
 *
 * The snapshot is stored in `session.workflow._xstateSnapshot` (a JSON blob)
 * alongside the existing workflow fields.
 */
export function persistWorkflowSnapshot(
  projectPath: string,
  sessionName: string,
  snapshot: Snapshot<unknown>,
  options?: { debounceMs?: number; immediate?: boolean },
): void {
  const key = `${projectPath}::${sessionName}`;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  // Clear existing timer for this key
  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const doWrite = () => {
    debounceTimers.delete(key);
    void writeSnapshot(projectPath, sessionName, snapshot);
  };

  if (options?.immediate) {
    debounceTimers.delete(key);
    doWrite();
  } else {
    debounceTimers.set(key, setTimeout(doWrite, debounceMs));
  }
}

async function writeSnapshot(
  projectPath: string,
  sessionName: string,
  snapshot: Snapshot<unknown>,
): Promise<void> {
  try {
    await mutateSession(
      projectPath,
      sessionName,
      "persistWorkflowSnapshot",
      (session) => {
        if (session.workflow) {
          // Store the XState snapshot as a JSON-serializable field
          (session.workflow as Record<string, unknown>)._xstateSnapshot =
            snapshot;
        }
      },
    );

    logger.debug("workflow-persistence.snapshot_saved", {
      sessionName,
    });
  } catch (err) {
    logger.error("workflow-persistence.snapshot_save_failed", {
      sessionName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Restore a workflow snapshot from persisted state.
 * Returns the snapshot if found and schema version matches, null otherwise.
 */
export async function restoreWorkflowSnapshot(
  projectPath: string,
  sessionName: string,
  expectedSchemaVersion: number,
): Promise<Snapshot<unknown> | null> {
  try {
    const state = await readState();
    const project = state.projects[projectPath];
    if (!project) return null;

    const session = project.sessions[sessionName];
    if (!session?.workflow) return null;

    const snapshot = (session.workflow as Record<string, unknown>)
      ._xstateSnapshot as Snapshot<unknown> | undefined;
    if (!snapshot) return null;

    // Check schema version in the snapshot context
    const context = (snapshot as { context?: { _schemaVersion?: number } })
      .context;
    if (context?._schemaVersion !== expectedSchemaVersion) {
      logger.warn("workflow-persistence.schema_mismatch", {
        sessionName,
        expected: expectedSchemaVersion,
        actual: context?._schemaVersion,
      });
      return null;
    }

    logger.info("workflow-persistence.snapshot_restored", {
      sessionName,
    });

    return snapshot;
  } catch (err) {
    logger.error("workflow-persistence.snapshot_restore_failed", {
      sessionName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Flush any pending debounced writes immediately.
 * Useful for testing or graceful shutdown.
 */
export function flushPendingWrites(): void {
  for (const [key, timer] of debounceTimers) {
    clearTimeout(timer);
    debounceTimers.delete(key);
    void key; // Timer callback already captured the write closure
  }
}

/** Reset state for testing — do not use in production. */
export function _resetForTesting(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}
