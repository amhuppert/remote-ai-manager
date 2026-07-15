import { createLogger } from "@/lib/logging";
import { getGlobalSingleton } from "./global-singleton";

/**
 * The one process-wide registry for live abort handles.
 *
 * Long-running work (a conversation turn, a background agent run, a workflow
 * slice) is observable through durable state, but its cancellation handle — an
 * AbortController — cannot serialize. Every domain used to keep its own
 * globalThis/module map for these; this registry replaces them with a single
 * HMR-safe map keyed by `<scope>:<id>` so a new cancellable work shape needs a
 * key, not a new registry.
 *
 * Domain semantics stay at the edges: conversations pair abort with a backend
 * runtime close, agent-runs infer "user cancelled" from `signal.aborted`,
 * collaboration retains an aborted handle so a slice can observe the stop
 * between rounds. The registry only owns the shared storage and the
 * compare-and-delete teardown discipline.
 */

const logger = createLogger("abort-registry");

export type AbortScope = "conversation" | "agent-run" | "workflow";
export type AbortHandleKey = `${AbortScope}:${string}`;

const GLOBAL_KEY = "__cc_abort_handles" as const;

function getRegistry(): Map<AbortHandleKey, AbortController> {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () => new Map<AbortHandleKey, AbortController>(),
  );
}

/** Register the live controller for `key`, replacing any previous one. */
export function registerAbortHandle(
  key: AbortHandleKey,
  controller: AbortController,
): void {
  getRegistry().set(key, controller);
  logger.debug("abort.registered", { key });
}

/** The live controller for `key`, or null when none is registered. */
export function getAbortHandle(key: AbortHandleKey): AbortController | null {
  return getRegistry().get(key) ?? null;
}

/**
 * Compare-and-delete teardown: removes the entry only when it still holds
 * `controller`. A turn's teardown may run after a replacement has registered
 * its own controller under the same key (abort → immediate re-dispatch); an
 * unconditional delete would strip the live handle, making it uncancellable.
 * Returns whether the entry was removed.
 */
export function unregisterAbortHandle(
  key: AbortHandleKey,
  controller: AbortController,
): boolean {
  const registry = getRegistry();
  if (registry.get(key) !== controller) {
    logger.debug("abort.unregister_skipped_stale", { key });
    return false;
  }
  registry.delete(key);
  logger.debug("abort.unregistered", { key });
  return true;
}

/** Remove the entry for `key` without aborting it. */
export function releaseAbortHandle(key: AbortHandleKey): void {
  getRegistry().delete(key);
  logger.debug("abort.released", { key });
}

/**
 * Abort and remove the controller for `key`. Returns true when a registered
 * controller was found and signalled.
 */
export function abortHandle(key: AbortHandleKey): boolean {
  const registry = getRegistry();
  const controller = registry.get(key);
  if (!controller) return false;
  registry.delete(key);
  controller.abort();
  logger.info("abort.signaled", { key });
  return true;
}

/** Test isolation only — clears every registered handle. */
export function _resetAbortRegistryForTesting(): void {
  getRegistry().clear();
}
