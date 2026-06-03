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
  type SessionsRepo,
} from "./sessions-repo";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
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
    objective: "make it fast",
    creationMode: "focus",
    tddEnabled: false,
    targetBranch: "develop",
    parentSessionName: "ancestor",
    graphWorkflowExecution: {
      id: "wf-1",
      seedDefinitionId: "seed-1",
      seedDefinitionRevision: 1,
      workingDefinition: {},
      status: "pending",
      startedAt: "2026-01-01T00:00:00Z",
    },
    graphWorkflowExecutionHistory: [
      {
        id: "wf-h-1",
        seedDefinitionId: "seed-h",
        seedDefinitionRevision: 1,
        workingDefinition: {},
        status: "completed",
        startedAt: "2025-12-01T00:00:00Z",
      },
    ],
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
    expect(out.objective).toBeNull();
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

  it("upsert + findByKey round-trips a fully populated fixture (every field set, JSON sub-trees included)", () => {
    const fixture = makeFullSession();
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findByKey(PROJECT_PATH, fixture.sessionName);
    expect(out).not.toBeNull();
    if (!out) return;

    // The repo materializes `spawnedFrom: null` for the (non-spawned) fixture.
    const expected = { ...fixture, spawnedFrom: null };
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
      objective: "mutated payload",
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
    expect(updated?.objective).toBe("mutated payload");
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
    const runningExecution = JSON.stringify({
      id: "wf-running",
      seedDefinitionId: "seed",
      seedDefinitionRevision: 1,
      workingDefinition: {},
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
    });
    const completedExecution = JSON.stringify({
      id: "wf-done",
      seedDefinitionId: "seed",
      seedDefinitionRevision: 1,
      workingDefinition: {},
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
    });

    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name,
          created_at, last_activity_at, graph_workflow_execution,
          graph_workflow_execution_history, workflow_envelopes, workflow_lanes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "running-wf",
      "/wt/running-wf",
      "csm/running-wf",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      runningExecution,
      "[]",
      JSON.stringify({
        env1: { workflowType: "collaboration", status: "running" },
      }),
      JSON.stringify({ lane1: { engine: "noop" } }),
    );
    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name,
          created_at, last_activity_at, graph_workflow_execution,
          graph_workflow_execution_history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "done-wf",
      "/wt/done-wf",
      "csm/done-wf",
      "2026-01-01T00:00:00Z",
      "2026-01-15T00:00:00Z",
      completedExecution,
      "[]",
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

    const forbidden = [
      "machine_snapshot",
      "graph_workflow_execution",
      "graph_workflow_execution_history",
      "workflow_lanes",
      "mcp_runtime",
      "agent_capabilities_runtime",
      "pending_questions",
      "pending_prompt_text",
      "debug_mode",
    ];
    for (const row of rows) {
      const keys = Object.keys(row);
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
    }

    const running = rows.find((r) => r.session_name === "running-wf");
    expect(running).toBeDefined();
    expect(running?.has_active_graph_workflow).toBe(1);
    expect(running?.workflow_envelopes).toContain("collaboration");

    const done = rows.find((r) => r.session_name === "done-wf");
    expect(done).toBeDefined();
    expect(done?.has_active_graph_workflow).toBe(0);
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
      canonicalSessionRow(PROJECT_PATH, makeMinimalSession({ objective: "a" })),
    );
    expect(canonicalSessionRow(PROJECT_PATH, base)).not.toBe(
      canonicalSessionRow("/p2", base),
    );
    expect(canonicalSessionRow(PROJECT_PATH, base)).not.toBe(
      canonicalSessionRow(PROJECT_PATH, makeMinimalSession({ archived: true })),
    );
  });
});

describe("rowToDomain quarantine: forward-incompatible workflow columns degrade in-memory", () => {
  const REQUIRED_COLUMNS =
    `(project_path, session_name, worktree_path, branch_name,
      created_at, last_activity_at` as const;

  /**
   * A graph_workflow_execution payload that is structurally a valid execution
   * but carries a halt reason whose discriminator the current schema does not
   * recognise — the exact shape a feature branch writes when it extends the
   * halt-reason union and persists into the shared database.
   */
  const execWithUnknownHaltReason = JSON.stringify({
    id: "wf-bad",
    seedDefinitionId: "seed",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    status: "halted",
    startedAt: "2026-01-01T00:00:00Z",
    haltReason: { type: "collaboration_failure", contextId: "ctx-1" },
  });

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

  it("findByKey returns the session with graphWorkflowExecution nulled instead of throwing", () => {
    insertRaw("bad-exec", "graph_workflow_execution", "?", [
      execWithUnknownHaltReason,
    ]);

    const out = repo.findByKey(PROJECT_PATH, "bad-exec");
    expect(out).not.toBeNull();
    expect(out?.sessionName).toBe("bad-exec");
    expect(out?.graphWorkflowExecution).toBeNull();
  });

  it("findAll does not throw and includes the degraded session alongside healthy ones", () => {
    insertRaw("bad-exec", "graph_workflow_execution", "?", [
      execWithUnknownHaltReason,
    ]);
    repo.upsert(PROJECT_PATH, makeMinimalSession({ sessionName: "healthy" }));

    const all = repo.findAll();
    const names = all.map((r) => r.session.sessionName).sort();
    expect(names).toEqual(["bad-exec", "healthy"]);
    const bad = all.find((r) => r.session.sessionName === "bad-exec");
    expect(bad?.session.graphWorkflowExecution).toBeNull();
  });

  it("degrades an unparseable graph_workflow_execution_history to an empty array", () => {
    insertRaw("bad-history", "graph_workflow_execution_history", "?", [
      `[${execWithUnknownHaltReason}]`,
    ]);

    const out = repo.findByKey(PROJECT_PATH, "bad-history");
    expect(out).not.toBeNull();
    expect(out?.graphWorkflowExecutionHistory).toEqual([]);
  });

  it("still throws (fail-loud) when a core scalar column is unparseable", () => {
    insertRaw("bad-source", "source", "?", ["not-a-valid-source"]);

    expect(() => repo.findByKey(PROJECT_PATH, "bad-source")).toThrow();
  });
});
