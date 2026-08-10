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
import { validationRunScopes } from "./0016-validation-run-scopes";

type Db = InstanceType<typeof BetterSqlite3>;
let db: Db;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.exec("ALTER TABLE validation_runs DROP COLUMN requested_scope");
  db.exec("ALTER TABLE validation_runs DROP COLUMN effective_scope");
});

afterEach(() => db.close());

function insertLegacy(runId: string, scoped: 0 | 1): void {
  db.prepare(
    `INSERT INTO validation_runs (
       run_id, source, command_name, cost, queue_order, status, nonce,
       project_path, worktree_path, submitted_at, scoped, scoped_path_count,
       timed_out
     ) VALUES (?, 'agent_cli', 'test', 4, ?, 'passed', ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    runId,
    scoped,
    `nonce-${runId}`,
    "/projects/app",
    "/projects/app/.worktrees/feature",
    "2026-08-09T12:00:00.000Z",
    scoped,
    scoped,
  );
}

async function runMigration(): Promise<void> {
  await validationRunScopes.up({
    name: validationRunScopes.name,
    context: { db, configDir: null },
  });
}

describe("0016-validation-run-scopes", () => {
  it("backfills only path-proven changed rows and preserves ambiguity", async () => {
    insertLegacy("path-run", 1);
    insertLegacy("ambiguous-run", 0);

    await runMigration();

    const rows = db
      .prepare(
        `SELECT run_id, requested_scope, effective_scope
           FROM validation_runs ORDER BY run_id`,
      )
      .all() as Array<{
      run_id: string;
      requested_scope: string | null;
      effective_scope: string | null;
    }>;
    expect(rows).toEqual([
      {
        run_id: "ambiguous-run",
        requested_scope: null,
        effective_scope: null,
      },
      {
        run_id: "path-run",
        requested_scope: "changed",
        effective_scope: "changed",
      },
    ]);
  });

  it("is idempotent and preserves scope already written by a new build", async () => {
    insertLegacy("path-run", 1);
    await runMigration();
    db.prepare(
      `UPDATE validation_runs
          SET requested_scope = 'full', effective_scope = 'full'
        WHERE run_id = 'path-run'`,
    ).run();

    await runMigration();

    expect(
      db
        .prepare(
          `SELECT requested_scope, effective_scope
             FROM validation_runs WHERE run_id = 'path-run'`,
        )
        .get(),
    ).toEqual({ requested_scope: "full", effective_scope: "full" });
  });
});
