import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { KNOWN_SCHEMA_VERSION } from "../state-db";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import { graphWorkflowCandidateUnstableHalt } from "./0031-graph-workflow-candidate-unstable-halt";

type Db = InstanceType<typeof Database>;

function createStampedDb(): Db {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
  ).run(9, "native-SDD version-2 cutover");
  return db;
}

async function runMigration(db: Db): Promise<void> {
  await graphWorkflowCandidateUnstableHalt.up({
    name: graphWorkflowCandidateUnstableHalt.name,
    context: { db, configDir: null },
  });
}

describe("0031-graph-workflow-candidate-unstable-halt", () => {
  it("stamps version 10 so a version-9 build refuses the database", async () => {
    const db = createStampedDb();
    try {
      await runMigration(db);

      const rows = db
        .prepare(
          "SELECT version, description FROM schema_migrations WHERE version = 10",
        )
        .all() as Array<{ version: number; description: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.description).toContain("candidate_unstable");

      // The point of the fence: a build that only knows version 9 must refuse
      // to open, while this build (whose known version the stamp equals) opens.
      expect(() =>
        enforceCurrentSchemaCompatibility(db, ":memory:", 9),
      ).toThrow(/schema/i);
      expect(() =>
        enforceCurrentSchemaCompatibility(db, ":memory:", KNOWN_SCHEMA_VERSION),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("replays idempotently on the same build", async () => {
    const db = createStampedDb();
    try {
      await runMigration(db);
      await runMigration(db);

      const count = db
        .prepare(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 10",
        )
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
