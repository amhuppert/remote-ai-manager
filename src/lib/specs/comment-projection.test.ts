import { describe, expect, it } from "vitest";

import type { SpecCommentRow } from "./schemas";
import { projectSpecComment } from "./comment-projection";
import { specCommentViewSchema } from "./view-schemas";

const anchor = {
  sectionId: "sec-1",
  headingLabel: "Requirements",
  line: 3,
  charStart: 10,
  charEnd: 25,
  quote: "retries are excluded",
  prefix: "the flow assumes ",
  suffix: " for now",
  docRevision: "rev-2",
};

function commentRow(overrides: Partial<SpecCommentRow> = {}): SpecCommentRow {
  return {
    id: "comment-1",
    spec_id: "spec-1",
    thread_id: "thread-1",
    parent_comment_id: null,
    element_id: "req-locality",
    anchor_json: JSON.stringify(anchor),
    revision_id: "revision-2",
    body: "Why does R6 exclude retries?",
    author_json: JSON.stringify({ kind: "human" }),
    blocking: 1,
    resolution: "open",
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T01:00:00.000Z",
    ...overrides,
  };
}

const context = {
  handleByElementId: new Map([["req-locality", "R6"]]),
  revisionNumberById: new Map([["revision-2", 2]]),
};

describe("projectSpecComment", () => {
  it("projects a row into the typed camelCase view", () => {
    const view = projectSpecComment(commentRow(), context);

    expect(view).toEqual({
      id: "comment-1",
      threadId: "thread-1",
      parentCommentId: null,
      elementId: "req-locality",
      handle: "R6",
      revisionId: "revision-2",
      revisionNumber: 2,
      anchor,
      quote: "retries are excluded",
      body: "Why does R6 exclude retries?",
      author: { kind: "human" },
      blocking: true,
      resolution: "open",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T01:00:00.000Z",
    });
    expect(specCommentViewSchema.parse(view)).toEqual(view);
  });

  it("keeps agent authorship intact", () => {
    const view = projectSpecComment(
      commentRow({
        author_json: JSON.stringify({
          kind: "agent",
          conversationId: "conv-9",
        }),
        blocking: 0,
      }),
      context,
    );

    expect(view.author).toEqual({ kind: "agent", conversationId: "conv-9" });
    expect(view.blocking).toBe(false);
  });

  it("degrades unknown handles, revisions, anchors, and authors to null instead of failing the read", () => {
    const view = projectSpecComment(
      commentRow({
        element_id: "removed-element",
        revision_id: "revision-gone",
        anchor_json: "not json",
        author_json: JSON.stringify({ kind: "unmapped-actor" }),
      }),
      context,
    );

    expect(view.handle).toBeNull();
    expect(view.revisionNumber).toBeNull();
    expect(view.anchor).toBeNull();
    expect(view.quote).toBeNull();
    expect(view.author).toBeNull();
    expect(specCommentViewSchema.parse(view)).toEqual(view);
  });

  it("extracts the quote only when the anchor carries one", () => {
    const view = projectSpecComment(
      commentRow({ anchor_json: JSON.stringify({ note: "no quote here" }) }),
      context,
    );

    expect(view.anchor).toEqual({ note: "no quote here" });
    expect(view.quote).toBeNull();
  });
});
