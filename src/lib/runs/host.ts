import type { ControlPermits } from "@/lib/control/permits";
import type { ContextHost, ContextSummary } from "@/lib/execution-context/host";
import { contextStartRequestSchema } from "@/lib/execution-context/schemas";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { IntentLedger } from "@/lib/intents/ledger";
import type { PendingIntent } from "@/lib/intents/schemas";
import { laneBindingId, laneProvisionReportSchema, lanePublicationReportSchema } from "@/lib/workspace/schemas";
import type { OwnerRef } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { RunsRepo } from "@/lib/state-store/runs-repo";
import { amendDefinition, type ProposedDefinition } from "./amendment";
import {
  deriveRunProgress,
  onlyHaltsRemain,
  decideNext,
  isTerminal,
  planRun,
  type ObservedContexts,
  type RunPlan,
} from "./schedule";
import {
  laneStateOf,
  type RunBoundary,
  type RunBoundaryDetail,
  type RunBoundaryKind,
  type RunDefinitionContext,
  type RunDisposition,
  type RunFacts,
  type RunInvocation,
  type RunLane,
  type RunLaneState,
  type RunLoop,
  type RunProgress,
  type RunRecord,
} from "./schemas";

/** The permit a Run controls its Contexts and lane steps through. */
const runControllerId = (runId: string): string => `run:${runId}`;

type LaneStep = "provision" | "publish";

/** A lane step's cause names the run, the step, the lane and the attempt; the Run reads them back from it. */
const laneStepCause = (runId: string, step: LaneStep, lane: string, attempt: number): string =>
  `${runId}:${step}:${lane}:${attempt}`;

function parseLaneStepCause(
  runId: string,
  cause: string,
): { step: LaneStep; lane: string; attempt: number } | null {
  const prefix = `${runId}:`;
  if (!cause.startsWith(prefix)) return null;
  const [step, ...rest] = cause.slice(prefix.length).split(":");
  const attempt = Number(rest.pop());
  const lane = rest.join(":");
  if ((step !== "provision" && step !== "publish") || !Number.isInteger(attempt) || lane.length === 0) return null;
  return { step, lane, attempt };
}

function withLane(facts: RunFacts, lane: string, state: RunLaneState): RunFacts {
  return { ...facts, lanes: { ...facts.lanes, [lane]: state } };
}

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
  lanes?: RunLane[];
  /** The workflow as its owner wrote it. */
  authored?: Record<string, unknown>;
}

export interface RunHostDeps {
  transaction<T>(fn: () => T): T;
  runs: RunsRepo;
  intents: IntentLedger;
  permits: ControlPermits;
  /** The Run reads its Contexts through their summaries, never their records. */
  contexts: Pick<ContextHost, "submit" | "outcome" | "describe" | "resume" | "cancel" | "decide">;
  /** Workspace provisions and publishes the Run's lanes. */
  workspace: Pick<Executor, "submit" | "outcome" | "withdraw"> & {
    interrupt(cause: string): void | Promise<void>;
  };
  touchContext(contextId: string): void;
  /**
   * The owner follows its run's boundaries with wake, so each one reaches it
   * without a wait. Idempotent: a restart repairs a launch that could not.
   */
  followOwner(run: RunRecord): Promise<void>;
  /** New boundaries were recorded and committed: deliver them now, not at the next delivery pass. */
  boundariesRecorded(runId: string): void;
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
  /** Open intents whose executor already settled, or ended uncertain: a stalled host, cleared by reconcile. */
  stalled: string[];
  /** Each started Context as the plan read it, by Context id; null when it could not be found. */
  contexts: ReadonlyMap<string, ContextSummary | null>;
}

