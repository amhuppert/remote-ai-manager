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
import { deliveryPlanPrelaunch } from "./0018-delivery-plan-prelaunch";

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
  await deliveryPlanPrelaunch.up({
    name: deliveryPlanPrelaunch.name,
    context: { db, configDir: null },
  });
}

function columnNames(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

/** The attempts table exactly as migration 0015 left it: no prelaunch column. */
function seedPreColumnAttempts(db: Db): void {
  db.exec(`
    CREATE TABLE spec_delivery_plan_attempts (
      id                        TEXT PRIMARY KEY,
      spec_id                   TEXT NOT NULL,
      pinned_revision_id        TEXT NOT NULL,
      delta_basis_execution_id  TEXT,
      status                    TEXT NOT NULL,
      draft_revision            INTEGER NOT NULL,
      content_json              TEXT NOT NULL,
      proposed_snapshot_id      TEXT,
      approval_json             TEXT,
      launched_execution_id     TEXT,
      created_at                TEXT NOT NULL,
      updated_at                TEXT NOT NULL
    );
    INSERT INTO spec_delivery_plan_attempts (
      id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
      draft_revision, content_json, proposed_snapshot_id, approval_json,
      launched_execution_id, created_at, updated_at
    ) VALUES (
      'attempt-legacy', 'spec-1', 'revision-1', NULL, 'draft',
      1, '{}', NULL, NULL, NULL, '2026-08-07T09:00:00.000Z',
      '2026-08-07T09:00:00.000Z'
    );
  `);
}

describe("0018-delivery-plan-prelaunch", () => {
  it("adds the prelaunch column to a table that predates it, preserving its rows", async () => {
    rawDb = new Database(":memory:");
    seedPreColumnAttempts(rawDb);
    expect(columnNames(rawDb, "spec_delivery_plan_attempts")).not.toContain(
      "prelaunch_json",
    );

    await runMigration(rawDb);

    expect(columnNames(rawDb, "spec_delivery_plan_attempts")).toContain(
      "prelaunch_json",
    );
    // Null is the meaningful legacy value: an attempt that was never parked
    // has no prelaunch record, and there is nothing to backfill.
    const row = rawDb
      .prepare(
        "SELECT id, prelaunch_json FROM spec_delivery_plan_attempts WHERE id = ?",
      )
      .get("attempt-legacy") as { id: string; prelaunch_json: string | null };
    expect(row).toEqual({ id: "attempt-legacy", prelaunch_json: null });
  });

  it("is a no-op on a floor-initialized database that already carries the column", async () => {
    fixture = createPersistenceFixture();
    expect(columnNames(fixture.db, "spec_delivery_plan_attempts")).toContain(
      "prelaunch_json",
    );

    await runMigration(fixture.db);
    await runMigration(fixture.db);

    expect(
      columnNames(fixture.db, "spec_delivery_plan_attempts").filter(
        (name) => name === "prelaunch_json",
      ),
    ).toHaveLength(1);
  });

  it("leaves a database that predates the attempts table alone", async () => {
    rawDb = new Database(":memory:");

    await runMigration(rawDb);

    expect(
      (
        rawDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_delivery_plan_attempts'",
          )
          .all() as Array<{ name: string }>
      ).length,
    ).toBe(0);
  });
});
