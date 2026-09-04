import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { createProjectsRepo } from "./projects-repo";
import {
  createMemoryRepo,
  type CreateMemoryNoteInput,
  type MemoryNoteListQuery,
  type MemoryRepo,
} from "./memory-repo";
import { _createTestDb, truncateAllTables } from "./state-db";
import { createWriteQueue, type WriteQueue } from "./write-queue";
import type { MemoryNote } from "@/lib/memory/schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-01T11:00:00.000Z";

let db: Db;
let queue: WriteQueue;
let memory: MemoryRepo;
let idSeq = 0;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  queue = createWriteQueue();
  memory = createMemoryRepo(db, queue);
  createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
  idSeq = 0;
});

afterEach(() => {
  db.close();
});

function reader(): MemoryRepo {
  return createMemoryRepo(db, queue);
}

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

async function createNote(
  overrides: Partial<CreateMemoryNoteInput> = {},
): Promise<MemoryNote> {
  const created = await memory.create({
    id: nextId("mem"),
    revisionId: nextId("rev"),
    slug: "vitest-ontaskupdate-timeout",
    scope: "project",
    projectPath: PROJECT_PATH,
    sessionName: null,
    sessionCreatedAt: null,
    kind: "lesson",
    hook: "Zero failures plus an onTaskUpdate timeout means swap thrash",
    body: "Check sysctl vm.swapusage before hunting a branch defect.",
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
  });
  if (created.status !== "created") {
    throw new Error(`expected create to succeed, got ${created.status}`);
  }
  return created.note;
}

const VISIBILITY: MemoryNoteListQuery = {
  visibility: { projectPath: PROJECT_PATH, session: null },
  includeArchived: false,
};

async function searchIds(query: string): Promise<string[]> {
  return (await reader().search(query, VISIBILITY)).map((hit) => hit.note.id);
}

describe("the FTS5 runtime", () => {
  it("reports ENABLE_FTS5, so a missing compile option fails loudly here", () => {
    const options = (
      db.prepare("PRAGMA compile_options").all() as Array<{
        compile_options: string;
      }>
    ).map((row) => row.compile_options);

    expect(options).toContain("ENABLE_FTS5");
  });
});

describe("searching the derived index", () => {
  it("finds a note written moments earlier, with no rebuild in between", async () => {
    const note = await createNote();

    expect(await searchIds("onTaskUpdate")).toEqual([note.id]);
  });

  it("matches the hook, the body, the slug, and an alias", async () => {
    const note = await createNote({
      slug: "notepad-feature-roadmap",
      aliases: ["notebook"],
      hook: "The feature is named Notepad, never Notebook",
      body: "Slices one and two merged; address their code by path.",
    });

    for (const query of [
      "notepad-feature-roadmap",
      "notebook",
      "Notepad",
      "slices",
    ]) {
      expect(await searchIds(query), `query: ${query}`).toEqual([note.id]);
    }
  });

  it("stems, so a search for the root finds the inflected prose", async () => {
    const note = await createNote({
      slug: "turbopack-cache",
      hook: "An unpruned Turbopack cache balloons the build",
      body: "The build was running on one core for the whole hour.",
    });

    expect(await searchIds("run")).toEqual([note.id]);
  });

  it("follows an edit in the same write path as the canonical row", async () => {
    const note = await createNote();

    await memory.update({
      memoryId: note.id,
      revisionId: nextId("rev"),
      baseRevision: 1,
      patch: {
        hook: "Swap thrash masquerades as a branch defect",
        body: "The signature is a lone test timeout under memory pressure.",
      },
      authorKind: "user",
      authorConversationId: null,
      writtenAt: T2,
    });

    expect(await searchIds("masquerades")).toEqual([note.id]);
    // The replaced body is gone from the index, not merely shadowed by the new
    // one. (The slug still answers "onTaskUpdate": the edit did not touch it.)
    expect(await searchIds("sysctl")).toEqual([]);
    expect(await searchIds("onTaskUpdate")).toEqual([note.id]);
  });

  it("drops a deleted note from the index", async () => {
    const note = await createNote();
    await memory.delete(note.id);

    expect(await searchIds("onTaskUpdate")).toEqual([]);
  });

  it("excludes archived and superseded notes from the search default", async () => {
    const predecessor = await createNote({ slug: "the-lesson" });
    const successor = await createNote({
      slug: "the-lesson",
      hook: "Zero failures plus an onTaskUpdate timeout means swap thrash",
      createdAt: T2,
      supersedes: {
        memoryId: predecessor.id,
        archiveRevisionId: nextId("rev"),
        baseRevision: null,
      },
    });

    expect(await searchIds("onTaskUpdate")).toEqual([successor.id]);
    expect(
      (
        await reader().search("onTaskUpdate", {
          ...VISIBILITY,
          includeArchived: true,
        })
      )
        .map((hit) => hit.note.id)
        .sort(),
    ).toEqual([predecessor.id, successor.id].sort());
  });

  it("restricts hits to the caller's visible scope union", async () => {
    const note = await createNote({ slug: "project-lesson" });

    expect(await searchIds("onTaskUpdate")).toEqual([note.id]);
    expect(
      (
        await reader().search("onTaskUpdate", {
          visibility: { projectPath: "/repos/other", session: null },
          includeArchived: false,
        })
      ).map((hit) => hit.note.id),
    ).toEqual([]);
  });
});

