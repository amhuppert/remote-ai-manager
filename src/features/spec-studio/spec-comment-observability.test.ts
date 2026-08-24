import { describe, expect, it, vi } from "vitest";

import type { SpecCommentThreadModel } from "@/lib/specs/comment-threads";
import type { SpecCommentView } from "@/lib/specs/view-schemas";

import {
  logInvalidSpecCommentThread,
  logSpecCommentReanchor,
} from "./spec-comment-observability";

function comment(id: string, parentCommentId: string | null): SpecCommentView {
  return {
    id,
    threadId: "thread-7",
    parentCommentId,
    elementId: "requirement-3",
    handle: "R3",
    revisionId: "revision-4",
    revisionNumber: 4,
    anchor: { quote: "private selected passage" },
    quote: "private selected passage",
    body: "private conversation content",
    author: { kind: "human" },
    blocking: false,
    resolution: "open",
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
  };
}

function invalidThread(): SpecCommentThreadModel {
  const root = comment("comment-root", null);
  const secondRoot = comment("comment-second-root", null);
  return {
    threadId: "thread-7",
    root,
    messages: [root, secondRoot],
    replies: [secondRoot],
    open: true,
    blocking: false,
    resolution: "open",
    integrity: "multiple-roots",
  };
}

describe("spec comment observability", () => {
  it("logs aggregate anchor outcomes with identifiers and no comment content", () => {
    const debug = vi.fn();

    logSpecCommentReanchor(
      { debug },
      {
        specId: "spec-1",
        revisionId: "revision-4",
        anchorStates: [
          { status: "anchored", charStart: 0, charEnd: 4 },
          { status: "anchored", charStart: 8, charEnd: 12 },
          { status: "reanchored", charStart: 3, charEnd: 9 },
          { status: "stale" },
          { status: "orphaned" },
        ],
      },
    );

    expect(debug).toHaveBeenCalledWith("spec_studio.comment.reanchor", {
      specId: "spec-1",
      revisionId: "revision-4",
      anchored: 2,
      reanchored: 1,
      stale: 1,
      orphaned: 1,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("private");
  });

  it("warns once with malformed thread identifiers but no bodies or anchors", () => {
    const warn = vi.fn();

    logInvalidSpecCommentThread(
      { warn },
      { specId: "spec-1", thread: invalidThread() },
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("spec_studio.comment.invalid_thread", {
      specId: "spec-1",
      threadId: "thread-7",
      integrity: "multiple-roots",
      rowIds: ["comment-root", "comment-second-root"],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });
});
