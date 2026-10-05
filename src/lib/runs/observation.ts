import { laneStateOf, type RunLaneState, type RunView } from "./schemas";
import { passContextId } from "./schedule";
import type { Supervision } from "@/lib/supervision/supervision";

export function describeRun(
  supervision: Supervision,
  runId: string,
): RunView | null {
  const observed = supervision.runs.observe(runId);
  const inspected = supervision.runs.inspect(runId);
  if (observed === null || inspected === null) return null;
  const { record } = observed;
  const { plan } = inspected;
  const loops = record.facts.definition.loops ?? [];
  const loopOf = new Map(
    loops.flatMap((loop) => loop.body.map((key) => [key, loop.key] as const)),
  );
  const contexts = record.facts.definition.contexts.map((defined) => {
    const state = plan.keys.get(defined.key) ?? {
      kind: "waiting" as const,
      pass: 0,
      on: defined.dependsOn,
    };
    const pass = state.kind === "skipped" ? 0 : state.pass;
    const context =
      state.kind === "started"
        ? supervision.contexts.describe(state.contextId)
        : null;
    const waitingOnLanes =
      state.kind !== "waiting"
        ? []
        : state.publications ?? (state.lane !== undefined ? [state.lane] : []);
    return {
      key: defined.key,
      contextId: passContextId(defined.request.contextId, pass),
      dependsOn: defined.dependsOn,
      waitingOn: state.kind === "waiting" ? state.on : [],
      started: state.kind === "started",
      skipped: state.kind === "skipped",
      loop: loopOf.get(defined.key) ?? null,
      lane: defined.lane ?? null,
      waitingOnLanes,
      pass: pass + 1,
      progress: context?.progress ?? null,
      occurrence: context?.occurrence ?? null,
      tasks: context?.tasks ?? [],
      seats: context?.seats ?? {},
      openQuestions: (context?.openQuestions ?? []).map((open) => ({
        ...open,
        text:
          supervision.requests.question(open.questionId)?.questionText ?? null,
      })),
      lastSummary: context?.lastSummary ?? null,
      output: context?.accepted?.output ?? null,
      stalled: context?.stalled ?? [],
    };
  });
  return {
    runId: record.runId,
    title: record.facts.title,
    kind: record.facts.kind,
    progress: record.progress,
    revision: record.revision,
    ownerConversationId: record.ownerConversationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    contexts: contexts.map(({ stalled: _stalled, ...context }) => context),
    boundaries: observed.boundaries.map((boundary) => ({
      seq: boundary.seq,
      kind: boundary.kind,
      summary: boundary.summary,
      recordedAt: boundary.recordedAt,
      notified: boundary.notifiedAt !== null,
    })),
    stalled: [
      ...inspected.stalled,
      ...contexts.flatMap((context) => context.stalled),
    ],
    halts: plan.halts.map((halt) => halt.reason),
    lanes: (record.facts.definition.lanes ?? []).map((lane) => {
      const members = record.facts.definition.contexts.filter((c) => c.lane === lane.key);
      const skipped = members.every((c) => plan.keys.get(c.key)?.kind === "skipped");
      return {
        key: lane.key,
        worktreePath: lane.worktreePath,
        branch: lane.branch,
        ...laneView(laneStateOf(record.facts, lane.key), skipped),
      };
    }),
    loops: loops.map((loop) => {
      const state = plan.loops.get(loop.key) ?? { kind: "unstarted" as const };
      const skipped =
        state.kind === "unstarted" &&
        plan.keys.get(loop.entry)?.kind === "skipped";
      return {
        key: loop.key,
        pass: state.kind === "unstarted" ? 0 : state.pass + 1,
        maxPasses: loop.maxPasses,
        state: skipped ? ("skipped" as const) : state.kind,
      };
    }),
  };
}

/** Where a lane stands for its owner: its step, the attempt, and why it stopped. */
function laneView(
  state: RunLaneState | undefined,
  skipped: boolean,
): Pick<RunView["lanes"][number], "state" | "attempt" | "detail" | "commit"> {
  const none = { attempt: null, detail: null, commit: null };
  if (state === undefined) return { state: skipped ? "skipped" : "waiting", ...none };
  const { provision, publication } = state;
  if (provision.outcome.kind === "requested")
    return { state: "provisioning", ...none, attempt: provision.attempt };
  if (provision.outcome.kind === "failed")
    return { state: "provision_failed", ...none, attempt: provision.attempt, detail: provision.outcome.detail };
  if (provision.outcome.kind === "cancelled") return { state: "cancelled", ...none, attempt: provision.attempt };
  if (publication === null) return { state: "working", ...none };
  const at = { attempt: publication.attempt, detail: null, commit: null };
  const outcome = publication.outcome;
  switch (outcome.kind) {
    case "requested":
      return { state: "publishing", ...at };
    case "published":
      return { state: "published", ...at, commit: outcome.commit };
    case "stale":
      return { state: "stale", ...at, detail: `The session branch moved to ${outcome.head} after the lane was checked` };
    case "blocked":
    case "failed":
    case "uncertain":
      return { state: outcome.kind, ...at, detail: outcome.detail };
    case "cancelled":
      return { state: "cancelled", ...at };
  }
}
