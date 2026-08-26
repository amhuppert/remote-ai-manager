import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  resolveBackendStallTimeoutMs,
  resolveBackendTimeoutMs,
  resolveBackendTurnSelection,
  resolveTurnModelSelection,
  type ActorConfig,
} from "./resolve-model-effort";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { getDefaultStallTimeoutForBackend } from "@/lib/agent-backends/catalog";

function makeConfig(): ActorConfig {
  return {
    agentBackends: {
      claude: {
        modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        timeoutMs: 300_000,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "true" },
        },
        timeoutMs: null,
      },
      cursor: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    },
    maxTurns: 50,
    idleQuerySessionTtlMs: 300_000,
  };
}

function userTurn(modelSelection?: BackendModelSelection): TranscriptMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "hi" }],
    timestamp: null,
    ...(modelSelection !== undefined ? { modelSelection } : {}),
  };
}

function assistantTurn(): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    timestamp: null,
  };
}

describe("atomic model selection resolution", () => {
  it("uses the selected backend's complete configured selection", () => {
    expect(resolveBackendTurnSelection("codex", makeConfig(), null)).toEqual({
      modelId: "gpt-5.4",
      parameters: { reasoning: "medium", fast: "true" },
    });
  });

  it("prefers the complete explicit selection over remembered and configured selections", () => {
    const explicit = {
      modelId: "gpt-5.6-sol",
      parameters: { reasoning: "ultra", fast: "false", context: "1m" },
    };
    expect(
      resolveTurnModelSelection({
        backend: "codex",
        config: makeConfig(),
        explicitModelSelection: explicit,
        priorMessages: [
          userTurn({
            modelId: "gpt-5.5",
            parameters: { reasoning: "low", fast: "true" },
          }),
        ],
      }),
    ).toEqual(explicit);
  });

  it("reuses the most recent selection as one indivisible bundle", () => {
    const remembered = {
      modelId: "gpt-5.6-sol",
      parameters: { reasoning: "xhigh", fast: "false", context: "1m" },
    };
    expect(
      resolveTurnModelSelection({
        backend: "codex",
        config: makeConfig(),
        explicitModelSelection: null,
        priorMessages: [
          userTurn({
            modelId: "gpt-5.5",
            parameters: { reasoning: "low", fast: "true" },
          }),
          assistantTurn(),
          userTurn(remembered),
          assistantTurn(),
        ],
      }),
    ).toEqual(remembered);
  });

  it("falls back to the backend profile when no turn has a selection", () => {
    expect(
      resolveTurnModelSelection({
        backend: "claude",
        config: makeConfig(),
        explicitModelSelection: null,
        priorMessages: [assistantTurn()],
      }),
    ).toEqual({ modelId: "opus", parameters: { effort: "high" } });
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

  it("arms the claude stall default and honors explicit disable", () => {
    const config = makeConfig();
    // The turn the conversation actor arms must carry the backend's declared
    // bound, not the unbounded sentinel.
    expect(resolveBackendStallTimeoutMs("claude", config)).toBe(
      getDefaultStallTimeoutForBackend("claude"),
    );
    expect(resolveBackendStallTimeoutMs("claude", config)).toBeGreaterThan(0);

    config.agentBackends.claude.stallTimeoutMs = null;
    expect(resolveBackendStallTimeoutMs("claude", config)).toBe(0);
  });
});
