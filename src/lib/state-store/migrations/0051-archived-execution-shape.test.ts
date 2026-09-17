import { expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowArchivedExecutionsRepo } from "../graph-workflow-archived-executions-repo";
import { migrateArchivedExecutionAssignments } from "./0051-archived-execution-shape";

it("persists archived assignments once while preserving historical runtime and unknown fields", () => {
  const fixture = createPersistenceFixture();
  try {
    fixture.seedProject("/project");
    fixture.seedSession("/project", "session");
    const execution = createWorkflowExecution({ id: "old-archive" });
    const archived = {
      ...execution,
      retainedEvidence: { note: "original bytes of unrelated evidence" },
      workingDefinition: {
        ...execution.workingDefinition,
        executionContexts: execution.workingDefinition.executionContexts.map(
          (context) => ({
            ...context,
            implementer: { model: "opus", reasoningEffort: "high" },
            contextValidator: null,
            collaboration: {
              enabled: { value: false, source: "global" },
              negotiationRounds: { value: 3, source: "global" },
              autonomousResolutionThreshold: {
                value: "minor",
                source: "global",
              },
              secondAgent: {
                source: "global",
                value: {
                  backend: "codex",
                  model: "gpt-5.6-sol",
                  reasoningEffort: "xhigh",
                },
              },
            },
          }),
        ),
      },
    };
    fixture.db
      .prepare(
        `INSERT INTO graph_workflow_archived_executions
      (project_path, session_name, execution_id, archived_at, status, started_at, completed_at, execution_json)
      VALUES ('/project', 'session', 'old-archive', '2026-01-02', 'completed', '2026-01-01', '2026-01-02', ?)`,
      )
      .run(JSON.stringify(archived));
    const read = () =>
      fixture.db
        .prepare(
          "SELECT execution_json FROM graph_workflow_archived_executions WHERE execution_id = 'old-archive'",
        )
        .get() as { execution_json: string };

    migrateArchivedExecutionAssignments(fixture.db);
    const migrated = read().execution_json;
    expect(
      JSON.parse(migrated).workingDefinition.executionContexts[0].implementer
        .agent,
    ).toEqual({
      backend: "claude",
      modelSelection: { modelId: "opus", parameters: { effort: "high" } },
    });
    expect(JSON.parse(migrated).retainedEvidence).toEqual(
      archived.retainedEvidence,
    );
    expect(
      JSON.parse(migrated).workingDefinition.executionContexts[0].collaboration
        .secondAgent.value,
    ).toEqual({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "xhigh", fast: "false" },
      },
    });
    const reopened = createGraphWorkflowArchivedExecutionsRepo(fixture.db);
    expect(
      reopened.findByExecutionId("old-archive")?.workingDefinition
        .executionContexts[0]?.contextValidator,
    ).toEqual({ enabled: false, assignments: [] });
    migrateArchivedExecutionAssignments(fixture.db);
    expect(read().execution_json).toBe(migrated);
  } finally {
    fixture.close();
  }
});
