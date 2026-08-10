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
import { addDeliveryPlanAttempts } from "./0015-add-delivery-plan-attempts";

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
  await addDeliveryPlanAttempts.up({
    name: addDeliveryPlanAttempts.name,
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

/**
 * A pre-floor database still carries the older spec tables the attempt's
 * foreign keys point at — only the two new tables are missing. The stubs
 * carry just the referenced columns, which is all a foreign key resolves.
 */
function seedPreFloorSpecTables(db: Db): void {
  db.exec(`
    CREATE TABLE specs (id TEXT PRIMARY KEY);
    CREATE TABLE spec_revisions (id TEXT PRIMARY KEY);
    CREATE TABLE spec_executions (id TEXT PRIMARY KEY);
    INSERT INTO specs (id) VALUES ('spec-1');
    INSERT INTO spec_revisions (id) VALUES ('revision-1');
  `);
}

const INSERT_ATTEMPT = `INSERT INTO spec_delivery_plan_attempts (
   id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
   draft_revision, content_json, proposed_snapshot_id, approval_json,
   launched_execution_id, created_at, updated_at
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe("0015-add-delivery-plan-attempts", () => {
  it("creates both delivery-plan tables on a database that lacks them", async () => {
    // A bare connection models a pre-floor database: no schema DDL has run.
    rawDb = new Database(":memory:");
    expect(tableNames(rawDb)).not.toContain("spec_delivery_plan_attempts");

    await runMigration(rawDb);

    const names = tableNames(rawDb);
    expect(names).toContain("spec_delivery_plan_attempts");
    expect(names).toContain("spec_delivery_plan_snapshots");
  });

  it("is idempotent and preserves existing attempts on replay", async () => {
    rawDb = new Database(":memory:");
    seedPreFloorSpecTables(rawDb);
    await runMigration(rawDb);
    rawDb
      .prepare(INSERT_ATTEMPT)
      .run(
        "attempt-1",
        "spec-1",
        "revision-1",
        null,
        "draft",
        1,
        "{}",
        null,
        null,
        null,
        "2026-08-07T09:00:00.000Z",
        "2026-08-07T09:00:00.000Z",
      );

    await runMigration(rawDb);

    expect(
      rawDb
        .prepare("SELECT id FROM spec_delivery_plan_attempts")
        .all() as Array<{ id: string }>,
    ).toEqual([{ id: "attempt-1" }]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("spec_delivery_plan_attempts");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("spec_delivery_plan_attempts");
  });
});
