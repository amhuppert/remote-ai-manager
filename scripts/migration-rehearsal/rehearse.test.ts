import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { _createTestDbAtPath } from "../../src/lib/state-store/state-db";
import { RETIRED_HISTORY_BUILD } from "../../src/lib/state-store/migration-history";
import { migrations as productionMigrations } from "../../src/lib/state-store/migrations";
import type { StateMigration } from "../../src/lib/state-store/migrations/types";
import { createDeploy15Database } from "../../src/lib/state-store/migrations/testing/deploy-1-5-database";
import {
  rehearsalEnvironment,
  rehearseMigrations,
  type RehearsalDeps,
} from "./rehearse";

/** A migration newer than the retired history, which adds one table. */
const PROBE: StateMigration = {
  name: "9000-rehearsal-probe",
  async up({ context }) {
    context.db.exec(
      "CREATE TABLE IF NOT EXISTS rehearsal_probe (id TEXT PRIMARY KEY)",
    );
  },
};

let root: string;
let source: string;
let scratch: string;

function dbIn(dir: string): string {
  return path.join(dir, "command-center.db");
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function snapshotDirectory(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((entry) => [entry, sha256(path.join(dir, entry))]),
  );
}

function deps(overrides: Partial<RehearsalDeps> = {}): RehearsalDeps {
  return {
    openStateDatabase: _createTestDbAtPath,
    isProcessAlive: () => false,
    ...overrides,
  };
}

function forget(migrationName: string): void {
  const db = new Database(dbIn(source));
  db.prepare("DELETE FROM applied_migrations WHERE name = ?").run(
    migrationName,
  );
  db.close();
}

beforeEach(() => {
  root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "migration-rehearsal-test-")),
  );
  source = path.join(root, "cc");
  scratch = path.join(root, "rehearsal");
  createDeploy15Database(source);
  writeFileSync(path.join(source, "config.json"), '{"projects":[]}\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("rehearseMigrations", () => {
  it("passes a deploy 1.5 copy through the history guard and a floor that changes nothing, leaving the source untouched", async () => {
    const before = snapshotDirectory(source);

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps(),
    );

    expect(result).toMatchObject({
      ok: true,
      report: {
        scratchDir: scratch,
        history: "eligible",
        pendingBefore: [],
        applied: [],
        schemaChanges: { added: [], removed: [], changed: [] },
        before: { integrityProblems: [], foreignKeyViolations: 0 },
        after: { integrityProblems: [], foreignKeyViolations: 0 },
      },
    });
    expect(existsSync(path.join(scratch, "config.json"))).toBe(true);
    expect(snapshotDirectory(source)).toEqual(before);
  });

  it("applies this build's pending migrations to the copy and reports the schema they changed", async () => {
    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps({ migrations: [...productionMigrations, PROBE] }),
    );

    expect(result).toMatchObject({
      ok: true,
      report: {
        pendingBefore: [PROBE.name],
        applied: [PROBE.name],
        schemaChanges: {
          added: ["table rehearsal_probe"],
          removed: [],
          changed: [],
        },
      },
    });
  });

  it("copies a database left with unmerged writes without opening it: the copy has them, the source files are unchanged", async () => {
    // A crashed server: committed frames still in the write-ahead log, no index.
    const crashed = path.join(root, "crashed");
    mkdirSync(crashed);
    const writer = new Database(dbIn(source));
    writer.pragma("wal_autocheckpoint = 0");
    writer
      .prepare("INSERT INTO projects (root_path) VALUES ('/crash/unmerged')")
      .run();
    copyFileSync(dbIn(source), dbIn(crashed));
    copyFileSync(`${dbIn(source)}-wal`, `${dbIn(crashed)}-wal`);
    writer.close();
    copyFileSync(
      path.join(source, "config.json"),
      path.join(crashed, "config.json"),
    );
    const before = snapshotDirectory(crashed);

    const result = await rehearseMigrations(
      { from: crashed, to: scratch },
      deps(),
    );

    expect(result.ok).toBe(true);
    expect(snapshotDirectory(crashed)).toEqual(before);
    const copy = new Database(dbIn(scratch), { readonly: true });
    expect(
      copy
        .prepare(
          "SELECT root_path FROM projects WHERE root_path = '/crash/unmerged'",
        )
        .get(),
    ).toEqual({ root_path: "/crash/unmerged" });
    copy.close();
  });

  it("refuses a copy that has not finished the retired history, naming what it lacks and the build that finishes it", async () => {
    forget("0035-generalized-model-selection");

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("0035-generalized-model-selection");
    expect(result.reason).toContain(RETIRED_HISTORY_BUILD.sha);
    expect(existsSync(scratch)).toBe(false);
  });

  it("reports integrity problems the data already had separately from new ones", async () => {
    const db = new Database(dbIn(source));
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO sessions (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at)
       VALUES ('/no/such/project', 'orphan', '/wt', 'b', '2026-10-01', '2026-10-01')`,
    ).run();
    db.close();

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps(),
    );

    expect(result).toMatchObject({
      ok: true,
      report: {
        before: { foreignKeyViolations: 1 },
        after: { foreignKeyViolations: 1 },
      },
    });
  });

  it("names a failing migration and leaves the source untouched", async () => {
    const before = snapshotDirectory(source);

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps({
        migrations: [
          ...productionMigrations,
          {
            name: "9999-broken",
            up: () => Promise.reject(new Error("constraint failed")),
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("9999-broken");
    expect(snapshotDirectory(source)).toEqual(before);
  });

  it("refuses while a Command Center server holds the source data directory", async () => {
    const db = new Database(dbIn(source));
    db.exec(`CREATE TABLE IF NOT EXISTS graph_workflow_runtime_owner (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      pid INTEGER NOT NULL,
      token TEXT NOT NULL
    )`);
    db.prepare(
      "INSERT INTO graph_workflow_runtime_owner (singleton, pid, token) VALUES (1, 4242, 't')",
    ).run();
    db.close();

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps({ isProcessAlive: (pid) => pid === 4242 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("4242");
    expect(existsSync(scratch)).toBe(false);
  });

  it("refuses a scratch directory inside the source however it is named, one that is not empty, and relative paths", async () => {
    const alias = path.join(root, "alias");
    symlinkSync(source, alias);
    mkdirSync(scratch);
    writeFileSync(path.join(scratch, "leftover.txt"), "x");

    const refusals = await Promise.all([
      rehearseMigrations(
        { from: source, to: path.join(source, "rehearsal") },
        deps(),
      ),
      rehearseMigrations(
        { from: source, to: path.join(source, "..rehearsal") },
        deps(),
      ),
      rehearseMigrations(
        { from: source, to: path.join(alias, "rehearsal") },
        deps(),
      ),
      rehearseMigrations({ from: source, to: scratch }, deps()),
      rehearseMigrations({ from: source, to: "rehearsal" }, deps()),
    ]);

    expect(refusals.map((result) => result.ok)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      readdirSync(source).filter((entry) => entry.includes("rehearsal")),
    ).toEqual([]);
  });
});

describe("rehearsalEnvironment", () => {
  it("points the data directory at the scratch copy and drops a log file override", () => {
    expect(
      rehearsalEnvironment(
        {
          NODE_ENV: "production",
          PATH: "/bin",
          CC_CONFIG_DIR: "/live/cc",
          CC_LOG_FILE: "/live/cc/logs/global.log",
        },
        "/tmp/rehearsal",
      ),
    ).toEqual({
      NODE_ENV: "production",
      PATH: "/bin",
      CC_CONFIG_DIR: "/tmp/rehearsal",
    });
  });
});
