import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { OwnerKind, OwnerRef } from "./schemas";

const logger = createLogger("intents.reconcile-scheduler");

export interface ReconcileHandlers {
  /** The domain's one reconcile path: consume outcomes, derive, submit. */
  reconcile(id: string): void | Promise<void>;
  /** Records a visible halt; the open intents stay for the next reconcile. */
  onFailure(id: string, error: unknown): void | Promise<void>;
}

/**
 * In-process trigger for reconcile. A hint is only a trigger: durability lives
 * in pending intents and executor records, so a lost hint never loses a result.
 * Each owner reconciles serially; touches during a run coalesce into one rerun.
 */
export interface ReconcileScheduler {
  register(kind: OwnerKind, handlers: ReconcileHandlers): void;
  touch(owner: OwnerRef): void;
  /** Resolves once no owner is reconciling or waiting to. */
  idle(): Promise<void>;
}

type OwnerState = "running" | "rerun";

export function createReconcileScheduler(): ReconcileScheduler {
  const handlersByKind = new Map<OwnerKind, ReconcileHandlers>();
  const states = new Map<string, OwnerState>();
  const active = new Set<Promise<void>>();

  async function drain(
    owner: OwnerRef,
    key: string,
    handlers: ReconcileHandlers,
  ) {
    // Start on a later tick so a touch from inside a caller's transaction
    // never reconciles re-entrantly.
    await Promise.resolve();
    for (;;) {
      try {
        await handlers.reconcile(owner.id);
      } catch (error) {
        try {
          await handlers.onFailure(owner.id, error);
        } catch (failure) {
          logger.error("intents.reconcile_failure_unrecorded", {
            ownerKind: owner.kind,
            ownerId: owner.id,
            error: getErrorMessage(error),
            recordError: getErrorMessage(failure),
          });
        }
      }
      if (states.get(key) !== "rerun") break;
      states.set(key, "running");
    }
    states.delete(key);
  }

  return {
    register(kind, handlers) {
      handlersByKind.set(kind, handlers);
    },
    touch(owner) {
      const handlers = handlersByKind.get(owner.kind);
      if (handlers === undefined) {
        throw new Error(`No reconcile registered for ${owner.kind}`);
      }
      const key = `${owner.kind}:${owner.id}`;
      if (states.has(key)) {
        states.set(key, "rerun");
        return;
      }
      states.set(key, "running");
      const run = drain(owner, key, handlers).finally(() => active.delete(run));
      active.add(run);
    },
    async idle() {
      while (active.size > 0) {
        await Promise.all(active);
      }
    },
  };
}
