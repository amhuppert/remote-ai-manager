/**
 * The clip-landing target for each open notepad, keyed by notepad id. Capture
 * landing reads this to route a clip into the notepad open in this session's
 * right pane (R22.5) — through the open view's own user-authored write path,
 * so the user's clip never arrives as an external write — instead of the HTTP
 * append path. Registered by NotepadOpenView for as long as the notepad is
 * open with its content loaded, in every view mode: the read, review, and
 * history views have no mounted editor, but a clip landed there must still go
 * through the open view rather than arrive as an external write.
 */
export interface NotepadClipTarget {
  /** Append a capture fragment under the shared composition rule. */
  appendFragment(fragment: string): void;
  /**
   * Undo a landed clip: remove the fragment and its single separator, but
   * only while it is still the content tail — of the persisted head, not
   * merely the local buffer, so an external write the view has seen but not
   * yet adopted refuses rather than being overwritten. Resolves false when
   * the undo is no longer possible; rejects on transport failure.
   */
  undoAppend(fragment: string): Promise<boolean>;
}

const targets = new Map<string, NotepadClipTarget>();

export function setOpenNotepadClipTarget(
  notepadId: string,
  target: NotepadClipTarget | null,
): void {
  if (target === null) {
    targets.delete(notepadId);
  } else {
    targets.set(notepadId, target);
  }
}

export function getOpenNotepadClipTarget(
  notepadId: string,
): NotepadClipTarget | null {
  return targets.get(notepadId) ?? null;
}
