import { describe, expect, it } from "vitest";

import {
  resolveAgentBackendTurnDefaults,
  type ConversationTurnConfig,
} from "./conversation-policy";

const config = {
  agentBackends: {
    claude: {
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      timeoutMs: 300_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { fast: "false", reasoning: "high" },
      },
      timeoutMs: null,
    },
    cursor: {
      modelSelection: { modelId: "composer-2.5", parameters: {} },
      timeoutMs: null,
    },
  },
} as unknown as ConversationTurnConfig;

describe("atomic conversation model-selection policy", () => {
  it("uses the first complete selection without merging parameters across layers", () => {
    const resolved = resolveAgentBackendTurnDefaults({
      backend: "codex",
      config,
      explicit: {
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { fast: "true", reasoning: "ultra" },
        },
      },
      scoped: {
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { fast: "false", reasoning: "low" },
        },
      },
    } as never);

    expect(resolved.modelSelection).toEqual({
      modelId: "gpt-5.6-sol",
      parameters: { fast: "true", reasoning: "ultra" },
    });
    expect(resolved).not.toHaveProperty("modelId");
    expect(resolved).not.toHaveProperty("reasoningEffort");
    expect(resolved).not.toHaveProperty("codexFastMode");
  });

  it("uses the scoped selection as a whole when the explicit layer is absent", () => {
    const resolved = resolveAgentBackendTurnDefaults({
      backend: "codex",
      config,
      scoped: {
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { fast: "true", reasoning: "xhigh" },
        },
      },
    } as never);

    expect(resolved.modelSelection).toEqual({
      modelId: "gpt-5.5",
      parameters: { fast: "true", reasoning: "xhigh" },
    });
  });
});
