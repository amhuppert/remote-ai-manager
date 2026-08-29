import type { NotepadSort } from "./schemas";

/**
 * Query keys for notepad reads. Summaries and details are keyed by the
 * immutable notepad id — the only key a reference resolves by — so a rename
 * invalidates in place rather than stranding a cache entry under an old name.
 */
export const notepadKeys = {
  all: ["notepads"] as const,
  summaries: () => [...notepadKeys.all, "summary"] as const,
  summary: (notepadId: string) =>
    [...notepadKeys.summaries(), notepadId] as const,
  details: () => [...notepadKeys.all, "detail"] as const,
  /** The full notepad including content — the open panel's read. */
  detail: (notepadId: string) => [...notepadKeys.details(), notepadId] as const,
  /** Bounded revision history for one notepad. */
  revisions: (notepadId: string) =>
    [...notepadKeys.detail(notepadId), "revisions"] as const,
  /**
   * A notepad's review comments with their passages. Nested under the detail
   * key on purpose: every passage is resolved against the current content, so
   * a head advance invalidates the comments along with the content they quote.
   */
  comments: (notepadId: string) =>
    [...notepadKeys.detail(notepadId), "comments"] as const,
  lists: () => [...notepadKeys.all, "list"] as const,
  /** The picker's reachable set: global notepads merged with one project's. */
  pickerList: (projectName: string) =>
    [...notepadKeys.lists(), "picker", projectName] as const,
  /** The right-pane browse list; params that vary the response are in the key. */
  panelList: (
    projectName: string,
    sort: NotepadSort,
    includeArchived: boolean,
  ) =>
    [
      ...notepadKeys.lists(),
      "panel",
      projectName,
      { sort, includeArchived },
    ] as const,
} as const;

/**
 * True when a list-family key (picker or panel) belongs to the named project.
 * Both shapes place the project name at index 3 — colocated with the factory
 * above so a key-shape change updates this check in the same file.
 */
export function isNotepadProjectListKey(
  queryKey: readonly unknown[],
  projectName: string,
): boolean {
  return queryKey[3] === projectName;
}
