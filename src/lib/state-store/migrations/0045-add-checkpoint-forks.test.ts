import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  addCheckpointForks,
  CHECKPOINT_FORKS_SCHEMA_VERSION,
} from "./0045-add-checkpoint-forks";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";

describe("checkpoint fork migration", () => {
  it("preserves existing conversations, adds provenance in both scopes, and rejects a reader that cannot honor the submission lock", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT); CREATE TABLE conversations(id TEXT PRIMARY KEY, backend_ref TEXT); CREATE TABLE project_conversations(id TEXT PRIMARY KEY, backend_ref TEXT); INSERT INTO conversations VALUES ('source', 'source-ref'); INSERT INTO project_conversations VALUES ('project-source', 'project-ref');",
      );
      const params = {
        name: addCheckpointForks.name,
        context: { db, configDir: null },
      };
      await addCheckpointForks.up(params);
      await addCheckpointForks.up(params);
      expect(
        db
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: CHECKPOINT_FORKS_SCHEMA_VERSION });
      expect(db.prepare("SELECT * FROM conversations").get()).toEqual({
        id: "source",
        backend_ref: "source-ref",
        checkpoint_fork: null,
      });
      expect(db.prepare("SELECT * FROM project_conversations").get()).toEqual({
        id: "project-source",
        backend_ref: "project-ref",
        checkpoint_fork: null,
      });
      expect(() =>
        enforceCurrentSchemaCompatibility(db, ":memory:", 15),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
