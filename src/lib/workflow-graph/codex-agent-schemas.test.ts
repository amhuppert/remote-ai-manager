import { describe, expect, it } from "vitest";
import { createWorkflowDefinition } from "./test-fixtures";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
describe("execution context implementer config with backend support", () => {
  it("preserves the complete model selection in fixture definitions", () => {
    const definition = createWorkflowDefinition();
    expect(
      definition.executionContexts[0]!.implementer?.agent.modelSelection,
    ).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
  });

  it("accepts codex backend on execution context implementer", () => {
    const definition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "ctx-codex",
          title: "Codex Context",
          acceptanceCriteria: "TBD",
          placement: { lane: "ctx-codex", mode: "full" },
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            agent: {
              backend: "codex",
              modelSelection: {
                modelId: "gpt-5.4",
                parameters: { reasoning: "high", fast: "false" },
              },
            },
          } as GraphWorkflowExecutionContextDefinition["implementer"],
          mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 3,
            continuity: { enabled: true },
          },
        },
      ],
    });

    const ctx = definition.executionContexts[0]!;
    expect(ctx.implementer?.agent.backend).toBe("codex");
    expect(ctx.implementer?.agent.modelSelection).toEqual({
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "false" },
    });
  });

  it("backend field is accessible as a discriminator on implementer config", () => {
    const definition = createWorkflowDefinition();
    const implementer = definition.executionContexts[0]!.implementer;

    expect(implementer?.agent.backend).toBe("claude");
  });
});
