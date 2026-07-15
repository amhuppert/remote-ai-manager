import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  canonicalSessionRow,
  createSessionsRepo,
  diffChangedSessionColumns,
  type SessionsRepo,
} from "./sessions-repo";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: SessionsRepo;

const PROJECT_PATH = "/p1";

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  repo = createSessionsRepo(db);
});

afterEach(() => {
  db.close();
});

function makeMinimalSession(
  overrides: Partial<SessionState> = {},
): SessionState {
  return sessionStateSchema.parse({
    sessionName: "s1",
    worktreePath: "/wt/s1",
    branchName: "csm/s1",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function makeFullSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: "full",
    worktreePath: "/wt/full",
    branchName: "csm/full",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-02-01T12:34:56Z",
    archived: true,
    finished: true,
    source: "imported",
    creationMode: "optimistic",
    tddEnabled: false,
    targetBranch: "develop",
    parentSessionName: "ancestor",
    graphWorkflowExecution: {
      id: "wf-1",
      seedDefinitionId: "seed-1",
      seedDefinitionRevision: 1,
      workingDefinition: {},
      charter: makeTestCharter(),
      status: "pending",
      startedAt: "2026-01-01T00:00:00Z",
    },
    workflowEnvelopes: { env1: { kind: "primitive", payload: 42 } },
    workflowLanes: { lane1: { engine: "noop" } },
    mcpOverrides: {
      servers: {
        stripe: { enabled: true, tools: { charge: { enabled: false } } },
      },
    },
    ...overrides,
  });
}

