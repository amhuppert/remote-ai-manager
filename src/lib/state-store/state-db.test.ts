import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  KNOWN_SCHEMA_VERSION,
  _createTestDb,
  _createTestDbAtPath,
  _resetForTesting,
} from "./state-db";

afterEach(() => {
  _resetForTesting();
});

const EXPECTED_TABLES = [
  "schema_migrations",
  "projects",
  "sessions",
  "conversations",
  "roadmap_items",
  "reference_documents",
  "notifications",
  "job_records",
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

describe("state-db forward-only schema_migrations conflict policy", () => {
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
