import { composeBoundaryNotice } from "@/lib/runs/notices";
import type { RunBoundary } from "@/lib/runs/schemas";
import type {
  SourceCursor,
  SourceFact,
  SourceReadResult,
  SubscriptionRecipient,
} from "./schemas";

export interface RunSourceDeps {
  run(
    runId: string,
  ): { runId: string; projectPath: string; title: string } | null;
  boundaries(runId: string): RunBoundary[];
  question(
    questionId: string,
  ): { questionText: string; state: "open" | "answered" | "withdrawn" } | null;
}

/** One owner-facing boundary as a source fact; its text is the notice the owner acts on. */
function boundaryFact(
  run: { runId: string; title: string },
  boundary: RunBoundary,
  questionText: string | undefined,
): SourceFact {
  return {
    occurrenceId: boundary.occurrence,
    eventKind: `run-boundary:${boundary.kind}`,
    category:
      boundary.kind === "succeeded" || boundary.kind === "cancelled"
        ? "outcome"
        : "decision",
    sourceTitle: run.title,
    summary: boundary.summary,
    sourceText: composeBoundaryNotice(
      run,
      boundary,
      questionText === undefined ? {} : { questionText },
    ),
    occurredAt: boundary.recordedAt,
    revision: null,
    outcome: boundary.kind,
    retrievalHandle: `cctl run show ${run.runId}`,
    actorConversationId: null,
  };
}

/**
 * Run boundaries after the cursor (a boundary sequence number). A question
 * that is no longer open needs nobody: its boundary yields no fact, and a
 * delivery of it not yet sent is withdrawn.
 */
export function createRunSourceReader(deps: RunSourceDeps) {
  return async (
    recipient: SubscriptionRecipient,
    source: { id: string },
    cursor: SourceCursor,
  ): Promise<SourceReadResult> => {
    const run = deps.run(source.id);
    if (run === null || run.projectPath !== recipient.projectPath)
      return { cursor, facts: [], missing: true };
    const boundaries = deps.boundaries(run.runId);
    const latest = String(boundaries.at(-1)?.seq ?? 0);
    if (cursor === null) return { cursor: latest, facts: [], missing: false };
    const after = Number(cursor);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Invalid run boundary cursor");

    const withdrawnOccurrenceIds: string[] = [];
    const facts: SourceFact[] = [];
    for (const boundary of boundaries) {
      const question =
        boundary.detail.kind === "question"
          ? deps.question(boundary.detail.questionId)
          : null;
      if (question !== null && question.state !== "open") {
        withdrawnOccurrenceIds.push(boundary.occurrence);
        continue;
      }
      if (boundary.seq > after)
        facts.push(boundaryFact(run, boundary, question?.questionText));
    }
    return {
      cursor: latest,
      facts,
      missing: false,
      ...(withdrawnOccurrenceIds.length > 0 ? { withdrawnOccurrenceIds } : {}),
    };
  };
}
