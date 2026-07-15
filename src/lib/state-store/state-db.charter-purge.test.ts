import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  KNOWN_SCHEMA_VERSION,
  LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
  LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID,
  LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
  _createTestDbAtPath,
  _setLegacyWorkflowPurgeFsOpsForTesting,
  runLegacyWorkflowPurgeMigration,
} from "./state-db";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo/example";

function newTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cc-charter-purge-"));
}

function dbPathIn(dir: string): string {
  return path.join(dir, "command-center.db");
}

function workflowsRootIn(dir: string): string {
  return path.join(dir, "workflows");
}

function seedWorkflowDefinitionFile(configDir: string, id: string): string {
  const projectKey = Buffer.from(PROJECT_PATH).toString("base64url");
  const projectDir = path.join(workflowsRootIn(configDir), projectKey);
  mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify({ id, name: "legacy" }), "utf-8");
  return filePath;
}

function insertProject(db: Db, rootPath: string): void {
  db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(rootPath);
}

function insertSession(
  db: Db,
  opts: {
    sessionName: string;
    execution: string | null;
    history: string;
  },
): void {
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at,
       graph_workflow_execution, graph_workflow_execution_history
     ) VALUES (
       @project_path, @session_name, @worktree_path, @branch_name,
       @created_at, @last_activity_at,
       @graph_workflow_execution, @graph_workflow_execution_history
     )`,
  ).run({
    project_path: PROJECT_PATH,
    session_name: opts.sessionName,
    worktree_path: `/wt/${opts.sessionName}`,
    branch_name: `csm/${opts.sessionName}`,
    created_at: "2025-01-01T00:00:00.000Z",
    last_activity_at: "2025-01-01T00:00:00.000Z",
    graph_workflow_execution: opts.execution,
    graph_workflow_execution_history: opts.history,
  });
}

function readSession(
  db: Db,
  sessionName: string,
): { execution: string | null; history: string } {
  const row = db
    .prepare(
      `SELECT graph_workflow_execution AS execution,
              graph_workflow_execution_history AS history
         FROM sessions WHERE session_name = ?`,
    )
    .get(sessionName) as { execution: string | null; history: string };
  return row;
}

function markerCount(
  db: Db,
  id: string = LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM applied_data_migrations WHERE id = ?`)
    .get(id) as { n: number };
  return row.n;
}

/**
 * Simulate a pre-migration DB: opening to seed fixtures necessarily runs the
 * migration once, which records the marker. Removing the marker makes the
 * NEXT open re-run the purge against the just-seeded legacy data.
 */
function resetPurgeFixture(db: Db, configDir: string): void {
  db.prepare("DELETE FROM applied_data_migrations WHERE id IN (?, ?)").run(
    LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
    LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID,
  );
  rmSync(path.join(configDir, LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME), {
    recursive: true,
    force: true,
  });
}

