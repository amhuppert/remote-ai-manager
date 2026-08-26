import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { workflowResultNotifications } from "./0027-workflow-result-notifications";

type Db = InstanceType<typeof Database>;

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

async function runMigration(database: Db): Promise<void> {
  await workflowResultNotifications.up({
    name: workflowResultNotifications.name,
    context: { db: database, configDir: null },
  });
}

describe("0027-workflow-result-notifications", () => {
  it("upgrades the notification table, preserves rows, stamps the breaking version, and replays idempotently", async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        project_name TEXT NOT NULL,
        session_name TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        merge_hash TEXT,
        commit_hash TEXT,
        conflict_count INTEGER,
        conflict_files TEXT,
        target_branch TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO notifications (
        id, type, title, message, project_name, session_name,
        branch_name, job_id, job_type
      ) VALUES (
        'notification-1', 'merge-completed', 'Merged', 'Ready', 'repo',
        'session-1', 'branch-1', 'job-1', 'merge'
      );
    `);

    await runMigration(db);
    await runMigration(db);

    const columns = (
      db.pragma("table_info(notifications)") as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "workflow_execution_id",
        "workflow_origin_conversation_id",
        "workflow_deep_link",
      ]),
    );
    expect(db.prepare("SELECT id, source FROM notifications").all()).toEqual([
      { id: "notification-1", source: "job" },
    ]);
    // This migration owns version 8; the application compatibility floor can
    // advance independently when later breaking migrations are registered.
    expect(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: 8 });
  });
});
