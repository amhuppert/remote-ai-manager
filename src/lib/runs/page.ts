import { plannedContextView } from "@/lib/execution-context/view";
import type {
  ContextState,
  ContextView,
  SeatSummary,
} from "@/lib/execution-context/schemas";
import type { SessionDiff } from "@/lib/git/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationCore } from "@/lib/conversation-core/executor";
import type { ConversationRequests } from "@/lib/conversation-core/requests";
import type { ContextHost } from "@/lib/execution-context/host";
import type { WorkspaceScope } from "@/lib/workspace/schemas";
import { currentDocuments, withCurrentDocuments } from "./documents";
import { contextBoundaryOccurrence } from "./notices";
import { laneView } from "./observation";
import type { RunHost, RunInspection } from "./host";
import { guardOf } from "./schedule";
import { laneSkipped, loopOf } from "./topology";
import {
  laneStateOf,
  type ActiveRun,
  type ContextDetail,
  type ContextInvocation,
  type RouteGuard,
  type RunBoundary,
  type RunCharterRevision,
  type RunDefinitionContext,
  type RunDocumentRevision,
  type RunInvocation,
  type RunPage,
  type RunProgress,
  type RunRecord,
  type RunStatus,
  type RunSummary,
} from "./schemas";

/** What the page needs to know of one of the session's conversations. */
export interface ConversationFacts {
  title: string | null;
  backend: AgentBackendId;
  /** A turn is running now. */
  working: boolean;
  costUsd: number;
  turns: number;
}

export interface RunPageSources {
  supervision: {
    runs: Pick<RunHost, "observe" | "inspect">;
    contexts: Pick<ContextHost, "view" | "candidateEvidence">;
    requests: Pick<ConversationRequests, "question">;
    core: Pick<ConversationCore, "seatBindingsOf">;
  };
  /** The session's conversations by id: the owner and every seat. */
  conversations: ReadonlyMap<string, ConversationFacts>;
  /** The session's branch, where work placed in the session worktree happens. */
  sessionBranch: string;
  /** A frozen document's text. */
  readText(artifactId: string): Promise<string>;
  /** What a candidate changed, from its Workspace evidence, or why that cannot be read now. */
  candidateChanges(input: {
    worktreePath: string;
    scope: WorkspaceScope;
    evidence: string;
  }): Promise<{ ok: true; diff: SessionDiff } | { ok: false; reason: string }>;
}

function statusOf(progress: RunProgress): RunStatus {
  return progress.kind === "needs_owner" ? { kind: "needs_input" } : progress;
}

function ownerOf(
  record: RunRecord,
  conversations: RunPageSources["conversations"],
): RunPage["owner"] {
  const owner = conversations.get(record.ownerConversationId);
  return {
    conversationId: record.ownerConversationId,
    title: owner?.title ?? null,
    backend: owner?.backend ?? null,
  };
}

/** When the run recorded each boundary it holds, by occurrence. */
function boundaryTimes(boundaries: readonly RunBoundary[]) {
  return new Map(boundaries.map((b) => [b.occurrence, b.recordedAt]));
}

function finishedAt(boundaries: readonly RunBoundary[]): string | null {
  return (
    boundaries.find((b) => b.kind === "succeeded" || b.kind === "cancelled")
      ?.recordedAt ?? null
  );
}

/** Every conversation a Context's seats held, and what each cost. */
function agentsOf(
  sources: RunPageSources,
  contextId: string,
  view: ContextView,
): ContextInvocation["agents"] {
  const seats = new Map<string, SeatSummary>(
    [view.implementer, ...view.reviewers].map((seat) => [
      seat.assignment,
      seat,
    ]),
  );
  const finished =
    view.state.kind === "succeeded" || view.state.kind === "cancelled";
  return sources.supervision.core.seatBindingsOf(contextId).map((binding) => {
    const conversation = sources.conversations.get(binding.conversationId);
    const replaced =
      binding.replacement < (view.incarnations[binding.assignmentId] ?? 0);
    return {
      conversationId: binding.conversationId,
      assignment: binding.assignmentId,
      seat: seats.get(binding.assignmentId) ?? null,
      status: replaced
        ? "replaced"
        : finished
          ? "finished"
          : conversation?.working === true
            ? "active"
            : "idle",
      turns: conversation?.turns ?? null,
      costUsd: conversation?.costUsd ?? null,
    };
  });
}

