/**
 * In-memory registry tracking running workflow loops for pause/abort signaling.
 * Uses globalThis singleton for HMR safety (same pattern as session locks).
 */

import { getGlobalSingleton } from "../global-singleton";

const GLOBAL_KEY = "__cc_running_workflows" as const;

export interface RunningWorkflow {
  projectPath: string;
  sessionName: string;
  abortController: AbortController;
  pauseRequested: boolean;
}

function getRegistry(): Map<string, RunningWorkflow> {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () => new Map<string, RunningWorkflow>(),
  );
}

function makeKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

export function register(
  projectPath: string,
  sessionName: string,
  entry: RunningWorkflow,
): void {
  getRegistry().set(makeKey(projectPath, sessionName), entry);
}

export function get(
  projectPath: string,
  sessionName: string,
): RunningWorkflow | undefined {
  return getRegistry().get(makeKey(projectPath, sessionName));
}

export function remove(projectPath: string, sessionName: string): void {
  getRegistry().delete(makeKey(projectPath, sessionName));
}

export function requestPause(
  projectPath: string,
  sessionName: string,
): boolean {
  const entry = get(projectPath, sessionName);
  if (!entry) return false;
  entry.pauseRequested = true;
  return true;
}

export function requestAbort(
  projectPath: string,
  sessionName: string,
): boolean {
  const entry = get(projectPath, sessionName);
  if (!entry) return false;
  entry.abortController.abort();
  return true;
}

/** Reset for testing — clears all entries */
export function _resetForTesting(): void {
  getRegistry().clear();
}
