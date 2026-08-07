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
import { runMigrations } from "../migrator";
import { mintGraphWorkflowEdgeIds } from "./0015-mint-graph-workflow-edge-ids";

type Db = InstanceType<typeof BetterSqlite3>;

const PROJECT_PATH = "/repos/legacy-edges";
const SESSION_NAME = "s1";
/** A second session in the SAME project, and a second project entirely. */
const SIBLING_SESSION_NAME = "s2";
const OTHER_PROJECT_PATH = "/repos/other-legacy-edges";

let db: Db;

function registerSession(projectPath: string, sessionName: string): void {
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    projectPath,
    sessionName,
    `/wt/${sessionName}`,
    `csm/${sessionName}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const insertProject = db.prepare(
    "INSERT INTO projects (root_path) VALUES (?)",
  );
  insertProject.run(PROJECT_PATH);
  insertProject.run(OTHER_PROJECT_PATH);
  registerSession(PROJECT_PATH, SESSION_NAME);
  registerSession(PROJECT_PATH, SIBLING_SESSION_NAME);
  registerSession(OTHER_PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  db.close();
});

/**
 * A pre-D4 definition tier: two parallel edges, neither carrying an id.
 * `prefix` names the contexts, so blobs from different scopes are
 * distinguishable after the migration has rewritten them.
 */
function legacyDefinitionTierFor(prefix: string): string {
  return JSON.stringify({
    id: "wf-legacy",
    seedDefinitionId: "seed-legacy",
    seedDefinitionRevision: 1,
    workingDefinition: {
      executionContexts: [
        { id: `${prefix}-1`, title: "First", description: "d1" },
        { id: `${prefix}-2`, title: "Second", description: "d2" },
      ],
      tasks: [],
      edges: [
        { sourceContextId: `${prefix}-1`, targetContextId: `${prefix}-2` },
        { sourceContextId: `${prefix}-1`, targetContextId: `${prefix}-2` },
      ],
    },
  });
}

function legacyDefinitionTier(): string {
  return legacyDefinitionTierFor("ctx");
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

function insertArchivedRowIn(
  projectPath: string,
  sessionName: string,
  executionId: string,
  executionJson: string,
): void {
  db.prepare(
    `INSERT INTO graph_workflow_archived_executions (
       project_path, session_name, execution_id, archived_at,
       status, started_at, completed_at, execution_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectPath,
    sessionName,
    executionId,
    "2026-01-02T01:00:00Z",
    "completed",
    "2026-01-01T00:00:00Z",
    "2026-01-02T00:00:00Z",
    executionJson,
  );
}

function storedActiveEdges(): { id?: string }[] {
  const row = db
    .prepare(
      `SELECT definition_json FROM graph_workflow_executions
        WHERE project_path = ? AND session_name = ?`,
    )
    .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
  return (
    JSON.parse(row.definition_json) as {
      workingDefinition: { edges: { id?: string }[] };
    }
  ).workingDefinition.edges;
}

/** Archive rows live in the default scope unless a test says otherwise. */
function insertArchivedRow(executionId: string, executionJson: string): void {
  insertArchivedRowIn(PROJECT_PATH, SESSION_NAME, executionId, executionJson);
}

/**
 * Read back by the COMPLETE archive key. The table is keyed
 * (project_path, session_name, execution_id), so a reader that matches on the
 * id alone would silently pick one of several sibling rows — the same mistake
 * this suite exists to catch in the migration.
 */
function storedArchivedJsonIn(
  projectPath: string,
  sessionName: string,
  executionId: string,
): string {
  const row = db
    .prepare(
      `SELECT execution_json FROM graph_workflow_archived_executions
        WHERE project_path = ? AND session_name = ? AND execution_id = ?`,
    )
    .get(projectPath, sessionName, executionId) as { execution_json: string };
  return row.execution_json;
}

function storedArchivedJson(executionId: string): string {
  return storedArchivedJsonIn(PROJECT_PATH, SESSION_NAME, executionId);
}

async function run(): Promise<void> {
  await mintGraphWorkflowEdgeIds.up({
    name: mintGraphWorkflowEdgeIds.name,
    context: { db, configDir: null },
  });
}

