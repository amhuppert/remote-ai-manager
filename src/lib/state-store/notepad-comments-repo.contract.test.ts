import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createNotepadsRepo, type NotepadsRepo } from "./notepads-repo";
import {
  createNotepadCommentsRepo,
  type NotepadCommentsRepo,
} from "./notepad-comments-repo";
import { createWriteQueue, type WriteQueue } from "./write-queue";
import { resolveNotepadCommentAnchor } from "@/lib/notepads/comment-anchors";
import {
  notepadCommentReplySchema,
  notepadCommentSchema,
  type NotepadCommentAnchor,
} from "@/lib/notepads/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

type Db = InstanceType<typeof Database>;

let db: Db;
let queue: WriteQueue;
let notepads: NotepadsRepo;
let comments: NotepadCommentsRepo;
let idSeq = 0;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  queue = createWriteQueue();
  notepads = createNotepadsRepo(db, queue);
  comments = createNotepadCommentsRepo(db, queue);
  idSeq = 0;
});

afterEach(() => {
  db.close();
});

/**
 * A second repo over the same database — the post-restart reader. Every
 * durability claim reloads through this rather than the writer instance, so a
 * value held in the writer's memory cannot stand in for a persisted one.
 */
function reader(): NotepadCommentsRepo {
  return createNotepadCommentsRepo(db, queue);
}

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

const CONTENT = [
  "# Release notes",
  "",
  "The migration lands additively and stamps no schema version.",
  "",
  "- [ ] confirm the rollback story",
].join("\n");

async function createNotepad(name = "Review me", content = CONTENT) {
  const created = await notepads.create({
    id: nextId("notepad"),
    revisionId: nextId("rev"),
    scope: "global",
    projectPath: null,
    name,
    content,
    writeMode: "full-edit",
    authorKind: "user",
    authorConversationId: null,
    createdAt: "2026-08-28T09:00:00.000Z",
  });
  if (created.status !== "created") {
    throw new Error(`expected create to succeed, got ${created.status}`);
  }
  return created.notepad;
}

function anchor(overrides: Partial<NotepadCommentAnchor> = {}) {
  return {
    sectionId: "release-notes",
    headingLabel: "Release notes",
    line: 3,
    charStart: 4,
    charEnd: 13,
    quote: "migration",
    prefix: "The ",
    suffix: " lands additively",
    notepadRevision: 1,
    ...overrides,
  };
}

async function addComment(
  notepadId: string,
  body: string,
  overrides: {
    anchor?: Partial<NotepadCommentAnchor>;
    authorKind?: "user" | "agent";
    authorConversationId?: string | null;
    createdAt?: string;
  } = {},
) {
  const created = await comments.create({
    id: nextId("comment"),
    notepadId,
    anchor: anchor(overrides.anchor ?? {}),
    body,
    authorKind: overrides.authorKind ?? "user",
    authorConversationId: overrides.authorConversationId ?? null,
    createdAt: overrides.createdAt ?? "2026-08-28T10:00:00.000Z",
  });
  if (created.status !== "created") {
    throw new Error(`expected comment create, got ${created.status}`);
  }
  return created.comment;
}

describe("comment creation and anchors", () => {
  it("persists a comment with its full anchor and author attribution", async () => {
    const notepad = await createNotepad();

    const comment = await addComment(notepad.id, "Name the rollback owner.", {
      authorKind: "user",
    });
    expect(comment.status).toBe("open");
    expect(comment.resolvedAt).toBeNull();

    const reloaded = await reader().find(comment.id);
    expect(reloaded).toEqual(comment);
    expect(reloaded?.anchor).toEqual({
      sectionId: "release-notes",
      headingLabel: "Release notes",
      line: 3,
      charStart: 4,
      charEnd: 13,
      quote: "migration",
      prefix: "The ",
      suffix: " lands additively",
      notepadRevision: 1,
    });
  });

  it("attributes an agent-authored comment to the conversation that wrote it", async () => {
    const notepad = await createNotepad();

    const comment = await addComment(notepad.id, "Drafted this section.", {
      authorKind: "agent",
      authorConversationId: "conv-writer",
    });

    const reloaded = await reader().find(comment.id);
    expect(reloaded?.authorKind).toBe("agent");
    expect(reloaded?.authorConversationId).toBe("conv-writer");
  });

  it("resolves a reloaded anchor back to the same passage of the canonical text", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Name the rollback owner.");

    // The durability that matters for a comment is not that its columns
    // survived, but that the passage they describe can still be found in the
    // notepad's canonical text after a restart.
    const reloaded = await reader().find(comment.id);
    if (reloaded === null) throw new Error("expected the comment to reload");

    const resolution = resolveNotepadCommentAnchor(
      reloaded.anchor,
      notepad.content,
    );
    expect(resolution).toEqual({
      state: "anchored",
      charStart: 4,
      charEnd: 13,
    });
    if (resolution.state !== "anchored") return;
    // And those offsets name the quoted passage in the canonical text itself,
    // not merely the numbers the row went in with.
    const block = notepad.content.split("\n")[reloaded.anchor.line - 1] ?? "";
    expect(block.slice(resolution.charStart, resolution.charEnd)).toBe(
      reloaded.anchor.quote,
    );
  });

  it("refuses a comment on a notepad that does not exist", async () => {
    const created = await comments.create({
      id: nextId("comment"),
      notepadId: "notepad-that-never-existed",
      anchor: anchor(),
      body: "orphan",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-28T10:00:00.000Z",
    });

    expect(created).toEqual({ status: "missing_notepad" });
  });
});

