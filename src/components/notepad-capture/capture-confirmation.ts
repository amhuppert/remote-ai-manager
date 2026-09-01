/**
 * What a landed capture tells the user, and what undoing it puts back.
 *
 * Both are pure: a capture surface must be able to state where content went and
 * offer to take it back without re-reading anything.
 */

/** How much of the transcription the confirmation quotes back. */
const PREVIEW_LIMIT = 60;

/**
 * The first line of what landed, bounded. A confirmation that only named the
 * notepad would leave the user unable to tell a captured thought from a
 * misheard one without opening it.
 */
export function captureConfirmationPreview(text: string): string {
  const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length <= PREVIEW_LIMIT
    ? firstLine
    : `${firstLine.slice(0, PREVIEW_LIMIT).trimEnd()}…`;
}

/**
 * The content a notepad held before `payload` was appended to it, or null when
 * the payload is no longer the tail — someone else has written since, and
 * trimming a suffix that is not there would destroy their text. Undo declines
 * rather than guesses; the write's revision check would refuse it anyway, but
 * refusing here means never proposing the wrong content in the first place.
 *
 * Mirrors composeAppendedNotepadContent, which owns the separator rule.
 */
export function contentWithoutAppended(
  content: string,
  payload: string,
): string | null {
  if (content === payload) return "";
  const withSeparator = `\n\n${payload}`;
  return content.endsWith(withSeparator)
    ? content.slice(0, -withSeparator.length)
    : null;
}

/** How much of a destination's existing text rides along as transcription context. */
const CONTEXT_TAIL_LIMIT = 4000;

/**
 * The tail of the destination's content, as transcription context: the words
 * nearest what the user is about to say are the ones that help the transcriber
 * spell names and jargon the same way twice. Empty for an empty destination —
 * the transcribe proxy then omits the field entirely.
 */
export function transcriptionContextFrom(content: string): string {
  const trimmed = content.trim();
  return trimmed.length <= CONTEXT_TAIL_LIMIT
    ? trimmed
    : trimmed.slice(-CONTEXT_TAIL_LIMIT);
}
