/**
 * External runtime state registry for non-serializable data.
 *
 * XState snapshots must be JSON-serializable. AbortControllers, lock release
 * functions, stream controllers, etc. cannot live in machine context.
 * Instead, we store them in an external Map keyed by a workflow identifier
 * (typically `${projectPath}::${sessionName}`).
 *
 * Lifecycle:
 * - Created when a workflow actor starts
 * - Cleaned up when the actor reaches a terminal state
 */

export interface RuntimeState {
  /** AbortController for cancelling in-flight SDK queries. */
  abortController: AbortController;

  /** Optional lock release function (e.g., project lock for merge). */
  releaseLock?: () => void;

  /** Arbitrary extra data a workflow may need at runtime. */
  extra?: Record<string, unknown>;
}

const GLOBAL_KEY = "__cc_workflow_runtime_state" as const;

function getRegistry(): Map<string, RuntimeState> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, RuntimeState>();
  }
  return g[GLOBAL_KEY] as Map<string, RuntimeState>;
}

/** Build a consistent key for a workflow instance. */
export function workflowKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

/** Register runtime state for a workflow. */
export function registerRuntime(key: string, state: RuntimeState): void {
  getRegistry().set(key, state);
}

/** Retrieve runtime state for a workflow. */
export function getRuntime(key: string): RuntimeState | undefined {
  return getRegistry().get(key);
}

/** Remove runtime state and abort any in-flight operations. */
export function cleanupRuntime(key: string): void {
  const state = getRegistry().get(key);
  if (state) {
    state.abortController.abort();
    state.releaseLock?.();
    getRegistry().delete(key);
  }
}

/** Check if a workflow has active runtime state. */
export function hasRuntime(key: string): boolean {
  return getRegistry().has(key);
}

/** Get all registered workflow keys (for diagnostics). */
export function getRegisteredKeys(): string[] {
  return [...getRegistry().keys()];
}

/** Reset state for testing — do not use in production. */
export function _resetForTesting(): void {
  getRegistry().clear();
}
