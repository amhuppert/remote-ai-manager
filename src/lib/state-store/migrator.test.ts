import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createMigrator, runMigrations } from "./migrator";
import { createGraphWorkflowArchivedExecutionsRepo } from "./graph-workflow-archived-executions-repo";
import { createGraphWorkflowEventsRepo } from "./graph-workflow-events-repo";
import { splitGraphWorkflowHistory } from "./migrations/0002-split-graph-workflow-history";
import { _createTestDb } from "./state-db";
import type { StateMigration } from "./migrations/types";

type Db = InstanceType<typeof Database>;

const openDbs: Db[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

function freshDb(): Db {
  const db = _createTestDb({ inMemory: true });
  openDbs.push(db);
  return db;
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function ledgerNames(db: Db): string[] {
  const rows = db
    .prepare("SELECT name FROM applied_migrations ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("state-store migrator runner", () => {
  it("runs pending migrations in order and records each in the ledger", async () => {
    const db = freshDb();
    const ran: string[] = [];
    const sample: StateMigration[] = [
      { name: "0001-a", up: async () => void ran.push("a") },
      { name: "0002-b", up: async () => void ran.push("b") },
    ];

    const applied = await runMigrations({ db, configDir: null }, sample);

    expect(applied).toEqual(["0001-a", "0002-b"]);
    expect(ran).toEqual(["a", "b"]);
    expect(ledgerNames(db)).toEqual(["0001-a", "0002-b"]);
  });

  it("is idempotent: a second run applies nothing and does not re-execute up", async () => {
    const db = freshDb();
    let runs = 0;
    const sample: StateMigration[] = [
      { name: "0001-a", up: async () => void runs++ },
    ];

    await runMigrations({ db, configDir: null }, sample);
    const secondRun = await runMigrations({ db, configDir: null }, sample);

    expect(secondRun).toEqual([]);
    expect(runs).toBe(1);
    expect(ledgerNames(db)).toEqual(["0001-a"]);
  });

  it("only runs migrations absent from the ledger when new ones are appended", async () => {
    const db = freshDb();
    const ran: string[] = [];
    const first: StateMigration[] = [
      { name: "0001-a", up: async () => void ran.push("a") },
    ];
    const extended: StateMigration[] = [
      ...first,
      { name: "0002-b", up: async () => void ran.push("b") },
    ];

    await runMigrations({ db, configDir: null }, first);
    const applied = await runMigrations({ db, configDir: null }, extended);

    expect(applied).toEqual(["0002-b"]);
    expect(ran).toEqual(["a", "b"]);
    expect(ledgerNames(db)).toEqual(["0001-a", "0002-b"]);
  });

  it("reverting a migration removes it from the ledger and re-runs it later", async () => {
    const db = freshDb();
    const events: string[] = [];
    const sample: StateMigration[] = [
      {
        name: "0001-a",
        up: async () => void events.push("up"),
        down: async () => void events.push("down"),
      },
    ];

    const migrator = createMigrator({ db, configDir: null }, sample);
    await migrator.up();
    await migrator.down();

    expect(ledgerNames(db)).toEqual([]);
    expect(events).toEqual(["up", "down"]);

    const reapplied = await runMigrations({ db, configDir: null }, sample);
    expect(reapplied).toEqual(["0001-a"]);
    expect(ledgerNames(db)).toEqual(["0001-a"]);
  });
});

describe("0001-drop-legacy-roadmap-items (production registry)", () => {
  it("drops the legacy roadmap_items table and index when present", async () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, project_path TEXT);
      CREATE INDEX idx_roadmap_items_project ON roadmap_items(project_path);
    `);
    expect(tableExists(db, "roadmap_items")).toBe(true);

    const applied = await runMigrations({ db, configDir: null });

    expect(applied).toContain("0001-drop-legacy-roadmap-items");
    expect(tableExists(db, "roadmap_items")).toBe(false);
  });

  it("is a no-op on a fresh DB that never had the table, but still records the ledger", async () => {
    const db = freshDb();
    expect(tableExists(db, "roadmap_items")).toBe(false);

    const applied = await runMigrations({ db, configDir: null });

    expect(applied).toContain("0001-drop-legacy-roadmap-items");
    expect(ledgerNames(db)).toContain("0001-drop-legacy-roadmap-items");
    expect(tableExists(db, "roadmap_items")).toBe(false);
  });
});

const PROJECT_PATH = "/repo";
const SESSION_NAME = "feature-a";

function contextStatusEvent(executionId: string, contextId: string) {
  return {
    type: "graph-workflow-context-status",
    projectName: "repo",
    sessionName: SESSION_NAME,
    executionId,
    contextId,
    status: "running",
    remainingTaskCount: 1,
    iterationCount: 0,
  };
}

function statusEvent(executionId: string) {
  return {
    type: "graph-workflow-status",
    projectName: "repo",
    sessionName: SESSION_NAME,
    executionId,
    workflowStatus: "running",
    activeContextIds: [],
    activeBatchIds: [],
    activeJoinIds: [],
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
  };
}

function historyEntry(event: object, occurredAt: string, preReset = false) {
  return { occurredAt, event, preReset };
}

function seedSessionWithLegacyBlobs(
  db: Db,
  activeExecution: object,
  historyExecutions: object[],
): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at,
       graph_workflow_execution, graph_workflow_execution_history
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    JSON.stringify(activeExecution),
    JSON.stringify(historyExecutions),
  );
}

function readActiveBlob(db: Db): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT graph_workflow_execution AS blob
         FROM sessions WHERE project_path = ? AND session_name = ?`,
    )
    .get(PROJECT_PATH, SESSION_NAME) as { blob: string | null };
  return row.blob === null ? null : (JSON.parse(row.blob) as Record<string, unknown>);
}

function readArchivedBlob(
  db: Db,
  executionId: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT execution_json AS blob
         FROM graph_workflow_archived_executions
        WHERE project_path = ? AND session_name = ? AND execution_id = ?`,
    )
    .get(PROJECT_PATH, SESSION_NAME, executionId) as
    | { blob: string }
    | undefined;
  return row === undefined
    ? null
    : (JSON.parse(row.blob) as Record<string, unknown>);
}

describe("0002-split-graph-workflow-history (production registry)", () => {
  it("splits active history into events and strips it from the blob", async () => {
    const db = freshDb();
    const activeExecution = {
      id: "exec-active",
      status: "running",
      startedAt: "2026-02-01T00:00:00Z",
      completedAt: null,
      history: [
        historyEntry(statusEvent("exec-active"), "2026-02-01T00:00:01Z"),
        historyEntry(
          contextStatusEvent("exec-active", "ctx-1"),
          "2026-02-01T00:00:02Z",
        ),
      ],
    };
    seedSessionWithLegacyBlobs(db, activeExecution, []);

    const applied = await runMigrations({ db, configDir: null });
    expect(applied).toContain("0002-split-graph-workflow-history");

    const events = createGraphWorkflowEventsRepo(db).findByExecution(
      "exec-active",
    );
    expect(events.map((e) => e.event.type)).toEqual([
      "graph-workflow-status",
      "graph-workflow-context-status",
    ]);

    const ctxScoped = createGraphWorkflowEventsRepo(db).findLatestForContext(
      "exec-active",
      "ctx-1",
      "graph-workflow-context-status",
    );
    expect(ctxScoped?.event.type).toBe("graph-workflow-context-status");

    const blob = readActiveBlob(db);
    expect(blob).not.toBeNull();
    expect(blob).toMatchObject({ id: "exec-active", status: "running" });
    expect(blob && "history" in blob).toBe(false);
  });

  it("archives past executions and splits their history by execution id", async () => {
    const db = freshDb();
    const activeExecution = {
      id: "exec-active",
      status: "running",
      startedAt: "2026-02-01T00:00:00Z",
      completedAt: null,
      history: [],
    };
    const pastA = {
      id: "exec-past-a",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T01:00:00Z",
      history: [
        historyEntry(statusEvent("exec-past-a"), "2026-01-01T00:30:00Z"),
      ],
    };
    const pastB = {
      id: "exec-past-b",
      status: "halted",
      startedAt: "2026-01-02T00:00:00Z",
      completedAt: null,
      history: [
        historyEntry(
          contextStatusEvent("exec-past-b", "ctx-9"),
          "2026-01-02T00:30:00Z",
        ),
      ],
    };
    seedSessionWithLegacyBlobs(db, activeExecution, [pastA, pastB]);

    await runMigrations({ db, configDir: null });

    const archivedRepo = createGraphWorkflowArchivedExecutionsRepo(db);
    const summaries = archivedRepo.listSummariesBySession(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(summaries.map((s) => s.executionId).sort()).toEqual([
      "exec-past-a",
      "exec-past-b",
    ]);
    const summaryA = summaries.find((s) => s.executionId === "exec-past-a");
    expect(summaryA).toMatchObject({
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T01:00:00Z",
    });

    const eventsRepo = createGraphWorkflowEventsRepo(db);
    expect(eventsRepo.findByExecution("exec-past-a").map((e) => e.event.type)).toEqual(
      ["graph-workflow-status"],
    );
    expect(eventsRepo.findByExecution("exec-past-b").map((e) => e.event.type)).toEqual(
      ["graph-workflow-context-status"],
    );

    const archivedBlob = readArchivedBlob(db, "exec-past-a");
    expect(archivedBlob).toMatchObject({ id: "exec-past-a" });
    expect(archivedBlob && "history" in archivedBlob).toBe(false);
  });

  it("is a no-op on a second run (idempotent)", async () => {
    const db = freshDb();
    const activeExecution = {
      id: "exec-active",
      status: "running",
      startedAt: "2026-02-01T00:00:00Z",
      completedAt: null,
      history: [
        historyEntry(statusEvent("exec-active"), "2026-02-01T00:00:01Z"),
      ],
    };
    const past = {
      id: "exec-past",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T01:00:00Z",
      history: [
        historyEntry(statusEvent("exec-past"), "2026-01-01T00:30:00Z"),
      ],
    };
    seedSessionWithLegacyBlobs(db, activeExecution, [past]);

    await runMigrations({ db, configDir: null });
    const secondRun = await runMigrations({ db, configDir: null });
    expect(secondRun).toEqual([]);

    const eventsRepo = createGraphWorkflowEventsRepo(db);
    expect(eventsRepo.findByExecution("exec-active")).toHaveLength(1);
    expect(eventsRepo.findByExecution("exec-past")).toHaveLength(1);
    expect(
      createGraphWorkflowArchivedExecutionsRepo(db).listSummariesBySession(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toHaveLength(1);

    const blob = readActiveBlob(db);
    expect(blob && "history" in blob).toBe(false);
  });

  it("re-runs the up step (manual replay) without duplicating rows", async () => {
    const db = freshDb();
    const activeExecution = {
      id: "exec-active",
      status: "running",
      startedAt: "2026-02-01T00:00:00Z",
      completedAt: null,
      history: [
        historyEntry(statusEvent("exec-active"), "2026-02-01T00:00:01Z"),
        historyEntry(
          contextStatusEvent("exec-active", "ctx-1"),
          "2026-02-01T00:00:02Z",
        ),
      ],
    };
    const past = {
      id: "exec-past",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T01:00:00Z",
      history: [
        historyEntry(statusEvent("exec-past"), "2026-01-01T00:30:00Z"),
      ],
    };
    seedSessionWithLegacyBlobs(db, activeExecution, [past]);

    await runMigrations({ db, configDir: null });

    // Force a manual re-execution of the up step to model a crash-after-up,
    // before-ledger replay: the up body itself must converge.
    await splitGraphWorkflowHistory.up({
      name: splitGraphWorkflowHistory.name,
      context: { db, configDir: null },
    });

    const eventsRepo = createGraphWorkflowEventsRepo(db);
    expect(eventsRepo.findByExecution("exec-active")).toHaveLength(2);
    expect(eventsRepo.findByExecution("exec-past")).toHaveLength(1);
    expect(
      createGraphWorkflowArchivedExecutionsRepo(db).listSummariesBySession(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toHaveLength(1);
  });
});
