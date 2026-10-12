/** A conversation of a session whose background work a merge must not pass (design C5b §5). */
export interface SessionBackgroundWork {
  conversationId: string;
  /** Its display name, when it has one. */
  conversationName: string | null;
  /**
   * Why its runtime is still unconfirmed, when custody ended but its
   * processes could not be confirmed collected; null while custody holds it.
   */
  unconfirmed: string | null;
}

export interface BackgroundWorkRefusal {
  code: "BACKGROUND_WORK_RUNNING";
  /** The first conversation whose background work blocks the act. */
  conversationId: string;
  message: string;
}

/** The session acts background work blocks. */
export type BackgroundWorkGuardedAct =
  | "merging this session"
  | "marking this session merged";

/**
 * Background work a conversation kept running between turns may still write
 * in the session's worktree, so the session is not merged under it. A turn
 * that only runs is not refused here, so the merge's own resolver and repair
 * turns never are.
 */
export function backgroundWorkRefusal(
  work: readonly SessionBackgroundWork[],
  act: BackgroundWorkGuardedAct,
): BackgroundWorkRefusal | null {
  const first = work[0];
  if (first === undefined) return null;
  const named =
    first.conversationName !== null
      ? `"${first.conversationName}"`
      : first.conversationId;
  const others =
    work.length > 1
      ? ` (and ${work.length - 1} other conversation${work.length > 2 ? "s" : ""})`
      : "";
  return {
    code: "BACKGROUND_WORK_RUNNING",
    conversationId: first.conversationId,
    message:
      first.unconfirmed === null
        ? `Background work is running in conversation ${named}${others}. Stop it from the conversation, or wait for it to finish, before ${act}.`
        : `Background work in conversation ${named}${others} could not be confirmed stopped (${first.unconfirmed}). Restart the server to collect its processes before ${act}.`,
  };
}
