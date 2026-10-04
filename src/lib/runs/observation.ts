import type { RunView } from "./schemas";
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
    return {
      key: defined.key,
      contextId: passContextId(defined.request.contextId, pass),
      dependsOn: defined.dependsOn,
      waitingOn: state.kind === "waiting" ? state.on : [],
      started: state.kind === "started",
      skipped: state.kind === "skipped",
      loop: loopOf.get(defined.key) ?? null,
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
