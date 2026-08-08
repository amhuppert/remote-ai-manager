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
import { migrations } from "./index";
import { splitGraphWorkflowExecution } from "./0003-split-graph-workflow-execution";
import { workflowAgentAssignments } from "./0011-workflow-agent-assignments";
import { _createTestDb } from "../state-db";
import {
  createGraphWorkflowExecutionsRepo,
  DEFINITION_TIER_KEYS,
  RUNTIME_TIER_KEYS,
} from "../graph-workflow-executions-repo";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";

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

/**
 * The production chain UP TO the agent-assignment cutover.
 *
 * These tests are about the bytes 0003 writes into `graph_workflow_executions`
 * and whether the live repository can load them, so they need that row to still
 * exist. `0011-workflow-agent-assignments` archives every active execution and
 * empties the table — correct, and covered by its own test — but it would leave
 * nothing here to assert against. Running the real prefix keeps the chain
 * realism these tests exist for (every earlier migration participates) without
 * asserting through the cutover.
 */
const MIGRATIONS_BEFORE_CUTOVER = migrations.slice(
  0,
  migrations.findIndex(
    (migration) => migration.name === workflowAgentAssignments.name,
  ),
);

function seedSessionWithExecution(
  db: Db,
  sessionName: string,
  execution: object | null,
): void {
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
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
    activeContextIds: ["ctx-1"],
    contextStates: { "ctx-1": { contextId: "ctx-1", status: "running" } },
    taskStates: { "task-1": { taskId: "task-1", status: "running" } },
    sharedDocuments: [{ id: "doc-1" }],
    machineSnapshot: { value: "running" },
  };
}

/**
 * A blob as it was persisted BEFORE the additive runtime keys existed: valid
 * under the schema of its day, missing every field added since. This is the
 * shape a real upgrading install carries into the migration.
 */
function preFeatureExecutionBlob(
  omittedKeys: readonly string[],
): Record<string, unknown> {
  const execution: Record<string, unknown> = {
    ...graphWorkflowExecutionSchema.parse(buildMaximalGraphWorkflowExecution()),
  };
  for (const key of omittedKeys) {
    delete execution[key];
  }
  return execution;
}

describe("0003-split-graph-workflow-execution (production registry)", () => {
  it("splits the active blob into definition/runtime tiers + projections and NULLs the source", async () => {
    const db = freshDb();
    seedSessionWithExecution(db, SESSION_NAME, populatedExecution());

    const applied = await runMigrations(
      { db, configDir: null },
      MIGRATIONS_BEFORE_CUTOVER,
    );
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

    const definition = JSON.parse(row.definition_json) as Record<
      string,
      unknown
    >;
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;

    // Each tier carries exactly its own keys that the source blob actually had.
    // A key the blob lacked is omitted, never materialized as null, so the
    // schema default fills it in on read (see the pre-feature-blob test below).
    const source = populatedExecution() as Record<string, unknown>;
    expect(Object.keys(definition).sort()).toEqual(
      DEFINITION_TIER_KEYS.filter((key) => key in source).sort(),
    );
    expect(definition.workingDefinition).toEqual({
      schemaVersion: 2,
      kind: "definition-payload",
    });
    expect(definition.charter).toEqual({ kind: "charter-payload" });

    expect(Object.keys(runtime).sort()).toEqual(
      RUNTIME_TIER_KEYS.filter((key) => key in source).sort(),
    );
    expect(runtime.activeContextIds).toEqual(["ctx-1"]);
    expect(runtime.status).toBe("running");
    // No key crosses tiers, and nothing outside the two tier lists leaks in.
    expect(Object.keys(definition).filter((key) => key in runtime)).toEqual([]);

    expect(readSessionBlob(db, SESSION_NAME)).toBeNull();
  });

  // The migration is only half of the startup path: whatever it writes has to
  // survive the very next read through the real repository. A key the source
  // blob never had must be OMITTED from the tier JSON, not written as null —
  // `.default({})` / `.default([])` / `.default(0)` fire on `undefined` only, so
  // a null would make the migrated row unloadable on the first boot after
  // upgrade. Every additive runtime key shares this hazard, so the test covers
  // the whole class rather than just the newest member.
  it("writes tiers a fresh repository can load when the source blob predates the additive keys", async () => {
    const db = freshDb();
    const additiveKeys = [
      "contextOutputs",
      "liveRevision",
      "charterAmendments",
      "planRepairRounds",
      "loopEpoch",
      "boundInputs",
      "launchedTier",
      "pendingMergeRetry",
      "secondaryHaltReasons",
    ] as const;
    seedSessionWithExecution(
      db,
      SESSION_NAME,
      preFeatureExecutionBlob(additiveKeys),
    );

    await runMigrations({ db, configDir: null }, MIGRATIONS_BEFORE_CUTOVER);

    // The real read path: a repository instance that has never seen this row.
    // A rejected blob is quarantined and reported as "no active execution", so
    // the failure mode is a silently lost workflow on the first boot after
    // upgrade, not a loud error.
    const loaded = createGraphWorkflowExecutionsRepo(db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(loaded).not.toBeNull();
    expect(loaded?.contextOutputs).toEqual({});
    expect(loaded?.charterAmendments).toEqual([]);
    expect(loaded?.planRepairRounds).toEqual([]);
    expect(loaded?.liveRevision).toBe(1);
    expect(loaded?.loopEpoch).toBe(0);
    expect(loaded?.boundInputs).toEqual({});
    expect(loaded?.launchedTier).toBe("project");
    // Fields the blob DID carry survive the split untouched.
    expect(loaded?.taskStates["task-1"]?.summary).toBe(
      "implemented the first slice",
    );

    // ...and the mechanism behind it: the absent keys are omitted from the tier
    // JSON entirely, which is what lets the schema defaults fire on read.
    const row = readExecutionRow(db, SESSION_NAME);
    if (row === undefined) throw new Error("row missing");
    const runtime = JSON.parse(row.runtime_json) as Record<string, unknown>;
    const definition = JSON.parse(row.definition_json) as Record<
      string,
      unknown
    >;
    for (const key of additiveKeys) {
      expect(
        key in runtime || key in definition,
        `${key} was absent from the source blob and must not be materialized as null`,
      ).toBe(false);
    }
  });

  it("is a no-op on a second run (idempotent) and a manual replay does not duplicate", async () => {
    const db = freshDb();
    seedSessionWithExecution(db, SESSION_NAME, populatedExecution());

    await runMigrations({ db, configDir: null }, MIGRATIONS_BEFORE_CUTOVER);
    const secondRun = await runMigrations(
      { db, configDir: null },
      MIGRATIONS_BEFORE_CUTOVER,
    );
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
    db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
      PROJECT_PATH,
    );
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
