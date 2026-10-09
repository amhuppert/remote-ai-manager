import {
  composeBoundaryNotice,
  contextBoundaryOccurrence,
} from "@/lib/runs/notices";
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
  /** The Context's current progress occurrence; null when there is no such Context. */
  contextOccurrence(contextId: string): string | null;
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
 * Whether a boundary asks for something already settled, by the owner or by a
 * person in Command Center: a question no longer open, or an approval or
 * Context halt that is no longer its Context's current progress occurrence.
 * Run-level halts, faults and restored pauses are delivered regardless.
 */
function settled(
  deps: RunSourceDeps,
  boundary: RunBoundary,
  question: { state: string } | null,
): boolean {
  const { detail } = boundary;
  if (detail.kind === "question")
    return question !== null && question.state !== "open";
  if (detail.kind !== "approval" && detail.kind !== "context_halt")
    return false;
  const current = deps.contextOccurrence(detail.contextId);
  return (
    current !== null &&
    boundary.occurrence !== contextBoundaryOccurrence(detail.contextId, current)
  );
}

/**
 * Run boundaries after the cursor (a boundary sequence number). A boundary
 * already settled needs nobody: it yields no fact, and a delivery of it not
 * yet sent is withdrawn.
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
      if (settled(deps, boundary, question)) {
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
