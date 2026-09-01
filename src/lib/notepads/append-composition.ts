/**
 * The append composition rule, owned once. Two paths land an appended payload —
 * the content route (which composes server-side, inside the write transaction)
 * and the open editor (which composes in the document, so the user's own
 * capture never trips the external-write banner) — and they must serialize
 * byte-identical content, so neither restates the rule.
 *
 * Deliberately dependency-free: the state-store repo and the client editor both
 * import it.
 */

/**
 * Compose an appended payload onto the current canonical text, separated by a
 * blank line — and onto nothing at all when the notepad is empty, so a first
 * append does not open the content with stray whitespace.
 */
export function composeAppendedNotepadContent(
  current: string,
  payload: string,
): string {
  return current.length === 0 ? payload : `${current}\n\n${payload}`;
}

/**
 * The inverse used by clip undo: remove an appended payload — and the one
 * separator the composition added — but only while it is still the content
 * tail. Anything else (the user kept typing, another write landed) returns
 * null: undo must refuse rather than guess at content it no longer owns.
 */
export function trimAppendedNotepadContent(
  current: string,
  payload: string,
): string | null {
  if (current === payload) return "";
  const suffix = `\n\n${payload}`;
  return current.endsWith(suffix)
    ? current.slice(0, current.length - suffix.length)
    : null;
}