describe("replies", () => {
  it("persists a reply attributed to the replying conversation", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Please expand this.");

    const added = await comments.addReply({
      id: nextId("reply"),
      commentId: comment.id,
      body: "Expanded in revision 4.",
      authorKind: "agent",
      authorConversationId: "conv-replier",
      createdAt: "2026-08-28T10:05:00.000Z",
    });
    expect(added.status).toBe("created");

    const thread = await reader().findThread(comment.id);
    expect(thread?.replies).toHaveLength(1);
    expect(thread?.replies[0]?.body).toBe("Expanded in revision 4.");
    expect(thread?.replies[0]?.authorKind).toBe("agent");
    expect(thread?.replies[0]?.authorConversationId).toBe("conv-replier");
  });

  it("orders replies oldest first and refuses a reply to a missing comment", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Two answers coming.");

    await comments.addReply({
      id: nextId("reply"),
      commentId: comment.id,
      body: "first",
      authorKind: "agent",
      authorConversationId: "conv-replier",
      createdAt: "2026-08-28T10:05:00.000Z",
    });
    await comments.addReply({
      id: nextId("reply"),
      commentId: comment.id,
      body: "second",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-28T10:06:00.000Z",
    });

    const thread = await reader().findThread(comment.id);
    expect(thread?.replies.map((reply) => reply.body)).toEqual([
      "first",
      "second",
    ]);

    expect(
      await comments.addReply({
        id: nextId("reply"),
        commentId: "comment-that-never-existed",
        body: "orphan",
        authorKind: "user",
        authorConversationId: null,
        createdAt: "2026-08-28T10:07:00.000Z",
      }),
    ).toEqual({ status: "missing_comment" });
  });
});

