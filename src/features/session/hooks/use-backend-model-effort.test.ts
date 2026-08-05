// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  pickPreferredEffort,
  useBackendModelEffort,
} from "./use-backend-model-effort";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import type { ConversationState } from "@/lib/conversations/schemas";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "c1",
    scope: "session",
    nameOrigin: "default",
    name: "chat",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    ...overrides,
  };
}

describe("pickPreferredEffort", () => {
  it("returns preferred when supported", () => {
    expect(pickPreferredEffort(["low", "medium", "high"], "medium")).toBe(
      "medium",
    );
  });

  it("falls back to high when preferred unsupported and high available", () => {
    expect(pickPreferredEffort(["low", "high"], "medium")).toBe("high");
  });

  it("falls back to first level when neither preferred nor high available", () => {
    expect(pickPreferredEffort(["low", "medium"], "minimal")).toBe("low");
  });

  it("returns preferred when no levels available (effort unsupported)", () => {
    expect(pickPreferredEffort([], "high")).toBe("high");
  });
});

describe("useBackendModelEffort", () => {
  it("initializes controls from the session conversation's last sent model and effort", () => {
    const { result } = renderHook(() =>
      useBackendModelEffort({
        conversationId: "c1",
        activeConversation: makeConversation(),
        backendDefaults: {
          claude: { modelId: "fable", effort: "high" },
          codex: { modelId: "gpt-5.4", effort: "high" },
        },
        lastUsedModelId: "sonnet",
        lastUsedEffort: "medium",
      }),
    );

    expect(result.current.selectedModel).toBe("sonnet");
    expect(result.current.selectedEffort).toBe("medium");
  });

  it("uses the configured Codex defaults when switching backends", () => {
    const { result } = renderHook(() =>
      useBackendModelEffort({
        conversationId: "c1",
        activeConversation: makeConversation({ promptCount: 0 }),
        backendDefaults: {
          claude: { modelId: "fable", effort: "high" },
          codex: { modelId: "gpt-5.6-terra", effort: "xhigh" },
        },
      }),
    );

    act(() => result.current.handleBackendChange("codex"));

    expect(result.current.selectedModel).toBe("gpt-5.6-terra");
    expect(result.current.selectedEffort).toBe("xhigh");
  });

  it("preserves a custom configured Codex model", () => {
    const { result } = renderHook(() =>
      useBackendModelEffort({
        conversationId: "c1",
        activeConversation: makeConversation({
          agentBackend: "codex",
          promptCount: 0,
        }),
        backendDefaults: {
          claude: { modelId: "opus", effort: "high" },
          codex: { modelId: "custom-codex-model", effort: "ultra" },
        },
      }),
    );

    expect(result.current.selectedModel).toBe("custom-codex-model");
    expect(result.current.selectedEffort).toBe("ultra");
  });

  it("hydrates controls from a running Codex conversation", () => {
    const initialProps: {
      activeConversation: ConversationState | undefined;
      lastUsedModelId: string | undefined;
      lastUsedEffort: string | undefined;
    } = {
      activeConversation: undefined,
      lastUsedModelId: undefined,
      lastUsedEffort: undefined,
    };
    const backendDefaults: BackendSelectionDefaultsById = {
      claude: { modelId: "fable", effort: "high" },
      codex: { modelId: "gpt-5.4", effort: "high" },
    };
    const { result, rerender } = renderHook(
      ({ activeConversation, lastUsedModelId, lastUsedEffort }) =>
        useBackendModelEffort({
          conversationId: "c1",
          activeConversation,
          backendDefaults,
          lastUsedModelId,
          lastUsedEffort,
        }),
      { initialProps },
    );

    expect(result.current.selectedBackend).toBe("claude");

    rerender({
      activeConversation: makeConversation({
        agentBackend: "codex",
        promptCount: 0,
        status: "running",
      }),
      lastUsedModelId: undefined,
      lastUsedEffort: undefined,
    });

    expect(result.current.selectedBackend).toBe("codex");
    expect(result.current.backendLocked).toBe(true);

    rerender({
      activeConversation: makeConversation({
        agentBackend: "codex",
        promptCount: 0,
        status: "running",
      }),
      lastUsedModelId: "gpt-5.6-sol",
      lastUsedEffort: "ultra",
    });

    expect(result.current.selectedModel).toBe("gpt-5.6-sol");
    expect(result.current.selectedEffort).toBe("ultra");
  });

  it("rejects a remembered Claude model in a locked Codex conversation", () => {
    const backendDefaults: BackendSelectionDefaultsById = {
      claude: { modelId: "opus", effort: "high" },
      codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
    };
    const activeConversation = makeConversation({
      agentBackend: "codex",
      promptCount: 2,
    });
    const { result, rerender } = renderHook(
      ({ lastUsedModelId }) =>
        useBackendModelEffort({
          conversationId: "c1",
          activeConversation,
          backendDefaults,
          lastUsedModelId,
          lastUsedEffort: "ultra",
        }),
      { initialProps: { lastUsedModelId: "gpt-5.6-luna" } },
    );

    expect(result.current.selectedModel).toBe("gpt-5.6-luna");

    rerender({ lastUsedModelId: "opus" });

    expect(result.current.selectedBackend).toBe("codex");
    expect(result.current.selectedModel).toBe("gpt-5.6-sol");
  });

  it("uses the canonical Codex default when remembered and configured models belong to Claude", () => {
    const backendDefaults: BackendSelectionDefaultsById = {
      claude: { modelId: "opus", effort: "high" },
      codex: { modelId: "opus", effort: "ultra" },
    };
    const activeConversation = makeConversation({
      agentBackend: "codex",
      promptCount: 2,
    });

    const { result } = renderHook(() =>
      useBackendModelEffort({
        conversationId: "c1",
        activeConversation,
        backendDefaults,
        lastUsedModelId: "opus",
        lastUsedEffort: "ultra",
      }),
    );

    expect(result.current.selectedBackend).toBe("codex");
    expect(result.current.selectedModel).toBe("gpt-5.4");
  });

  it("rejects a non-catalog last-used Claude model", () => {
    const { result } = renderHook(() =>
      useBackendModelEffort({
        conversationId: "c1",
        activeConversation: makeConversation(),
        backendDefaults: {
          claude: { modelId: "sonnet", effort: "medium" },
          codex: { modelId: "gpt-5.4", effort: "high" },
        },
        lastUsedModelId: "custom-claude-model",
        lastUsedEffort: "high",
      }),
    );

    expect(result.current.selectedModel).toBe("sonnet");
  });
});
