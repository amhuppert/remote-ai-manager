import { describe, expect, it } from "vitest";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { checkpointWorkflowAssignments } from "./fork-workflow-assignments";

describe("checkpoint workflow assignment references", () => {
  it("keeps workflow, concrete contexts, loop templates and dormant cohorts distinct without assigning authority", () => {
    const execution = graphWorkflowExecutionSchema.parse(
      buildMaximalGraphWorkflowExecution(),
    );
    const before = JSON.stringify(execution);
    const choices = checkpointWorkflowAssignments(execution);
    expect(choices.some((choice) => choice.owner.kind === "workflow")).toBe(
      true,
    );
    expect(choices.some((choice) => choice.owner.kind === "context")).toBe(
      true,
    );
    expect(
      choices.some((choice) => choice.owner.kind === "loop_template"),
    ).toBe(true);
    expect(
      choices.some(
        (choice) =>
          choice.useSite === "validator" &&
          choice.label.includes("Disabled cohort"),
      ),
    ).toBe(true);
    expect(new Set(choices.map((choice) => choice.id)).size).toBe(
      choices.length,
    );
    expect(JSON.stringify(execution)).toBe(before);
    expect(
      checkpointWorkflowAssignments({
        ...execution,
        launchDocument: null,
      }).some((choice) => choice.owner.kind === "workflow"),
    ).toBe(false);
  });
});
