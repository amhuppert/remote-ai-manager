import { randomUUID } from "node:crypto";
import {
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import { createLogger, type Logger } from "@/lib/logging";
import type { ValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { projectNameFromPath } from "@/lib/state-store/tickets-repo";
import type { ValidationBudgetResponse } from "./api-schemas";
import {
  createValidationLeaseManager,
  type LeaseCancelAuthorization,
} from "./lease";
import type {
  SpawnValidationParams,
  SpawnValidationResult,
  ValidationProcessHandle,
  ValidationRunOutcome,
} from "./process-runner";
import {
  createValidationAdmissionGate,
  reconcileValidationLedger,
  type ValidationProcessIdentity,
} from "./recovery";
import {
  createValidationRunHandleRegistry,
  type SchedulerReleaseVerdict,
  type ValidationRunSubmission,
  type ValidationScheduler,
} from "./scheduler";
import {
  isTerminalValidationRunStatus,
  type GlobalValidationConfig,
  type RepoValidationConfig,
  type ValidationCommandCost,
  type ValidationLease,
  type ValidationRunEventPhase,
  type ValidationRunRecord,
  type ValidationRunResult,
  type ValidationRunSource,
  type ValidationRunStatus,
  type ValidationScope,
  type ValidationWorkflowRole,
} from "./schemas";
import { resolveValidationExecution } from "./command-resolution";
import { resolveSubmissionCost } from "./cost-resolution";
import { countMatchedScopePaths } from "./scope-match";

const defaultLogger = createLogger("validation");

/**
 * The single deep entry point for every validation execution in Command
 * Center (design: validation-concurrency §4, §7, §12). Feature code — the
 * agent CLI route, the graph script gate, lane merges, Smart Merge, Smart
 * Commit — talks only to this facade; nothing else may reach the scheduler
 * or the low-level process runner.
 *
 * Order of decisions for a submission, each stage consuming nothing from the
 * stages after it: recursion guard → caller identity (fails closed on
 * ambiguity) → command registry lookup → scope-args preflight → agent policy
 * (a disabled command is an exit-0-shaped no-op with zero scheduler or
 * runner involvement) → weighted FIFO admission → spawn. Capacity is
 * released only after the runner confirms the process group is dead.
 */

// ============================================================
// Caller identity
// ============================================================

export interface ValidationCallerRef {
  projectPath: string;
  sessionName?: string | null;
  conversationId?: string | null;
  /**
   * Workflow identity claimed by the caller's environment. Never
   * authoritative: it is verified against server-side graph state, and any
   * mismatch fails closed. `role` is optional because the lane env carries
   * only execution/context ids (CC_WORKFLOW_EXECUTION_ID/CONTEXT_ID); a
   * claimed role is cross-checked when present, and the authoritative role
   * always comes from the resolved lane.
   */
  claimedWorkflow?: {
    executionId: string;
    contextId: string;
    role?: ValidationWorkflowRole;
  } | null;
}

interface ResolvedCallerTarget {
  worktreePath: string;
  sessionName: string | null;
  branchName: string | null;
  targetBranch: string | null;
}

export type ResolvedValidationCaller =
  | ({ kind: "project" } & ResolvedCallerTarget)
  | ({ kind: "session" } & ResolvedCallerTarget)
  | ({ kind: "graph_lane" } & ResolvedCallerTarget & {
        executionId: string;
        contextId: string;
        role: ValidationWorkflowRole;
        /** Seed-time policy snapshot, expanded and role-selected. */
        allowedCommands: readonly string[];
        /** The context's script-gate selection, for the honest skip message. */
        scriptGateCommands: readonly string[];
      })
  | { kind: "ambiguous"; reason: string };

export interface ValidationCallerResolver {
  resolveCaller(ref: ValidationCallerRef): Promise<ResolvedValidationCaller>;
}

// ============================================================
// Service contract
// ============================================================

export interface ValidationServiceDeps {
  repo: ValidationRunsRepo;
  /** Short synchronous SQLite transaction host. */
  transact<T>(label: string, fn: () => T): T;
  scheduler: ValidationScheduler;
  runner: {
    spawn(params: SpawnValidationParams): Promise<SpawnValidationResult>;
  };
  resolver: ValidationCallerResolver;
  config: {
    readRepoValidation(
      projectPath: string,
    ): Promise<RepoValidationConfig | null>;
    readGlobal(): Promise<GlobalValidationConfig>;
  };
  /** Crash-recovery process identity (nonce-verified, never bare PID). */
  identity: ValidationProcessIdentity;
  publish: PublishFn;
  logger?: Logger;
  now?(): Date;
  leaseTtlMs?: number;
  ids?: { runId(): string; nonce(): string };
}

export interface ValidationSubmitRequest {
  source: ValidationRunSource;
  commandName: string;
  scope?: ValidationScope;
  scopePaths?: string[];
  queueIfBusy?: boolean;
  caller: ValidationCallerRef;
  /**
   * CC_VALIDATION_RUN_ID observed in the submitter's environment: a
   * registered command invoking `cctl validate run` would hold capacity
   * while waiting for capacity, so nested invocations are rejected.
   */
  nestedValidationRunId?: string | null;
}

// ============================================================
// System submissions (orchestrator gates)
// ============================================================

export type ValidationSystemSource = Exclude<ValidationRunSource, "agent_cli">;

/** Registered command reference for an orchestrator-owned submission. */
export interface ValidationSystemCommandRef {
  kind: "registered";
  name: string;
}

/**
 * Explicitly caller-resolved execution target. System callers are in-process
 * orchestration (script gate, merge/commit machines) that already resolved
 * the worktree they are validating — a lane merge validates a lane worktree
 * that no session-scoped resolver lookup would produce — so the CLI's
 * identity-resolution path does not apply and targeting is passed verbatim.
 */
export interface ValidationSystemTarget {
  worktreePath: string;
  sessionName?: string | null;
  branchName?: string | null;
  targetBranch?: string | null;
  /** Lane-worktree context id, forwarded to the script as CONTEXT_ID. */
  contextId?: string | null;
}

export interface ValidationSystemSubmitRequest {
  source: ValidationSystemSource;
  command: ValidationSystemCommandRef;
  scope: ValidationScope;
  projectPath: string;
  conversationId?: string | null;
  /** Ledger stamping for §12 timing accounting; never used for policy. */
  workflow?: { executionId: string; contextId: string } | null;
  target: ValidationSystemTarget;
}

export type ValidationSubmitInvalidReason =
  | "identity_unresolved"
  | "nested_invocation"
  | "duplicate_active"
  | "path_args_forbidden"
  | "path_args_rejected"
  | "path_args_require_changed"
  | "service_unavailable";

export type ValidationNotStartedResult = Extract<
  ValidationRunResult,
  {
    kind:
      | "skipped_by_policy"
      | "capacity_unavailable"
      | "command_not_found"
      | "cost_exceeds_limit";
  }
>;

export type ValidationSubmission =
  | {
      kind: "accepted";
      runId: string;
      status: "queued" | "running";
      position: number | null;
      /** Returned only to the submitter; null for system-owned sources. */
      lease: ValidationLease | null;
      requestedScope: ValidationScope;
      effectiveScope: ValidationScope;
    }
  | { kind: "not_started"; result: ValidationNotStartedResult }
  | {
      kind: "invalid";
      reason: ValidationSubmitInvalidReason;
      message: string;
    };

export interface ValidationListCommand {
  name: string;
  /** The registration as declared; reservation weights resolve at submission. */
  cost: ValidationCommandCost;
  description: string | null;
  pathArgs: "forbid" | "paths";
  changedScope: "native" | "full_fallback";
  timeoutMs: number | null;
  enabled: boolean;
}

export interface ValidationActiveRun {
  runId: string;
  commandName: string;
  status: "queued" | "running";
  cost: number;
  source: ValidationRunSource;
  projectPath: string;
  conversationId: string | null;
  requestedScope: ValidationScope | null;
  effectiveScope: ValidationScope | null;
  position: number | null;
}

export type ValidationListResult =
  | {
      kind: "ok";
      commands: ValidationListCommand[];
      capacity: { limit: number; inUse: number; queueDepth: number };
      runs: ValidationActiveRun[];
    }
  | {
      kind: "invalid";
      reason: "identity_unresolved" | "service_unavailable";
      message: string;
    };

export interface ValidationService {
  /** Resolves once startup reconciliation opened admission. */
  whenReady(): Promise<void>;
  /**
   * Whether startup recovery succeeded (meaningful after `whenReady`). When
   * false every submission is refused, and the composition root must not
   * start lease sweeps or shutdown hooks — retained non-terminal rows belong
   * to unverifiable process groups only the next recovery pass may settle.
   */
  isAvailable(): boolean;
  submit(request: ValidationSubmitRequest): Promise<ValidationSubmission>;
  /** Registry + policy enablement and the global active-capacity snapshot. */
  list(caller: ValidationCallerRef): Promise<ValidationListResult>;
  /**
   * Caller-independent capacity read for the budget indicator. The budget is
   * global, so this resolves no caller identity and applies no policy — it
   * reports what the ledger holds and whether admission is open at all.
   */
  budget(): Promise<ValidationBudgetResponse>;
  /**
   * Lease-exempt, always-queueing submission for system-owned gates (script
   * validator, lane merge, Smart Merge, Smart Commit). Queueing for capacity
   * is orchestration state — the caller blocks on `waitForCompletion`, and
   * queued work must never surface as a failure.
   */
  submitSystem(
    request: ValidationSystemSubmitRequest,
  ): Promise<ValidationSubmission>;
  /**
   * Resolves with the run's terminal result (in-process waiters only; call
   * after an `accepted` submission). Event-driven — never polls or sleeps —
   * and resolves for every terminal path, including oversized retirement,
   * cancellation, and shutdown interruption.
   */
  waitForCompletion(runId: string): Promise<ValidationRunResult>;
  /**
   * Resolves when any lifecycle phase is published for `runId` — admission,
   * start, or a terminal verdict — or as soon as `signal` aborts. Never
   * rejects and carries no payload: it is a "something moved, read again"
   * signal for a caller that then re-reads through `poll`.
   */
  waitForStatusChange(runId: string, signal?: AbortSignal): Promise<void>;
  /** Status + terminal result; renews the lease when a token is supplied. */
  poll(
    runId: string,
    leaseToken?: string,
  ): {
    status: ValidationRunStatus | null;
    position: number | null;
    result: ValidationRunResult | null;
    requestedScope: ValidationScope | null;
    effectiveScope: ValidationScope | null;
  };
  /** Owner-only cancel; performs the cancellation when authorized. */
  cancel(
    runId: string,
    leaseToken: string,
  ): Promise<{ authorization: LeaseCancelAuthorization }>;
  /** Orchestrator cancellation for lease-exempt (system-owned) runs. */
  cancelSystemOwned(runId: string): Promise<boolean>;
  /** Lease-expiry fallback sweep; returns how many runs were reaped. */
  sweepExpiredLeases(): Promise<number>;
  /** Graceful shutdown: group-kill tracked runs, then release reservations. */
  shutdown(): Promise<void>;
}

export async function waitForSystemValidationCompletion(
  service: Pick<ValidationService, "waitForCompletion" | "cancelSystemOwned">,
  runId: string,
  signal?: AbortSignal,
): Promise<ValidationRunResult> {
  let cancellation: Promise<boolean> | null = null;
  const cancel = () => {
    cancellation ??= Promise.resolve().then(() =>
      service.cancelSystemOwned(runId),
    );
  };

  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();

  try {
    const result = await service.waitForCompletion(runId);
    if (cancellation !== null) {
      await cancellation;
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

// ============================================================
// Implementation
// ============================================================

export function createValidationService(
  deps: ValidationServiceDeps,
): ValidationService {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => new Date());
  const ids = deps.ids ?? {
    runId: () => `vrun-${randomUUID()}`,
    nonce: () => randomUUID(),
  };
  const handles = createValidationRunHandleRegistry<ValidationProcessHandle>();
  const gate = createValidationAdmissionGate();
  /** Terminal outcome per run for poll(); in-memory like process handles. */
  const results = new Map<string, ValidationRunResult>();
  /** In-process waitForCompletion resolvers, settled by recordResult. */
  const completionWaiters = new Map<
    string,
    Array<(result: ValidationRunResult) => void>
  >();
  /**
   * Readers holding a status request open for a run, keyed by run. Unlike
   * `completionWaiters` these settle on every phase (a queued run's admission
   * is progress a held reader must see), and every entry owns its removal, so
   * a reader that gives up before the run moves leaves nothing behind.
   */
  const statusChangeWaiters = new Map<string, Set<() => void>>();
  /** Spawn parameters for queued runs awaiting pump admission. */
  const preparedSpawns = new Map<string, SpawnValidationParams>();
  /**
   * Matched-file count per live run, recorded at submission for the runs that
   * named their own paths. Only the submission-time resolution can answer it:
   * once the wrapper is running, the tree it walks may already differ.
   */
  const scopeMatches = new Map<string, number>();
  /** Runs whose in-flight cancellation must finalize as interrupted. */
  const forcedVerdicts = new Map<string, "interrupted">();
  /**
   * Admitted runs whose runner.spawn has not settled yet. Capacity is already
   * reserved but no handle exists, so cancellation in this window must not
   * finalize — the spawn may still succeed and leave a live group running
   * after its reservation was released. Cancellers park a verdict in
   * `pendingSpawnCancels` and the spawn continuation performs the kill.
   */
  const spawnsInFlight = new Map<string, Promise<void>>();
  const pendingSpawnCancels = new Map<string, "cancelled" | "interrupted">();
  /**
   * Exact active agent submissions, scoped to one conversation and mutable
   * worktree. A second client cannot safely share the first client's private
   * lease, so duplicates are refused and pointed at the existing run.
   */
  const activeAgentRunsByKey = new Map<string, string>();
  const activeAgentKeysByRun = new Map<string, string>();
  /**
   * Runs this service instance admitted or queued itself. Rows outside this
   * set — chiefly non-terminal rows retained after a FAILED recovery, whose
   * process groups this process cannot verify or kill — must never be
   * terminalized by local lifecycle paths (lease sweep, shutdown): releasing
   * them would reopen budget over a possibly-live group and erase the
   * evidence the next recovery pass needs.
   */
  const locallyOwned = new Set<string>();
  let lastKnownLimit = 8;
  let initFailed = false;
  let shuttingDown = false;

  function admissionUnavailable(): Extract<
    ValidationSubmission,
    { kind: "invalid" }
  > | null {
    if (initFailed) {
      return {
        kind: "invalid",
        reason: "service_unavailable",
        message:
          "Validation is unavailable: startup recovery failed and admission is closed. Check server logs (validation.recovery_failed).",
      };
    }
    if (shuttingDown) {
      return {
        kind: "invalid",
        reason: "service_unavailable",
        message:
          "Validation is unavailable: graceful shutdown is in progress and admission is closed.",
      };
    }
    return null;
  }

  function publishPhase(
    phase: ValidationRunEventPhase,
    fields: {
      runId: string | null;
      commandName: string;
      source: ValidationRunSource;
      projectPath: string;
      conversationId: string | null;
      requestedScope: ValidationScope | null;
      effectiveScope: ValidationScope | null;
      outcome?: string;
    },
  ): void {
    publishEventBestEffort({
      build: () => ({
        type: "validation-run",
        phase,
        runId: fields.runId,
        commandName: fields.commandName,
        source: fields.source,
        projectPath: fields.projectPath,
        conversationId: fields.conversationId,
        requestedScope: fields.requestedScope,
        effectiveScope: fields.effectiveScope,
        outcome: fields.outcome ?? null,
        timestamp: now().toISOString(),
      }),
      logger,
      failureEvent: "validation.event_publish_failed",
      context: { phase, runId: fields.runId },
      publish: deps.publish,
    });
    // Every transition of an existing run funnels through here, so this is the
    // one place that can promise a held reader it will be woken. Phases with
    // no run (pre-admission refusals) have nobody holding on them.
    if (fields.runId !== null) notifyStatusChange(fields.runId);
  }

  function rowMeta(row: ValidationRunRecord): {
    runId: string;
    commandName: string;
    source: ValidationRunSource;
    projectPath: string;
    conversationId: string | null;
    requestedScope: ValidationScope | null;
    effectiveScope: ValidationScope | null;
  } {
    return {
      runId: row.runId,
      commandName: row.commandName,
      source: row.source,
      projectPath: row.projectPath,
      conversationId: row.conversationId,
      requestedScope: row.requestedScope,
      effectiveScope: row.effectiveScope,
    };
  }

  /** Record a run's terminal result and settle its in-process waiters. */
  function recordResult(runId: string, result: ValidationRunResult): void {
    results.set(runId, result);
    const pending = completionWaiters.get(runId);
    if (pending) {
      completionWaiters.delete(runId);
      for (const resolve of pending) resolve(result);
    }
  }

  /**
   * Settle in-process observers from a durable terminal row and emit its one
   * canonical completion signal. Capacity ownership stays with the caller:
   * normal runs invoke this only after scheduler release, recovery only after
   * confirmed group death, and queued retirement never held capacity.
   */
  function observeTerminalCompletion(
    runId: string,
    result: ValidationRunResult,
    phase: ValidationRunEventPhase,
  ): void {
    const activeAgentKey = activeAgentKeysByRun.get(runId);
    if (activeAgentKey !== undefined) {
      activeAgentKeysByRun.delete(runId);
      activeAgentRunsByKey.delete(activeAgentKey);
    }
    recordResult(runId, result);
    const row = deps.repo.findById(runId);
    if (!row) return;
    logger.info("validation.run_completed", {
      runId,
      name: row.commandName,
      cost: row.cost,
      source: row.source,
      project: row.projectPath,
      ...(row.sessionName !== null ? { sessionName: row.sessionName } : {}),
      conversation: row.conversationId,
      ...(row.workflowExecutionId !== null
        ? { workflowExecutionId: row.workflowExecutionId }
        : {}),
      ...(row.workflowContextId !== null
        ? { workflowContextId: row.workflowContextId }
        : {}),
      ...(row.workflowRole !== null ? { workflowRole: row.workflowRole } : {}),
      outcome: result.kind,
      exitCode: row.exitCode,
      queueMs: row.queueMs,
      execMs: row.execMs,
      timedOut: row.timedOut,
      requestedScope: row.requestedScope,
      effectiveScope: row.effectiveScope,
      scopedPathCount: row.scopedPathCount,
      limit: lastKnownLimit,
    });
    publishPhase(phase, { ...rowMeta(row), outcome: result.kind });
  }

  /**
   * The locally-owned terminal choke point: release capacity (double-release
   * guarded by the scheduler), emit canonical completion observability, and
   * pump the queue. Natural completion, cancel, lease expiry, and shutdown
   * land here, and only the first caller for a run wins.
   */
  function finalizeWith(
    runId: string,
    verdict: SchedulerReleaseVerdict,
    result: ValidationRunResult,
  ): boolean {
    if (!locallyOwned.has(runId)) {
      logger.warn("validation.finalize_refused_foreign_row", {
        runId,
        verdict: verdict.status,
      });
      return false;
    }
    const released = deps.scheduler.release(runId, verdict, {
      limit: lastKnownLimit,
    });
    if (!released) return false;
    handles.take(runId);
    preparedSpawns.delete(runId);
    scopeMatches.delete(runId);
    forcedVerdicts.delete(runId);
    pendingSpawnCancels.delete(runId);
    const phase: ValidationRunEventPhase =
      verdict.status === "cancelled"
        ? "cancelled"
        : verdict.status === "interrupted"
          ? "interrupted"
          : "completed";
    observeTerminalCompletion(runId, result, phase);
    void pumpQueue();
    return true;
  }

  /** Present only for runs whose scope the server resolved into a file list. */
  function matchedFiles(runId: string): { filesMatched?: number } {
    const filesMatched = scopeMatches.get(runId);
    return filesMatched === undefined ? {} : { filesMatched };
  }

  function mapOutcome(
    runId: string,
    outcome: ValidationRunOutcome,
    forced: "interrupted" | undefined,
  ): { verdict: SchedulerReleaseVerdict; result: ValidationRunResult } {
    if (forced === "interrupted") {
      return {
        verdict: { status: "interrupted" },
        result: { kind: "interrupted", runId },
      };
    }
    switch (outcome.kind) {
      case "exited":
        return outcome.exitCode === 0
          ? {
              verdict: { status: "passed", exitCode: 0 },
              result: {
                kind: "passed",
                runId,
                exitCode: 0,
                output: outcome.output,
                ...matchedFiles(runId),
              },
            }
          : {
              verdict: { status: "failed", exitCode: outcome.exitCode },
              result: {
                kind: "failed",
                runId,
                exitCode: outcome.exitCode,
                output: outcome.output,
                ...matchedFiles(runId),
              },
            };
      case "timed_out":
        return {
          verdict: { status: "timed_out", exitCode: null },
          result: {
            kind: "timed_out",
            runId,
            timeoutMs: outcome.timeoutMs,
            output: outcome.output,
          },
        };
      case "cancelled":
        return {
          verdict: { status: "cancelled" },
          result: { kind: "cancelled", runId },
        };
    }
  }

  async function spawnAdmitted(record: ValidationRunRecord): Promise<void> {
    const task = (async () => {
      const params = preparedSpawns.get(record.runId);
      if (!params) {
        finalizeWith(
          record.runId,
          { status: "failed", exitCode: null },
          {
            kind: "failed",
            runId: record.runId,
            exitCode: null,
            output: "internal: no spawn parameters for admitted run",
          },
        );
        return;
      }
      const spawned = await deps.runner.spawn(params);
      // Read the parked verdict only now: anything set earlier belongs to a
      // cancellation that arrived while the spawn was in flight.
      const parkedCancel = pendingSpawnCancels.get(record.runId);
      pendingSpawnCancels.delete(record.runId);
      if (spawned.kind !== "spawned") {
        if (parkedCancel) {
          finalizeWith(
            record.runId,
            { status: parkedCancel },
            { kind: parkedCancel, runId: record.runId },
          );
          return;
        }
        const message =
          spawned.kind === "script_not_found"
            ? `validation script not found: ${spawned.scriptPath}`
            : spawned.kind === "spawn_error"
              ? spawned.message
              : `path arguments refused at spawn (${spawned.kind})`;
        logger.warn("validation.run_spawn_failed", {
          runId: record.runId,
          name: record.commandName,
          reason: spawned.kind,
        });
        finalizeWith(
          record.runId,
          { status: "failed", exitCode: null },
          {
            kind: "failed",
            runId: record.runId,
            exitCode: null,
            output: message,
          },
        );
        return;
      }
      // Persist pid + nonce ownership BEFORE releasing the start barrier: a
      // crash in between leaves a blocked supervisor that self-aborts on the
      // closed pipe, never a live workload behind a pid-less ledger row.
      const started = deps.scheduler.markStarted(
        record.runId,
        spawned.handle.processGroupPid,
      );
      handles.attach(record.runId, spawned.handle);
      logger.info("validation.run_started", {
        runId: record.runId,
        name: record.commandName,
        cost: record.cost,
        source: record.source,
        pid: spawned.handle.processGroupPid,
        queueMs: started?.queueMs ?? 0,
        requestedScope: record.requestedScope,
        effectiveScope: record.effectiveScope,
        scopedPathCount: record.scopedPathCount,
        limit: lastKnownLimit,
      });
      publishPhase("started", rowMeta(record));
      void spawned.handle.wait().then((outcome) => {
        const mapped = mapOutcome(
          record.runId,
          outcome,
          forcedVerdicts.get(record.runId),
        );
        finalizeWith(record.runId, mapped.verdict, mapped.result);
      });
      if (parkedCancel) {
        // The group exists now; kill it with the workload still barriered.
        // Finalization happens in the wait() continuation above, after group
        // death is confirmed.
        if (parkedCancel === "interrupted") {
          forcedVerdicts.set(record.runId, "interrupted");
        }
        void spawned.handle.cancel();
      } else if (started) {
        spawned.handle.confirmStart();
      } else {
        // The row is not in the just-admitted state (a raced transition) —
        // never release a workload whose ledger identity is unsettled.
        void spawned.handle.cancel();
      }
    })();
    spawnsInFlight.set(record.runId, task);
    try {
      await task;
    } finally {
      spawnsInFlight.delete(record.runId);
    }
  }

  async function pumpQueue(): Promise<void> {
    // A release during shutdown must not admit waiting work.
    if (shuttingDown) return;
    const global = await deps.config.readGlobal();
    if (shuttingDown) return;
    lastKnownLimit = global.concurrencyLimit;
    const pumped = deps.scheduler.pump({ limit: global.concurrencyLimit });
    for (const row of pumped.oversized) {
      preparedSpawns.delete(row.runId);
      scopeMatches.delete(row.runId);
      observeTerminalCompletion(
        row.runId,
        {
          kind: "cost_exceeds_limit",
          name: row.commandName,
          cost: row.cost,
          limit: global.concurrencyLimit,
        },
        "rejected",
      );
    }
    for (const row of pumped.admitted) {
      await spawnAdmitted(row);
    }
  }

  async function cancelRun(
    runId: string,
    as: "cancelled" | "interrupted",
  ): Promise<void> {
    const inFlight = spawnsInFlight.get(runId);
    if (inFlight) {
      // Capacity is reserved but the process may still materialize: park the
      // verdict for the spawn continuation, which kills whatever spawned.
      pendingSpawnCancels.set(runId, as);
      await inFlight;
      const handle = handles.get(runId);
      // Joining the settled outcome resolves only after confirmed group
      // death; when the handle is already gone the run has finalized.
      if (handle) await handle.cancel();
      return;
    }
    const handle = handles.get(runId);
    if (handle) {
      if (as === "interrupted") forcedVerdicts.set(runId, "interrupted");
      // The wait() continuation registered at spawn finalizes (release,
      // result, event) synchronously before this await resumes.
      await handle.cancel();
      return;
    }
    finalizeWith(
      runId,
      { status: as },
      as === "cancelled"
        ? { kind: "cancelled", runId }
        : { kind: "interrupted", runId },
    );
  }

  const leases = createValidationLeaseManager({
    repo: deps.repo,
    transact: deps.transact,
    killRun: (runId) => cancelRun(runId, "interrupted"),
    // Running expiries were already finalized via killRun's continuation;
    // the double-release guard makes this a no-op for them, and it settles
    // queued expiries.
    releaseInterrupted: (runId) => {
      finalizeWith(
        runId,
        { status: "interrupted" },
        { kind: "interrupted", runId },
      );
    },
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.leaseTtlMs !== undefined ? { ttlMs: deps.leaseTtlMs } : {}),
  });

  // Startup recovery: admission stays closed until reconciliation has
  // terminated surviving owned process groups and marked stale rows
  // interrupted; only then does the gate open. On failure the gate still
  // opens so waiters do not hang, but every submission is refused.
  const ready: Promise<void> = (async () => {
    try {
      await reconcileValidationLedger({
        repo: deps.repo,
        transact: deps.transact,
        identity: deps.identity,
        onInterrupted: (runId) => {
          observeTerminalCompletion(
            runId,
            { kind: "interrupted", runId },
            "interrupted",
          );
        },
        ...(deps.now ? { now: deps.now } : {}),
      });
    } catch (err) {
      initFailed = true;
      logger.error("validation.recovery_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      gate.open();
    }
  })();

  async function submit(
    request: ValidationSubmitRequest,
  ): Promise<ValidationSubmission> {
    await gate.whenOpen();
    const unavailableAtEntry = admissionUnavailable();
    if (unavailableAtEntry) return unavailableAtEntry;

    const requestedScope = request.scope ?? "changed";
    const scopePaths = request.scopePaths ?? [];
    let effectiveScope: ValidationScope | null = null;
    const meta = {
      runId: null,
      commandName: request.commandName,
      source: request.source,
      projectPath: request.caller.projectPath,
      conversationId: request.caller.conversationId ?? null,
      requestedScope,
      effectiveScope: null,
    };
    logger.info("validation.run_requested", {
      name: request.commandName,
      source: request.source,
      project: request.caller.projectPath,
      conversation: meta.conversationId,
      queueIfBusy: request.queueIfBusy ?? false,
      requestedScope,
      effectiveScope,
      scopedPathCount: scopePaths.length,
    });
    publishPhase("requested", meta);

    const rejected = (
      reason: ValidationSubmitInvalidReason,
      message: string,
      outcome?: string,
      fields: Record<string, unknown> = {},
    ): ValidationSubmission => {
      logger.warn("validation.run_rejected", {
        name: request.commandName,
        source: request.source,
        project: request.caller.projectPath,
        reason: outcome ?? reason,
        ...fields,
      });
      publishPhase("rejected", {
        ...meta,
        effectiveScope,
        outcome: outcome ?? reason,
      });
      return { kind: "invalid", reason, message };
    };

    if (request.nestedValidationRunId) {
      return rejected(
        "nested_invocation",
        "Refused: `cctl validate` cannot run from inside a running validation command (CC_VALIDATION_RUN_ID is set) — a registered command would hold capacity while waiting for capacity.",
      );
    }

    const resolved = await deps.resolver.resolveCaller(request.caller);
    if (resolved.kind === "ambiguous") {
      return rejected(
        "identity_unresolved",
        `Refused: caller identity did not resolve (${resolved.reason}). Graph identity must match server-side workflow state; validation fails closed rather than granting unrestricted access.`,
      );
    }

    const repoValidation = await deps.config.readRepoValidation(
      request.caller.projectPath,
    );
    const command = repoValidation?.commands[request.commandName];
    if (!command) {
      const knownCommands = Object.keys(repoValidation?.commands ?? {});
      logger.warn("validation.run_rejected", {
        name: request.commandName,
        source: request.source,
        project: request.caller.projectPath,
        reason: "command_not_found",
      });
      publishPhase("rejected", { ...meta, outcome: "command_not_found" });
      return {
        kind: "not_started",
        result: {
          kind: "command_not_found",
          name: request.commandName,
          knownCommands,
        },
      };
    }

    const execution = resolveValidationExecution({
      profile: command,
      requestedScope,
      scopePaths,
      worktreePath: resolved.worktreePath,
    });
    if (!execution.ok) return rejected(execution.reason, execution.message);
    effectiveScope = execution.effectiveScope;

    // Policy gate BEFORE admission (design §7): resolved from the
    // execution's seed-time snapshot; a disabled command is an exit-0-shaped
    // no-op — zero scheduler or runner involvement. The internal script
    // validator and merge gates are system sources and ignore agent
    // allowlists.
    if (request.source === "agent_cli" && resolved.kind === "graph_lane") {
      if (!resolved.allowedCommands.includes(request.commandName)) {
        const roleLabel =
          resolved.role === "implementer" ? "implementer" : "context validator";
        const handledByScriptGate = resolved.scriptGateCommands.includes(
          request.commandName,
        );
        // Only claim another component handles it when that is true.
        const message = handledByScriptGate
          ? `Skipped "${request.commandName}": it is disabled for the ${roleLabel} in context "${resolved.contextId}". Do not run it in this execution context; it is handled by the script validator.`
          : `Skipped "${request.commandName}": workflow policy disables it for the ${roleLabel} in context "${resolved.contextId}". Do not attempt to run it by other means.`;
        logger.info("validation.policy_skipped", {
          name: request.commandName,
          role: resolved.role,
          executionId: resolved.executionId,
          contextId: resolved.contextId,
          handledByScriptGate,
        });
        publishPhase("policy_skipped", {
          ...meta,
          effectiveScope,
          outcome: "skipped_by_policy",
        });
        return {
          kind: "not_started",
          result: { kind: "skipped_by_policy", message },
        };
      }
    }

    // Resolve every async preflight dependency before claiming the active
    // key. From the lookup through scheduler submission there is no await, so
    // concurrent requests cannot both observe the key as free.
    const global = await deps.config.readGlobal();
    lastKnownLimit = global.concurrencyLimit;
    const conversationId = request.caller.conversationId ?? null;
    const activeAgentKey =
      request.source === "agent_cli" && conversationId !== null
        ? JSON.stringify([
            request.caller.projectPath,
            resolved.worktreePath,
            conversationId,
            request.commandName,
            execution.effectiveScope,
            [...new Set(execution.scopePaths)].sort(),
          ])
        : null;
    if (activeAgentKey !== null) {
      const existingRunId = activeAgentRunsByKey.get(activeAgentKey);
      if (existingRunId !== undefined) {
        const existing = deps.repo.findById(existingRunId);
        if (existing?.status === "queued" || existing?.status === "running") {
          return rejected(
            "duplicate_active",
            `Refused duplicate "${request.commandName}": validation run "${existingRunId}" is already ${existing.status} for this conversation, worktree, scope, and paths. This is deliberate: concurrent validations read the same mutable worktree and can produce nondeterministic evidence. Wait for it with \`cctl validate status ${existingRunId}\` or cancel it before retrying.`,
            "duplicate_active",
            { existingRunId, existingStatus: existing.status },
          );
        }
        activeAgentRunsByKey.delete(activeAgentKey);
        activeAgentKeysByRun.delete(existingRunId);
      }
    }

    const runId = ids.runId();
    const nonce = ids.nonce();
    const lease: ValidationLease | null =
      request.source === "agent_cli" ? { runId, ...leases.issue() } : null;
    const cost = resolveSubmissionCost({
      cost: command.cost,
      effectiveScope: execution.effectiveScope,
      scopedPathCount: execution.scopePaths.length,
    });
    // Forwarded paths are the only scope the server itself resolves into a
    // file list; a changed or full run is narrowed inside the wrapper, which
    // never reports back, so those runs carry no count rather than a guess.
    const filesMatched =
      execution.scopePaths.length > 0
        ? countMatchedScopePaths(execution.scopePaths, resolved.worktreePath)
        : null;
    const submission: ValidationRunSubmission = {
      runId,
      source: request.source,
      commandName: request.commandName,
      cost,
      nonce,
      leaseToken: lease?.token ?? null,
      leaseExpiresAt: lease?.expiresAt ?? null,
      projectPath: request.caller.projectPath,
      worktreePath: resolved.worktreePath,
      sessionName: resolved.sessionName,
      conversationId: request.caller.conversationId ?? null,
      workflowExecutionId:
        resolved.kind === "graph_lane" ? resolved.executionId : null,
      workflowContextId:
        resolved.kind === "graph_lane" ? resolved.contextId : null,
      workflowRole: resolved.kind === "graph_lane" ? resolved.role : null,
      requestedScope: execution.requestedScope,
      effectiveScope: execution.effectiveScope,
      scopedPathCount: execution.scopePaths.length,
    };
    const spawnParams: SpawnValidationParams = {
      runId,
      nonce,
      commandName: request.commandName,
      command: execution.executable,
      cost,
      projectPath: request.caller.projectPath,
      worktreePath: resolved.worktreePath,
      sessionName: resolved.sessionName ?? "",
      branchName: resolved.branchName ?? "",
      ...(resolved.targetBranch ? { targetBranch: resolved.targetBranch } : {}),
      ...(resolved.kind === "graph_lane"
        ? { contextId: resolved.contextId }
        : {}),
      requestedScope: execution.requestedScope,
      effectiveScope: execution.effectiveScope,
      pathArgs: execution.pathArgs,
      scopePaths: execution.scopePaths,
      timeoutMs: command.timeoutMs ?? global.defaultTimeoutMs,
    };

    // Shutdown may begin while an async preflight dependency is resolving.
    // This check and scheduler.submit run without an intervening await, so no
    // run can cross the shutdown fence into the ledger.
    const unavailableAtAdmission = admissionUnavailable();
    if (unavailableAtAdmission) {
      return rejected(
        unavailableAtAdmission.reason,
        unavailableAtAdmission.message,
      );
    }
    const decision = deps.scheduler.submit(submission, {
      queueIfBusy: request.queueIfBusy ?? false,
      limit: global.concurrencyLimit,
    });
    switch (decision.kind) {
      case "cost_exceeds_limit": {
        logger.warn("validation.run_rejected", {
          name: request.commandName,
          reason: "cost_exceeds_limit",
          cost,
          limit: global.concurrencyLimit,
        });
        publishPhase("rejected", {
          ...meta,
          effectiveScope,
          outcome: "cost_exceeds_limit",
        });
        return {
          kind: "not_started",
          result: {
            kind: "cost_exceeds_limit",
            name: request.commandName,
            cost,
            limit: global.concurrencyLimit,
          },
        };
      }
      case "capacity_unavailable": {
        publishPhase("rejected", {
          ...meta,
          effectiveScope,
          outcome: "capacity_unavailable",
        });
        return {
          kind: "not_started",
          result: {
            kind: "capacity_unavailable",
            cost,
            inUse: decision.inUse,
            limit: decision.limit,
            queueDepth: decision.queueDepth,
            blockedByOlderWaiter: decision.blockedByOlderWaiter,
          },
        };
      }
      case "queued": {
        locallyOwned.add(runId);
        if (activeAgentKey !== null) {
          activeAgentRunsByKey.set(activeAgentKey, runId);
          activeAgentKeysByRun.set(runId, activeAgentKey);
        }
        preparedSpawns.set(runId, spawnParams);
        if (filesMatched !== null) scopeMatches.set(runId, filesMatched);
        publishPhase("queued", { ...meta, effectiveScope, runId });
        return {
          kind: "accepted",
          runId,
          status: "queued",
          position: decision.position,
          lease,
          requestedScope: execution.requestedScope,
          effectiveScope: execution.effectiveScope,
        };
      }
      case "admitted": {
        locallyOwned.add(runId);
        if (activeAgentKey !== null) {
          activeAgentRunsByKey.set(activeAgentKey, runId);
          activeAgentKeysByRun.set(runId, activeAgentKey);
        }
        preparedSpawns.set(runId, spawnParams);
        if (filesMatched !== null) scopeMatches.set(runId, filesMatched);
        await spawnAdmitted(decision.record);
        return {
          kind: "accepted",
          runId,
          status: "running",
          position: null,
          lease,
          requestedScope: execution.requestedScope,
          effectiveScope: execution.effectiveScope,
        };
      }
    }
  }

  async function list(
    caller: ValidationCallerRef,
  ): Promise<ValidationListResult> {
    await gate.whenOpen();
    if (initFailed) {
      return {
        kind: "invalid",
        reason: "service_unavailable",
        message:
          "Validation is unavailable: startup recovery failed and admission is closed. Check server logs (validation.recovery_failed).",
      };
    }

    const resolved = await deps.resolver.resolveCaller(caller);
    if (resolved.kind === "ambiguous") {
      return {
        kind: "invalid",
        reason: "identity_unresolved",
        message: `Refused: caller identity did not resolve (${resolved.reason}). Graph identity must match server-side workflow state; validation fails closed rather than granting unrestricted access.`,
      };
    }

    const [repoValidation, global] = await Promise.all([
      deps.config.readRepoValidation(caller.projectPath),
      deps.config.readGlobal(),
    ]);
    lastKnownLimit = global.concurrencyLimit;
    const commands = Object.entries(repoValidation?.commands ?? {}).map(
      ([name, command]) => ({
        name,
        cost: command.cost,
        description: command.description ?? null,
        pathArgs: command.pathArgs,
        changedScope:
          command.command.changed === undefined
            ? ("full_fallback" as const)
            : ("native" as const),
        timeoutMs: command.timeoutMs ?? null,
        enabled:
          resolved.kind !== "graph_lane" ||
          resolved.allowedCommands.includes(name),
      }),
    );
    const queue = deps.repo.findQueued();
    const queuePositions = new Map(
      queue.map((row, position) => [row.runId, position]),
    );
    const active = [...deps.repo.findRunning(), ...queue];
    const snapshot = deps.scheduler.snapshot();

    logger.info("validation.list_requested", {
      project: caller.projectPath,
      conversation: caller.conversationId ?? null,
      commandCount: commands.length,
      inUse: snapshot.inUse,
      limit: global.concurrencyLimit,
      queueDepth: snapshot.queueDepth,
    });

    return {
      kind: "ok",
      commands,
      capacity: { limit: global.concurrencyLimit, ...snapshot },
      runs: active.map((row) => ({
        runId: row.runId,
        commandName: row.commandName,
        status: row.status as "queued" | "running",
        cost: row.cost,
        source: row.source,
        projectPath: row.projectPath,
        conversationId: row.conversationId,
        requestedScope: row.requestedScope,
        effectiveScope: row.effectiveScope,
        position: queuePositions.get(row.runId) ?? null,
      })),
    };
  }

  async function budget(): Promise<ValidationBudgetResponse> {
    await gate.whenOpen();
    const global = await deps.config.readGlobal();
    lastKnownLimit = global.concurrencyLimit;

    const queue = deps.repo.findQueued();
    const queuePositions = new Map(
      queue.map((row, position) => [row.runId, position]),
    );
    return {
      available: !initFailed,
      capacity: {
        limit: global.concurrencyLimit,
        ...deps.scheduler.snapshot(),
      },
      runs: [...deps.repo.findRunning(), ...queue].map((row) => ({
        runId: row.runId,
        commandName: row.commandName,
        status: row.status as "queued" | "running",
        cost: row.cost,
        projectName: projectNameFromPath(row.projectPath),
        sessionName: row.sessionName,
        conversationId: row.conversationId,
        position: queuePositions.get(row.runId) ?? null,
      })),
    };
  }

  async function submitSystem(
    request: ValidationSystemSubmitRequest,
  ): Promise<ValidationSubmission> {
    await gate.whenOpen();
    const unavailableAtEntry = admissionUnavailable();
    if (unavailableAtEntry) return unavailableAtEntry;

    const commandName = request.command.name;
    let effectiveScope: ValidationScope | null = null;
    const meta = {
      runId: null,
      commandName,
      source: request.source,
      projectPath: request.projectPath,
      conversationId: request.conversationId ?? null,
      requestedScope: request.scope,
      effectiveScope: null,
    };
    logger.info("validation.run_requested", {
      name: commandName,
      source: request.source,
      project: request.projectPath,
      conversation: meta.conversationId,
      queueIfBusy: true,
      requestedScope: request.scope,
      effectiveScope,
      scopedPathCount: 0,
    });
    publishPhase("requested", meta);

    const global = await deps.config.readGlobal();
    lastKnownLimit = global.concurrencyLimit;
    const repoValidation = await deps.config.readRepoValidation(
      request.projectPath,
    );
    const registeredCommand = repoValidation?.commands[commandName];
    if (!registeredCommand) {
      const knownCommands = Object.keys(repoValidation?.commands ?? {});
      logger.warn("validation.run_rejected", {
        name: commandName,
        source: request.source,
        project: request.projectPath,
        reason: "command_not_found",
      });
      publishPhase("rejected", { ...meta, outcome: "command_not_found" });
      return {
        kind: "not_started",
        result: { kind: "command_not_found", name: commandName, knownCommands },
      };
    }

    const execution = resolveValidationExecution({
      profile: registeredCommand,
      requestedScope: request.scope,
      scopePaths: [],
      worktreePath: request.target.worktreePath,
    });
    if (!execution.ok) {
      logger.warn("validation.run_rejected", {
        name: commandName,
        source: request.source,
        project: request.projectPath,
        reason: execution.reason,
      });
      publishPhase("rejected", {
        ...meta,
        outcome: execution.reason,
      });
      return {
        kind: "invalid",
        reason: execution.reason,
        message: execution.message,
      };
    }
    effectiveScope = execution.effectiveScope;
    // System gates never forward paths, so a scope-aware registration charges
    // its full or changed weight and never the scoped one.
    const cost = resolveSubmissionCost({
      cost: registeredCommand.cost,
      effectiveScope: execution.effectiveScope,
      scopedPathCount: 0,
    });
    const timeoutMs = registeredCommand.timeoutMs ?? global.defaultTimeoutMs;

    const runId = ids.runId();
    const nonce = ids.nonce();
    const submission: ValidationRunSubmission = {
      runId,
      source: request.source,
      commandName,
      cost,
      nonce,
      leaseToken: null,
      leaseExpiresAt: null,
      projectPath: request.projectPath,
      worktreePath: request.target.worktreePath,
      sessionName: request.target.sessionName ?? null,
      conversationId: request.conversationId ?? null,
      workflowExecutionId: request.workflow?.executionId ?? null,
      workflowContextId: request.workflow?.contextId ?? null,
      workflowRole: null,
      requestedScope: execution.requestedScope,
      effectiveScope: execution.effectiveScope,
      scopedPathCount: 0,
    };
    const spawnParams: SpawnValidationParams = {
      runId,
      nonce,
      commandName,
      command: execution.executable,
      cost,
      projectPath: request.projectPath,
      worktreePath: request.target.worktreePath,
      sessionName: request.target.sessionName ?? "",
      branchName: request.target.branchName ?? "",
      ...(request.target.targetBranch
        ? { targetBranch: request.target.targetBranch }
        : {}),
      ...(request.target.contextId
        ? { contextId: request.target.contextId }
        : {}),
      requestedScope: execution.requestedScope,
      effectiveScope: execution.effectiveScope,
      pathArgs: execution.pathArgs,
      scopePaths: execution.scopePaths,
      timeoutMs,
    };

    const unavailableAtAdmission = admissionUnavailable();
    if (unavailableAtAdmission) {
      logger.warn("validation.run_rejected", {
        name: commandName,
        source: request.source,
        project: request.projectPath,
        reason: unavailableAtAdmission.reason,
      });
      publishPhase("rejected", {
        ...meta,
        effectiveScope,
        outcome: unavailableAtAdmission.reason,
      });
      return unavailableAtAdmission;
    }
    const decision = deps.scheduler.submit(submission, {
      queueIfBusy: true,
      limit: global.concurrencyLimit,
    });
    if (decision.kind === "cost_exceeds_limit") {
      logger.warn("validation.run_rejected", {
        name: commandName,
        source: request.source,
        project: request.projectPath,
        reason: "cost_exceeds_limit",
        cost,
        limit: global.concurrencyLimit,
      });
      publishPhase("rejected", {
        ...meta,
        effectiveScope,
        outcome: "cost_exceeds_limit",
      });
      return {
        kind: "not_started",
        result: {
          kind: "cost_exceeds_limit",
          name: commandName,
          cost,
          limit: global.concurrencyLimit,
        },
      };
    }
    if (decision.kind === "capacity_unavailable") {
      logger.error("validation.system_admission_refused", {
        name: commandName,
        source: request.source,
        project: request.projectPath,
        inUse: decision.inUse,
        limit: decision.limit,
        queueDepth: decision.queueDepth,
      });
      publishPhase("rejected", {
        ...meta,
        effectiveScope,
        outcome: "capacity_unavailable",
      });
      return {
        kind: "not_started",
        result: {
          kind: "capacity_unavailable",
          cost,
          inUse: decision.inUse,
          limit: decision.limit,
          queueDepth: decision.queueDepth,
          blockedByOlderWaiter: decision.blockedByOlderWaiter,
        },
      };
    }

    locallyOwned.add(runId);
    preparedSpawns.set(runId, spawnParams);
    if (decision.kind === "queued") {
      logger.info("validation.run_queued", {
        runId,
        name: commandName,
        source: request.source,
        cost,
        position: decision.position,
        requestedScope: execution.requestedScope,
        effectiveScope: execution.effectiveScope,
        scopedPathCount: execution.scopePaths.length,
      });
      publishPhase("queued", { ...meta, effectiveScope, runId });
      return {
        kind: "accepted",
        runId,
        status: "queued",
        position: decision.position,
        lease: null,
        requestedScope: execution.requestedScope,
        effectiveScope: execution.effectiveScope,
      };
    }

    await spawnAdmitted(decision.record);
    return {
      kind: "accepted",
      runId,
      status: "running",
      position: null,
      lease: null,
      requestedScope: execution.requestedScope,
      effectiveScope: execution.effectiveScope,
    };
  }

  function waitForCompletion(runId: string): Promise<ValidationRunResult> {
    const completed = results.get(runId);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve) => {
      const pending = completionWaiters.get(runId) ?? [];
      pending.push(resolve);
      completionWaiters.set(runId, pending);
    });
  }

  /**
   * Settle every reader held on `runId`. Only this run's own phases wake it:
   * queue position also moves when unrelated runs retire, and waking every
   * reader on every transition would rebuild the storm holding removes.
   */
  function notifyStatusChange(runId: string): void {
    const waiting = statusChangeWaiters.get(runId);
    if (!waiting) return;
    statusChangeWaiters.delete(runId);
    for (const settle of waiting) settle();
  }

  function waitForStatusChange(
    runId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiting = statusChangeWaiters.get(runId) ?? new Set<() => void>();
      const settle = (): void => {
        const current = statusChangeWaiters.get(runId);
        current?.delete(settle);
        if (current?.size === 0) statusChangeWaiters.delete(runId);
        signal?.removeEventListener("abort", settle);
        resolve();
      };
      waiting.add(settle);
      statusChangeWaiters.set(runId, waiting);
      signal?.addEventListener("abort", settle, { once: true });
      logger.debug("validation.status_wait", { runId, waiting: waiting.size });
    });
  }

  return {
    whenReady: () => ready,
    isAvailable: () => !initFailed,
    submit,
    list,
    budget,
    submitSystem,
    waitForCompletion,
    waitForStatusChange,

    poll(runId, leaseToken) {
      if (leaseToken) leases.renew(runId, leaseToken);
      const row = deps.repo.findById(runId);
      if (!row) {
        return {
          status: null,
          position: null,
          result: null,
          requestedScope: null,
          effectiveScope: null,
        };
      }
      const position =
        row.status === "queued"
          ? deps.repo.findQueued().findIndex((q) => q.runId === runId)
          : null;
      return {
        status: row.status,
        position,
        result: results.get(runId) ?? null,
        requestedScope: row.requestedScope,
        effectiveScope: row.effectiveScope,
      };
    },

    async cancel(runId, leaseToken) {
      const authorization = leases.authorizeCancel(runId, leaseToken);
      if (authorization !== "authorized") return { authorization };
      await cancelRun(runId, "cancelled");
      return { authorization };
    },

    async cancelSystemOwned(runId) {
      const row = deps.repo.findById(runId);
      if (!row || row.leaseToken !== null) return false;
      if (isTerminalValidationRunStatus(row.status)) return false;
      await cancelRun(runId, "cancelled");
      return true;
    },

    async sweepExpiredLeases() {
      const { expired } = await leases.sweepExpired();
      return expired.length;
    },

    async shutdown() {
      shuttingDown = true;
      const tracked = handles.list();
      logger.info("validation.shutdown", { tracked: tracked.length });
      // Group-kill tracked runs first; each finalize (which releases the
      // reservation) runs only after its group death is confirmed, and the
      // shutdown flag keeps those releases from admitting waiting work.
      await Promise.all(
        tracked.map(({ runId }) => cancelRun(runId, "interrupted")),
      );
      // Remaining active rows are queued waiters and admitted runs whose
      // spawn is still in flight; cancelRun settles each without ever
      // releasing a reservation ahead of its process group's death.
      await Promise.all(
        deps.repo
          .findStaleActive()
          .map((row) => cancelRun(row.runId, "interrupted")),
      );
    },
  };
}