describe("sessions-repo round-trip contract", () => {
  it("upsert + findByKey round-trips a minimal fixture (all nullable/optional fields default)", () => {
    const fixture = makeMinimalSession();
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findByKey(PROJECT_PATH, fixture.sessionName);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out.sessionName).toBe(fixture.sessionName);
    expect(out.parentSessionName).toBeNull();
    expect(out.graphWorkflowExecution).toBeNull();
    expect(out.workflowEnvelopes).toBeUndefined();
    expect(out.workflowLanes).toBeUndefined();
    expect(out.mcpOverrides).toBeUndefined();
    // The repo materializes an explicit `spawnedFrom: null` for non-spawned
    // rows; the minimal fixture omits it (optional, no default).
    expect(out.spawnedFrom).toBeNull();

    expect(sessionStateSchema.parse(out)).toEqual({
      ...fixture,
      spawnedFrom: null,
    });
  });

  it("upsert leaves the vestigial objective column NULL and defaults creation_mode to 'normal'", () => {
    // The `objective` field was removed from the domain; the physical column is
    // retained (forward/backward-compatible) but the repo binds nothing to it,
    // so a freshly upserted row must read back NULL. The minimal fixture omits
    // creationMode, so the schema/floor default must land it on `normal`.
    repo.upsert(PROJECT_PATH, makeMinimalSession());

    const rawRow = db
      .prepare(
        `SELECT objective, creation_mode FROM sessions
         WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, "s1") as {
      objective: string | null;
      creation_mode: string;
    };

    expect(rawRow.objective).toBeNull();
    expect(rawRow.creation_mode).toBe("normal");
  });

  it("a row inserted with no creation_mode falls back to the floor default 'normal'", () => {
    // Insert bypassing the repo (only the required columns) so the floor's
    // `creation_mode TEXT NOT NULL DEFAULT 'normal'` is what supplies the value.
    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name,
          created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "floor-default",
      "/wt/floor-default",
      "csm/floor-default",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    const out = repo.findByKey(PROJECT_PATH, "floor-default");
    expect(out?.creationMode).toBe("normal");
  });

  it("upsert + findByKey round-trips a fully populated fixture (every field set, JSON sub-trees included)", () => {
    const fixture = makeFullSession();
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findByKey(PROJECT_PATH, fixture.sessionName);
    expect(out).not.toBeNull();
    if (!out) return;

    // The repo materializes `spawnedFrom: null` for the (non-spawned) fixture
    // and no longer persists `graphWorkflowExecution` on the sessions row (it
    // lives in the dedicated graph_workflow_executions table), so it nulls on
    // reload regardless of the fixture value.
    const expected = {
      ...fixture,
      spawnedFrom: null,
      graphWorkflowExecution: null,
    };
    expect(out).toEqual(expected);
    expect(sessionStateSchema.parse(out)).toEqual(expected);
  });

  it("round-trips a chat-spawned session's spawnedFrom origin tag", () => {
    const fixture = makeMinimalSession({
      sessionName: "from-chat",
      spawnedFrom: {
        source: "chat",
        projectName: "my-project",
        conversationId: "conv-1",
      },
    });
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findByKey(PROJECT_PATH, "from-chat");
    expect(out?.spawnedFrom).toEqual({
      source: "chat",
      projectName: "my-project",
      conversationId: "conv-1",
    });
  });

  it("findByProject returns all sessions belonging to a project, no others", () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/p2");
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "a" }));
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "b" }));
    repo.upsert("/p2", makeMinimalSession({ sessionName: "x" }));

    const p1Sessions = repo.findByProject(PROJECT_PATH);
    expect(p1Sessions.map((s) => s.sessionName).sort()).toEqual(["a", "b"]);
    const p2Sessions = repo.findByProject("/p2");
    expect(p2Sessions.map((s) => s.sessionName)).toEqual(["x"]);
  });

  it("findAll returns every session paired with its projectPath", () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/p2");
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "a" }));
    repo.upsert("/p2", makeMinimalSession({ sessionName: "x" }));

    const all = repo.findAll();
    const pairs = all
      .map((entry) => `${entry.projectPath}::${entry.session.sessionName}`)
      .sort();
    expect(pairs).toEqual(["/p1::a", "/p2::x"]);
  });

  it("delete removes only the targeted session", () => {
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "a" }));
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "b" }));

    repo.delete(PROJECT_PATH, "a");
    expect(repo.findByKey(PROJECT_PATH, "a")).toBeNull();
    expect(repo.findByKey(PROJECT_PATH, "b")).not.toBeNull();
  });
});

describe("sessions-repo cascading-FK invariant", () => {
  it("upsert on an existing session does NOT delete child conversations or reference_documents", () => {
    repo.upsert(
      PROJECT_PATH,
      makeMinimalSession({ sessionName: "with-children" }),
    );

    const insertConversation = db.prepare(
      `INSERT INTO conversations
        (id, project_path, session_name, status, prompt_count,
         created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertConversation.run(
      "c1",
      PROJECT_PATH,
      "with-children",
      "active",
      0,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    insertConversation.run(
      "c2",
      PROJECT_PATH,
      "with-children",
      "active",
      0,
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
    );

    const insertRefDoc = db.prepare(
      `INSERT INTO reference_documents
        (id, project_path, session_name, file_path, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertRefDoc.run(
      "r1",
      PROJECT_PATH,
      "with-children",
      "/docs/a.md",
      "ref a",
      "2026-01-01T00:00:00Z",
    );
    insertRefDoc.run(
      "r2",
      PROJECT_PATH,
      "with-children",
      "/docs/b.md",
      "ref b",
      "2026-01-02T00:00:00Z",
    );

    const beforeConvos = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversations WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, "with-children") as { n: number }
    ).n;
    const beforeRefs = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM reference_documents WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, "with-children") as { n: number }
    ).n;
    expect(beforeConvos).toBe(2);
    expect(beforeRefs).toBe(2);

    const mutated = makeMinimalSession({
      sessionName: "with-children",
      targetBranch: "release",
      lastActivityAt: "2026-03-01T00:00:00Z",
    });
    repo.upsert(PROJECT_PATH, mutated);

    const afterConvos = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversations WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, "with-children") as { n: number }
    ).n;
    const afterRefs = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM reference_documents WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, "with-children") as { n: number }
    ).n;

    expect(afterConvos).toBe(2);
    expect(afterRefs).toBe(2);

    const updated = repo.findByKey(PROJECT_PATH, "with-children");
    expect(updated?.targetBranch).toBe("release");
    expect(updated?.lastActivityAt).toBe("2026-03-01T00:00:00Z");
  });

  it("delete on a session cascades to its conversations and reference_documents (sanity)", () => {
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "doomed" }));
    db.prepare(
      `INSERT INTO conversations
        (id, project_path, session_name, status, prompt_count,
         created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "c1",
      PROJECT_PATH,
      "doomed",
      "active",
      0,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO reference_documents
        (id, project_path, session_name, file_path, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "r1",
      PROJECT_PATH,
      "doomed",
      "/docs/a.md",
      "ref a",
      "2026-01-01T00:00:00Z",
    );

    repo.delete(PROJECT_PATH, "doomed");

    const convos = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversations WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, "doomed") as { n: number }
    ).n;
    const refs = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM reference_documents WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, "doomed") as { n: number }
    ).n;
    expect(convos).toBe(0);
    expect(refs).toBe(0);
  });
});

