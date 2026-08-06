import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@/lib/logging";
import type { ValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import {
  isProcessGroupAlive,
  killProcessGroup,
  validationNonceMarker,
} from "./process-runner";

const execFile = promisify(execFileCb);
const logger = createLogger("validation");

/**
 * Crash recovery for the validation ledger (design: validation-concurrency
 * §4). An abrupt server death can leave detached vitest groups alive while a
 * restarted in-memory scheduler reports zero usage — admitting a fresh full
 * budget on top of them recreates the exact overload this feature exists to
 * prevent. So the composition root keeps admission closed until
 * reconciliation has terminated surviving owned groups and marked every
 * stale row interrupted. v1 never auto-resumes interrupted work.
 */

/**
 * What a ledger row's recorded process group turned out to be, verified via
 * the per-run nonce — never a bare PID, which the OS reuses.
 *
 * - `owned`: alive and the leader's argv carries this run's nonce — ours to
 *   kill.
 * - `not_ours`: dead, or alive under a leader that is verifiably a different
 *   process (recycled pid) — nothing of ours survives, safe to settle.
 * - `unverifiable`: members are alive but the leader cannot be inspected, so
 *   ownership cannot be proven either way. Recovery must fail closed on this:
 *   killing risks a recycled group, settling risks releasing budget over a
 *   still-running validation.
 */
export type ValidationGroupClassification =
  | "owned"
  | "not_ours"
  | "unverifiable";

export interface ValidationProcessIdentity {
  classifyGroup(
    processGroupPid: number,
    nonce: string,
  ): Promise<ValidationGroupClassification>;
  /** SIGTERM-then-SIGKILL the group; resolves after confirmed death. */
  killGroup(processGroupPid: number): Promise<void>;
}

/**
 * Reconciliation met a live process group it could neither verify nor safely
 * settle. The service treats this as a failed recovery: admission never
 * opens, every submission is refused, and the rows stay non-terminal so the
 * next startup retries.
 */
export class UnverifiableValidationGroupError extends Error {
  readonly groups: Array<{ runId: string; processGroupPid: number }>;
  constructor(groups: Array<{ runId: string; processGroupPid: number }>) {
    super(
      `validation recovery found ${groups.length} live process group(s) whose ` +
        `ownership could not be verified (${groups
          .map((group) => `${group.runId}:pgid ${group.processGroupPid}`)
          .join(", ")}); admission stays closed`,
    );
    this.name = "UnverifiableValidationGroupError";
    this.groups = groups;
  }
}

/**
 * Production identity over the runner's argv contract: the group leader is a
 * sh wrapper whose command line carries `cc-validation-nonce=<nonce>`, read
 * back with `ps -ww -o command=`. (macOS forbids reading another process's
 * environment even same-user, so the CC_VALIDATION_NONCE env var cannot be
 * probed.) A dead leader with live descendants is unverifiable and treated
 * as not ours — recovery fails closed rather than killing a recycled pid.
 */
export function createProcessGroupIdentity(
  opts: { killGraceMs?: number; pollMs?: number } = {},
): ValidationProcessIdentity {
  return {
    async classifyGroup(processGroupPid, nonce) {
      if (!isProcessGroupAlive(processGroupPid)) return "not_ours";
      let leaderCommand: string | null = null;
      try {
        const { stdout } = await execFile("ps", [
          "-ww",
          "-o",
          "command=",
          "-p",
          String(processGroupPid),
        ]);
        leaderCommand = stdout.trim().length > 0 ? stdout : null;
      } catch {
        // ps exits non-zero when the leader is gone.
        leaderCommand = null;
      }
      if (leaderCommand !== null) {
        return leaderCommand.includes(validationNonceMarker(nonce))
          ? "owned"
          : "not_ours";
      }
      // The leader vanished between the aliveness probe and ps — re-probe:
      // a group that died in that window is settled, one that is still alive
      // has unverifiable orphan members and must fail closed.
      return isProcessGroupAlive(processGroupPid) ? "unverifiable" : "not_ours";
    },
    killGroup(processGroupPid) {
      return killProcessGroup(processGroupPid, {
        ...(opts.killGraceMs !== undefined
          ? { killGraceMs: opts.killGraceMs }
          : {}),
        ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
        onEscalate: () => {
          logger.warn("validation.recovery.group_kill_escalated", {
            pid: processGroupPid,
          });
        },
      });
    },
  };
}

export interface ReconcileValidationDeps {
  repo: ValidationRunsRepo;
  transact<T>(label: string, fn: () => T): T;
  identity: ValidationProcessIdentity;
  /** Runs after the interrupted verdict is durable and any owned group died. */
  onInterrupted?(runId: string): void;
  now?(): Date;
}

export interface ReconcileValidationResult {
  interruptedRunIds: string[];
  killedProcessGroups: number[];
}

export async function reconcileValidationLedger(
  deps: ReconcileValidationDeps,
): Promise<ReconcileValidationResult> {
  const { repo, transact, identity } = deps;
  const now = deps.now ?? (() => new Date());

  const stale = transact("validation.recovery.load", () =>
    repo.findStaleActive(),
  );
  const interruptedRunIds: string[] = [];
  const killedProcessGroups: number[] = [];
  const unverifiable: Array<{ runId: string; processGroupPid: number }> = [];

  for (const row of stale) {
    if (row.status === "running" && row.processGroupPid !== null) {
      const classification = await identity.classifyGroup(
        row.processGroupPid,
        row.nonce,
      );
      if (classification === "unverifiable") {
        // Leave the row non-terminal: settling it would release budget over
        // a group that may still be running, and killing it risks a recycled
        // pgid. The error below keeps admission closed and the next startup
        // retries this row.
        unverifiable.push({
          runId: row.runId,
          processGroupPid: row.processGroupPid,
        });
        logger.error("validation.recovery.unverifiable_group", {
          runId: row.runId,
          name: row.commandName,
          cost: row.cost,
          pid: row.processGroupPid,
        });
        continue;
      }
      if (classification === "owned") {
        await identity.killGroup(row.processGroupPid);
        killedProcessGroups.push(row.processGroupPid);
      }
    }
    const marked = transact("validation.recovery.mark", () =>
      repo.markInterrupted(row.runId, { finishedAt: now().toISOString() }),
    );
    if (marked) {
      interruptedRunIds.push(row.runId);
      deps.onInterrupted?.(row.runId);
    }
    logger.warn("validation.recovery.interrupted", {
      runId: row.runId,
      name: row.commandName,
      cost: row.cost,
      status: row.status,
      pid: row.processGroupPid,
      reason: "unclean_shutdown",
    });
  }

  if (stale.length > 0) {
    logger.info("validation.recovery.reconciled", {
      interrupted: interruptedRunIds.length,
      killedGroups: killedProcessGroups.length,
      unverifiable: unverifiable.length,
    });
  }
  if (unverifiable.length > 0) {
    throw new UnverifiableValidationGroupError(unverifiable);
  }
  return { interruptedRunIds, killedProcessGroups };
}

/**
 * Admission gate the composition root holds closed until reconciliation
 * finishes; submissions arriving during recovery wait on `whenOpen()`.
 */
export interface ValidationAdmissionGate {
  isOpen(): boolean;
  open(): void;
  whenOpen(): Promise<void>;
}

export function createValidationAdmissionGate(): ValidationAdmissionGate {
  let open = false;
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    isOpen: () => open,
    open() {
      open = true;
      release();
    },
    whenOpen: () => opened,
  };
}