/** What a frozen revision is now: the latest, superseded by a later one, or removed. */
function frozeOf(
  invocation: RunInvocation,
  documents: readonly RunDocumentRevision[],
): ContextInvocation["froze"] {
  if (invocation.froze === undefined) return null;
  const latest = new Map(
    currentDocuments(documents).map((revision) => [revision.path, revision]),
  );
  return {
    charter: invocation.froze.charter,
    documents: invocation.froze.documents.map((frozen) => {
      const current = latest.get(frozen.path);
      return {
        ...frozen,
        later:
          current === undefined
            ? "removed"
            : current.revision === frozen.revision
              ? null
              : "superseded",
      };
    }),
  };
}

interface KeyContext {
  defined: RunDefinitionContext;
  loop: ContextInvocation["loop"];
  placement: ContextInvocation["placement"];
}

/** A key's started invocation, as the page shows it. */
async function startedInvocation(
  sources: RunPageSources,
  key: KeyContext,
  invocation: RunInvocation,
  record: RunRecord,
  times: ReadonlyMap<string, string>,
  inspection: RunInspection,
): Promise<ContextInvocation | null> {
  const { supervision } = sources;
  const { contextId } = invocation;
  const summary = inspection.contexts.get(contextId) ?? null;
  const view = supervision.contexts.view(contextId, {
    question(questionId) {
      const question = supervision.requests.question(questionId);
      return question === null
        ? null
        : { text: question.questionText, askedAt: question.createdAt };
    },
    since:
      summary === null
        ? null
        : (times.get(
            contextBoundaryOccurrence(contextId, summary.occurrence),
          ) ?? null),
    held: record.facts.control.paused && !record.facts.control.cancelled,
  });
  if (view === null) return null;
  const agents = agentsOf(sources, contextId, view);
  let candidate: ContextInvocation["candidate"] = null;
  if (view.approval !== null) {
    const evidence = supervision.contexts.candidateEvidence(
      contextId,
      view.approval.candidateId,
    );
    const { scope, worktreePath } = view.configuration;
    const changes =
      evidence === null
        ? ({
            ok: false,
            reason: "The candidate is no longer recorded",
          } as const)
        : await sources.candidateChanges({ worktreePath, scope, evidence });
    candidate = changes.ok
      ? {
          status: "ready",
          scope: scope.mode === "owned" ? "owned" : "whole_tree",
          ownedPaths: scope.mode === "owned" ? scope.paths : [],
          diff: changes.diff,
        }
      : { status: "unavailable", reason: changes.reason };
  }
  const {
    contextId: _contextId,
    incarnations: _incarnations,
    startedAt,
    ...shown
  } = view;
  return {
    ...shown,
    key: key.defined.key,
    placement: key.placement,
    loop: key.loop === null ? null : { ...key.loop, pass: invocation.pass + 1 },
    dependsOn: key.defined.dependsOn,
    costUsd: agents.reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0),
    costComplete: agents.every((agent) => agent.costUsd !== null),
    startedAt,
    invocationId: contextId,
    agents,
    froze: frozeOf(invocation, record.facts.documents),
    candidate,
    configuration: {
      ...view.configuration,
      branch: view.configuration.branch ?? sources.sessionBranch,
    },
  };
}

