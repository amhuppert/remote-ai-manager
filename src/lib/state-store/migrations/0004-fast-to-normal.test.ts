import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { runMigrations } from "../migrator";
import { fastToNormal } from "./0004-fast-to-normal";
import { _createTestDb } from "../state-db";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repo";

const openDbs: Db[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

function freshDb(): Db {
  const db = _createTestDb({ inMemory: true });
  openDbs.push(db);
  return db;
}

interface SeedOptions {
  objective?: string | null;
  tddEnabled?: number;
  targetBranch?: string;
  source?: string;
}

function seedSession(
  db: Db,
  sessionName: string,
  creationMode: string,
  opts: SeedOptions = {},
): void {
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at, creation_mode,
       objective, tdd_enabled, target_branch, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    sessionName,
    `${PROJECT_PATH}/.worktrees/${sessionName}`,
    `csm/${sessionName}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    creationMode,
    opts.objective === undefined ? null : opts.objective,
    opts.tddEnabled ?? 1,
    opts.targetBranch ?? "main",
    opts.source ?? "cc",
  );
}

interface SessionRow {
  creation_mode: string;
  objective: string | null;
  tdd_enabled: number;
  target_branch: string;
  source: string;
  worktree_path: string;
  branch_name: string;
  created_at: string;
  last_activity_at: string;
}

function readSession(db: Db, sessionName: string): SessionRow {
  return db
    .prepare(
      `SELECT creation_mode, objective, tdd_enabled, target_branch, source,
              worktree_path, branch_name, created_at, last_activity_at
         FROM sessions WHERE project_path = ? AND session_name = ?`,
    )
    .get(PROJECT_PATH, sessionName) as SessionRow;
}

describe("0004-fast-to-normal (production registry)", () => {
  it("maps fast and focus creation modes to normal", async () => {
    const db = freshDb();
    seedSession(db, "was-fast", "fast");
    seedSession(db, "was-focus", "focus");

    const applied = await runMigrations({ db, configDir: null });
    expect(applied).toContain("0004-fast-to-normal");

    expect(readSession(db, "was-fast").creation_mode).toBe("normal");
    expect(readSession(db, "was-focus").creation_mode).toBe("normal");
  });

  it("leaves rows already normal or optimistic unchanged", async () => {
    const db = freshDb();
    seedSession(db, "already-normal", "normal");
    seedSession(db, "already-optimistic", "optimistic");

    await runMigrations({ db, configDir: null });

    expect(readSession(db, "already-normal").creation_mode).toBe("normal");
    expect(readSession(db, "already-optimistic").creation_mode).toBe(
      "optimistic",
    );
  });

  it("changes no non-mode fields on a remapped row", async () => {
    const db = freshDb();
    seedSession(db, "was-focus", "focus", {
      objective: "ship the feature",
      tddEnabled: 0,
      targetBranch: "develop",
      source: "external",
    });

    await runMigrations({ db, configDir: null });

    const row = readSession(db, "was-focus");
    expect(row).toEqual({
      creation_mode: "normal",
      objective: "ship the feature",
      tdd_enabled: 0,
      target_branch: "develop",
      source: "external",
      worktree_path: `${PROJECT_PATH}/.worktrees/was-focus`,
      branch_name: "csm/was-focus",
      created_at: "2026-01-01T00:00:00Z",
      last_activity_at: "2026-01-01T00:00:00Z",
    });
  });

  it("is a no-op on a second run (idempotent) and a manual replay yields identical state", async () => {
    const db = freshDb();
    seedSession(db, "was-fast", "fast", { objective: "alpha" });
    seedSession(db, "was-focus", "focus", { objective: "beta" });
    seedSession(db, "already-normal", "normal", { objective: "gamma" });
    seedSession(db, "already-optimistic", "optimistic", { objective: "delta" });

    await runMigrations({ db, configDir: null });

    const snapshotAfterFirst = {
      fast: readSession(db, "was-fast"),
      focus: readSession(db, "was-focus"),
      normal: readSession(db, "already-normal"),
      optimistic: readSession(db, "already-optimistic"),
    };

    const secondRun = await runMigrations({ db, configDir: null });
    expect(secondRun).toEqual([]);

    // Manual replay of the up body models a crash-after-up, before-ledger replay.
    await fastToNormal.up({
      name: fastToNormal.name,
      context: { db, configDir: null },
    });

    expect({
      fast: readSession(db, "was-fast"),
      focus: readSession(db, "was-focus"),
      normal: readSession(db, "already-normal"),
      optimistic: readSession(db, "already-optimistic"),
    }).toEqual(snapshotAfterFirst);

    expect(snapshotAfterFirst.fast.creation_mode).toBe("normal");
    expect(snapshotAfterFirst.focus.creation_mode).toBe("normal");
  });
});
