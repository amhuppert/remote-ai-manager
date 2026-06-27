import type { QueryKey } from "@tanstack/react-query";

import { alignmentKeys } from "./query-keys";
import type { SessionAlignmentUpdatedEvent } from "./schemas";

/**
 * Maps a `session-alignment-updated` SSE event to the query keys an open
 * session view must invalidate so it refetches the active charter.
 *
 * Invalidating the whole alignment subtree (`alignmentKeys.all`) is the simple
 * correct refresh here: the event carries `projectPath` rather than the
 * `projectName` the query keys are scoped by, and alignment views are
 * session-scoped and rarely open concurrently, so there is no fan-out cost to
 * guard against. Precise per-key invalidation after a client-initiated change
 * is handled by the mutations.
 */
export function computeAlignmentInvalidations(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the event is part of the contract; broad invalidation needs none of its fields (see above).
  _event: SessionAlignmentUpdatedEvent,
): { queryKey: QueryKey }[] {
  return [{ queryKey: alignmentKeys.all }];
}
