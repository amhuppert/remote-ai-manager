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
import {
  contextStartRequestSchema,
  type ContextContract,
  type ContextFacts,
  type ContextProgress,
  type ContextRecord,
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
  /** Ends the Context's workspace binding; idempotent, joins the caller's transaction. */
  releaseBinding(bindingId: string): void;
  now(): string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export const contextControllerId = (contextId: string): string =>
  `context:${contextId}`;
export const runControllerId = (runId: string): string => `run:${runId}`;

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

/** The controller binding a seat conversation records when it is spawned. */
export interface SeatBinding {
  contextId: string;
  assignmentId: string;
  /** Which incarnation of the seat; a replaced seat's conversation loses its authority. */
  replacement: number;
}

export interface ContextObservation {
  record: ContextRecord;
  /** Open intents whose executor already settled: a stalled host, cleared by reconcile. */
  stalled: string[];
}

export interface ContextHost extends Executor<ContextProgressReport> {
  reconcile(contextId: string): Promise<void>;
  recordReconcileFailure(contextId: string, error: unknown): void;
  observe(contextId: string): ContextObservation | null;
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
  ): void;
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

  async function submitAdmissible(contextId: string): Promise<void> {
    const permit = permitOf(contextId);
    if (!deps.permits.admits(permit)) return;
    for (const intent of deps.intents.pending(owner(contextId))) {
      // Idempotent by cause; carrying the current permit refreshes an operation
      // queued under an older generation, so a resumed obligation is admitted.
      await executorFor(intent).submit({ ...intent, permit });
    }
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

  function afterCommit(before: ContextRecord, after: ContextRecord): void {
    if (after.progressOccurrence !== before.progressOccurrence) {
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
      deps.transaction(() => {
        if (deps.contexts.getByStartCause(intent.cause) !== null) return;
        const now = deps.now();
        deps.permits.issue({
          controllerId: contextControllerId(request.contextId),
          parent: runControllerId(request.runId),
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
      const accepted =
        record.progress.kind === "succeeded"
          ? record.facts.candidates.items.find(
              (c) =>
                record.progress.kind === "succeeded" &&
                c.id === record.progress.candidateId,
            )
          : undefined;
      return {
        kind: "settled",
        outcome: {
          ...report,
          ...(accepted !== undefined ? { output: accepted.output } : {}),
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
          });
          deps.intents.close(intent.id);
        }
        const permit = permitOf(contextId);
        const stillPending = deps.intents.pending(owner(contextId));
        if (stillPending.length === 0 && deps.permits.admits(permit)) {
          const planned = planEffects({ facts });
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
      if (before !== null) afterCommit(before, after);
      await submitAdmissible(contextId);
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

    applyTaskCommand(contextId, caller, command) {
      const outcome = deps.transaction(
        (): {
          result: TaskCommandResult;
          change: { before: ContextRecord; after: ContextRecord } | null;
        } => {
          const record = requireRecord(contextId);
          const facts = record.facts;
          if (
            caller === null ||
            caller.contextId !== contextId ||
            caller.assignmentId !== "implementer" ||
            caller.replacement !==
              (facts.seats.replacements[caller.assignmentId] ?? 0)
          ) {
            return {
              result: {
                kind: "refused",
                reason:
                  "Only this context's current implementer may change its tasks",
              },
              change: null,
            };
          }
          if (isTerminal(record.progress) || facts.control.cancelled) {
            return {
              result: {
                kind: "refused",
                reason: `Context ${contextId} has finished; its tasks no longer change`,
              },
              change: null,
            };
          }
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
          });
        }
        if (record.facts.control.paused) {
          deps.permits.reopen(contextControllerId(contextId), deps.now());
        }
        facts = advanceContext(facts, { kind: "resume" });
        return persist(record, facts, deps.intents.pending(owner(contextId)));
      });
      if (before !== null) afterCommit(before, after);
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
