import type { ConversationStatus } from "@/lib/conversations/schemas";

/**
 * Presentation mapping for a project conversation's turn status, kept consistent
 * with how session conversations present status: cyan for running, amber for
 * awaiting / waiting-for-input. Pure and dependency-free so it can be unit-tested
 * and reused across the tab, pane header, and transcript.
 */
export interface StatusPresentation {
  /** `.status-dot` color modifier, or null when no live indicator. */
  dotClass: "cyan" | "amber" | null;
  /** Human label, or null for the resting "new" status. */
  label: string | null;
  /** `.cc-badge--status` value, or null when no badge should render. */
  badgeStatus: "running" | "awaiting" | null;
}

export function presentConversationStatus(
  status: ConversationStatus,
): StatusPresentation {
  switch (status) {
    case "running":
      return { dotClass: "cyan", label: "Running", badgeStatus: "running" };
    case "awaiting":
      return { dotClass: "amber", label: "Awaiting", badgeStatus: "awaiting" };
    case "waiting_for_input":
      return {
        dotClass: "amber",
        label: "Waiting for input",
        badgeStatus: "awaiting",
      };
    case "new":
    default:
      return { dotClass: null, label: null, badgeStatus: null };
  }
}

/** True when the conversation is mid-turn or needs the user — not resting. */
export function isLiveStatus(status: ConversationStatus): boolean {
  return (
    status === "running" ||
    status === "awaiting" ||
    status === "waiting_for_input"
  );
}