describe("sessions-repo findListItemsByProject projection", () => {
  it("returns rows without heavy JSON columns and computes has_active_graph_workflow", () => {
    const heavyMachineSnapshot = JSON.stringify({
      state: "running",
      context: { largeBlob: "x".repeat(50_000) },
    });

    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name,
          created_at, last_activity_at, workflow_envelopes, workflow_lanes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "running-wf",
      "/wt/running-wf",
      "csm/running-wf",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      JSON.stringify({
        env1: { workflowType: "collaboration", status: "running" },
      }),
      JSON.stringify({ lane1: { engine: "noop" } }),
    );
    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name,
          created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "done-wf",
      "/wt/done-wf",
      "csm/done-wf",
      "2026-01-01T00:00:00Z",
      "2026-01-15T00:00:00Z",
    );

    // The has_active_graph_workflow flag is derived by a correlated subquery
    // against graph_workflow_executions, not the (now vestigial) sessions
    // column. Seed one active and one terminal execution in the new table.
    const insertExecution = db.prepare(
      `INSERT INTO graph_workflow_executions
         (project_path, session_name, execution_id, seed_definition_id,
          seed_definition_revision, started_at, status, completed_at,
          definition_json, runtime_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertExecution.run(
      PROJECT_PATH,
      "running-wf",
      "wf-running",
      "seed",
      1,
      "2026-01-01T00:00:00Z",
      "running",
      null,
      "{}",
      "{}",
      "2026-02-01T00:00:00Z",
    );
    insertExecution.run(
      PROJECT_PATH,
      "done-wf",
      "wf-done",
      "seed",
      1,
      "2026-01-01T00:00:00Z",
      "completed",
      "2026-01-15T00:00:00Z",
      "{}",
      "{}",
      "2026-01-15T00:00:00Z",
    );

    db.prepare(
      `INSERT INTO conversations
         (id, project_path, session_name, status, prompt_count,
          created_at, last_activity_at, machine_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "conv-running",
      PROJECT_PATH,
      "running-wf",
      "running",
      0,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      heavyMachineSnapshot,
    );

    const rows = repo.findListItemsByProject(PROJECT_PATH);
    expect(rows).toHaveLength(2);

    // The projection speaks camelCase domain vocabulary — no snake_case row
    // shape (heavy or otherwise) crosses the repo boundary.
    for (const row of rows) {
      const keys = Object.keys(row);
      for (const key of keys) {
        expect(key).not.toContain("_");
      }
    }

    const running = rows.find((r) => r.sessionName === "running-wf");
    expect(running).toBeDefined();
    expect(running?.hasActiveGraphWorkflow).toBe(true);
    // The JSON column is parsed at the boundary into a domain object.
    expect(running?.workflowEnvelopes).toMatchObject({
      env1: { workflowType: "collaboration", status: "running" },
    });

    const done = rows.find((r) => r.sessionName === "done-wf");
    expect(done).toBeDefined();
    expect(done?.hasActiveGraphWorkflow).toBe(false);
    expect(done?.workflowEnvelopes).toBeNull();
  });
});

describe("canonicalSessionRow", () => {
  it("returns the same string for two SessionState values that are deep-equal post-Zod-parse", () => {
    const a = makeFullSession();
    const b = makeFullSession();
    expect(canonicalSessionRow(PROJECT_PATH, a)).toBe(
      canonicalSessionRow(PROJECT_PATH, b),
    );
  });

  it("is insensitive to mcpOverrides.servers key insertion order", () => {
    const a = makeMinimalSession({
      mcpOverrides: {
        servers: { alpha: { enabled: true }, beta: { enabled: false } },
      },
    });
    const b = makeMinimalSession({
      mcpOverrides: {
        servers: { beta: { enabled: false }, alpha: { enabled: true } },
      },
    });
    expect(canonicalSessionRow(PROJECT_PATH, a)).toBe(
      canonicalSessionRow(PROJECT_PATH, b),
    );
  });

  it("differs when any field differs", () => {
    const base = makeMinimalSession();
    expect(canonicalSessionRow(PROJECT_PATH, base)).not.toBe(
      canonicalSessionRow(
        PROJECT_PATH,
        makeMinimalSession({ targetBranch: "release" }),
      ),
    );
    expect(canonicalSessionRow(PROJECT_PATH, base)).not.toBe(
      canonicalSessionRow("/p2", base),
    );
    expect(canonicalSessionRow(PROJECT_PATH, base)).not.toBe(
      canonicalSessionRow(PROJECT_PATH, makeMinimalSession({ archived: true })),
    );
  });
});

