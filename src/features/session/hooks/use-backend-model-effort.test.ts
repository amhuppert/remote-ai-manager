// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  pickPreferredEffort,
  useBackendModelEffort,
} from "./use-backend-model-effort";
import type { ConversationState } from "@/lib/conversations/schemas";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "c1",
    scope: "session",
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
    machineSnapshot: null,
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
        defaultModel: "fable",
        defaultEffort: "high",
        defaultCodexModel: "gpt-5.4",
        defaultCodexEffort: "high",
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
        defaultModel: "fable",
        defaultEffort: "high",
        defaultCodexModel: "gpt-5.6-terra",
        defaultCodexEffort: "xhigh",
      }),
    );

    act(() => result.current.handleBackendChange("codex"));

    expect(result.current.selectedModel).toBe("gpt-5.6-terra");
    expect(result.current.selectedEffort).toBe("xhigh");
  });
});