describe("0015-mint-graph-workflow-edge-ids", () => {
  // D4 made `edges[].id` required (decision D2). The read path repairs a legacy
  // row on inflate, but a repair that is only ever re-derived leaves the stored
  // bytes disagreeing with every id-addressed reference taken from them — and an
  // ARCHIVED row is never rewritten at all, so for that tier the read-time repair
  // is the only thing standing between the data and permanent unreadability.
  // This migration puts the minted ids in the column, once.
  it("mints ids into a stored active definition tier", async () => {
    insertActiveRow(legacyDefinitionTier());

    await run();

    expect(storedActiveEdges().map((edge) => edge.id)).toEqual([
      "ctx-1__ctx-2",
      "ctx-1__ctx-2-2",
    ]);
  });

  it("mints ids into a stored archived execution blob", async () => {
    insertArchivedRow("wf-archived", legacyDefinitionTier());

    await run();

    const edges = (
      JSON.parse(storedArchivedJson("wf-archived")) as {
        workingDefinition: { edges: { id?: string }[] };
      }
    ).workingDefinition.edges;
    expect(edges.map((edge) => edge.id)).toEqual([
      "ctx-1__ctx-2",
      "ctx-1__ctx-2-2",
    ]);
  });

  // The runner records completion in a separate step from running `up`, so a
  // crash in between replays it. A second pass must be a no-op, not a re-mint
  // that renames edges an id-addressed edit already referenced.
  it("is idempotent across a replay", async () => {
    insertActiveRow(legacyDefinitionTier());
    insertArchivedRow("wf-archived", legacyDefinitionTier());

    await run();
    const afterFirst = storedArchivedJson("wf-archived");
    const activeAfterFirst = storedActiveEdges();
    await run();

    expect(storedArchivedJson("wf-archived")).toEqual(afterFirst);
    expect(storedActiveEdges()).toEqual(activeAfterFirst);
  });

  // Additive means additive: a row already carrying ids keeps its exact bytes,
  // so the migration cannot churn rows or invent state on a current database.
  it("leaves an already-current row byte-identical", async () => {
    const current = JSON.stringify({
      id: "wf-current",
      workingDefinition: {
        executionContexts: [{ id: "ctx-1", title: "First", description: "d" }],
        tasks: [],
        edges: [
          {
            id: "author-chose-this",
            sourceContextId: "ctx-1",
            targetContextId: "ctx-2",
          },
        ],
      },
    });
    insertActiveRow(current);
    insertArchivedRow("wf-current", current);

    await run();

    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    expect(row.definition_json).toBe(current);
    expect(storedArchivedJson("wf-current")).toBe(current);
  });

  it("preserves every non-edge field of the blob", async () => {
    insertActiveRow(legacyDefinitionTier());

    await run();

    const row = db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME) as { definition_json: string };
    const stored = JSON.parse(row.definition_json) as Record<string, unknown>;
    expect(stored.id).toBe("wf-legacy");
    expect(stored.seedDefinitionId).toBe("seed-legacy");
    expect(
      (stored.workingDefinition as { executionContexts: unknown[] })
        .executionContexts,
    ).toHaveLength(2);
  });

  // An unparseable or endpoint-less row must not abort the run: a migration that
  // throws on one bad row blocks every later migration and the server start.
  it("skips a row it cannot repair without failing the run", async () => {
    insertActiveRow("{not json");
    insertArchivedRow(
      "wf-bad-endpoints",
      JSON.stringify({
        workingDefinition: {
          edges: [{ sourceContextId: "", targetContextId: "" }],
        },
      }),
    );

    await expect(run()).resolves.toBeUndefined();
    expect(storedArchivedJson("wf-bad-endpoints")).toContain("sourceContextId");
  });

  // The archive table is keyed (project_path, session_name, execution_id), and
  // execution ids are only unique WITHIN a session — two sessions, or two
  // projects, can hold archived executions sharing an id. An UPDATE that matches
  // on the id alone rewrites all of them with whichever row it happened to
  // repair last, destroying the others' history irreversibly.
  it("repairs each scope's archived row without touching its same-id siblings", async () => {
    const scopes = [
      { projectPath: PROJECT_PATH, sessionName: SESSION_NAME, prefix: "alpha" },
      {
        projectPath: PROJECT_PATH,
        sessionName: SIBLING_SESSION_NAME,
        prefix: "beta",
      },
      {
        projectPath: OTHER_PROJECT_PATH,
        sessionName: SESSION_NAME,
        prefix: "gamma",
      },
    ] as const;
    for (const scope of scopes) {
      insertArchivedRowIn(
        scope.projectPath,
        scope.sessionName,
        "wf-shared-id",
        legacyDefinitionTierFor(scope.prefix),
      );
    }

    await run();

    for (const scope of scopes) {
      const edges = (
        JSON.parse(
          storedArchivedJsonIn(
            scope.projectPath,
            scope.sessionName,
            "wf-shared-id",
          ),
        ) as {
          workingDefinition: {
            edges: { id?: string; sourceContextId: string }[];
          };
        }
      ).workingDefinition.edges;
      // Still ITS OWN contexts — not a sibling scope's blob copied over it...
      expect(edges.map((edge) => edge.sourceContextId)).toEqual([
        `${scope.prefix}-1`,
        `${scope.prefix}-1`,
      ]);
      // ...and its own ids were nonetheless minted.
      expect(edges.map((edge) => edge.id)).toEqual([
        `${scope.prefix}-1__${scope.prefix}-2`,
        `${scope.prefix}-1__${scope.prefix}-2-2`,
      ]);
    }
  });

  it("is registered in the ordered migration runner", async () => {
    insertActiveRow(legacyDefinitionTier());

    await runMigrations({ db, configDir: null });

    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM graph_workflow_executions")
        .get(),
    ).toEqual({ count: 0 });
    const archivedEdges = (
      JSON.parse(storedArchivedJson("wf-legacy")) as {
        workingDefinition: { edges: { id?: string }[] };
      }
    ).workingDefinition.edges;
    expect(archivedEdges.map((edge) => edge.id)).toEqual([
      "ctx-1__ctx-2",
      "ctx-1__ctx-2-2",
    ]);
    const applied = db
      .prepare("SELECT name FROM applied_migrations WHERE name = ?")
      .get("0015-mint-graph-workflow-edge-ids");
    expect(applied).toBeDefined();
  });
});
