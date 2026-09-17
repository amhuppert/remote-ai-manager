import type Database from "better-sqlite3";
import { upgradeLegacyArchivedExecutionBlob } from "./frozen-archived-execution";

export function migrateArchivedExecutionAssignments(
  db: InstanceType<typeof Database>,
): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'graph_workflow_archived_executions'",
      )
      .get()
  )
    return;
  const rows = db
    .prepare<
      [],
      { rowid: number; execution_json: string }
    >("SELECT rowid, execution_json FROM graph_workflow_archived_executions")
    .all();
  const write = db.prepare(
    "UPDATE graph_workflow_archived_executions SET execution_json = ? WHERE rowid = ?",
  );
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.execution_json);
    } catch {
      // Unreadable history stays available for inspection; list reads skip it.
      continue;
    }
    const upgraded = upgradeLegacyArchivedExecutionBlob(raw);
    if (upgraded === raw) continue;
    write.run(JSON.stringify(upgraded), row.rowid);
  }
}
