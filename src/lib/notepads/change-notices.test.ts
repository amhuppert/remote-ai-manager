import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import {
  createNotepadDeliveryStateReader,
  createNotepadDeliveryTracker,
  type NotepadDeliveryTracker,
} from "./change-notices";
import { buildNotepadReadCommand } from "./references";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createNotepadCommentsRepo,
  type NotepadCommentsRepo,
} from "@/lib/state-store/notepad-comments-repo";
import {
  createNotepadDeliveryWatermarksRepo,
  type NotepadDeliveryWatermarksRepo,
} from "@/lib/state-store/notepad-delivery-watermarks-repo";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import {
  createWriteQueue,
  type WriteQueue,
} from "@/lib/state-store/write-queue";

type Db = InstanceType<typeof Database>;

let db: Db;
let queue: WriteQueue;
let notepads: NotepadsRepo;
let comments: NotepadCommentsRepo;
let watermarks: NotepadDeliveryWatermarksRepo;
let tracker: NotepadDeliveryTracker;
let clock: string;
let idSeq = 0;

/**
 * Real repos over a real database throughout: a watermark that only exists in
 * a fake's memory proves nothing about the durability this seam is for.
 */
beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  queue = createWriteQueue();
  notepads = createNotepadsRepo(db, queue);
  comments = createNotepadCommentsRepo(db, queue);
  watermarks = createNotepadDeliveryWatermarksRepo(db, queue);
  clock = "2026-08-28T10:00:00.000Z";
  idSeq = 0;
  tracker = createNotepadDeliveryTracker({
    watermarks,
    readDeliveryState: createNotepadDeliveryStateReader({
      repo: notepads,
      comments,
    }),
    now: () => clock,
  });
});

afterEach(() => {
  db.close();
});

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
    content: "# Release checklist\n\nConfirm the rollback story.",
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

async function agentEdit(notepadId: string, content: string) {
  const written = await notepads.writeContent({
    notepadId,
    revisionId: nextId("rev"),
    operation: "update",
    content,
    authorKind: "agent",
    authorConversationId: "conversation-writer",
    enforceBaseRevision: false,
    baseRevision: null,
    permittedWriteModes: null,
    restoredFromRevision: null,
    writtenAt: "2026-08-28T11:00:00.000Z",
    coalesceWindowMs: null,
  });
  if (written.status !== "written") {
    throw new Error(`expected write to succeed, got ${written.status}`);
  }
  return written.notepad;
}

async function addOpenComment(
  notepadId: string,
  body: string,
  createdAt = "2026-08-28T12:00:00.000Z",
) {
  const created = await comments.create({
    id: nextId("comment"),
    notepadId,
    anchor: {
      sectionId: "release-checklist",
      headingLabel: "Release checklist",
      line: 3,
      charStart: 0,
      charEnd: 7,
      quote: "Confirm",
      prefix: "",
      suffix: " the rollback story.",
      notepadRevision: 1,
    },
    body,
    authorKind: "user",
    authorConversationId: null,
    createdAt,
  });
  if (created.status !== "created") {
    throw new Error(`expected comment create, got ${created.status}`);
  }
  return created.comment;
}

describe("recording a delivery", () => {
  it("tracks a notepad for the conversation its reference was expanded for", async () => {
    const notepad = await createNotepad();

    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: notepad.revision }],
    });

    const tracked = await tracker.listTracked("conversation-1");
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.seen).toEqual({
      conversationId: "conversation-1",
      notepadId: notepad.id,
      revision: 1,
      openComments: { count: 0, latestCreatedAt: null },
      updatedAt: clock,
    });
  });

  it("tracks nothing for a conversation whose messages carried no reference", async () => {
    const notepad = await createNotepad();
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: notepad.revision }],
    });

    expect(await tracker.listTracked("conversation-2")).toEqual([]);
  });

  it("records the revision the message carried, not a revision written since", async () => {
    const notepad = await createNotepad();
    // The write lands between the expansion and the recording — the agent saw
    // revision 1, so revision 1 is what the watermark must hold.
    await agentEdit(notepad.id, "# Release checklist\n\nRewritten.");

    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });

    const tracked = await tracker.listTracked("conversation-1");
    expect(tracked[0]?.seen.revision).toBe(1);
    expect(tracked[0]?.current.revision).toBe(2);
  });

  it("captures the open-comment state as part of what was presented", async () => {
    const notepad = await createNotepad();
    await addOpenComment(notepad.id, "Name the rollback owner.");

    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: notepad.revision }],
    });

    expect(
      (await tracker.listTracked("conversation-1"))[0]?.seen.openComments,
    ).toEqual({ count: 1, latestCreatedAt: "2026-08-28T12:00:00.000Z" });
  });

  it("records every notepad a single message referenced", async () => {
    const first = await createNotepad("First");
    const second = await createNotepad("Second");

    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [
        { notepadId: first.id, revision: 1 },
        { notepadId: second.id, revision: 1 },
      ],
    });

    expect(
      (await tracker.listTracked("conversation-1")).map(
        (entry) => entry.current.name,
      ),
    ).toEqual(["First", "Second"]);
  });

  it("advances an existing watermark rather than tracking the notepad twice", async () => {
    const notepad = await createNotepad();
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });
    await agentEdit(notepad.id, "# Release checklist\n\nRewritten.");

    clock = "2026-08-28T11:30:00.000Z";
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 2 }],
    });

    const tracked = await tracker.listTracked("conversation-1");
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.seen.revision).toBe(2);
  });

  it("ignores a notepad that was deleted before the recording landed", async () => {
    const notepad = await createNotepad();
    await notepads.delete(notepad.id);

    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });

    expect(await tracker.listTracked("conversation-1")).toEqual([]);
  });
});

