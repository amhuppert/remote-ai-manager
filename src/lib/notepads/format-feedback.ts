import type { NotepadFeedbackPayload } from "@/lib/conversations/message-content-schemas";

/**
 * Serialize a notepad comment dispatch into the agent-facing prompt text. Pure,
 * and the ONLY place the prose is derived: the live send and the drained queue
 * both build it from the same payload, so what a queued dispatch delivers is
 * what an immediate one would have.
 */
export function formatNotepadFeedbackPrompt(
  payload: NotepadFeedbackPayload,
): string {
  const body = payload.items
    .map((item) => `${item.location}\n  "${item.quote}"\n  → ${item.body}`)
    .join("\n\n");
  return (
    `Notepad review comments on "${payload.notepadName}":\n\n` +
    `${payload.notepadRefXml}\n\n${body}`
  );
}
