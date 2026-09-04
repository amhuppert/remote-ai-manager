import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishFn } from "@/lib/events/publication";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_STATUS_NOTE_LEASE_MS,
  memoryChangedEventSchema,
  type CreateMemoryNoteRequest,
  type MemoryActor,
  type MemoryChangedEvent,
  type MemoryNote,
} from "./schemas";
import type {
  MemoryContributionDecision,
  MemoryPolicyResolution,
} from "./delivery-policy";
import {
  createMemoryService,
  type MemoryError,
  type MemoryResult,
  type MemoryService,
} from "./service";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT = "/repos/other";
const INCARNATION = {
  sessionName: "memory-spike",
  sessionCreatedAt: "2026-09-01T08:00:00.000Z",
};

const USER_GLOBAL: MemoryActor = {
  kind: "user",
  visibility: { projectPath: null, session: null },
};
const USER_IN_PROJECT: MemoryActor = {
  kind: "user",
  visibility: { projectPath: PROJECT_PATH, session: null },
};
const AGENT_IN_PROJECT: MemoryActor = {
  kind: "agent",
  conversationId: "conv-project",
  visibility: { projectPath: PROJECT_PATH, session: null },
};
const AGENT_IN_SESSION: MemoryActor = {
  kind: "agent",
  conversationId: "conv-session",
  visibility: { projectPath: PROJECT_PATH, session: INCARNATION },
};
const AGENT_ELSEWHERE: MemoryActor = {
  kind: "agent",
  conversationId: "conv-other",
  visibility: { projectPath: OTHER_PROJECT, session: null },
};

const BASE_TIME = Date.UTC(2026, 8, 1, 10, 0, 0);

let db: Db;
let repo: MemoryRepo;
let service: MemoryService;
let published: SSEEvent[];
let clock: number;
let idSeq: number;
/** What the contribution gate answers for AGENT actors; humans are always admitted. */
let gateDecision: MemoryContributionDecision;

const publish: PublishFn = (event) => {
  published.push(event);
  return { delivered: true };
};

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const queue = createWriteQueue();
  repo = createMemoryRepo(db, queue);
  const projects = createProjectsRepo(db);
  projects.upsert({ rootPath: PROJECT_PATH });
  projects.upsert({ rootPath: OTHER_PROJECT });
  published = [];
  clock = 0;
  idSeq = 0;
  gateDecision = { allowed: true };
  service = createMemoryService({
    repo,
    publish,
    contributionGate: {
      async decide(actor) {
        return actor.kind === "user" ? { allowed: true } : gateDecision;
      },
    },
    now: () => {
      clock += 1000;
      return new Date(BASE_TIME + clock).toISOString();
    },
    generateId: () => {
      idSeq += 1;
      return `generated-${idSeq}`;
    },
    sessions: {
      // This fixture models no session lifecycle, so no incarnation it is
      // asked about has ended. Session completion is covered against real
      // session rows in session-end.test.ts.
      async isSessionIncarnationOver() {
        return false;
      },
    },
  });
});

afterEach(() => {
  db.close();
});

function events(): MemoryChangedEvent[] {
  return published.filter(
    (event): event is MemoryChangedEvent => event.type === "memory-changed",
  );
}

function changes(): string[] {
  return events().map((event) => event.change);
}

