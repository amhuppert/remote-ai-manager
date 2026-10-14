import { randomUUID } from "node:crypto";
import type { ControlPermits } from "@/lib/control/permits";
import type { PermitRef } from "@/lib/control/schemas";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { IntentLedger } from "@/lib/intents/ledger";
import type {
  ExecutorKind,
  OwnerRef,
  PendingIntent,
} from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ExecutionContextsRepo } from "@/lib/state-store/execution-contexts-repo";
import {
  ContextInputRefusedError,
  DISPOSITIONS_BY_HALT,
  advanceContext,
  currentHalt,
  type ContextInput,
} from "./advance";
import {
  contextEffectRequestSchema,
  planEffects,
  waitsOnPerson,
  type ContextEffectRequest,
} from "./effects";
import { initialContextFacts } from "./facts";
import {
  applyTaskCommand,
  type TaskCommand,
  type TaskCommandResult,
} from "./ledger";
import { deriveProgress, type EffectView } from "./progress";
import { contextView, type ContextViewLookups } from "./view";
import {
  contextStartRequestSchema,
  type ContextContract,
  type ContextFacts,
  type ContextProgress,
  type ContextRecord,
  type ContextView,
  type HaltDisposition,
} from "./schemas";

/** What Run observes while a Context runs, and its settled result. */
export interface ContextProgressReport {
  contextId: string;
  progress: ContextProgress;
  occurrence: string;
  /** The accepted candidate's output, present once succeeded. */
  output?: unknown;
}

