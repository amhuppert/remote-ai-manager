import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import {
  MEMORY_BODY_MAX_BYTES,
  memoryLinkSchema,
  memoryNoteRevisionSchema,
  memoryNoteSchema,
  type MemoryLink,
  type MemoryNote,
} from "@/lib/memory/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { captureStoreInventory } from "@/lib/shared/testing/store-inventory";
import { createProjectsRepo } from "./projects-repo";
import {
  createMemoryRepo,
  type AddMemoryLinkResult,
  type CreateMemoryNoteInput,
  type MemoryNoteListQuery,
  type MemoryRepo,
} from "./memory-repo";
import { _createTestDb } from "./state-db";
import { createWriteQueue, type WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT = "/repos/other";
const INCARNATION = {
  sessionName: "memory-spike",
  sessionCreatedAt: "2026-09-01T08:00:00.000Z",
};
/** The same session NAME, created later: a different incarnation entirely. */
const LATER_INCARNATION = {
  sessionName: "memory-spike",
  sessionCreatedAt: "2026-09-02T08:00:00.000Z",
};

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-01T11:00:00.000Z";
const T3 = "2026-09-01T12:00:00.000Z";
const T4 = "2026-09-01T13:00:00.000Z";

/** A leased status line: the perishable half of a durable capture. */
const STATUS_NOTE = {
  text: "ticket-74 work still unmerged",
  updatedAt: T1,
  reviewAfter: "2026-09-15T10:00:00.000Z",
};

let db: Db;
let queue: WriteQueue;
let memory: MemoryRepo;
let idSeq = 0;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  queue = createWriteQueue();
  memory = createMemoryRepo(db, queue);
  const projects = createProjectsRepo(db);
  projects.upsert({ rootPath: PROJECT_PATH });
  projects.upsert({ rootPath: OTHER_PROJECT });
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
function reader(): MemoryRepo {
  return createMemoryRepo(db, queue);
}

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function createInput(
  overrides: Partial<CreateMemoryNoteInput> = {},
): CreateMemoryNoteInput {
  return {
    id: nextId("mem"),
    revisionId: nextId("rev"),
    slug: "fts-is-derived",
    scope: "project",
    projectPath: PROJECT_PATH,
    sessionName: null,
    sessionCreatedAt: null,
    kind: "lesson",
    hook: "The FTS5 index is derived state rebuilt from the note rows",
    body: "A rebuild repopulates the index from `memory_notes`.",
    statusNote: null,
    aliases: [],
    indexMode: "auto",
    lifecycle: "active",
    reviewAfter: null,
    expiresAt: null,
    createdBy: "user",
    authorConversationId: null,
    supersedes: null,
    createdAt: T1,
    ...overrides,
  };
}

async function createNote(
  overrides: Partial<CreateMemoryNoteInput> = {},
): Promise<MemoryNote> {
  const created = await memory.create(createInput(overrides));
  if (created.status !== "created") {
    throw new Error(`expected create to succeed, got ${created.status}`);
  }
  return created.note;
}

function linked(result: AddMemoryLinkResult): MemoryLink {
  if (result.status !== "linked") {
    throw new Error(`expected the link to land, got ${result.status}`);
  }
  return result.link;
}

function visibility(query: Partial<MemoryNoteListQuery> = {}) {
  return {
    visibility: { projectPath: PROJECT_PATH, session: null },
    includeArchived: false,
    ...query,
  } satisfies MemoryNoteListQuery;
}

describe("creating a memory note", () => {
  it("reloads every field through a second repo instance", async () => {
    const note = await createNote({
      slug: "ticket88-cursor-darwin-status",
      aliases: ["cursor-darwin", "evidenced-hosts"],
      statusNote: {
        text: "ticket-88 work still unmerged",
        updatedAt: "2026-08-30T12:00:00.000Z",
        reviewAfter: "2026-09-13T12:00:00.000Z",
      },
      indexMode: "always",
      lifecycle: "proposed",
      createdBy: "agent",
      authorConversationId: "conversation-7",
    });

    expect(await reader().find(note.id)).toEqual(note);
    expect(note.revision).toBe(1);
    expect(note.aliases).toEqual(["cursor-darwin", "evidenced-hosts"]);
  });

  it("appends the creating snapshot as revision 1", async () => {
    const note = await createNote();

    const revisions = await reader().listRevisions(note.id);

    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.origin).toBe("create");
    expect(revisions[0]?.baseRevision).toBeNull();
    expect(revisions[0]?.snapshot).toEqual(note);
  });

  it("refuses a body over the 8 KiB cap, naming the limit, and persists nothing", async () => {
    const before = captureStoreInventory(db);

    const refused = await memory.create(
      createInput({ body: "x".repeat(MEMORY_BODY_MAX_BYTES + 1) }),
    );

    expect(refused).toEqual({
      status: "body_too_large",
      limitBytes: MEMORY_BODY_MAX_BYTES,
      actualBytes: MEMORY_BODY_MAX_BYTES + 1,
    });
    expect(captureStoreInventory(db)).toEqual(before);
  });

  it("refuses a slug already held by an active note in the same scope owner", async () => {
    await createNote({ slug: "shared-slug" });

    const refused = await memory.create(createInput({ slug: "shared-slug" }));

    expect(refused).toEqual({ status: "slug_taken", slug: "shared-slug" });
  });

  it("allows the same slug in a different scope", async () => {
    await createNote({ slug: "shared-slug" });

    const globalNote = await createNote({
      slug: "shared-slug",
      scope: "global",
      projectPath: null,
    });

    expect(globalNote.scope).toBe("global");
  });
});

