import type { ControlPermits } from "@/lib/control/permits";
import type { ContextHost, ContextSummary } from "@/lib/execution-context/host";
import { contextStartRequestSchema } from "@/lib/execution-context/schemas";
import { runControllerId } from "@/lib/execution-context/host";
import type { ContextProgress } from "@/lib/execution-context/schemas";
import type { IntentLedger } from "@/lib/intents/ledger";
import type { OwnerRef } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { RunsRepo } from "@/lib/state-store/runs-repo";
import {
  decideNext,
  deriveRunProgress,
  onlyHaltsRemain,
  planRun,
  type ObservedContexts,
  type RunPlan,
} from "./schedule";
import {
  boundaryDetail,
  type RunBoundary,
  type RunBoundaryKind,
  type RunDefinitionContext,
  type RunDisposition,
  type RunFacts,
  type RunInvocation,
  type RunLoop,
  type RunProgress,
  type RunRecord,
} from "./schemas";

export interface RunLaunchInput {
  runId: string;
  cause: string;
  kind: RunFacts["kind"];
  title: string;
  projectPath: string;
  sessionName: string;
  owner: { conversationId: string; sessionName: string | null };
  /**
   * Every context the run may start, each with its frozen start request; a
   * context starts once the routes from the contexts it depends on are decided
   * and taken.
   */
  contexts: RunDefinitionContext[];
  loops?: RunLoop[];
}

