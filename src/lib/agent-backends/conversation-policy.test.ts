import { describe, expect, it } from "vitest";
import {
  resolveConfiguredAgentBackendDefaults,
  type ConversationTurnConfig,
} from "./conversation-policy";

function makeConfig(
  overrides: Partial<ConversationTurnConfig["agentBackends"]> = {},
): ConversationTurnConfig {
  return {
    agentBackends: {
      claude: {
        model: "opus",
        reasoningEffort: "high",
        timeoutMs: 300_000,
        ...overrides.claude,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        timeoutMs: null,
        ...overrides.codex,
      },
    },
  };
}

describe("resolveConfiguredAgentBackendDefaults", () => {
  it("resolves each backend exclusively from its own profile", () => {
    const config = makeConfig({
      claude: {
        model: "sonnet",
        reasoningEffort: "medium",
        timeoutMs: 45_000,
      },
      codex: {
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        fastMode: true,
        timeoutMs: 90_000,
        stallTimeoutMs: 60_000,
      },
    });

    expect(resolveConfiguredAgentBackendDefaults(config, "claude")).toEqual({
      modelId: "sonnet",
      reasoningEffort: "medium",
      codexFastMode: false,
      timeoutMs: 45_000,
      stallTimeoutMs: 0,
    });
    expect(resolveConfiguredAgentBackendDefaults(config, "codex")).toEqual({
      modelId: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      codexFastMode: true,
      timeoutMs: 90_000,
      stallTimeoutMs: 60_000,
    });
  });

  it("uses high when effort is unset and the model supports it", () => {
    const config = makeConfig({
      claude: {
        model: "opus",
        reasoningEffort: undefined,
        timeoutMs: null,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: undefined,
        timeoutMs: null,
      },
    });

    expect(
      resolveConfiguredAgentBackendDefaults(config, "claude").reasoningEffort,
    ).toBe("high");
    expect(
      resolveConfiguredAgentBackendDefaults(config, "codex").reasoningEffort,
    ).toBe("high");
  });

  it("rejects a Claude model configured in the Codex profile", () => {
    const config = makeConfig({
      codex: {
        model: "opus",
        reasoningEffort: "medium",
        timeoutMs: null,
      },
    });

    expect(resolveConfiguredAgentBackendDefaults(config, "codex").modelId).toBe(
      "gpt-5.4",
    );
  });

  it("omits effort for a model that does not support reasoning effort", () => {
    const config = makeConfig({
      claude: {
        model: "haiku",
        reasoningEffort: undefined,
        timeoutMs: null,
      },
    });

    expect(
      resolveConfiguredAgentBackendDefaults(config, "claude").reasoningEffort,
    ).toBeUndefined();
  });

  it("converts null safety timeouts to the runtime's unbounded sentinel", () => {
    const config = makeConfig({
      claude: { model: "opus", timeoutMs: null },
      codex: { model: "gpt-5.4", timeoutMs: null },
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
        model: "gpt-5.4",
        timeoutMs: null,
        stallTimeoutMs: null,
      },
    });
    expect(
      resolveConfiguredAgentBackendDefaults(disabled, "codex").stallTimeoutMs,
    ).toBe(0);
  });
});
