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
import { addDeliveryDiscoveries } from "./0020-add-delivery-discoveries";

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
  await addDeliveryDiscoveries.up({
    name: addDeliveryDiscoveries.name,
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
 * A pre-floor database still carries the tables a discovery's foreign keys
 * point at — only the discovery table itself is missing. The stubs carry just
 * the referenced columns, which is all a foreign key resolves.
 */
function seedPreFloorSpecTables(db: Db): void {
  db.exec(`
    CREATE TABLE specs (id TEXT PRIMARY KEY);
    CREATE TABLE spec_revisions (id TEXT PRIMARY KEY);
    CREATE TABLE spec_executions (id TEXT PRIMARY KEY);
    CREATE TABLE spec_delivery_plan_attempts (id TEXT PRIMARY KEY);
    INSERT INTO specs (id) VALUES ('spec-1');
    INSERT INTO spec_revisions (id) VALUES ('revision-1');
    INSERT INTO spec_executions (id) VALUES ('execution-1');
  `);
}

const INSERT_DISCOVERY = `INSERT INTO spec_delivery_discoveries (
   id, spec_id, execution_id, attempt_id, pinned_revision_id,
   discovered_task_json, blocking_reason, captured_by_json, captured_at
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe("0020-add-delivery-discoveries", () => {
  it("creates the discovery table on a database that lacks it", async () => {
    // A bare connection models a pre-floor database: no schema DDL has run.
    rawDb = new Database(":memory:");
    expect(tableNames(rawDb)).not.toContain("spec_delivery_discoveries");

    await runMigration(rawDb);

    expect(tableNames(rawDb)).toContain("spec_delivery_discoveries");
  });

  it("is idempotent and preserves existing discoveries on replay", async () => {
    rawDb = new Database(":memory:");
    seedPreFloorSpecTables(rawDb);
    await runMigration(rawDb);
    rawDb
      .prepare(INSERT_DISCOVERY)
      .run(
        "discovery-1",
        "spec-1",
        "execution-1",
        null,
        "revision-1",
        '{"title":"Found it"}',
        null,
        '{"kind":"human"}',
        "2026-08-07T09:00:00.000Z",
      );

    await runMigration(rawDb);

    expect(
      rawDb.prepare("SELECT id FROM spec_delivery_discoveries").all() as Array<{
        id: string;
      }>,
    ).toEqual([{ id: "discovery-1" }]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("spec_delivery_discoveries");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("spec_delivery_discoveries");
  });
});