export interface ContextHostDeps {
  transaction<T>(fn: () => T): T;
  contexts: ExecutionContextsRepo;
  intents: IntentLedger;
  permits: ControlPermits;
  executors: Record<Exclude<ExecutorKind, "context">, Executor>;
  /** Hints the Run that started a Context whenever its progress changes. */
  touchRun(runId: string): void;
  /** Something a person sees of the Context changed; called inside the committing transaction. */
  changed(context: {
    runId: string;
    projectPath: string;
    sessionName: string;
  }): void;
  /** Ends the Context's workspace binding; idempotent, joins the caller's transaction. */
  releaseBinding(bindingId: string): void;
  now(): string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export const contextControllerId = (contextId: string): string =>
  `context:${contextId}`;

const owner = (contextId: string): OwnerRef => ({
  kind: "context",
  id: contextId,
});

function occurrenceKey(progress: ContextProgress): string {
  switch (progress.kind) {
    case "running":
    case "waiting":
      return `${progress.kind}:${JSON.stringify(progress.obligation)}`;
    case "halted":
      return `halted:${progress.halt}`;
    case "paused":
      return `paused:${progress.next === null ? "draining" : occurrenceKey(progress.next)}`;
    case "succeeded":
      return `succeeded:${progress.candidateId}`;
    case "stopping":
    case "cancelled":
      return progress.kind;
  }
}

function isTerminal(progress: ContextProgress): boolean {
  return progress.kind === "succeeded" || progress.kind === "cancelled";
}

/** The accepted candidate's output, once the Context succeeded. */
function acceptedOf(record: ContextRecord): { output: unknown } | null {
  const progress = record.progress;
  if (progress.kind !== "succeeded") return null;
  const accepted = record.facts.candidates.items.find(
    (candidate) => candidate.id === progress.candidateId,
  );
  return accepted === undefined ? null : { output: accepted.output };
}

/** The controller binding a seat conversation records when it is spawned. */
export interface SeatBinding {
  contextId: string;
  assignmentId: string;
  /** Which incarnation of the seat; a replaced seat's conversation loses its authority. */
  replacement: number;
}

export type SeatWorkplace =
  | {
      kind: "current";
      runId: string;
      role: "implementer" | "reviewer";
      worktreePath: string;
      /** A lane's branch; null in the session worktree, whose branch the session names. */
      branch: string | null;
      /** The registered validation commands frozen for this seat. */
      validationAccess: string[];
    }
  | { kind: "refused"; reason: string };

export interface ContextObservation {
  record: ContextRecord;
  /** Open intents whose executor already settled: a stalled host, cleared by reconcile. */
  stalled: string[];
}

/**
 * A Context as its owner reads it: what it needs next, what runs now and what
 * it produced, without the records behind them.
 */
export interface ContextSummary {
  contextId: string;
  revision: number;
  title: string;
  progress: ContextProgress;
  /** Changes whenever progress does; a halt disposition must name it. */
  occurrence: string;
  /** The accepted result, once the Context succeeded. */
  accepted: { output: unknown } | null;
  /** An effect is admitted and running: it drains through a pause. */
  active: boolean;
  /** The Context's own pause, apart from its Run's. */
  paused: boolean;
  /** What clears the current halt; empty unless halted. */
  dispositions: readonly string[];
  ownerQuestions: boolean;
  tasks: Array<{ id: string; title: string; status: "open" | "done" }>;
  /** assignment id → seat conversation id */
  seats: Record<string, string>;
  openQuestions: Array<{ questionId: string; seat: string }>;
  lastSummary: string | null;
  /** Open intents whose executor already settled: a stalled host, cleared by reconcile. */
  stalled: string[];
}

/**
 * What a resume changed: whether it lifted the Context's own pause, and the
 * disposition it applied to a halt. A disposition for a Context no longer
 * halted is ignored, so it changes nothing.
 */
export interface ContextResumption {
  unpaused: boolean;
  applied: HaltDisposition | null;
}

export interface ContextHost extends Executor<ContextProgressReport> {
  reconcile(contextId: string): Promise<void>;
  recordReconcileFailure(contextId: string, error: unknown): void;
  /** The stored record, for diagnostics and tests; consumers read `describe`. */
  observe(contextId: string): ContextObservation | null;
  describe(contextId: string): ContextSummary | null;
  /** What the Context shows a person (design §9); null when there is no such Context. */
  view(contextId: string, lookups: ContextViewLookups): ContextView | null;
  /** The Workspace evidence a candidate froze, to show what it changed; null for an unknown one. */
  candidateEvidence(contextId: string, candidateId: string): string | null;
  /**
   * Where one of this context's current seats works and what it may run
   * there, for a command it sends about its work; a refusal when `caller` is
   * not a current seat or the context has finished.
   */
  seatWorkplace(contextId: string, caller: SeatBinding): SeatWorkplace;
  /** `caller` is the calling conversation's controller binding, resolved from its record. */
  applyTaskCommand(
    contextId: string,
    caller: SeatBinding | null,
    command: TaskCommand,
  ): TaskCommandResult;
  pause(contextId: string, expectedRevision: number): void;
  resume(
    contextId: string,
    expectedRevision: number,
    disposition?: { occurrence: string; disposition: HaltDisposition },
  ): ContextResumption;
  cancel(contextId: string, expectedRevision: number): Promise<void>;
  steer(contextId: string, expectedRevision: number, instruction: string): void;
  decide(
    contextId: string,
    input: {
      candidateId: string;
      decision: "approved" | "rejected";
      notes?: string;
    },
  ): void;
  amend(
    contextId: string,
    expectedRevision: number,
    contract: ContextContract,
    reason: string,
  ): Promise<void>;
}

/** Why `caller` may not act as this context's implementer now; null when it may. */
function implementerRefusal(
  record: ContextRecord,
  caller: SeatBinding | null,
): string | null {
  if (
    caller === null ||
    caller.contextId !== record.contextId ||
    caller.assignmentId !== record.facts.contract.current.implementer.id ||
    !isCurrentIncarnation(record, caller)
  )
    return "Only this context's current implementer may do this";
  return finishedRefusal(record);
}

function isCurrentIncarnation(
  record: ContextRecord,
  caller: SeatBinding,
): boolean {
  return (
    caller.replacement ===
    (record.facts.seats.replacements[caller.assignmentId] ?? 0)
  );
}

function finishedRefusal(record: ContextRecord): string | null {
  return isTerminal(record.progress) || record.facts.control.cancelled
    ? `Context ${record.contextId} has finished`
    : null;
}

function seatWorkplaceOf(
  record: ContextRecord,
  caller: SeatBinding,
): SeatWorkplace {
  const contract = record.facts.contract.current;
  const reviewer = contract.reviewers.find((r) => r.id === caller.assignmentId);
  const seat =
    caller.assignmentId === contract.implementer.id
      ? { role: "implementer" as const, assignment: contract.implementer }
      : reviewer !== undefined
        ? { role: "reviewer" as const, assignment: reviewer }
        : null;
  if (
    seat === null ||
    caller.contextId !== record.contextId ||
    !isCurrentIncarnation(record, caller)
  )
    return {
      kind: "refused",
      reason: `This conversation is not a current seat of context ${record.contextId}`,
    };
  const finished = finishedRefusal(record);
  if (finished !== null) return { kind: "refused", reason: finished };
  return {
    kind: "current",
    runId: record.runId,
    role: seat.role,
    worktreePath: record.workspace.worktreePath,
    branch: record.workspace.kind === "lane" ? record.workspace.branch : null,
    validationAccess: seat.assignment.validationAccess,
  };
}

export function createContextHost(deps: ContextHostDeps): ContextHost {
  function requireRecord(contextId: string): ContextRecord {
    const record = deps.contexts.get(contextId);
    if (record === null)
      throw new ContextInputRefusedError(`Unknown context ${contextId}`);
    return record;
  }

  function effectViews(intents: PendingIntent[]): EffectView[] {
    return intents.map((intent) => {
      const state = executorFor(intent).outcome(intent.cause);
      const request = contextEffectRequestSchema.parse(intent.request);
      return {
        cause: intent.cause,
        admitted: state.kind === "running",
        waitsOnPerson: waitsOnPerson(request),
      };
    });
  }

  function executorFor(intent: PendingIntent): Executor {
    if (intent.executor === "context") {
      throw new Error(
        `Context ${intent.requester.id} cannot request another context`,
      );
    }
    return deps.executors[intent.executor];
  }

  /** Persists facts and the derived projection in the caller's transaction. */
  function persist(
    record: ContextRecord,
    derivedFrom: ContextFacts,
    pending: PendingIntent[],
  ): ContextRecord {
    const progress = deriveProgress(derivedFrom, effectViews(pending));
    let facts = derivedFrom;
    // A finished context gives its workspace back in the same transaction that
    // records the finish, so a later binding on the worktree is never stranded.
    if (
      isTerminal(progress) &&
      facts.binding.bound &&
      !facts.binding.released
    ) {
      deps.releaseBinding(record.contextId);
      facts = { ...facts, binding: { ...facts.binding, released: true } };
    }
    const occurrence =
      occurrenceKey(progress) === occurrenceKey(record.progress)
        ? record.progressOccurrence
        : randomUUID();
    const updatedAt = deps.now();
    const revision = deps.contexts.update(record.contextId, record.revision, {
      facts,
      progress,
      progressOccurrence: occurrence,
      updatedAt,
    });
    deps.changed(record);
    return {
      ...record,
      facts,
      progress,
      progressOccurrence: occurrence,
      revision,
      updatedAt,
    };
  }

  function permitOf(contextId: string): PermitRef | null {
    return deps.permits.current(contextControllerId(contextId));
  }

  /** Submits every pending effect the permit admits; whether there were any. */
  async function submitAdmissible(contextId: string): Promise<boolean> {
    const permit = permitOf(contextId);
    if (!deps.permits.admits(permit)) return false;
    const pending = deps.intents.pending(owner(contextId));
    for (const intent of pending) {
      // Idempotent by cause; carrying the current permit refreshes an operation
      // queued under an older generation, so a resumed obligation is admitted.
      await executorFor(intent).submit({ ...intent, permit });
    }
    return pending.length > 0;
  }

  /** Withdraws pending effects that were not admitted and releases their allowances. */
  async function withdrawUnadmitted(contextId: string): Promise<void> {
    for (const intent of deps.intents.pending(owner(contextId))) {
      const executor = executorFor(intent);
      const state = executor.outcome(intent.cause);
      if (state.kind !== "queued" && state.kind !== "unknown") continue;
      await executor.withdraw(intent.cause);
      const request: ContextEffectRequest = contextEffectRequestSchema.parse(
        intent.request,
      );
      deps.transaction(() => {
        const record = requireRecord(contextId);
        deps.intents.close(intent.id);
        persist(
          record,
          advanceContext(record.facts, {
            kind: "withdrawn",
            cause: intent.cause,
            request,
          }),
          deps.intents.pending(owner(contextId)),
        );
      });
    }
  }

  /**
   * Tells the Run when what it reads may have changed: a new progress
   * occurrence, or a consumed outcome, which can end the Context's admitted
   * activity (a paused Run's drain) while its progress stays as it was.
   */
  function afterCommit(
    before: ContextRecord,
    after: ContextRecord,
    consumedOutcome = false,
  ): void {
    if (
      consumedOutcome ||
      after.progressOccurrence !== before.progressOccurrence
    ) {
      deps.touchRun(after.runId);
    }
  }

  function applyControl(
    contextId: string,
    expectedRevision: number | null,
    input: ContextInput,
    permitChange?: () => void,
  ): void {
    let before: ContextRecord | null = null;
    const after = deps.transaction(() => {
      const record = requireRecord(contextId);
      if (expectedRevision !== null && record.revision !== expectedRevision) {
        throw new ContextInputRefusedError(
          `Context ${contextId} is at revision ${record.revision}, not ${expectedRevision}`,
        );
      }
      before = record;
      permitChange?.();
      const facts = advanceContext(record.facts, input);
      return persist(record, facts, deps.intents.pending(owner(contextId)));
    });
    if (before !== null) afterCommit(before, after);
  }

  const host: ContextHost = {
    submit(intent) {
      const request = contextStartRequestSchema.parse(intent.request);
      const parent = intent.permit;
      if (parent === null)
        throw new Error(
          `Context ${request.contextId} must start under its Run's permit`,
        );
      deps.transaction(() => {
        if (deps.contexts.getByStartCause(intent.cause) !== null) return;
        const now = deps.now();
        deps.permits.issue({
          controllerId: contextControllerId(request.contextId),
          // The Run that started it controls it through the permit it started it under.
          parent: parent.controllerId,
          now,
        });
        const facts = initialContextFacts({
          contextId: request.contextId,
          workspace: request.workspace,
          contract: request.contract,
          policy: request.policy,
        });
        deps.contexts.insertIfAbsent({
          contextId: request.contextId,
          runId: request.runId,
          projectPath: request.workspace.projectPath,
          sessionName: request.workspace.sessionName,
          ownerConversationId: request.ownerConversationId,
          startCause: intent.cause,
          workspace: request.workspace,
          facts,
          revision: 1,
          progress: deriveProgress(facts, []),
          progressOccurrence: randomUUID(),
          createdAt: now,
          updatedAt: now,
        });
      });
    },

    outcome(cause): OperationState<ContextProgressReport> {
      const record = deps.contexts.getByStartCause(cause);
      if (record === null) return { kind: "unknown" };
      const report: ContextProgressReport = {
        contextId: record.contextId,
        progress: record.progress,
        occurrence: record.progressOccurrence,
      };
      if (!isTerminal(record.progress))
        return { kind: "running", progress: report };
      const accepted = acceptedOf(record);
      return {
        kind: "settled",
        outcome: {
          ...report,
          ...(accepted !== null ? { output: accepted.output } : {}),
        },
      };
    },

    withdraw(cause) {
      const record = deps.contexts.getByStartCause(cause);
      if (record === null) return;
      return host.cancel(record.contextId, record.revision);
    },

    async reconcile(contextId) {
      let before: ContextRecord | null = null;
      let consumed = false;
      const after = deps.transaction(() => {
        const record = requireRecord(contextId);
        before = record;
        let facts = record.facts;
        for (const intent of deps.intents.pending(owner(contextId))) {
          const state = executorFor(intent).outcome(intent.cause);
          if (state.kind !== "settled" && state.kind !== "uncertain") continue;
          const request = contextEffectRequestSchema.parse(intent.request);
          facts = advanceContext(facts, {
            kind: "outcome",
            cause: intent.cause,
            request,
            state:
              state.kind === "settled"
                ? { kind: "settled", outcome: state.outcome }
                : { kind: "uncertain", evidence: state.evidence },
            at: deps.now(),
          });
          deps.intents.close(intent.id);
          consumed = true;
        }
        const permit = permitOf(contextId);
        if (deps.permits.admits(permit)) {
          const othersPending =
            deps.intents.pending(owner(contextId)).length > 0;
          const planned = planEffects({
            facts,
            othersPending,
            now: deps.now(),
          });
          facts = planned.facts;
          for (const effect of planned.effects) {
            deps.intents.record({
              requester: owner(contextId),
              executor: effect.executor,
              cause: effect.cause,
              permit,
              request: effect.request,
              recordedAt: deps.now(),
            });
          }
        }
        return persist(record, facts, deps.intents.pending(owner(contextId)));
      });
      if (before !== null) afterCommit(before, after, consumed);
      // A seat's conversation is created as its turn is submitted, after the
      // commit that planned it, so the run's page hears of it once more.
      if (await submitAdmissible(contextId)) deps.changed(after);
    },

    recordReconcileFailure(contextId, error) {
      deps.log.error("execution_context.reconcile_failed", {
        contextId,
        error: getErrorMessage(error),
      });
      applyControl(contextId, null, {
        kind: "reconcile_failed",
        detail: getErrorMessage(error),
      });
    },

    observe(contextId) {
      const record = deps.contexts.get(contextId);
      if (record === null) return null;
      const stalled = deps.intents
        .pending(owner(contextId))
        .filter((intent) => {
          const state = executorFor(intent).outcome(intent.cause);
          return state.kind === "settled" || state.kind === "uncertain";
        })
        .map((intent) => intent.cause);
      return { record, stalled };
    },

    describe(contextId) {
      const observed = host.observe(contextId);
      if (observed === null) return null;
      const { record, stalled } = observed;
      const { facts, progress } = record;
      const pending = deps.intents.pending(owner(contextId));
      return {
        contextId,
        revision: record.revision,
        title: facts.contract.current.title,
        progress,
        occurrence: record.progressOccurrence,
        accepted: acceptedOf(record),
        // A question waiting on its owner is not work that drains.
        active: effectViews(pending).some(
          (effect) => effect.admitted && !effect.waitsOnPerson,
        ),
        paused: facts.control.paused,
        dispositions:
          progress.kind === "halted" ? DISPOSITIONS_BY_HALT[progress.halt] : [],
        ownerQuestions: facts.contract.current.ownerQuestions,
        tasks: facts.ledger.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
        })),
        seats: facts.seats.conversations,
        openQuestions: facts.requests.open.map((open) => ({
          questionId: open.questionId,
          seat: open.seat,
        })),
        lastSummary: facts.ledger.lastSummary,
        stalled,
      };
    },

    view(contextId, lookups) {
      const record = deps.contexts.get(contextId);
      if (record === null) return null;
      return contextView(record, {
        ...lookups,
        active: effectViews(deps.intents.pending(owner(contextId))).some(
          (effect) => effect.admitted && !effect.waitsOnPerson,
        ),
      });
    },

    candidateEvidence(contextId, candidateId) {
      const record = deps.contexts.get(contextId);
      return (
        record?.facts.candidates.items.find(
          (candidate) => candidate.id === candidateId,
        )?.evidence ?? null
      );
    },

    seatWorkplace(contextId, caller) {
      return seatWorkplaceOf(requireRecord(contextId), caller);
    },

    applyTaskCommand(contextId, caller, command) {
      const outcome = deps.transaction(
        (): {
          result: TaskCommandResult;
          change: { before: ContextRecord; after: ContextRecord } | null;
        } => {
          const record = requireRecord(contextId);
          const facts = record.facts;
          const refusal = implementerRefusal(record, caller);
          if (refusal !== null)
            return {
              result: { kind: "refused", reason: refusal },
              change: null,
            };
          const applied = applyTaskCommand(facts, command);
          if (applied.kind === "refused")
            return { result: applied, change: null };
          const after = persist(
            record,
            applied.facts,
            deps.intents.pending(owner(contextId)),
          );
          return { result: applied, change: { before: record, after } };
        },
      );
      if (outcome.change !== null)
        afterCommit(outcome.change.before, outcome.change.after);
      return outcome.result;
    },

    pause(contextId, expectedRevision) {
      applyControl(contextId, expectedRevision, { kind: "pause" }, () =>
        deps.permits.close(contextControllerId(contextId), deps.now()),
      );
    },

    resume(contextId, expectedRevision, disposition) {
      let before: ContextRecord | null = null;
      let resumption: ContextResumption = { unpaused: false, applied: null };
      const after = deps.transaction(() => {
        const record = requireRecord(contextId);
        if (record.revision !== expectedRevision) {
          throw new ContextInputRefusedError(
            `Context ${contextId} is at revision ${record.revision}, not ${expectedRevision}`,
          );
        }
        before = record;
        let facts = record.facts;
        if (currentHalt(facts) !== null) {
          if (disposition === undefined) {
            throw new ContextInputRefusedError(
              `Context ${contextId} is halted; resume needs a disposition for occurrence ${record.progressOccurrence}`,
            );
          }
          if (disposition.occurrence !== record.progressOccurrence) {
            throw new ContextInputRefusedError(
              `The disposition names occurrence ${disposition.occurrence}, but the context is at ${record.progressOccurrence}`,
            );
          }
          facts = advanceContext(facts, {
            kind: "disposition",
            disposition: disposition.disposition,
            occurrence: disposition.occurrence,
            at: deps.now(),
          });
          resumption = { ...resumption, applied: disposition.disposition };
        }
        if (record.facts.control.paused) {
          resumption = { ...resumption, unpaused: true };
          deps.permits.reopen(contextControllerId(contextId), deps.now());
        }
        facts = advanceContext(facts, { kind: "resume" });
        return persist(record, facts, deps.intents.pending(owner(contextId)));
      });
      if (before !== null) afterCommit(before, after);
      return resumption;
    },

    async cancel(contextId, expectedRevision) {
      applyControl(contextId, expectedRevision, { kind: "cancel" }, () =>
        deps.permits.revoke(contextControllerId(contextId), deps.now()),
      );
      for (const intent of deps.intents.pending(owner(contextId))) {
        const executor = executorFor(intent);
        if (executor.outcome(intent.cause).kind === "running") {
          await executor.interrupt?.(intent.cause);
        }
      }
      await withdrawUnadmitted(contextId);
    },

    steer(contextId, expectedRevision, instruction) {
      applyControl(contextId, expectedRevision, {
        kind: "steer",
        id: randomUUID(),
        instruction,
      });
    },

    decide(contextId, input) {
      applyControl(contextId, null, {
        kind: "decide",
        candidateId: input.candidateId,
        decision: input.decision,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        decidedAt: deps.now(),
      });
    },

    async amend(contextId, expectedRevision, contract, reason) {
      const record = requireRecord(contextId);
      const admitted = effectViews(deps.intents.pending(owner(contextId))).some(
        (e) => e.admitted,
      );
      if (admitted || !record.facts.control.paused) {
        throw new ContextInputRefusedError(
          `Context ${contextId} must be paused with no admitted effect before amendment`,
        );
      }
      applyControl(contextId, expectedRevision, {
        kind: "amend",
        contract,
        reason,
        at: deps.now(),
      });
      // Queued work was composed from the old contract; the next plan uses the new one.
      await withdrawUnadmitted(contextId);
    },
  };
  return host;
}
