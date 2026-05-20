/**
 * Pure derive functions for session-level properties computed from conversations.
 * This module has NO Node.js dependencies and is safe to import from client components.
 */
import type {
  SessionState,
  DerivedSessionStatus,
  ConversationState,
  ConversationStatus,
} from "@/types";

type CollabEnvelopeContribution = "running" | "paused" | null;

// Inspect opaque workflowEnvelopes for an active collaboration so a session
// with no live conversations but a running/paused inline /collab still surfaces
// in active-status views (sidebar, project cards). Validation lives at the
// WorkflowEnvelopeStore boundary; we only do narrow shape checks here.
export function getCollaborationEnvelopeContribution(parts: {
  workflowEnvelopes: Record<string, unknown> | null | undefined;
}): CollabEnvelopeContribution {
  const envelopes = parts.workflowEnvelopes;
  if (!envelopes) return null;

  let sawRunning = false;
  let sawPaused = false;
  for (const raw of Object.values(envelopes)) {
    if (!raw || typeof raw !== "object") continue;
    const env = raw as { workflowType?: unknown; status?: unknown };
    if (env.workflowType !== "collaboration") continue;
    if (env.status === "running") sawRunning = true;
    else if (env.status === "paused") sawPaused = true;
  }

  if (sawPaused) return "paused";
  if (sawRunning) return "running";
  return null;
}

/**
 * Derive session status from minimal primitive parts. Decision order:
 * - Finished sessions → `idle` (merged, no longer active)
 * - `waiting_for_input` if any conversation is waiting for user input OR an
 *   inline collaboration envelope is paused (typically awaiting Alex's input)
 * - `running` if any conversation is running OR an inline collaboration
 *   envelope is running
 * - `awaiting` if any conversation is awaiting
 * - `new` if any conversation is new (and none running/awaiting)
 * - `idle` otherwise (no conversations)
 */
export function deriveSessionStatusFromParts(parts: {
  finished: boolean;
  convStatuses: ConversationStatus[];
  collabContribution: CollabEnvelopeContribution;
}): DerivedSessionStatus {
  const { finished, convStatuses, collabContribution } = parts;

  if (finished) return "idle";

  if (
    collabContribution === "paused" ||
    convStatuses.some((s) => s === "waiting_for_input")
  ) {
    return "waiting_for_input";
  }
  if (
    collabContribution === "running" ||
    convStatuses.some((s) => s === "running")
  ) {
    return "running";
  }

  if (convStatuses.length === 0) {
    return "idle";
  }

  if (convStatuses.some((s) => s === "awaiting")) {
    return "awaiting";
  }
  if (convStatuses.some((s) => s === "new")) {
    return "new";
  }
  return "idle";
}

/** Derive session prompt count from slim conv rows: sum of all conversation prompt counts. */
export function deriveSessionPromptCountFromConvs(
  convs: Array<{ promptCount: number }>,
): number {
  let sum = 0;
  for (const c of convs) sum += c.promptCount;
  return sum;
}

/**
 * Derive session last activity from slim conv rows: most recent lastActivityAt
 * among conversations, falling back to the session's own lastActivityAt.
 * ISO timestamps compare lexicographically.
 */
export function deriveSessionLastActivityFromConvs(
  sessionLastActivityAt: string,
  convs: Array<{ lastActivityAt: string }>,
): string {
  let latest = sessionLastActivityAt;
  for (const c of convs) {
    if (c.lastActivityAt > latest) {
      latest = c.lastActivityAt;
    }
  }
  return latest;
}

/**
 * Derive session status from workflow state and conversations:
 * - Finished sessions → `idle` (merged, no longer active)
 * - Workflow running → `running` (stable, no flicker between iterations)
 * - `waiting_for_input` if any conversation is waiting for user input OR an
 *   inline collaboration envelope is paused (typically awaiting Alex's input)
 * - `running` if any conversation is running OR an inline collaboration
 *   envelope is running
 * - `awaiting` if any conversation is awaiting
 * - `new` if any conversation is new (and none running/awaiting)
 * - `idle` otherwise (no conversations)
 */
export function deriveSessionStatus(
  session: SessionState,
): DerivedSessionStatus {
  return deriveSessionStatusFromParts({
    finished: session.finished,
    convStatuses: session.conversations.map((c) => c.status),
    collabContribution: getCollaborationEnvelopeContribution({
      workflowEnvelopes: session.workflowEnvelopes,
    }),
  });
}

/** Derive session prompt count: sum of all conversation prompt counts */
export function deriveSessionPromptCount(session: SessionState): number {
  return deriveSessionPromptCountFromConvs(session.conversations);
}

/**
 * Return conversations other than `currentConversationId` that are currently
 * executing a prompt. Used by the prompt-submit flow to warn the user before
 * launching a concurrent agent in the same session.
 *
 * "Busy" here means status === "running"; awaiting / waiting_for_input are
 * paused states where no agent is actively editing files.
 */
export function findBusyOtherConversations(
  conversations: ConversationState[] | undefined,
  currentConversationId: string,
): ConversationState[] {
  if (!conversations) return [];
  return conversations.filter(
    (c) => c.id !== currentConversationId && c.status === "running",
  );
}

/**
 * Derive session last activity: most recent lastActivityAt among conversations,
 * falling back to the session's own lastActivityAt.
 */
export function deriveSessionLastActivity(session: SessionState): string {
  return deriveSessionLastActivityFromConvs(
    session.lastActivityAt,
    session.conversations,
  );
}
