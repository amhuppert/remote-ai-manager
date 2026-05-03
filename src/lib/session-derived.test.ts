import { describe, it, expect } from "vitest";
import { findBusyOtherConversations } from "./session-derived";
import type { ConversationState } from "@/types";

function makeConversation(
  overrides: Partial<ConversationState> & {
    id: string;
    status: ConversationState["status"];
  },
): ConversationState {
  return {
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    promptCount: 0,
    role: null,
    name: null,
    summary: null,
    transcriptPath: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalTurns: 0,
    source: "cc",
    agentBackend: "claude",
    backendRef: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    archived: false,
    ...overrides,
  };
}

describe("findBusyOtherConversations", () => {
  it("returns empty array when conversations are undefined", () => {
    expect(findBusyOtherConversations(undefined, "conv-1")).toEqual([]);
  });

  it("returns empty array when no conversations are running", () => {
    const conversations = [
      makeConversation({ id: "conv-1", status: "running" }),
      makeConversation({ id: "conv-2", status: "awaiting" }),
      makeConversation({ id: "conv-3", status: "new" }),
    ];

    expect(findBusyOtherConversations(conversations, "conv-1")).toEqual([]);
  });

  it("excludes the current conversation even when it is running", () => {
    const conversations = [
      makeConversation({ id: "conv-1", status: "running" }),
    ];

    expect(findBusyOtherConversations(conversations, "conv-1")).toEqual([]);
  });

  it("returns other conversations whose status is running", () => {
    const running = makeConversation({ id: "conv-2", status: "running" });
    const conversations = [
      makeConversation({ id: "conv-1", status: "awaiting" }),
      running,
      makeConversation({ id: "conv-3", status: "new" }),
    ];

    expect(findBusyOtherConversations(conversations, "conv-1")).toEqual([
      running,
    ]);
  });

  it("does not flag waiting_for_input conversations as busy", () => {
    // A conversation paused on AskUserQuestion is not editing files;
    // it should not trigger the concurrent-agent warning.
    const conversations = [
      makeConversation({ id: "conv-1", status: "awaiting" }),
      makeConversation({ id: "conv-2", status: "waiting_for_input" }),
    ];

    expect(findBusyOtherConversations(conversations, "conv-1")).toEqual([]);
  });
});