describe("rowToDomain quarantine: forward-incompatible scalar columns fail loud", () => {
  const REQUIRED_COLUMNS =
    `(project_path, session_name, worktree_path, branch_name,
      created_at, last_activity_at` as const;

  function insertRaw(
    sessionName: string,
    columns: string,
    placeholders: string,
    values: unknown[],
  ): void {
    db.prepare(
      `INSERT INTO sessions ${REQUIRED_COLUMNS}, ${columns})
       VALUES (?, ?, ?, ?, ?, ?, ${placeholders})`,
    ).run(
      PROJECT_PATH,
      sessionName,
      `/wt/${sessionName}`,
      `csm/${sessionName}`,
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      ...values,
    );
  }

  it("never reads the vestigial graph_workflow_execution column into the domain", () => {
    // A structurally-valid-but-forward-incompatible blob left on the (now
    // vestigial) sessions column must NOT surface on the domain object: the
    // execution lives in graph_workflow_executions and the column is ignored.
    insertRaw("legacy-blob", "graph_workflow_execution", "?", [
      JSON.stringify({
        id: "wf-ignored",
        seedDefinitionId: "seed",
        seedDefinitionRevision: 1,
        workingDefinition: {},
        status: "halted",
        startedAt: "2026-01-01T00:00:00Z",
        haltReason: { type: "collaboration_failure", contextId: "ctx-1" },
      }),
    ]);

    const out = repo.findByKey(PROJECT_PATH, "legacy-blob");
    expect(out).not.toBeNull();
    expect(out?.sessionName).toBe("legacy-blob");
    expect(out?.graphWorkflowExecution).toBeNull();
  });

  it("still throws (fail-loud) when a core scalar column is unparseable", () => {
    insertRaw("bad-source", "source", "?", ["not-a-valid-source"]);

    expect(() => repo.findByKey(PROJECT_PATH, "bad-source")).toThrow();
  });
});

describe("sessions-repo findAll caching", () => {
  it("returns identical session references for unchanged rows across calls (cache hit)", () => {
    repo.upsert(PROJECT_PATH, makeFullSession({ sessionName: "s-a" }));
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-b" }));

    const first = repo.findAll();
    const second = repo.findAll();

    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i += 1) {
      const a = first[i];
      const b = second[i];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Reference equality proves the cached parsed value was returned.
      expect(b!.session).toBe(a!.session);
    }
  });

  it("returns the same array reference across calls when no writes occurred", () => {
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-a" }));
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-b" }));

    const first = repo.findAll();
    const second = repo.findAll();

    expect(second).toBe(first);
  });

  it("returns a new reference for a row after upsert mutates it, reusing unchanged siblings", () => {
    repo.upsert(
      PROJECT_PATH,
      makeMinimalSession({ sessionName: "s-changed", targetBranch: "before" }),
    );
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-stable" }));

    const first = repo.findAll();
    const firstChanged = first.find(
      (r) => r.session.sessionName === "s-changed",
    );
    const firstStable = first.find((r) => r.session.sessionName === "s-stable");
    expect(firstChanged).toBeDefined();
    expect(firstStable).toBeDefined();

    repo.upsert(
      PROJECT_PATH,
      makeMinimalSession({ sessionName: "s-changed", targetBranch: "after" }),
    );

    const second = repo.findAll();
    const secondChanged = second.find(
      (r) => r.session.sessionName === "s-changed",
    );
    const secondStable = second.find(
      (r) => r.session.sessionName === "s-stable",
    );
    expect(second).not.toBe(first);
    expect(secondChanged?.session.targetBranch).toBe("after");
    expect(secondChanged?.session).not.toBe(firstChanged!.session);
    // The untouched sibling is served from cache by reference.
    expect(secondStable?.session).toBe(firstStable!.session);
  });

  it("invalidates the cache after delete and drops the removed row", () => {
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-keep" }));
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-drop" }));

    const first = repo.findAll();
    expect(first.map((r) => r.session.sessionName).sort()).toEqual([
      "s-drop",
      "s-keep",
    ]);

    repo.delete(PROJECT_PATH, "s-drop");

    const second = repo.findAll();
    expect(second).not.toBe(first);
    expect(second.map((r) => r.session.sessionName)).toEqual(["s-keep"]);
  });
});

