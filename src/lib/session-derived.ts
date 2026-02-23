/**
 * Pure derive functions for session-level properties computed from conversations.
 * This module has NO Node.js dependencies and is safe to import from client components.
 */
import type { SessionState, DerivedSessionStatus } from "@/types";

/**
 * Derive session status from conversations:
 * - `waiting_for_input` if any conversation is waiting for user input
 * - `running` if any conversation is running
 * - `awaiting` if any conversation is awaiting
 * - `idle` otherwise (all new or no conversations)
 */
export function deriveSessionStatus(
  session: SessionState,
): DerivedSessionStatus {
  if (session.conversations.length === 0) {
    return "idle";
  }

  if (session.conversations.some((c) => c.status === "waiting_for_input")) {
    return "waiting_for_input";
  }
  if (session.conversations.some((c) => c.status === "running")) {
    return "running";
  }
  if (session.conversations.some((c) => c.status === "awaiting")) {
    return "awaiting";
  }
  return "idle";
}

/** Derive session prompt count: sum of all conversation prompt counts */
export function deriveSessionPromptCount(session: SessionState): number {
  return session.conversations.reduce((sum, c) => sum + c.promptCount, 0);
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
