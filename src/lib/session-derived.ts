/**
 * Pure derive functions for session-level properties computed from conversations.
 * This module has NO Node.js dependencies and is safe to import from client components.
 */
import type {
  SessionState,
  DerivedSessionStatus,
  ConversationState,
} from "@/types";

type CollabEnvelopeContribution = "running" | "paused" | null;

// Inspect opaque workflowEnvelopes for an active collaboration so a session
// with no live conversations but a running/paused inline /collab still surfaces
// in active-status views (sidebar, project cards). Validation lives at the
// WorkflowEnvelopeStore boundary; we only do narrow shape checks here.
function getCollaborationEnvelopeContribution(
  session: SessionState,
): CollabEnvelopeContribution {
  const envelopes = session.workflowEnvelopes;
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
  // Finished sessions are done — conversation statuses are irrelevant
  if (session.finished) return "idle";

  const collabContribution = getCollaborationEnvelopeContribution(session);

  if (
    collabContribution === "paused" ||
    session.conversations.some((c) => c.status === "waiting_for_input")
  ) {
    return "waiting_for_input";
  }
  if (
    collabContribution === "running" ||
    session.conversations.some((c) => c.status === "running")
  ) {
    return "running";
  }

  if (session.conversations.length === 0) {
    return "idle";
  }

  if (session.conversations.some((c) => c.status === "awaiting")) {
    return "awaiting";
  }
  if (session.conversations.some((c) => c.status === "new")) {
    return "new";
  }
  return "idle";
}

/** Derive session prompt count: sum of all conversation prompt counts */
export function deriveSessionPromptCount(session: SessionState): number {
  return session.conversations.reduce((sum, c) => sum + c.promptCount, 0);
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
  if (session.conversations.length === 0) {
    return session.lastActivityAt;
  }

  let latest = session.lastActivityAt;
  for (const c of session.conversations) {
    if (c.lastActivityAt > latest) {
      latest = c.lastActivityAt;
    }
  }
  return latest;
}