export interface RunHost {
  launch(input: RunLaunchInput): Promise<RunRecord>;
  reconcile(runId: string): Promise<void>;
  recordReconcileFailure(runId: string, error: unknown): void;
  /** The record and ledger only; it reads no Context, so ownership checks never depend on one. */
  observe(runId: string): RunObservation | null;
  /** Reads every started Context and pending start. */
  inspect(runId: string): RunInspection | null;
  pause(runId: string): Promise<void>;
  resume(runId: string, dispositions?: RunDisposition[]): Promise<void>;
  cancel(runId: string): Promise<void>;
  /**
   * Asks for a new attempt at a lane's halted publication or failed
   * provisioning, after the owner fixed what stopped it.
   */
  retryLane(runId: string, lane: string): Promise<void>;
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
  /**
   * Replaces a workflow's definition with its next revision, unless work it
   * already did forbids the change (design §7.6). `basedOn` names the
   * definition revision the proposal was made from; null applies it to the
   * definition as it is now.
   */
  amend(
    runId: string,
    input: { definition: ProposedDefinition; basedOn: number | null },
  ): Promise<void>;
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

/**
 * Whether an error is a Run refusal. Judged by name: the supervision a route
 * calls is created at boot, and a server can load this module once for boot
 * and again for a route, so the refusal's class need not be the route's.
 */
export function isRunRefusal(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "RunControlRefusedError" ||
      error.name === "RunAmendmentRefusedError")
  );
}

/** The changes an amendment refusal names, or null for any other error. */
export function amendmentIssuesOf(error: unknown): string[] | null {
  if (!(error instanceof Error) || error.name !== "RunAmendmentRefusedError")
    return null;
  const issues: unknown = "issues" in error ? error.issues : null;
  return Array.isArray(issues) && issues.every((issue) => typeof issue === "string")
    ? issues
    : null;
}

/** An amendment that work the Run already did forbids; nothing changed. */
export class RunAmendmentRefusedError extends RunControlRefusedError {
  constructor(readonly issues: string[]) {
    super(`The amendment changes work that already happened: ${issues.join("; ")}`);
    this.name = "RunAmendmentRefusedError";
  }
}

/**
 * The owner-facing occurrences a Context asks for: each open question once,
 * whatever else its seats are doing, and its progress's approval or halt.
 */
function contextBoundaries(
  run: RunRecord,
  invocation: RunInvocation,
  context: ContextSummary,
): Array<Omit<RunBoundary, "seq" | "recordedAt">> {
  const questions = context.openQuestions.map((open) => ({
    runId: run.runId,
    occurrence: `${invocation.contextId}:question:${open.questionId}`,
    kind: "question" as const,
    summary: `${context.title}: the agent asked you a question.`,
    detail: { kind: "question" as const, contextId: invocation.contextId, questionId: open.questionId },
  }));
  const progressBoundary = contextBoundary(run, invocation, context);
  return progressBoundary === null ? questions : [...questions, progressBoundary];
}

/** The halt a Run's own reconcile failure records; a resume clears it. */
function faultBoundary(
  facts: RunFacts,
  fault: { detail: string; at: string },
): Omit<RunBoundary, "seq" | "recordedAt" | "runId"> {
  return {
    occurrence: `run:fault:${fault.at}`,
    kind: "halted",
    summary: `${facts.title}: the run could not be reconciled: ${fault.detail}. Resume it to retry.`,
    detail: { kind: "fault", error: fault.detail },
  };
}

