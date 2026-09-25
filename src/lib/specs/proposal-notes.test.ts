import { describe, expect, it } from "vitest";

import {
  PROPOSAL_NOTES_MAX_CHARACTERS,
  oversizedProposalNotesRefusal,
  proposalNotes,
} from "./proposal-notes";
import { revisionAuthor } from "./revision-author";
import type { SpecEventRow } from "./schemas";

const ACTOR = JSON.stringify({
  kind: "agent",
  conversationId: "conversation-1",
  backend: "claude",
});

function event(
  id: number,
  eventType: SpecEventRow["event_type"],
  payload: unknown,
): SpecEventRow {
  return {
    id,
    spec_id: "spec-1",
    occurred_at: `2026-08-07T10:0${id}:00.000Z`,
    event_type: eventType,
    actor_json: ACTOR,
    payload_json: JSON.stringify(payload),
  };
}

describe("proposalNotes", () => {
  it("reads the disposition document off the revision's propose event", () => {
    const events = [
      event(1, "spec-revision-changed", {
        kind: "proposed",
        revisionId: "revision-2",
        notes: "## Disposition\n\nClosed F3 by rebinding the exit.",
      }),
    ];

    expect(proposalNotes(events, "revision-2")).toBe(
      "## Disposition\n\nClosed F3 by rebinding the exit.",
    );
  });

  /**
   * Every propose event written before notes existed carries no `notes` key.
   * They must still parse — as an author who supplied none, not as a broken
   * row — or the reader would blank out the review history of every spec.
   */
  it("reads a legacy propose event that carries no notes as none", () => {
    const legacy = [
      event(1, "spec-revision-changed", {
        kind: "proposed",
        revisionId: "revision-2",
      }),
    ];

    expect(proposalNotes(legacy, "revision-2")).toBeNull();
    expect(revisionAuthor(legacy, "revision-2")).toMatchObject({
      kind: "agent",
      conversationId: "conversation-1",
    });
  });

  /** A notes-bearing payload must not disturb the ownership read beside it. */
  it("leaves the propose event's authorship readable when notes ride it", () => {
    const events = [
      event(1, "spec-revision-changed", {
        kind: "proposed",
        revisionId: "revision-2",
        notes: "Rewrote R4 after the reviewer's finding.",
      }),
    ];

    expect(revisionAuthor(events, "revision-2")).toMatchObject({
      conversationId: "conversation-1",
    });
  });

  /**
   * Under an all-Notify/Off policy the propose absorbs the sign-off and the
   * event is recorded as `approved`. The author still wrote a disposition, and
   * a reader keyed only on `proposed` would lose it.
   */
  it("reads notes off a propose that absorbed the sign-off", () => {
    const events = [
      event(1, "spec-revision-changed", {
        kind: "approved",
        revisionId: "revision-2",
        notes: "Policy-admitted; no reviewer round.",
      }),
    ];

    expect(proposalNotes(events, "revision-2")).toBe(
      "Policy-admitted; no reviewer round.",
    );
  });

  it("returns nothing for a revision whose sibling carries the notes", () => {
    const events = [
      event(1, "spec-revision-changed", {
        kind: "proposed",
        revisionId: "revision-2",
        notes: "Revision 2's disposition.",
      }),
    ];

    expect(proposalNotes(events, "revision-3")).toBeNull();
  });

  it("ignores unrelated revision events and unparseable payloads", () => {
    const events: SpecEventRow[] = [
      {
        ...event(1, "spec-revision-changed", null),
        payload_json: "{not json",
      },
      event(2, "spec-review-commented", {
        kind: "proposed",
        revisionId: "revision-2",
        notes: "Not a propose event.",
      }),
      event(3, "spec-revision-changed", {
        kind: "withdrawn",
        revisionId: "revision-2",
        notes: "Not a propose kind.",
      }),
    ];

    expect(proposalNotes(events, "revision-2")).toBeNull();
  });
});

describe("oversizedProposalNotesRefusal", () => {
  it("admits a document at the cap", () => {
    expect(
      oversizedProposalNotesRefusal("x".repeat(PROPOSAL_NOTES_MAX_CHARACTERS)),
    ).toBeNull();
  });

  it("refuses one character over the cap, naming the cap and the size sent", () => {
    const refusal = oversizedProposalNotesRefusal(
      "x".repeat(PROPOSAL_NOTES_MAX_CHARACTERS + 1),
    );

    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe("validation");
    expect(refusal?.unmetConditions.join(" ")).toContain(
      String(PROPOSAL_NOTES_MAX_CHARACTERS),
    );
    expect(refusal?.unmetConditions.join(" ")).toContain(
      String(PROPOSAL_NOTES_MAX_CHARACTERS + 1),
    );
  });

  /** A refusal that does not name its exit recreates the dead end (#50). */
  it("names the remedy and states that nothing was proposed", () => {
    const refusal = oversizedProposalNotesRefusal(
      "x".repeat(PROPOSAL_NOTES_MAX_CHARACTERS + 1),
    );

    expect(refusal?.instruction).toContain("--notes-file");
    expect(refusal?.instruction.toLowerCase()).toContain("shorten");
    expect(refusal?.instruction.toLowerCase()).toContain("nothing was");
  });
});