export interface RunHostDeps {
  transaction<T>(fn: () => T): T;
  runs: RunsRepo;
  intents: IntentLedger;
  permits: ControlPermits;
  /** The Run reads its Contexts through their summaries, never their records. */
  contexts: Pick<ContextHost, "submit" | "outcome" | "describe" | "resume" | "cancel" | "decide">;
  touchContext(contextId: string): void;
  /** Queues an owner-facing boundary into the owner conversation, waking it when idle. */
  notifyOwner(input: { run: RunRecord; boundary: RunBoundary }): Promise<void>;
  now(): string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export interface RunObservation {
  record: RunRecord;
  boundaries: RunBoundary[];
}

/** What a Run's Contexts say about it; reading them can fail where the record cannot. */
export interface RunInspection {
  /** Where each defined context, loop and route stands. */
  plan: RunPlan;
  /** Pending start intents whose Context already settled: a stalled host. */
  stalled: string[];
}

export interface RunHost {
  launch(input: RunLaunchInput): Promise<RunRecord>;
  reconcile(runId: string): Promise<void>;
  recordReconcileFailure(runId: string, error: unknown): void;
  /** The record and ledger only; it reads no Context, so ownership checks never depend on one. */
  observe(runId: string): RunObservation | null;
  /** Reads every started Context and pending start. */
  inspect(runId: string): RunInspection | null;
  /** `expectedRevision` null skips the optimistic check for callers that hold no revision. */
  pause(runId: string, expectedRevision: number | null): Promise<void>;
  resume(
    runId: string,
    expectedRevision: number | null,
    dispositions?: RunDisposition[],
  ): Promise<void>;
  cancel(runId: string, expectedRevision: number | null): Promise<void>;
  /** Records a human approval decision on one of the Run's Contexts. */
  decide(
    runId: string,
    contextId: string,
    input: {
      candidateId: string;
      decision: "approved" | "rejected";
      notes?: string;
    },
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
  context: ContextSummary,
): Omit<RunBoundary, "seq" | "notifiedAt" | "recordedAt"> | null {
  const { progress, occurrence } = context;
  const base = {
    runId: run.runId,
    occurrence: `${invocation.contextId}:${occurrence}`,
  };
  const title = context.title;
  if (
    progress.kind === "waiting" &&
    progress.obligation.kind === "await_answer"
  ) {
    return {
      ...base,
      kind: "question",
      summary: `${title}: the agent asked you a question.`,
      detail: {
        contextId: invocation.contextId,
        questionId: progress.obligation.questionId,
      },
    };
  }
  if (
    progress.kind === "waiting" &&
    progress.obligation.kind === "await_approval"
  ) {
    return {
      ...base,
      kind: "approval",
      summary: `${title}: the result awaits a human decision.`,
      detail: {
        contextId: invocation.contextId,
        candidateId: progress.obligation.candidateId,
      },
    };
  }
  if (progress.kind === "halted") {
    return {
      ...base,
      kind: "halted",
      summary: `${title}: halted (${progress.halt}). ${progress.detail}`,
      detail: {
        contextId: invocation.contextId,
        halt: progress.halt,
        occurrence,
        dispositions: context.dispositions,
      },
    };
  }
  return null;
}

export function createRunHost(deps: RunHostDeps): RunHost {
  function requireRecord(runId: string): RunRecord {
    const record = deps.runs.get(runId);
    if (record === null) throw new Error(`Unknown run ${runId}`);
    return record;
  }

  function observeInvocations(facts: RunFacts) {
    return facts.invocations.map((invocation) => ({
      invocation,
      key: invocation.key,
      context: deps.contexts.describe(invocation.contextId),
    }));
  }

  function recordBoundary(
    run: RunRecord,
    boundary: {
      occurrence: string;
      kind: RunBoundaryKind;
      summary: string;
      detail: unknown;
    },
  ): void {
    deps.runs.recordBoundary({
      runId: run.runId,
      ...boundary,
      recordedAt: deps.now(),
    });
  }

  function observedOf(
    views: ReturnType<typeof observeInvocations>,
  ): ObservedContexts {
    return new Map(
      views.map((v) => [
        v.invocation.contextId,
        {
          progress: v.context?.progress ?? null,
          output: v.context?.accepted?.output,
          active: v.context?.active ?? false,
        },
      ]),
    );
  }

  /**
   * Starts every context the scheduler finds eligible, recording its start
   * intent with the inputs bound now. Joins the caller's transaction.
   */
  function startEligible(record: RunRecord, facts: RunFacts): RunFacts {
    const starts = decideNext(facts, observedOf(observeInvocations(facts)));
    if (starts.length === 0) return facts;
    const permit = deps.permits.current(runControllerId(record.runId));
    const byKey = new Map(facts.definition.contexts.map((c) => [c.key, c]));
    const started: RunInvocation[] = starts.map((start) => {
      const defined = byKey.get(start.key);
      if (defined === undefined)
        throw new Error(`Run ${record.runId} has no context ${start.key}`);
      const request = {
        ...defined.request,
        contextId: start.contextId,
        contract: { ...defined.request.contract, inputs: start.inputs },
      };
      const invocation: RunInvocation = {
        key: start.key,
        pass: start.pass,
        contextId: start.contextId,
        startCause: `${record.runId}:start:${start.key}:${start.pass}`,
        request,
      };
      deps.intents.record({
        requester: owner(record.runId),
        executor: "context",
        cause: invocation.startCause,
        permit,
        request,
        recordedAt: deps.now(),
      });
      return invocation;
    });
    return { ...facts, invocations: [...facts.invocations, ...started] };
  }

  /**
   * Route and loop halts reach the owner at once. Only a definition change
   * clears them, so a halt reported while other work remains (moving, held by
   * a pause or fault, or waiting on the owner) promises one more notice, and
   * the run records it once the halts are all that stands.
   */
  function projectRunHalts(
    record: RunRecord,
    observed: ObservedContexts,
    plan: RunPlan,
  ): void {
    if (plan.halts.length === 0) return;
    const otherWorkRemains = !onlyHaltsRemain(record.facts, observed, plan);
    for (const halt of plan.halts) {
      recordBoundary(record, {
        occurrence: halt.occurrence,
        kind: "halted",
        summary: `${record.facts.title}: ${halt.reason}.`,
        detail: { runHalt: halt.kind, otherWorkRemains },
      });
    }
    if (otherWorkRemains) return;
    const boundaries = deps.runs.boundaries(record.runId);
    // A promise counts until a follow-up answers it.
    const answered = Math.max(
      0,
      ...boundaries
        .filter((boundary) => boundaryDetail(boundary).runHalt === "stalled")
        .map((boundary) => boundary.seq),
    );
    const occurrences = new Set(plan.halts.map((halt) => halt.occurrence));
    const promised = boundaries.some(
      (boundary) =>
        boundary.seq > answered &&
        occurrences.has(boundary.occurrence) &&
        boundaryDetail(boundary).otherWorkRemains === true,
    );
    if (!promised) return;
    recordBoundary(record, {
      occurrence: `run:stalled:${[...occurrences].sort().join(",")}`,
      kind: "halted",
      summary: `${record.facts.title}: only halted routes or loops remain. ${plan.halts.map((halt) => halt.reason).join("; ")}.`,
      detail: { runHalt: "stalled", otherWorkRemains: false },
    });
  }

  /** Projects and persists in the caller's transaction. */
  function project(record: RunRecord, facts: RunFacts): RunRecord {
    const views = observeInvocations(facts);
    for (const view of views) {
      if (view.context === null) continue;
      const boundary = contextBoundary(record, view.invocation, view.context);
      if (boundary !== null) recordBoundary(record, boundary);
    }
    const fault = facts.control.fault;
    if (fault !== null) {
      recordBoundary(record, {
        occurrence: `run:fault:${fault.at}`,
        kind: "halted",
        summary: `${facts.title}: the run could not be reconciled: ${fault.detail}. Resume it to retry.`,
        detail: { error: fault.detail },
      });
    }
    const observed = observedOf(views);
    const plan = planRun(facts, observed);
    const progress = deriveRunProgress(facts, observed);
    if (!facts.control.cancelled) projectRunHalts(record, observed, plan);
    if (progress.kind === "succeeded") {
      recordBoundary(record, {
        occurrence: "run:succeeded",
        kind: "succeeded",
        summary: `${facts.title}: finished.`,
        detail: {
          outputs: Object.fromEntries(
            facts.definition.contexts.flatMap((c) => {
              const state = plan.keys.get(c.key);
              if (state?.kind !== "started") return [];
              return [[c.key, observed.get(state.contextId)?.output ?? null]];
            }),
          ),
        },
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
    const revision = deps.runs.update(record.runId, record.revision, {
      facts,
      progress,
      updatedAt,
    });
    return { ...record, facts, progress, revision, updatedAt };
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
    for (const intent of deps.intents.pending(owner(runId))) {
      // Rechecked per start: a pause or cancel between two submissions stops the rest.
      if (!deps.permits.admits(permit)) return;
      await deps.contexts.submit({ ...intent, permit });
      deps.touchContext(
        contextStartRequestSchema.parse(intent.request).contextId,
      );
    }
  }

  function updateControl(
    runId: string,
    expectedRevision: number | null,
    change: Partial<RunFacts["control"]>,
    permitChange: () => void,
  ): RunRecord {
    return deps.transaction(() => {
      const record = requireRecord(runId);
      if (expectedRevision !== null && record.revision !== expectedRevision) {
        throw new RunControlRefusedError(
          `Run ${runId} is at revision ${record.revision}, not ${expectedRevision}`,
        );
      }
      if (
        record.progress.kind === "succeeded" ||
        record.progress.kind === "cancelled"
      ) {
        throw new RunControlRefusedError(
          `Run ${runId} already finished (${record.progress.kind})`,
        );
      }
      permitChange();
      return project(record, {
        ...record.facts,
        control: { ...record.facts.control, ...change },
      });
    });
  }

  const host: RunHost = {
    async launch(input) {
      const record = deps.transaction(() => {
        const existing = deps.runs.getByLaunchCause(input.cause);
        if (existing !== null) return existing;
        const now = deps.now();
        deps.permits.issue({
          controllerId: runControllerId(input.runId),
          parent: null,
          now,
        });
        const facts: RunFacts = {
          runId: input.runId,
          kind: input.kind,
          title: input.title,
          definition: {
            revision: 1,
            contexts: input.contexts,
            ...(input.loops !== undefined ? { loops: input.loops } : {}),
          },
          invocations: [],
          control: { paused: false, cancelled: false, fault: null },
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
          createdAt: now,
          updatedAt: now,
        };
        deps.runs.insertIfAbsent(created);
        // The first contexts start with the launch itself, so a run is never
        // persisted without the work its definition can begin.
        return project(created, startEligible(created, facts));
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
        project(record, startEligible(record, record.facts));
      });
      await submitAdmissible(runId);
      await notifyPending(runId);
    },

    recordReconcileFailure(runId, error) {
      const detail = getErrorMessage(error);
      deps.log.error("runs.reconcile_failed", { runId, error: detail });
      // A fault the owner clears: nothing new is admitted until they resume. Recorded
      // without reading the Contexts, since reading one may be what failed.
      deps.transaction(() => {
        const record = requireRecord(runId);
        if (record.facts.control.fault !== null) return;
        deps.permits.close(runControllerId(runId), deps.now());
        const facts: RunFacts = {
          ...record.facts,
          control: { ...record.facts.control, fault: { detail, at: deps.now() } },
        };
        const progress: RunProgress = facts.control.cancelled
          ? record.progress
          : { kind: "needs_owner", reasons: [`run: ${detail}`] };
        const updatedAt = deps.now();
        deps.runs.update(runId, record.revision, { facts, progress, updatedAt });
        recordBoundary(record, {
          occurrence: `run:fault:${facts.control.fault?.at ?? updatedAt}`,
          kind: "halted",
          summary: `${facts.title}: the run could not be reconciled: ${detail}. Resume it to retry.`,
          detail: { error: detail },
        });
      });
      void notifyPending(runId);
    },

    observe(runId) {
      const record = deps.runs.get(runId);
      if (record === null) return null;
      return { record, boundaries: deps.runs.boundaries(runId) };
    },

    inspect(runId) {
      const record = deps.runs.get(runId);
      if (record === null) return null;
      const stalled = deps.intents
        .pending(owner(runId))
        .filter(
          (intent) => deps.contexts.outcome(intent.cause).kind === "settled",
        )
        .map((intent) => intent.cause);
      const plan = planRun(
        record.facts,
        observedOf(observeInvocations(record.facts)),
      );
      return { plan, stalled };
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
        const members = new Set(
          current.facts.invocations.map((invocation) => invocation.contextId),
        );
        const foreign = dispositions.find((d) => !members.has(d.contextId));
        if (foreign !== undefined) {
          throw new RunControlRefusedError(
            `Context ${foreign.contextId} does not belong to run ${runId}`,
          );
        }
        // Resume clears a fault too: the owner asked the run to try again.
        const resumed = updateControl(
          runId,
          expectedRevision,
          { paused: false, fault: null },
          () => {
            const { paused, fault } = current.facts.control;
            if (paused || fault !== null)
              deps.permits.reopen(runControllerId(runId), deps.now());
          },
        );
        for (const invocation of resumed.facts.invocations) {
          const disposition = dispositions.find(
            (d) => d.contextId === invocation.contextId,
          );
          const context = deps.contexts.describe(invocation.contextId);
          if (context === null) continue;
          if (disposition !== undefined || context.paused) {
            deps.contexts.resume(
              invocation.contextId,
              context.revision,
              disposition === undefined
                ? undefined
                : {
                    occurrence: disposition.occurrence,
                    disposition: disposition.disposition,
                  },
            );
          }
        }
        return resumed;
      });
      for (const invocation of record.facts.invocations)
        deps.touchContext(invocation.contextId);
      await host.reconcile(runId);
    },

    async cancel(runId, expectedRevision) {
      const record = updateControl(
        runId,
        expectedRevision,
        { cancelled: true },
        () => {
          deps.permits.revoke(runControllerId(runId), deps.now());
          // A start recorded but never submitted (a crash in between) will not
          // run: the revoked permit refuses it, so its intent closes with the run.
          for (const intent of deps.intents.pending(owner(runId))) {
            if (deps.contexts.outcome(intent.cause).kind === "unknown")
              deps.intents.close(intent.id);
          }
        },
      );
      for (const invocation of record.facts.invocations) {
        const context = deps.contexts.describe(invocation.contextId);
        if (context === null || isTerminal(context.progress)) continue;
        await deps.contexts.cancel(invocation.contextId, context.revision);
      }
      await host.reconcile(runId);
    },

    decide(runId, contextId, input) {
      const record = requireRecord(runId);
      if (
        !record.facts.invocations.some(
          (invocation) => invocation.contextId === contextId,
        )
      ) {
        throw new RunControlRefusedError(
          `Context ${contextId} does not belong to run ${runId}`,
        );
      }
      deps.contexts.decide(contextId, input);
    },

    async restoreAfterRestart() {
      const active = deps.runs
        .listActive()
        .filter((run) => !run.facts.control.cancelled);
      // Close every permit first, in one transaction, so nothing a later failure
      // skips can admit work before its owner decides to resume.
      deps.transaction(() => {
        for (const run of active)
          deps.permits.close(runControllerId(run.runId), deps.now());
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
          deps.log.error("runs.restore_failed", {
            runId: run.runId,
            error: getErrorMessage(error),
          });
        }
      }
      // Finished runs too: a result whose notice was lost must still reach its owner.
      for (const runId of deps.runs.runsWithUnnotifiedBoundaries())
        await notifyPending(runId);
    },
  };
  return host;
}
