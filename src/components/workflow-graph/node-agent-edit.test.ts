import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { nodeAgentPatch } from "./node-agent-edit";

const agent = {
  backend: "codex" as const,
  modelSelection: {
    modelId: "gpt-6-astra",
    parameters: { reasoning: "xhigh", fast: "true" },
  },
};

describe("nodeAgentPatch", () => {
  it("preserves implementer identity and instructions while removing its execution snapshot", () => {
    const context =
      createWorkflowExecution().workingDefinition.executionContexts[0]!;
    const patch = nodeAgentPatch(context, { kind: "implementer" }, agent);
    const { profileSnapshot: _snapshot, ...authored } = context.implementer;
    expect(patch).toEqual({ implementer: { ...authored, agent } });
    expect(context.implementer.agent).not.toEqual(agent);
  });

  it("edits an existing seat by ID without losing siblings, cohort policy, or assignment metadata", () => {
    const context =
      createWorkflowExecution().workingDefinition.executionContexts[0]!;
    const first = {
      ...context.implementer,
      id: "general",
      authority: "blocking" as const,
    };
    context.contextValidator.enabled = true;
    const second = {
      ...first,
      id: "security",
      authority: "advisory" as const,
      focus: "Check permissions",
    };
    context.contextValidator.assignments = [first, second];
    const patch = nodeAgentPatch(
      context,
      { kind: "validator", assignmentId: second.id },
      agent,
    );
    expect(patch.contextValidator).toEqual({
      ...context.contextValidator,
      assignments: [first, second].map(
        ({ profileSnapshot: _snapshot, ...assignment }) => ({
          ...assignment,
          agent: assignment.id === second.id ? agent : assignment.agent,
        }),
      ),
    });
    expect(patch).not.toHaveProperty("implementer");
    expect(patch.contextValidator?.assignments).toHaveLength(2);
    expect(context.contextValidator.assignments[1]?.agent).toEqual(
      second.agent,
    );
  });

  it("does not add a missing seat", () => {
    const context =
      createWorkflowExecution().workingDefinition.executionContexts[0]!;
    expect(
      nodeAgentPatch(
        context,
        { kind: "validator", assignmentId: "missing" },
        agent,
      ),
    ).toEqual({});
  });
});