/**
 * Wrap `db.prepare` so every `Statement.all()` execution whose source SQL
 * matches a predicate is counted. This proves the cache short-circuits BEFORE
 * the raw SQLite fetch, not merely before the Zod parse — the "short-circuit
 * before raw fetch" property PERFORMANCE.md pins (§50-62).
 */
function countingAllStmtDb(
  db: Db,
  sqlMatches: (sql: string) => boolean,
): { counter: { count: number } } {
  const counter = { count: 0 };
  const realPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (!sqlMatches(sql)) return stmt;
    const realAll = stmt.all.bind(stmt);
    stmt.all = ((...args: unknown[]) => {
      counter.count += 1;
      return realAll(...args);
    }) as typeof stmt.all;
    return stmt;
  }) as typeof db.prepare;
  return { counter };
}

describe("sessions-repo findAll SQL short-circuit (F9)", () => {
  it("does NOT execute the findAll statement on a warm-version cache hit", () => {
    const local = _createTestDb({ inMemory: true });
    local
      .prepare("INSERT INTO projects (root_path) VALUES (?)")
      .run(PROJECT_PATH);
    const { counter } = countingAllStmtDb(local, (sql) =>
      /FROM sessions[\s\S]*ORDER BY project_path/.test(sql),
    );
    const localRepo = createSessionsRepo(local);
    localRepo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-a" }));
    localRepo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-b" }));

    localRepo.findAll();
    expect(counter.count).toBe(1);

    // Warm hit: the version has not moved, so no SQL fetch may run.
    localRepo.findAll();
    expect(counter.count).toBe(1);

    // A mutation bumps the version; the next findAll must re-fetch once.
    localRepo.upsert(
      PROJECT_PATH,
      makeMinimalSession({ sessionName: "s-a", targetBranch: "moved" }),
    );
    localRepo.findAll();
    expect(counter.count).toBe(2);

    local.close();
  });
});

describe("sessions-repo setSpawnedFrom cache invalidation (F10)", () => {
  it("bumps the cache so a warm findAll observes the updated spawnedFrom, keeping unchanged siblings by reference", () => {
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-target" }));
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-sibling" }));

    // Warm the findAll cache before the single-column write.
    const first = repo.findAll();
    const firstTarget = first.find((r) => r.session.sessionName === "s-target");
    const firstSibling = first.find(
      (r) => r.session.sessionName === "s-sibling",
    );
    expect(firstTarget?.session.spawnedFrom).toBeNull();

    const spawnedFrom = {
      source: "chat" as const,
      projectName: "p1",
      conversationId: "conv-1",
    };
    const changed = repo.setSpawnedFrom(PROJECT_PATH, "s-target", spawnedFrom);
    expect(changed).toBe(true);

    const second = repo.findAll();
    const secondTarget = second.find(
      (r) => r.session.sessionName === "s-target",
    );
    const secondSibling = second.find(
      (r) => r.session.sessionName === "s-sibling",
    );

    // New result container after the write invalidated the version.
    expect(second).not.toBe(first);
    // The updated projection is visible (not the stale pre-write null).
    expect(secondTarget?.session.spawnedFrom).toEqual(spawnedFrom);
    expect(secondTarget?.session).not.toBe(firstTarget!.session);
    // The untouched sibling is still served from cache by reference.
    expect(secondSibling?.session).toBe(firstSibling!.session);
  });

  it("does not bump when the row is absent (no changes)", () => {
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "s-only" }));
    const first = repo.findAll();

    const changed = repo.setSpawnedFrom(PROJECT_PATH, "s-missing", {
      source: "chat",
      projectName: "p1",
      conversationId: "conv-x",
    });
    expect(changed).toBe(false);

    // No write occurred, so the version is unchanged and the array reference
    // is preserved.
    const second = repo.findAll();
    expect(second).toBe(first);
  });
});

