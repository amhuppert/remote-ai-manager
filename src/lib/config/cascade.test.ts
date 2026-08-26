import { describe, expect, it } from "vitest";
import { resolveCompactionConfig } from "./cascade";
import type { GlobalConfig, PerRepoConfig } from "./schemas";

describe("resolveCompactionConfig", () => {
  it("materializes schema defaults with no timeout when neither global nor repo config set compaction", () => {
    const globalConfig: Pick<GlobalConfig, "compaction"> = {};

    const result = resolveCompactionConfig(globalConfig, null);

    expect(result).toEqual({
      backend: "claude",
      conversationModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
      messageModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    });
    expect(result.timeoutMs).toBeUndefined();
  });

  it("lets a per-repo null timeout clear a global timeout to no-timeout", () => {
    const globalConfig: Pick<GlobalConfig, "compaction"> = {
      compaction: {
        backend: "claude",
        conversationModelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
        messageModelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
        timeoutMs: 60_000,
      },
    };
    const repoConfig: Pick<PerRepoConfig, "compaction"> = {
      compaction: { timeoutMs: null },
    };

    const result = resolveCompactionConfig(globalConfig, repoConfig);

    expect(result.timeoutMs).toBeNull();
  });

  it("uses the global compaction block when no repo override is present", () => {
    const globalConfig: Pick<GlobalConfig, "compaction"> = {
      compaction: {
        backend: "codex",
        conversationModelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        messageModelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        timeoutMs: 60_000,
      },
    };

    const result = resolveCompactionConfig(globalConfig, null);

    expect(result).toEqual(globalConfig.compaction);
  });

  it("merges a partial per-repo override field-wise over the global config", () => {
    const globalConfig: Pick<GlobalConfig, "compaction"> = {
      compaction: {
        backend: "claude",
        conversationModelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        messageModelSelection: {
          modelId: "sonnet",
          parameters: { effort: "high" },
        },
        timeoutMs: 60_000,
      },
    };
    const repoConfig: Pick<PerRepoConfig, "compaction"> = {
      compaction: {
        messageModelSelection: { modelId: "haiku", parameters: {} },
      },
    };

    const result = resolveCompactionConfig(globalConfig, repoConfig);

    expect(result).toEqual({
      backend: "claude",
      conversationModelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      messageModelSelection: { modelId: "haiku", parameters: {} },
      timeoutMs: 60_000,
    });
  });
});
