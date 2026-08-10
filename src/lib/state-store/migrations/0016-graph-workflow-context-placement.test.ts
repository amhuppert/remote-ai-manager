import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type BetterSqlite3 from "better-sqlite3";
import { _createTestDb } from "../state-db";
import { graphWorkflowContextPlacement } from "./0016-graph-workflow-context-placement";

type Db = InstanceType<typeof BetterSqlite3>;

const PROJECT_PATH = "/repos/pre-placement";
const SESSION_NAME = "s1";

let db: Db;

interface StoredContext {
  id: string;
  placement?: { lane: string; mode: string };
}

/**
 * A pre-placement blob: contexts with no `placement`, plus the `lanePlan` field
 * D5 deleted. Two of the three ids sanitize to one lane segment, so the stored
 * bytes also witness the collision encoding.
 */
function prePlacementBlob(): string {
  return JSON.stringify({
    id: "wf-legacy",
    seedDefinitionId: "seed-legacy",
    seedDefinitionRevision: 1,
    lanePlan: {
      continuationMap: { "build api": "ship" },
      longestDownstreamPath: { "build api": 1 },
    },
    workingDefinition: {
      executionContexts: [
        { id: "build api", title: "First" },
        { id: "build/api", title: "Second" },
        { id: "ship", title: "Third" },
      ],
      tasks: [],
      edges: [],
    },
  });
}

function insertActiveRow(definitionJson: string): void {
  db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, status, started_at, completed_at,
       definition_json, runtime_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    "wf-legacy",
    "seed-legacy",
    1,
    "running",
    "2026-01-01T00:00:00Z",
    null,
    definitionJson,
    JSON.stringify({ contextStates: {}, taskStates: {} }),
    "2026-01-01T00:00:00Z",
  );
}

function insertArchivedRow(executionId: string, executionJson: string): void {
  db.prepare(
    `INSERT INTO graph_workflow_archived_executions (
       project_path, session_name, execution_id, archived_at,
       status, started_at, completed_at, execution_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    executionId,
    "2026-01-02T01:00:00Z",
    "completed",
    "2026-01-01T00:00:00Z",
    "2026-01-02T00:00:00Z",
    executionJson,
  );
}

function storedActive(): Record<string, unknown> {
  const row = db
    .prepare(
      `SELECT definition_json FROM graph_workflow_executions
        WHERE project_path = ? AND session_name = ?`,
    )
    .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
  return JSON.parse(row.definition_json) as Record<string, unknown>;
}

function storedArchivedJson(executionId: string): string {
  const row = db
    .prepare(
      `SELECT execution_json FROM graph_workflow_archived_executions
        WHERE project_path = ? AND session_name = ? AND execution_id = ?`,
    )
    .get(PROJECT_PATH, SESSION_NAME, executionId) as { execution_json: string };
  return row.execution_json;
}

function lanesOf(blob: Record<string, unknown>): string[] {
  const definition = blob.workingDefinition as {
    executionContexts: StoredContext[];
  };
  return definition.executionContexts.map(
    (context) => context.placement?.lane ?? "<absent>",
  );
}

async function run(): Promise<void> {
  await graphWorkflowContextPlacement.up({
    name: graphWorkflowContextPlacement.name,
    context: { db, configDir: null },
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    "/wt/s1",
    "csm/s1",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
});

afterEach(() => {
  db.close();
});

describe("0016-graph-workflow-context-placement", () => {
  it("backfills one deterministically encoded lane per context into the active tier, and drops lanePlan", async () => {
    insertActiveRow(prePlacementBlob());

    await run();

    const blob = storedActive();
    expect(blob).not.toHaveProperty("lanePlan");
    expect(lanesOf(blob)).toEqual(["build_api", "build_api-2", "ship"]);
  });

  it("backfills an archived execution, whose row nothing else ever rewrites", async () => {
    insertArchivedRow("wf-archived", prePlacementBlob());

    await run();

    const blob = JSON.parse(storedArchivedJson("wf-archived")) as Record<
      string,
      unknown
    >;
    expect(blob).not.toHaveProperty("lanePlan");
    expect(lanesOf(blob)).toEqual(["build_api", "build_api-2", "ship"]);
  });

  it("is idempotent: a replay leaves already-migrated bytes untouched", async () => {
    insertArchivedRow("wf-archived", prePlacementBlob());

    await run();
    const afterFirst = storedArchivedJson("wf-archived");
    await run();

    expect(storedArchivedJson("wf-archived")).toBe(afterFirst);
  });

  it("stamps the compatibility version that fences out builds predating placement", async () => {
    await run();

    const stamped = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    // 5 is this migration's own fence, not the build's current ceiling: the
    // abandon-coordinator cutover fences independently at 6.
    expect(stamped.version).toBe(5);
  });
});
