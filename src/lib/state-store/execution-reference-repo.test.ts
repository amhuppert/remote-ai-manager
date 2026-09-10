import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { listExecutionReferences } from "./execution-reference-repo";

describe("execution reference inventory", () => {
  it("searches active and archived runs before bounding the result and retains their exact scope", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE graph_workflow_executions (project_path TEXT, session_name TEXT, execution_id TEXT, status TEXT, started_at TEXT, definition_json TEXT);
      CREATE TABLE graph_workflow_archived_executions (project_path TEXT, session_name TEXT, execution_id TEXT, status TEXT, started_at TEXT, execution_json TEXT);`);
    db.prepare(
      "INSERT INTO graph_workflow_executions VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "/repos/cc",
      "current",
      "run-2",
      "running",
      "2026-09-10",
      JSON.stringify({ launchDocument: { name: "Shipping" } }),
    );
    db.prepare(
      "INSERT INTO graph_workflow_archived_executions VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "/repos/other",
      "past",
      "run-1",
      "completed",
      "2026-09-09",
      JSON.stringify({ launchDocument: { name: "Capture" } }),
    );
    expect(
      listExecutionReferences(db, "", 1).map((item) => item.executionId),
    ).toEqual(["run-2"]);
    expect(listExecutionReferences(db, "Capture", 1)).toEqual([
      {
        projectName: "other",
        sessionName: "past",
        executionId: "run-1",
        title: "Capture",
        status: "completed",
        startedAt: "2026-09-09",
      },
    ]);
    db.prepare(
      "UPDATE graph_workflow_archived_executions SET execution_json = ?",
    ).run(
      JSON.stringify({
        origin: { kind: "template", definitionId: "Stored template name" },
      }),
    );
    expect(listExecutionReferences(db, "Stored template name")[0]?.title).toBe(
      "Stored template name",
    );
    db.close();
  });
});
