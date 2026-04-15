import { describe, expect, it } from "vitest";
import { createWorkflowDefinition } from "./test-fixtures";
import type { GraphWorkflowExecutionContextDefinition } from "@/types";

describe("execution context agent config with backend support", () => {
  it("existing fixtures without backend field still produce valid definitions", () => {
    const definition = createWorkflowDefinition();
    expect(definition.executionContexts[0]!.agent.model).toBe("opus");
    expect(definition.executionContexts[0]!.agent.reasoningEffort).toBe("high");
  });

  it("accepts codex backend on execution context agent", () => {
    const definition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "ctx-codex",
          title: "Codex Context",
          agent: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
          } as GraphWorkflowExecutionContextDefinition["agent"],
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
    expect(ctx.agent.backend).toBe("codex");
    expect(ctx.agent.model).toBe("gpt-5.4");
  });

  it("backend field is accessible as a discriminator on agent config", () => {
    const definition = createWorkflowDefinition();
    const agent = definition.executionContexts[0]!.agent;

    expect(agent.backend).toBe("claude");
  });
});