function ok<T>(result: MemoryResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function refused<T>(result: MemoryResult<T>): MemoryError {
  if (result.ok) throw new Error("expected a refusal, got success");
  return result.error;
}

async function capture(
  actor: MemoryActor,
  overrides: Partial<CreateMemoryNoteRequest> = {},
): Promise<MemoryNote> {
  const result = await service.create(
    {
      scope: "project",
      kind: "lesson",
      hook: "The FTS5 index is derived state rebuilt from the note rows",
      body: "A rebuild repopulates the index from `memory_notes`.",
      ...overrides,
    },
    actor,
  );
  return ok(result).note;
}

describe("capture (R9, D8)", () => {
  it("persists a project note with a slug derived from the hook and publishes created", async () => {
    const note = await capture(USER_IN_PROJECT);

    expect(note.slug).toBe(
      "the-fts5-index-is-derived-state-rebuilt-from-the-note-rows",
    );
    expect(note).toMatchObject({
      scope: "project",
      projectPath: PROJECT_PATH,
      sessionName: null,
      lifecycle: "active",
      createdBy: "user",
      authorConversationId: null,
      revision: 1,
    });
    expect(await repo.find(note.id)).toEqual(note);

    const [event] = events();
    expect(events()).toHaveLength(1);
    expect(memoryChangedEventSchema.parse(event)).toEqual({
      type: "memory-changed",
      change: "created",
      memoryId: note.id,
      slug: note.slug,
      scope: "project",
      projectPath: PROJECT_PATH,
      sessionName: null,
      sessionCreatedAt: null,
      lifecycle: "active",
      revision: 1,
      authorKind: "user",
      link: null,
    });
    // Prose never rides the bus: the frame is identity and state only.
    expect(event).not.toHaveProperty("hook");
    expect(event).not.toHaveProperty("body");
  });

  it("binds a session note to the actor's exact incarnation and attributes the agent", async () => {
    const note = await capture(AGENT_IN_SESSION, {
      scope: "session",
      kind: "state",
      hook: "Working on the capture service; links come next",
    });

    expect(note).toMatchObject({
      scope: "session",
      projectPath: PROJECT_PATH,
      sessionName: INCARNATION.sessionName,
      sessionCreatedAt: INCARNATION.sessionCreatedAt,
      createdBy: "agent",
      authorConversationId: "conv-session",
      lifecycle: "active",
    });
  });

  it("refuses a scope level the actor does not occupy and publishes nothing", async () => {
    const noSession = refused(
      await service.create(
        { scope: "session", kind: "state", hook: "Some working state" },
        AGENT_IN_PROJECT,
      ),
    );
    expect(noSession).toMatchObject({
      code: "scope_unavailable",
      scope: "session",
      missing: "session",
    });

    const noProject = refused(
      await service.create(
        { scope: "project", kind: "lesson", hook: "A fact about a project" },
        USER_GLOBAL,
      ),
    );
    expect(noProject).toMatchObject({
      code: "scope_unavailable",
      scope: "project",
      missing: "project",
    });

    expect(events()).toEqual([]);
  });

  it("suffixes a colliding generated slug but refuses a colliding explicit one", async () => {
    const first = await capture(USER_IN_PROJECT, {
      hook: "Same hook here again",
    });
    const second = await capture(USER_IN_PROJECT, {
      hook: "Same hook here again",
    });
    expect(first.slug).toBe("same-hook-here-again");
    expect(second.slug).toBe("same-hook-here-again-2");

    const explicit = refused(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "Another fact entirely stated",
          slug: "same-hook-here-again",
        },
        USER_IN_PROJECT,
      ),
    );
    expect(explicit).toMatchObject({
      code: "slug_taken",
      slug: "same-hook-here-again",
      scope: "project",
    });

    const third = await capture(USER_IN_PROJECT, {
      hook: "Same hook here again",
    });
    expect(third.slug).toBe("same-hook-here-again-3");
    expect(changes()).toEqual(["created", "created", "created"]);
  });

  it("treats another note's alias in the same scope as a slug collision", async () => {
    await capture(USER_IN_PROJECT, {
      hook: "Notepad is the panel's name, never Notebook",
      aliases: ["notebook"],
    });

    const explicit = refused(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "A note that wants the alias as its slug",
          slug: "notebook",
        },
        USER_IN_PROJECT,
      ),
    );
    expect(explicit.code).toBe("slug_taken");

    const generated = await capture(USER_IN_PROJECT, { hook: "Notebook" });
    expect(generated.slug).toBe("notebook-2");
  });

  it("refuses a body over the cap, names the limit, and persists nothing", async () => {
    const error = refused(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "A hook whose body is far too large to keep",
          body: "x".repeat(MEMORY_BODY_MAX_BYTES + 1),
        },
        USER_IN_PROJECT,
      ),
    );
    expect(error).toMatchObject({
      code: "body_too_large",
      limitBytes: MEMORY_BODY_MAX_BYTES,
      actualBytes: MEMORY_BODY_MAX_BYTES + 1,
    });
    expect(error.message).toContain(String(MEMORY_BODY_MAX_BYTES));
    expect(
      await repo.list({
        visibility: USER_IN_PROJECT.visibility,
        includeArchived: true,
      }),
    ).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("refuses shape violations as validation failures naming the field", async () => {
    const stateAtProject = refused(
      await service.create(
        { scope: "project", kind: "state", hook: "State outside a session" },
        USER_IN_PROJECT,
      ),
    );
    expect(stateAtProject.code).toBe("validation_failed");
    expect(stateAtProject.message).toContain("kind");

    const stateWithStatus = refused(
      await service.create(
        {
          scope: "session",
          kind: "state",
          hook: "State with a status line",
          statusNote: "still going",
        },
        AGENT_IN_SESSION,
      ),
    );
    expect(stateWithStatus.code).toBe("validation_failed");
    expect(stateWithStatus.message).toContain("statusNote");

    const badSlug = refused(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "A slug with spaces is refused",
          slug: "Not A Slug",
        },
        USER_IN_PROJECT,
      ),
    );
    expect(badSlug.code).toBe("validation_failed");
    expect(events()).toEqual([]);
  });

  it("stamps the statusNote's updated-at and 14-day lease from one instant", async () => {
    const note = await capture(USER_IN_PROJECT, {
      statusNote: "Fix merged on main, not yet live-tested",
    });
    expect(note.statusNote).not.toBeNull();
    const status = note.statusNote;
    if (status === null) throw new Error("unreachable");
    expect(status.text).toBe("Fix merged on main, not yet live-tested");
    expect(status.updatedAt).toBe(note.createdAt);
    expect(
      new Date(status.reviewAfter).getTime() -
        new Date(status.updatedAt).getTime(),
    ).toBe(MEMORY_STATUS_NOTE_LEASE_MS);
  });
});

