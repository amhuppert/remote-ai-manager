import { z } from "zod";

import type { SpecEventRow } from "./schemas";
import type { TransitionRefusal } from "./transitions";

/**
 * The author's disposition document for one review round: what the revision
 * changed, which prior findings it closes, and what it deliberately did not
 * touch. It lives on the durable propose event rather than in a table of its
 * own — the document belongs to exactly one review request, and storing it on
 * that request's event is what makes it impossible for a request to show
 * notes written for another.
 *
 * Storage decision (durability-contracts): the notes ride the existing
 * `spec_events.payload_json` column as an OPTIONAL key on the propose event's
 * payload. No DDL migration and no schema-floor bump follow from that — the
 * column already exists and already holds a versionless JSON document — and
 * the optional key is what keeps both directions readable: a propose event
 * written before notes existed parses here as "the author supplied none", and
 * an older build reading a notes-bearing payload ignores a key it does not
 * know. The round-trip backstop lives in `spec-events-repo.contract.test.ts`.
 */
export const PROPOSAL_NOTES_MAX_CHARACTERS = 20_000;

/**
 * The durable propose-event payload. Not `.strict()`: the same payload also
 * carries the measure events the propose emits, and this schema speaks only
 * for the fields the notes surfaces read.
 *
 * `approved` is a propose kind here because an all-Notify/Off policy absorbs
 * the sign-off into the propose itself — the same author wrote the same
 * document, and a reader keyed only on `proposed` would lose it.
 */
export const proposeEventPayloadSchema = z.object({
  kind: z.enum(["proposed", "approved"]),
  revisionId: z.string().min(1),
  notes: z.string().min(1).optional(),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The disposition document recorded with the latest review request on
 * `revisionId`, or null when the author supplied none. Read from the durable event rather than from a
 * projected field so every surface — Studio, the review API, an audit — reads
 * the same bytes the propose transaction committed.
 */
export function proposalNotes(
  events: readonly SpecEventRow[],
  revisionId: string,
): string | null {
  const proposeEvent = events.findLast((event) => {
    if (event.event_type !== "spec-revision-changed") return false;
    const payload = proposeEventPayloadSchema.safeParse(
      parseJson(event.payload_json),
    );
    return payload.success && payload.data.revisionId === revisionId;
  });
  if (proposeEvent === undefined) return null;
  const payload = proposeEventPayloadSchema.safeParse(
    parseJson(proposeEvent.payload_json),
  );
  return payload.success ? (payload.data.notes ?? null) : null;
}

/**
 * The server-side cap, as a refusal or null. It is a domain refusal rather
 * than a schema bound because the caller needs to be told the limit and the
 * size they sent: a bare validation error names neither, and the author would
 * have to bisect their own document to find the line.
 */
export function oversizedProposalNotesRefusal(
  notes: string,
): TransitionRefusal | null {
  if (notes.length <= PROPOSAL_NOTES_MAX_CHARACTERS) return null;
  return {
    code: "validation",
    unmetConditions: [
      `The proposal notes are ${notes.length} characters; the server stores at most ${PROPOSAL_NOTES_MAX_CHARACTERS}.`,
    ],
    instruction: `Nothing was proposed. Shorten the notes to ${PROPOSAL_NOTES_MAX_CHARACTERS} characters or fewer — keep the disposition and the closure list, and link the long form from a spec element rather than pasting it — then run \`cctl spec propose <slug> --notes-file <file>\` again.`,
  };
}
