import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { buildConversation } from "@/lib/conversations/build-conversation";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createStateStore } from "./store";

/**
 * Durability + cache-coherence contract for the focused session-lifecycle
 * mutations in `sessions/service.ts` (`createSessionRow` / `deleteSessionRow` /
 * `retargetChildrenToMain` / `applyFusedSessionDelete` / `deleteProjectRow`).
 *
 * Durability is proven by reloading through a FRESH `createStateStore` over the
 * same `:memory:` DB — reading through a store whose repos never saw the writes,
 * so only genuinely-persisted SQLite state can satisfy an assertion (a JS-object
 * fake cannot pass). Cache coherence is proven on the SAME store: a warm
 * accessor must reflect a cascade delete, since the FK `ON DELETE CASCADE`
 * removes child rows behind the child repos' backs and only an explicit
 * invalidation keeps their parsed-row caches honest.
 */

const PROJECT = "/repo";

function makeSession(
  name: string,
  overrides: Partial<SessionState> = {},
): SessionState {
  return sessionStateSchema.parse({
    sessionName: name,
    worktreePath: `${PROJECT}/.worktrees/${name}`,
    branchName: `csm/${name}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    conversations: [
      buildConversation({
        id: `conv-${name}`,
        scope: "session",
        name: `${name} 1`,
        createdAt: "2026-01-01T00:00:00Z",
        agentBackend: "claude",
      }),
    ],
    ...overrides,
  });
}

function makeProjectConversation(id: string) {
  return conversationStateSchema.parse({
    id,
    scope: "project",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    open: true,
  });
}

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

/**
 * A fresh store over the SAME DB — cold repos/caches — so every read below hits
 * SQLite rather than the write-side store's warm cache. This is the durability
 * assertion: only actually-persisted state survives the reload.
 */
function reload() {
  return createStateStore({ db: fixture.db });
}

describe("createSessionRow — durability via reload", () => {
  it("persists the session, its child conversation, and the (missing) FK-parent project", async () => {
    // No project row yet: createSessionRow must create the FK parent.
    await fixture.store.createSessionRow(PROJECT, makeSession("s1"));

    const store = reload();
    const reloaded = await store.getSession(PROJECT, "s1");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.sessionName).toBe("s1");
    expect(reloaded!.branchName).toBe("csm/s1");
    expect(reloaded!.conversations).toHaveLength(1);
    expect(reloaded!.conversations[0]!.id).toBe("conv-s1");
  });
});

describe("deleteSessionRow — durability via reload", () => {
  it("removes the session row and cascades its conversation", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("s1"));
    expect(await reload().getSession(PROJECT, "s1")).not.toBeNull();

    await fixture.store.deleteSessionRow(PROJECT, "s1", "rollbackSession");

    const store = reload();
    expect(await store.getSession(PROJECT, "s1")).toBeNull();
    // FK cascade removed the child conversation too.
    expect(await store.getConversation(PROJECT, "s1", "conv-s1")).toBeNull();
    expect(await store.getSessionConversations(PROJECT, "s1")).toEqual([]);
  });

  it("is a no-op for a session that does not exist", async () => {
    await expect(
      fixture.store.deleteSessionRow(PROJECT, "ghost", "rollbackSession"),
    ).resolves.toBeUndefined();
  });
});

describe("retargetChildrenToMain — durability via reload", () => {
  it("points direct children of a parent at main and clears their parent link", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("parent"));
    await fixture.store.createSessionRow(
      PROJECT,
      makeSession("child", {
        parentSessionName: "parent",
        targetBranch: "csm/parent",
      }),
    );

    await fixture.store.retargetChildrenToMain(PROJECT, "parent");

    const child = await reload().getSession(PROJECT, "child");
    expect(child!.parentSessionName).toBeNull();
    expect(child!.targetBranch).toBe("main");
  });
});

describe("applyFusedSessionDelete — durability via reload", () => {
  it("deletes the named sessions and retargets children of the deleted parents in one pass", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("parent"));
    await fixture.store.createSessionRow(
      PROJECT,
      makeSession("child", {
        parentSessionName: "parent",
        targetBranch: "csm/parent",
      }),
    );
    await fixture.store.createSessionRow(PROJECT, makeSession("other"));

    await fixture.store.applyFusedSessionDelete(
      PROJECT,
      ["parent", "other"],
      "bulkDeleteSessions",
    );

    const store = reload();
    expect(await store.getSession(PROJECT, "parent")).toBeNull();
    expect(await store.getSession(PROJECT, "other")).toBeNull();
    // The deleted parent's conversation cascaded away.
    expect(
      await store.getConversation(PROJECT, "parent", "conv-parent"),
    ).toBeNull();
    const child = await store.getSession(PROJECT, "child");
    expect(child).not.toBeNull();
    expect(child!.parentSessionName).toBeNull();
    expect(child!.targetBranch).toBe("main");
  });

  it("is a no-op for an empty deletion set", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("keep"));
    await fixture.store.applyFusedSessionDelete(PROJECT, [], "deleteSession");
    expect(await reload().getSession(PROJECT, "keep")).not.toBeNull();
  });
});

describe("deleteProjectRow — durability via reload", () => {
  it("removes the project row, cascades its sessions/conversations/project conversations, and drops archived/pinned membership", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("s1"));
    await fixture.store.createProjectConversation(
      PROJECT,
      makeProjectConversation("plc-1"),
    );
    await fixture.store.setProjectArchived(PROJECT, true);
    await fixture.store.setProjectPinned(PROJECT, true);
    expect(await reload().getArchivedProjects()).toContain(PROJECT);

    await fixture.store.deleteProjectRow(
      PROJECT,
      [],
      "2026-01-02T00:00:00.000Z",
    );

    const store = reload();
    expect(await store.getSession(PROJECT, "s1")).toBeNull();
    expect(await store.getConversation(PROJECT, "s1", "conv-s1")).toBeNull();
    expect(await store.getProjectConversations(PROJECT)).toEqual([]);
    // Archived/pinned lists are derived from the projects row, so the delete
    // removes membership without any array bookkeeping.
    expect(await store.getArchivedProjects()).not.toContain(PROJECT);
    expect(await store.getPinnedProjects()).not.toContain(PROJECT);
  });

  it("bumps deduplicated external relationship neighbors in the same transaction as the project cascade", async () => {
    const externalProject = "/other";
    fixture.db
      .prepare("INSERT INTO projects (root_path) VALUES (?), (?)")
      .run(PROJECT, externalProject);
    const insertTicket = fixture.db.prepare(
      `INSERT INTO tickets
         (id, project_path, ticket_number, title, description, work_type,
          status, created_at, updated_at)
       VALUES (?, ?, 1, ?, '', 'feature', 'not_started', ?, ?)`,
    );
    insertTicket.run(
      "deleted-ticket",
      PROJECT,
      "Deleted ticket",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    insertTicket.run(
      "external-ticket",
      externalProject,
      "External ticket",
      "2026-01-01T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    );
    fixture.db
      .prepare(
        `INSERT INTO ticket_relationships
           (id, relation_type, source_ticket_id, target_ticket_id, description,
            created_at, updated_at)
         VALUES ('cross-project', 'depends_on', 'deleted-ticket',
                 'external-ticket', '', ?, ?)`,
      )
      .run("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");

    await fixture.store.deleteProjectRow(
      PROJECT,
      ["external-ticket", "external-ticket"],
      "2026-01-02T00:00:00.000Z",
    );

    expect(
      fixture.db
        .prepare("SELECT updated_at FROM tickets WHERE id = ?")
        .get("external-ticket"),
    ).toEqual({ updated_at: "2026-01-03T00:00:00.001Z" });
    expect(
      fixture.db
        .prepare("SELECT 1 FROM ticket_relationships WHERE id = ?")
        .get("cross-project"),
    ).toBeUndefined();
    expect(
      fixture.db
        .prepare("SELECT 1 FROM projects WHERE root_path = ?")
        .get(PROJECT),
    ).toBeUndefined();
  });

  it("rolls back external neighbor revisions when project deletion fails", async () => {
    const externalProject = "/other";
    fixture.db
      .prepare("INSERT INTO projects (root_path) VALUES (?), (?)")
      .run(PROJECT, externalProject);
    const insertTicket = fixture.db.prepare(
      `INSERT INTO tickets
         (id, project_path, ticket_number, title, description, work_type,
          status, created_at, updated_at)
       VALUES (?, ?, 1, ?, '', 'feature', 'not_started', ?, ?)`,
    );
    insertTicket.run(
      "deleted-ticket",
      PROJECT,
      "Deleted ticket",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    insertTicket.run(
      "external-ticket",
      externalProject,
      "External ticket",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    fixture.db.exec(`
      CREATE TRIGGER refuse_project_delete
      BEFORE DELETE ON projects
      WHEN OLD.root_path = '${PROJECT}'
      BEGIN
        SELECT RAISE(ABORT, 'refused');
      END
    `);

    await expect(
      fixture.store.deleteProjectRow(
        PROJECT,
        ["external-ticket"],
        "2026-01-02T00:00:00.000Z",
      ),
    ).rejects.toThrow("refused");

    expect(
      fixture.db
        .prepare("SELECT updated_at FROM tickets WHERE id = ?")
        .get("external-ticket"),
    ).toEqual({ updated_at: "2026-01-01T00:00:00.000Z" });
    expect(
      fixture.db
        .prepare("SELECT 1 FROM projects WHERE root_path = ?")
        .get(PROJECT),
    ).toEqual({ 1: 1 });
  });
});

/**
 * These read through the SAME store that performed the delete, after warming the
 * accessor's cache. Without the explicit cache invalidation in the focused
 * delete setters, a cascade-removed child row would keep being served from the
 * warm parsed-row cache (the cascade never routes through the child repo's own
 * `delete`). Each assertion is red against an un-invalidated cache.
 */
describe("cascade delete — warm cache invalidation (same store)", () => {
  it("warm getSessionConversations returns nothing after deleteSessionRow", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("s1"));
    // Warm the per-session conversations cache.
    expect(
      await fixture.store.getSessionConversations(PROJECT, "s1"),
    ).toHaveLength(1);

    await fixture.store.deleteSessionRow(PROJECT, "s1", "rollbackSession");

    expect(await fixture.store.getSessionConversations(PROJECT, "s1")).toEqual(
      [],
    );
  });

  it("warm getSessionConversations returns nothing after applyFusedSessionDelete", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("s1"));
    expect(
      await fixture.store.getSessionConversations(PROJECT, "s1"),
    ).toHaveLength(1);

    await fixture.store.applyFusedSessionDelete(
      PROJECT,
      ["s1"],
      "bulkDeleteSessions",
    );

    expect(await fixture.store.getSessionConversations(PROJECT, "s1")).toEqual(
      [],
    );
  });

  it("warm getSessionConversations and getProjectConversations return nothing after deleteProjectRow", async () => {
    await fixture.store.createSessionRow(PROJECT, makeSession("s1"));
    await fixture.store.createProjectConversation(
      PROJECT,
      makeProjectConversation("plc-1"),
    );
    // Warm both caches on this store.
    expect(
      await fixture.store.getSessionConversations(PROJECT, "s1"),
    ).toHaveLength(1);
    expect(await fixture.store.getProjectConversations(PROJECT)).toHaveLength(
      1,
    );

    await fixture.store.deleteProjectRow(
      PROJECT,
      [],
      "2026-01-02T00:00:00.000Z",
    );

    expect(await fixture.store.getSessionConversations(PROJECT, "s1")).toEqual(
      [],
    );
    expect(await fixture.store.getProjectConversations(PROJECT)).toEqual([]);
  });
});