describe("the read seam prompt assembly consumes", () => {
  it("survives a reload — the watermark is durable, not in-memory", async () => {
    const notepad = await createNotepad();
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });

    const reloaded = createNotepadDeliveryTracker({
      watermarks: createNotepadDeliveryWatermarksRepo(db, queue),
      readDeliveryState: createNotepadDeliveryStateReader({
        repo: createNotepadsRepo(db, queue),
        comments: createNotepadCommentsRepo(db, queue),
      }),
      now: () => clock,
    });

    expect(
      (await reloaded.listTracked("conversation-1"))[0]?.seen.revision,
    ).toBe(1);
  });

  it("pairs the watermark with the notepad's state today", async () => {
    const notepad = await createNotepad();
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });
    await agentEdit(
      notepad.id,
      "# Release checklist\n\nRewritten by the agent.",
    );
    await addOpenComment(notepad.id, "Explain the rewrite.");

    const tracked = await tracker.listTracked("conversation-1");

    expect(tracked[0]?.current).toEqual({
      id: notepad.id,
      name: "Release checklist",
      revision: 2,
      authorKind: "agent",
      openComments: { count: 1, latestCreatedAt: "2026-08-28T12:00:00.000Z" },
    });
  });

  it("drops a tracked notepad once it is deleted", async () => {
    const notepad = await createNotepad();
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });

    await notepads.delete(notepad.id);

    expect(await tracker.listTracked("conversation-1")).toEqual([]);
  });
});

