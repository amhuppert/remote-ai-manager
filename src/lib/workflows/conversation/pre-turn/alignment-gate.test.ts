import { describe, it, expect, vi } from "vitest";
import { ALIGN_SUGGESTION_INSTRUCTIONS } from "@/lib/session-alignment/render";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import {
  isAlignmentEligibleTurn,
  resolveAlignmentGateForReusedRuntime,
  resolveAlignmentInstructionForNewRuntime,
  recordSeenAlignmentVersion,
} from "./alignment-gate";

describe("isAlignmentEligibleTurn", () => {
  it("is eligible only for attended normal-session turns", () => {
    expect(
      isAlignmentEligibleTurn({
        creationMode: "normal",
        isProjectConversation: false,
        autonomous: false,
      }),
    ).toBe(true);
  });

  it("is ineligible for optimistic sessions", () => {
    expect(
      isAlignmentEligibleTurn({
        creationMode: "optimistic",
        isProjectConversation: false,
        autonomous: false,
      }),
    ).toBe(false);
  });

  it("is ineligible for project conversations", () => {
    expect(
      isAlignmentEligibleTurn({
        creationMode: "normal",
        isProjectConversation: true,
        autonomous: false,
      }),
    ).toBe(false);
  });

  it("is ineligible for autonomous turns", () => {
    expect(
      isAlignmentEligibleTurn({
        creationMode: "normal",
        isProjectConversation: false,
        autonomous: true,
      }),
    ).toBe(false);
  });

  it("is ineligible when the session is unknown", () => {
    expect(
      isAlignmentEligibleTurn({
        creationMode: undefined,
        isProjectConversation: false,
        autonomous: false,
      }),
    ).toBe(false);
  });
});

describe("resolveAlignmentGateForReusedRuntime", () => {
  const identity = {
    projectPath: "/p",
    sessionName: "s",
    isProjectConversation: false,
    autonomous: false,
  };

  it("reads the active version for an eligible turn", async () => {
    const getActiveAlignmentVersion = vi.fn(async () => 7);
    const gate = await resolveAlignmentGateForReusedRuntime(
      { getActiveAlignmentVersion },
      { ...identity, creationMode: "normal" },
    );
    expect(gate).toEqual({ eligible: true, desiredAlignmentVersion: 7 });
    expect(getActiveAlignmentVersion).toHaveBeenCalledWith("/p", "s");
  });

  it("skips the version read entirely for an ineligible turn", async () => {
    const getActiveAlignmentVersion = vi.fn(async () => 7);
    const gate = await resolveAlignmentGateForReusedRuntime(
      { getActiveAlignmentVersion },
      { ...identity, creationMode: "normal", autonomous: true },
    );
    expect(gate).toEqual({ eligible: false, desiredAlignmentVersion: null });
    expect(getActiveAlignmentVersion).not.toHaveBeenCalled();
  });
});

describe("resolveAlignmentInstructionForNewRuntime", () => {
  const identity = {
    projectPath: "/p",
    sessionName: "s",
    creationMode: "normal" as const,
    isProjectConversation: false,
    autonomous: false,
  };

  it("bakes the governing charter section and version when a charter is active", async () => {
    const deps = {
      getActiveAlignmentInjection: vi.fn(async () => ({
        version: 3,
        contentHash: "hash-3",
        text: "## Charter\ngoverning text",
      })),
    };
    const result = await resolveAlignmentInstructionForNewRuntime(
      deps,
      identity,
    );
    expect(result).toEqual({
      eligible: true,
      activeAlignmentVersion: 3,
      alignmentInstruction: "## Charter\ngoverning text",
    });
  });

  it("suggests /align when an eligible session has no active charter", async () => {
    const deps = { getActiveAlignmentInjection: vi.fn(async () => null) };
    const result = await resolveAlignmentInstructionForNewRuntime(
      deps,
      identity,
    );
    expect(result).toEqual({
      eligible: true,
      activeAlignmentVersion: null,
      alignmentInstruction: ALIGN_SUGGESTION_INSTRUCTIONS,
    });
  });

  it("injects nothing for an ineligible turn and never reads the charter", async () => {
    const deps = { getActiveAlignmentInjection: vi.fn(async () => null) };
    const result = await resolveAlignmentInstructionForNewRuntime(deps, {
      ...identity,
      isProjectConversation: true,
    });
    expect(result).toEqual({
      eligible: false,
      activeAlignmentVersion: null,
      alignmentInstruction: null,
    });
    expect(deps.getActiveAlignmentInjection).not.toHaveBeenCalled();
  });
});

describe("recordSeenAlignmentVersion", () => {
  it("persists the seen version on the conversation (R8.4)", async () => {
    const conversation = conversationStateSchema.parse({
      id: "conv-1",
      transcriptPath: null,
      status: "idle",
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    });
    const deps = {
      mutateConversation: vi.fn(
        async (
          _p: string,
          _s: string,
          _c: string,
          _label: string,
          mutate: (c: ConversationState) => void,
        ) => {
          mutate(conversation);
        },
      ),
    };
    await recordSeenAlignmentVersion(deps, {
      projectPath: "/p",
      sessionName: "s",
      conversationId: "conv-1",
      seenAlignmentVersion: 5,
    });
    expect(conversation.lastSeenAlignmentVersion).toBe(5);
    expect(deps.mutateConversation).toHaveBeenCalledWith(
      "/p",
      "s",
      "conv-1",
      "prompt.recordSeenAlignmentVersion",
      expect.any(Function),
    );
  });
});
