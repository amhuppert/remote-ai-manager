import type { ControlPermits } from "@/lib/control/permits";
import type { ContextHost } from "@/lib/execution-context/host";
import { contextStartRequestSchema, type ContextStartRequest } from "@/lib/execution-context/schemas";
import { runControllerId } from "@/lib/execution-context/host";
import type { ContextProgress } from "@/lib/execution-context/schemas";
import type { IntentLedger } from "@/lib/intents/ledger";
import type { OwnerRef } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { RunsRepo } from "@/lib/state-store/runs-repo";
import type {
  RunBoundary,
  RunBoundaryKind,
  RunDisposition,
  RunFacts,
  RunInvocation,
  RunProgress,
  RunRecord,
} from "./schemas";

export interface RunLaunchInput {
  runId: string;
  cause: string;
  kind: RunFacts["kind"];
  title: string;
  projectPath: string;
  sessionName: string;
  owner: { conversationId: string; sessionName: string | null };
  /** One frozen start request per invocation, keyed by its authored position. */
  invocations: Array<{ key: string; request: ContextStartRequest }>;
}

export interface RunHostDeps {
  transaction<T>(fn: () => T): T;
  runs: RunsRepo;
  intents: IntentLedger;
  permits: ControlPermits;
  contexts: ContextHost;
  touchContext(contextId: string): void;
  /** Queues an owner-facing boundary into the owner conversation, waking it when idle. */
  notifyOwner(input: { run: RunRecord; boundary: RunBoundary }): Promise<void>;
  now(): string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export interface RunObservation {
  record: RunRecord;
  boundaries: RunBoundary[];
  /** Pending start intents whose Context already settled: a stalled host. */
  stalled: string[];
}

export interface RunHost {
  launch(input: RunLaunchInput): Promise<RunRecord>;
  reconcile(runId: string): Promise<void>;
  recordReconcileFailure(runId: string, error: unknown): void;
  observe(runId: string): RunObservation | null;
  /** `expectedRevision` null skips the optimistic check for callers that hold no revision. */
  pause(runId: string, expectedRevision: number | null): Promise<void>;
  resume(runId: string, expectedRevision: number | null, dispositions?: RunDisposition[]): Promise<void>;
  cancel(runId: string, expectedRevision: number | null): Promise<void>;
  /** Records a human approval decision on one of the Run's Contexts. */
  decide(
    runId: string,
    contextId: string,
    input: { candidateId: string; decision: "approved" | "rejected"; notes?: string },
  ): void;
  /** Boot: every active Run restores paused, and its owner is told. */
  restoreAfterRestart(): Promise<void>;
}

const owner = (runId: string): OwnerRef => ({ kind: "run", id: runId });

/** A control request the Run's current state refuses; nothing changed. */
export class RunControlRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunControlRefusedError";
  }
}

function isTerminal(progress: ContextProgress | null): boolean {
  return progress?.kind === "succeeded" || progress?.kind === "cancelled";
}

/** The owner-facing occurrences a Context's progress asks for. */
function contextBoundary(
  run: RunRecord,
  invocation: RunInvocation,
  progress: ContextProgress,
  occurrence: string,
): Omit<RunBoundary, "seq" | "notifiedAt" | "recordedAt"> | null {
  const base = { runId: run.runId, occurrence: `${invocation.contextId}:${occurrence}` };
  const title = invocation.request.contract.title;
  if (progress.kind === "waiting" && progress.obligation.kind === "await_answer") {
    return {
      ...base,
      kind: "question",
      summary: `${title}: the agent asked you a question.`,
      detail: { contextId: invocation.contextId, questionId: progress.obligation.questionId },
    };
  }
  if (progress.kind === "waiting" && progress.obligation.kind === "await_approval") {
    return {
      ...base,
      kind: "approval",
      summary: `${title}: the result awaits a human decision.`,
      detail: { contextId: invocation.contextId, candidateId: progress.obligation.candidateId },
    };
  }
  if (progress.kind === "halted") {
    return {
      ...base,
      kind: "halted",
      summary: `${title}: halted (${progress.halt}). ${progress.detail}`,
      detail: { contextId: invocation.contextId, halt: progress.halt, occurrence },
    };
  }
  return null;
}