/** A key that has not started: what it waits on, or that its route was not taken. */
function plannedInvocation(
  sources: RunPageSources,
  key: KeyContext,
  state: ContextState,
  pass: number,
): ContextInvocation {
  const planned = plannedContextView(key.defined.request);
  return {
    key: key.defined.key,
    title: planned.title,
    placement: key.placement,
    loop: key.loop === null ? null : { ...key.loop, pass: pass + 1 },
    dependsOn: key.defined.dependsOn,
    state,
    tasks: planned.tasks,
    costUsd: null,
    costComplete: true,
    implementer: planned.implementer,
    reviewers: planned.reviewers,
    humanApproval: planned.humanApproval,
    startedAt: null,
    questions: [],
    invocationId: null,
    brief: planned.brief,
    taskList: planned.taskList,
    criteria: planned.criteria,
    stages:
      state.kind === "skipped"
        ? planned.stages.map((stage) => ({
            ...stage,
            state: "skipped" as const,
          }))
        : planned.stages,
    reviews: [],
    output: null,
    inputs: planned.inputs,
    agents: [],
    froze: null,
    approval: null,
    decisions: [],
    candidate: null,
    lastSummary: null,
    configuration: {
      ...planned.configuration,
      branch: planned.configuration.branch ?? sources.sessionBranch,
    },
  };
}

async function contextsOf(
  sources: RunPageSources,
  record: RunRecord,
  inspection: RunInspection,
  times: ReadonlyMap<string, string>,
): Promise<ContextDetail[]> {
  const { facts } = record;
  const loops = facts.definition.loops ?? [];
  const details: ContextDetail[] = [];
  for (const defined of facts.definition.contexts) {
    const loop = loopOf(loops, defined.key);
    const key: KeyContext = {
      defined,
      loop:
        loop === undefined
          ? null
          : { key: loop.key, pass: 1, maxPasses: loop.maxPasses },
      placement:
        defined.lane === undefined
          ? { kind: "session" }
          : { kind: "lane", lane: defined.lane },
    };
    const passes = facts.invocations
      .filter((invocation) => invocation.key === defined.key)
      .sort((a, b) => a.pass - b.pass);
    const started: ContextInvocation[] = [];
    for (const invocation of passes) {
      const shown = await startedInvocation(
        sources,
        key,
        invocation,
        record,
        times,
        inspection,
      );
      if (shown !== null) started.push(shown);
    }
    const state = inspection.plan.keys.get(defined.key);
    let current: ContextInvocation | undefined;
    if (state?.kind === "started") {
      current = started.find(
        (invocation) => invocation.invocationId === state.contextId,
      );
    } else if (state?.kind === "skipped") {
      current = plannedInvocation(
        sources,
        key,
        { kind: "skipped", reason: "Its route was not taken" },
        0,
      );
    } else {
      current = plannedInvocation(
        sources,
        key,
        {
          kind: "waiting",
          dependencies: state?.on ?? defined.dependsOn,
          provisionLanes:
            state?.lane !== undefined && state.publications === undefined
              ? [state.lane]
              : [],
          publicationLanes: state?.publications ?? [],
        },
        state?.pass ?? 0,
      );
    }
    // The next pass of a loop is planned while its earlier passes keep their evidence.
    const shown =
      current ??
      started.at(-1) ??
      plannedInvocation(
        sources,
        key,
        {
          kind: "waiting",
          dependencies: defined.dependsOn,
          provisionLanes: [],
          publicationLanes: [],
        },
        0,
      );
    details.push({
      ...shown,
      previousInvocations: started.filter(
        (invocation) => invocation.invocationId !== shown.invocationId,
      ),
    });
  }
  return details;
}

/** A guard as the diagram labels it: its schema's own title or description, else the schema itself. */
function guardLabel(guard: RouteGuard): string {
  if ("else" in guard) return "else";
  return schemaLabel(guard.schema);
}

