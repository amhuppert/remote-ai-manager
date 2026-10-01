import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { notepadNoticeContext } from "./0062-notepad-notice-context";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";

let db: InstanceType<typeof Database> | undefined;
afterEach(() => db?.close());
it("preserves legacy accepted revision and comment markers without inventing observed IDs", async () => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT);
    CREATE TABLE notepad_delivery_watermarks(conversation_id TEXT,notepad_id TEXT,revision INTEGER,open_comment_count INTEGER,latest_open_comment_at TEXT,updated_at TEXT,PRIMARY KEY(conversation_id,notepad_id));
    INSERT INTO notepad_delivery_watermarks VALUES('recipient','pad',3,2,'2026-10-01T10:00:00Z','2026-10-01T10:01:00Z');`);
  const context = { db, configDir: null };
  await notepadNoticeContext.up({ name: notepadNoticeContext.name, context });
  await notepadNoticeContext.up({ name: notepadNoticeContext.name, context });
  const columns = z
    .array(z.object({ name: z.string() }))
    .parse(db.prepare("PRAGMA table_info(notepad_delivery_watermarks)").all());
  expect(columns.map((column) => column.name)).toContain(
    "observed_comment_ids_json",
  );
  expect(db.prepare("SELECT * FROM notepad_delivery_watermarks").get()).toEqual(
    {
      conversation_id: "recipient",
      notepad_id: "pad",
      revision: 3,
      open_comment_count: 2,
      latest_open_comment_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-10-01T10:01:00Z",
      observed_comment_ids_json: null,
    },
  );
  const migratedDb = db;
  expect(() =>
    enforceCurrentSchemaCompatibility(migratedDb, ":memory:", 26),
  ).toThrow(/greater than known build version/);
});
