import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createNotepadsRepo, type NotepadsRepo } from "./notepads-repo";
import {
  createNotepadDeliveryWatermarksRepo,
  type NotepadDeliveryWatermarksRepo,
} from "./notepad-delivery-watermarks-repo";
import { createWriteQueue, type WriteQueue } from "./write-queue";
import { notepadDeliveryWatermarkSchema } from "@/lib/notepads/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { createNotepadCommentsRepo } from "./notepad-comments-repo";
import {
  createNotepadSourceReader,
  notepadInvolvementCursor,
} from "@/lib/subscriptions/notepad-source";

type Db = InstanceType<typeof Database>;

let db: Db;
let queue: WriteQueue;
let notepads: NotepadsRepo;
let watermarks: NotepadDeliveryWatermarksRepo;
let idSeq = 0;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  queue = createWriteQueue();
  notepads = createNotepadsRepo(db, queue);
  watermarks = createNotepadDeliveryWatermarksRepo(db, queue);
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
function reader(): NotepadDeliveryWatermarksRepo {
  return createNotepadDeliveryWatermarksRepo(db, queue);
}

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

async function createNotepad(name = "Release checklist") {
  const created = await notepads.create({
    id: nextId("notepad"),
    revisionId: nextId("rev"),
    scope: "global",
    projectPath: null,
    name,
    content: "# Release checklist",
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

describe("recording a delivery watermark", () => {
  it("retains opaque legacy marker knowledge without inventing comment identities", async () => {
    const notepad = await createNotepad();
    await watermarks.record({
      conversationId: "legacy-context",
      notepadId: notepad.id,
      revision: 4,
      openComments: { count: 2, latestCreatedAt: "2026-10-01T10:02:00Z" },
      updatedAt: "2026-10-01T10:03:00Z",
    });
    await watermarks.record({
      conversationId: "legacy-context",
      notepadId: notepad.id,
      revision: 2,
      openComments: { count: 3, latestCreatedAt: "2026-10-01T10:00:00Z" },
      updatedAt: "2026-10-01T10:04:00Z",
    });
    const persisted = (await reader().listForConversation("legacy-context"))[0];
    expect(persisted).toMatchObject({
      revision: 4,
      openComments: { count: 2, latestCreatedAt: "2026-10-01T10:02:00Z" },
    });
    expect(persisted?.commentIds).toBeUndefined();
  });
  it("preserves accepted knowledge when an older reference receipt retries after a newer acceptance", async () => {
    const notepad = await createNotepad();
    const comments = createNotepadCommentsRepo(db, queue);
    const add = (id: string, createdAt: string) =>
      comments.create({
        id,
        notepadId: notepad.id,
        body: id,
        authorKind: "user",
        authorConversationId: null,
        createdAt,
        anchor: {
          sectionId: "preamble",
          headingLabel: "",
          line: 1,
          charStart: 0,
          charEnd: 1,
          quote: "#",
          prefix: "",
          suffix: "",
          notepadRevision: 1,
        },
      });
    await add("older-observed", "2026-10-01T10:00:00Z");
    await comments.delete("older-observed");
    await add("newer-observed", "2026-10-01T10:01:00Z");
    await notepads.writeContent({
      notepadId: notepad.id,
      revisionId: "later-revision",
      operation: "update",
      content: "Later accepted body",
      authorKind: "user",
      authorConversationId: null,
      baseRevision: null,
      enforceBaseRevision: false,
      permittedWriteModes: null,
      restoredFromRevision: null,
      writtenAt: "2026-10-01T10:01:00Z",
      coalesceWindowMs: null,
    });
    await watermarks.record({
      conversationId: "out-of-order",
      notepadId: notepad.id,
      revision: 2,
      openComments: { count: 1, latestCreatedAt: "2026-10-01T10:01:00Z" },
      commentIds: ["newer-observed"],
      updatedAt: "2026-10-01T10:02:00Z",
    });
    await watermarks.record({
      conversationId: "out-of-order",
      notepadId: notepad.id,
      revision: 1,
      openComments: { count: 1, latestCreatedAt: "2026-10-01T10:00:00Z" },
      commentIds: ["older-observed"],
      updatedAt: "2026-10-01T10:03:00Z",
    });
    const persisted = (await reader().listForConversation("out-of-order"))[0];
    expect(persisted).toMatchObject({
      revision: 2,
      openComments: { count: 1, latestCreatedAt: "2026-10-01T10:01:00Z" },
      commentIds: ["newer-observed", "older-observed"],
    });
    const source = await createNotepadSourceReader({
      notepads,
      comments,
      watermarks: reader(),
    })(
      { projectPath: "/global-reader", conversationId: "out-of-order" },
      { kind: "notepad", id: notepad.id },
      notepadInvolvementCursor({
        notepadId: notepad.id,
        revision: 1,
        openComments: { count: 0, latestCreatedAt: null },
        commentIds: [],
      }),
    );
    expect(source.facts).toEqual([]);
  });
  it("retains the exact observed comment identities without rereading after acceptance", async () => {
    const notepad = await createNotepad();
    await watermarks.record({
      conversationId: "conversation-ids",
      notepadId: notepad.id,
      revision: 1,
      openComments: { count: 1, latestCreatedAt: "2026-10-01T10:00:00Z" },
      commentIds: ["open-at-render", "resolved-at-render"],
      updatedAt: "2026-10-01T10:01:00Z",
    });
    expect(
      (await reader().listForConversation("conversation-ids"))[0]?.commentIds,
    ).toEqual(["open-at-render", "resolved-at-render"]);
  });
  it("persists the presented revision and open-comment marker", async () => {
    const notepad = await createNotepad();

    await watermarks.record({
      conversationId: "conversation-1",
      notepadId: notepad.id,
      revision: 1,
      openComments: { count: 2, latestCreatedAt: "2026-08-28T10:00:00.000Z" },
      updatedAt: "2026-08-28T10:05:00.000Z",
    });

    expect(await reader().listForConversation("conversation-1")).toEqual([
      {
        conversationId: "conversation-1",
        notepadId: notepad.id,
        revision: 1,
        openComments: { count: 2, latestCreatedAt: "2026-08-28T10:00:00.000Z" },
        updatedAt: "2026-08-28T10:05:00.000Z",
      },
    ]);
  });

  it("upserts rather than appending, so a conversation holds one row per notepad", async () => {
    const notepad = await createNotepad();
    await watermarks.record({
      conversationId: "conversation-1",
      notepadId: notepad.id,
      revision: 1,
      openComments: { count: 0, latestCreatedAt: null },
      updatedAt: "2026-08-28T10:00:00.000Z",
    });

    await watermarks.record({
      conversationId: "conversation-1",
      notepadId: notepad.id,
      revision: 4,
      openComments: { count: 3, latestCreatedAt: "2026-08-28T11:00:00.000Z" },
      updatedAt: "2026-08-28T11:05:00.000Z",
    });

    const reloaded = await reader().listForConversation("conversation-1");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.revision).toBe(4);
    expect(reloaded[0]?.openComments).toEqual({
      count: 3,
      latestCreatedAt: "2026-08-28T11:00:00.000Z",
    });
  });

  it("keeps each conversation's watermark for the same notepad separate", async () => {
    const notepad = await createNotepad();
    await watermarks.record({
      conversationId: "conversation-1",
      notepadId: notepad.id,
      revision: 1,
      openComments: { count: 0, latestCreatedAt: null },
      updatedAt: "2026-08-28T10:00:00.000Z",
    });
    await watermarks.record({
      conversationId: "conversation-2",
      notepadId: notepad.id,
      revision: 3,
      openComments: { count: 0, latestCreatedAt: null },
      updatedAt: "2026-08-28T10:30:00.000Z",
    });

    expect(
      (await reader().listForConversation("conversation-1"))[0]?.revision,
    ).toBe(1);
    expect(
      (await reader().listForConversation("conversation-2"))[0]?.revision,
    ).toBe(3);
  });

  it("lists every notepad a conversation has been shown", async () => {
    const first = await createNotepad("First");
    const second = await createNotepad("Second");
    await watermarks.record({
      conversationId: "conversation-1",
      notepadId: first.id,
      revision: 1,
      openComments: { count: 0, latestCreatedAt: null },
      updatedAt: "2026-08-28T10:00:00.000Z",
    });
    await watermarks.record({
      conversationId: "conversation-1",
      notepadId: second.id,
      revision: 1,
      openComments: { count: 0, latestCreatedAt: null },
      updatedAt: "2026-08-28T10:01:00.000Z",
    });

    expect(
      (await reader().listForConversation("conversation-1")).map(
        (watermark) => watermark.notepadId,
      ),
    ).toEqual([first.id, second.id]);
  });

  it("reports a vanished notepad as null instead of raising a constraint", async () => {
    expect(
      await watermarks.record({
        conversationId: "conversation-1",
        notepadId: "notepad-that-was-deleted",
        revision: 1,
        openComments: { count: 0, latestCreatedAt: null },
        updatedAt: "2026-08-28T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("drops a notepad's watermarks when the notepad is deleted", async () => {
    const notepad = await createNotepad();
    await watermarks.record({
      conversationId: "conversation-1",
      notepadId: notepad.id,
      revision: 1,
      openComments: { count: 0, latestCreatedAt: null },
      updatedAt: "2026-08-28T10:00:00.000Z",
    });

    await notepads.delete(notepad.id);

    expect(await reader().listForConversation("conversation-1")).toEqual([]);
  });
});

describe("round-trip durability", () => {
  it("preserves every persisted watermark field across a reload", async () => {
    const notepad = await createNotepad();

    await assertRoundTripDurability({
      label: "notepad-delivery-watermarks",
      schema: notepadDeliveryWatermarkSchema,
      buildMaximalFixture: () =>
        notepadDeliveryWatermarkSchema.parse({
          conversationId: "conversation-maximal",
          notepadId: notepad.id,
          revision: 7,
          openComments: {
            count: 4,
            latestCreatedAt: "2026-03-16T09:10:11.000Z",
          },
          commentIds: ["comment-first", "comment-second", "comment-resolved"],
          updatedAt: "2026-04-17T10:11:12.000Z",
        }),
      persist: async (fixture) => {
        const recorded = await watermarks.record(fixture);
        if (recorded === null) {
          throw new Error("expected the watermark to persist");
        }
        return recorded;
      },
      reload: async (expected) =>
        (await reader().listForConversation(expected.conversationId))[0] ??
        null,
    });
  });
});
