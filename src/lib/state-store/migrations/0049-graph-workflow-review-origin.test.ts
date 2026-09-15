import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { graphWorkflowReviewOrigin } from "./0049-graph-workflow-review-origin";

describe("0049-graph-workflow-review-origin", () => {
  it("marks retained or reset work unavailable without fabricating a baseline, preserving unstarted contexts and replay", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE graph_workflow_executions (
          project_path TEXT, session_name TEXT, execution_id TEXT, runtime_json TEXT
        );
        CREATE TABLE graph_workflow_events (
          project_path TEXT, session_name TEXT, execution_id TEXT, context_id TEXT, pre_reset INTEGER
        );
      `);
      const storedOrigin = {
        laneId: "a",
        baselineSha: "real-captured-baseline",
        candidateScope: { mode: "wholeTree" },
        capturedAt: "now",
      };
      const runtime = {
        contextStates: {
          fresh: { status: "pending", iterationCount: 0 },
          worked: { status: "running", iterationCount: 1 },
          reset: { status: "pending", iterationCount: 0 },
          captured: {
            status: "running",
            iterationCount: 3,
            reviewOrigin: storedOrigin,
          },
          unavailable: {
            status: "pending",
            iterationCount: 0,
            reviewOrigin: null,
          },
        },
        untouched: "keep",
      };
      db.prepare(
        "INSERT INTO graph_workflow_executions VALUES (?, ?, ?, ?)",
      ).run("p", "s", "e", JSON.stringify(runtime));
      db.prepare(
        "INSERT INTO graph_workflow_events VALUES (?, ?, ?, ?, ?)",
      ).run("p", "s", "e", "reset", 1);
      await graphWorkflowReviewOrigin.up({
        name: graphWorkflowReviewOrigin.name,
        context: { db, configDir: null },
      });
      const read = (): string =>
        (
          db
            .prepare("SELECT runtime_json FROM graph_workflow_executions")
            .get() as { runtime_json: string }
        ).runtime_json;
      const migrated = JSON.parse(read());
      expect(migrated.contextStates.worked.reviewOrigin).toBeNull();
      expect(migrated.contextStates.reset.reviewOrigin).toBeNull();
      expect(migrated.contextStates.fresh).not.toHaveProperty("reviewOrigin");
      expect(migrated.contextStates.captured.reviewOrigin).toEqual(
        storedOrigin,
      );
      expect(migrated.contextStates.unavailable.reviewOrigin).toBeNull();
      expect(migrated.untouched).toBe("keep");
      const once = read();
      await graphWorkflowReviewOrigin.up({
        name: graphWorkflowReviewOrigin.name,
        context: { db, configDir: null },
      });
      expect(read()).toBe(once);
    } finally {
      db.close();
    }
  });
});
