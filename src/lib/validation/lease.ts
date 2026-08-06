import { randomBytes } from "node:crypto";
import { createLogger } from "@/lib/logging";
import type { ValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import type { ValidationRunRecord } from "./schemas";

const logger = createLogger("validation");

/**
 * Lease lifecycle for agent-owned validation runs (design:
 * validation-concurrency §4). The opaque token is returned only to the
 * submitter and persisted on the ledger row; only the exact token holder can
 * renew or cancel, so read-only status polling by other agents or a human can
 * never keep abandoned work alive. Expiry is the fallback that stops a dead
 * agent's cost-8 suite from holding the budget for its full timeout.
 *
 * System-owned runs (script validator, merge/commit gates) carry a null
 * lease and are exempt: their orchestrator lifecycle performs cancellation.
 */

export const DEFAULT_LEASE_TTL_MS = 60_000;

export type LeaseCancelAuthorization =
  | "authorized"
  | "not_found"
  | "already_terminal"
  | "system_owned"
  | "not_owner";

export interface ValidationLeaseManagerDeps {
  repo: ValidationRunsRepo;
  /** Short synchronous SQLite transaction host. */
  transact<T>(label: string, fn: () => T): T;
  /**
   * Group-kill the run's live process and resolve after confirmed death
   * (facade: handle registry + runner cancel).
   */
  killRun(runId: string): Promise<void>;
  /**
   * Terminal `interrupted` transition + capacity release + queue pump
   * (facade: scheduler release). Called only after any live group is dead.
   */
  releaseInterrupted(runId: string): void;
  now?(): Date;
  ttlMs?: number;
}

export interface ValidationLeaseManager {
  /** Opaque token + expiry for a new agent-owned submission. */
  issue(): { token: string; expiresAt: string };
  /** Extend the lease on poll — only for the exact token holder. */
  renew(runId: string, token: string): { renewed: boolean; expiresAt: string };
  /** Owner-only cancel gate; the facade performs the actual cancellation. */
  authorizeCancel(runId: string, token: string): LeaseCancelAuthorization;
  /**
   * Expiry fallback: dequeue expired waiters, group-kill expired runners,
   * and mark both interrupted. Lease-less (system-owned) runs are exempt.
   */
  sweepExpired(): Promise<{ expired: ValidationRunRecord[] }>;
}

export function createValidationLeaseManager(
  deps: ValidationLeaseManagerDeps,
): ValidationLeaseManager {
  const { repo, transact, killRun, releaseInterrupted } = deps;
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? DEFAULT_LEASE_TTL_MS;

  const expiryFrom = (from: Date): string =>
    new Date(from.getTime() + ttlMs).toISOString();

  return {
    issue() {
      return {
        token: randomBytes(24).toString("base64url"),
        expiresAt: expiryFrom(now()),
      };
    },

    renew(runId, token) {
      const expiresAt = expiryFrom(now());
      const renewed = transact("validation.lease.renew", () =>
        repo.renewLease(runId, token, expiresAt),
      );
      return { renewed, expiresAt };
    },

    authorizeCancel(runId, token) {
      const row = transact("validation.lease.authorize-cancel", () =>
        repo.findById(runId),
      );
      if (!row) return "not_found";
      if (row.status !== "queued" && row.status !== "running") {
        return "already_terminal";
      }
      if (row.leaseToken === null) return "system_owned";
      return row.leaseToken === token ? "authorized" : "not_owner";
    },

    async sweepExpired() {
      const cutoff = now().toISOString();
      // ISO-8601 UTC strings compare correctly as strings. Runners first:
      // their group-kills are the sweep's only awaits, so every waiter is
      // re-verified after them and an admission that lands mid-kill is seen.
      const candidates = transact("validation.lease.sweep", () =>
        [...repo.findRunning(), ...repo.findQueued()].filter(
          (row) =>
            row.leaseToken !== null &&
            row.leaseExpiresAt !== null &&
            row.leaseExpiresAt <= cutoff,
        ),
      );
      const expired: ValidationRunRecord[] = [];
      for (const candidate of candidates) {
        // The snapshot is stale the moment an earlier row's group-kill is
        // awaited: a renewal must spare its run, and a waiter admitted by the
        // freed capacity now has a live process. Re-verify in a fresh
        // transaction and act synchronously on the row's CURRENT state — no
        // await separates this claim from the kill/release it authorizes.
        const claimed = transact("validation.lease.claim", () => {
          const row = repo.findById(candidate.runId);
          if (!row) return null;
          if (row.status !== "queued" && row.status !== "running") return null;
          if (row.leaseToken !== candidate.leaseToken) return null;
          if (row.leaseExpiresAt === null) return null;
          return row.leaseExpiresAt <= now().toISOString() ? row : null;
        });
        if (!claimed) continue;
        logger.warn("validation.lease.expired", {
          runId: claimed.runId,
          name: claimed.commandName,
          cost: claimed.cost,
          status: claimed.status,
          reason: "lease_expired",
        });
        if (claimed.status === "running") {
          await killRun(claimed.runId);
        }
        releaseInterrupted(claimed.runId);
        expired.push(claimed);
      }
      return { expired };
    },
  };
}
