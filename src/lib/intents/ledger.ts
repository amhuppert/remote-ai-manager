import { randomUUID } from "node:crypto";
import type { PendingIntentsRepo } from "@/lib/state-store/pending-intents-repo";
import type { NewPendingIntent, OwnerRef, PendingIntent } from "./schemas";

/**
 * Pending cross-domain intents. A requester records an intent in the same
 * transaction as the decision that needs it and closes it in the transaction
 * that consumes the executor's outcome, so an open intent is exactly "this
 * requester still awaits that operation". No in-process await carries that fact.
 */
export interface IntentLedger {
  /** Idempotent by executor and cause: a repeat returns the recorded intent. */
  record(intent: NewPendingIntent): PendingIntent;
  close(intentId: string): void;
  pending(owner: OwnerRef): PendingIntent[];
  /** Every requester with an open intent; boot reconciles each. */
  owners(): OwnerRef[];
}

export function createIntentLedger(repo: PendingIntentsRepo): IntentLedger {
  return {
    record(intent) {
      repo.insertIfAbsent({ id: randomUUID(), ...intent });
      const recorded = repo.getByCause(intent.executor, intent.cause);
      if (recorded === null) {
        throw new Error(
          `Intent ${intent.executor}:${intent.cause} was not recorded`,
        );
      }
      if (
        recorded.requester.kind !== intent.requester.kind ||
        recorded.requester.id !== intent.requester.id
      ) {
        throw new Error(
          `Intent ${intent.executor}:${intent.cause} belongs to ${recorded.requester.kind}:${recorded.requester.id}`,
        );
      }
      return recorded;
    },
    close(intentId) {
      repo.delete(intentId);
    },
    pending(owner) {
      return repo.listByRequester(owner);
    },
    owners() {
      return repo.listRequesters();
    },
  };
}
