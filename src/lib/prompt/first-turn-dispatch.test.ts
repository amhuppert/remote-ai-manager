import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createFirstTurnDispatcher,
  type FirstTurnDispatcherDeps,
} from "./first-turn-dispatch";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import type { SpawnAgent } from "@/lib/chat-spawning/schemas";

const CONVERSATION_ID = "conv-1";

function makeSession(): SessionState {
  return sessionStateSchema.parse({
    sessionName: "spawned",
    worktreePath: "/wt/spawned",
    branchName: "csm/spawned",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    conversations: [
      {
        id: CONVERSATION_ID,
        scope: "session",
        name: "spawned 1",
        transcriptPath: null,
        status: "new",
        promptCount: 0,
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
        forkedFrom: null,
        role: null,
        activeTurnSource: null,
        contextTokens: null,
        contextWindowMax: null,
        debugMode: null,
        machineSnapshot: null,
        agentBackend: "claude",
        backendRef: null,
        unread: false,
      },
    ],
  });
}

function makeDeps(
  overrides: Partial<FirstTurnDispatcherDeps> = {},
): FirstTurnDispatcherDeps {
  return {
    executePromptStream: vi.fn().mockResolvedValue({
      conversationId: CONVERSATION_ID,
      contextTokens: null,
      contextWindowMax: null,
    }),
    startDualRace: vi.fn().mockResolvedValue(undefined),
    isConversationBusy: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function input(agent: SpawnAgent, initialPrompt: string | null) {
  return {
    projectPath: "/repo",
    projectName: "repo",
    session: makeSession(),
    initialPrompt,
    agent,
  };
}

describe("createFirstTurnDispatcher", () => {
  let deps: FirstTurnDispatcherDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("is a no-op when initialPrompt is null (session stays idle)", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const result = await dispatchFirstTurn(input("claude", null));
    expect(result).toEqual({ dispatched: false });
    expect(deps.executePromptStream).not.toHaveBeenCalled();
    expect(deps.startDualRace).not.toHaveBeenCalled();
  });

  it("dispatches a single claude first turn on the chosen backend", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const result = await dispatchFirstTurn(input("claude", "do the thing"));
    expect(result).toEqual({ dispatched: true });
    expect(deps.executePromptStream).toHaveBeenCalledTimes(1);
    const call = (deps.executePromptStream as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(call[0]).toBe("/repo"); // projectPath
    expect(call[2]).toBe("do the thing"); // promptText
    expect(call[4]).toBe(CONVERSATION_ID); // conversationId
    expect(call[7]).toEqual({ backend: "claude" }); // options
  });

  it("dispatches a codex first turn on the codex backend", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    await dispatchFirstTurn(input("codex", "do the thing"));
    const call = (deps.executePromptStream as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(call[7]).toEqual({ backend: "codex" });
    expect(deps.startDualRace).not.toHaveBeenCalled();
  });

  it("threads the proposed model + reasoning effort into the first turn", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    await dispatchFirstTurn({
      ...input("codex", "do the thing"),
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    const call = (deps.executePromptStream as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(call[5]).toBe("gpt-5.4"); // modelId
    expect(call[7]).toEqual({ backend: "codex", effort: "high" }); // options
  });

  it("delivers ordered image payloads with the first turn", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    await dispatchFirstTurn({
      ...input("claude", "Use these images"),
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "one",
        },
        {
          attachmentId: "second",
          mediaType: "image/jpeg",
          base64Data: "two",
        },
      ],
    });
    const call = (deps.executePromptStream as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(call[6]).toEqual([
      {
        attachmentId: "first",
        mediaType: "image/png",
        base64Data: "one",
      },
      {
        attachmentId: "second",
        mediaType: "image/jpeg",
        base64Data: "two",
      },
    ]);
  });

  it("omits the effort option when no reasoning effort is supplied", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    await dispatchFirstTurn({ ...input("claude", "go"), model: "opus" });
    const call = (deps.executePromptStream as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(call[5]).toBe("opus");
    expect(call[7]).toEqual({ backend: "claude" }); // no effort key
  });

  it("delivers a single turn for two concurrent dispatches (exactly once)", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const shared = input("claude", "do the thing");
    const [a, b] = await Promise.all([
      dispatchFirstTurn(shared),
      dispatchFirstTurn(shared),
    ]);
    expect(deps.executePromptStream).toHaveBeenCalledTimes(1);
    // Exactly one of the two reports a dispatch.
    expect([a.dispatched, b.dispatched].filter(Boolean)).toHaveLength(1);
  });

  it("does not dispatch twice for the same session across sequential calls", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const shared = input("claude", "do the thing");
    const first = await dispatchFirstTurn(shared);
    const second = await dispatchFirstTurn(shared);
    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(deps.executePromptStream).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when the conversation is already busy", async () => {
    deps = makeDeps({ isConversationBusy: vi.fn().mockReturnValue(true) });
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const result = await dispatchFirstTurn(input("claude", "do the thing"));
    expect(result).toEqual({ dispatched: false });
    expect(deps.executePromptStream).not.toHaveBeenCalled();
  });

  it("seeds a dual race exactly once with its brief and ordered images", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const result = await dispatchFirstTurn({
      ...input("dual", "shared brief"),
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "one",
        },
        {
          attachmentId: "second",
          mediaType: "image/jpeg",
          base64Data: "two",
        },
      ],
    });
    expect(result).toEqual({ dispatched: true });
    expect(deps.startDualRace).toHaveBeenCalledTimes(1);
    const call = (deps.startDualRace as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.brief).toBe("shared brief");
    expect(call.conversationId).toBe(CONVERSATION_ID);
    expect(call.images).toEqual([
      {
        attachmentId: "first",
        mediaType: "image/png",
        base64Data: "one",
      },
      {
        attachmentId: "second",
        mediaType: "image/jpeg",
        base64Data: "two",
      },
    ]);
    expect(deps.executePromptStream).not.toHaveBeenCalled();
  });

  it("gives an image-only dual race a stable nonempty brief", async () => {
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const result = await dispatchFirstTurn({
      ...input("dual", ""),
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "one",
        },
      ],
    });

    expect(result).toEqual({ dispatched: true });
    expect(deps.startDualRace).toHaveBeenCalledWith(
      expect.objectContaining({ brief: "Attached image." }),
    );
  });

  it("logs and drops on dispatch error without throwing or re-dispatching", async () => {
    deps = makeDeps({
      executePromptStream: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const { dispatchFirstTurn } = createFirstTurnDispatcher(deps);
    const shared = input("claude", "do the thing");

    const result = await dispatchFirstTurn(shared);
    expect(result).toEqual({ dispatched: false });

    // No retry storm: a follow-up dispatch does not re-attempt the turn.
    const again = await dispatchFirstTurn(shared);
    expect(again).toEqual({ dispatched: false });
    expect(deps.executePromptStream).toHaveBeenCalledTimes(1);
  });
});