/** Run progress from control and the observed invocations. Pure. */
export function deriveRunProgress(
  facts: RunFacts,
  views: ReadonlyArray<{ key: string; progress: ContextProgress | null }>,
): RunProgress {
  const allTerminal = views.every((v) => isTerminal(v.progress));
  if (facts.control.cancelled) return allTerminal ? { kind: "cancelled" } : { kind: "stopping" };
  // Success outranks pause: work that drained during a pause and finished the run is done.
  if (views.length > 0 && views.every((v) => v.progress?.kind === "succeeded")) {
    return { kind: "succeeded" };
  }
  if (facts.control.paused) {
    const draining = views.some((v) => v.progress?.kind === "paused" && v.progress.draining);
    return { kind: "paused", draining };
  }
  const reasons = views.flatMap((v) => {
    const progress = v.progress;
    if (progress === null) return [];
    if (progress.kind === "halted") return [`${v.key}: halted (${progress.halt})`];
    if (progress.kind === "waiting" && progress.obligation.kind === "await_answer") {
      return [`${v.key}: question`];
    }
    if (progress.kind === "waiting" && progress.obligation.kind === "await_approval") {
      return [`${v.key}: approval`];
    }
    return [];
  });
  const independentWork = views.some((v) => v.progress?.kind === "running");
  if (reasons.length > 0 && !independentWork) return { kind: "needs_owner", reasons };
  return { kind: "running" };
}

