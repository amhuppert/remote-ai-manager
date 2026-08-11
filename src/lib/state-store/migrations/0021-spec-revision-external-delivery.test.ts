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
import { specRevisionExternalDelivery } from "./0021-spec-revision-external-delivery";

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
  await specRevisionExternalDelivery.up({
    name: specRevisionExternalDelivery.name,
    context: { db, configDir: null },
  });
}

/**
 * A database from before the column: the revision table as it stood, carrying a
 * revision this system authored itself.
 */
const LEGACY_DDL = `
  CREATE TABLE spec_revisions (
    id                    TEXT PRIMARY KEY,
    spec_id               TEXT NOT NULL,
    number                INTEGER NOT NULL,
    state                 TEXT NOT NULL,
    authoring_stage       TEXT NOT NULL DEFAULT 'plan',
    based_on_revision_id  TEXT,
    content_hash          TEXT,
    proposed_at           TEXT,
    approved_at           TEXT,
    created_at            TEXT NOT NULL
  );
  INSERT INTO spec_revisions (
    id, spec_id, number, state, authoring_stage, based_on_revision_id,
    content_hash, proposed_at, approved_at, created_at
  ) VALUES (
    'revision-authored', 'spec-1', 1, 'approved', 'plan', NULL,
    'hash-authored', '2026-08-09T09:00:00.000Z', '2026-08-09T09:30:00.000Z',
    '2026-08-09T08:00:00.000Z'
  );
`;

function columnNames(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function externalDeliveryOf(db: Db, revisionId: string): string | null {
  return (
    db
      .prepare("SELECT external_delivery_json FROM spec_revisions WHERE id = ?")
      .get(revisionId) as { external_delivery_json: string | null }
  ).external_delivery_json;
}

const EXTERNAL_DELIVERY_JSON = JSON.stringify({
  at: "2026-08-09T10:00:00.000Z",
  actor: { kind: "agent", conversationId: "conversation-import" },
  source: { label: "kiro:.kiro/specs/native-sdd" },
});

describe("0021-spec-revision-external-delivery", () => {
  it("adds the column to a legacy table and accepts an external-delivery record", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    expect(columnNames(rawDb, "spec_revisions")).not.toContain(
      "external_delivery_json",
    );

    await runMigration(rawDb);

    rawDb
      .prepare(
        "UPDATE spec_revisions SET external_delivery_json = ? WHERE id = 'revision-authored'",
      )
      .run(EXTERNAL_DELIVERY_JSON);
    expect(externalDeliveryOf(rawDb, "revision-authored")).toBe(
      EXTERNAL_DELIVERY_JSON,
    );
  });

  it("leaves revisions that predate the column with no external-delivery claim", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);

    await runMigration(rawDb);

    // Null is the truth for every revision this system authored: back-filling
    // anything here would manufacture a delivery claim nobody made.
    expect(externalDeliveryOf(rawDb, "revision-authored")).toBeNull();
    expect(
      rawDb
        .prepare(
          "SELECT state, content_hash, approved_at FROM spec_revisions WHERE id = 'revision-authored'",
        )
        .get(),
    ).toEqual({
      state: "approved",
      content_hash: "hash-authored",
      approved_at: "2026-08-09T09:30:00.000Z",
    });
  });

  it("is idempotent on replay and preserves a recorded claim", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    await runMigration(rawDb);
    rawDb
      .prepare(
        "UPDATE spec_revisions SET external_delivery_json = ? WHERE id = 'revision-authored'",
      )
      .run(EXTERNAL_DELIVERY_JSON);

    await runMigration(rawDb);

    expect(externalDeliveryOf(rawDb, "revision-authored")).toBe(
      EXTERNAL_DELIVERY_JSON,
    );
  });

  it("is a no-op on a floor-created database that already carries the column", async () => {
    fixture = createPersistenceFixture();
    expect(columnNames(fixture.db, "spec_revisions")).toContain(
      "external_delivery_json",
    );

    await runMigration(fixture.db);

    expect(columnNames(fixture.db, "spec_revisions")).toContain(
      "external_delivery_json",
    );
  });

  it("skips a database that predates the spec tables entirely", async () => {
    // Such a database picks the column up with the table itself when the floor
    // creates it, so there is nothing here to alter and nothing to fail on.
    rawDb = new Database(":memory:");

    await expect(runMigration(rawDb)).resolves.toBeUndefined();
  });
});