describe("advisory assists never block (R9.2)", () => {
  it("returns overlap candidates and hook warnings while the create succeeds", async () => {
    const existing = await capture(USER_IN_PROJECT, {
      hook: "Zero failures plus an onTaskUpdate timeout means swap thrash, not a branch defect",
      body: "Check sysctl vm.swapusage and re-run the file in isolation.",
    });

    const result = ok(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "Vitest swap thrash",
          body: "The onTaskUpdate timeout again.",
        },
        AGENT_IN_PROJECT,
      ),
    );

    expect(result.note.lifecycle).toBe("active");
    expect(await repo.find(result.note.id)).not.toBeNull();
    expect(result.advisories.hookWarnings.map((w) => w.code)).toEqual([
      "hook_topic_only",
    ]);
    expect(result.advisories.overlapCandidates.map((c) => c.memoryId)).toEqual([
      existing.id,
    ]);
    expect(result.advisories.overlapCandidates[0]).toMatchObject({
      slug: existing.slug,
      scope: "project",
      hook: existing.hook,
    });
    expect(changes()).toEqual(["created", "created"]);
  });

  it("warns on an over-long hook and reports no candidates for an unrelated one", async () => {
    await capture(USER_IN_PROJECT, {
      hook: "Radix dropdown items drop the inherited font family",
    });
    const longHook = `${"The build cache balloons ".repeat(12)}until pruned`;
    const result = ok(
      await service.create(
        { scope: "project", kind: "lesson", hook: longHook },
        USER_IN_PROJECT,
      ),
    );
    expect(result.advisories.hookWarnings.map((w) => w.code)).toEqual([
      "hook_too_long",
    ]);
    expect(result.advisories.overlapCandidates).toEqual([]);
  });
});

describe("update under compare-and-swap (R1.2)", () => {
  it("refuses a stale revision naming the current one, persisting nothing and publishing nothing", async () => {
    const note = await capture(USER_IN_PROJECT);
    const winner = ok(
      await service.update(
        note.slug,
        { baseRevision: 1, hook: "The winning edit of the hook line" },
        AGENT_IN_PROJECT,
      ),
    );
    expect(winner.revision).toBe(2);

    const stale = refused(
      await service.update(
        note.slug,
        { baseRevision: 1, hook: "The losing edit of the hook line" },
        USER_IN_PROJECT,
      ),
    );
    expect(stale).toMatchObject({
      code: "stale_revision",
      currentRevision: 2,
      baseRevision: 1,
    });
    expect(stale.message).toContain("2");

    const current = await repo.find(note.id);
    expect(current?.hook).toBe("The winning edit of the hook line");
    expect(current?.revision).toBe(2);
    expect(await repo.listRevisions(note.id)).toHaveLength(2);
    expect(changes()).toEqual(["created", "updated"]);
    expect(events()[1]).toMatchObject({
      change: "updated",
      revision: 2,
      authorKind: "agent",
    });
  });

  it("keeps the old slug as a resolving alias on rename", async () => {
    const note = await capture(USER_IN_PROJECT, { aliases: ["fts"] });
    const renamed = ok(
      await service.update(
        note.slug,
        { baseRevision: 1, slug: "fts-index-derived" },
        USER_IN_PROJECT,
      ),
    );
    expect(renamed.slug).toBe("fts-index-derived");
    expect(renamed.aliases).toEqual(["fts", note.slug]);

    const byOldSlug = ok(await service.resolve(note.slug, USER_IN_PROJECT));
    const byNewSlug = ok(
      await service.resolve("fts-index-derived", USER_IN_PROJECT),
    );
    expect(byOldSlug.id).toBe(note.id);
    expect(byNewSlug.id).toBe(note.id);
  });

  it("refuses a rename onto another note's slug or alias", async () => {
    await capture(USER_IN_PROJECT, {
      hook: "Notepad is the panel's name",
      aliases: ["notebook"],
    });
    const note = await capture(USER_IN_PROJECT, { hook: "A second note here" });

    const ontoSlug = refused(
      await service.update(
        note.slug,
        { baseRevision: 1, slug: "notepad-is-the-panel-s-name" },
        USER_IN_PROJECT,
      ),
    );
    expect(ontoSlug.code).toBe("slug_taken");
    const ontoAlias = refused(
      await service.update(
        note.slug,
        { baseRevision: 1, slug: "notebook" },
        USER_IN_PROJECT,
      ),
    );
    expect(ontoAlias.code).toBe("slug_taken");
    expect(changes()).toEqual(["created", "created"]);
  });

  it("re-leases a statusNote only when its text changes, and null clears it", async () => {
    const note = await capture(USER_IN_PROJECT, {
      statusNote: "Landed on main",
    });
    const original = note.statusNote;
    if (original === null) throw new Error("unreachable");

    const sameText = ok(
      await service.update(
        note.slug,
        { baseRevision: 1, statusNote: "Landed on main", body: "edited" },
        USER_IN_PROJECT,
      ),
    );
    expect(sameText.statusNote).toEqual(original);

    const newText = ok(
      await service.update(
        note.slug,
        { baseRevision: 2, statusNote: "Live-tested 2026-09-01" },
        USER_IN_PROJECT,
      ),
    );
    const refreshed = newText.statusNote;
    if (refreshed === null) throw new Error("unreachable");
    expect(refreshed.text).toBe("Live-tested 2026-09-01");
    expect(refreshed.updatedAt).toBe(newText.updatedAt);
    expect(
      new Date(refreshed.reviewAfter).getTime() -
        new Date(refreshed.updatedAt).getTime(),
    ).toBe(MEMORY_STATUS_NOTE_LEASE_MS);
    expect(refreshed.updatedAt > original.updatedAt).toBe(true);

    const cleared = ok(
      await service.update(
        note.slug,
        { baseRevision: 3, statusNote: null },
        USER_IN_PROJECT,
      ),
    );
    expect(cleared.statusNote).toBeNull();
  });

  it("refuses an oversized body on edit and a statusNote on a state note", async () => {
    const note = await capture(USER_IN_PROJECT);
    const tooLarge = refused(
      await service.update(
        note.slug,
        { baseRevision: 1, body: "y".repeat(MEMORY_BODY_MAX_BYTES + 1) },
        USER_IN_PROJECT,
      ),
    );
    expect(tooLarge.code).toBe("body_too_large");

    const state = await capture(AGENT_IN_SESSION, {
      scope: "session",
      kind: "state",
      hook: "Working state for this session",
    });
    const statusOnState = refused(
      await service.update(
        state.slug,
        { baseRevision: 1, statusNote: "not allowed" },
        AGENT_IN_SESSION,
      ),
    );
    expect(statusOnState.code).toBe("validation_failed");
    expect(changes()).toEqual(["created", "created"]);
  });

  it("is invisible to an actor outside the note's scope", async () => {
    const note = await capture(USER_IN_PROJECT);
    const elsewhere = refused(
      await service.update(
        note.slug,
        { baseRevision: 1, hook: "An edit from another project" },
        AGENT_ELSEWHERE,
      ),
    );
    expect(elsewhere).toMatchObject({ code: "not_found", handle: note.slug });
    const byId = refused(
      await service.update(
        note.id,
        { baseRevision: 1, hook: "An edit from another project" },
        AGENT_ELSEWHERE,
      ),
    );
    expect(byId.code).toBe("not_found");
    expect(changes()).toEqual(["created"]);
  });
});

