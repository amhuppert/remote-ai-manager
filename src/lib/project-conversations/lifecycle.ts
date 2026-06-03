/**
 * Pure open/closed/archived lifecycle derivation for project conversations.
 * No I/O — directly unit-testable.
 *
 * - **open**: has a tab in the conversation pane (`open && !archived`).
 * - **closed**: no tab but not archived (`!open && !archived`) — still listed
 *   in the global active-conversations source and reopenable.
 * - **archived**: excluded from the active source by default.
 */
export type ProjectConversationLifecycle = "open" | "closed" | "archived";

export function deriveLifecycle(c: {
  open: boolean;
  archived: boolean;
}): ProjectConversationLifecycle {
  if (c.archived) return "archived";
  if (c.open) return "open";
  return "closed";
}

/** A project conversation is listed in the active source unless archived. */
export function isListedInActiveSource(c: { archived: boolean }): boolean {
  return !c.archived;
}

/** Count of conversations that are currently open (`open && !archived`). */
export function countOpen(
  convs: ReadonlyArray<{ open: boolean; archived: boolean }>,
): number {
  let n = 0;
  for (const c of convs) {
    if (c.open && !c.archived) n += 1;
  }
  return n;
}
