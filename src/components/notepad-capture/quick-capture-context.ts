/**
 * What the app-global quick-capture host must know before it records: which
 * project the current route puts the user in, and which notepads the shared
 * destination rule may choose between.
 *
 * Project derivation reuses the whole quick-ticket resolution — route inference
 * and the conversation registry both — rather than route inference alone. The
 * two hosts live side by side in the root layout and must agree about "the
 * project you are looking at", or a capture and a ticket raised from the same
 * screen would disagree about where they belong.
 */

import type {
  CaptureDestination,
  CaptureDestinationInput,
} from "@/lib/notepads/capture-destination";
import type { NotepadListItem } from "@/lib/notepads/schemas";
import {
  resolveQuickTicketContext,
  type QuickTicketConversationRegistration,
} from "@/lib/tickets/quick-ticket-context";

export interface AmbientProject {
  name: string;
}

/**
 * The ambient project of a route, or null outside any project context.
 *
 * Resolved exactly as the quick-ticket host resolves it — route inference plus
 * the conversation registry, so a conversation open on an otherwise
 * project-less route (`/conversations?c=…`) names its project here too. Taking
 * only the route would send that capture to the global pool while a ticket
 * raised from the same screen went to the project.
 *
 * The caller reads `search` and the registrations at the moment of the press,
 * the way QuickTicketHost does, rather than memoising them: a search-only
 * change (the tickets project filter) moves neither the pathname nor a React
 * subscription, so a memoised copy would go stale.
 */
export function ambientProjectFromRoute(
  pathname: string | null | undefined,
  search: string,
  registrations: readonly QuickTicketConversationRegistration[] = [],
): AmbientProject | null {
  if (!pathname) return null;
  const { projectName } = resolveQuickTicketContext({
    pathname,
    searchParams: new URLSearchParams(search),
    registrations,
  });
  return projectName === undefined ? null : { name: projectName };
}

export interface QuickCaptureResolutionInput {
  ambientProject: AmbientProject | null;
  /** The right-pane notepad, as the session store holds it. */
  openNotepadId: string | null;
  /**
   * The destination pool, archived rows included: the recency tier needs the
   * unarchived ones and the create tier needs every taken name.
   */
  listing: readonly NotepadListItem[];
  /**
   * The name the surface already showed, when landing is honouring a
   * destination it promised before recording rather than resolving afresh.
   */
  promisedName?: string;
  today: string;
}

/**
 * Assemble the shared rule's inputs from what the host holds.
 *
 * The open notepad is only honoured while the listing still contains it: a
 * notepad deleted mid-capture leaves its id in the session store, and trusting
 * that stale id would append into nothing. Dropping it here is what makes
 * landing re-resolve rather than fail (D21).
 */
export function quickCaptureResolution(
  input: QuickCaptureResolutionInput,
): CaptureDestinationInput {
  const open =
    input.openNotepadId !== null &&
    input.listing.some((row) => row.id === input.openNotepadId && !row.archived)
      ? { id: input.openNotepadId }
      : null;

  return {
    openNotepad: open,
    candidates: input.listing,
    ambientProject: input.ambientProject,
    ...(input.promisedName === undefined
      ? {}
      : { promisedName: input.promisedName }),
    takenNames: input.listing
      .filter((row) => isInDestinationScope(row, input.ambientProject))
      .map((row) => row.name),
    today: input.today,
  };
}

function isInDestinationScope(
  row: NotepadListItem,
  ambientProject: AmbientProject | null,
): boolean {
  return ambientProject === null
    ? row.scope === "global"
    : row.scope === "project" && row.projectName === ambientProject.name;
}

/**
 * The destination's name, for the surface that must show it before anything
 * lands. A create carries its own name; an existing destination is named by
 * the listing row it resolved to, and `null` when the caller holds no row for
 * it — the caller names it from the notepad it already has open instead of
 * inventing a label.
 */
export function captureDestinationName(
  destination: CaptureDestination,
  listing: readonly NotepadListItem[],
): string | null {
  if (destination.kind === "create") return destination.name;
  return listing.find((row) => row.id === destination.id)?.name ?? null;
}