describe("links (R8)", () => {
  it("links an about artifact and publishes linked with the link identity", async () => {
    const note = await capture(USER_IN_PROJECT);
    const link = ok(
      await service.link(
        note.slug,
        { kind: "about", artifact: { kind: "ticket", ticketId: "ticket-74" } },
        AGENT_IN_PROJECT,
      ),
    );
    expect(link.link).toMatchObject({
      memoryId: note.id,
      kind: "about",
      artifact: { kind: "ticket", ticketId: "ticket-74" },
    });
    // The act reports the note it belongs to, so a surface can name the slug
    // rather than echo the handle it was addressed by.
    expect(link.note.id).toBe(note.id);
    expect(await repo.listLinks(note.id)).toEqual([link.link]);
    expect(events()[1]).toMatchObject({
      change: "linked",
      memoryId: note.id,
      authorKind: "agent",
      link: { id: link.link.id, kind: "about" },
    });
  });

  it("re-linking the same artifact and kind lands on the one existing row", async () => {
    const note = await capture(USER_IN_PROJECT);
    const artifact = { kind: "ticket", ticketId: "ticket-74" } as const;
    const first = ok(
      await service.link(
        note.slug,
        { kind: "about", artifact },
        USER_IN_PROJECT,
      ),
    );
    const again = ok(
      await service.link(
        note.slug,
        { kind: "about", artifact },
        USER_IN_PROJECT,
      ),
    );

    expect(again.link).toEqual(first.link);
    expect(await repo.listLinks(note.id)).toEqual([first.link]);
  });

  it("unlinks by identity or by id, publishing unlinked; an unknown link is refused silently", async () => {
    const note = await capture(USER_IN_PROJECT);
    const about = ok(
      await service.link(
        note.slug,
        { kind: "about", artifact: { kind: "ticket", ticketId: "ticket-74" } },
        USER_IN_PROJECT,
      ),
    );
    const source = ok(
      await service.link(
        note.slug,
        { kind: "source", artifact: { kind: "spec", specId: "spec-memory" } },
        USER_IN_PROJECT,
      ),
    );

    const byIdentity = ok(
      await service.unlink(
        note.slug,
        { kind: "about", artifact: { kind: "ticket", ticketId: "ticket-74" } },
        AGENT_IN_PROJECT,
      ),
    );
    expect(byIdentity.link.id).toBe(about.link.id);
    const byId = ok(
      await service.unlink(
        note.slug,
        { linkId: source.link.id },
        USER_IN_PROJECT,
      ),
    );
    expect(byId.link.id).toBe(source.link.id);
    expect(await repo.listLinks(note.id)).toEqual([]);

    const missing = refused(
      await service.unlink(
        note.slug,
        { linkId: source.link.id },
        USER_IN_PROJECT,
      ),
    );
    expect(missing.code).toBe("link_not_found");

    // A link id borrowed from another note never unlinks through this one.
    const other = await capture(USER_IN_PROJECT, {
      hook: "Another note to link",
    });
    const otherLink = ok(
      await service.link(
        other.slug,
        { kind: "about", artifact: { kind: "ticket", ticketId: "ticket-1" } },
        USER_IN_PROJECT,
      ),
    );
    const borrowed = refused(
      await service.unlink(
        note.slug,
        { linkId: otherLink.link.id },
        USER_IN_PROJECT,
      ),
    );
    expect(borrowed.code).toBe("link_not_found");
    expect(await repo.listLinks(other.id)).toHaveLength(1);

    expect(changes()).toEqual([
      "created",
      "linked",
      "linked",
      "unlinked",
      "unlinked",
      "created",
      "linked",
    ]);
    expect(events()[3]).toMatchObject({
      change: "unlinked",
      link: { id: about.link.id, kind: "about" },
      authorKind: "agent",
    });
  });
});

