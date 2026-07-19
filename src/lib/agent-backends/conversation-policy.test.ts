import { describe, expect, it, beforeAll } from "vitest";
import {
  resolveConfiguredBackendSelectionDefaults,
  resolveConfiguredStallTimeoutMs,
  type ConversationTurnConfig,
} from "./conversation-policy";
import { bootstrapBackends } from "./registry";

beforeAll(() => {
  bootstrapBackends();
});

describe("resolveConfiguredBackendSelectionDefaults", () => {
  it("projects provider configuration into backend-keyed selection defaults", () => {
    const config: ConversationTurnConfig = {
      claudeTimeoutMs: 300_000,
      defaultModel: "sonnet",
      defaultEffort: "medium",
      codex: {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    };

    expect(resolveConfiguredBackendSelectionDefaults(config)).toEqual({
      claude: { modelId: "sonnet", effort: "medium" },
      codex: { modelId: "gpt-5.6-sol", effort: "xhigh" },
    });
  });

  it("uses each backend's declared model and the composer effort fallback", () => {
    const config: ConversationTurnConfig = {
      claudeTimeoutMs: 300_000,
    };

    expect(resolveConfiguredBackendSelectionDefaults(config)).toEqual({
      claude: { modelId: "opus", effort: "high" },
      codex: { modelId: "gpt-5.4", effort: "high" },
    });
  });
});

describe("resolveConfiguredStallTimeoutMs", () => {
  const baseConfig: ConversationTurnConfig = { claudeTimeoutMs: 300_000 };

  it("codex defaults to the descriptor's stall bound when unconfigured", () => {
    expect(resolveConfiguredStallTimeoutMs("codex", baseConfig)).toBe(
      20 * 60 * 1000,
    );
  });

  it("codex honors a configured override", () => {
    expect(
      resolveConfiguredStallTimeoutMs("codex", {
        ...baseConfig,
        codex: { stallTimeoutMs: 60_000 },
      }),
    ).toBe(60_000);
  });

  it("an explicit null disables the codex stall bound", () => {
    expect(
      resolveConfiguredStallTimeoutMs("codex", {
        ...baseConfig,
        codex: { stallTimeoutMs: null },
      }),
    ).toBe(0);
  });

  it("claude stays disabled (descriptor declares no stall bound)", () => {
    expect(resolveConfiguredStallTimeoutMs("claude", baseConfig)).toBe(0);
  });
});
