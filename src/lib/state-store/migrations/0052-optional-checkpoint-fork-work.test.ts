import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { optionalCheckpointForkWork } from "./0052-optional-checkpoint-fork-work";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";

it("idempotently blocks readers that discard forks without related work", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT)",
    );
    const params = {
      name: optionalCheckpointForkWork.name,
      context: { db, configDir: null },
    };
    await optionalCheckpointForkWork.up(params);
    await optionalCheckpointForkWork.up(params);
    expect(() =>
      enforceCurrentSchemaCompatibility(db, ":memory:", 18),
    ).toThrow();
    expect(() =>
      enforceCurrentSchemaCompatibility(db, ":memory:", 19),
    ).not.toThrow();
  } finally {
    db.close();
  }
});
