import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { runMigrations } from "../migrator";
import { splitGraphWorkflowExecution } from "./0003-split-graph-workflow-execution";
import { _createTestDb } from "../state-db";
import {
  DEFINITION_TIER_KEYS,
  RUNTIME_TIER_KEYS,
} from "../graph-workflow-executions-repo";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo";
const SESSION_NAME = "feature-a";

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

function seedSessionWithExecution(
  db: Db,
  sessionName: string,
  execution: object | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO projects (root_path) VALUES (?)`,
  ).run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at, graph_workflow_execution
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    sessionName,
    `${PROJECT_PATH}/.worktrees/${sessionName}`,
    `csm/${sessionName}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    execution === null ? null : JSON.stringify(execution),
  );
}

function readSessionBlob(db: Db, sessionName: string): string | null {
  const row = db
    .prepare(
      `SELECT graph_workflow_execution AS blob
         FROM sessions WHERE project_path = ? AND session_name = ?`,
    )
    .get(PROJECT_PATH, sessionName) as { blob: string | null };
  return row.blob;
}

function readExecutionRow(
  db: Db,
  sessionName: string,
):
  | {
      execution_id: string;
      seed_definition_id: string;
      seed_definition_revision: number;
      started_at: string;
      status: string;
      completed_at: string | null;
      definition_json: string;
      runtime_json: string;
    }
  | undefined {
  return db
    .prepare(
      `SELECT execution_id, seed_definition_id, seed_definition_revision,
              started_at, status, completed_at, definition_json, runtime_json
         FROM graph_workflow_executions
        WHERE project_path = ? AND session_name = ?`,
    )
    .get(PROJECT_PATH, sessionName) as
    | {
        execution_id: string;
        seed_definition_id: string;
        seed_definition_revision: number;
        started_at: string;
        status: string;
        completed_at: string | null;
        definition_json: string;
        runtime_json: string;
      }
    | undefined;
}

function populatedExecution() {
  return {
    id: "exec-active",
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 2,
    startedAt: "2026-02-01T00:00:00Z",
    status: "running",
    completedAt: null,
    workingDefinition: { schemaVersion: 2, kind: "definition-payload" },
    charter: { kind: "charter-payload" },
    lanePlan: { continuationMap: { "ctx-1": "ctx-2" } },
    activeContextIds: ["ctx-1"],
    contextStates: { "ctx-1": { contextId: "ctx-1", status: "running" } },
    taskStates: { "task-1": { taskId: "task-1", status: "running" } },
    sharedDocuments: [{ id: "doc-1" }],
    machineSnapshot: { value: "running" },
  };
}

describe("0003-split-graph-workflow-execution (production registry)", () => {
  it("splits the active blob into definition/runtime tiers + projections and NULLs the source", async () => {
    const db = freshDb();
    seedSessionWithExecution(db, SESSION_NAME, populatedExecution());

    const applied = await runMigrations({ db, configDir: null });
    expect(applied).toContain("0003-split-graph-workflow-execution");

    const row = readExecutionRow(db, SESSION_NAME);
    expect(row).toBeDefined();
    if (row === undefined) throw new Error("row missing");

    expect(row.execution_id).toBe("exec-active");
    expect(row.seed_definition_id).toBe("seed-1");
    expect(row.seed_definition_revision).toBe(2);
    expect(row.started_at).toBe("2026-02-01T00:00:00Z");
    expect(row.status).toBe("running");
    expect(row.completed_at).toBeNull();

    const definition = JSON.parse(row.definition_json) as Record<string, unknown>;
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;

    // Definition tier carries exactly the definition-tier keys.
    expect(Object.keys(definition).sort()).toEqual(
      [...DEFINITION_TIER_KEYS].sort(),
    );
    expect(definition.workingDefinition).toEqual({
      schemaVersion: 2,
      kind: "definition-payload",
    });
    expect(definition.charter).toEqual({ kind: "charter-payload" });

    // Runtime tier carries exactly the runtime-tier keys; unset hot fields
    // (haltReason, joins, etc.) serialize to null because the source blob
    // omitted them — a positional read preserves the shape losslessly.
    expect(Object.keys(runtime).sort()).toEqual([...RUNTIME_TIER_KEYS].sort());
    expect(runtime.activeContextIds).toEqual(["ctx-1"]);
    expect(runtime.status).toBe("running");

    expect(readSessionBlob(db, SESSION_NAME)).toBeNull();
  });

  it("is a no-op on a second run (idempotent) and a manual replay does not duplicate", async () => {
    const db = freshDb();
    seedSessionWithExecution(db, SESSION_NAME, populatedExecution());

    await runMigrations({ db, configDir: null });
    const secondRun = await runMigrations({ db, configDir: null });
    expect(secondRun).toEqual([]);

    // Manual replay of the up body models a crash-after-up, before-ledger replay.
    await splitGraphWorkflowExecution.up({
      name: splitGraphWorkflowExecution.name,
      context: { db, configDir: null },
    });

    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { n: number };
    expect(count.n).toBe(1);
    expect(readSessionBlob(db, SESSION_NAME)).toBeNull();
  });

  it("skips an identity-less blob without throwing and leaves its column intact", async () => {
    const db = freshDb();
    seedSessionWithExecution(db, "no-id", { status: "running" });

    const applied = await runMigrations({ db, configDir: null });
    expect(applied).toContain("0003-split-graph-workflow-execution");

    expect(readExecutionRow(db, "no-id")).toBeUndefined();
    // The blob is left in place (not NULLed) so a later build can still read it.
    expect(readSessionBlob(db, "no-id")).not.toBeNull();
  });

  it("skips an unparseable blob without throwing", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT OR IGNORE INTO projects (root_path) VALUES (?)`,
    ).run(PROJECT_PATH);
    db.prepare(
      `INSERT INTO sessions (
         project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at, graph_workflow_execution
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_PATH,
      "bad-json",
      `${PROJECT_PATH}/.worktrees/bad-json`,
      "csm/bad-json",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "{not valid json",
    );

    await expect(runMigrations({ db, configDir: null })).resolves.toContain(
      "0003-split-graph-workflow-execution",
    );
    expect(readExecutionRow(db, "bad-json")).toBeUndefined();
  });
});
