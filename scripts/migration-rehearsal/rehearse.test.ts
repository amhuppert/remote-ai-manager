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
import { runMigrations } from "../../src/lib/state-store/migrator";
import { migrations as productionMigrations } from "../../src/lib/state-store/migrations";
import { runNativeSddV2CutoverBeforeStateDbOpen } from "../../src/lib/state-store/migrations/0030-native-sdd-v2-cutover";
import {
  rehearsalEnvironment,
  rehearseMigrations,
  type RehearsalDeps,
} from "./rehearse";

const LATEST = productionMigrations[productionMigrations.length - 1];
const CUTOVER_MANIFEST = "native-sdd-v2-cutover-manifest.json";

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

function forget(migrationName: string | undefined): void {
  const db = new Database(dbIn(source));
  db.prepare("DELETE FROM applied_migrations WHERE name = ?").run(
    migrationName,
  );
  db.close();
}

/**
 * A stopped data directory one migration behind this build: current tables,
 * the native SDD cutover complete, every migration but the latest ledgered.
 */
async function seedSourceBehindLatest(): Promise<void> {
  const db = _createTestDbAtPath(dbIn(source));
  await runMigrations({ db, configDir: null });
  db.close();
  writeFileSync(path.join(source, "config.json"), '{"projects":[]}\n');
  await runNativeSddV2CutoverBeforeStateDbOpen(source);
  forget(LATEST?.name);
}

beforeEach(async () => {
  root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "migration-rehearsal-test-")),
  );
  source = path.join(root, "cc");
  scratch = path.join(root, "rehearsal");
  mkdirSync(source);
  await seedSourceBehindLatest();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("rehearseMigrations", () => {
  it("applies this build's pending migrations to a copy, leaving the source untouched", async () => {
    const before = snapshotDirectory(source);

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps(),
    );

    expect(result).toMatchObject({
      ok: true,
      report: {
        scratchDir: scratch,
        pendingBefore: [LATEST?.name],
        applied: [LATEST?.name],
        before: { integrityProblems: [], foreignKeyViolations: 0 },
        after: { integrityProblems: [], foreignKeyViolations: 0 },
      },
    });
    expect(existsSync(path.join(scratch, "config.json"))).toBe(true);
    expect(snapshotDirectory(source)).toEqual(before);
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
    for (const file of ["config.json", CUTOVER_MANIFEST]) {
      copyFileSync(path.join(source, file), path.join(crashed, file));
    }
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

  it("refuses migrations from before the supported baseline, naming them, before running anything", async () => {
    forget("0035-generalized-model-selection");

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("0035-generalized-model-selection");
    expect(existsSync(scratch)).toBe(false);
  });

  it("refuses a data directory whose native SDD cutover has not completed", async () => {
    rmSync(path.join(source, CUTOVER_MANIFEST));

    const result = await rehearseMigrations(
      { from: source, to: scratch },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(CUTOVER_MANIFEST);
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
