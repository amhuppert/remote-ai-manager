/**
 * The one stateless destination rule every capture surface shares (D21): it
 * lands in the notepad you are looking at, else the one you last edited, else a
 * fresh Inbox. Pure and server-safe — clip and voice quick-capture both decide
 * with it before they write.
 */

import type { NotepadListItem, NotepadScope } from "./schemas";

/** The name a capture-created notepad takes. */
export const CAPTURE_INBOX_NAME = "Inbox";

export interface CaptureDestinationInput {
  /** The notepad open in the session's right pane — the user is looking at it. */
  openNotepad: { id: string } | null;
  /** The caller's notepad listing, in the picker/panel list shape. */
  candidates: readonly NotepadListItem[];
  /**
   * Route-derived ambient project, named as the quick-ticket host names it and
   * as the create seam consumes it. Null outside any project context, which
   * runs the same tiers over global-scope notepads rather than refusing.
   */
  ambientProject: { name: string } | null;
  /**
   * Names already held in the destination scope, archived ones included. The
   * recency tier cannot see archived notepads, but a create collides with them:
   * names are unique per scope.
   */
  takenNames?: readonly string[];
  /**
   * A name this capture was already promised under — the voice pill names its
   * destination before a word is spoken. When set, the promise replaces the
   * recency tier rather than re-running it: the capture lands in whatever
   * notepad holds that name now, and otherwise under exactly that name.
   */
  promisedName?: string;
  /** Today, `YYYY-MM-DD`, for the collision suffix. */
  today: string;
}

export type CaptureDestination =
  | { kind: "existing"; id: string }
  | {
      kind: "create";
      scope: NotepadScope;
      /** Null for the global scope, which has no owning project. */
      projectName: string | null;
      name: string;
    };

/**
 * Resolve where a capture lands, in order: the open right-pane notepad; a name
 * already promised to the user, if one was; the most recently updated
 * unarchived notepad of the destination scope; otherwise a new Inbox in that
 * scope.
 *
 * Recency is `updatedAt` — the only recency the store records, and the
 * ordering the panel's default sort already teaches. Pinning deliberately does
 * not participate, so a pinned-but-stale notepad never silently steals
 * captures; server listings arrive pinned-first, so the tier re-orders rather
 * than trusting the incoming order.
 */
export function resolveCaptureDestination(
  input: CaptureDestinationInput,
): CaptureDestination {
  if (input.openNotepad) {
    return { kind: "existing", id: input.openNotepad.id };
  }

  const inScope = input.candidates.filter(
    (candidate) =>
      !candidate.archived && isInDestinationScope(candidate, input),
  );

  if (input.promisedName !== undefined) {
    // A notepad that took the promised name while the capture was in flight is
    // the promise kept, not a collision: appending to it beats creating a
    // second notepad the user was never shown.
    const holder = inScope.find(
      (candidate) => candidate.name === input.promisedName,
    );
    if (holder) return { kind: "existing", id: holder.id };
    return createDestination(input, input.promisedName);
  }

  const mostRecent = inScope.reduce<NotepadListItem | null>(
    (best, candidate) =>
      best === null || isNewer(candidate, best) ? candidate : best,
    null,
  );
  if (mostRecent) return { kind: "existing", id: mostRecent.id };

  return createDestination(input, CAPTURE_INBOX_NAME);
}

function isInDestinationScope(
  candidate: NotepadListItem,
  input: CaptureDestinationInput,
): boolean {
  return input.ambientProject === null
    ? candidate.scope === "global"
    : candidate.scope === "project" &&
        candidate.projectName === input.ambientProject.name;
}

/** Ties break on id so the same listing always resolves the same way. */
function isNewer(candidate: NotepadListItem, best: NotepadListItem): boolean {
  if (candidate.updatedAt !== best.updatedAt) {
    return candidate.updatedAt > best.updatedAt;
  }
  return candidate.id < best.id;
}

/**
 * Names are unique per scope, so a create must dodge one an archived notepad
 * still holds — the date suffix, rather than failing the capture. Reached with
 * a promised name only when that name is genuinely unavailable: an unarchived
 * holder would have taken the capture rather than blocked it.
 */
function createDestination(
  input: CaptureDestinationInput,
  name: string,
): CaptureDestination {
  const taken = input.takenNames ?? [];
  return {
    kind: "create",
    scope: input.ambientProject ? "project" : "global",
    projectName: input.ambientProject?.name ?? null,
    name: taken.includes(name)
      ? `${CAPTURE_INBOX_NAME} (${input.today})`
      : name,
  };
}
