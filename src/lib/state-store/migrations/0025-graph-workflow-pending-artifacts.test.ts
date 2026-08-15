import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { graphWorkflowPendingArtifacts } from "./0025-graph-workflow-pending-artifacts";

type Db = InstanceType<typeof Database>;

let rawDb: Db | null = null;
let fixture: PersistenceFixture | null = null;

afterEach(() => {
  rawDb?.close();
  rawDb = null;
  fixture?.close();
  fixture = null;
});

async function runMigration(db: Db): Promise<void> {
  await graphWorkflowPendingArtifacts.up({
    name: graphWorkflowPendingArtifacts.name,
    context: { db, configDir: null },
  });
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/**
 * A database that predates the floor entry: it has the FK parent the table
 * references and nothing else, so the migration exercises the real CREATE
 * rather than the already-present no-op path.
 */
const PRE_0025_DDL = `
  CREATE TABLE projects (root_path TEXT PRIMARY KEY);
  CREATE TABLE sessions (
    project_path     TEXT NOT NULL,
    session_name     TEXT NOT NULL,
    worktree_path    TEXT NOT NULL,
    branch_name      TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    PRIMARY KEY (project_path, session_name)
  );
`;

describe("0025-graph-workflow-pending-artifacts", () => {
  it("creates the pending-artifact table on a pre-floor database", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(PRE_0025_DDL);
    expect(tableNames(rawDb)).not.toContain("graph_workflow_pending_artifacts");

    await runMigration(rawDb);

    expect(tableNames(rawDb)).toContain("graph_workflow_pending_artifacts");
    rawDb.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/p1");
    rawDb
      .prepare(
        `INSERT INTO sessions (
           project_path, session_name, worktree_path, branch_name,
           created_at, last_activity_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "/p1",
        "s1",
        "/p1/.worktrees/s1",
        "csm/s1",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    rawDb
      .prepare(
        `INSERT INTO graph_workflow_pending_artifacts (
           execution_id, project_path, session_name, documents_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("exec-1", "/p1", "s1", "[]", "2026-08-13T00:00:00.000Z");
    expect(
      rawDb
        .prepare("SELECT COUNT(*) AS n FROM graph_workflow_pending_artifacts")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("is a no-op replay against a floor-initialized database", async () => {
    fixture = createPersistenceFixture();
    const before = tableNames(fixture.db).sort();

    await runMigration(fixture.db);
    await runMigration(fixture.db);

    expect(tableNames(fixture.db).sort()).toEqual(before);
    expect(before).toContain("graph_workflow_pending_artifacts");
  });
});
