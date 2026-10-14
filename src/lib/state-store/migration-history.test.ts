import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  RETIRED_HISTORY_BUILD,
  RETIRED_MIGRATION_NAMES,
  RetiredMigrationHistoryError,
  classifyMigrationHistory,
} from "./migration-history";
import {
  DEPLOY_1_5_CONVERSATION_ID,
  DEPLOY_1_5_PROJECT_CONVERSATION_ID,
  DEPLOY_1_5_PROJECT_PATH,
  DEPLOY_1_5_SESSION_NAME,
  createDeploy15Database,
} from "./migrations/testing/deploy-1-5-database";
import { _createTestDb, _createTestDbAtPath } from "./state-db";

type Db = InstanceType<typeof Database>;

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-migration-history-"));
  scratchDirs.push(dir);
  return dir;
}

function ledger(db: Db): string[] {
  return db
    .prepare("SELECT name FROM applied_migrations ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

const RETIRED_SORTED = [...RETIRED_MIGRATION_NAMES].sort();

/**
 * What a refused or untouched open must leave as it found it: the schema, every
 * row of every table (the ledger and the version table included) and the
 * compatibility barrier files.
 */
function dataDirectoryState(configDir: string) {
  const db = new Database(path.join(configDir, "command-center.db"));
  try {
    const schema = db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
      )
      .all();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    const rows = Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    );
    const barriers = Object.fromEntries(
      readdirSync(configDir)
        .filter((name) =>
          /^command-center\.schema-version-\d+\.json$/.test(name),
        )
        .sort()
        .map((name) => [
          name,
          readFileSync(path.join(configDir, name), "utf8"),
        ]),
    );
    return { schema, rows, barriers };
  } finally {
    db.close();
  }
}

function openRefusal(dbPath: string): RetiredMigrationHistoryError {
  try {
    _createTestDbAtPath(dbPath).close();
  } catch (error) {
    if (error instanceof RetiredMigrationHistoryError) return error;
    throw error;
  }
  throw new Error(`expected ${dbPath} to be refused`);
}

describe("retired migration history", () => {
  it("stamps every retired migration on a fresh database, so its next open is eligible", () => {
    const dbPath = path.join(scratchDir(), "command-center.db");

    const created = _createTestDbAtPath(dbPath);
    expect(ledger(created)).toEqual(RETIRED_SORTED);
    created.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      expect(classifyMigrationHistory(reopened)).toBe("eligible");
      expect(ledger(reopened)).toEqual(RETIRED_SORTED);
    } finally {
      reopened.close();
    }
  });

  it("stamps an in-memory database like any fresh one", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      expect(ledger(db)).toEqual(RETIRED_SORTED);
    } finally {
      db.close();
    }
  });

  it("opens deploy 1.5's database as eligible without changing its schema, rows or ledger", async () => {
    const configDir = scratchDir();
    const dbPath = createDeploy15Database(configDir);
    const before = dataDirectoryState(configDir);
    const probe = new Database(dbPath);
    try {
      expect(classifyMigrationHistory(probe)).toBe("eligible");
    } finally {
      probe.close();
    }

    _createTestDbAtPath(dbPath).close();

    expect(dataDirectoryState(configDir)).toEqual(before);
    const fixture = createPersistenceFixture({
      db: _createTestDbAtPath(dbPath),
    });
    try {
      await expect(
        fixture.store.getConversation(
          DEPLOY_1_5_PROJECT_PATH,
          DEPLOY_1_5_SESSION_NAME,
          DEPLOY_1_5_CONVERSATION_ID,
        ),
      ).resolves.toMatchObject({
        id: DEPLOY_1_5_CONVERSATION_ID,
        name: "Session conversation",
        promptCount: 2,
      });
      await expect(
        fixture.store.getProjectConversation(
          DEPLOY_1_5_PROJECT_PATH,
          DEPLOY_1_5_PROJECT_CONVERSATION_ID,
        ),
      ).resolves.toMatchObject({
        id: DEPLOY_1_5_PROJECT_CONVERSATION_ID,
        name: "Project conversation",
      });
    } finally {
      fixture.close();
    }
  });

  it("refuses a ledger missing one retired migration, naming it and the build that finishes it, and changes nothing", () => {
    const configDir = scratchDir();
    const dbPath = createDeploy15Database(configDir);
    const raw = new Database(dbPath);
    raw
      .prepare("DELETE FROM applied_migrations WHERE name = ?")
      .run("0042-add-memory-telemetry");
    raw.close();
    const before = dataDirectoryState(configDir);

    const refusal = openRefusal(dbPath);

    expect(refusal.missing).toEqual(["0042-add-memory-telemetry"]);
    expect(refusal.message).toBe(
      "This database has not applied every migration this build retired (missing: 0042-add-memory-telemetry). " +
        `Start build ${RETIRED_HISTORY_BUILD.tag} (${RETIRED_HISTORY_BUILD.sha}) on it once so its startup migrations finish, then start this build. ` +
        "A disposable dev instance can delete its .config directory instead.",
    );
    expect(dataDirectoryState(configDir)).toEqual(before);
  });

  it("refuses a database that predates the migration ledger, naming the first three missing and counting the rest", () => {
    const configDir = scratchDir();
    const dbPath = path.join(configDir, "command-center.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE projects (root_path TEXT PRIMARY KEY);
      INSERT INTO projects (root_path) VALUES ('/before/umzug');
    `);
    raw.close();
    const before = dataDirectoryState(configDir);

    const refusal = openRefusal(dbPath);

    expect(refusal.missing).toEqual([...RETIRED_MIGRATION_NAMES]);
    expect(refusal.message).toContain(
      "(missing: 0001-drop-legacy-roadmap-items, 0002-split-graph-workflow-history, 0003-split-graph-workflow-execution, and 76 more)",
    );
    expect(dataDirectoryState(configDir)).toEqual(before);
  });
});