describe("the index as derived state", () => {
  it("stores no column values at all, so canonical content cannot live only here", async () => {
    await createNote();

    const rows = db.prepare("SELECT * FROM memory_notes_fts").all() as Array<
      Record<string, unknown>
    >;

    expect(rows).toHaveLength(1);
    // A contentless FTS5 table returns NULL for every column: the searchable
    // projection is an index, never a second copy of the note.
    expect(Object.values(rows[0] ?? {}).every((value) => value === null)).toBe(
      true,
    );
  });

  it("reproduces identical query results when rebuilt from the canonical tables", async () => {
    await createNote({ slug: "first-lesson" });
    await createNote({
      slug: "second-lesson",
      aliases: ["swap-thrash"],
      hook: "Turbopack's FS cache became the build bottleneck",
      body: "An unpruned cache made the build run 59 times slower.",
    });
    const queries = ["onTaskUpdate", "swap-thrash", "run", "cache", "lesson"];
    const before = await Promise.all(queries.map(searchIds));
    expect(before.every((hits) => hits.length > 0)).toBe(true);

    const indexed = await memory.rebuildSearchIndex();

    expect(indexed).toBe(2);
    expect(await Promise.all(queries.map(searchIds))).toEqual(before);
  });

  it("recovers an index that drifted from the canonical rows", async () => {
    const note = await createNote();

    // Canonical rows edited behind the repository's back — a hand-repaired
    // database, a restored backup — leave the derived index stale.
    db.prepare("UPDATE memory_notes SET body = ? WHERE id = ?").run(
      "A rewritten body nobody indexed.",
      note.id,
    );
    db.prepare("DELETE FROM memory_notes_fts").run();
    expect(await searchIds("onTaskUpdate")).toEqual([]);

    expect(await memory.rebuildSearchIndex()).toBe(1);

    expect(await searchIds("rewritten")).toEqual([note.id]);
    expect(await searchIds("onTaskUpdate")).toEqual([note.id]);
  });

  it("survives a full reset of the store", async () => {
    await createNote();

    // The fixture reset path clears the virtual table itself and leaves its
    // shadow tables to SQLite; modifying those directly is refused outright.
    expect(() => truncateAllTables(db)).not.toThrow();
    expect(await searchIds("onTaskUpdate")).toEqual([]);

    createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
    const note = await createNote();
    expect(await searchIds("onTaskUpdate")).toEqual([note.id]);
  });
});