describe("archive, restore, delete (R1, R9)", () => {
  it("archives reversibly, hides the note from bare resolution, and publishes archived", async () => {
    const note = await capture(USER_IN_PROJECT);
    const archived = ok(
      await service.archive(note.slug, { baseRevision: 1 }, AGENT_IN_PROJECT),
    );
    expect(archived.lifecycle).toBe("archived");
    expect(archived.revision).toBe(2);

    expect(
      refused(await service.resolve(note.slug, USER_IN_PROJECT)).code,
    ).toBe("not_found");
    expect(
      ok(
        await service.resolve(note.slug, USER_IN_PROJECT, {
          includeArchived: true,
        }),
      ).id,
    ).toBe(note.id);
    expect(events()[1]).toMatchObject({
      change: "archived",
      lifecycle: "archived",
      revision: 2,
      authorKind: "agent",
    });
  });

  it("archive states a stale revision and is refused without publishing", async () => {
    const note = await capture(USER_IN_PROJECT);
    ok(
      await service.update(
        note.slug,
        { baseRevision: 1, body: "moved on" },
        USER_IN_PROJECT,
      ),
    );
    const stale = refused(
      await service.archive(note.slug, { baseRevision: 1 }, USER_IN_PROJECT),
    );
    expect(stale.code).toBe("stale_revision");
    expect(changes()).toEqual(["created", "updated"]);
  });

  it("restores a historical snapshot forward as a new head and publishes restored", async () => {
    const note = await capture(USER_IN_PROJECT, {
      hook: "The original hook text",
    });
    ok(
      await service.update(
        note.slug,
        { baseRevision: 1, hook: "The edited hook text" },
        USER_IN_PROJECT,
      ),
    );

    const restored = ok(
      await service.restore(note.slug, { revision: 1 }, USER_IN_PROJECT),
    );
    expect(restored.hook).toBe("The original hook text");
    expect(restored.revision).toBe(3);
    const revisions = await repo.listRevisions(note.id);
    expect(revisions.map((r) => [r.origin, r.restoredFromRevision])).toEqual([
      ["create", null],
      ["edit", null],
      ["restore", 1],
    ]);
    expect(events()[2]).toMatchObject({ change: "restored", revision: 3 });
  });

  it("restoring an archived note's earlier snapshot brings it back", async () => {
    const note = await capture(USER_IN_PROJECT);
    ok(await service.archive(note.slug, {}, USER_IN_PROJECT));
    const restored = ok(
      await service.restore(note.slug, { revision: 1 }, USER_IN_PROJECT),
    );
    expect(restored.lifecycle).toBe("active");
    expect(ok(await service.resolve(note.slug, USER_IN_PROJECT)).id).toBe(
      note.id,
    );
  });

  it("refuses a missing revision and publishes nothing", async () => {
    const note = await capture(USER_IN_PROJECT);
    const error = refused(
      await service.restore(note.slug, { revision: 9 }, USER_IN_PROJECT),
    );
    expect(error).toMatchObject({ code: "revision_not_found", revision: 9 });
    expect(changes()).toEqual(["created"]);
  });

  it("deletes permanently, reaching archived notes too, and publishes deleted", async () => {
    const note = await capture(USER_IN_PROJECT);
    ok(await service.archive(note.slug, {}, USER_IN_PROJECT));

    const deleted = ok(await service.delete(note.slug, USER_IN_PROJECT));
    expect(deleted.id).toBe(note.id);
    expect(await repo.find(note.id)).toBeNull();
    expect(events()[2]).toMatchObject({
      change: "deleted",
      memoryId: note.id,
      lifecycle: "archived",
    });

    const gone = refused(await service.delete(note.slug, USER_IN_PROJECT));
    expect(gone.code).toBe("not_found");
    expect(changes()).toEqual(["created", "archived", "deleted"]);
  });
});

describe("supersession (R1.3)", () => {
  it("archives the predecessor in the same act, points forward, and publishes both changes", async () => {
    const predecessor = await capture(USER_IN_PROJECT, {
      hook: "The old understanding of the cache",
    });
    const result = ok(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "The corrected understanding of the cache",
          supersedes: predecessor.slug,
        },
        AGENT_IN_PROJECT,
      ),
    );
    const successor = result.note;
    expect(successor.supersedesId).toBe(predecessor.id);

    const archived = await repo.find(predecessor.id);
    expect(archived).toMatchObject({
      lifecycle: "archived",
      supersededById: successor.id,
      revision: 2,
    });
    expect(
      refused(await service.resolve(predecessor.slug, USER_IN_PROJECT)).code,
    ).toBe("not_found");

    expect(changes()).toEqual(["created", "created", "superseded"]);
    expect(events()[2]).toMatchObject({
      change: "superseded",
      memoryId: predecessor.id,
      lifecycle: "archived",
      revision: 2,
      authorKind: "agent",
    });
  });

  it("lets a successor take its predecessor's slug", async () => {
    const predecessor = await capture(USER_IN_PROJECT, {
      hook: "Cache lesson",
    });
    const successor = ok(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "The cache lesson, restated with the real numbers",
          slug: predecessor.slug,
          supersedes: predecessor.slug,
        },
        USER_IN_PROJECT,
      ),
    ).note;
    expect(successor.slug).toBe(predecessor.slug);
  });

  it("refuses a predecessor the actor cannot see and creates nothing", async () => {
    const predecessor = await capture(USER_IN_PROJECT);
    const error = refused(
      await service.create(
        {
          scope: "project",
          kind: "lesson",
          hook: "An attempt to supersede across projects",
          supersedes: predecessor.slug,
        },
        AGENT_ELSEWHERE,
      ),
    );
    expect(error).toMatchObject({
      code: "not_found",
      handle: predecessor.slug,
    });
    expect(
      await repo.list({
        visibility: AGENT_ELSEWHERE.visibility,
        includeArchived: true,
      }),
    ).toEqual([]);
    expect(changes()).toEqual(["created"]);
  });
});

