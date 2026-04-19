import { describe, it, expect, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptEntry } from "@/lib/transcript";
import type { ConversationBackendEvent } from "@/lib/agent-backends/conversation";
import {
  createExternalTurnHandler,
  type ExternalTurnHandlerDeps,
  type ExternalTurnHandlerIdentity,
} from "./external-turn-handler";

function makeIdentity(
  overrides: Partial<ExternalTurnHandlerIdentity> = {},
): ExternalTurnHandlerIdentity {
  return {
    projectPath: "/projects/repo",
    projectName: "repo",
    sessionName: "test",
    conversationId: "conv-ext-1",
    ...overrides,
  };
}

function makeDeps(): {
  deps: ExternalTurnHandlerDeps;
  transcriptWrites: Array<{ conversationId: string; entry: TranscriptEntry }>;
} {
  const transcriptWrites: Array<{
    conversationId: string;
    entry: TranscriptEntry;
  }> = [];
  return {
    transcriptWrites,
    deps: {
      safeAppendTranscriptEntry: vi.fn(
        async (conversationId: string, entry: TranscriptEntry) => {
          transcriptWrites.push({ conversationId, entry });
        },
      ),
    },
  };
}

describe("createExternalTurnHandler", () => {
  it("sends EXTERNAL_TURN_STARTED to machine on external_turn_started", () => {
    const sendToMachine = vi.fn();
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      deps,
    );

    handler({ type: "external_turn_started" });

    expect(sendToMachine).toHaveBeenCalledWith({
      type: "EXTERNAL_TURN_STARTED",
    });
  });

  it("writes transcript entries for assistant provider_events", async () => {
    const sendToMachine = vi.fn();
    const { deps, transcriptWrites } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity({ conversationId: "conv-x" }),
      { sendToMachine },
      deps,
    );

    handler({ type: "external_turn_started" });

    const assistantMsg = {
      type: "assistant",
      session_id: "sess-1",
      uuid: "u1",
      message: {
        content: [{ type: "text", text: "External turn response" }],
      },
    } as unknown as SDKMessage;

    handler({ type: "provider_event", payload: assistantMsg });

    // processMessage inside the handler is async; wait a tick
    await new Promise((r) => setTimeout(r, 10));

    const assistantEntry = transcriptWrites.find(
      (w) => w.entry.type === "assistant",
    );
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry!.conversationId).toBe("conv-x");
  });

  it("sends EXTERNAL_TURN_COMPLETED to machine with a PromptActorResult", async () => {
    const sendToMachine = vi.fn();
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      deps,
    );

    handler({ type: "external_turn_started" });

    // Feed an assistant block so contentBlocks is populated
    handler({
      type: "provider_event",
      payload: {
        type: "assistant",
        session_id: "sess-1",
        uuid: "u1",
        message: {
          content: [{ type: "text", text: "Hello from external turn" }],
        },
      } as unknown as SDKMessage,
    });

    await new Promise((r) => setTimeout(r, 10));

    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", sessionId: "sess-1" },
        costUsd: 0.1,
        durationMs: 500,
        numTurns: 2,
        contextTokens: 1000,
        contextWindowMax: 200_000,
        contentBlocks: [{ type: "text", text: "Hello from external turn" }],
        aborted: false,
        error: null,
      },
    });

    const completeCall = sendToMachine.mock.calls.find(
      (c) => c[0].type === "EXTERNAL_TURN_COMPLETED",
    );
    expect(completeCall).toBeDefined();
    const event = completeCall![0];
    expect(event.result.costUsd).toBe(0.1);
    expect(event.result.durationMs).toBe(500);
    expect(event.result.numTurns).toBe(2);
    expect(event.result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sess-1",
    });
    expect(event.result.error).toBeNull();
    expect(event.result.aborted).toBe(false);
    // Result should carry the accumulated content blocks
    expect(event.result.contentBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it("resets content accumulator between consecutive virtual turns", async () => {
    const sendToMachine = vi.fn();
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      deps,
    );

    // Turn 1
    handler({ type: "external_turn_started" });
    handler({
      type: "provider_event",
      payload: {
        type: "assistant",
        session_id: "sess-1",
        uuid: "u1",
        message: { content: [{ type: "text", text: "turn1" }] },
      } as unknown as SDKMessage,
    });
    await new Promise((r) => setTimeout(r, 10));
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", sessionId: "sess-1" },
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [{ type: "text", text: "turn1" }],
        aborted: false,
        error: null,
      },
    });

    // Turn 2
    handler({ type: "external_turn_started" });
    handler({
      type: "provider_event",
      payload: {
        type: "assistant",
        session_id: "sess-1",
        uuid: "u2",
        message: { content: [{ type: "text", text: "turn2" }] },
      } as unknown as SDKMessage,
    });
    await new Promise((r) => setTimeout(r, 10));
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", sessionId: "sess-1" },
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [{ type: "text", text: "turn2" }],
        aborted: false,
        error: null,
      },
    });

    const completes = sendToMachine.mock.calls.filter(
      (c) => c[0].type === "EXTERNAL_TURN_COMPLETED",
    );
    expect(completes.length).toBe(2);
    // Each completion should carry the blocks from its own turn (handler
    // forwards ConversationBackendTurnResult.contentBlocks).
    const turn1Blocks = completes[0]![0].result.contentBlocks;
    const turn2Blocks = completes[1]![0].result.contentBlocks;
    expect(turn1Blocks.some((b: { text?: string }) => b.text === "turn1")).toBe(
      true,
    );
    expect(turn2Blocks.some((b: { text?: string }) => b.text === "turn2")).toBe(
      true,
    );
  });

  it("does not throw when safeAppendTranscriptEntry rejects", async () => {
    const sendToMachine = vi.fn();
    const failingDeps: ExternalTurnHandlerDeps = {
      safeAppendTranscriptEntry: vi
        .fn()
        .mockRejectedValue(new Error("disk full")),
    };
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      failingDeps,
    );

    handler({ type: "external_turn_started" });

    expect(() => {
      handler({
        type: "provider_event",
        payload: {
          type: "assistant",
          session_id: "sess-1",
          uuid: "u1",
          message: { content: [{ type: "text", text: "hi" }] },
        } as unknown as SDKMessage,
      });
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
  });

  it("ignores content and backend_init events (not part of external turn protocol)", () => {
    const sendToMachine = vi.fn();
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      deps,
    );

    const contentEvent: ConversationBackendEvent = {
      type: "content",
      block: { type: "text", text: "unexpected" },
    };
    handler(contentEvent);

    const backendInit: ConversationBackendEvent = {
      type: "backend_init",
      backendRef: { backend: "claude", sessionId: "s" },
    };
    handler(backendInit);

    expect(sendToMachine).not.toHaveBeenCalled();
  });
});
