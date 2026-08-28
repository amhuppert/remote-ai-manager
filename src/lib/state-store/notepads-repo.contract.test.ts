import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createNotepadsRepo, type NotepadsRepo } from "./notepads-repo";
import { createWriteQueue, type WriteQueue } from "./write-queue";
import {
  notepadImageSchema,
  notepadRevisionSchema,
  notepadSchema,
  type NotepadImage,
} from "@/lib/notepads/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT = "/repos/other";

let db: Db;
let queue: WriteQueue;
let repo: NotepadsRepo;
let idSeq = 0;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(OTHER_PROJECT);
  queue = createWriteQueue();
  repo = createNotepadsRepo(db, queue);
  idSeq = 0;
});

afterEach(() => {
  db.close();
});

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

async function createGlobal(
  name: string,
  overrides: {
    content?: string;
    writeMode?: "read-only" | "append-only" | "full-edit";
    createdAt?: string;
  } = {},
) {
  const result = await repo.create({
    id: nextId("notepad"),
    revisionId: nextId("rev"),
    scope: "global",
    projectPath: null,
    name,
    content: overrides.content ?? "",
    writeMode: overrides.writeMode ?? "full-edit",
    authorKind: "user",
    authorConversationId: null,
    createdAt: overrides.createdAt ?? "2026-08-27T09:00:00.000Z",
  });
  if (result.status !== "created") {
    throw new Error(`expected create to succeed, got ${result.status}`);
  }
  return result.notepad;
}

async function userEdit(
  notepadId: string,
  content: string,
  at: string,
  coalesceWindowMs: number | null = null,
) {
  return repo.writeContent({
    coalesceWindowMs,
    notepadId,
    revisionId: nextId("rev"),
    operation: "update",
    content,
    authorKind: "user",
    authorConversationId: null,
    baseRevision: null,
    enforceBaseRevision: false,
    // A user write is not mode-governed: the mode is their control over agents.
    permittedWriteModes: null,
    restoredFromRevision: null,
    writtenAt: at,
  });
}

async function agentEdit(
  notepadId: string,
  content: string,
  baseRevision: number,
  at: string,
  operation: "update" | "append" = "update",
) {
  return repo.writeContent({
    notepadId,
    revisionId: nextId("rev"),
    operation,
    content,
    authorKind: "agent",
    authorConversationId: "conv-writer",
    baseRevision,
    enforceBaseRevision: true,
    // An agent write is one deliberate act; it never folds into another row.
    coalesceWindowMs: null,
    // The service is the policy owner; these are the modes it would permit for
    // this operation, restated here because the helper bypasses the service.
    permittedWriteModes:
      operation === "append" ? ["append-only", "full-edit"] : ["full-edit"],
    restoredFromRevision: null,
    writtenAt: at,
  });
}