function schemaLabel(schema: Record<string, unknown>): string {
  for (const field of ["title", "description"]) {
    const value = schema[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const text = JSON.stringify(schema);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function edgesOf(
  record: RunRecord,
  inspection: RunInspection,
): RunPage["edges"] {
  return record.facts.definition.contexts.flatMap((defined) =>
    defined.dependsOn.map((source) => {
      const guard = guardOf(defined, source);
      const resolution = inspection.plan.routes.get(
        `${source}->${defined.key}`,
      )?.resolution;
      return {
        from: source,
        to: defined.key,
        guard:
          guard === undefined
            ? null
            : {
                label: guardLabel(guard),
                state:
                  resolution === "active"
                    ? ("taken" as const)
                    : resolution === "inactive" || resolution === "omitted"
                      ? ("not_taken" as const)
                      : ("undecided" as const),
              },
        outputOnly: defined.outputOnly?.includes(source) ?? false,
      };
    }),
  );
}

function lanesOf(
  record: RunRecord,
  inspection: RunInspection,
): RunPage["lanes"] {
  const { facts } = record;
  return (facts.definition.lanes ?? []).map((lane) => {
    const skipped = laneSkipped(
      facts.definition.contexts,
      lane.key,
      (key) => inspection.plan.keys.get(key)?.kind === "skipped",
    );
    return {
      key: lane.key,
      branch: lane.branch,
      worktreePath: lane.worktreePath,
      checks: lane.checks,
      ...laneView(laneStateOf(facts, lane.key), skipped),
    };
  });
}

function loopsOf(
  record: RunRecord,
  inspection: RunInspection,
): RunPage["loops"] {
  return (record.facts.definition.loops ?? []).map((loop) => {
    const state = inspection.plan.loops.get(loop.key) ?? {
      kind: "unstarted" as const,
    };
    const skipped =
      state.kind === "unstarted" &&
      inspection.plan.keys.get(loop.entry)?.kind === "skipped";
    return {
      key: loop.key,
      body: loop.body,
      pass: state.kind === "unstarted" ? 0 : state.pass + 1,
      maxPasses: loop.maxPasses,
      state: skipped ? ("skipped" as const) : state.kind,
      until: schemaLabel(loop.until.schema),
    };
  });
}

async function documentOf(
  sources: RunPageSources,
  revision: RunDocumentRevision,
): Promise<RunPage["documents"][number] | null> {
  const { document } = revision;
  if (document === null) return null;
  return {
    path: revision.path,
    revision: revision.revision,
    source: revision.source,
    ...(revision.by !== undefined ? { by: revision.by } : {}),
    ...(revision.reason !== undefined ? { reason: revision.reason } : {}),
    description: document.description,
    ...(document.readWhen !== undefined ? { readWhen: document.readWhen } : {}),
    ...(document.appliesTo !== undefined
      ? { appliesTo: document.appliesTo }
      : {}),
    bytes: document.bytes,
    at: revision.at,
    contents: await sources.readText(document.artifactId),
  };
}

async function documentsOf(
  sources: RunPageSources,
  revisions: readonly RunDocumentRevision[],
): Promise<RunPage["documents"]> {
  const shown: RunPage["documents"] = [];
  for (const revision of revisions) {
    const document = await documentOf(sources, revision);
    if (document !== null) shown.push(document);
  }
  return shown;
}

function charterOf(
  revision: RunCharterRevision,
): RunPage["charterHistory"][number] | null {
  const { charter } = revision;
  if (charter === null) return null;
  return {
    revision: revision.revision,
    source: revision.source,
    at: revision.at,
    reason: revision.reason,
    mission: charter.mission,
    conventions: charter.conventions ?? [],
    vocabulary: charter.vocabulary ?? [],
    testStrategy: charter.testStrategy ?? null,
    knownAmbiguities: charter.knownAmbiguities ?? [],
    invariants: charter.invariants ?? [],
    sources: [...(charter.sourcesOfTruth ?? [])]
      .sort((a, b) => a.rank - b.rank)
      .map((source) => ({
        rank: source.rank,
        label: source.label,
        locator: source.locator,
        description: source.description,
        ...(source.appliesTo !== undefined
          ? { appliesTo: source.appliesTo }
          : {}),
      })),
    nonGoals: charter.nonGoals ?? [],
  };
}

/**
 * Whether anything in the run can still be acted on. A cancelled run (still
 * stopping, or stopped) refuses every act but cancel, so what halted it is
 * history, kept in its activity, lanes and loops.
 */
function actionable(record: RunRecord): boolean {
  return (
    !record.facts.control.cancelled && record.progress.kind !== "succeeded"
  );
}

function attentionOf(
  record: RunRecord,
  contexts: readonly ContextDetail[],
  inspection: RunInspection,
  times: ReadonlyMap<string, string>,
): RunPage["attention"] {
  if (!actionable(record)) return [];
  const items: RunPage["attention"] = [];
  for (const context of contexts) {
    const { state } = context;
    if (state.kind === "awaiting_approval") {
      const latest = context.reviews.at(-1);
      items.push({
        kind: "approval",
        contextKey: context.key,
        contextTitle: context.title,
        requestedAt: state.requestedAt,
        reviewersPassed:
          latest?.seats.filter((seat) => seat.status === "pass").length ?? 0,
      });
    }
    if (state.kind === "halted")
      items.push({
        kind: "halt",
        contextKey: context.key,
        contextTitle: context.title,
        halt: state.halt.kind,
        detail: state.halt.detail,
        at: state.halt.at,
      });
    for (const question of context.questions)
      items.push({
        kind: "question",
        questionId: question.questionId,
        contextKey: context.key,
        contextTitle: context.title,
        seat: question.seat,
        question: question.question,
        askedAt: question.askedAt,
      });
  }
  // A completion no one consumed; a resume reconciles it.
  for (const context of contexts) {
    const causes =
      context.invocationId === null
        ? []
        : (inspection.contexts.get(context.invocationId)?.stalled ?? []);
    if (causes.length > 0)
      items.push({
        kind: "stalled",
        contextKey: context.key,
        contextTitle: context.title,
        causes: [...causes],
      });
  }
  if (inspection.stalled.length > 0)
    items.push({ kind: "stalled", causes: [...inspection.stalled] });
  for (const halt of inspection.plan.halts)
    items.push({
      kind: "run_halt",
      occurrence: halt.occurrence,
      halt: halt.kind,
      detail: halt.reason,
      clearedBy: halt.clearedBy,
      ...(halt.lane !== undefined ? { lane: halt.lane } : {}),
      at: times.get(halt.occurrence) ?? record.updatedAt,
    });
  const { fault } = record.facts.control;
  if (fault !== null)
    items.push({
      kind: "run_halt",
      occurrence: `run:fault:${fault.at}`,
      halt: "reconcile_failed",
      detail: fault.detail,
      clearedBy: "resume",
      at: fault.at,
    });
  return items;
}

const WHO = { owner: "the owner", person: "Alex" } as const;
const WHO_FIRST = { owner: "The owner", person: "Alex" } as const;

const words = (name: string) => name.replaceAll("_", " ");

/**
 * A boundary as the person's activity reads it. Boundaries are the owner's
 * notices; the page words them for the person, beside the context they name.
 * An agent run's finish is its one context's, already listed.
 */
function boundaryActivity(
  detail: RunBoundary["detail"],
  kind: RunRecord["facts"]["kind"],
): string | null {
  switch (detail.kind) {
    case "question":
      return "asked the owner a question";
    case "approval":
      return "awaits your approval";
    case "context_halt":
      return `halted (${words(detail.halt)})`;
    case "run_halt":
      return detail.lane === undefined
        ? `Halted: ${words(detail.halt)}`
        : `Lane ${detail.lane} halted: ${words(detail.halt)}`;
    case "stalled":
      return "Only halted routes or loops remain";
    case "fault":
      return `Could not be reconciled: ${detail.error}`;
    case "succeeded":
      return kind === "agent" ? null : "Finished";
    case "cancelled":
      return "Cancelled";
    case "restored_paused":
      return "Paused by a server restart";
  }
}

/**
 * What happened, in order: derived from the run's facts, its Contexts' and
 * its boundaries, never recorded twice.
 */
function activityOf(
  sources: RunPageSources,
  record: RunRecord,
  contexts: readonly ContextDetail[],
  boundaries: readonly RunBoundary[],
): RunPage["activity"] {
  const { facts } = record;
  const keyOf = new Map(
    facts.invocations.map((invocation) => [
      invocation.contextId,
      invocation.key,
    ]),
  );
  type Event = Omit<RunPage["activity"][number], "seq">;
  const events: Event[] = [
    {
      id: "launch",
      at: record.createdAt,
      kind: "launched",
      summary: "Launched",
    },
  ];
  facts.acts.forEach((act, index) => {
    const id = `act:${index}`;
    const who = WHO[act.by];
    if (act.action === "pause")
      events.push({
        id,
        at: act.at,
        kind: "paused",
        summary: `Paused by ${who}`,
      });
    if (act.action === "cancel")
      events.push({
        id,
        at: act.at,
        kind: "cancelled",
        summary: `Cancelled by ${who}`,
      });
    if (act.action === "retry_lane")
      events.push({
        id,
        at: act.at,
        kind: "retried",
        summary: `Lane ${act.lane} retried by ${who}`,
      });
    if (act.action === "resume" && act.dispositions.length === 0)
      events.push({
        id,
        at: act.at,
        kind: "resumed",
        summary: `Resumed by ${who}`,
      });
    for (const disposition of act.action === "resume" ? act.dispositions : []) {
      const key = keyOf.get(disposition.contextId);
      events.push({
        id: `${id}:${disposition.contextId}`,
        at: act.at,
        kind: "resolved",
        summary: `${WHO_FIRST[act.by]} chose ${disposition.disposition.replaceAll("_", " ")}`,
        ...(key !== undefined ? { contextKey: key } : {}),
      });
    }
  });
  for (const amendment of facts.amendments)
    events.push({
      id: `amend:${amendment.revision}`,
      at: amendment.at,
      kind: "amended",
      summary:
        amendment.reason === null
          ? `Amended to revision ${amendment.revision}`
          : `Amended to revision ${amendment.revision}: ${amendment.reason}`,
    });
  for (const context of contexts)
    for (const invocation of [...context.previousInvocations, context]) {
      const { invocationId } = invocation;
      if (invocationId === null || invocation.startedAt === null) continue;
      events.push({
        id: `start:${invocationId}`,
        at: invocation.startedAt,
        kind: "started",
        summary:
          invocation.loop === null
            ? "started"
            : `started pass ${invocation.loop.pass}`,
        contextKey: invocation.key,
      });
      if (invocation.state.kind === "succeeded")
        events.push({
          id: `done:${invocationId}`,
          at: invocation.state.at,
          kind: "succeeded",
          summary: "finished",
          contextKey: invocation.key,
        });
      for (const decision of invocation.decisions)
        events.push({
          id: `decision:${invocationId}:${decision.candidateId}:${decision.decidedAt}`,
          at: decision.decidedAt,
          kind: "decided",
          summary:
            decision.decision === "approved"
              ? "Alex approved the result"
              : "Alex sent the result back",
          contextKey: invocation.key,
        });
    }
  for (const revision of facts.documents)
    if (revision.source === "publish")
      events.push({
        id: `document:${revision.path}:${revision.revision}`,
        at: revision.at,
        kind: "published",
        summary: `${revision.path} revision ${revision.revision} published`,
        ...(revision.by !== undefined
          ? { contextKey: keyOf.get(revision.by) ?? revision.by }
          : {}),
      });
  // A cancel act already says who stopped the run; its boundary only says it finished stopping.
  const cancelActed = facts.acts.some((act) => act.action === "cancel");
  for (const boundary of boundaries) {
    const contextId =
      "contextId" in boundary.detail ? boundary.detail.contextId : undefined;
    const key = contextId === undefined ? undefined : keyOf.get(contextId);
    const summary = boundaryActivity(boundary.detail, facts.kind);
    if (!(boundary.kind === "cancelled" && cancelActed) && summary !== null)
      events.push({
        id: `boundary:${boundary.seq}`,
        at: boundary.recordedAt,
        kind: boundary.kind === "restored_paused" ? "paused" : boundary.kind,
        summary,
        ...(key !== undefined ? { contextKey: key } : {}),
      });
    if (boundary.detail.kind === "question") {
      const question = sources.supervision.requests.question(
        boundary.detail.questionId,
      );
      if (question?.answeredAt != null)
        events.push({
          id: `answer:${boundary.detail.questionId}`,
          at: question.answeredAt,
          kind: "answered",
          summary: "The owner answered",
          ...(key !== undefined ? { contextKey: key } : {}),
        });
    }
  }
  // A stable sort keeps the order above for events of one moment: an act before the boundary it caused.
  return events
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((event, index) => ({ seq: index + 1, ...event }));
}

/** What every invocation's seats cost, and whether each is still known. */
function costOf(contexts: readonly ContextDetail[]): {
  costUsd: number;
  costComplete: boolean;
} {
  const invocations = contexts.flatMap((context) => [
    context,
    ...context.previousInvocations,
  ]);
  return {
    costUsd: invocations.reduce(
      (sum, invocation) => sum + (invocation.costUsd ?? 0),
      0,
    ),
    costComplete: invocations.every((invocation) => invocation.costComplete),
  };
}

/** The run as the page shows it; null when there is no such run. */
export async function runPage(
  sources: RunPageSources,
  runId: string,
): Promise<RunPage | null> {
  const { runs } = sources.supervision;
  const observed = runs.observe(runId);
  const inspection = runs.inspect(runId);
  if (observed === null || inspection === null) return null;
  const { record, boundaries } = observed;
  const times = boundaryTimes(boundaries);
  // Current documents are among the history: read each artifact once.
  const texts = new Map<string, Promise<string>>();
  const read: RunPageSources = {
    ...sources,
    readText(artifactId) {
      const text = texts.get(artifactId) ?? sources.readText(artifactId);
      texts.set(artifactId, text);
      return text;
    },
  };
  const contexts = await contextsOf(sources, record, inspection, times);
  const { facts } = record;
  const charters = facts.charter.flatMap((revision) => {
    const charter = charterOf(revision);
    return charter === null ? [] : [charter];
  });
  const current = facts.charter.at(-1);
  return {
    runId: record.runId,
    title: facts.title,
    kind: facts.kind,
    status: statusOf(record.progress),
    owner: ownerOf(record, sources.conversations),
    origin: record.origin,
    definitionRevision: facts.definition.revision,
    startedAt: record.createdAt,
    finishedAt: finishedAt(boundaries),
    ...costOf(contexts),
    attention: attentionOf(record, contexts, inspection, times),
    contexts,
    edges: edgesOf(record, inspection),
    lanes: lanesOf(record, inspection),
    loops: loopsOf(record, inspection),
    documents: await documentsOf(read, currentDocuments(facts.documents)),
    documentHistory: await documentsOf(read, facts.documents),
    charter:
      current === undefined || current.charter === null
        ? null
        : (charters.at(-1) ?? null),
    charterHistory: charters,
    activity: activityOf(sources, record, contexts, boundaries),
    definition:
      facts.definition.authored === undefined
        ? null
        : withCurrentDocuments(facts.definition.authored, facts.documents),
  };
}

/**
 * How far a run got and what it needs of a person, as its list rows read it:
 * contexts done of those not skipped, and what the page's attention lists
 * (seat questions aside), with the approvals among it and when the newest of
 * it arose (a stalled completion has no time of its own).
 */
function runStanding(
  supervision: RunPageSources["supervision"],
  record: RunRecord,
): Pick<
  ActiveRun,
  "status" | "attention" | "approvals" | "contexts" | "askedAt"
> {
  const inspection = supervision.runs.inspect(record.runId);
  const times = boundaryTimes(
    supervision.runs.observe(record.runId)?.boundaries ?? [],
  );
  const keys = record.facts.definition.contexts;
  const live = actionable(record);
  const asked: string[] = [];
  let done = 0;
  let skipped = 0;
  let approvals = 0;
  let attention = 0;
  if (live) {
    for (const halt of inspection?.plan.halts ?? []) {
      attention += 1;
      const at = times.get(halt.occurrence);
      if (at !== undefined) asked.push(at);
    }
    const { fault } = record.facts.control;
    if (fault !== null) {
      attention += 1;
      asked.push(fault.at);
    }
    // A completion no one consumed is attention too, as the page lists it.
    if ((inspection?.stalled.length ?? 0) > 0) attention += 1;
  }
  for (const defined of keys) {
    const state = inspection?.plan.keys.get(defined.key);
    if (state?.kind === "skipped") {
      skipped += 1;
      continue;
    }
    if (state?.kind !== "started") continue;
    const summary = inspection?.contexts.get(state.contextId);
    if (live && (summary?.stalled.length ?? 0) > 0) attention += 1;
    const progress = summary?.progress;
    if (progress?.kind === "succeeded") done += 1;
    if (!live || summary === undefined || summary === null) continue;
    const approval =
      progress?.kind === "waiting" &&
      progress.obligation.kind === "await_approval";
    if (progress?.kind !== "halted" && !approval) continue;
    attention += 1;
    if (approval) approvals += 1;
    const at = times.get(
      contextBoundaryOccurrence(state.contextId, summary.occurrence),
    );
    if (at !== undefined) asked.push(at);
  }
  return {
    status: statusOf(record.progress),
    attention,
    approvals,
    contexts: { done, total: keys.length - skipped },
    askedAt:
      attention > 0 && asked.length > 0
        ? asked.reduce((newest, at) => (at > newest ? at : newest))
        : null,
  };
}

/** A run as the session's run list shows it. */
export function runSummary(
  sources: Pick<RunPageSources, "supervision" | "conversations">,
  record: RunRecord,
): RunSummary {
  const { supervision } = sources;
  const boundaries = supervision.runs.observe(record.runId)?.boundaries ?? [];
  const { status, attention, contexts } = runStanding(supervision, record);
  const seats = record.facts.invocations.flatMap((invocation) =>
    supervision.core
      .seatBindingsOf(invocation.contextId)
      .map((binding) => sources.conversations.get(binding.conversationId)),
  );
  return {
    runId: record.runId,
    title: record.facts.title,
    kind: record.facts.kind,
    status,
    attention,
    contexts,
    costUsd: seats.reduce((sum, seat) => sum + (seat?.costUsd ?? 0), 0),
    costComplete: seats.every((seat) => seat !== undefined),
    startedAt: record.createdAt,
    finishedAt: finishedAt(boundaries),
    owner: ownerOf(record, sources.conversations),
  };
}

/** A current run as the sidebar and the "Needs you" menu list it, among every session's. */
export function activeRun(
  supervision: RunPageSources["supervision"],
  record: RunRecord,
  projectName: string,
): ActiveRun {
  return {
    runId: record.runId,
    title: record.facts.title,
    kind: record.facts.kind,
    projectName,
    sessionName: record.sessionName,
    ...runStanding(supervision, record),
    startedAt: record.createdAt,
  };
}
