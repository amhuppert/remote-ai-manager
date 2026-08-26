import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { addGraphPlanReviews } from "./0032-add-graph-plan-reviews";

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
  await addGraphPlanReviews.up({
    name: addGraphPlanReviews.name,
    context: { db, configDir: null },
  });
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const INSERT_REVIEW = `INSERT INTO graph_plan_reviews (
   id, definition_hash, reviewer_conversation_id, verdict, findings, reviewed_at
 ) VALUES (?, ?, ?, ?, ?, ?)`;

describe("0032-add-graph-plan-reviews", () => {
  it("creates the review table on a database that lacks it", async () => {
    // A bare connection models a pre-floor database: no schema DDL has run.
    rawDb = new Database(":memory:");
    expect(tableNames(rawDb)).not.toContain("graph_plan_reviews");

    await runMigration(rawDb);

    expect(tableNames(rawDb)).toContain("graph_plan_reviews");
  });

  it("is idempotent and preserves existing reviews on replay", async () => {
    rawDb = new Database(":memory:");
    await runMigration(rawDb);
    rawDb
      .prepare(INSERT_REVIEW)
      .run(
        "review-1",
        `sha256:${"3f".repeat(32)}`,
        "conv-1",
        "changes_requested",
        "Split the persistence work out.",
        "2026-08-18T14:23:07.512Z",
      );

    await runMigration(rawDb);

    expect(
      rawDb.prepare("SELECT id FROM graph_plan_reviews").all() as Array<{
        id: string;
      }>,
    ).toEqual([{ id: "review-1" }]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("graph_plan_reviews");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("graph_plan_reviews");
  });

  it("stamps no compatibility version — a new table is additive", async () => {
    // The database file is shared live state across branches: an older build
    // simply ignores a table it does not read, so fencing it out would cost
    // sibling branches everything and buy nothing.
    fixture = createPersistenceFixture();
    const before = fixture.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();

    await runMigration(fixture.db);

    expect(
      fixture.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(before);
  });
});
