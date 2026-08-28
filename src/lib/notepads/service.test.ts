import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishFn } from "@/lib/events/publication";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createNotepadContentStore,
  NotepadContentError,
  type NotepadContentStore,
} from "./content-store";
import {
  createNotepadService,
  USER_REVISION_COALESCE_WINDOW_MS,
  type NotepadService,
} from "./service";
import type { NotepadAuthor, NotepadChangedEvent } from "./schemas";

const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT = "/repos/other";
const AGENT: NotepadAuthor = { kind: "agent", conversationId: "conv-writer" };
const USER: NotepadAuthor = { kind: "user" };

let fixture: PersistenceFixture;
let repo: NotepadsRepo;
let service: NotepadService;
let contentStore: NotepadContentStore;
let contentBase: string;
let published: SSEEvent[];
let clock: number;
let idSeq: number;

const publish: PublishFn = (event) => {
  published.push(event);
  return { delivered: true };
};

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedProject(OTHER_PROJECT);
  repo = createNotepadsRepo(fixture.db, createWriteQueue());
  contentBase = mkdtempSync(path.join(tmpdir(), "cc-notepad-service-"));
  // The real content store against a temp root: a JS fake could not prove that
  // deleting a notepad actually removes its image bytes from disk.
  contentStore = createNotepadContentStore({
    contentRoot: path.join(contentBase, "notepad-content"),
    listNotepadIdsForProject: (projectPath) => repo.listNotepadIds(projectPath),
  });
  published = [];
  clock = 0;
  idSeq = 0;
  service = createNotepadService({
    repo,
    publish,
    deleteNotepadContent: (notepadId) => contentStore.deleteNotepad(notepadId),
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 7, 27, 9, 0, 0) + clock).toISOString();
    },
    generateId: () => {
      idSeq += 1;
      return `generated-${idSeq}`;
    },
  });
});

afterEach(() => {
  fixture.close();
  rmSync(contentBase, { recursive: true, force: true });
});

function notepadEvents(): NotepadChangedEvent[] {
  return published.filter(
    (event): event is NotepadChangedEvent => event.type === "notepad-changed",
  );
}

async function createGlobal(
  name: string,
  overrides: Partial<{
    content: string;
    writeMode: "read-only" | "append-only" | "full-edit";
  }> = {},
) {
  const result = await service.create({
    scope: "global",
    projectPath: null,
    name,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`expected create to succeed, got ${result.error.code}`);
  }
  return result.value;
}