describe("preparing the change notice", () => {
  async function deliver(notepadId: string, revision: number) {
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId, revision }],
    });
  }

  it("names the notepad, revision, author kind, and read command after a content change", async () => {
    const notepad = await createNotepad();
    await deliver(notepad.id, 1);
    await agentEdit(notepad.id, "# Release checklist\n\nRewritten.");

    const notice = await tracker.prepare("conversation-1");

    expect(notice.block).toContain(`id: ${notepad.id}`);
    expect(notice.block).toContain("name: Release checklist");
    expect(notice.block).toContain("revision: 2");
    expect(notice.block).toContain("changed: content");
    expect(notice.block).toContain("changed-by: agent");
    expect(notice.block).toContain(
      `read: ${buildNotepadReadCommand(notepad.id)}`,
    );
  });

  it("never carries the changed content itself", async () => {
    const notepad = await createNotepad();
    await deliver(notepad.id, 1);
    await agentEdit(notepad.id, "# Release checklist\n\nSECRET NEW BODY.");

    const notice = await tracker.prepare("conversation-1");

    expect(notice.block).not.toContain("SECRET NEW BODY");
  });

  it("prepares nothing when nothing changed", async () => {
    const notepad = await createNotepad();
    await deliver(notepad.id, 1);

    const notice = await tracker.prepare("conversation-1");

    expect(notice.block).toBeNull();
    expect(notice.advances).toEqual([]);
  });

  it("prepares nothing for a conversation that was never shown the notepad", async () => {
    const notepad = await createNotepad();
    await deliver(notepad.id, 1);
    await agentEdit(notepad.id, "# Release checklist\n\nRewritten.");

    expect((await tracker.prepare("conversation-2")).block).toBeNull();
  });

  it("names comment activity when a new open comment appeared", async () => {
    const notepad = await createNotepad();
    await deliver(notepad.id, 1);
    await addOpenComment(notepad.id, "Name the rollback owner.");

    const notice = await tracker.prepare("conversation-1");

    expect(notice.block).toContain("changed: comments");
    expect(notice.block).toContain("open-comments: 1");
    expect(notice.block).toContain(`id: ${notepad.id}`);
  });

  it("names both when content and comments changed together", async () => {
    const notepad = await createNotepad();
    await deliver(notepad.id, 1);
    await agentEdit(notepad.id, "# Release checklist\n\nRewritten.");
    await addOpenComment(notepad.id, "Explain the rewrite.");

    expect((await tracker.prepare("conversation-1")).block).toContain(
      "changed: content, comments",
    );
  });

  it("treats a restore as a content change", async () => {
    const notepad = await createNotepad();
    await agentEdit(notepad.id, "# Release checklist\n\nSecond revision.");
    await deliver(notepad.id, 2);

    const restored = await notepads.writeContent({
      notepadId: notepad.id,
      revisionId: nextId("rev"),
      operation: "restore",
      content: "# Release checklist\n\nConfirm the rollback story.",
      authorKind: "user",
      authorConversationId: null,
      enforceBaseRevision: false,
      baseRevision: null,
      permittedWriteModes: null,
      restoredFromRevision: 1,
      writtenAt: "2026-08-28T12:30:00.000Z",
      coalesceWindowMs: null,
    });
    if (restored.status !== "written") {
      throw new Error(`expected restore to succeed, got ${restored.status}`);
    }

    const notice = await tracker.prepare("conversation-1");

    expect(notice.block).toContain("changed: content");
    expect(notice.block).toContain("revision: 3");
    expect(notice.block).toContain("changed-by: user");
  });

  it("produces no notice for rename, pin, or archive", async () => {
    const notepad = await createNotepad();
    await deliver(notepad.id, 1);

    const organized = await notepads.updateOrganization({
      notepadId: notepad.id,
      name: "Renamed checklist",
      pinned: true,
      archived: true,
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
    if (organized.status !== "updated") {
      throw new Error(`expected organize to succeed, got ${organized.status}`);
    }

    expect((await tracker.prepare("conversation-1")).block).toBeNull();
  });

  it("produces no notice when the only comment act was resolving one already seen", async () => {
    const notepad = await createNotepad();
    const comment = await addOpenComment(
      notepad.id,
      "Name the rollback owner.",
    );
    await deliver(notepad.id, 1);

    await comments.updateStatus({
      commentId: comment.id,
      status: "resolved",
      updatedAt: "2026-08-28T13:00:00.000Z",
    });

    expect((await tracker.prepare("conversation-1")).block).toBeNull();
  });

  it("names every changed notepad the conversation has seen", async () => {
    const first = await createNotepad("First");
    const second = await createNotepad("Second");
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [
        { notepadId: first.id, revision: 1 },
        { notepadId: second.id, revision: 1 },
      ],
    });
    await agentEdit(first.id, "First rewritten.");
    await agentEdit(second.id, "Second rewritten.");

    const notice = await tracker.prepare("conversation-1");

    expect(notice.block).toContain(`id: ${first.id}`);
    expect(notice.block).toContain(`id: ${second.id}`);
    expect(notice.advances).toHaveLength(2);
  });
});

describe("settle gating", () => {
  async function deliverAndChange() {
    const notepad = await createNotepad();
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });
    await agentEdit(notepad.id, "# Release checklist\n\nRewritten.");
    return notepad;
  }

  it("does not repeat an accepted notice on the next message", async () => {
    await deliverAndChange();
    const notice = await tracker.prepare("conversation-1");
    expect(notice.block).not.toBeNull();

    await tracker.settle(notice);

    expect((await tracker.prepare("conversation-1")).block).toBeNull();
  });

  it("re-fires the notice when the delivery failed before acceptance", async () => {
    await deliverAndChange();
    const first = await tracker.prepare("conversation-1");
    expect(first.block).not.toBeNull();

    // No settle — the backend never accepted the message that carried it.
    const second = await tracker.prepare("conversation-1");

    expect(second.block).toBe(first.block);
  });

  it("notices a change that landed after the previous notice settled", async () => {
    const notepad = await deliverAndChange();
    await tracker.settle(await tracker.prepare("conversation-1"));

    await agentEdit(notepad.id, "# Release checklist\n\nRewritten again.");

    expect((await tracker.prepare("conversation-1")).block).toContain(
      "revision: 3",
    );
  });

  it("tolerates settling the same notice twice — the notice is idempotent", async () => {
    await deliverAndChange();
    const notice = await tracker.prepare("conversation-1");

    await tracker.settle(notice);
    await tracker.settle(notice);

    expect((await tracker.prepare("conversation-1")).block).toBeNull();
  });

  it("settles comment activity too, so a seen comment does not re-notify", async () => {
    const notepad = await createNotepad();
    await tracker.recordDelivered({
      conversationId: "conversation-1",
      notepads: [{ notepadId: notepad.id, revision: 1 }],
    });
    await addOpenComment(notepad.id, "Name the rollback owner.");

    await tracker.settle(await tracker.prepare("conversation-1"));

    expect((await tracker.prepare("conversation-1")).block).toBeNull();
  });
});