describe("compare-and-swap updates", () => {
  it("refuses a write stating a stale revision, naming the current one", async () => {
    const note = await createNote();
    const winner = await memory.update({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: 1,
      patch: { hook: "The winning edit" },
      authorKind: "user",
      authorConversationId: null,
      writtenAt: T2,
    });
    expect(winner.status).toBe("written");
    const afterWinner = captureStoreInventory(db);

    const loser = await memory.update({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: 1,
      patch: { hook: "The losing edit" },
      authorKind: "agent",
      authorConversationId: "conversation-9",
      writtenAt: T3,
    });

    expect(loser).toEqual({ status: "stale", currentRevision: 2 });
    // The refused payload reached no statement at all.
    expect(captureStoreInventory(db)).toEqual(afterWinner);
    expect((await reader().find(note.id))?.hook).toBe("The winning edit");
  });

  it("keeps the winning revision and every prior snapshot readable", async () => {
    const note = await createNote({ hook: "Revision one" });
    await memory.update({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: 1,
      patch: { hook: "Revision two", body: "Rewritten body" },
      authorKind: "user",
      authorConversationId: null,
      writtenAt: T2,
    });

    const revisions = await reader().listRevisions(note.id);

    expect(revisions.map((entry) => entry.revision)).toEqual([1, 2]);
    expect(revisions[0]?.snapshot.hook).toBe("Revision one");
    expect(revisions[1]?.snapshot.hook).toBe("Revision two");
    expect(revisions[1]?.baseRevision).toBe(1);
    expect((await reader().find(note.id))?.revision).toBe(2);
  });

  it("refuses an oversized body on update and leaves the head untouched", async () => {
    const note = await createNote();

    const refused = await memory.update({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: 1,
      patch: { body: "x".repeat(MEMORY_BODY_MAX_BYTES + 5) },
      authorKind: "user",
      authorConversationId: null,
      writtenAt: T2,
    });

    expect(refused).toEqual({
      status: "body_too_large",
      limitBytes: MEMORY_BODY_MAX_BYTES,
      actualBytes: MEMORY_BODY_MAX_BYTES + 5,
    });
    expect(await reader().find(note.id)).toEqual(note);
  });

  it("copies an old snapshot forward as a new head on restore", async () => {
    const note = await createNote({ hook: "Original hook" });
    await memory.update({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: 1,
      patch: { hook: "Replaced hook" },
      authorKind: "user",
      authorConversationId: null,
      writtenAt: T2,
    });

    const restored = await memory.restore({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: 2,
      restoreFromRevision: 1,
      authorKind: "user",
      authorConversationId: null,
      writtenAt: T3,
    });

    expect(restored.status).toBe("written");
    const head = await reader().find(note.id);
    expect(head?.hook).toBe("Original hook");
    // Forward, never rewound: the compare-and-swap token keeps advancing.
    expect(head?.revision).toBe(3);
    const revisions = await reader().listRevisions(note.id);
    expect(revisions.map((entry) => entry.revision)).toEqual([1, 2, 3]);
    expect(revisions[2]?.origin).toBe("restore");
    expect(revisions[2]?.restoredFromRevision).toBe(1);
  });

  it("refuses a restore from a revision that never existed", async () => {
    const note = await createNote();

    expect(
      await memory.restore({
        memoryId: note.id,
        revisionId: nextId("rev"),
        baseRevision: 1,
        restoreFromRevision: 9,
        authorKind: "user",
        authorConversationId: null,
        writtenAt: T2,
      }),
    ).toEqual({ status: "revision_missing", revision: 9 });
  });
});