/** The owner-facing occurrence a Context's progress asks for. */
function contextBoundary(
  run: RunRecord,
  invocation: RunInvocation,
  context: ContextSummary,
): Omit<RunBoundary, "seq" | "recordedAt"> | null {
  const { progress, occurrence } = context;
  const base = {
    runId: run.runId,
    occurrence: `${invocation.contextId}:${occurrence}`,
  };
  const title = context.title;
  if (
    progress.kind === "waiting" &&
    progress.obligation.kind === "await_approval"
  ) {
    return {
      ...base,
      kind: "approval",
      summary: `${title}: the result awaits a human decision.`,
      detail: {
        kind: "approval",
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
        kind: "context_halt",
        contextId: invocation.contextId,
        halt: progress.halt,
        occurrence,
        dispositions: [...context.dispositions],
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

  /** Runs with a boundary recorded since their last announcement. */
  const fresh = new Set<string>();

  function recordBoundary(
    run: RunRecord,
    boundary: {
      occurrence: string;
      kind: RunBoundaryKind;
      summary: string;
      detail: RunBoundaryDetail;
    },
  ): void {
    const recorded = deps.runs.recordBoundary({
      runId: run.runId,
      ...boundary,
      recordedAt: deps.now(),
    });
    if (recorded) fresh.add(run.runId);
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
          openQuestions: v.context?.openQuestions.length ?? 0,
        },
      ]),
    );
  }

  /** What Workspace needs to provision or publish one of the Run's lanes. */
  function laneTarget(record: RunRecord, lane: RunLane) {
    return {
      projectPath: record.projectPath,
      sessionName: record.sessionName,
      laneId: lane.laneId,
      worktreePath: lane.worktreePath,
      branch: lane.branch,
      sessionWorktreePath: lane.target.worktreePath,
      sessionBranch: lane.target.branch,
    };
  }

  function laneOf(facts: RunFacts, key: string): RunLane {
    const lane = (facts.definition.lanes ?? []).find((l) => l.key === key);
    if (lane === undefined) throw new Error(`Run ${facts.runId} has no lane ${key}`);
    return lane;
  }

  /** Records the Workspace request for a lane step, joining the caller's transaction. */
  function requestLaneStep(
    record: RunRecord,
    lane: RunLane,
    step: "provision" | "publish",
    attempt: number,
  ): void {
    const target = laneTarget(record, lane);
    deps.intents.record({
      requester: owner(record.runId),
      executor: "workspace",
      cause: laneStepCause(record.runId, step, lane.key, attempt),
      permit: deps.permits.current(runControllerId(record.runId)),
      request:
        step === "provision"
          ? { kind: "provision", bindingId: laneBindingId(target), lane: target }
          : { kind: "publish", bindingId: laneBindingId(target), lane: target, checks: lane.checks },
      recordedAt: deps.now(),
    });
  }

  /**
   * Starts every context and lane step the scheduler finds due, recording
   * each intent with the inputs bound now. Nothing new starts while the run is
   * paused, cancelled or faulted. Joins the caller's transaction.
   */
  function startEligible(record: RunRecord, facts: RunFacts): RunFacts {
    const plan = decideNext(facts, observedOf(observeInvocations(facts)));
    if (plan.starts.length === 0 && plan.laneActions.length === 0) return facts;
    const permit = deps.permits.current(runControllerId(record.runId));
    const byKey = new Map(facts.definition.contexts.map((c) => [c.key, c]));
    const started: RunInvocation[] = plan.starts.map((start) => {
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
    const lanes = { ...(facts.lanes ?? {}) };
    for (const action of plan.laneActions) {
      const lane = laneOf(facts, action.lane);
      if (action.kind === "provision") {
        requestLaneStep(record, lane, "provision", 1);
        lanes[lane.key] = {
          provision: { attempt: 1, outcome: { kind: "requested" } },
          publication: null,
        };
        continue;
      }
      const state = laneStateOf({ lanes }, lane.key);
      if (state === undefined) throw new Error(`Lane ${lane.key} was never provisioned`);
      requestLaneStep(record, lane, "publish", action.attempt);
      lanes[lane.key] = {
        ...state,
        publication: { attempt: action.attempt, outcome: { kind: "requested" } },
      };
    }
    return {
      ...facts,
      invocations: [...facts.invocations, ...started],
      ...(plan.laneActions.length > 0 ? { lanes } : {}),
    };
  }

  /** Where an intent's operation stands, asked of the executor that runs it. */
  function outcomeOf(intent: PendingIntent): OperationState {
    return intent.executor === "workspace"
      ? deps.workspace.outcome(intent.cause)
      : deps.contexts.outcome(intent.cause);
  }

  /** Records that cancelling withdrew a lane step before Workspace admitted it. Pure over facts. */
  function cancelLaneStep(facts: RunFacts, intent: PendingIntent): RunFacts {
    const step = parseLaneStepCause(facts.runId, intent.cause);
    const current = step === null ? undefined : laneStateOf(facts, step.lane);
    if (step === null || current === undefined) return facts;
    const cancelled = { kind: "cancelled" as const };
    if (step.step === "provision")
      return current.provision.attempt === step.attempt
        ? withLane(facts, step.lane, { ...current, provision: { attempt: step.attempt, outcome: cancelled } })
        : facts;
    return current.publication?.attempt === step.attempt
      ? withLane(facts, step.lane, { ...current, publication: { attempt: step.attempt, outcome: cancelled } })
      : facts;
  }

  /**
   * Records what Workspace reported for a lane step, unless a newer attempt
   * replaced the one it answers. A step Workspace could not settle reads as
   * refused (provisioning) or uncertain (publication), with what it knows.
   * Pure over facts.
   */
  function consumeLaneOutcome(
    facts: RunFacts,
    intent: PendingIntent,
    state: Extract<OperationState, { kind: "settled" | "uncertain" }>,
  ): RunFacts {
    const step = parseLaneStepCause(facts.runId, intent.cause);
    const current = step === null ? undefined : laneStateOf(facts, step.lane);
    if (step === null || current === undefined) return facts;
    if (step.step === "provision") {
      if (current.provision.attempt !== step.attempt) return facts;
      const outcome =
        state.kind === "uncertain"
          ? { kind: "refused" as const, detail: state.evidence }
          : laneProvisionReportSchema.parse(state.outcome);
      return withLane(facts, step.lane, { ...current, provision: { attempt: step.attempt, outcome } });
    }
    if (current.publication?.attempt !== step.attempt) return facts;
    const outcome =
      state.kind === "uncertain"
        ? { kind: "publication_uncertain" as const, detail: state.evidence }
        : lanePublicationReportSchema.parse(state.outcome);
    return withLane(facts, step.lane, { ...current, publication: { attempt: step.attempt, outcome } });
  }

  /**
   * Route and loop halts reach the owner at once. Only an amendment (or
   * cancelling) clears them, so a halt reported while other work remains
   * (moving, held by a pause or fault, or waiting on the owner) promises one
   * more notice, and the run records it once the halts are all that stands.
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
        detail: {
          kind: "run_halt",
          halt: halt.kind,
          clearedBy: halt.clearedBy,
          ...(halt.lane !== undefined ? { lane: halt.lane } : {}),
          otherWorkRemains,
        },
      });
    }
    // A lane halt clears with a retry the owner can ask for at once; the
    // follow-up is for route and loop halts, which only an amendment or cancelling ends.
    if (otherWorkRemains || plan.halts.some((halt) => halt.clearedBy === "retry_lane")) return;
    const boundaries = deps.runs.boundaries(record.runId);
    // A promise counts until a follow-up answers it.
    const answered = Math.max(
      0,
      ...boundaries.filter((boundary) => boundary.detail.kind === "stalled").map((boundary) => boundary.seq),
    );
    const occurrences = new Set(plan.halts.map((halt) => halt.occurrence));
    const promised = boundaries.some(
      (boundary) =>
        boundary.seq > answered &&
        occurrences.has(boundary.occurrence) &&
        boundary.detail.kind === "run_halt" &&
        boundary.detail.otherWorkRemains,
    );
    if (!promised) return;
    recordBoundary(record, {
      occurrence: `run:stalled:${[...occurrences].sort().join(",")}`,
      kind: "halted",
      summary: `${record.facts.title}: only halted routes or loops remain. ${plan.halts.map((halt) => halt.reason).join("; ")}.`,
      detail: {
        kind: "stalled",
        clearedBy: plan.halts.every((halt) => halt.clearedBy === "cancel") ? "cancel" : "amend",
      },
    });
  }

  /** Projects and persists in the caller's transaction. */
  function project(record: RunRecord, facts: RunFacts): RunRecord {
    const views = observeInvocations(facts);
    for (const view of views) {
      if (view.context === null) continue;
      for (const boundary of contextBoundaries(record, view.invocation, view.context))
        recordBoundary(record, boundary);
    }
    if (facts.control.fault !== null) recordBoundary(record, faultBoundary(facts, facts.control.fault));
    const observed = observedOf(views);
    const plan = planRun(facts, observed);
    const laneStepRunning = deps.intents
      .pending(owner(record.runId))
      .some((intent) => intent.executor === "workspace" && deps.workspace.outcome(intent.cause).kind === "running");
    const progress = deriveRunProgress(facts, observed, laneStepRunning);
    if (!facts.control.cancelled) projectRunHalts(record, observed, plan);
    if (progress.kind === "succeeded") {
      recordBoundary(record, {
        occurrence: "run:succeeded",
        kind: "succeeded",
        summary: `${facts.title}: finished.`,
        detail: {
          kind: "succeeded",
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
        detail: { kind: "cancelled" },
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

  /** Announces boundaries recorded since the last announcement; call only after their transaction commits. */
  function announce(runId: string): void {
    if (fresh.delete(runId)) deps.boundariesRecorded(runId);
  }

  async function followOwner(run: RunRecord): Promise<void> {
    try {
      await deps.followOwner(run);
    } catch (error) {
      deps.log.error("runs.owner_follow_failed", {
        runId: run.runId,
        conversationId: run.ownerConversationId,
        error: getErrorMessage(error),
      });
    }
  }

  async function submitAdmissible(runId: string): Promise<void> {
    const permit = deps.permits.current(runControllerId(runId));
    for (const intent of deps.intents.pending(owner(runId))) {
      // Rechecked per start: a pause or cancel between two submissions stops the rest.
      if (!deps.permits.admits(permit)) return;
      if (intent.executor === "workspace") {
        await deps.workspace.submit({ ...intent, permit });
        continue;
      }
      await deps.contexts.submit({ ...intent, permit });
      deps.touchContext(
        contextStartRequestSchema.parse(intent.request).contextId,
      );
    }
  }

  function updateControl(
    runId: string,
    change: Partial<RunFacts["control"]>,
    /** Changes the permit, and any facts that change with it, in the same transaction. */
    permitChange: (facts: RunFacts) => RunFacts | void,
  ): RunRecord {
    return deps.transaction(() => {
      const record = requireRecord(runId);
      if (
        record.progress.kind === "succeeded" ||
        record.progress.kind === "cancelled"
      ) {
        throw new RunControlRefusedError(
          `Run ${runId} already finished (${record.progress.kind})`,
        );
      }
      const facts = permitChange(record.facts) ?? record.facts;
      return project(record, {
        ...facts,
        control: { ...facts.control, ...change },
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
            ...(input.lanes !== undefined ? { lanes: input.lanes } : {}),
            ...(input.authored !== undefined ? { authored: input.authored } : {}),
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
      await followOwner(record);
      await host.reconcile(record.runId);
      return requireRecord(record.runId);
    },

    async reconcile(runId) {
      deps.transaction(() => {
        const record = requireRecord(runId);
        let facts = record.facts;
        for (const intent of deps.intents.pending(owner(runId))) {
          const state = outcomeOf(intent);
          if (facts.control.cancelled) {
            // A lane step not yet admitted never will be, including one a restart
            // returned to the queue; a start recorded but never submitted (a crash
            // in between) is refused by the revoked permit. Both close with the run.
            if (intent.executor === "workspace" && (state.kind === "queued" || state.kind === "unknown")) {
              void deps.workspace.withdraw(intent.cause);
              facts = cancelLaneStep(facts, intent);
              deps.intents.close(intent.id);
              continue;
            }
            if (state.kind === "unknown") {
              deps.intents.close(intent.id);
              continue;
            }
          }
          if (state.kind !== "settled" && state.kind !== "uncertain") continue;
          if (intent.executor === "workspace")
            facts = consumeLaneOutcome(facts, intent, state);
          deps.intents.close(intent.id);
        }
        project(record, startEligible(record, facts));
      });
      announce(runId);
      await submitAdmissible(runId);
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
        const fault = { detail, at: deps.now() };
        const facts: RunFacts = { ...record.facts, control: { ...record.facts.control, fault } };
        const progress: RunProgress = facts.control.cancelled
          ? record.progress
          : { kind: "needs_owner", reasons: [`run: ${detail}`] };
        const updatedAt = deps.now();
        deps.runs.update(runId, record.revision, { facts, progress, updatedAt });
        recordBoundary(record, faultBoundary(facts, fault));
      });
      announce(runId);
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
        .filter((intent) => {
          const state = outcomeOf(intent);
          return state.kind === "settled" || state.kind === "uncertain";
        })
        .map((intent) => intent.cause);
      const views = observeInvocations(record.facts);
      const plan = planRun(record.facts, observedOf(views));
      return { plan, stalled, contexts: new Map(views.map((v) => [v.invocation.contextId, v.context])) };
    },

    async pause(runId) {
      updateControl(runId, { paused: true }, () =>
        deps.permits.close(runControllerId(runId), deps.now()),
      );
    },

    async resume(runId, dispositions = []) {
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

    async cancel(runId) {
      const running: string[] = [];
      const record = updateControl(
        runId,
        { cancelled: true },
        () => {
          deps.permits.revoke(runControllerId(runId), deps.now());
          // One running is stopped and awaited; reconcile closes what never started.
          for (const intent of deps.intents.pending(owner(runId)))
            if (intent.executor === "workspace" && outcomeOf(intent).kind === "running")
              running.push(intent.cause);
        },
      );
      for (const cause of running) void deps.workspace.interrupt(cause);
      for (const invocation of record.facts.invocations) {
        const context = deps.contexts.describe(invocation.contextId);
        if (context === null || isTerminal(context.progress)) continue;
        await deps.contexts.cancel(invocation.contextId, context.revision);
      }
      await host.reconcile(runId);
    },

    async retryLane(runId, laneKey) {
      deps.transaction(() => {
        const record = requireRecord(runId);
        if (record.facts.control.cancelled)
          throw new RunControlRefusedError(`Run ${runId} was cancelled`);
        const lane = (record.facts.definition.lanes ?? []).find((l) => l.key === laneKey);
        if (lane === undefined)
          throw new RunControlRefusedError(`Run ${runId} has no lane "${laneKey}"`);
        const state = laneStateOf(record.facts, laneKey);
        const publication = state?.publication;
        let next: RunLaneState;
        if (
          state !== undefined &&
          publication !== null &&
          publication !== undefined &&
          publication.outcome.kind !== "requested" &&
          publication.outcome.kind !== "published"
        ) {
          const attempt = publication.attempt + 1;
          requestLaneStep(record, lane, "publish", attempt);
          next = { ...state, publication: { attempt, outcome: { kind: "requested" } } };
        } else if (state?.provision.outcome.kind === "refused") {
          const attempt = state.provision.attempt + 1;
          requestLaneStep(record, lane, "provision", attempt);
          next = { ...state, provision: { attempt, outcome: { kind: "requested" } } };
        } else {
          throw new RunControlRefusedError(
            `Lane "${laneKey}" of run ${runId} has nothing to retry: only a halted publication or a failed provisioning is retried`,
          );
        }
        project(record, {
          ...record.facts,
          lanes: { ...record.facts.lanes, [laneKey]: next },
        });
      });
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

    async amend(runId, { definition: proposed, basedOn }) {
      const revision = deps.transaction(() => {
        const record = requireRecord(runId);
        const { facts } = record;
        if (facts.kind !== "workflow")
          throw new RunControlRefusedError(
            `Run ${runId} runs one agent; only a workflow run's definition can be amended`,
          );
        if (facts.control.cancelled || record.progress.kind === "succeeded")
          throw new RunControlRefusedError(
            `Run ${runId} already finished (${facts.control.cancelled ? "cancelled" : "succeeded"})`,
          );
        if (basedOn !== null && basedOn !== facts.definition.revision)
          throw new RunControlRefusedError(
            `Run ${runId}'s definition is at revision ${facts.definition.revision}, not ${basedOn}; read run show and amend that revision`,
          );
        const amended = amendDefinition(facts, observedOf(observeInvocations(facts)), proposed);
        if (!amended.ok) throw new RunAmendmentRefusedError(amended.issues);
        const next: RunFacts = { ...facts, title: amended.title, definition: amended.definition };
        project(record, startEligible(record, next));
        return amended.definition.revision;
      });
      deps.log.info("runs.amended", { runId, revision });
      await host.reconcile(runId);
    },

    async restoreAfterRestart() {
      const listed = deps.runs.listActive();
      const active = listed.filter((run) => !run.facts.control.cancelled);
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
              detail: { kind: "restored_paused" },
            });
          });
          announce(run.runId);
        } catch (error) {
          deps.log.error("runs.restore_failed", {
            runId: run.runId,
            error: getErrorMessage(error),
          });
        }
      }
      // A cancel the last process did not finish stops its children again; each stop is idempotent.
      for (const run of listed.filter((r) => r.facts.control.cancelled)) {
        try {
          await host.cancel(run.runId);
        } catch (error) {
          deps.log.error("runs.cancel_resume_failed", {
            runId: run.runId,
            error: getErrorMessage(error),
          });
        }
      }
      for (const run of listed) await followOwner(run);
    },
  };
  return host;
}
