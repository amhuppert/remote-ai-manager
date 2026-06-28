import type { DocumentFeedbackItem } from "./schemas";

/**
 * Serialize feedback items into the agent-facing prompt text. Pure. Used to
 * derive the user-turn prompt when feedback is sent without explicit text. Each
 * item embeds its source path, section heading, line, exact quote, and the
 * user's note so the agent can locate and act on the passage.
 */
export function formatDocumentFeedbackPrompt(
  items: DocumentFeedbackItem[],
): string {
  const body = items
    .map(
      (item) =>
        `${item.path} — § ${item.headingLabel} · L${item.line}\n` +
        `  "${item.quote}"\n` +
        `  → ${item.note}`,
    )
    .join("\n\n");
  return `Document feedback:\n\n${body}`;
}
