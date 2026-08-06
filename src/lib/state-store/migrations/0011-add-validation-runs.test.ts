import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import Database from "better-sqlite3";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { addValidationRuns } from "./0011-add-validation-runs";

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
  await addValidationRuns.up({
    name: addValidationRuns.name,
    context: { db, configDir: null },
  });
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("0011-add-validation-runs", () => {
  it("creates the validation_runs table on a database that lacks it", async () => {
    // A bare connection models a pre-floor database: no schema DDL has run.
    rawDb = new Database(":memory:");
    expect(tableNames(rawDb)).not.toContain("validation_runs");

    await runMigration(rawDb);

    expect(tableNames(rawDb)).toContain("validation_runs");
    const indexes = (
      rawDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'validation_runs'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_validation_runs_status_queue");
    const columns = rawDb.pragma("table_info(validation_runs)") as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("session_name");
  });

  it("is idempotent and preserves existing ledger rows on replay", async () => {
    rawDb = new Database(":memory:");
    await runMigration(rawDb);

    rawDb
      .prepare(
        `INSERT INTO validation_runs (
           run_id, source, command_name, cost, queue_order, status, nonce,
           project_path, worktree_path, submitted_at, scoped,
           scoped_path_count, timed_out
         ) VALUES (
           'vr-1', 'agent_cli', 'test', 8, 0, 'queued', 'nonce-1',
           '/p', '/p/.worktrees/s', '2026-08-05T10:00:00.000Z', 0, 0, 0
         )`,
      )
      .run();

    await runMigration(rawDb);

    const rows = rawDb
      .prepare("SELECT run_id FROM validation_runs")
      .all() as Array<{ run_id: string }>;
    expect(rows).toEqual([{ run_id: "vr-1" }]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("validation_runs");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("validation_runs");
  });
});