describe("scoped creation and listing", () => {
  it("persists notepads in both scopes and lists each scope separately", async () => {
    const global = await createGlobal("Shared");
    const scoped = await repo.create({
      id: nextId("notepad"),
      revisionId: nextId("rev"),
      scope: "project",
      projectPath: PROJECT_PATH,
      name: "Project notes",
      content: "body",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-27T09:01:00.000Z",
    });
    expect(scoped.status).toBe("created");

    const globals = await repo.list({
      scope: "global",
      includeArchived: false,
      sort: "recency",
    });
    expect(globals.map((n) => n.id)).toEqual([global.id]);

    const projectScoped = await repo.list({
      scope: "project",
      projectPath: PROJECT_PATH,
      includeArchived: false,
      sort: "recency",
    });
    expect(projectScoped.map((n) => n.name)).toEqual(["Project notes"]);
    expect(projectScoped[0]?.projectName).toBe("command-center");

    const otherProject = await repo.list({
      scope: "project",
      projectPath: OTHER_PROJECT,
      includeArchived: false,
      sort: "recency",
    });
    expect(otherProject).toEqual([]);
  });

  it("merges global and one project's notepads when a project is supplied without a scope", async () => {
    await createGlobal("Shared");
    await repo.create({
      id: nextId("notepad"),
      revisionId: nextId("rev"),
      scope: "project",
      projectPath: PROJECT_PATH,
      name: "Mine",
      content: "",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-27T09:01:00.000Z",
    });
    await repo.create({
      id: nextId("notepad"),
      revisionId: nextId("rev"),
      scope: "project",
      projectPath: OTHER_PROJECT,
      name: "Theirs",
      content: "",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-27T09:02:00.000Z",
    });

    const reachable = await repo.list({
      projectPath: PROJECT_PATH,
      includeArchived: false,
      sort: "name",
    });
    expect(reachable.map((n) => n.name)).toEqual(["Mine", "Shared"]);
  });

  it("refuses a duplicate name in the same scope and allows it in another", async () => {
    await createGlobal("Inbox");

    const duplicate = await repo.create({
      id: nextId("notepad"),
      revisionId: nextId("rev"),
      scope: "global",
      projectPath: null,
      name: "Inbox",
      content: "",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-27T09:01:00.000Z",
    });
    expect(duplicate.status).toBe("name_taken");

    const sameNameOtherScope = await repo.create({
      id: nextId("notepad"),
      revisionId: nextId("rev"),
      scope: "project",
      projectPath: PROJECT_PATH,
      name: "Inbox",
      content: "",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-27T09:02:00.000Z",
    });
    expect(sameNameOtherScope.status).toBe("created");
  });

  it("records the creating write as revision 1 with origin create", async () => {
    const notepad = await createGlobal("Fresh", { content: "seed" });
    expect(notepad.revision).toBe(1);

    const revisions = await repo.listRevisions(notepad.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.origin).toBe("create");
    expect(revisions[0]?.content).toBe("seed");
    expect(revisions[0]?.baseRevision).toBeNull();
  });
});