describe("supersession", () => {
  async function supersede(): Promise<{
    predecessor: MemoryNote;
    successor: MemoryNote;
  }> {
    const predecessor = await createNote({ slug: "the-lesson" });
    const successor = await createNote({
      slug: "the-lesson",
      hook: "The corrected lesson",
      createdAt: T2,
      supersedes: {
        memoryId: predecessor.id,
        archiveRevisionId: nextId("rev"),
        baseRevision: null,
      },
    });
    return { predecessor, successor };
  }

  it("archives the predecessor in the same transaction and links both ends", async () => {
    const { predecessor, successor } = await supersede();

    const archived = await reader().find(predecessor.id);
    expect(archived?.lifecycle).toBe("archived");
    expect(archived?.supersededById).toBe(successor.id);
    expect(successor.supersedesId).toBe(predecessor.id);
  });

  it("excludes the superseded note from default reads while keeping it fetchable", async () => {
    const { predecessor, successor } = await supersede();

    const listed = await reader().list(visibility());
    expect(listed.map((note) => note.id)).toEqual([successor.id]);

    // A bare slug resolves the successor only; the archived predecessor is
    // addressed through the explicit archived read.
    expect(
      (await reader().findByHandle("the-lesson", visibility())).map(
        (note) => note.id,
      ),
    ).toEqual([successor.id]);
    expect(
      (await reader().list(visibility({ includeArchived: true }))).map(
        (note) => note.id,
      ),
    ).toEqual(expect.arrayContaining([predecessor.id, successor.id]));
    expect(await reader().find(predecessor.id)).not.toBeNull();
  });

  it("records the predecessor's archival as its own snapshot", async () => {
    const { predecessor } = await supersede();

    const revisions = await reader().listRevisions(predecessor.id);

    expect(revisions.map((entry) => entry.origin)).toEqual([
      "create",
      "archive",
    ]);
    expect(revisions[1]?.snapshot.lifecycle).toBe("archived");
    expect(revisions[1]?.snapshot.supersededById).not.toBeNull();
  });

  it("refuses a slug collision without retiring the predecessor it would have superseded", async () => {
    const holder = await createNote({ slug: "held-slug" });
    const predecessor = await createNote({ slug: "about-to-be-replaced" });
    const before = captureStoreInventory(db);

    const refused = await memory.create(
      createInput({
        slug: "held-slug",
        createdAt: T2,
        supersedes: {
          memoryId: predecessor.id,
          archiveRevisionId: nextId("rev"),
          baseRevision: null,
        },
      }),
    );

    expect(refused).toEqual({ status: "slug_taken", slug: "held-slug" });
    // A refusal returns from the transaction, which commits: an archive
    // written before the check would have retired a note and created nothing.
    expect(captureStoreInventory(db)).toEqual(before);
    expect((await reader().find(predecessor.id))?.lifecycle).toBe("active");
    expect((await reader().find(holder.id))?.lifecycle).toBe("active");
  });

  it("refuses a supersedes reference to a note that does not exist, persisting nothing", async () => {
    const before = captureStoreInventory(db);

    const refused = await memory.create(
      createInput({
        supersedes: {
          memoryId: "mem-absent",
          archiveRevisionId: "rev-absent",
          baseRevision: null,
        },
      }),
    );

    expect(refused).toEqual({
      status: "supersedes_missing",
      memoryId: "mem-absent",
    });
    expect(captureStoreInventory(db)).toEqual(before);
  });
});

