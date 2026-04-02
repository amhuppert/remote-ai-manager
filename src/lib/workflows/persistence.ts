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

// ============================================================
// Dependency Injection (kept for API compatibility with tests)
// ============================================================

export interface PersistenceDeps {
  mutateSession: (...args: unknown[]) => Promise<void>;
  readState: () => Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setPersistenceDeps(_deps: PersistenceDeps): void {
  // No-op — legacy DI surface kept for test compatibility
}

export function _resetPersistenceDepsForTesting(): void {
  // No-op
}

/**
 * Persist a workflow snapshot to the session's state.
 * Debounced to avoid excessive writes during rapid state transitions.
 *
 * Note: This is the generic default implementation used by `actions.ts`.
 * The conversation workflow machine overrides this with its own implementation
 * that persists to the conversation-level snapshot field.
 */
export function persistWorkflowSnapshot(
  _projectPath: string,
  _sessionName: string,
  _snapshot: Snapshot<unknown>,
  _options?: { debounceMs?: number; immediate?: boolean },
): void {
  // No-op: Ralph Loop workflow (which stored snapshots in session.workflow)
  // has been removed. The conversation workflow overrides this action with
  // its own implementation via .provide().
}

/**
 * Restore a workflow snapshot from persisted state.
 * Returns null — the legacy storage location (session.workflow) no longer exists.
 */
export async function restoreWorkflowSnapshot(
  _projectPath: string,
  _sessionName: string,
  _expectedSchemaVersion: number,
): Promise<Snapshot<unknown> | null> {
  return null;
}

/**
 * Flush any pending debounced writes immediately.
 * No-op since snapshot persistence was removed with Ralph Loop.
 */
export function flushPendingWrites(): void {
  // No-op
}

/** Reset state for testing — do not use in production. */
export function _resetForTesting(): void {
  _resetPersistenceDepsForTesting();
}
