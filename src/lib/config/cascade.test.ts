import { describe, expect, it } from "vitest";
import { resolveCompactionConfig } from "./cascade";
import type { GlobalConfig, PerRepoConfig } from "./schemas";

describe("resolveCompactionConfig", () => {
  it("materializes schema defaults when neither global nor repo config set compaction", () => {
    const globalConfig: Pick<GlobalConfig, "compaction"> = {};

    const result = resolveCompactionConfig(globalConfig, null);

    expect(result).toEqual({
      backend: "claude",
      conversationModel: "sonnet",
      messageModel: "sonnet",
      effort: "medium",
      timeoutMs: 180_000,
    });
  });

  it("uses the global compaction block when no repo override is present", () => {
    const globalConfig: Pick<GlobalConfig, "compaction"> = {
      compaction: {
        backend: "codex",
        conversationModel: "opus",
        messageModel: "sonnet",
        effort: "high",
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
        conversationModel: "opus",
        messageModel: "sonnet",
        effort: "high",
        timeoutMs: 60_000,
      },
    };
    const repoConfig: Pick<PerRepoConfig, "compaction"> = {
      compaction: { messageModel: "haiku" },
    };

    const result = resolveCompactionConfig(globalConfig, repoConfig);

    expect(result).toEqual({
      backend: "claude",
      conversationModel: "opus",
      messageModel: "haiku",
      effort: "high",
      timeoutMs: 60_000,
    });
  });
});
