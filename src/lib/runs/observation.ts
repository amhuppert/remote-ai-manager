import type { RunView } from "./schemas";
import type { RunSupervision } from "./supervision";

export function describeRun(
  supervision: RunSupervision,
  runId: string,
): RunView | null {
  const observed = supervision.runs.observe(runId);
  if (observed === null) return null;
  const { record } = observed;
  const contexts = record.facts.invocations.map((invocation) => {
    const context = supervision.contexts.observe(invocation.contextId);
    const facts = context?.record.facts;
    const progress = context?.record.progress ?? null;
    const accepted =
      progress?.kind === "succeeded"
        ? facts?.candidates.items.find(
            (candidate) => candidate.id === progress.candidateId,
          )
        : undefined;
    return {
      key: invocation.key,
      contextId: invocation.contextId,
      progress,
      occurrence: context?.record.progressOccurrence ?? null,
      tasks: (facts?.ledger.tasks ?? []).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
      })),
      seats: facts?.seats.conversations ?? {},
      openQuestions: (facts?.requests.open ?? []).map((open) => ({
        questionId: open.questionId,
        seat: open.seat,
        text:
          supervision.requests.question(open.questionId)?.questionText ?? null,
      })),
      lastSummary: facts?.ledger.lastSummary ?? null,
      output: accepted?.output ?? null,
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
      ...contexts.flatMap(
        (c) => supervision.contexts.observe(c.contextId)?.stalled ?? [],
      ),
    ],
  };
}
