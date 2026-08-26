import { describe, expect, it } from "vitest";
import {
  resolveConfiguredAgentBackendDefaults,
  type ConversationTurnConfig,
} from "./conversation-policy";
import { CLAUDE_DEFAULT_STALL_TIMEOUT_MS } from "./claude/shared";

function makeConfig(
  overrides: Partial<ConversationTurnConfig["agentBackends"]> = {},
): ConversationTurnConfig {
  return {
    agentBackends: {
      claude: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: 300_000,
        ...overrides.claude,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        timeoutMs: null,
        ...overrides.codex,
      },
      cursor: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    },
  };
}

describe("resolveConfiguredAgentBackendDefaults", () => {
  it("resolves each backend exclusively from its own profile", () => {
    const config = makeConfig({
      claude: {
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
        timeoutMs: 45_000,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { reasoning: "ultra", fast: "true" },
        },
        timeoutMs: 90_000,
        stallTimeoutMs: 60_000,
      },
    });

    expect(resolveConfiguredAgentBackendDefaults(config, "claude")).toEqual({
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
      timeoutMs: 45_000,
      stallTimeoutMs: CLAUDE_DEFAULT_STALL_TIMEOUT_MS,
    });
    expect(resolveConfiguredAgentBackendDefaults(config, "codex")).toEqual({
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "ultra", fast: "true" },
      },
      timeoutMs: 90_000,
      stallTimeoutMs: 60_000,
    });
  });

  it("preserves a complete parameterless selection", () => {
    const config = makeConfig({
      claude: {
        modelSelection: { modelId: "haiku", parameters: {} },
        timeoutMs: null,
      },
    });

    expect(
      resolveConfiguredAgentBackendDefaults(config, "claude").modelSelection,
    ).toEqual({ modelId: "haiku", parameters: {} });
  });

  it("converts null safety timeouts to the runtime's unbounded sentinel", () => {
    const config = makeConfig({
      claude: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: null,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        timeoutMs: null,
      },
    });

    expect(
      resolveConfiguredAgentBackendDefaults(config, "claude").timeoutMs,
    ).toBe(0);
    expect(
      resolveConfiguredAgentBackendDefaults(config, "codex").timeoutMs,
    ).toBe(0);
  });

  it("uses the descriptor stall default when unset and lets null disable it", () => {
    expect(
      resolveConfiguredAgentBackendDefaults(makeConfig(), "codex")
        .stallTimeoutMs,
    ).toBe(20 * 60 * 1000);

    const disabled = makeConfig({
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        timeoutMs: null,
        stallTimeoutMs: null,
      },
    });
    expect(
      resolveConfiguredAgentBackendDefaults(disabled, "codex").stallTimeoutMs,
    ).toBe(0);
  });

  it("honors a Claude stall override and lets null disable the bound", () => {
    const raised = makeConfig({
      claude: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: null,
        stallTimeoutMs: 45 * 60 * 1000,
      },
    });
    expect(
      resolveConfiguredAgentBackendDefaults(raised, "claude").stallTimeoutMs,
    ).toBe(45 * 60 * 1000);

    const disabled = makeConfig({
      claude: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: null,
        stallTimeoutMs: null,
      },
    });
    expect(
      resolveConfiguredAgentBackendDefaults(disabled, "claude").stallTimeoutMs,
    ).toBe(0);
  });
});
