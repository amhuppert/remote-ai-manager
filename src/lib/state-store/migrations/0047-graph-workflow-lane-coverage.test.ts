import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { describe, expect, it } from "vitest";
import { graphWorkflowLaneCoverage } from "./0047-graph-workflow-lane-coverage";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { remainingSourceLanes } from "@/lib/workflow-graph/lane-join";

describe("0047 graph lane coverage cutover", () => {
  it("drops false inherited coverage and replays uncertain merged progress, preserving the original snapshot", async () => {
    const fixture = createPersistenceFixture();
    const db = fixture.db;
    try {
      fixture.seedProject("/project");
      fixture.seedSession("/project", "session");
      const execution = createWorkflowExecution();
      execution.status = "paused";
      for (const state of Object.values(execution.contextStates)) {
        state.status = "completed";
        state.completedTaskCount = state.totalTaskCount;
      }
      execution.contextStates["context-plan"]!.laneId = "worker";
      execution.contextStates["context-implement"]!.laneId = "judge";
      execution.contextStates["context-verify"]!.laneId = "worker";
      execution.workingDefinition.executionContexts.find(
        (context) => context.id === "context-verify",
      )!.placement = { lane: "worker", mode: "readOnly" };
      const laneBase = {
        kind: "worktree" as const,
        status: "active" as const,
        worktreePath: "/tmp/lane",
        branchName: "lane",
        lastCommittingContextId: null,
        createdAt: "now",
        updatedAt: "now",
      };
      execution.executionLanes = {
        worker: {
          ...laneBase,
          laneId: "worker",
          includedContextIds: ["context-plan"],
          commitSnapshots: [
            { contextId: "context-plan", sha: "confirmed", committedAt: "now" },
          ],
        },
        fork: {
          ...laneBase,
          laneId: "fork",
          includedContextIds: ["context-plan", "context-implement"],
          commitSnapshots: [],
        },
        judge: {
          ...laneBase,
          laneId: "judge",
          includedContextIds: ["context-plan", "context-implement"],
          commitSnapshots: [],
        },
      };
      execution.joins = {
        old: {
          joinId: "old",
          kind: "context_merge",
          contextId: null,
          sourceLaneIds: ["fork"],
          targetLaneId: "judge",
          sourceLaneContextIds: { fork: ["context-plan", "context-implement"] },
          mergedSourceLaneIds: ["fork"],
          validationDebtSourceLaneIds: [],
          validationEvidence: [],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "now",
          updatedAt: "now",
          completedAt: "now",
        },
        interrupted: {
          joinId: "interrupted",
          kind: "final_publish",
          contextId: null,
          sourceLaneIds: ["worker", "judge"],
          targetLaneId: "session",
          sourceLaneContextIds: {
            worker: ["context-plan"],
            judge: ["context-plan", "context-implement"],
          },
          mergedSourceLaneIds: ["worker", "judge"],
          validationDebtSourceLaneIds: ["judge"],
          validationEvidence: [],
          status: "running",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "now",
          updatedAt: "now",
          completedAt: null,
        },
      };
      fixture.graphWorkflowExecutions.setActive(
        "/project",
        "session",
        execution,
        "2026-09-15T20:00:00.000Z",
      );
      const readStored = () =>
        db
          .prepare(
            "SELECT definition_json, runtime_json FROM graph_workflow_executions",
          )
          .get() as { definition_json: string; runtime_json: string };
      const original = readStored();
      expect(JSON.parse(original.runtime_json)).not.toHaveProperty(
        "workingDefinition",
      );
      expect(JSON.parse(original.definition_json)).toHaveProperty(
        "workingDefinition",
      );
      const input = {
        name: graphWorkflowLaneCoverage.name,
        context: { db, configDir: null },
      };
      await graphWorkflowLaneCoverage.up(input);
      const read = () =>
        createGraphWorkflowExecutionsRepo(db).getActive("/project", "session")!;
      const migrated = read();
      expect(
        db
          .prepare("SELECT version FROM schema_migrations WHERE version = 17")
          .all(),
      ).toEqual([{ version: 17 }]);
      expect(migrated.executionLanes.worker!.includedContextIds).toEqual([
        "context-plan",
        "context-verify",
      ]);
      expect(migrated.executionLanes.fork!.includedContextIds).toEqual([]);
      expect(migrated.executionLanes.judge!.includedContextIds).toEqual([]);
      expect(remainingSourceLanes(migrated.joins.interrupted!)).toEqual([
        "worker",
        "judge",
      ]);
      expect(migrated.joins.interrupted!.sourceLaneContextIds).toEqual({
        worker: ["context-plan", "context-verify"],
        judge: [],
      });
      expect(migrated.joins.interrupted!.validationDebtSourceLaneIds).toEqual(
        [],
      );
      expect(
        db
          .prepare(
            "SELECT runtime_json FROM graph_workflow_coverage_cutover_backups",
          )
          .get(),
      ).toEqual({ runtime_json: original.runtime_json });
      expect(readStored().definition_json).toBe(original.definition_json);
      expect(JSON.parse(readStored().runtime_json)).not.toHaveProperty(
        "workingDefinition",
      );
      await graphWorkflowLaneCoverage.up(input);
      expect(read()).toEqual(migrated);
    } finally {
      fixture.close();
    }
  });
});
