import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import BetterSqlite3 from "better-sqlite3";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import { codexRunsToAgentRuns } from "./0006-codex-runs-to-agent-runs";

type Db = InstanceType<typeof BetterSqlite3>;

const openDbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A DB in the state the migration meets in the wild: the current schema floor
 * has already created `agent_run_records` (empty), and an older build left a
 * populated `codex_run_records` behind.
 */
function dbWithLegacyTable(options?: {
  withOwnerPid?: boolean;
  filename?: string;
}): Db {
  const db = new BetterSqlite3(options?.filename ?? ":memory:");
  openDbs.push(db);
  db.exec(`
    CREATE TABLE agent_run_records (
      run_id              TEXT PRIMARY KEY,
      backend             TEXT NOT NULL,
      project_name        TEXT NOT NULL,
      session_name        TEXT NOT NULL,
      status              TEXT NOT NULL,
      started_at          TEXT NOT NULL,
      completed_at        TEXT,
      summary             TEXT,
      reference_documents TEXT,
      error_message       TEXT,
      owner_pid           INTEGER
    );
    CREATE TABLE codex_run_records (
      run_id              TEXT PRIMARY KEY,
      project_name        TEXT NOT NULL,
      session_name        TEXT NOT NULL,
      status              TEXT NOT NULL,
      started_at          TEXT NOT NULL,
      completed_at        TEXT,
      summary             TEXT,
      reference_documents TEXT,
      error_message       TEXT${options?.withOwnerPid === false ? "" : ",\n      owner_pid           INTEGER"}
    );
  `);
  return db;
}

function insertLegacyRun(
  db: Db,
  runId: string,
  status: string,
  extra?: { summary?: string; error?: string },
): void {
  db.prepare(
    `INSERT INTO codex_run_records
       (run_id, project_name, session_name, status, started_at, completed_at, summary, reference_documents, error_message)
     VALUES (?, 'proj', 'sess', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', ?, ?, ?)`,
  ).run(
    runId,
    status,
    extra?.summary ?? null,
    status === "succeeded"
      ? JSON.stringify([{ filePath: "a.md", description: "a" }])
      : null,
    extra?.error ?? null,
  );
}

async function runUp(db: Db): Promise<void> {
  await codexRunsToAgentRuns.up({
    name: codexRunsToAgentRuns.name,
    context: { db, configDir: null },
  });
}

describe("0006-codex-runs-to-agent-runs", () => {
  it("moves legacy codex rows into agent_run_records with backend=codex and the aligned terminal vocabulary", async () => {
    const db = dbWithLegacyTable();
    insertLegacyRun(db, "run-ok", "succeeded", { summary: "did it" });
    insertLegacyRun(db, "run-bad", "failed", { error: "boom" });
    insertLegacyRun(db, "run-slow", "timed_out", { error: "took too long" });
    insertLegacyRun(db, "run-live", "running");

    await runUp(db);

    const rows = db
      .prepare(
        `SELECT run_id, backend, status, summary, error_message, reference_documents
           FROM agent_run_records ORDER BY run_id`,
      )
      .all() as Array<{
      run_id: string;
      backend: string;
      status: string;
      summary: string | null;
      error_message: string | null;
      reference_documents: string | null;
    }>;

    expect(rows.map((r) => [r.run_id, r.backend, r.status])).toEqual([
      ["run-bad", "codex", "failed"],
      ["run-live", "codex", "running"],
      ["run-ok", "codex", "completed"],
      ["run-slow", "codex", "failed"],
    ]);
    // Results survive the move.
    expect(rows.find((r) => r.run_id === "run-ok")?.summary).toBe("did it");
    expect(rows.find((r) => r.run_id === "run-ok")?.reference_documents).toBe(
      JSON.stringify([{ filePath: "a.md", description: "a" }]),
    );
    expect(rows.find((r) => r.run_id === "run-slow")?.error_message).toBe(
      "took too long",
    );

    // The legacy table is gone.
    const legacy = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_run_records'",
      )
      .get();
    expect(legacy).toBeUndefined();
  });

  it("migrates a legacy table that predates the owner_pid column", async () => {
    const db = dbWithLegacyTable({ withOwnerPid: false });
    insertLegacyRun(db, "old-run", "succeeded", { summary: "s" });

    await runUp(db);

    const row = db
      .prepare(
        "SELECT backend, status, owner_pid FROM agent_run_records WHERE run_id = 'old-run'",
      )
      .get() as { backend: string; status: string; owner_pid: number | null };
    expect(row).toEqual({
      backend: "codex",
      status: "completed",
      owner_pid: null,
    });
  });

  it("is idempotent: a crash-replay after the drop is a no-op", async () => {
    const db = dbWithLegacyTable();
    insertLegacyRun(db, "run-ok", "succeeded", { summary: "did it" });

    await runUp(db);
    await runUp(db);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM agent_run_records")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("no-ops on a fresh database without the legacy table", async () => {
    const db = new BetterSqlite3(":memory:");
    openDbs.push(db);
    db.exec(`
      CREATE TABLE agent_run_records (
        run_id TEXT PRIMARY KEY, backend TEXT NOT NULL, project_name TEXT NOT NULL,
        session_name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT, summary TEXT, reference_documents TEXT,
        error_message TEXT, owner_pid INTEGER
      );
    `);

    await runUp(db);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM agent_run_records")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("locks before probing so a concurrent worker cannot drop the legacy table between probe and copy", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-migration-0006-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "command-center.db");
    const dbA = dbWithLegacyTable({ filename: dbPath });
    insertLegacyRun(dbA, "run-race", "succeeded", { summary: "preserved" });
    dbA.pragma("journal_mode = WAL");

    const dbB = new BetterSqlite3(dbPath, { timeout: 1 });
    openDbs.push(dbB);
    dbB.pragma("journal_mode = WAL");

    let competingWriterBlocked = false;
    const interleavedDb = new Proxy(dbA, {
      get(target, property, receiver) {
        if (property === "pragma") {
          return (source: string) => {
            const result = target.pragma(source);
            if (source === "table_info(codex_run_records)") {
              try {
                dbB.prepare("DROP TABLE codex_run_records").run();
              } catch (err) {
                if ((err as { code?: string }).code !== "SQLITE_BUSY") {
                  throw err;
                }
                competingWriterBlocked = true;
              }
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(runUp(interleavedDb as Db)).resolves.toBeUndefined();
    expect(competingWriterBlocked).toBe(true);
    expect(
      dbA
        .prepare(
          "SELECT backend, status, summary FROM agent_run_records WHERE run_id = ?",
        )
        .get("run-race"),
    ).toEqual({ backend: "codex", status: "completed", summary: "preserved" });
    expect(
      dbA
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_run_records'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("refuses a future schema version under the write lock before probing or mutating", async () => {
    const db = dbWithLegacyTable();
    insertLegacyRun(db, "run-future", "succeeded", { summary: "preserve" });
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (${KNOWN_SCHEMA_VERSION + 1}, 'future breaking migration');
    `);

    await expect(runUp(db)).rejects.toThrow(/schema version|refus/i);

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_run_records'",
        )
        .get(),
    ).toEqual({ name: "codex_run_records" });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM agent_run_records").get(),
    ).toEqual({ count: 0 });
  });
});