describe("global proposals (R9.1)", () => {
  it("an agent's global create lands proposed while a user's lands active", async () => {
    const proposed = await capture(AGENT_IN_PROJECT, {
      scope: "global",
      hook: "Every project's CC guidance ships through skills, never steering",
    });
    expect(proposed).toMatchObject({
      scope: "global",
      projectPath: null,
      lifecycle: "proposed",
      createdBy: "agent",
    });

    const immediate = await capture(USER_GLOBAL, {
      scope: "global",
      hook: "A human's global note is active at once",
    });
    expect(immediate.lifecycle).toBe("active");
    expect(events()[0]).toMatchObject({
      change: "created",
      lifecycle: "proposed",
    });

    const proposals = ok(
      await service.list({ lifecycle: "proposed" }, USER_GLOBAL),
    );
    expect(proposals.map((n) => n.id)).toEqual([proposed.id]);
  });

  it("approval activates the proposal without rewriting it", async () => {
    const proposed = await capture(AGENT_IN_PROJECT, {
      scope: "global",
      hook: "Every project's CC guidance ships through skills, never steering",
      body: "Alex's rule: all-project guidance is a skill or cctl help.",
      aliases: ["guidance-portability"],
    });

    const approved = ok(
      await service.approveProposal(
        proposed.slug,
        { baseRevision: 1 },
        USER_GLOBAL,
      ),
    );
    expect(approved).toMatchObject({
      id: proposed.id,
      lifecycle: "active",
      revision: 2,
      hook: proposed.hook,
      body: proposed.body,
      slug: proposed.slug,
      aliases: proposed.aliases,
      createdBy: "agent",
      authorConversationId: "conv-project",
    });
    const revisions = await repo.listRevisions(proposed.id);
    expect(revisions[1]).toMatchObject({
      origin: "edit",
      authorKind: "user",
      snapshot: { lifecycle: "active", hook: proposed.hook },
    });
    expect(events()[1]).toMatchObject({
      change: "proposal-approved",
      lifecycle: "active",
      revision: 2,
      authorKind: "user",
    });
  });

  it("rejection archives the proposal and publishes proposal-rejected", async () => {
    const proposed = await capture(AGENT_IN_PROJECT, {
      scope: "global",
      hook: "A global claim the human declines",
    });
    const rejected = ok(
      await service.rejectProposal(
        proposed.slug,
        { baseRevision: 1 },
        USER_GLOBAL,
      ),
    );
    expect(rejected.lifecycle).toBe("archived");
    expect(events()[1]).toMatchObject({
      change: "proposal-rejected",
      lifecycle: "archived",
    });
  });

  it("an agent can neither approve nor reject, and nothing is published", async () => {
    const proposed = await capture(AGENT_IN_PROJECT, {
      scope: "global",
      hook: "A global claim awaiting a human",
    });
    const approve = refused(
      await service.approveProposal(
        proposed.slug,
        { baseRevision: 1 },
        AGENT_IN_SESSION,
      ),
    );
    expect(approve).toMatchObject({
      code: "human_act_required",
      act: "approve-proposal",
    });
    const reject = refused(
      await service.rejectProposal(
        proposed.slug,
        { baseRevision: 1 },
        AGENT_IN_PROJECT,
      ),
    );
    expect(reject).toMatchObject({
      code: "human_act_required",
      act: "reject-proposal",
    });
    expect((await repo.find(proposed.id))?.lifecycle).toBe("proposed");
    expect(changes()).toEqual(["created"]);
  });

  it("approving a note that is not a proposal is refused", async () => {
    const active = await capture(USER_IN_PROJECT);
    const error = refused(
      await service.approveProposal(
        active.slug,
        { baseRevision: 1 },
        USER_IN_PROJECT,
      ),
    );
    expect(error).toMatchObject({ code: "not_proposed", lifecycle: "active" });
    expect(changes()).toEqual(["created"]);
  });

  it("a decision on a revision the human did not review is refused before anything is published", async () => {
    const proposed = await capture(AGENT_IN_PROJECT, {
      scope: "global",
      hook: "A global claim as first proposed",
    });
    const edited = ok(
      await service.update(
        proposed.slug,
        { baseRevision: 1, hook: "A global claim rewritten after review" },
        AGENT_IN_PROJECT,
      ),
    );
    expect(edited).toMatchObject({ revision: 2, lifecycle: "proposed" });

    const stale = refused(
      await service.approveProposal(
        proposed.slug,
        { baseRevision: 1 },
        USER_GLOBAL,
      ),
    );
    expect(stale).toMatchObject({
      code: "stale_revision",
      currentRevision: 2,
      baseRevision: 1,
    });
    expect(stale.message).toContain("2");

    const current = await repo.find(proposed.id);
    expect(current).toMatchObject({
      lifecycle: "proposed",
      revision: 2,
      hook: "A global claim rewritten after review",
    });
    expect(changes()).toEqual(["created", "updated"]);
  });

  it("an approval that arrives after a rejection is refused and the rejection stands", async () => {
    const proposed = await capture(AGENT_IN_PROJECT, {
      scope: "global",
      hook: "A global claim two humans decide at once",
    });
    ok(
      await service.rejectProposal(
        proposed.slug,
        { baseRevision: 1 },
        USER_GLOBAL,
      ),
    );

    const late = refused(
      await service.approveProposal(
        proposed.id,
        { baseRevision: 1 },
        USER_GLOBAL,
      ),
    );
    expect(late).toMatchObject({
      code: "stale_revision",
      currentRevision: 2,
      baseRevision: 1,
    });

    expect(await repo.find(proposed.id)).toMatchObject({
      lifecycle: "archived",
      revision: 2,
    });
    expect(changes()).toEqual(["created", "proposal-rejected"]);
  });
});

