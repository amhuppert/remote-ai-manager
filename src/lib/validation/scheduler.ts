import { createLogger } from "@/lib/logging";
import type { ValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import type { ValidationRunRecord } from "@/lib/validation/schemas";

const logger = createLogger("validation");

/**
 * Weighted FIFO admission over the validation_runs ledger (design:
 * validation-concurrency §3, §4).
 *
 * The scheduler owns admission POLICY and the three timing transitions
 * (`submittedAt`, `startedAt`, `finishedAt`); the repository owns row
 * mutations. Every decision runs inside a short synchronous SQLite
 * transaction via the injected `transact` host — no transaction is ever held
 * open while a child process runs, and process handles never touch the
 * ledger (they live in the in-memory registry below, keyed by runId).
 *
 * The concurrency limit is passed into every decision rather than cached so
 * a live config change takes effect at the next decision point: lowering the
 * limit never disturbs running work, and `pump` retires queued rows whose
 * cost newly exceeds it.
 */

/** Submission identity: everything the caller knows before admission. */
export type ValidationRunSubmission = Omit<
  ValidationRunRecord,
  | "status"
  | "queueOrder"
  | "submittedAt"
  | "startedAt"
  | "finishedAt"
  | "queueMs"
  | "execMs"
  | "exitCode"
  | "timedOut"
  | "processGroupPid"
>;

export type ValidationAdmissionDecision =
  | { kind: "admitted"; record: ValidationRunRecord }
  | { kind: "queued"; record: ValidationRunRecord; position: number }
  | {
      kind: "capacity_unavailable";
      cost: number;
      inUse: number;
      limit: number;
      queueDepth: number;
      blockedByOlderWaiter: boolean;
    }
  | { kind: "cost_exceeds_limit"; cost: number; limit: number };

export interface ValidationPumpResult {
  /** Queued rows admitted head-first; the caller must spawn each of them. */
  admitted: ValidationRunRecord[];
  /**
   * Queued rows whose configured cost exceeds the (possibly just-lowered)
   * limit: unrunnable configuration, marked cost_exceeds_limit in the ledger
   * so the durable verdict matches what the submitter is told and they never
   * wait forever.
   */
  oversized: ValidationRunRecord[];
}

export type SchedulerReleaseVerdict =
  | { status: "passed"; exitCode: number }
  | { status: "failed"; exitCode: number | null }
  | { status: "timed_out"; exitCode: number | null }
  | { status: "cancelled" }
  | { status: "interrupted" };

export interface ValidationSchedulerDeps {
  repo: ValidationRunsRepo;
  /** Short synchronous SQLite transaction host (production: write queue + db.transaction). */
  transact<T>(label: string, fn: () => T): T;
  now?(): Date;
}

export interface ValidationScheduler {
  submit(
    submission: ValidationRunSubmission,
    opts: { queueIfBusy: boolean; limit: number },
  ): ValidationAdmissionDecision;
  /**
   * Record process spawn on an admitted run: stamps `startedAt`, derives
   * `queueMs`, and stores the process-group pid. Null when the run is not in
   * the just-admitted state (unknown, still queued, already started, or
   * terminal) — the guard against double starts.
   */
  markStarted(
    runId: string,
    processGroupPid: number | null,
  ): { startedAt: string; queueMs: number } | null;
  /**
   * Terminal transition + capacity release. Callers must only invoke this
   * after the spawned process group is confirmed dead. Returns false when the
   * row is already terminal (double-release guard).
   */
  release(
    runId: string,
    verdict: SchedulerReleaseVerdict,
    opts: { limit: number },
  ): boolean;
  /**
   * FIFO admission sweep: retire queued rows whose cost exceeds the limit,
   * then admit from the head while it fits — never skipping a large head.
   */
  pump(opts: { limit: number }): ValidationPumpResult;
  snapshot(): { inUse: number; queueDepth: number };
}

function sumRunningCost(repo: ValidationRunsRepo): number {
  return repo.findRunning().reduce((sum, row) => sum + row.cost, 0);
}

export function createValidationScheduler(
  deps: ValidationSchedulerDeps,
): ValidationScheduler {
  const { repo, transact } = deps;
  const now = deps.now ?? (() => new Date());

  function buildQueuedRecord(
    submission: ValidationRunSubmission,
  ): ValidationRunRecord {
    return {
      ...submission,
      status: "queued",
      queueOrder: repo.nextQueueOrder(),
      processGroupPid: null,
      submittedAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
      queueMs: null,
      execMs: null,
      exitCode: null,
      timedOut: false,
    };
  }

  return {
    submit(submission, { queueIfBusy, limit }) {
      return transact("validation.scheduler.submit", () => {
        if (submission.cost > limit) {
          return {
            kind: "cost_exceeds_limit" as const,
            cost: submission.cost,
            limit,
          };
        }

        const inUse = sumRunningCost(repo);
        const queueDepth = repo.findQueued().length;
        const fits = inUse + submission.cost <= limit;
        const hasOlderWaiter = queueDepth > 0;

        if (!hasOlderWaiter && fits) {
          const record = buildQueuedRecord(submission);
          repo.submit(record);
          repo.admit(record.runId);
          logger.info("validation.scheduler.admitted", {
            runId: record.runId,
            name: record.commandName,
            cost: record.cost,
            inUse: inUse + record.cost,
            limit,
            queueDepth,
          });
          return {
            kind: "admitted" as const,
            record: { ...record, status: "running" as const },
          };
        }

        if (!queueIfBusy) {
          logger.info("validation.scheduler.refused", {
            runId: submission.runId,
            name: submission.commandName,
            cost: submission.cost,
            inUse,
            limit,
            queueDepth,
            blockedByOlderWaiter: hasOlderWaiter && fits,
          });
          return {
            kind: "capacity_unavailable" as const,
            cost: submission.cost,
            inUse,
            limit,
            queueDepth,
            // Strict FIFO can refuse even when raw capacity is free; the
            // refusal must say which situation the caller is in.
            blockedByOlderWaiter: hasOlderWaiter && fits,
          };
        }

        const record = buildQueuedRecord(submission);
        repo.submit(record);
        logger.info("validation.scheduler.queued", {
          runId: record.runId,
          name: record.commandName,
          cost: record.cost,
          inUse,
          limit,
          queueDepth: queueDepth + 1,
          position: queueDepth,
        });
        return { kind: "queued" as const, record, position: queueDepth };
      });
    },

    markStarted(runId, processGroupPid) {
      return transact("validation.scheduler.mark-started", () => {
        const row = repo.findById(runId);
        if (!row || row.status !== "running" || row.startedAt !== null) {
          return null;
        }
        const startedAtDate = now();
        const startedAt = startedAtDate.toISOString();
        const queueMs = Math.max(
          0,
          startedAtDate.getTime() - new Date(row.submittedAt).getTime(),
        );
        const changed = repo.markStarted(runId, {
          startedAt,
          queueMs,
          processGroupPid,
        });
        return changed ? { startedAt, queueMs } : null;
      });
    },

    release(runId, verdict, { limit }) {
      const released = transact("validation.scheduler.release", () => {
        const row = repo.findById(runId);
        if (!row) return false;
        const finishedAtDate = now();
        const finishedAt = finishedAtDate.toISOString();
        const execMs =
          row.startedAt === null
            ? null
            : Math.max(
                0,
                finishedAtDate.getTime() - new Date(row.startedAt).getTime(),
              );
        switch (verdict.status) {
          case "passed":
            return repo.markPassed(runId, {
              finishedAt,
              // A passed run has necessarily started; guard for type safety.
              execMs: execMs ?? 0,
              exitCode: verdict.exitCode,
            });
          case "failed":
            return repo.markFailed(runId, {
              finishedAt,
              execMs,
              exitCode: verdict.exitCode,
            });
          case "timed_out":
            return repo.markTimedOut(runId, {
              finishedAt,
              execMs: execMs ?? 0,
              exitCode: verdict.exitCode,
            });
          case "cancelled":
            return repo.markCancelled(runId, { finishedAt, execMs });
          case "interrupted":
            return repo.markInterrupted(runId, { finishedAt });
        }
      });
      if (released) {
        logger.info("validation.scheduler.released", {
          runId,
          status: verdict.status,
          limit,
        });
      }
      return released;
    },

    pump({ limit }) {
      return transact("validation.scheduler.pump", () => {
        const admitted: ValidationRunRecord[] = [];
        const oversized: ValidationRunRecord[] = [];
        const finishedAt = now().toISOString();

        // Retire unrunnable configuration first, wherever it sits in the
        // queue: after a limit lowering these rows would otherwise wait
        // forever behind a head that can never fit them.
        for (const row of repo.findQueued()) {
          if (row.cost > limit) {
            repo.markCostExceedsLimit(row.runId, { finishedAt });
            oversized.push(row);
            logger.warn("validation.scheduler.oversized_retired", {
              runId: row.runId,
              name: row.commandName,
              cost: row.cost,
              limit,
            });
          }
        }

        let inUse = sumRunningCost(repo);
        for (;;) {
          const head = repo.findQueued()[0];
          if (!head) break;
          if (inUse + head.cost > limit) break; // never skip a large head
          repo.admit(head.runId);
          inUse += head.cost;
          admitted.push({ ...head, status: "running" });
          logger.info("validation.scheduler.admitted", {
            runId: head.runId,
            name: head.commandName,
            cost: head.cost,
            inUse,
            limit,
            queueDepth: repo.findQueued().length,
          });
        }
        return { admitted, oversized };
      });
    },

    snapshot() {
      return transact("validation.scheduler.snapshot", () => ({
        inUse: sumRunningCost(repo),
        queueDepth: repo.findQueued().length,
      }));
    },
  };
}

// ============================================================
// In-memory process handle registry
// ============================================================

/**
 * Process handles are runtime-only state: the ledger carries durable
 * ownership identity (pid + nonce) for crash recovery, while live handles
 * stay in this in-memory map keyed by runId.
 */
export interface ValidationRunHandleRegistry<H> {
  attach(runId: string, handle: H): void;
  get(runId: string): H | null;
  /** Remove and return the handle (idempotent; null when absent). */
  take(runId: string): H | null;
  list(): Array<{ runId: string; handle: H }>;
}

export function createValidationRunHandleRegistry<
  H,
>(): ValidationRunHandleRegistry<H> {
  const handles = new Map<string, H>();
  return {
    attach(runId, handle) {
      handles.set(runId, handle);
    },
    get(runId) {
      return handles.get(runId) ?? null;
    },
    take(runId) {
      const handle = handles.get(runId) ?? null;
      handles.delete(runId);
      return handle;
    },
    list() {
      return [...handles.entries()].map(([runId, handle]) => ({
        runId,
        handle,
      }));
    },
  };
}
