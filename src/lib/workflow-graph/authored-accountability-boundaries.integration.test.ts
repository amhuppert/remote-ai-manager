import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  createWorkflowLayout,
  TEST_AGENT_BACKENDS_CONFIG,
} from "./test-fixtures";
import { admitAuthoredWorkflowLaunch } from "./authored-launch-admission";
import { locateAuthoredAccountabilityCoverage } from "./authored-accountability-coverage";

describe("authored accountability application boundaries", () => {
  it("carries admission identities into independent live-edit coverage groups", async () => {
    const launch = {
      name: "Accountability boundary",
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    };
    const admitted = await admitAuthoredWorkflowLaunch(launch, {
      caller: "project-validate",
      documentScope: { kind: "project", projectPath: "/repo" },
      workflowDefaults: undefined,
      agentBackends: TEST_AGENT_BACKENDS_CONFIG,
      assignmentReferences: {
        async checkDefinition() {
          return [];
        },
        async checkWorkflowDefaults() {
          return [];
        },
      },
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const resolved = createWorkflowExecution().workingDefinition;
    const proposedDefinition = {
      ...resolved,
      executionContexts: resolved.executionContexts.filter(
        (context) => context.id !== "context-implement",
      ),
      tasks: resolved.tasks.filter(
        (task) => task.contextId !== "context-implement",
      ),
      edges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    };
    const located = locateAuthoredAccountabilityCoverage({
      source: {
        kind: "working",
        definition: proposedDefinition,
        admittedStableSourceIds: admitted.stableAccountabilityContextIds,
      },
      groups: [
        {
          bindingKey: "binding-with-alternative",
          claimantContextIds: ["context-implement", "context-verify"],
        },
        {
          bindingKey: "binding-orphaned-by-edit",
          claimantContextIds: ["context-implement"],
        },
      ],
    });

    expect(located).toEqual([
      {
        bindingKey: "binding-with-alternative",
        claimantContextIds: ["context-implement", "context-verify"],
        stableExistingClaimantContextIds: ["context-verify"],
        mustRunClaimantContextIds: ["context-verify"],
        covered: true,
      },
      {
        bindingKey: "binding-orphaned-by-edit",
        claimantContextIds: ["context-implement"],
        stableExistingClaimantContextIds: [],
        mustRunClaimantContextIds: [],
        covered: false,
      },
    ]);
  });
});