describe("organization and ordering", () => {
  it("persists rename, pin, archive, and unarchive", async () => {
    const notepad = await createGlobal("Before");

    const renamed = await repo.updateOrganization({
      notepadId: notepad.id,
      name: "After",
      updatedAt: "2026-08-27T10:00:00.000Z",
    });
    expect(renamed.status).toBe("updated");

    await repo.updateOrganization({
      notepadId: notepad.id,
      pinned: true,
      archived: true,
      updatedAt: "2026-08-27T10:01:00.000Z",
    });
    let reloaded = await repo.find(notepad.id);
    expect(reloaded?.name).toBe("After");
    expect(reloaded?.pinned).toBe(true);
    expect(reloaded?.archived).toBe(true);

    await repo.updateOrganization({
      notepadId: notepad.id,
      archived: false,
      updatedAt: "2026-08-27T10:02:00.000Z",
    });
    reloaded = await repo.find(notepad.id);
    expect(reloaded?.archived).toBe(false);
    expect(reloaded?.pinned).toBe(true);
  });

  it("refuses a rename onto a name already used in the same scope", async () => {
    await createGlobal("Taken");
    const other = await createGlobal("Free");

    const result = await repo.updateOrganization({
      notepadId: other.id,
      name: "Taken",
      updatedAt: "2026-08-27T10:00:00.000Z",
    });
    expect(result.status).toBe("name_taken");
    expect((await repo.find(other.id))?.name).toBe("Free");
  });

  it("hides archived notepads by default and surfaces them on request", async () => {
    const kept = await createGlobal("Kept");
    const shelved = await createGlobal("Shelved");
    await repo.updateOrganization({
      notepadId: shelved.id,
      archived: true,
      updatedAt: "2026-08-27T10:00:00.000Z",
    });

    const visible = await repo.list({
      includeArchived: false,
      sort: "name",
    });
    expect(visible.map((n) => n.id)).toEqual([kept.id]);

    const all = await repo.list({ includeArchived: true, sort: "name" });
    expect(all.map((n) => n.name)).toEqual(["Kept", "Shelved"]);
  });

  it("sorts pinned notepads first within both orderings", async () => {
    await createGlobal("Alpha", { createdAt: "2026-08-27T09:00:00.000Z" });
    await createGlobal("Beta", { createdAt: "2026-08-27T09:01:00.000Z" });
    const pinned = await createGlobal("Zulu", {
      createdAt: "2026-08-27T09:02:00.000Z",
    });
    await repo.updateOrganization({
      notepadId: pinned.id,
      pinned: true,
      updatedAt: "2026-08-27T09:03:00.000Z",
    });

    const byName = await repo.list({ includeArchived: false, sort: "name" });
    expect(byName.map((n) => n.name)).toEqual(["Zulu", "Alpha", "Beta"]);

    const byRecency = await repo.list({
      includeArchived: false,
      sort: "recency",
    });
    expect(byRecency.map((n) => n.name)).toEqual(["Zulu", "Beta", "Alpha"]);
  });

  it("orders unpinned notepads by name and by recency as requested", async () => {
    const first = await createGlobal("Charlie", {
      createdAt: "2026-08-27T09:00:00.000Z",
    });
    await createGlobal("Alpha", { createdAt: "2026-08-27T09:01:00.000Z" });
    await createGlobal("Bravo", { createdAt: "2026-08-27T09:02:00.000Z" });
    await userEdit(first.id, "touched last", "2026-08-27T11:00:00.000Z");

    expect(
      (await repo.list({ includeArchived: false, sort: "name" })).map(
        (n) => n.name,
      ),
    ).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(
      (await repo.list({ includeArchived: false, sort: "recency" })).map(
        (n) => n.name,
      ),
    ).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("deletes a notepad with its revisions and image rows", async () => {
    const notepad = await createGlobal("Doomed");
    await userEdit(notepad.id, "body", "2026-08-27T10:00:00.000Z");
    await repo.addImage(makeImage(notepad.id));

    const deleted = await repo.delete(notepad.id);
    expect(deleted?.id).toBe(notepad.id);
    expect(await repo.find(notepad.id)).toBeNull();
    expect(await repo.listRevisions(notepad.id)).toEqual([]);
    expect(await repo.listImages(notepad.id)).toEqual([]);
    expect(await repo.delete(notepad.id)).toBeNull();
  });

  it("lists the notepad ids of one project so blob cleanup can find them", async () => {
    await createGlobal("Global");
    const scoped = await repo.create({
      id: nextId("notepad"),
      revisionId: nextId("rev"),
      scope: "project",
      projectPath: PROJECT_PATH,
      name: "Scoped",
      content: "",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-27T09:01:00.000Z",
    });
    if (scoped.status !== "created") throw new Error("expected create");

    expect(await repo.listNotepadIds(PROJECT_PATH)).toEqual([
      scoped.notepad.id,
    ]);
  });
});

describe("content writes, compare-and-swap, and history", () => {
  it("advances the revision counter and snapshots every persisted write", async () => {
    const notepad = await createGlobal("Log", { content: "one" });

    const second = await userEdit(
      notepad.id,
      "two",
      "2026-08-27T10:00:00.000Z",
    );
    expect(second.status).toBe("written");
    if (second.status !== "written") return;
    expect(second.notepad.revision).toBe(2);
    expect(second.notepad.content).toBe("two");
    expect(second.notepad.updatedAt).toBe("2026-08-27T10:00:00.000Z");

    const revisions = await repo.listRevisions(notepad.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions.map((r) => r.content)).toEqual(["one", "two"]);
  });

  it("refuses an agent write stating a stale base revision and reports the current one", async () => {
    const notepad = await createGlobal("Contested", { content: "one" });
    await userEdit(notepad.id, "two", "2026-08-27T10:00:00.000Z");

    const stale = await agentEdit(
      notepad.id,
      "agent body",
      1,
      "2026-08-27T10:01:00.000Z",
    );
    expect(stale).toEqual({ status: "stale", currentRevision: 2 });
    expect((await repo.find(notepad.id))?.content).toBe("two");

    const retried = await agentEdit(
      notepad.id,
      "agent body",
      2,
      "2026-08-27T10:02:00.000Z",
    );
    expect(retried.status).toBe("written");
    expect((await repo.find(notepad.id))?.content).toBe("agent body");
  });

  it("re-reads the write mode inside the write transaction and refuses a write the current mode forbids", async () => {
    const notepad = await createGlobal("Narrowed", { content: "one" });

    // The user narrows the mode. This does NOT advance the revision, so the
    // agent's compare-and-swap token stays valid — only a mode re-read inside
    // the transaction can catch it.
    const narrowed = await repo.updateOrganization({
      notepadId: notepad.id,
      writeMode: "read-only",
      updatedAt: "2026-08-27T10:00:00.000Z",
    });
    expect(narrowed.status === "updated" && narrowed.notepad.revision).toBe(1);

    const refused = await agentEdit(
      notepad.id,
      "agent body",
      1,
      "2026-08-27T10:01:00.000Z",
    );

    expect(refused).toEqual({
      status: "write_mode_refused",
      writeMode: "read-only",
    });
    expect((await repo.find(notepad.id))?.content).toBe("one");
    expect(await repo.listRevisions(notepad.id)).toHaveLength(1);
  });

  it("permits a write whose operation the current mode still allows", async () => {
    const notepad = await createGlobal("Narrowed to append", {
      content: "one",
    });
    await repo.updateOrganization({
      notepadId: notepad.id,
      writeMode: "append-only",
      updatedAt: "2026-08-27T10:00:00.000Z",
    });

    const appended = await agentEdit(
      notepad.id,
      "agent line",
      1,
      "2026-08-27T10:01:00.000Z",
      "append",
    );

    expect(appended.status).toBe("written");
    expect((await repo.find(notepad.id))?.content).toContain("agent line");
  });

  it("never refuses a user write for staleness and keeps both racers in history", async () => {
    const notepad = await createGlobal("Raced", { content: "base" });
    const agentWrite = await agentEdit(
      notepad.id,
      "agent draft",
      1,
      "2026-08-27T10:00:00.000Z",
    );
    expect(agentWrite.status).toBe("written");

    // The user's editor still holds revision 1 when their autosave lands.
    const userWrite = await userEdit(
      notepad.id,
      "user typing",
      "2026-08-27T10:00:01.000Z",
    );
    expect(userWrite.status).toBe("written");

    const revisions = await repo.listRevisions(notepad.id);
    expect(revisions.map((r) => r.content)).toEqual([
      "base",
      "agent draft",
      "user typing",
    ]);
  });

  it("attributes each revision to its author and names the writing conversation", async () => {
    const notepad = await createGlobal("Attributed", { content: "start" });
    await userEdit(notepad.id, "by hand", "2026-08-27T10:00:00.000Z");
    await agentEdit(notepad.id, "by agent", 2, "2026-08-27T10:01:00.000Z");

    const revisions = await repo.listRevisions(notepad.id);
    expect(
      revisions.map((r) => [r.authorKind, r.authorConversationId]),
    ).toEqual([
      ["user", null],
      ["user", null],
      ["agent", "conv-writer"],
    ]);
  });

  it("appends under the same compare-and-swap, composing content with a blank line", async () => {
    const notepad = await createGlobal("Growing", { content: "first" });

    const appended = await agentEdit(
      notepad.id,
      "second",
      1,
      "2026-08-27T10:00:00.000Z",
      "append",
    );
    expect(appended.status).toBe("written");
    if (appended.status !== "written") return;
    expect(appended.notepad.content).toBe("first\n\nsecond");

    const revisions = await repo.listRevisions(notepad.id);
    expect(revisions[1]?.origin).toBe("append");
    expect(revisions[1]?.baseRevision).toBe(1);
  });

  it("appends without a leading separator when the notepad is empty", async () => {
    const notepad = await createGlobal("Empty");
    const appended = await agentEdit(
      notepad.id,
      "first words",
      1,
      "2026-08-27T10:00:00.000Z",
      "append",
    );
    if (appended.status !== "written") throw new Error("expected a write");
    expect(appended.notepad.content).toBe("first words");
  });

  it("records a restore as a new revision naming the revision it came from", async () => {
    const notepad = await createGlobal("Restorable", { content: "original" });
    await userEdit(notepad.id, "replaced", "2026-08-27T10:00:00.000Z");

    const source = await repo.findRevision(notepad.id, 1);
    expect(source?.content).toBe("original");

    const restored = await repo.writeContent({
      notepadId: notepad.id,
      revisionId: nextId("rev"),
      operation: "restore",
      content: source?.content ?? "",
      authorKind: "user",
      authorConversationId: null,
      baseRevision: null,
      enforceBaseRevision: false,
      permittedWriteModes: null,
      restoredFromRevision: 1,
      writtenAt: "2026-08-27T10:01:00.000Z",
      coalesceWindowMs: null,
    });
    expect(restored.status).toBe("written");
    if (restored.status !== "written") return;
    expect(restored.notepad.content).toBe("original");
    expect(restored.notepad.revision).toBe(3);

    const revisions = await repo.listRevisions(notepad.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(revisions[2]?.origin).toBe("restore");
    expect(revisions[2]?.restoredFromRevision).toBe(1);
    // The earlier history is untouched.
    expect(revisions[0]?.content).toBe("original");
    expect(revisions[1]?.content).toBe("replaced");
  });

  it("reports a missing notepad rather than inventing one", async () => {
    const result = await userEdit(
      "notepad-that-never-existed",
      "body",
      "2026-08-27T10:00:00.000Z",
    );
    expect(result).toEqual({ status: "missing" });
    expect(
      await repo.updateOrganization({
        notepadId: "notepad-that-never-existed",
        name: "nope",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }),
    ).toEqual({ status: "missing" });
  });
});

function makeImage(
  notepadId: string,
  overrides: Partial<NotepadImage> = {},
): NotepadImage {
  idSeq += 1;
  const id = `image-${idSeq}`;
  return notepadImageSchema.parse({
    id,
    notepadId,
    fileName: "screenshot.png",
    mediaType: "image/png",
    sizeBytes: 2048,
    sha256: "deadbeefcafef00d",
    snapshotKey: `${notepadId}/${id}/screenshot.png`,
    createdAt: "2026-08-27T09:30:00.000Z",
    ...overrides,
  });
}

describe("image metadata", () => {
  it("stores, finds, lists, and deletes image rows per notepad", async () => {
    const notepad = await createGlobal("Illustrated");
    const image = await repo.addImage(makeImage(notepad.id));

    expect(await repo.findImage(notepad.id, image.id)).toEqual(image);
    expect(await repo.listImages(notepad.id)).toEqual([image]);

    const deleted = await repo.deleteImage(notepad.id, image.id);
    expect(deleted).toEqual(image);
    expect(await repo.findImage(notepad.id, image.id)).toBeNull();
    expect(await repo.deleteImage(notepad.id, image.id)).toBeNull();
  });

  it("does not resolve an image through a different notepad's id", async () => {
    const owner = await createGlobal("Owner");
    const other = await createGlobal("Other");
    const image = await repo.addImage(makeImage(owner.id));

    expect(await repo.findImage(other.id, image.id)).toBeNull();
  });
});

describe("durability contracts", () => {
  it("round-trips every persisted notepad key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "notepads",
      schema: notepadSchema,
      buildMaximalFixture: () =>
        notepadSchema.parse({
          id: "notepad-maximal",
          scope: "project",
          projectPath: PROJECT_PATH,
          name: "A maximal durability fixture",
          content: '# Heading\n\n<ticket-ref ticket-id="t-1" />\n',
          revision: 2,
          writeMode: "append-only",
          pinned: true,
          archived: true,
          createdAt: "2026-02-15T08:09:10.000Z",
          updatedAt: "2026-03-16T09:10:11.000Z",
        }),
      persist: async (fixture) => {
        const created = await repo.create({
          id: fixture.id,
          revisionId: "notepad-maximal-rev-1",
          scope: fixture.scope,
          projectPath: fixture.projectPath,
          name: fixture.name,
          content: "seed",
          writeMode: fixture.writeMode,
          authorKind: "user",
          authorConversationId: null,
          createdAt: fixture.createdAt,
        });
        if (created.status !== "created") {
          throw new Error(`create failed: ${created.status}`);
        }
        const written = await repo.writeContent({
          notepadId: fixture.id,
          revisionId: "notepad-maximal-rev-2",
          operation: "update",
          content: fixture.content,
          authorKind: "user",
          authorConversationId: null,
          baseRevision: null,
          enforceBaseRevision: false,
          permittedWriteModes: null,
          restoredFromRevision: null,
          writtenAt: "2026-03-16T09:10:10.000Z",
          coalesceWindowMs: null,
        });
        if (written.status !== "written") {
          throw new Error(`write failed: ${written.status}`);
        }
        const organized = await repo.updateOrganization({
          notepadId: fixture.id,
          pinned: fixture.pinned,
          archived: fixture.archived,
          updatedAt: fixture.updatedAt,
        });
        if (organized.status !== "updated") {
          throw new Error(`organize failed: ${organized.status}`);
        }
        return organized.notepad;
      },
      reload: (expected) => repo.find(expected.id),
      // Every field maps to a dedicated NOT NULL column (project_path nullable
      // by scope); the repo allocates `revision` inside its write transaction.
      fieldPolicies: { revision: "derived-on-write" },
    });
  });

  it("round-trips every persisted revision key path through the real repo", async () => {
    const notepad = await createGlobal("History", { content: "original" });
    await userEdit(notepad.id, "replaced", "2026-08-27T10:00:00.000Z");

    await assertRoundTripDurability({
      label: "notepad-revisions",
      schema: notepadRevisionSchema,
      buildMaximalFixture: () =>
        notepadRevisionSchema.parse({
          id: "revision-maximal",
          notepadId: notepad.id,
          revision: 3,
          content: "original",
          authorKind: "agent",
          authorConversationId: "conv-restorer",
          origin: "restore",
          baseRevision: 2,
          restoredFromRevision: 1,
          createdAt: "2026-03-16T09:10:11.000Z",
        }),
      persist: async (fixture) => {
        const written = await repo.writeContent({
          notepadId: fixture.notepadId,
          revisionId: fixture.id,
          operation: "restore",
          content: fixture.content,
          authorKind: fixture.authorKind,
          authorConversationId: fixture.authorConversationId,
          baseRevision: fixture.baseRevision,
          enforceBaseRevision: true,
          permittedWriteModes: ["full-edit"],
          restoredFromRevision: fixture.restoredFromRevision,
          writtenAt: fixture.createdAt,
          coalesceWindowMs: null,
        });
        if (written.status !== "written") {
          throw new Error(`restore failed: ${written.status}`);
        }
        return written.revision;
      },
      reload: async (expected) =>
        repo.findRevision(expected.notepadId, expected.revision),
      // The repo allocates the revision number inside its write transaction.
      fieldPolicies: { revision: "derived-on-write" },
    });
  });

  it("round-trips every persisted image key path through the real repo", async () => {
    const notepad = await createGlobal("Gallery");
    await assertRoundTripDurability({
      label: "notepad-images",
      schema: notepadImageSchema,
      buildMaximalFixture: () =>
        notepadImageSchema.parse({
          id: "image-maximal",
          notepadId: notepad.id,
          fileName: "design review.png",
          mediaType: "image/png",
          sizeBytes: 40960,
          sha256: "deadbeefcafef00d",
          snapshotKey: `${notepad.id}/image-maximal/design review.png`,
          createdAt: "2026-03-16T09:10:11.000Z",
        }),
      persist: (fixture) => repo.addImage(fixture),
      reload: (expected) => repo.findImage(expected.notepadId, expected.id),
      fieldPolicies: {},
    });
  });
});