/**
 * Build a session with EVERY introspectable persisted key path populated to a
 * distinctive non-default value, so the schema-driven durability harness can
 * prove no field is dropped on write or reset to its default on read.
 *
 * Every scalar is non-default; every optional/nullable field is present and
 * non-null; the nested graph-workflow execution (and its execution-history
 * twin) is fully populated; the opaque envelope/lane records and the
 * mcp/agent-capability override cascades each carry a representative entry whose
 * nested optional fields are all set.
 */
function buildMaximalSession(): SessionState {
  const execution = buildMaximalGraphWorkflowExecution();
  return sessionStateSchema.parse({
    sessionName: "full-durable",
    worktreePath: "/wt/full-durable",
    branchName: "csm/full-durable",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-02-15T08:09:10Z",
    archived: true,
    finished: true,
    source: "imported",
    creationMode: "optimistic",
    tddEnabled: false,
    targetBranch: "develop",
    parentSessionName: "ancestor-session",
    spawnedFrom: {
      source: "chat",
      projectName: "my-project",
      conversationId: "conv-1",
    },
    graphWorkflowExecution: execution,
    workflowEnvelopes: {
      env1: { kind: "primitive", payload: 42, status: "running" },
    },
    workflowLanes: {
      lane1: { engine: "noop", status: "active" },
    },
    mcpOverrides: {
      servers: {
        stripe: {
          enabled: true,
          tools: { charge: { enabled: false } },
        },
      },
    },
    agentCapabilityOverrides: {
      cascades: {
        "codex-skills": {
          items: {
            "review-pr": { enabled: false },
          },
        },
      },
    },
  });
}

