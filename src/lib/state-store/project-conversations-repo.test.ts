import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  createProjectConversationsRepo,
  type ProjectConversationsRepo,
} from "./project-conversations-repo";
import { PersistenceError } from "../shared/errors";
import type { ConversationState } from "@/lib/conversations/schemas";

type Db = InstanceType<typeof Database>;

function makeProjectConversation(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return {
    id: overrides.id,
    scope: "project",
    nameOrigin: "default",
    name: overrides.name ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    status: overrides.status ?? "new",
    promptCount: overrides.promptCount ?? 0,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    lastActivityAt: overrides.lastActivityAt ?? "2025-01-01T00:00:00.000Z",
    source: "cc",
    summary: overrides.summary ?? null,
    archived: overrides.archived ?? false,
    open: overrides.open ?? true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: overrides.pendingPromptText ?? null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: overrides.agentBackend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    unread: overrides.unread ?? false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    spawnedSessionIds: overrides.spawnedSessionIds,
  };
}

describe("ProjectConversationsRepo", () => {
  let db: Db;
  let repo: ProjectConversationsRepo;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare(`INSERT INTO projects (root_path) VALUES ('/repo-a')`).run();
    db.prepare(`INSERT INTO projects (root_path) VALUES ('/repo-b')`).run();
    repo = createProjectConversationsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips a project conversation with scope:project and open", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));
    const found = repo.findByKey("/repo-a", "c1");
    expect(found).not.toBeNull();
    expect(found?.scope).toBe("project");
    expect(found?.open).toBe(true);
    expect(found?.id).toBe("c1");
  });

  it("persists backendRef as canonical bytes and round-trips the canonical shape", () => {
    repo.upsert(
      "/repo-a",
      makeProjectConversation({
        id: "c-canon",
        agentBackend: "codex",
        backendRef: { backend: "codex", ref: "thr-plc" },
      }),
    );

    const raw = db
      .prepare(`SELECT backend_ref FROM project_conversations WHERE id = ?`)
      .get("c-canon") as { backend_ref: string | null };
    expect(JSON.parse(raw.backend_ref!)).toEqual({
      backend: "codex",
      ref: "thr-plc",
    });

    const found = repo.findByKey("/repo-a", "c-canon");
    expect(found?.backendRef).toEqual({ backend: "codex", ref: "thr-plc" });
  });

  it("decodes a legacy-shape backend_ref row to the canonical ref", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c-legacy" }));
    db.prepare(
      `UPDATE project_conversations SET backend_ref = ? WHERE id = ?`,
    ).run(
      JSON.stringify({ backend: "claude", sessionId: "sess-old" }),
      "c-legacy",
    );

    const found = repo.findByKey("/repo-a", "c-legacy");
    expect(found?.backendRef).toEqual({ backend: "claude", ref: "sess-old" });
  });

  it("defaults spawnedSessionIds to [] for a row written without it", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));
    const found = repo.findByKey("/repo-a", "c1");
    expect(found?.spawnedSessionIds).toEqual([]);
  });

  it("round-trips a populated spawnedSessionIds list", () => {
    repo.upsert(
      "/repo-a",
      makeProjectConversation({ id: "c1", spawnedSessionIds: ["s1", "s2"] }),
    );
    const found = repo.findByKey("/repo-a", "c1");
    expect(found?.spawnedSessionIds).toEqual(["s1", "s2"]);
  });

  it("findAll returns the same array reference when nothing changed", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));
    const first = repo.findAll();
    const second = repo.findAll();
    expect(second).toBe(first);
  });

  it("does NOT execute the findAll statement on a warm-version cache hit (F9)", () => {
    // Fresh db + counting wrapper so we can observe raw SQL executions, proving
    // the version hit short-circuits BEFORE the SQLite fetch, not just before
    // the Zod parse (PERFORMANCE.md §50-62).
    const local = _createTestDb({ inMemory: true });
    local.prepare(`INSERT INTO projects (root_path) VALUES ('/repo-a')`).run();
    const counter = { count: 0 };
    const realPrepare = local.prepare.bind(local);
    local.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (
        !/FROM project_conversations[\s\S]*ORDER BY project_path ASC/.test(sql)
      ) {
        return stmt;
      }
      const realAll = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        counter.count += 1;
        return realAll(...args);
      }) as typeof stmt.all;
      return stmt;
    }) as typeof local.prepare;
    const localRepo = createProjectConversationsRepo(local);
    localRepo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));

    localRepo.findAll();
    expect(counter.count).toBe(1);

    // Warm hit: version unchanged, so no SQL fetch may run.
    localRepo.findAll();
    expect(counter.count).toBe(1);

    // A mutation bumps the version; the next findAll re-fetches once.
    localRepo.upsert("/repo-a", makeProjectConversation({ id: "c2" }));
    localRepo.findAll();
    expect(counter.count).toBe(2);

    local.close();
  });

  it("findAll returns a new reference after upsert, setOpen, and setArchived", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));
    const a = repo.findAll();

    repo.upsert("/repo-a", makeProjectConversation({ id: "c2" }));
    const b = repo.findAll();
    expect(b).not.toBe(a);

    repo.setOpen("/repo-a", "c1", false);
    const c = repo.findAll();
    expect(c).not.toBe(b);

    repo.setArchived("/repo-a", "c1", true);
    const d = repo.findAll();
    expect(d).not.toBe(c);
  });

  it("does not bump the cache version when a focused setter changes no row", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));
    const first = repo.findAll();
    const changed = repo.setOpen("/repo-a", "missing-id", false);
    expect(changed).toBe(false);
    expect(repo.findAll()).toBe(first);
  });

  it("isolates conversations per project", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "a1" }));
    repo.upsert("/repo-b", makeProjectConversation({ id: "b1" }));
    expect(repo.findByProject("/repo-a").map((c) => c.id)).toEqual(["a1"]);
    expect(repo.findByProject("/repo-b").map((c) => c.id)).toEqual(["b1"]);
    expect(repo.findByKey("/repo-a", "b1")).toBeNull();
  });

  it("setOpen / setArchived / setPendingPromptText persist", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));
    expect(repo.setOpen("/repo-a", "c1", false)).toBe(true);
    expect(repo.findByKey("/repo-a", "c1")?.open).toBe(false);
    expect(repo.setArchived("/repo-a", "c1", true)).toBe(true);
    expect(repo.findByKey("/repo-a", "c1")?.archived).toBe(true);
    expect(repo.setPendingPromptText("/repo-a", "c1", "draft")).toBe(true);
    expect(repo.findByKey("/repo-a", "c1")?.pendingPromptText).toBe("draft");
  });

  it("delete removes the row and updates findAll", () => {
    repo.upsert("/repo-a", makeProjectConversation({ id: "c1" }));
    repo.delete("c1");
    expect(repo.findById("c1")).toBeNull();
    expect(repo.findAll()).toHaveLength(0);
  });

  it("throws a PersistenceError at the boundary for a corrupt row", () => {
    db.prepare(
      `INSERT INTO project_conversations
         (id, project_path, status, created_at, last_activity_at)
       VALUES ('bad', '/repo-a', 'not-a-status', '2025-01-01', '2025-01-01')`,
    ).run();
    expect(() => repo.findById("bad")).toThrow(PersistenceError);
  });
});
