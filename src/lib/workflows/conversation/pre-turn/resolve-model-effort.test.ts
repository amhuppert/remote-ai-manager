import { afterAll, beforeAll, describe, it, expect } from "vitest";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "@/lib/agent-backends/registry-core";
import { bootstrapBackends } from "@/lib/agent-backends/registry";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
} from "@/lib/agent-backends/testing/testfake-backend";
import {
  resolveBackendTurnSettings,
  resolveTurnModelEffort,
  resolveBackendTimeoutMs,
  type ActorConfig,
} from "./resolve-model-effort";

beforeAll(() => {
  _resetBackendRegistryForTesting();
  bootstrapBackends();
  _registerBackendForTesting(createTestFakeBackend().descriptor);
});

afterAll(() => {
  _resetBackendRegistryForTesting();
  bootstrapBackends();
});

describe("resolveBackendTurnSettings", () => {
  const baseConfig: ActorConfig = {
    claudeTimeoutMs: 300_000,
    maxTurns: 50,
    idleQuerySessionTtlMs: 300_000,
  };

  it("returns Claude config.defaultModel when backend is claude", () => {
    const config = { ...baseConfig, defaultModel: "opus" };
    expect(resolveBackendTurnSettings("claude", config, null, null)).toEqual({
      effectiveModel: "opus",
      effectiveEffort: undefined,
    });
  });

  it("returns explicit model over Claude default", () => {
    const config = { ...baseConfig, defaultModel: "opus" };
    expect(
      resolveBackendTurnSettings("claude", config, "sonnet", null),
    ).toEqual({ effectiveModel: "sonnet", effectiveEffort: undefined });
  });

  it("returns Claude defaultEffort when backend is claude", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
    };
    expect(resolveBackendTurnSettings("claude", config, null, null)).toEqual({
      effectiveModel: "opus",
      effectiveEffort: "high",
    });
  });

  it("returns Codex config defaults when backend is codex", () => {
    const config = {
      ...baseConfig,
      codex: { model: "o3", reasoningEffort: "high" },
    };
    expect(resolveBackendTurnSettings("codex", config, null, null)).toEqual({
      effectiveModel: "o3",
      effectiveEffort: "high",
    });
  });

  it("returns explicit over Codex defaults", () => {
    const config = {
      ...baseConfig,
      codex: { model: "o3", reasoningEffort: "high" },
    };
    expect(resolveBackendTurnSettings("codex", config, "gpt-5", "low")).toEqual(
      { effectiveModel: "gpt-5", effectiveEffort: "low" },
    );
  });

  it("returns undefined for Codex when no config and no explicit", () => {
    expect(resolveBackendTurnSettings("codex", baseConfig, null, null)).toEqual(
      { effectiveModel: undefined, effectiveEffort: undefined },
    );
  });

  it("does not fall back to Claude defaults for Codex backend", () => {
    const config = { ...baseConfig, defaultModel: "opus" };
    expect(resolveBackendTurnSettings("codex", config, null, null)).toEqual({
      effectiveModel: undefined,
      effectiveEffort: undefined,
    });
  });

  it("uses a registered backend's declared model instead of another backend's config", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
      codex: { model: "gpt-5", reasoningEffort: "medium" },
    };

    expect(
      resolveBackendTurnSettings(TESTFAKE_BACKEND_ID, config, null, null),
    ).toEqual({
      effectiveModel: "fake-1",
      effectiveEffort: undefined,
    });
  });
});

describe("resolveTurnModelEffort", () => {
  const baseConfig: ActorConfig = {
    claudeTimeoutMs: 300_000,
    maxTurns: 50,
    idleQuerySessionTtlMs: 300_000,
  };

  const userTurn = (model?: string, effort?: string): TranscriptMessage => ({
    role: "user",
    content: [{ type: "text", text: "hi" }],
    timestamp: null,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  });

  const assistantTurn = (): TranscriptMessage => ({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    timestamp: null,
  });

  it("continues with the conversation's last-used model/effort when the turn carries none", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
    };
    expect(
      resolveTurnModelEffort({
        backend: "claude",
        config,
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [userTurn("claude-haiku-4-5", "low")],
      }),
    ).toEqual({ effectiveModel: "claude-haiku-4-5", effectiveEffort: "low" });
  });

  it("prefers an explicit per-turn model/effort over the last-used values", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
    };
    expect(
      resolveTurnModelEffort({
        backend: "claude",
        config,
        explicitModel: "sonnet",
        explicitEffort: "medium",
        priorMessages: [userTurn("claude-haiku-4-5", "low")],
      }),
    ).toEqual({ effectiveModel: "sonnet", effectiveEffort: "medium" });
  });

  it("falls back to config defaults when there is no prior user turn", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
    };
    expect(
      resolveTurnModelEffort({
        backend: "claude",
        config,
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [assistantTurn()],
      }),
    ).toEqual({ effectiveModel: "opus", effectiveEffort: "high" });
  });

  it("reads the most recent user turn, skipping later assistant rows", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
    };
    expect(
      resolveTurnModelEffort({
        backend: "claude",
        config,
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [
          userTurn("opus", "high"),
          assistantTurn(),
          userTurn("claude-haiku-4-5", "low"),
          assistantTurn(),
        ],
      }),
    ).toEqual({ effectiveModel: "claude-haiku-4-5", effectiveEffort: "low" });
  });

  it("continues with the last-used Codex model/effort rather than the codex config defaults", () => {
    const config = {
      ...baseConfig,
      codex: { model: "gpt-5-codex", reasoningEffort: "high" },
    };
    expect(
      resolveTurnModelEffort({
        backend: "codex",
        config,
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [userTurn("gpt-5-codex-mini", "low")],
      }),
    ).toEqual({ effectiveModel: "gpt-5-codex-mini", effectiveEffort: "low" });
  });

  it("falls back to config default effort when the last user turn recorded a model but no effort", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
    };
    expect(
      resolveTurnModelEffort({
        backend: "claude",
        config,
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [userTurn("claude-haiku-4-5", undefined)],
      }),
    ).toEqual({ effectiveModel: "claude-haiku-4-5", effectiveEffort: "high" });
  });
});

describe("resolveBackendTimeoutMs", () => {
  const baseConfig: ActorConfig = {
    claudeTimeoutMs: 300_000,
    maxTurns: 50,
    idleQuerySessionTtlMs: 300_000,
  };

  it("returns claudeTimeoutMs for claude backend", () => {
    expect(resolveBackendTimeoutMs("claude", baseConfig)).toBe(300_000);
  });

  it("returns codex timeoutMs unchanged when configured", () => {
    const config = { ...baseConfig, codex: { timeoutMs: 120_000 } };
    expect(resolveBackendTimeoutMs("codex", config)).toBe(120_000);
  });

  it("returns 0 (no timeout) for codex when timeoutMs is empty", () => {
    const config = { ...baseConfig, codex: {} };
    expect(resolveBackendTimeoutMs("codex", config)).toBe(0);
  });

  it("returns 0 (no timeout) when codex timeoutMs is null", () => {
    const config = { ...baseConfig, codex: { timeoutMs: null } };
    expect(resolveBackendTimeoutMs("codex", config)).toBe(0);
  });

  it("returns 0 (no timeout) when codex config is undefined", () => {
    expect(resolveBackendTimeoutMs("codex", baseConfig)).toBe(0);
  });

  it("uses a registered backend's declared timeout instead of another backend's timeout", () => {
    expect(resolveBackendTimeoutMs(TESTFAKE_BACKEND_ID, baseConfig)).toBe(0);
  });
});