describe("sessions-repo updateChangedColumns", () => {
  const ALL_COLUMNS = [
    "worktree_path",
    "branch_name",
    "created_at",
    "last_activity_at",
    "archived",
    "finished",
    "source",
    "creation_mode",
    "tdd_enabled",
    "target_branch",
    "parent_session_name",
    "workflow_envelopes",
    "workflow_lanes",
    "mcp_overrides",
    "agent_capability_overrides",
    "spawned_from",
  ] as const;

  function readRow(sessionName: string): Record<string, unknown> {
    return db
      .prepare(
        `SELECT * FROM sessions WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, sessionName) as Record<string, unknown>;
  }

  it("writes only the changed column and does NOT auto-restamp last_activity_at", () => {
    repo.upsert(PROJECT_PATH, makeFullSession({ targetBranch: "v1" }));
    const baselineActivity = readRow("full").last_activity_at;

    const base = repo.findByKey(PROJECT_PATH, "full")!;
    const next = { ...base, targetBranch: "v2" };
    const changed = diffChangedSessionColumns(base, next);
    expect(Object.keys(changed)).toEqual(["target_branch"]);

    const updated = repo.updateChangedColumns(PROJECT_PATH, "full", changed);
    expect(updated).toBe(true);

    const reloaded = repo.findByKey(PROJECT_PATH, "full")!;
    expect(reloaded.targetBranch).toBe("v2");
    // The config-toggle path must not bump session activity.
    expect(readRow("full").last_activity_at).toBe(baselineActivity);
  });

  it("writes last_activity_at when the caller includes it as a changed column", () => {
    repo.upsert(PROJECT_PATH, makeFullSession());
    const newActivity = "2026-04-04T04:04:04Z";

    repo.updateChangedColumns(PROJECT_PATH, "full", {
      target_branch: "moved",
      last_activity_at: newActivity,
    });

    const reloaded = repo.findByKey(PROJECT_PATH, "full")!;
    expect(reloaded.targetBranch).toBe("moved");
    expect(reloaded.lastActivityAt).toBe(newActivity);
  });

  it("returns false when the session row does not exist", () => {
    const updated = repo.updateChangedColumns(PROJECT_PATH, "missing", {
      target_branch: "x",
    });
    expect(updated).toBe(false);
  });

  it("is a no-op when no columns changed", () => {
    repo.upsert(PROJECT_PATH, makeFullSession());
    const baseline = readRow("full");

    const updated = repo.updateChangedColumns(PROJECT_PATH, "full", {});
    expect(updated).toBe(false);
    expect(readRow("full")).toEqual(baseline);
  });

  it("leaves every non-changed column byte-identical to the full-upsert baseline across a sequence of single-column writes", () => {
    repo.upsert(PROJECT_PATH, makeFullSession());
    const baseline = readRow("full");

    const steps: Array<{
      apply: (s: SessionState) => SessionState;
      column: string;
    }> = [
      { apply: (s) => ({ ...s, archived: false }), column: "archived" },
      { apply: (s) => ({ ...s, source: "cc" }), column: "source" },
      { apply: (s) => ({ ...s, tddEnabled: true }), column: "tdd_enabled" },
      {
        apply: (s) => ({ ...s, targetBranch: "release" }),
        column: "target_branch",
      },
    ];

    let prevRow = baseline;
    for (const step of steps) {
      const before = repo.findByKey(PROJECT_PATH, "full")!;
      const after = step.apply(before);
      const changed = diffChangedSessionColumns(before, after);
      expect(Object.keys(changed)).toEqual([step.column]);

      repo.updateChangedColumns(PROJECT_PATH, "full", changed);

      const newRow = readRow("full");
      for (const col of ALL_COLUMNS) {
        if (col === step.column) continue;
        expect(newRow[col], `column ${col} must be unchanged`).toBe(
          prevRow[col],
        );
      }
      prevRow = newRow;
    }

    // The big blob columns the focused path must never have re-written stay
    // byte-identical to the very first full-upsert baseline.
    for (const blob of [
      "workflow_lanes",
      "workflow_envelopes",
      "mcp_overrides",
    ]) {
      expect(readRow("full")[blob]).toBe(baseline[blob]);
    }
  });

  it("a per-column update of every mutable column matches the full-upsert bytes (no column drift)", () => {
    // Seed a minimal row, then drive every column to its makeFullSession value
    // via the focused per-column path. The result must be byte-identical to a
    // direct full upsert of makeFullSession — proving SESSION_COLUMN_MAP's
    // serializers do not drift from sessionToSqlBind.
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "full" }));
    const minimal = repo.findByKey(PROJECT_PATH, "full")!;
    const full = makeFullSession();
    const changed = diffChangedSessionColumns(minimal, full);
    // `last_activity_at` is excluded from the column map; carry it explicitly so
    // the byte comparison against the full upsert holds.
    changed.last_activity_at = full.lastActivityAt;
    repo.updateChangedColumns(PROJECT_PATH, "full", changed);
    const viaColumns = readRow("full");

    db.prepare(
      `DELETE FROM sessions WHERE project_path = ? AND session_name = ?`,
    ).run(PROJECT_PATH, "full");
    repo.upsert(PROJECT_PATH, makeFullSession());
    const viaUpsert = readRow("full");

    for (const col of ALL_COLUMNS) {
      expect(
        viaColumns[col],
        `column ${col} must match full-upsert bytes`,
      ).toBe(viaUpsert[col]);
    }
  });
});

describe("sessions-repo durability contract", () => {
  it("round-trips every persisted session key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "sessions",
      schema: sessionStateSchema,
      buildMaximalFixture: buildMaximalSession,
      persist: (fixture) => {
        repo.upsert(PROJECT_PATH, fixture);
        return fixture;
      },
      reload: (expected) => repo.findByKey(PROJECT_PATH, expected.sessionName),
      fieldPolicies: {
        // `conversations` is never stored on the sessions row. Conversations
        // live in their own `conversations` table (see conversations-repo) and
        // are joined back into the in-memory SessionState by higher layers, not
        // by sessions-repo. rowToDomain deliberately sets `conversations: []`,
        // so the column-level round trip cannot carry them and the array is
        // correctly empty on reload. Not a serialization gap.
        conversations: "not-persisted",
        // `referenceDocuments` is likewise never stored on the sessions row.
        // Reference documents live in their own `reference_documents` table and
        // are joined in by higher layers; rowToDomain sets
        // `referenceDocuments: []`. Not a serialization gap.
        referenceDocuments: "not-persisted",
        // `graphWorkflowExecution` no longer round-trips on the sessions row.
        // The active execution lives in the dedicated graph_workflow_executions
        // table (see graph-workflow-executions-repo) and is merged back into the
        // in-memory SessionState by higher layers, not by sessions-repo;
        // rowToDomain deliberately sets `graphWorkflowExecution: null`. Its own
        // durability backstop is graph-workflow-executions-repo.contract.test.
        graphWorkflowExecution: "not-persisted",
      },
    });
  });
});
