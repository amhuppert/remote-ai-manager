import type { DocumentRef } from "@/lib/document-comments/schemas";

/**
 * Browser-side scroll memory for document viewer panes. Within one session the
 * panes stay mounted across conversation switches, so the DOM keeps the scroll
 * position; this map covers the cases where a pane REMOUNTS with prior context
 * — returning to a session after visiting another, or re-opening a closed tab.
 * Keyed per project/session/docPath and never persisted across reloads,
 * matching the panel-session memory's lifetime.
 */
const memory = new Map<string, number>();

function keyFor(ref: DocumentRef): string {
  return `${ref.projectName}\u0000${ref.sessionName}\u0000${ref.docPath}`;
}

export function saveDocScroll(ref: DocumentRef, scrollTop: number): void {
  memory.set(keyFor(ref), scrollTop);
}

export function readDocScroll(ref: DocumentRef): number | undefined {
  return memory.get(keyFor(ref));
}

export function clearDocScrollMemory(): void {
  memory.clear();
}
