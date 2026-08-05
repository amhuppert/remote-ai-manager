import { describe, it, expect } from "vitest";
import {
  findBusyOtherConversations,
  deriveSessionStatusFromParts,
  deriveSessionPromptCountFromConvs,
  deriveSessionLastActivityFromConvs,
  isReservedSessionName,
} from "./derived";
import type { ConversationState } from "@/lib/conversations/schemas";
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
    scope: "session",
    nameOrigin: "default",
    role: null,
    activeTurnSource: null,
    name: null,
    summary: null,
    transcriptPath: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalTurns: 0,
    source: "cc",
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    archived: false,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    pendingQueue: [],
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

describe("deriveSessionStatusFromParts", () => {
  it("returns idle when finished, regardless of conversation statuses", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: true,
        convStatuses: ["running", "waiting_for_input", "awaiting", "new"],
        collabContribution: "running",
      }),
    ).toBe("idle");
  });

  it("returns waiting_for_input when collab is paused with no waiting conv", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: ["running"],
        collabContribution: "paused",
      }),
    ).toBe("waiting_for_input");
  });

  it("returns waiting_for_input when a conv is waiting and no collab", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: ["awaiting", "waiting_for_input"],
        collabContribution: null,
      }),
    ).toBe("waiting_for_input");
  });

  it("returns running when collab is running and no running conv", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: ["awaiting"],
        collabContribution: "running",
      }),
    ).toBe("running");
  });

  it("returns running when a conv is running and no collab", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: ["awaiting", "running"],
        collabContribution: null,
      }),
    ).toBe("running");
  });

  it("returns idle when convStatuses is empty and collab is null", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: [],
        collabContribution: null,
      }),
    ).toBe("idle");
  });

  it("returns awaiting when a conv is awaiting (no running/waiting)", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: ["awaiting"],
        collabContribution: null,
      }),
    ).toBe("awaiting");
  });

  it("returns new when a conv is new (no running/waiting/awaiting)", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: ["new"],
        collabContribution: null,
      }),
    ).toBe("new");
  });

  it("returns running when mixing running and awaiting (running wins)", () => {
    expect(
      deriveSessionStatusFromParts({
        finished: false,
        convStatuses: ["running", "awaiting"],
        collabContribution: null,
      }),
    ).toBe("running");
  });
});

describe("deriveSessionPromptCountFromConvs", () => {
  it("returns 0 for empty array", () => {
    expect(deriveSessionPromptCountFromConvs([])).toBe(0);
  });

  it("returns the single conv's promptCount", () => {
    expect(deriveSessionPromptCountFromConvs([{ promptCount: 5 }])).toBe(5);
  });

  it("sums promptCount across multiple convs", () => {
    expect(
      deriveSessionPromptCountFromConvs([
        { promptCount: 3 },
        { promptCount: 7 },
        { promptCount: 2 },
      ]),
    ).toBe(12);
  });
});

describe("deriveSessionLastActivityFromConvs", () => {
  it("returns the session timestamp when convs is empty", () => {
    expect(
      deriveSessionLastActivityFromConvs("2024-01-01T00:00:00.000Z", []),
    ).toBe("2024-01-01T00:00:00.000Z");
  });

  it("returns the conv timestamp when the conv is newer than the session", () => {
    expect(
      deriveSessionLastActivityFromConvs("2024-01-01T00:00:00.000Z", [
        { lastActivityAt: "2024-02-01T00:00:00.000Z" },
      ]),
    ).toBe("2024-02-01T00:00:00.000Z");
  });

  it("returns the session timestamp when the session is newer than the conv", () => {
    expect(
      deriveSessionLastActivityFromConvs("2024-03-01T00:00:00.000Z", [
        { lastActivityAt: "2024-02-01T00:00:00.000Z" },
      ]),
    ).toBe("2024-03-01T00:00:00.000Z");
  });

  it("returns the max timestamp across multiple convs", () => {
    expect(
      deriveSessionLastActivityFromConvs("2024-01-01T00:00:00.000Z", [
        { lastActivityAt: "2024-02-15T00:00:00.000Z" },
        { lastActivityAt: "2024-04-10T00:00:00.000Z" },
        { lastActivityAt: "2024-03-05T00:00:00.000Z" },
      ]),
    ).toBe("2024-04-10T00:00:00.000Z");
  });
});

describe("isReservedSessionName", () => {
  it("flags single-underscore-prefixed names as reserved", () => {
    expect(isReservedSessionName("_internal")).toBe(true);
  });

  it("flags the planner session as reserved", () => {
    expect(isReservedSessionName("__planner__")).toBe(true);
  });

  it("does not flag normal user-created session names", () => {
    expect(isReservedSessionName("feature-x")).toBe(false);
    expect(isReservedSessionName("planner")).toBe(false);
    expect(isReservedSessionName("a_b")).toBe(false);
  });
});
