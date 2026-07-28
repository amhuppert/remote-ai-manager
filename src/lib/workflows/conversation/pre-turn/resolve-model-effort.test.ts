import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  resolveBackendStallTimeoutMs,
  resolveBackendTimeoutMs,
  resolveBackendTurnSettings,
  resolveTurnCodexFastMode,
  resolveTurnModelEffort,
  type ActorConfig,
} from "./resolve-model-effort";

function makeConfig(): ActorConfig {
  return {
    agentBackends: {
      claude: {
        model: "opus",
        reasoningEffort: "high",
        timeoutMs: 300_000,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "medium",
        fastMode: true,
        timeoutMs: null,
      },
    },
    maxTurns: 50,
    idleQuerySessionTtlMs: 300_000,
  };
}

function userTurn(
  model?: string,
  effort?: string,
  codexFastMode?: boolean,
): TranscriptMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "hi" }],
    timestamp: null,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(codexFastMode !== undefined ? { codexFastMode } : {}),
  };
}

function assistantTurn(): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    timestamp: null,
  };
}

describe("resolveTurnCodexFastMode", () => {
  it("prefers an explicit conversation selection over the last turn and global default", () => {
    expect(
      resolveTurnCodexFastMode({
        backend: "codex",
        config: makeConfig(),
        explicitCodexFastMode: false,
        priorMessages: [userTurn("gpt-5.4", "high", true)],
      }),
    ).toBe(false);
  });

  it("uses the conversation's latest selection before the global default", () => {
    expect(
      resolveTurnCodexFastMode({
        backend: "codex",
        config: makeConfig(),
        explicitCodexFastMode: null,
        priorMessages: [
          userTurn("gpt-5.4", "high", true),
          assistantTurn(),
          userTurn("gpt-5.4", "high", false),
        ],
      }),
    ).toBe(false);
  });

  it("uses the global Codex default for a conversation without a prior selection", () => {
    expect(
      resolveTurnCodexFastMode({
        backend: "codex",
        config: makeConfig(),
        explicitCodexFastMode: null,
        priorMessages: [],
      }),
    ).toBe(true);
  });

  it("never enables Codex fast mode for Claude", () => {
    expect(
      resolveTurnCodexFastMode({
        backend: "claude",
        config: makeConfig(),
        explicitCodexFastMode: true,
        priorMessages: [],
      }),
    ).toBe(false);
  });
});

describe("resolveBackendTurnSettings", () => {
  it("uses the selected backend's profile without consulting the default backend", () => {
    const config = makeConfig();

    expect(resolveBackendTurnSettings("claude", config, null, null)).toEqual({
      effectiveModel: "opus",
      effectiveEffort: "high",
    });
    expect(resolveBackendTurnSettings("codex", config, null, null)).toEqual({
      effectiveModel: "gpt-5.4",
      effectiveEffort: "medium",
    });
  });

  it("prefers explicit model and effort over the configured profile", () => {
    expect(
      resolveBackendTurnSettings("codex", makeConfig(), "gpt-5.6-sol", "ultra"),
    ).toEqual({
      effectiveModel: "gpt-5.6-sol",
      effectiveEffort: "ultra",
    });
  });

  it("does not synthesize effort for Haiku", () => {
    const base = makeConfig();
    const config: ActorConfig = {
      ...base,
      agentBackends: {
        ...base.agentBackends,
        claude: {
          model: "haiku",
          timeoutMs: 300_000,
        },
      },
    };

    expect(resolveBackendTurnSettings("claude", config, null, null)).toEqual({
      effectiveModel: "haiku",
      effectiveEffort: undefined,
    });
  });
});

describe("resolveTurnModelEffort", () => {
  it("uses explicit values before the conversation's last selection", () => {
    expect(
      resolveTurnModelEffort({
        backend: "claude",
        config: makeConfig(),
        explicitModel: "sonnet",
        explicitEffort: "medium",
        priorMessages: [userTurn("opus", "low")],
      }),
    ).toEqual({ effectiveModel: "sonnet", effectiveEffort: "medium" });
  });

  it("uses the most recent scoped selection before the backend profile", () => {
    expect(
      resolveTurnModelEffort({
        backend: "codex",
        config: makeConfig(),
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [
          userTurn("gpt-5.5", "low"),
          assistantTurn(),
          userTurn("gpt-5.6-sol", "xhigh"),
          assistantTurn(),
        ],
      }),
    ).toEqual({
      effectiveModel: "gpt-5.6-sol",
      effectiveEffort: "xhigh",
    });
  });

  it("fills independently missing scoped fields from the profile", () => {
    expect(
      resolveTurnModelEffort({
        backend: "codex",
        config: makeConfig(),
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [userTurn("gpt-5.6-sol")],
      }),
    ).toEqual({
      effectiveModel: "gpt-5.6-sol",
      effectiveEffort: "medium",
    });
  });

  it("falls back to the selected backend's profile with no scoped selection", () => {
    expect(
      resolveTurnModelEffort({
        backend: "claude",
        config: makeConfig(),
        explicitModel: null,
        explicitEffort: null,
        priorMessages: [assistantTurn()],
      }),
    ).toEqual({ effectiveModel: "opus", effectiveEffort: "high" });
  });
});

describe("backend timeout resolution", () => {
  it("resolves the safety timeout from the actual backend profile", () => {
    const config = makeConfig();
    expect(resolveBackendTimeoutMs("claude", config)).toBe(300_000);
    expect(resolveBackendTimeoutMs("codex", config)).toBe(0);
  });

  it("resolves the codex stall default and honors explicit disable", () => {
    const config = makeConfig();
    expect(resolveBackendStallTimeoutMs("codex", config)).toBe(20 * 60 * 1000);

    config.agentBackends.codex.stallTimeoutMs = null;
    expect(resolveBackendStallTimeoutMs("codex", config)).toBe(0);
  });
});
