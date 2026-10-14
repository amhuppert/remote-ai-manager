import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  KNOWN_SCHEMA_VERSION,
  _createTestDb,
  _createTestDbAtPath,
  _resetForTesting,
  _setStateDbBeforeLockedInitializationHookForTesting,
  truncateAllTables,
} from "./state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
  schemaCompatibilityBarrierPath,
} from "./schema-compatibility";
import { RETIRED_MIGRATION_NAMES } from "./migration-history";

afterEach(() => {
  _setStateDbBeforeLockedInitializationHookForTesting(null);
  _resetForTesting();
});

const EXPECTED_TABLES = [
  "schema_migrations",
  "applied_migrations",
  "projects",
  "sessions",
  "conversations",
  "reference_documents",
  "session_markdown_documents",
  "document_comments",
  "notifications",
  "job_records",
  "runs",
] as const;

describe("state-db pragmas", () => {
  it("applies WAL, foreign_keys=ON, synchronous=FULL on a file-backed DB", () => {
    const db = _createTestDb();
    try {
      const journalRows = db.pragma("journal_mode") as {
        journal_mode: string;
      }[];
      expect(journalRows[0]?.journal_mode).toBe("wal");

      const fkRows = db.pragma("foreign_keys") as { foreign_keys: number }[];
      expect(fkRows[0]?.foreign_keys).toBe(1);

      const syncRows = db.pragma("synchronous") as { synchronous: number }[];
      expect(syncRows[0]?.synchronous).toBe(2);
    } finally {
      db.close();
    }
  });

  it("applies foreign_keys=ON and synchronous=FULL on an in-memory DB", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      const fkRows = db.pragma("foreign_keys") as { foreign_keys: number }[];
      expect(fkRows[0]?.foreign_keys).toBe(1);

      const syncRows = db.pragma("synchronous") as { synchronous: number }[];
      expect(syncRows[0]?.synchronous).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe("state-db schema initialization", () => {
  it("creates every required table", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      const tableNames = new Set(rows.map((r) => r.name));
      for (const expected of EXPECTED_TABLES) {
        expect(tableNames.has(expected)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("exposes the document_comments table and its lookup index on a fresh in-memory DB", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_comments'",
        )
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("document_comments");

      const index = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_document_comments_doc'",
        )
        .get() as { name: string } | undefined;
      expect(index?.name).toBe("idx_document_comments_doc");
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated opens against the same file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const first = _createTestDbAtPath(dbPath);
    first.close();

    const second = _createTestDbAtPath(dbPath);
    try {
      const rows = second
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      const tableNames = new Set(rows.map((r) => r.name));
      for (const expected of EXPECTED_TABLES) {
        expect(tableNames.has(expected)).toBe(true);
      }
    } finally {
      second.close();
    }
  });
});

describe("state-db additive column migrations", () => {
  it("is a no-op when pending_prompt_text already exists (idempotent)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const first = _createTestDbAtPath(dbPath);
    first.close();

    expect(() => {
      const second = _createTestDbAtPath(dbPath);
      second.close();
    }).not.toThrow();
  });
});

describe("truncateAllTables", () => {
  function tableNames(db: InstanceType<typeof Database>): string[] {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  function countRows(db: InstanceType<typeof Database>, table: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    };
    return row.n;
  }

  function seedFkChain(db: InstanceType<typeof Database>): void {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/p1");
    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "/p1",
      "s1",
      "/wt/s1",
      "csm/s1",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO conversations
         (id, project_path, session_name, status, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "c1",
      "/p1",
      "s1",
      "active",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO reference_documents
         (id, project_path, session_name, file_path, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "rd1",
      "/p1",
      "s1",
      "memory-bank/focus.md",
      "focus",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO notifications
         (id, type, title, message, project_name, session_name, branch_name, job_id, job_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("n1", "merge", "t", "m", "/p1", "s1", "csm/s1", "j1", "merge");
    db.prepare(
      `INSERT INTO job_records
         (job_id, job_type, status, project_name, session_name, branch_name, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "j1",
      "merge",
      "running",
      "/p1",
      "s1",
      "csm/s1",
      "2026-01-01T00:00:00Z",
    );
  }

  it("empties every application table while leaving schema_migrations, the migration ledger and their rows intact", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      seedFkChain(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      ).run(KNOWN_SCHEMA_VERSION, "baseline");

      const appTables = [
        "projects",
        "sessions",
        "conversations",
        "reference_documents",
        "notifications",
        "job_records",
      ] as const;
      for (const t of appTables) {
        expect(countRows(db, t)).toBeGreaterThan(0);
      }

      truncateAllTables(db);

      for (const t of appTables) {
        expect(countRows(db, t)).toBe(0);
      }
      expect(tableNames(db)).toContain("schema_migrations");
      expect(countRows(db, "schema_migrations")).toBe(1);
      expect(countRows(db, "applied_migrations")).toBe(
        RETIRED_MIGRATION_NAMES.length,
      );
    } finally {
      db.close();
    }
  });

  it("clears a runtime-created application table without a hand-maintained list (Req 4.3)", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      db.exec(
        "CREATE TABLE temp_extra_app_table (id TEXT PRIMARY KEY, value TEXT)",
      );
      db.prepare(
        "INSERT INTO temp_extra_app_table (id, value) VALUES (?, ?)",
      ).run("x", "y");
      expect(countRows(db, "temp_extra_app_table")).toBe(1);

      truncateAllTables(db);

      // A virtual table's shadow tables (`memory_notes_fts_data` and friends)
      // hold SQLite's own structural records, never application rows, and
      // refuse direct modification: the reset clears the virtual table and
      // leaves its shadows to SQLite.
      const shadowTables = new Set(
        (
          db.pragma("table_list") as Array<{
            schema: string;
            name: string;
            type: string;
          }>
        )
          .filter((row) => row.schema === "main" && row.type === "shadow")
          .map((row) => row.name),
      );
      const remaining = tableNames(db).filter(
        (n) =>
          n !== "schema_migrations" &&
          n !== "applied_migrations" &&
          !n.startsWith("sqlite_") &&
          !shadowTables.has(n),
      );
      for (const t of remaining) {
        expect(countRows(db, t)).toBe(0);
      }
      expect(remaining).toContain("temp_extra_app_table");
      expect(remaining).toContain("memory_notes_fts");
    } finally {
      db.close();
    }
  });

  it("leaves a freshly reset DB able to reopen past the forward-only version check and the retired-history guard", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const db = _createTestDbAtPath(dbPath);
    seedFkChain(db);
    truncateAllTables(db);
    db.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      expect(reopened.open).toBe(true);
    } finally {
      reopened.close();
    }
  });
});

describe("state-db forward-only schema_migrations conflict policy", () => {
  it("rechecks a barrier published after preflight under the initialization lock", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const bootstrap = new Database(dbPath);
    bootstrap.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL
      );
    `);
    bootstrap.close();

    const futureVersion = KNOWN_SCHEMA_VERSION + 1;
    _setStateDbBeforeLockedInitializationHookForTesting(() => {
      writeFileSync(
        schemaCompatibilityBarrierPath(dir, futureVersion),
        JSON.stringify({ version: futureVersion }),
      );
    });

    try {
      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      const probe = new Database(dbPath);
      try {
        const journalRows = probe.pragma("journal_mode") as Array<{
          journal_mode: string;
        }>;
        expect(journalRows[0]?.journal_mode).toBe("delete");
        const tables = probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .pluck()
          .all();
        expect(tables).toEqual(["schema_migrations"]);
      } finally {
        probe.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not change journal mode when a future version wins before the locked recheck", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const bootstrap = new Database(dbPath);
    bootstrap.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL
      );
    `);
    bootstrap.close();

    _setStateDbBeforeLockedInitializationHookForTesting(() => {
      const newer = new Database(dbPath);
      newer
        .prepare(
          "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
        )
        .run(KNOWN_SCHEMA_VERSION + 1, "newer build won startup race");
      newer.close();
    });

    try {
      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      const probe = new Database(dbPath);
      try {
        const journalRows = probe.pragma("journal_mode") as Array<{
          journal_mode: string;
        }>;
        expect(journalRows[0]?.journal_mode).toBe("delete");
      } finally {
        probe.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a future version committed only in WAL without changing any DB or sidecar bytes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const workflowsDir = path.join(dir, "workflows");
    const workflowPath = path.join(workflowsDir, "future-workflow.json");
    mkdirSync(workflowsDir);
    writeFileSync(workflowPath, '{"from":"future-build"}');

    const futureVersion = KNOWN_SCHEMA_VERSION + 1;
    const futureDb = new Database(dbPath);
    futureDb.pragma("journal_mode = WAL");
    futureDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    futureDb.pragma("wal_checkpoint(TRUNCATE)");
    futureDb
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(futureVersion, "future migration in WAL");
    await publishSchemaCompatibilityBarrier(dir, futureVersion);

    const snapshotBytes = (): Record<string, string> =>
      Object.fromEntries(
        readdirSync(dir)
          .sort()
          .filter((name) => name !== "workflows")
          .map((name) => {
            const bytes = readFileSync(path.join(dir, name));
            return [name, createHash("sha256").update(bytes).digest("hex")];
          }),
      );

    try {
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(
        existsSync(schemaCompatibilityBarrierPath(dir, futureVersion)),
      ).toBe(true);
      const before = snapshotBytes();

      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      expect(snapshotBytes()).toEqual(before);
      expect(readFileSync(workflowPath, "utf-8")).toBe(
        '{"from":"future-build"}',
      );
    } finally {
      futureDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a future-version database before changing its schema, data, or workflow files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const workflowsDir = path.join(dir, "workflows");
    const workflowPath = path.join(workflowsDir, "future-workflow.json");
    mkdirSync(workflowsDir);
    writeFileSync(workflowPath, '{"from":"future-build"}');

    const futureDb = new Database(dbPath);
    futureDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (${KNOWN_SCHEMA_VERSION + 1}, 'future migration');
    `);
    futureDb.close();

    try {
      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      const probe = new Database(dbPath);
      try {
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all() as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toEqual(["schema_migrations"]);
        expect(
          probe
            .prepare("SELECT description FROM schema_migrations")
            .pluck()
            .all(),
        ).toEqual(["future migration"]);
      } finally {
        probe.close();
      }
      expect(existsSync(workflowPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open when schema_migrations records a version greater than KNOWN_SCHEMA_VERSION", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const initial = _createTestDbAtPath(dbPath);
    initial
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION + 1, "future migration");
    initial.close();

    expect(() => _createTestDbAtPath(dbPath)).toThrow(/schema version|refus/i);
  });

  it("opens cleanly when no migration row records a version greater than KNOWN_SCHEMA_VERSION", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const initial = _createTestDbAtPath(dbPath);
    if (KNOWN_SCHEMA_VERSION > 0) {
      initial
        .prepare(
          "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
        )
        .run(KNOWN_SCHEMA_VERSION, "current migration");
    }
    initial.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      expect(reopened.open).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("closes the underlying connection when refusing to open", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const initial = _createTestDbAtPath(dbPath);
    initial
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION + 5, "future");
    initial.close();

    expect(() => _createTestDbAtPath(dbPath)).toThrow();

    const probe = new Database(dbPath);
    try {
      probe.prepare("SELECT 1 AS ok").get();
    } finally {
      probe.close();
    }
  });
});

describe("state-db breaking-cutover versions", () => {
  it("this build fences graph-engine retirement at schema version 30", () => {
    expect(KNOWN_SCHEMA_VERSION).toBe(30);
  });

  it("refuses a version-12 binary after ticket relationships stamp version 13", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const current = new Database(dbPath);
    current.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (13, 'ticket relationships and append-only status updates');
    `);
    current.close();

    const oldBinaryConnection = new Database(dbPath);
    try {
      expect(() =>
        enforceCurrentSchemaCompatibility(oldBinaryConnection, dbPath, 12),
      ).toThrow(/recorded schema version 13.*known build version 12/i);
    } finally {
      oldBinaryConnection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a version-13 binary after managed definitions stamp version 14", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const current = new Database(dbPath);
    current.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (14, 'native SDD managed workflow definitions');
    `);
    current.close();

    const oldBinaryConnection = new Database(dbPath);
    try {
      expect(() =>
        enforceCurrentSchemaCompatibility(oldBinaryConnection, dbPath, 13),
      ).toThrow(/recorded schema version 14.*known build version 13/i);
    } finally {
      oldBinaryConnection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a version-14 binary after conversation checkpoints stamp version 15", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const current = new Database(dbPath);
    current.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (15, 'durable conversation checkpoint operations');
    `);
    current.close();

    const oldBinaryConnection = new Database(dbPath);
    try {
      expect(() =>
        enforceCurrentSchemaCompatibility(oldBinaryConnection, dbPath, 14),
      ).toThrow(/recorded schema version 15.*known build version 14/i);
    } finally {
      oldBinaryConnection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens a DB stamped at this build's version but refuses one stamped above it (an older build's DB advanced past this)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const stamped = _createTestDbAtPath(dbPath);
    stamped
      .prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION, "this build's newest breaking cutover");
    stamped.close();

    // A build that knows this version reopens cleanly.
    const reopened = _createTestDbAtPath(dbPath);
    expect(reopened.open).toBe(true);
    reopened
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION + 1, "a future breaking migration");
    reopened.close();

    // Now the recorded MAX(version) exceeds what this build knows, so the
    // forward-only gate refuses to open — the cutover's whole point.
    expect(() => _createTestDbAtPath(dbPath)).toThrow(/schema version|refus/i);
  });
});