describe("legacy workflow charter purge migration", () => {
  const openDbs: Db[] = [];

  afterEach(() => {
    _setLegacyWorkflowPurgeFsOpsForTesting(null);
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  function open(dbPath: string): Db {
    const db = _createTestDbAtPath(dbPath);
    openDbs.push(db);
    return db;
  }

  it("nulls embedded executions, deletes definition files, and records the marker on first run", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);

    // Bootstrap the schema so we can seed rows before the migration runs.
    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    insertSession(bootstrap, {
      sessionName: "legacy-a",
      execution: JSON.stringify({ executionId: "exec-a", status: "running" }),
      history: JSON.stringify([{ executionId: "exec-a" }]),
    });
    insertSession(bootstrap, {
      sessionName: "legacy-b",
      execution: JSON.stringify({ executionId: "exec-b", status: "halted" }),
      history: JSON.stringify([{ executionId: "exec-b" }]),
    });
    resetPurgeFixture(bootstrap, dir);
    bootstrap.close();
    openDbs.pop();

    const defFile = seedWorkflowDefinitionFile(dir, "wf-1");
    expect(existsSync(defFile)).toBe(true);

    // Reopen: the migration runs as part of initializeSchema.
    const db = open(dbPath);

    const a = readSession(db, "legacy-a");
    const b = readSession(db, "legacy-b");
    expect(a.execution).toBeNull();
    expect(a.history).toBe("[]");
    expect(b.execution).toBeNull();
    expect(b.history).toBe("[]");

    expect(existsSync(defFile)).toBe(false);
    expect(existsSync(workflowsRootIn(dir))).toBe(false);
    expect(markerCount(db)).toBe(1);
  });

  it("is a no-op on a second run: a newly seeded valid execution and def file survive", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);

    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    insertSession(bootstrap, {
      sessionName: "legacy-a",
      execution: JSON.stringify({ executionId: "exec-a", status: "running" }),
      history: JSON.stringify([{ executionId: "exec-a" }]),
    });
    resetPurgeFixture(bootstrap, dir);
    bootstrap.close();
    openDbs.pop();

    seedWorkflowDefinitionFile(dir, "wf-1");

    // First open runs the migration and records the marker.
    const first = open(dbPath);
    expect(markerCount(first)).toBe(1);

    // Seed NEW, valid (charter-bearing) state AFTER the migration.
    const freshExecution = JSON.stringify({
      executionId: "exec-new",
      status: "running",
      charter: { mission: "x", sourcesOfTruth: [{ rank: 1, id: "s" }] },
    });
    first
      .prepare(
        `UPDATE sessions
           SET graph_workflow_execution = ?,
               graph_workflow_execution_history = ?
         WHERE session_name = 'legacy-a'`,
      )
      .run(freshExecution, JSON.stringify([{ executionId: "exec-new" }]));
    first.close();
    openDbs.pop();

    const newDefFile = seedWorkflowDefinitionFile(dir, "wf-2");

    // Reopen: the migration must NOT touch the new state.
    const second = open(dbPath);
    const row = readSession(second, "legacy-a");
    expect(row.execution).toBe(freshExecution);
    expect(row.history).toBe(JSON.stringify([{ executionId: "exec-new" }]));
    expect(existsSync(newDefFile)).toBe(true);
    expect(markerCount(second)).toBe(1);
  });

  it("is concurrency-safe: a second connection opening the same DB after the migration applied does not crash, re-run the purge, or duplicate the marker", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);

    // First open runs the migration once and records the marker.
    const first = open(dbPath);
    expect(markerCount(first)).toBe(1);

    // Seed NEW, valid (charter-bearing) state AFTER the migration so we can
    // prove a concurrent open does NOT re-run the purge against it.
    const freshExecution = JSON.stringify({
      executionId: "exec-new",
      status: "running",
      charter: { mission: "x", sourcesOfTruth: [{ rank: 1, id: "s" }] },
    });
    insertProject(first, PROJECT_PATH);
    insertSession(first, {
      sessionName: "valid-after",
      execution: freshExecution,
      history: JSON.stringify([{ executionId: "exec-new" }]),
    });

    const newDefFile = seedWorkflowDefinitionFile(dir, "wf-after");

    // A SECOND connection opens the SAME file-backed DB while the first remains
    // open. With the old SELECT-then-INSERT guard this INSERT would violate the
    // applied_data_migrations PRIMARY KEY and throw at DB open.
    let second: Db | undefined;
    expect(() => {
      second = open(dbPath);
    }).not.toThrow();
    if (!second) {
      throw new Error("second open did not produce a DB");
    }

    expect(markerCount(second)).toBe(1);

    // The purge must NOT have re-run: the charter-bearing execution and its def
    // file survive untouched.
    const row = readSession(second, "valid-after");
    expect(row.execution).toBe(freshExecution);
    expect(row.history).toBe(JSON.stringify([{ executionId: "exec-new" }]));
    expect(existsSync(newDefFile)).toBe(true);
  });

  it("leaves SQLite unchanged when capture setup fails and retries the whole cutover", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    insertSession(bootstrap, {
      sessionName: "legacy-crash",
      execution: JSON.stringify({ executionId: "exec-crash" }),
      history: JSON.stringify([{ executionId: "exec-crash" }]),
    });
    resetPurgeFixture(bootstrap, dir);
    bootstrap.close();
    openDbs.pop();

    const legacyDefinition = seedWorkflowDefinitionFile(dir, "wf-crash");
    const quarantineRoot = path.join(
      dir,
      LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
    );
    writeFileSync(quarantineRoot, "blocks quarantine directory creation");

    expect(() => open(dbPath)).toThrow();

    const probe = new Database(dbPath);
    try {
      expect(readSession(probe, "legacy-crash")).toEqual({
        execution: JSON.stringify({ executionId: "exec-crash" }),
        history: JSON.stringify([{ executionId: "exec-crash" }]),
      });
      expect(
        markerCount(probe, LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID),
      ).toBe(0);
      expect(markerCount(probe)).toBe(0);
    } finally {
      probe.close();
    }
    expect(existsSync(legacyDefinition)).toBe(true);

    rmSync(quarantineRoot, { force: true });
    const retried = open(dbPath);
    expect(markerCount(retried)).toBe(1);
    expect(existsSync(legacyDefinition)).toBe(false);
    expect(existsSync(path.join(quarantineRoot, "captured-workflows"))).toBe(
      true,
    );
  });

  it("never recaptures a fresh workflow after capture succeeded but the SQL reset rolled back", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    insertSession(bootstrap, {
      sessionName: "legacy-post-capture-failure",
      execution: JSON.stringify({ executionId: "exec-legacy" }),
      history: JSON.stringify([{ executionId: "exec-legacy" }]),
    });
    resetPurgeFixture(bootstrap, dir);
    bootstrap.exec(`
      CREATE TRIGGER reject_workflow_purge_claim
      BEFORE INSERT ON applied_data_migrations
      WHEN NEW.id = '${LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated SQL failure after capture');
      END;
    `);
    bootstrap.close();
    openDbs.pop();

    const legacyDefinition = seedWorkflowDefinitionFile(dir, "wf-legacy");
    const capturedRoot = path.join(
      dir,
      LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
      "captured-workflows",
    );
    const capturedLegacyDefinition = path.join(
      capturedRoot,
      path.relative(workflowsRootIn(dir), legacyDefinition),
    );

    expect(() => open(dbPath)).toThrow("simulated SQL failure after capture");
    expect(existsSync(legacyDefinition)).toBe(false);
    expect(existsSync(capturedLegacyDefinition)).toBe(true);

    const repair = new Database(dbPath);
    repair.exec("DROP TRIGGER reject_workflow_purge_claim");
    repair.close();
    const freshDefinition = seedWorkflowDefinitionFile(dir, "wf-fresh");

    const retried = open(dbPath);
    expect(markerCount(retried)).toBe(1);
    expect(existsSync(capturedLegacyDefinition)).toBe(false);
    expect(existsSync(freshDefinition)).toBe(true);
  });

  it("preserves fresh state when upgrading a pending-only pre-capture claim", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    resetPurgeFixture(bootstrap, dir);
    bootstrap
      .prepare("INSERT INTO applied_data_migrations (id) VALUES (?)")
      .run(LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID);

    const freshExecution = JSON.stringify({
      executionId: "exec-after-pending",
      charter: { mission: "fresh" },
    });
    insertSession(bootstrap, {
      sessionName: "fresh-after-pending",
      execution: freshExecution,
      history: JSON.stringify([{ executionId: "exec-after-pending" }]),
    });
    bootstrap.close();
    openDbs.pop();
    const freshDefinition = seedWorkflowDefinitionFile(dir, "wf-after-pending");

    const retried = open(dbPath);

    expect(markerCount(retried)).toBe(1);
    expect(readSession(retried, "fresh-after-pending")).toEqual({
      execution: freshExecution,
      history: JSON.stringify([{ executionId: "exec-after-pending" }]),
    });
    expect(existsSync(freshDefinition)).toBe(true);
    expect(
      existsSync(
        path.join(
          dir,
          LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
          "captured-workflows",
        ),
      ),
    ).toBe(true);
  });

  it("syncs both capture parents before recording completion", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    const bootstrap = open(dbPath);
    resetPurgeFixture(bootstrap, dir);
    bootstrap.close();
    openDbs.pop();

    seedWorkflowDefinitionFile(dir, "wf-durable");
    const syncedDirectories: string[] = [];
    _setLegacyWorkflowPurgeFsOpsForTesting({
      syncDirectory(dirPath) {
        syncedDirectories.push(dirPath);
      },
    });

    const migrated = open(dbPath);

    expect(markerCount(migrated)).toBe(1);
    expect(syncedDirectories.slice(0, 2)).toEqual([
      path.join(dir, LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME),
      dir,
    ]);
  });

  it("does not commit the reset or completion when capture-directory fsync fails", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    insertSession(bootstrap, {
      sessionName: "legacy-fsync-failure",
      execution: JSON.stringify({ executionId: "exec-fsync" }),
      history: JSON.stringify([{ executionId: "exec-fsync" }]),
    });
    resetPurgeFixture(bootstrap, dir);
    bootstrap.close();
    openDbs.pop();
    seedWorkflowDefinitionFile(dir, "wf-fsync");

    const quarantineRoot = path.join(
      dir,
      LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
    );
    _setLegacyWorkflowPurgeFsOpsForTesting({
      syncDirectory(dirPath) {
        if (dirPath === quarantineRoot) {
          throw Object.assign(new Error("capture fsync failed"), {
            code: "EIO",
          });
        }
      },
    });

    expect(() => open(dbPath)).toThrow("capture fsync failed");

    const probe = new Database(dbPath);
    expect(readSession(probe, "legacy-fsync-failure")).toEqual({
      execution: JSON.stringify({ executionId: "exec-fsync" }),
      history: JSON.stringify([{ executionId: "exec-fsync" }]),
    });
    expect(markerCount(probe)).toBe(0);
    expect(markerCount(probe, LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID)).toBe(
      0,
    );
    probe.close();
  });

  it("serializes concurrent missing-source finalizers and converges on one sentinel", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    const first = open(dbPath);
    resetPurgeFixture(first, dir);

    const second = new Database(dbPath, { timeout: 1 });
    openDbs.push(second);
    const capturedRoot = path.join(
      dir,
      LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
      "captured-workflows",
    );
    let competingAttemptBlocked = false;
    let injectCompetingAttempt = true;
    _setLegacyWorkflowPurgeFsOpsForTesting({
      exists(targetPath) {
        if (injectCompetingAttempt && targetPath === capturedRoot) {
          injectCompetingAttempt = false;
          try {
            runLegacyWorkflowPurgeMigration(second, dir, dbPath);
          } catch (err) {
            if ((err as { code?: string }).code !== "SQLITE_BUSY") throw err;
            competingAttemptBlocked = true;
          }
        }
        return existsSync(targetPath);
      },
    });

    expect(() =>
      runLegacyWorkflowPurgeMigration(first, dir, dbPath),
    ).not.toThrow();
    expect(competingAttemptBlocked).toBe(true);
    expect(() =>
      runLegacyWorkflowPurgeMigration(second, dir, dbPath),
    ).not.toThrow();

    expect(markerCount(first)).toBe(1);
    expect(existsSync(capturedRoot)).toBe(true);
  });

  it("uses the captured-directory sentinel to preserve workflows created after a crash", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    const bootstrap = open(dbPath);
    insertProject(bootstrap, PROJECT_PATH);
    insertSession(bootstrap, {
      sessionName: "legacy-captured",
      execution: JSON.stringify({ executionId: "exec-captured" }),
      history: JSON.stringify([{ executionId: "exec-captured" }]),
    });
    resetPurgeFixture(bootstrap, dir);
    bootstrap.close();
    openDbs.pop();

    const legacyDefinition = seedWorkflowDefinitionFile(dir, "wf-legacy");
    const quarantineRoot = path.join(
      dir,
      LEGACY_WORKFLOW_PURGE_QUARANTINE_DIR_NAME,
    );
    writeFileSync(quarantineRoot, "force post-claim startup failure");
    expect(() => open(dbPath)).toThrow();
    rmSync(quarantineRoot, { force: true });

    const capturedRoot = path.join(quarantineRoot, "captured-workflows");
    const capturedLegacyDefinition = path.join(
      capturedRoot,
      path.relative(workflowsRootIn(dir), legacyDefinition),
    );
    mkdirSync(quarantineRoot);
    renameSync(workflowsRootIn(dir), capturedRoot);
    const crashProbe = new Database(dbPath);
    crashProbe
      .prepare("INSERT OR IGNORE INTO applied_data_migrations (id) VALUES (?)")
      .run(LEGACY_WORKFLOW_PURGE_MIGRATION_ID);
    crashProbe
      .prepare("INSERT OR IGNORE INTO applied_data_migrations (id) VALUES (?)")
      .run(LEGACY_WORKFLOW_PURGE_PENDING_MIGRATION_ID);
    crashProbe.close();
    const freshDefinition = seedWorkflowDefinitionFile(dir, "wf-fresh");

    const retried = open(dbPath);
    expect(markerCount(retried)).toBe(1);
    expect(existsSync(capturedLegacyDefinition)).toBe(false);
    expect(existsSync(freshDefinition)).toBe(true);
    expect(existsSync(capturedRoot)).toBe(true);
  });

  it("tolerates a missing workflows directory", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);
    // No workflows dir, no sessions seeded.
    const db = open(dbPath);
    expect(existsSync(workflowsRootIn(dir))).toBe(false);
    expect(markerCount(db)).toBe(1);
  });

  it("does not trip the forward-only version gate (the purge marker never advances schema_migrations)", () => {
    const dir = newTempDir();
    const dbPath = dbPathIn(dir);

    // First build opens, runs the purge, records the data-migration marker.
    // The synchronous open path does not run the Umzug migrator, so the purge
    // must leave schema_migrations empty — it advances the gate only through
    // the dedicated applied_data_migrations table.
    const first = open(dbPath);
    const maxVersionRow = first
      .prepare(`SELECT MAX(version) AS maxVersion FROM schema_migrations`)
      .get() as { maxVersion: number | null };
    expect(maxVersionRow.maxVersion ?? 0).toBe(0);
    expect(maxVersionRow.maxVersion ?? 0).toBeLessThanOrEqual(
      KNOWN_SCHEMA_VERSION,
    );
    first.close();
    openDbs.pop();

    // A second build with the same KNOWN_SCHEMA_VERSION must still open.
    expect(() => {
      const second = open(dbPath);
      second.close();
      openDbs.pop();
    }).not.toThrow();
  });
});