describe("contribution policy (R10.1, D7)", () => {
  const OFF_POLICY: MemoryPolicyResolution = {
    role: "validator",
    read: { value: "off", source: "global" },
    contribute: { value: "off", source: "workflow" },
  };
  const OFF_FOR_VALIDATORS: MemoryContributionDecision = {
    allowed: false,
    reason: "contribution_off",
    policy: OFF_POLICY,
  };

  function expectPolicyRefusal(
    result: MemoryResult<unknown>,
    verb: string,
  ): void {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("policy_refused");
    if (result.error.code !== "policy_refused") return;
    expect(result.error.verb).toBe(verb);
    expect(result.error.reason).toBe("contribution_off");
    expect(result.error.policy).toEqual(OFF_POLICY);
    // The refusal names the policy, its tier, and what stays available.
    expect(result.error.message).toContain("validator");
    expect(result.error.message).toContain("contribute");
    expect(result.error.message).toContain("workflow");
    expect(result.error.instruction).toContain("recall");
  }

  it("refuses every mutation verb for a writer whose contribution is off, and persists and publishes nothing", async () => {
    const seeded = ok(
      await service.create(
        { scope: "project", kind: "lesson", hook: "A durable lesson" },
        AGENT_IN_PROJECT,
      ),
    ).note;
    const sessionNote = ok(
      await service.create(
        { scope: "session", kind: "lesson", hook: "A session lesson" },
        AGENT_IN_SESSION,
      ),
    ).note;
    const proposal = ok(
      await service.create(
        { scope: "global", kind: "lesson", hook: "A global proposal" },
        AGENT_IN_PROJECT,
      ),
    ).note;
    published = [];
    gateDecision = OFF_FOR_VALIDATORS;

    expectPolicyRefusal(
      await service.create(
        { scope: "project", kind: "lesson", hook: "Refused capture" },
        AGENT_IN_PROJECT,
      ),
      "create",
    );
    expectPolicyRefusal(
      await service.update(
        seeded.slug,
        { baseRevision: seeded.revision, hook: "Refused edit" },
        AGENT_IN_PROJECT,
      ),
      "update",
    );
    expectPolicyRefusal(
      await service.link(
        seeded.slug,
        { kind: "about", artifact: { kind: "ticket", ticketId: "ticket-1" } },
        AGENT_IN_PROJECT,
      ),
      "link",
    );
    expectPolicyRefusal(
      await service.unlink(seeded.slug, { linkId: "link-x" }, AGENT_IN_PROJECT),
      "unlink",
    );
    expectPolicyRefusal(
      await service.markReviewed(
        seeded.slug,
        { target: "note" },
        AGENT_IN_PROJECT,
      ),
      "mark-reviewed",
    );
    expectPolicyRefusal(
      await service.promote(sessionNote.slug, {}, AGENT_IN_SESSION),
      "promote",
    );
    expectPolicyRefusal(
      await service.archive(seeded.slug, {}, AGENT_IN_PROJECT),
      "archive",
    );
    expectPolicyRefusal(
      await service.restore(seeded.slug, { revision: 1 }, AGENT_IN_PROJECT),
      "restore",
    );
    expectPolicyRefusal(
      await service.delete(seeded.slug, AGENT_IN_PROJECT),
      "delete",
    );
    expectPolicyRefusal(
      await service.approveProposal(
        proposal.slug,
        { baseRevision: proposal.revision },
        AGENT_IN_PROJECT,
      ),
      "approve-proposal",
    );
    expectPolicyRefusal(
      await service.rejectProposal(
        proposal.slug,
        { baseRevision: proposal.revision },
        AGENT_IN_PROJECT,
      ),
      "reject-proposal",
    );

    expect(published).toEqual([]);
    const stillThere = ok(
      await service.get(seeded.slug, AGENT_IN_PROJECT),
    ).note;
    expect(stillThere.revision).toBe(seeded.revision);
    expect(stillThere.hook).toBe("A durable lesson");
    expect(stillThere.lifecycle).toBe("active");
  });

  it("keeps every retrieval verb available to the same writer", async () => {
    const seeded = ok(
      await service.create(
        { scope: "project", kind: "lesson", hook: "Readable under off" },
        AGENT_IN_PROJECT,
      ),
    ).note;
    gateDecision = OFF_FOR_VALIDATORS;

    expect(ok(await service.get(seeded.slug, AGENT_IN_PROJECT)).note.id).toBe(
      seeded.id,
    );
    expect(ok(await service.resolve(seeded.slug, AGENT_IN_PROJECT)).id).toBe(
      seeded.id,
    );
    expect(
      ok(await service.list({}, AGENT_IN_PROJECT)).map((note) => note.id),
    ).toContain(seeded.id);
    expect(
      ok(await service.listRevisions(seeded.slug, AGENT_IN_PROJECT)),
    ).toHaveLength(1);
  });

  it("never gates a human: the Library repairs whatever the lanes may not", async () => {
    gateDecision = OFF_FOR_VALIDATORS;
    const created = await service.create(
      { scope: "project", kind: "lesson", hook: "Human capture" },
      USER_IN_PROJECT,
    );
    expect(created.ok).toBe(true);
  });

  it("refuses a writer Command Center cannot place, naming the conversation", async () => {
    gateDecision = {
      allowed: false,
      reason: "caller_unresolved",
      conversationId: "conv-project",
    };
    const result = await service.create(
      { scope: "project", kind: "lesson", hook: "Ghost capture" },
      AGENT_IN_PROJECT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("policy_refused");
    if (result.error.code !== "policy_refused") return;
    expect(result.error.reason).toBe("caller_unresolved");
    expect(result.error.policy).toBeNull();
    expect(result.error.message).toContain("conv-project");
  });
});

describe("handle resolution (R4)", () => {
  it("resolves by internal id, slug, and alias within the actor's visibility", async () => {
    const note = await capture(USER_IN_PROJECT, { aliases: ["fts"] });
    expect(ok(await service.resolve(note.id, AGENT_IN_PROJECT)).id).toBe(
      note.id,
    );
    expect(ok(await service.resolve(note.slug, AGENT_IN_SESSION)).id).toBe(
      note.id,
    );
    expect(ok(await service.resolve("fts", USER_IN_PROJECT)).id).toBe(note.id);
    expect(refused(await service.resolve(note.id, AGENT_ELSEWHERE)).code).toBe(
      "not_found",
    );
  });

  it("returns a labeled disambiguation for a slug in two visible scopes and narrows by scope", async () => {
    const global = await capture(USER_GLOBAL, {
      scope: "global",
      hook: "Shared slug here",
      slug: "shared-slug",
    });
    const project = await capture(USER_IN_PROJECT, {
      hook: "Shared slug here",
      slug: "shared-slug",
    });

    const ambiguous = refused(
      await service.resolve("shared-slug", USER_IN_PROJECT),
    );
    expect(ambiguous.code).toBe("ambiguous_handle");
    if (ambiguous.code !== "ambiguous_handle") throw new Error("unreachable");
    expect(ambiguous.candidates.map((c) => [c.scope, c.memoryId])).toEqual([
      ["global", global.id],
      ["project", project.id],
    ]);
    expect(ambiguous.candidates[1]).toMatchObject({
      slug: "shared-slug",
      projectPath: PROJECT_PATH,
    });

    expect(
      ok(
        await service.resolve("shared-slug", USER_IN_PROJECT, {
          scope: "project",
        }),
      ).id,
    ).toBe(project.id);
    // Outside the project only the global one is visible: no ambiguity.
    expect(ok(await service.resolve("shared-slug", USER_GLOBAL)).id).toBe(
      global.id,
    );
  });

  it("get returns the note with its links; list filters by scope and hides archived by default", async () => {
    const note = await capture(USER_IN_PROJECT);
    const link = ok(
      await service.link(
        note.slug,
        { kind: "about", artifact: { kind: "ticket", ticketId: "ticket-74" } },
        USER_IN_PROJECT,
      ),
    );
    const fetched = ok(await service.get(note.slug, USER_IN_PROJECT));
    expect(fetched.note.id).toBe(note.id);
    expect(fetched.links).toEqual([link.link]);

    const globalNote = await capture(USER_GLOBAL, {
      scope: "global",
      hook: "A global note beside the project one",
    });
    const archivedNote = await capture(USER_IN_PROJECT, {
      hook: "Soon archived",
    });
    ok(await service.archive(archivedNote.slug, {}, USER_IN_PROJECT));

    const all = ok(await service.list({}, USER_IN_PROJECT));
    expect(all.map((n) => n.id).sort()).toEqual(
      [globalNote.id, note.id].sort(),
    );
    const projectOnly = ok(
      await service.list({ scope: "project" }, USER_IN_PROJECT),
    );
    expect(projectOnly.map((n) => n.id)).toEqual([note.id]);
    const withArchived = ok(
      await service.list({ includeArchived: true }, USER_IN_PROJECT),
    );
    expect(withArchived).toHaveLength(3);
    expect(
      ok(await service.listRevisions(note.slug, USER_IN_PROJECT)),
    ).toHaveLength(1);
  });
});
