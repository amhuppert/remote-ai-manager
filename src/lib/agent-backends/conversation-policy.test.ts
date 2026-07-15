import { describe, expect, it } from "vitest";
import {
  resolveConfiguredBackendSelectionDefaults,
  type ConversationTurnConfig,
} from "./conversation-policy";

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