export function createRunHost(deps: RunHostDeps): RunHost {
  function requireRecord(runId: string): RunRecord {
    const record = deps.runs.get(runId);
    if (record === null) throw new Error(`Unknown run ${runId}`);
    return record;
  }

  function observeInvocations(facts: RunFacts) {
    return facts.invocations.map((invocation) => {
      const observed = deps.contexts.observe(invocation.contextId);
      return {
        invocation,
        key: invocation.key,
        contextId: invocation.contextId,
        progress: observed?.record.progress ?? null,
        occurrence: observed?.record.progressOccurrence ?? null,
        output: observed?.record.progress.kind === "succeeded"
          ? observed.record.facts.candidates.items.find(
              (c) => observed.record.progress.kind === "succeeded" && c.id === observed.record.progress.candidateId,
            )?.output
          : undefined,
      };
    });
  }

  function recordBoundary(
    run: RunRecord,
    boundary: { occurrence: string; kind: RunBoundaryKind; summary: string; detail: unknown },
  ): void {
    deps.runs.recordBoundary({ runId: run.runId, ...boundary, recordedAt: deps.now() });
  }

  /** Projects and persists in the caller's transaction. */
  function project(record: RunRecord, facts: RunFacts): RunRecord {
    const views = observeInvocations(facts);
    for (const view of views) {
      if (view.progress === null || view.occurrence === null) continue;
      const boundary = contextBoundary(record, view.invocation, view.progress, view.occurrence);
      if (boundary !== null) recordBoundary(record, boundary);
    }
    const progress = deriveRunProgress(facts, views);
    if (progress.kind === "succeeded") {
      recordBoundary(record, {
        occurrence: "run:succeeded",
        kind: "succeeded",
        summary: `${facts.title}: finished.`,
        detail: { outputs: Object.fromEntries(views.map((v) => [v.key, v.output ?? null])) },
      });
    }
    if (progress.kind === "cancelled") {
      recordBoundary(record, {
        occurrence: "run:cancelled",
        kind: "cancelled",
        summary: `${facts.title}: cancelled.`,
        detail: {},
      });
    }
    const updatedAt = deps.now();
    const invocations = views.map((v) => ({
      key: v.key,
      contextId: v.contextId,
      progress: v.progress,
      occurrence: v.occurrence,
    }));
    const revision = deps.runs.update(record.runId, record.revision, {
      facts,
      progress,
      invocations,
      updatedAt,
    });
    return { ...record, facts, progress, invocations, revision, updatedAt };
  }

  const notifying = new Map<string, Promise<void>>();
  const notifyAgain = new Set<string>();

  /** Delivers in boundary order; a failure stops the run's queue until the next attempt or boot. */
  async function deliverPending(runId: string): Promise<void> {
    const run = requireRecord(runId);
    for (const boundary of deps.runs.unnotifiedBoundaries(runId)) {
      try {
        await deps.notifyOwner({ run, boundary });
      } catch (error) {
        deps.log.error("runs.owner_notify_failed", {
          runId,
          boundary: boundary.seq,
          kind: boundary.kind,
          error: getErrorMessage(error),
        });
        return;
      }
      deps.transaction(() => deps.runs.markNotified(boundary.seq, deps.now()));
    }
  }

  /** One delivery pass per run at a time, so overlapping reconciles never send a boundary twice. */
  function notifyPending(runId: string): Promise<void> {
    const inFlight = notifying.get(runId);
    if (inFlight !== undefined) {
      notifyAgain.add(runId);
      return inFlight;
    }
    const pass = (async () => {
      do {
        notifyAgain.delete(runId);
        await deliverPending(runId);
      } while (notifyAgain.has(runId));
    })().finally(() => notifying.delete(runId));
    notifying.set(runId, pass);
    return pass;
  }

  async function submitAdmissible(runId: string): Promise<void> {
    const permit = deps.permits.current(runControllerId(runId));
    if (!deps.permits.admits(permit)) return;
    for (const intent of deps.intents.pending(owner(runId))) {
      await deps.contexts.submit({ ...intent, permit });
      deps.touchContext(contextStartRequestSchema.parse(intent.request).contextId);
    }
  }

  function updateControl(runId: string, expectedRevision: number | null, change: Partial<RunFacts["control"]>, permitChange: () => void): RunRecord {
    return deps.transaction(() => {
      const record = requireRecord(runId);
      if (expectedRevision !== null && record.revision !== expectedRevision) {
        throw new RunControlRefusedError(`Run ${runId} is at revision ${record.revision}, not ${expectedRevision}`);
      }
      if (record.progress.kind === "succeeded" || record.progress.kind === "cancelled") {
        throw new RunControlRefusedError(`Run ${runId} already finished (${record.progress.kind})`);
      }
      permitChange();
      return project(record, { ...record.facts, control: { ...record.facts.control, ...change } });
    });
  }

  const host: RunHost = {
    async launch(input) {
      const record = deps.transaction(() => {
        const existing = deps.runs.getByLaunchCause(input.cause);
        if (existing !== null) return existing;
        const now = deps.now();
        deps.permits.issue({ controllerId: runControllerId(input.runId), parent: null, now });
        const invocations: RunInvocation[] = input.invocations.map((inv) => ({
          key: inv.key,
          pass: 0,
          contextId: inv.request.contextId,
          startCause: `${input.runId}:start:${inv.key}:0`,
          request: inv.request,
        }));
        const facts: RunFacts = {
          runId: input.runId,
          kind: input.kind,
          title: input.title,
          invocations,
          control: { paused: false, cancelled: false },
        };
        const created: RunRecord = {
          runId: input.runId,
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          ownerConversationId: input.owner.conversationId,
          ownerSessionName: input.owner.sessionName,
          launchCause: input.cause,
          facts,
          revision: 1,
          progress: { kind: "running" },
          invocations: invocations.map((i) => ({ key: i.key, contextId: i.contextId, progress: null, occurrence: null })),
          createdAt: now,
          updatedAt: now,
        };
        deps.runs.insertIfAbsent(created);
        const permit = deps.permits.current(runControllerId(input.runId));
        for (const invocation of invocations) {
          deps.intents.record({
            requester: owner(input.runId),
            executor: "context",
            cause: invocation.startCause,
            permit,
            request: invocation.request,
            recordedAt: now,
          });
        }
        return created;
      });
      await host.reconcile(record.runId);
      return requireRecord(record.runId);
    },

    async reconcile(runId) {
      deps.transaction(() => {
        const record = requireRecord(runId);
        for (const intent of deps.intents.pending(owner(runId))) {
          const state = deps.contexts.outcome(intent.cause);
          if (state.kind === "settled") deps.intents.close(intent.id);
        }
        project(record, record.facts);
      });
      await submitAdmissible(runId);
      await notifyPending(runId);
    },

    recordReconcileFailure(runId, error) {
      deps.log.error("runs.reconcile_failed", { runId, error: getErrorMessage(error) });
      deps.transaction(() => {
        const record = requireRecord(runId);
        recordBoundary(record, {
          occurrence: `run:reconcile_failed:${record.revision}`,
          kind: "halted",
          summary: `${record.facts.title}: the run could not be reconciled: ${getErrorMessage(error)}. Resume it to retry.`,
          detail: { error: getErrorMessage(error) },
        });
      });
    },

    observe(runId) {
      const record = deps.runs.get(runId);
      if (record === null) return null;
      const stalled = deps.intents
        .pending(owner(runId))
        .filter((intent) => deps.contexts.outcome(intent.cause).kind === "settled")
        .map((intent) => intent.cause);
      return { record, boundaries: deps.runs.boundaries(runId), stalled };
    },

    async pause(runId, expectedRevision) {
      updateControl(runId, expectedRevision, { paused: true }, () =>
        deps.permits.close(runControllerId(runId), deps.now()),
      );
    },

    async resume(runId, expectedRevision, dispositions = []) {
      // One transaction: a refused disposition leaves the run paused and every
      // context as it was, rather than half resumed.
      const record = deps.transaction(() => {
        const current = requireRecord(runId);
        const members = new Set(current.facts.invocations.map((invocation) => invocation.contextId));
        const foreign = dispositions.find((d) => !members.has(d.contextId));
        if (foreign !== undefined) {
          throw new RunControlRefusedError(`Context ${foreign.contextId} does not belong to run ${runId}`);
        }
        const resumed = updateControl(runId, expectedRevision, { paused: false }, () => {
          if (current.facts.control.paused) deps.permits.reopen(runControllerId(runId), deps.now());
        });
        for (const invocation of resumed.facts.invocations) {
          const disposition = dispositions.find((d) => d.contextId === invocation.contextId);
          const observed = deps.contexts.observe(invocation.contextId);
          if (observed === null) continue;
          if (disposition !== undefined || observed.record.facts.control.paused) {
            deps.contexts.resume(
              invocation.contextId,
              observed.record.revision,
              disposition === undefined
                ? undefined
                : { occurrence: disposition.occurrence, disposition: disposition.disposition },
            );
          }
        }
        return resumed;
      });
      for (const invocation of record.facts.invocations) deps.touchContext(invocation.contextId);
      await host.reconcile(runId);
    },

    async cancel(runId, expectedRevision) {
      const record = updateControl(runId, expectedRevision, { cancelled: true }, () =>
        deps.permits.revoke(runControllerId(runId), deps.now()),
      );
      for (const invocation of record.facts.invocations) {
        const observed = deps.contexts.observe(invocation.contextId);
        if (observed === null || isTerminal(observed.record.progress)) continue;
        await deps.contexts.cancel(invocation.contextId, observed.record.revision);
      }
      await host.reconcile(runId);
    },

    decide(runId, contextId, input) {
      const record = requireRecord(runId);
      if (!record.facts.invocations.some((invocation) => invocation.contextId === contextId)) {
        throw new RunControlRefusedError(`Context ${contextId} does not belong to run ${runId}`);
      }
      deps.contexts.decide(contextId, input);
    },

    async restoreAfterRestart() {
      const active = deps.runs.listActive().filter((run) => !run.facts.control.cancelled);
      // Close every permit first, in one transaction, so nothing a later failure
      // skips can admit work before its owner decides to resume.
      deps.transaction(() => {
        for (const run of active) deps.permits.close(runControllerId(run.runId), deps.now());
      });
      for (const run of active) {
        try {
          deps.transaction(() => {
            const record = requireRecord(run.runId);
            const restored = project(record, {
              ...record.facts,
              control: { ...record.facts.control, paused: true },
            });
            recordBoundary(restored, {
              occurrence: `run:restored_paused:${restored.revision}`,
              kind: "restored_paused",
              summary: `${restored.facts.title}: the server restarted, so this run is paused until someone resumes it.`,
              detail: {},
            });
          });
        } catch (error) {
          deps.log.error("runs.restore_failed", { runId: run.runId, error: getErrorMessage(error) });
        }
      }
      // Finished runs too: a result whose notice was lost must still reach its owner.
      for (const runId of deps.runs.runsWithUnnotifiedBoundaries()) await notifyPending(runId);
    },
  };
  return host;
}
