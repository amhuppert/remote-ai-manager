import { describe, expect, it } from "vitest";

import type { SpecCommentView } from "./view-schemas";
import {
  assembleSpecCommentThreads,
  summarizeSpecComments,
} from "./comment-threads";

function comment(
  id: string,
  overrides: Partial<SpecCommentView> = {},
): SpecCommentView {
  return {
    id,
    threadId: "thread-1",
    parentCommentId: null,
    elementId: "requirement-1",
    handle: "R1",
    revisionId: "revision-1",
    revisionNumber: 1,
    anchor: { quote: "selected text" },
    quote: "selected text",
    body: `Body for ${id}`,
    author: { kind: "human" },
    blocking: false,
    resolution: "open",
    createdAt: "2026-08-22T12:00:00.000Z",
    updatedAt: "2026-08-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("assembleSpecCommentThreads", () => {
  it("finds the null-parent root and orders roots and messages by timestamp then id", () => {
    const replyFirst = comment("reply-b", {
      parentCommentId: "root-b",
      createdAt: "2026-08-22T12:01:00.000Z",
    });
    const rootB = comment("root-b", {
      createdAt: "2026-08-22T12:00:00.000Z",
    });
    const replyA = comment("reply-a", {
      parentCommentId: "root-b",
      createdAt: "2026-08-22T12:01:00.000Z",
    });
    const rootA = comment("root-a", {
      threadId: "thread-a",
      createdAt: "2026-08-22T11:59:00.000Z",
    });

    const threads = assembleSpecCommentThreads([
      replyFirst,
      rootB,
      replyA,
      rootA,
    ]);

    expect(threads.map((thread) => thread.threadId)).toEqual([
      "thread-a",
      "thread-1",
    ]);
    expect(threads[1]?.root.id).toBe("root-b");
    expect(threads[1]?.messages.map(({ id }) => id)).toEqual([
      "root-b",
      "reply-a",
      "reply-b",
    ]);
    expect(threads[1]?.replies.map(({ id }) => id)).toEqual([
      "reply-a",
      "reply-b",
    ]);
  });

  it("derives lifecycle defensively from every row while keeping root terminal state", () => {
    const threads = assembleSpecCommentThreads([
      comment("root", { resolution: "dismissed", blocking: false }),
      comment("reply", {
        parentCommentId: "root",
        resolution: "open",
        blocking: true,
      }),
    ]);

    expect(threads[0]).toMatchObject({
      open: true,
      blocking: true,
      resolution: "open",
      integrity: "valid",
    });

    const settled = assembleSpecCommentThreads([
      comment("root", { resolution: "dismissed" }),
      comment("reply", {
        parentCommentId: "root",
        resolution: "resolved",
        blocking: true,
      }),
    ]);
    expect(settled[0]).toMatchObject({
      open: false,
      blocking: false,
      resolution: "dismissed",
    });
  });

  it("treats a canonical one-row comment as a valid thread", () => {
    const [thread] = assembleSpecCommentThreads([comment("root")]);

    expect(thread).toMatchObject({
      root: { id: "root" },
      messages: [{ id: "root" }],
      replies: [],
      integrity: "valid",
    });
  });

  it.each([
    {
      name: "missing root",
      comments: [comment("reply", { parentCommentId: "absent" })],
      integrity: "missing-root",
      rootId: "reply",
    },
    {
      name: "multiple roots",
      comments: [
        comment("root-b"),
        comment("root-a", { createdAt: "2026-08-22T11:59:00.000Z" }),
      ],
      integrity: "multiple-roots",
      rootId: "root-a",
    },
    {
      name: "invalid parent",
      comments: [
        comment("root"),
        comment("reply", { parentCommentId: "different-root" }),
      ],
      integrity: "invalid-parent",
      rootId: "root",
    },
  ])("keeps every row visible for $name", ({ comments, integrity, rootId }) => {
    const [thread] = assembleSpecCommentThreads(comments);

    expect(thread?.integrity).toBe(integrity);
    expect(thread?.root.id).toBe(rootId);
    expect(thread?.messages).toHaveLength(comments.length);
  });
});

describe("summarizeSpecComments", () => {
  it("reports row and thread metrics independently", () => {
    const comments = [
      comment("root"),
      comment("reply-1", { parentCommentId: "root", blocking: true }),
      comment("reply-2", { parentCommentId: "root" }),
      comment("other-root", {
        threadId: "thread-2",
        blocking: true,
      }),
      comment("settled-root", {
        threadId: "thread-3",
        resolution: "resolved",
        blocking: true,
      }),
    ];

    expect(summarizeSpecComments(comments)).toEqual({
      openCount: 4,
      openBlockingCount: 2,
      openThreadCount: 2,
      openBlockingThreadCount: 2,
    });
  });
});