describe("session incarnation scoping", () => {
  async function sessionNote(): Promise<MemoryNote> {
    return createNote({
      slug: "worktree-detail",
      scope: "session",
      ...INCARNATION,
      kind: "state",
    });
  }

  it("delivers a session note to its own incarnation", async () => {
    const note = await sessionNote();

    const listed = await reader().list(
      visibility({
        visibility: { projectPath: PROJECT_PATH, session: INCARNATION },
      }),
    );

    expect(listed.map((entry) => entry.id)).toContain(note.id);
  });

  it("hides it from a later session that reuses the name", async () => {
    await sessionNote();

    const listed = await reader().list(
      visibility({
        visibility: { projectPath: PROJECT_PATH, session: LATER_INCARNATION },
      }),
    );
    const resolved = await reader().findByHandle(
      "worktree-detail",
      visibility({
        visibility: { projectPath: PROJECT_PATH, session: LATER_INCARNATION },
      }),
    );

    expect(listed).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it("hides it from a project conversation in the same project", async () => {
    await sessionNote();
    const projectNote = await createNote({ slug: "project-lesson" });
    const globalNote = await createNote({
      slug: "global-lesson",
      scope: "global",
      projectPath: null,
    });

    const listed = await reader().list(visibility());

    expect(listed.map((entry) => entry.id).sort()).toEqual(
      [projectNote.id, globalNote.id].sort(),
    );
  });

  it("hides another project's notes entirely", async () => {
    await createNote({ slug: "project-lesson" });

    const listed = await reader().list(
      visibility({ visibility: { projectPath: OTHER_PROJECT, session: null } }),
    );

    expect(listed).toEqual([]);
  });

  it("resolves a note by an alias as well as by its slug", async () => {
    const note = await createNote({
      slug: "notepad-feature-roadmap",
      aliases: ["notebook"],
    });

    expect(
      (await reader().findByHandle("notebook", visibility())).map(
        (entry) => entry.id,
      ),
    ).toEqual([note.id]);
  });
});

describe("typed artifact links", () => {
  it("persists an about link and a source link to the same artifact side by side", async () => {
    const note = await createNote({ statusNote: STATUS_NOTE });

    const about = linked(
      await memory.addLink({
        id: "link-about",
        memoryId: note.id,
        kind: "about",
        artifact: { kind: "ticket", ticketId: "ticket-74" },
        createdAt: T2,
      }),
    );
    const source = linked(
      await memory.addLink({
        id: "link-source",
        memoryId: note.id,
        kind: "source",
        artifact: { kind: "ticket", ticketId: "ticket-74" },
        createdAt: T3,
      }),
    );

    expect(await reader().listLinks(note.id)).toEqual([about, source]);
  });

  it("re-links the same note, kind, and artifact onto the one existing row", async () => {
    const note = await createNote({ statusNote: STATUS_NOTE });
    const first = linked(
      await memory.addLink({
        id: "link-1",
        memoryId: note.id,
        kind: "about",
        artifact: { kind: "ticket", ticketId: "ticket-74" },
        createdAt: T2,
      }),
    );

    const again = linked(
      await memory.addLink({
        id: "link-2",
        memoryId: note.id,
        kind: "about",
        artifact: { kind: "ticket", ticketId: "ticket-74" },
        createdAt: T3,
      }),
    );

    expect(again).toEqual(first);
    expect(await reader().listLinks(note.id)).toEqual([first]);
  });

  it("keeps every link when the write clears the status line", async () => {
    const note = await createNote({ statusNote: STATUS_NOTE });
    const about = linked(
      await memory.addLink({
        id: "link-about",
        memoryId: note.id,
        kind: "about",
        artifact: { kind: "ticket", ticketId: "ticket-74" },
        createdAt: T2,
      }),
    );

    const cleared = await memory.update({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: note.revision,
      patch: { statusNote: null },
      authorKind: "user",
      authorConversationId: null,
      writtenAt: T3,
    });

    expect(cleared.status).toBe("written");
    expect(await reader().listLinks(note.id)).toEqual([about]);
  });

  it("finds every note linked to one artifact", async () => {
    const first = await createNote({ slug: "first" });
    const second = await createNote({ slug: "second" });
    for (const [id, memoryId] of [
      ["link-1", first.id],
      ["link-2", second.id],
    ] as const) {
      linked(
        await memory.addLink({
          id,
          memoryId,
          kind: "about",
          artifact: { kind: "ticket", ticketId: "ticket-74" },
          createdAt: T2,
        }),
      );
    }

    const found = await reader().listLinksForArtifact({
      kind: "ticket",
      ticketId: "ticket-74",
    });

    expect(found.map((link) => link.memoryId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("persists a workflow-context link distinctly from its execution-wide sibling", async () => {
    // One note, three about-links into one run: the whole execution and two of
    // its contexts. A context reference shares the execution's row identity
    // plus the context id, so the three must coexist and resolve separately.
    const note = await createNote({ slug: "run-lessons" });
    const execution = {
      kind: "workflow_execution",
      executionId: "exec-1",
    } as const;
    const contextA = {
      kind: "workflow_context",
      executionId: "exec-1",
      contextId: "ctx-a",
    } as const;
    const contextB = {
      kind: "workflow_context",
      executionId: "exec-1",
      contextId: "ctx-b",
    } as const;
    // Ids sort in insertion order: a note's links list by created_at then id.
    for (const [id, artifact] of [
      ["link-1-exec", execution],
      ["link-2-ctx-a", contextA],
      ["link-3-ctx-b", contextB],
    ] as const) {
      linked(
        await memory.addLink({
          id,
          memoryId: note.id,
          kind: "about",
          artifact,
          createdAt: T2,
        }),
      );
    }

    const reloaded = await reader().listLinks(note.id);
    expect(reloaded.map((link) => link.artifact)).toEqual([
      execution,
      contextA,
      contextB,
    ]);
    expect(
      (await reader().listLinksForArtifact(contextA)).map((link) => link.id),
    ).toEqual(["link-2-ctx-a"]);
    expect(
      (await reader().listLinksForArtifact(execution)).map((link) => link.id),
    ).toEqual(["link-1-exec"]);
  });

  it("removes a link and cascades every child row on delete", async () => {
    const note = await createNote({ aliases: ["an-alias"] });
    linked(
      await memory.addLink({
        id: "link-1",
        memoryId: note.id,
        kind: "source",
        artifact: { kind: "spec", specId: "spec-memory" },
        createdAt: T2,
      }),
    );

    expect((await memory.removeLink("link-1"))?.id).toBe("link-1");
    expect(await reader().listLinks(note.id)).toEqual([]);

    expect((await memory.delete(note.id))?.id).toBe(note.id);
    expect(await reader().find(note.id)).toBeNull();
    expect(await reader().listRevisions(note.id)).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM memory_note_aliases").get() as {
        count: number;
      },
    ).toEqual({ count: 0 });
  });
});

describe("round-trip durability", () => {
  const MAXIMAL_ID = "mem-maximal";
  const ANCESTOR_ID = "mem-ancestor";
  const SUCCESSOR_ID = "mem-successor";

  function maximalNote(): MemoryNote {
    return memoryNoteSchema.parse({
      id: MAXIMAL_ID,
      slug: "maximal-note",
      scope: "session",
      projectPath: PROJECT_PATH,
      ...INCARNATION,
      kind: "lesson",
      hook: "Superseding a note archives its predecessor in one transaction",
      body: "The predecessor keeps its history and names its successor.",
      statusNote: {
        text: "the successor landed on 2026-09-01",
        updatedAt: "2026-08-30T12:00:00.000Z",
        reviewAfter: "2026-09-13T12:00:00.000Z",
      },
      aliases: ["maximal-alias", "second-alias"],
      indexMode: "always",
      lifecycle: "archived",
      reviewAfter: "2026-09-20T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      supersedesId: ANCESTOR_ID,
      supersededById: SUCCESSOR_ID,
      createdBy: "agent",
      authorConversationId: "conversation-7",
      revision: 3,
      createdAt: T1,
      updatedAt: T3,
    });
  }

  /**
   * Drive the maximal note to its final shape through the ordinary verbs:
   * created superseding an ancestor, edited into its maximal content, then
   * superseded in turn. Every repo-owned field (revision, updatedAt, both
   * supersession pointers) therefore holds a value the write path derived
   * rather than one the fixture handed it.
   */
  async function seedMaximalLineage(target: MemoryNote): Promise<void> {
    await createNote({
      id: ANCESTOR_ID,
      slug: "ancestor-note",
      scope: "session",
      ...INCARNATION,
      createdAt: "2026-09-01T09:00:00.000Z",
    });
    const created = await memory.create(
      createInput({
        id: target.id,
        slug: target.slug,
        scope: "session",
        projectPath: PROJECT_PATH,
        ...INCARNATION,
        kind: target.kind,
        hook: "The first hook",
        body: "The first body.",
        statusNote: null,
        aliases: [],
        indexMode: "auto",
        lifecycle: "proposed",
        reviewAfter: null,
        expiresAt: null,
        createdBy: target.createdBy,
        authorConversationId: target.authorConversationId,
        supersedes: {
          memoryId: ANCESTOR_ID,
          archiveRevisionId: "rev-ancestor-archive",
          baseRevision: null,
        },
        createdAt: T1,
      }),
    );
    if (created.status !== "created") {
      throw new Error(`expected create to succeed, got ${created.status}`);
    }

    const edited = await memory.update({
      memoryId: target.id,
      revisionId: "rev-maximal-2",
      baseRevision: 1,
      patch: {
        hook: target.hook,
        body: target.body,
        statusNote: target.statusNote,
        aliases: target.aliases,
        indexMode: target.indexMode,
        lifecycle: "active",
        reviewAfter: target.reviewAfter,
        expiresAt: target.expiresAt,
      },
      authorKind: "agent",
      authorConversationId: target.authorConversationId,
      writtenAt: T2,
    });
    if (edited.status !== "written") {
      throw new Error(`expected the edit to persist, got ${edited.status}`);
    }

    const superseded = await memory.create(
      createInput({
        id: SUCCESSOR_ID,
        slug: "successor-note",
        scope: "session",
        projectPath: PROJECT_PATH,
        ...INCARNATION,
        supersedes: {
          memoryId: target.id,
          archiveRevisionId: "rev-maximal-3",
          baseRevision: null,
        },
        createdAt: T3,
      }),
    );
    if (superseded.status !== "created") {
      throw new Error(`expected the successor, got ${superseded.status}`);
    }
  }

  it("preserves every persisted note field across a reload", async () => {
    await assertRoundTripDurability({
      label: "memory-notes",
      schema: memoryNoteSchema,
      buildMaximalFixture: maximalNote,
      persist: async (fixture) => {
        await seedMaximalLineage(fixture);
        return fixture;
      },
      reload: async (expected) => reader().find(expected.id),
    });
  });

  it("preserves every persisted revision field across a reload", async () => {
    const restoredHead: MemoryNote = {
      ...maximalNote(),
      // The revision-2 snapshot the restore copies forward was still active.
      lifecycle: "active",
      revision: 4,
      updatedAt: T4,
    };

    await assertRoundTripDurability({
      label: "memory-note-revisions",
      schema: memoryNoteRevisionSchema,
      buildMaximalFixture: () =>
        memoryNoteRevisionSchema.parse({
          id: "rev-maximal-4",
          memoryId: MAXIMAL_ID,
          revision: 4,
          snapshot: restoredHead,
          origin: "restore",
          baseRevision: 3,
          restoredFromRevision: 2,
          authorKind: "user",
          authorConversationId: "conversation-9",
          createdAt: T4,
        }),
      persist: async (fixture) => {
        await seedMaximalLineage(maximalNote());
        const restored = await memory.restore({
          memoryId: fixture.memoryId,
          revisionId: fixture.id,
          baseRevision: 3,
          restoreFromRevision: 2,
          authorKind: fixture.authorKind,
          authorConversationId: fixture.authorConversationId,
          writtenAt: T4,
        });
        if (restored.status !== "written") {
          throw new Error(`expected the restore, got ${restored.status}`);
        }
        return fixture;
      },
      reload: async (expected) =>
        reader().findRevision(expected.memoryId, expected.revision),
    });
  });

  it("preserves every persisted link field across a reload", async () => {
    const note = await createNote({ statusNote: STATUS_NOTE });

    await assertRoundTripDurability({
      label: "memory-links",
      schema: memoryLinkSchema,
      buildMaximalFixture: () =>
        memoryLinkSchema.parse({
          id: "link-maximal",
          memoryId: note.id,
          kind: "about",
          artifact: {
            kind: "session",
            projectPath: PROJECT_PATH,
            ...INCARNATION,
          },
          createdAt: T4,
        }),
      persist: async (fixture) => linked(await memory.addLink(fixture)),
      reload: async (expected) =>
        (await reader().listLinks(expected.memoryId))[0] ?? null,
    });
  });
});
