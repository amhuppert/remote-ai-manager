import type { RunView } from "./schemas";
import type { Supervision } from "@/lib/supervision/supervision";

export function describeRun(
  supervision: Supervision,
  runId: string,
): RunView | null {
  const observed = supervision.runs.observe(runId);
  if (observed === null) return null;
  const { record } = observed;
  const started = new Set(record.facts.invocations.map((i) => i.key));
  const summaries = new Map(
    record.facts.definition.contexts.map((defined) => [
      defined.key,
      started.has(defined.key)
        ? supervision.contexts.describe(defined.request.contextId)
        : null,
    ]),
  );
  const contexts = record.facts.definition.contexts.map((defined) => {
    const context = summaries.get(defined.key) ?? null;
    return {
      key: defined.key,
      contextId: defined.request.contextId,
      dependsOn: defined.dependsOn,
      waitingOn: defined.dependsOn.filter(
        (key) => summaries.get(key)?.progress.kind !== "succeeded",
      ),
      started: started.has(defined.key),
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
    contexts,
    boundaries: observed.boundaries.map((boundary) => ({
      seq: boundary.seq,
      kind: boundary.kind,
      summary: boundary.summary,
      recordedAt: boundary.recordedAt,
      notified: boundary.notifiedAt !== null,
    })),
    stalled: [
      ...observed.stalled,
      ...[...summaries.values()].flatMap((context) => context?.stalled ?? []),
    ],
  };
}
