import { describe, expect, it } from "vitest";
import { createWorkflowDefinition } from "./test-fixtures";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
describe("execution context implementer config with backend support", () => {
  it("existing fixtures without backend field still produce valid definitions", () => {
    const definition = createWorkflowDefinition();
    expect(definition.executionContexts[0]!.implementer?.agent.model).toBe(
      "opus",
    );
    expect(
      definition.executionContexts[0]!.implementer?.agent.reasoningEffort,
    ).toBe("high");
  });

  it("accepts codex backend on execution context implementer", () => {
    const definition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "ctx-codex",
          title: "Codex Context",
          acceptanceCriteria: "TBD",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            agent: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "high",
            },
          } as GraphWorkflowExecutionContextDefinition["implementer"],
          mutability: { allowAgentTaskAdd: false },
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
    expect(ctx.implementer?.agent.model).toBe("gpt-5.4");
  });

  it("backend field is accessible as a discriminator on implementer config", () => {
    const definition = createWorkflowDefinition();
    const implementer = definition.executionContexts[0]!.implementer;

    expect(implementer?.agent.backend).toBe("claude");
  });
});