describe("creation and scoped listing", () => {
  it("persists notepads in both scopes and lists each scope's own", async () => {
    const global = await createGlobal("Shared");
    const scoped = await service.create({
      scope: "project",
      projectPath: PROJECT_PATH,
      name: "Project notes",
      content: "body",
    });
    expect(scoped.ok).toBe(true);

    const globals = await service.list({ scope: "global" });
    expect(globals.ok && globals.value.map((n) => n.id)).toEqual([global.id]);

    const projectScoped = await service.list({
      scope: "project",
      projectPath: PROJECT_PATH,
    });
    expect(projectScoped.ok && projectScoped.value.map((n) => n.name)).toEqual([
      "Project notes",
    ]);

    const elsewhere = await service.list({
      scope: "project",
      projectPath: OTHER_PROJECT,
    });
    expect(elsewhere.ok && elsewhere.value).toEqual([]);
  });

  it("refuses a duplicate name inside one scope and allows it in another", async () => {
    await createGlobal("Inbox");

    const duplicate = await service.create({
      scope: "global",
      projectPath: null,
      name: "Inbox",
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.error.code).toBe("name_taken");
    expect(duplicate.error.message).toContain("Inbox");

    const otherScope = await service.create({
      scope: "project",
      projectPath: PROJECT_PATH,
      name: "Inbox",
    });
    expect(otherScope.ok).toBe(true);
  });

  it("defaults a new notepad to full-edit and records its creating revision", async () => {
    const notepad = await createGlobal("Fresh", { content: "seed" });
    expect(notepad.writeMode).toBe("full-edit");
    expect(notepad.revision).toBe(1);

    const revisions = await service.listRevisions(notepad.id);
    expect(revisions.ok && revisions.value).toHaveLength(1);
    expect(revisions.ok && revisions.value[0]?.origin).toBe("create");
  });

  it("reports a missing notepad by the id that was asked for", async () => {
    const result = await service.get("notepad-that-never-existed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
    expect(result.error.message).toContain("notepad-that-never-existed");
  });
});

describe("organization and ordering", () => {
  it("persists rename, pin, archive, unarchive, and delete", async () => {
    const notepad = await createGlobal("Before");

    const renamed = await service.update(notepad.id, { name: "After" }, USER);
    expect(renamed.ok && renamed.value.name).toBe("After");

    await service.update(notepad.id, { pinned: true, archived: true }, USER);
    let current = await service.get(notepad.id);
    expect(current.ok && current.value.pinned).toBe(true);
    expect(current.ok && current.value.archived).toBe(true);

    await service.update(notepad.id, { archived: false }, USER);
    current = await service.get(notepad.id);
    expect(current.ok && current.value.archived).toBe(false);

    const deleted = await service.delete(notepad.id);
    expect(deleted.ok).toBe(true);
    expect((await service.get(notepad.id)).ok).toBe(false);
  });

  it("hides archived notepads by default and surfaces them on request", async () => {
    const kept = await createGlobal("Kept");
    const shelved = await createGlobal("Shelved");
    await service.update(shelved.id, { archived: true }, USER);

    const visible = await service.list({ sort: "name" });
    expect(visible.ok && visible.value.map((n) => n.id)).toEqual([kept.id]);

    const all = await service.list({ sort: "name", includeArchived: true });
    expect(all.ok && all.value.map((n) => n.name)).toEqual(["Kept", "Shelved"]);
  });

  it("returns pinned notepads first under both orderings", async () => {
    await createGlobal("Alpha");
    await createGlobal("Beta");
    const pinned = await createGlobal("Zulu");
    await service.update(pinned.id, { pinned: true }, USER);

    const byName = await service.list({ sort: "name" });
    expect(byName.ok && byName.value.map((n) => n.name)).toEqual([
      "Zulu",
      "Alpha",
      "Beta",
    ]);

    const byRecency = await service.list({ sort: "recency" });
    expect(byRecency.ok && byRecency.value.map((n) => n.name)).toEqual([
      "Zulu",
      "Beta",
      "Alpha",
    ]);
  });

  it("refuses a rename onto a name already taken in the same scope", async () => {
    await createGlobal("Taken");
    const other = await createGlobal("Free");

    const result = await service.update(other.id, { name: "Taken" }, USER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("name_taken");
  });
});

describe("write modes on agent writes", () => {
  it.each([
    ["read-only", "update", false],
    ["read-only", "append", false],
    ["append-only", "update", false],
    ["append-only", "append", true],
    ["full-edit", "update", true],
    ["full-edit", "append", true],
  ] as const)(
    "a %s notepad %ss an agent %s",
    async (writeMode, operation, allowed) => {
      const notepad = await createGlobal(`Mode ${writeMode} ${operation}`, {
        writeMode,
        content: "base",
      });

      const result = await service.writeContent(notepad.id, {
        operation,
        content: "agent body",
        author: AGENT,
        baseRevision: notepad.revision,
      });

      expect(result.ok).toBe(allowed);
      if (result.ok) return;
      expect(result.error.code).toBe("write_mode_refused");
      // The refusal has to name the mode the caller ran into.
      expect(result.error.message).toContain(writeMode);
      expect((await service.get(notepad.id)).ok && true).toBe(true);
    },
  );

  it("refuses an agent write when the mode narrowed after the decision was taken", async () => {
    const notepad = await createGlobal("Narrowing", { content: "base" });

    // The production interleave: a queued user organization write commits
    // between the service's decision and its serialized content write. A mode
    // change does not advance the revision, so the agent's compare-and-swap
    // token is still current — staleness cannot catch this.
    const racingRepo: NotepadsRepo = {
      ...repo,
      writeContent: async (input) => {
        await repo.updateOrganization({
          notepadId: notepad.id,
          writeMode: "read-only",
          updatedAt: "2026-08-27T09:30:00.000Z",
        });
        return repo.writeContent(input);
      },
    };
    const racingService = createNotepadService({
      repo: racingRepo,
      publish,
      deleteNotepadContent: (notepadId) =>
        contentStore.deleteNotepad(notepadId),
      now: () => "2026-08-27T09:31:00.000Z",
      generateId: () => "generated-race",
    });

    const result = await racingService.writeContent(notepad.id, {
      operation: "update",
      content: "agent body",
      author: AGENT,
      baseRevision: notepad.revision,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("write_mode_refused");
    expect(result.error.message).toContain("read-only");
    const reloaded = await repo.find(notepad.id);
    expect(reloaded?.content).toBe("base");
    expect(reloaded?.revision).toBe(1);
    expect(notepadEvents().map((event) => event.change)).toEqual(["created"]);
  });

  it("never mode-checks a user write, even on a read-only notepad", async () => {
    const notepad = await createGlobal("Locked", {
      writeMode: "read-only",
      content: "base",
    });

    const result = await service.writeContent(notepad.id, {
      operation: "update",
      content: "the owner edits freely",
      author: USER,
    });

    expect(result.ok).toBe(true);
    const reloaded = await service.get(notepad.id);
    expect(reloaded.ok && reloaded.value.content).toBe(
      "the owner edits freely",
    );
  });

  it("refuses an agent-attributed write-mode change so an agent cannot loosen its own leash", async () => {
    const notepad = await createGlobal("Guarded", { writeMode: "read-only" });

    const result = await service.update(
      notepad.id,
      { writeMode: "full-edit" },
      AGENT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("write_mode_refused");
    const reloaded = await service.get(notepad.id);
    expect(reloaded.ok && reloaded.value.writeMode).toBe("read-only");
  });

  it("lets a user change the write mode", async () => {
    const notepad = await createGlobal("Adjustable", {
      writeMode: "read-only",
    });
    const result = await service.update(
      notepad.id,
      { writeMode: "append-only" },
      USER,
    );
    expect(result.ok && result.value.writeMode).toBe("append-only");
  });
});

describe("agent compare-and-swap", () => {
  // The write transaction, not a pre-read, is what reports a vanished notepad:
  // the id may stop resolving between any read and the serialized write.
  it("reports a content write to a missing notepad as not found, naming the id", async () => {
    const result = await service.writeContent("notepad-that-never-existed", {
      operation: "update",
      content: "x",
      author: AGENT,
      baseRevision: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
    expect(result.error.message).toContain("notepad-that-never-existed");
  });

  it("refuses a stale agent write with the current revision and accepts the retry", async () => {
    const notepad = await createGlobal("Contested", { content: "one" });
    await service.writeContent(notepad.id, {
      operation: "update",
      content: "two",
      author: USER,
    });

    const stale = await service.writeContent(notepad.id, {
      operation: "update",
      content: "agent body",
      author: AGENT,
      baseRevision: 1,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("stale_revision");
    if (stale.error.code !== "stale_revision") return;
    expect(stale.error.currentRevision).toBe(2);

    const fresh = await service.get(notepad.id);
    const retried = await service.writeContent(notepad.id, {
      operation: "update",
      content: "agent body",
      author: AGENT,
      baseRevision: fresh.ok ? fresh.value.revision : 0,
    });
    expect(retried.ok).toBe(true);
    const reloaded = await service.get(notepad.id);
    expect(reloaded.ok && reloaded.value.content).toBe("agent body");
  });

  it("keeps both racers' content in history when a user edit races an agent write", async () => {
    const notepad = await createGlobal("Raced", { content: "base" });

    const agentWrite = await service.writeContent(notepad.id, {
      operation: "update",
      content: "agent draft",
      author: AGENT,
      baseRevision: 1,
    });
    expect(agentWrite.ok).toBe(true);

    // The user's editor still holds revision 1 when their autosave lands; a
    // user write is never refused for staleness.
    const userWrite = await service.writeContent(notepad.id, {
      operation: "update",
      content: "user typing",
      author: USER,
    });
    expect(userWrite.ok).toBe(true);

    const revisions = await service.listRevisions(notepad.id);
    expect(revisions.ok && revisions.value.map((r) => r.content)).toEqual([
      "base",
      "agent draft",
      "user typing",
    ]);
  });

  it("appends onto the current content under the same compare-and-swap", async () => {
    const notepad = await createGlobal("Growing", { content: "first" });

    const appended = await service.writeContent(notepad.id, {
      operation: "append",
      content: "second",
      author: AGENT,
      baseRevision: 1,
    });

    expect(appended.ok).toBe(true);
    const reloaded = await service.get(notepad.id);
    expect(reloaded.ok && reloaded.value.content).toBe("first\n\nsecond");
  });
});

describe("attribution, history, and restore", () => {
  it("attributes each revision to its author and names the writing conversation", async () => {
    const notepad = await createGlobal("Attributed", { content: "start" });
    await service.writeContent(notepad.id, {
      operation: "update",
      content: "by hand",
      author: USER,
    });
    await service.writeContent(notepad.id, {
      operation: "update",
      content: "by agent",
      author: AGENT,
      baseRevision: 2,
    });

    const revisions = await service.listRevisions(notepad.id);
    expect(
      revisions.ok &&
        revisions.value.map((r) => [r.authorKind, r.authorConversationId]),
    ).toEqual([
      ["user", null],
      ["user", null],
      ["agent", "conv-writer"],
    ]);
  });

  it("restores a prior revision as a new revision and leaves history untouched", async () => {
    const notepad = await createGlobal("Restorable", { content: "original" });
    await service.writeContent(notepad.id, {
      operation: "update",
      content: "replaced",
      author: USER,
    });

    const restored = await service.restore(notepad.id, { revision: 1 });
    expect(restored.ok && restored.value.content).toBe("original");
    expect(restored.ok && restored.value.revision).toBe(3);

    const revisions = await service.listRevisions(notepad.id);
    if (!revisions.ok) throw new Error("expected revisions");
    expect(revisions.value.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(revisions.value[2]?.origin).toBe("restore");
    expect(revisions.value[2]?.restoredFromRevision).toBe(1);
    expect(revisions.value[0]?.content).toBe("original");
    expect(revisions.value[1]?.content).toBe("replaced");
  });

  it("reports a restore of an unknown revision as not found", async () => {
    const notepad = await createGlobal("Shallow");
    const result = await service.restore(notepad.id, { revision: 9 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
  });
});

describe("user editing bursts", () => {
  /** Past the coalescing window: the next write starts a fresh revision. */
  function goQuiet() {
    clock += USER_REVISION_COALESCE_WINDOW_MS + 1000;
  }

  async function userWrite(notepadId: string, content: string) {
    const written = await service.writeContent(notepadId, {
      operation: "update",
      content,
      author: USER,
    });
    if (!written.ok) throw new Error(`write failed: ${written.error.code}`);
    return written.value;
  }

  it("folds one burst of autosaves into a single revision", async () => {
    const notepad = await createGlobal("Bursty", { content: "seed" });

    const burstStart = await userWrite(notepad.id, "t");
    await userWrite(notepad.id, "ty");
    const last = await userWrite(notepad.id, "typing");

    // Every save still advanced the head — the durable text is the last one
    // typed, not the last one that opened a revision.
    expect(last.content).toBe("typing");
    const head = await service.get(notepad.id);
    expect(head.ok && head.value.content).toBe("typing");
    expect(head.ok && head.value.revision).toBe(last.revision);

    const revisions = await service.listRevisions(notepad.id);
    if (!revisions.ok) throw new Error("expected revisions");
    expect(revisions.value.map((r) => r.origin)).toEqual(["create", "edit"]);
    expect(revisions.value[1]?.content).toBe("typing");
    expect(revisions.value[1]?.revision).toBe(last.revision);
    // The revision is stamped when the burst began, so absorbing saves cannot
    // keep pushing its window forward and fold an unbounded session into one
    // entry.
    expect(revisions.value[1]?.createdAt).toBe(burstStart.updatedAt);
  });

  it("opens a new revision once the burst goes quiet", async () => {
    const notepad = await createGlobal("Paused", { content: "seed" });

    await userWrite(notepad.id, "first burst");
    goQuiet();
    await userWrite(notepad.id, "second burst");

    const revisions = await service.listRevisions(notepad.id);
    if (!revisions.ok) throw new Error("expected revisions");
    expect(revisions.value.map((r) => r.content)).toEqual([
      "seed",
      "first burst",
      "second burst",
    ]);
  });

  it("never folds an edit into a revision it did not write", async () => {
    const notepad = await createGlobal("Shared pad", { content: "seed" });

    const mine = await userWrite(notepad.id, "mine");
    const agentWrite = await service.writeContent(notepad.id, {
      operation: "update",
      content: "theirs",
      author: AGENT,
      baseRevision: mine.revision,
    });
    expect(agentWrite.ok).toBe(true);
    await userWrite(notepad.id, "mine again");

    const revisions = await service.listRevisions(notepad.id);
    if (!revisions.ok) throw new Error("expected revisions");
    // The agent's revision keeps its own row, and the user's later burst opens
    // another rather than absorbing it.
    expect(revisions.value.map((r) => [r.authorKind, r.content])).toEqual([
      ["user", "seed"],
      ["user", "mine"],
      ["agent", "theirs"],
      ["user", "mine again"],
    ]);
  });

  it("keeps a restore as its own revision and never folds into one", async () => {
    const notepad = await createGlobal("Restored burst", { content: "seed" });
    await userWrite(notepad.id, "edited");

    const restored = await service.restore(notepad.id, { revision: 1 });
    expect(restored.ok).toBe(true);
    await userWrite(notepad.id, "after restore");

    const revisions = await service.listRevisions(notepad.id);
    if (!revisions.ok) throw new Error("expected revisions");
    expect(revisions.value.map((r) => [r.origin, r.content])).toEqual([
      ["create", "seed"],
      ["edit", "edited"],
      ["restore", "seed"],
      ["edit", "after restore"],
    ]);
  });

  it("still refuses an agent's stale write after a folded burst", async () => {
    const notepad = await createGlobal("CAS pad", { content: "seed" });
    const stale = await userWrite(notepad.id, "one");
    await userWrite(notepad.id, "two");

    // The burst folded into one revision row, but every save advanced the
    // compare-and-swap token: an agent holding the older head is still stale.
    const refused = await service.writeContent(notepad.id, {
      operation: "update",
      content: "agent text",
      author: AGENT,
      baseRevision: stale.revision,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("stale_revision");
  });
});

describe("id-addressed revision resolution", () => {
  it("resolves a revision and its immediate predecessor regardless of depth", async () => {
    const notepad = await createGlobal("Deep", { content: "r1" });
    for (let revision = 2; revision <= 60; revision += 1) {
      // Separate editing sessions, so each one records its own revision.
      clock += USER_REVISION_COALESCE_WINDOW_MS + 1000;
      await service.writeContent(notepad.id, {
        operation: "update",
        content: `r${revision}`,
        author: USER,
      });
    }

    // r5 sits far outside any bounded newest-first listing window.
    const result = await service.resolveRevision(notepad.id, 5);
    if (!result.ok) throw new Error("expected resolution");
    expect(result.value.map((r) => [r.revision, r.content])).toEqual([
      [4, "r4"],
      [5, "r5"],
    ]);
  });

  it("resolves the create revision alone — it genuinely has no predecessor", async () => {
    const notepad = await createGlobal("Origin", { content: "seed" });
    const result = await service.resolveRevision(notepad.id, 1);
    if (!result.ok) throw new Error("expected resolution");
    expect(result.value.map((r) => [r.revision, r.origin])).toEqual([
      [1, "create"],
    ]);
  });

  it("resolves a user restore (null base revision) with its real predecessor", async () => {
    const notepad = await createGlobal("Restored", { content: "original" });
    await service.writeContent(notepad.id, {
      operation: "update",
      content: "replaced",
      author: USER,
    });
    const restored = await service.restore(notepad.id, { revision: 1 });
    if (!restored.ok) throw new Error("expected restore");

    // r3 is a user restore whose recorded baseRevision is null; its immediate
    // predecessor is still r2, never an empty-content stand-in.
    const result = await service.resolveRevision(notepad.id, 3);
    if (!result.ok) throw new Error("expected resolution");
    expect(result.value.map((r) => [r.revision, r.content])).toEqual([
      [2, "replaced"],
      [3, "original"],
    ]);
    expect(result.value[1]?.baseRevision).toBeNull();
    expect(result.value[1]?.origin).toBe("restore");
  });

  it("reports an unknown revision and an unknown notepad as not found", async () => {
    const notepad = await createGlobal("Shallow resolution");
    const missingRevision = await service.resolveRevision(notepad.id, 9);
    expect(missingRevision.ok).toBe(false);
    if (!missingRevision.ok) {
      expect(missingRevision.error.code).toBe("not_found");
    }

    const missingNotepad = await service.resolveRevision("np-never", 1);
    expect(missingNotepad.ok).toBe(false);
    if (!missingNotepad.ok) {
      expect(missingNotepad.error.code).toBe("not_found");
    }
  });
});

describe("notepad-changed publication", () => {
  it("publishes one frame per committed mutation with the right change kind", async () => {
    const notepad = await createGlobal("Watched", { content: "one" });
    await service.writeContent(notepad.id, {
      operation: "update",
      content: "two",
      author: AGENT,
      baseRevision: 1,
    });
    await service.update(notepad.id, { pinned: true }, USER);
    await service.restore(notepad.id, { revision: 1 });
    await service.delete(notepad.id);

    expect(notepadEvents().map((event) => event.change)).toEqual([
      "created",
      "updated",
      "organized",
      "restored",
      "deleted",
    ]);
  });

  it("carries identifiers, the head revision, the author, and a list projection — never content", async () => {
    const notepad = await createGlobal("Framed", { content: "one" });
    await service.writeContent(notepad.id, {
      operation: "update",
      content: "a very long body that must never ride the event bus",
      author: AGENT,
      baseRevision: 1,
    });

    const updated = notepadEvents().at(-1);
    expect(updated).toBeDefined();
    if (!updated) return;
    expect(updated.notepadId).toBe(notepad.id);
    expect(updated.scope).toBe("global");
    expect(updated.revision).toBe(2);
    expect(updated.authorKind).toBe("agent");
    expect(updated.listItem?.name).toBe("Framed");
    expect(JSON.stringify(updated)).not.toContain("must never ride");
  });

  it("publishes a deletion frame with no list item so a list reaction can drop the row", async () => {
    const notepad = await createGlobal("Doomed");
    await service.delete(notepad.id);

    const deleted = notepadEvents().at(-1);
    expect(deleted?.change).toBe("deleted");
    expect(deleted?.listItem).toBeNull();
    expect(deleted?.notepadId).toBe(notepad.id);
  });

  it("publishes nothing when the mutation was refused", async () => {
    await createGlobal("Taken");
    published = [];

    await service.create({ scope: "global", projectPath: null, name: "Taken" });
    await service.writeContent("notepad-that-never-existed", {
      operation: "update",
      content: "x",
      author: USER,
    });

    expect(notepadEvents()).toEqual([]);
  });

  it("still commits the mutation when publication fails", async () => {
    const failing = createNotepadService({
      repo,
      publish: () => {
        throw new Error("transport is down");
      },
      deleteNotepadContent: (notepadId) =>
        contentStore.deleteNotepad(notepadId),
      now: () => "2026-08-27T09:00:00.000Z",
      generateId: () => "generated-fail",
    });

    const result = await failing.create({
      scope: "global",
      projectPath: null,
      name: "Durable",
    });

    expect(result.ok).toBe(true);
    const reloaded = await repo.find(result.ok ? result.value.id : "");
    expect(reloaded?.name).toBe("Durable");
  });
});

describe("image lifecycle", () => {
  async function attachImage(notepadId: string, fileName: string) {
    const imageId = `image-${fileName.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const snapshot = await contentStore.capture({
      notepadId,
      imageId,
      fileName,
      bytes: Buffer.from(`bytes of ${fileName}`, "utf8"),
    });
    await repo.addImage({
      id: imageId,
      notepadId,
      fileName: snapshot.fileName,
      mediaType: "image/png",
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
      snapshotKey: snapshot.snapshotKey,
      createdAt: "2026-08-27T09:00:00.000Z",
    });
    return snapshot;
  }

  async function expectMissingBytes(snapshotKey: string): Promise<void> {
    const thrown = await contentStore.read(snapshotKey).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(NotepadContentError);
    expect((thrown as NotepadContentError).code).toBe("snapshot_not_found");
  }

  it("persists image bytes alongside a metadata row the notepad can list", async () => {
    const notepad = await createGlobal("Illustrated");
    const snapshot = await attachImage(notepad.id, "diagram.png");

    const images = await repo.listImages(notepad.id);
    expect(images.map((image) => image.snapshotKey)).toEqual([
      snapshot.snapshotKey,
    ]);
    expect(
      Buffer.from(await contentStore.read(snapshot.snapshotKey)).toString(),
    ).toBe("bytes of diagram.png");
  });

  it("removes both the image rows and the stored bytes when the notepad is deleted", async () => {
    const notepad = await createGlobal("Doomed with pictures");
    const first = await attachImage(notepad.id, "one.png");
    const second = await attachImage(notepad.id, "two.png");
    const survivor = await createGlobal("Untouched");
    const keep = await attachImage(survivor.id, "keep.png");

    const deleted = await service.delete(notepad.id);

    expect(deleted.ok).toBe(true);
    expect(await repo.listImages(notepad.id)).toEqual([]);
    await expectMissingBytes(first.snapshotKey);
    await expectMissingBytes(second.snapshotKey);
    expect((await repo.listImages(survivor.id)).length).toBe(1);
    await expect(contentStore.read(keep.snapshotKey)).resolves.toBeTruthy();
  });

  it("still deletes the notepad when its content cleanup fails", async () => {
    const stranded = createNotepadService({
      repo,
      publish,
      deleteNotepadContent: () =>
        Promise.reject(new Error("content root is read-only")),
      now: () => "2026-08-27T09:00:00.000Z",
      generateId: () => "generated-stranded",
    });
    const notepad = await createGlobal("Cleanup fails");
    await attachImage(notepad.id, "orphan.png");

    const deleted = await stranded.delete(notepad.id);

    expect(deleted.ok).toBe(true);
    expect(await repo.find(notepad.id)).toBeNull();
    expect(await repo.listImages(notepad.id)).toEqual([]);
  });
});