describe("listing and lifecycle", () => {
  it("lists a notepad's comments with their replies, oldest first", async () => {
    const notepad = await createNotepad();
    const first = await addComment(notepad.id, "one", {
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const second = await addComment(notepad.id, "two", {
      createdAt: "2026-08-28T10:01:00.000Z",
    });
    await comments.addReply({
      id: nextId("reply"),
      commentId: second.id,
      body: "answering two",
      authorKind: "agent",
      authorConversationId: "conv-replier",
      createdAt: "2026-08-28T10:02:00.000Z",
    });

    const listed = await reader().list({ notepadId: notepad.id });
    expect(listed.map((thread) => thread.comment.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(listed[0]?.replies).toEqual([]);
    expect(listed[1]?.replies.map((reply) => reply.body)).toEqual([
      "answering two",
    ]);
  });

  it("lists only one notepad's comments", async () => {
    const mine = await createNotepad("Mine");
    const theirs = await createNotepad("Theirs");
    const comment = await addComment(mine.id, "scoped to mine");
    await addComment(theirs.id, "scoped to theirs");

    const listed = await reader().list({ notepadId: mine.id });
    expect(listed.map((thread) => thread.comment.id)).toEqual([comment.id]);
  });

  it("removes a resolved comment from the open listing and restores it on reopen", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Resolve me.");

    const resolved = await comments.updateStatus({
      commentId: comment.id,
      status: "resolved",
      updatedAt: "2026-08-28T11:00:00.000Z",
    });
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toBe("2026-08-28T11:00:00.000Z");

    expect(
      await reader().list({ notepadId: notepad.id, status: "open" }),
    ).toEqual([]);
    expect(
      (await reader().list({ notepadId: notepad.id, status: "resolved" })).map(
        (thread) => thread.comment.id,
      ),
    ).toEqual([comment.id]);

    const reopened = await comments.updateStatus({
      commentId: comment.id,
      status: "open",
      updatedAt: "2026-08-28T11:05:00.000Z",
    });
    expect(reopened?.status).toBe("open");
    // Reopening clears the resolution timestamp in the same write, so the two
    // can never disagree about whether the comment is settled.
    expect(reopened?.resolvedAt).toBeNull();
    expect(
      (await reader().list({ notepadId: notepad.id, status: "open" })).map(
        (thread) => thread.comment.id,
      ),
    ).toEqual([comment.id]);
  });

  it("deletes a comment permanently, taking its replies with it", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Delete me.");
    await comments.addReply({
      id: "reply-of-deleted",
      commentId: comment.id,
      body: "answered",
      authorKind: "agent",
      authorConversationId: "conv-replier",
      createdAt: "2026-08-28T10:05:00.000Z",
    });

    const deleted = await comments.delete(comment.id);
    expect(deleted?.id).toBe(comment.id);

    expect(await reader().find(comment.id)).toBeNull();
    expect(await reader().list({ notepadId: notepad.id })).toEqual([]);
    expect(await comments.delete(comment.id)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) FROM notepad_comment_replies").pluck().get(),
    ).toBe(0);
  });

  it("reports a missing comment rather than inventing one", async () => {
    expect(
      await comments.updateStatus({
        commentId: "comment-that-never-existed",
        status: "resolved",
        updatedAt: "2026-08-28T11:00:00.000Z",
      }),
    ).toBeNull();
    expect(await comments.findThread("comment-that-never-existed")).toBeNull();
  });
});

describe("open-comment marker", () => {
  it("reports no open comments for a notepad that has none", async () => {
    const notepad = await createNotepad();

    expect(await reader().openCommentMarker(notepad.id)).toEqual({
      count: 0,
      latestCreatedAt: null,
    });
  });

  it("counts open comments and names the newest one's creation time", async () => {
    const notepad = await createNotepad();
    await addComment(notepad.id, "First look.", {
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    await addComment(notepad.id, "Second look.", {
      createdAt: "2026-08-28T12:00:00.000Z",
    });

    expect(await reader().openCommentMarker(notepad.id)).toEqual({
      count: 2,
      latestCreatedAt: "2026-08-28T12:00:00.000Z",
    });
  });

  it("excludes resolved comments, so resolving never looks like new activity", async () => {
    const notepad = await createNotepad();
    const first = await addComment(notepad.id, "First look.", {
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    await addComment(notepad.id, "Second look.", {
      createdAt: "2026-08-28T12:00:00.000Z",
    });

    await comments.updateStatus({
      commentId: first.id,
      status: "resolved",
      updatedAt: "2026-08-28T13:00:00.000Z",
    });

    expect(await reader().openCommentMarker(notepad.id)).toEqual({
      count: 1,
      latestCreatedAt: "2026-08-28T12:00:00.000Z",
    });
  });

  it("counts only the notepad asked about", async () => {
    const mine = await createNotepad("Mine");
    const other = await createNotepad("Other");
    await addComment(mine.id, "On mine.");
    await addComment(other.id, "On the other.");
    await addComment(other.id, "Also on the other.");

    expect((await reader().openCommentMarker(mine.id)).count).toBe(1);
    expect((await reader().openCommentMarker(other.id)).count).toBe(2);
  });
});

describe("comments against a changing notepad", () => {
  it("keeps a comment and its replies addressable after rename, pin, and archive", async () => {
    const notepad = await createNotepad("Before organizing");
    const comment = await addComment(notepad.id, "Still mine afterwards.");
    await comments.addReply({
      id: nextId("reply"),
      commentId: comment.id,
      body: "still attached",
      authorKind: "agent",
      authorConversationId: "conv-replier",
      createdAt: "2026-08-28T10:05:00.000Z",
    });

    const renamed = await notepads.updateOrganization({
      notepadId: notepad.id,
      name: "After organizing",
      pinned: true,
      archived: true,
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    expect(renamed.status).toBe("updated");

    // Comments are keyed by the notepad's immutable id, so organization —
    // which touches name and flags only — cannot strand them.
    const afterOrganizing = reader();
    expect((await afterOrganizing.find(comment.id))?.body).toBe(
      "Still mine afterwards.",
    );
    const listed = await afterOrganizing.list({ notepadId: notepad.id });
    expect(listed.map((thread) => thread.comment.id)).toEqual([comment.id]);
    expect(listed[0]?.replies.map((reply) => reply.body)).toEqual([
      "still attached",
    ]);
  });

  it("keeps an anchor's authored-against revision after the content moves on", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Anchored at revision 1.");

    await notepads.writeContent({
      notepadId: notepad.id,
      revisionId: nextId("rev"),
      operation: "update",
      content: "Rewritten entirely.",
      authorKind: "user",
      authorConversationId: null,
      baseRevision: null,
      enforceBaseRevision: false,
      permittedWriteModes: null,
      restoredFromRevision: null,
      writtenAt: "2026-08-28T12:00:00.000Z",
      coalesceWindowMs: null,
    });

    expect((await reader().find(comment.id))?.anchor.notepadRevision).toBe(1);
  });

  it("deletes comments and replies with their notepad", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Goes with the notepad.");
    await comments.addReply({
      id: nextId("reply"),
      commentId: comment.id,
      body: "also gone",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-28T10:05:00.000Z",
    });

    await notepads.delete(notepad.id);

    expect(await reader().find(comment.id)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) FROM notepad_comment_replies").pluck().get(),
    ).toBe(0);
  });
});

describe("durability contracts", () => {
  it("round-trips every persisted comment key path through the real repo", async () => {
    const notepad = await createNotepad();

    await assertRoundTripDurability({
      label: "notepad-comments",
      schema: notepadCommentSchema,
      buildMaximalFixture: () =>
        notepadCommentSchema.parse({
          id: "comment-maximal",
          notepadId: notepad.id,
          anchor: {
            sectionId: "release-notes",
            headingLabel: "Release notes",
            line: 5,
            charStart: 6,
            charEnd: 15,
            quote: "rollback",
            prefix: "- [ ] confirm the ",
            suffix: " story",
            notepadRevision: 1,
          },
          body: "A maximal durability fixture body.",
          status: "resolved",
          authorKind: "agent",
          authorConversationId: "conv-reviewer",
          createdAt: "2026-02-15T08:09:10.000Z",
          updatedAt: "2026-03-16T09:10:11.000Z",
          resolvedAt: "2026-03-16T09:10:11.000Z",
        }),
      persist: async (fixture) => {
        const created = await comments.create({
          id: fixture.id,
          notepadId: fixture.notepadId,
          anchor: fixture.anchor,
          body: fixture.body,
          authorKind: fixture.authorKind,
          authorConversationId: fixture.authorConversationId,
          createdAt: fixture.createdAt,
        });
        if (created.status !== "created") {
          throw new Error(`create failed: ${created.status}`);
        }
        const resolved = await comments.updateStatus({
          commentId: fixture.id,
          status: fixture.status,
          updatedAt: fixture.updatedAt,
        });
        if (resolved === null) throw new Error("resolve failed");
        return resolved;
      },
      reload: (expected) => reader().find(expected.id),
      // The repo owns the resolution timestamp so it cannot disagree with the
      // status it explains; every other field maps to a dedicated column.
      fieldPolicies: { resolvedAt: "derived-on-write" },
    });
  });

  it("round-trips every persisted reply key path through the real repo", async () => {
    const notepad = await createNotepad();
    const comment = await addComment(notepad.id, "Reply fixture host.");

    await assertRoundTripDurability({
      label: "notepad-comment-replies",
      schema: notepadCommentReplySchema,
      buildMaximalFixture: () =>
        notepadCommentReplySchema.parse({
          id: "reply-maximal",
          commentId: comment.id,
          body: "A maximal durability fixture reply.",
          authorKind: "agent",
          authorConversationId: "conv-replier",
          createdAt: "2026-03-16T09:10:11.000Z",
        }),
      persist: async (fixture) => {
        const added = await comments.addReply({
          id: fixture.id,
          commentId: fixture.commentId,
          body: fixture.body,
          authorKind: fixture.authorKind,
          authorConversationId: fixture.authorConversationId,
          createdAt: fixture.createdAt,
        });
        if (added.status !== "created") {
          throw new Error(`reply failed: ${added.status}`);
        }
        return added.reply;
      },
      reload: async (expected) => {
        const thread = await reader().findThread(expected.commentId);
        return thread?.replies.find((r) => r.id === expected.id) ?? null;
      },
      fieldPolicies: {},
    });
  });
});
