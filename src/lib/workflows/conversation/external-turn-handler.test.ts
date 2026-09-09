import { describe, it, expect, vi } from "vitest";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
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
    conversationId: "conv-ext-1",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExternalTurnHandlerDeps> = {}): {
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
      ...overrides,
    },
  };
}

function frameEnvelope(
  seq: number,
  frame: TranscriptEntry,
): ConversationBackendEvent {
  return {
    type: "transcript_entry",
    entry: { seq, backend: "claude", type: frame.type, raw: frame },
  };
}

describe("createExternalTurnHandler", () => {
  it("sends EXTERNAL_TURN_STARTED to machine on external_turn_started", async () => {
    const sendToMachine = vi.fn();
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      deps,
    );

    handler({ type: "external_turn_started" });
    await new Promise((r) => setTimeout(r, 0));

    expect(sendToMachine).toHaveBeenCalledWith({
      type: "EXTERNAL_TURN_STARTED",
    });
  });

  it("persists transcript_entry frames verbatim, in emission order", async () => {
    const sendToMachine = vi.fn();
    const { deps, transcriptWrites } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity({ conversationId: "conv-x" }),
      { sendToMachine },
      deps,
    );

    const noticeFrame: TranscriptEntry = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "notice",
      role: "notice",
      content: [{ type: "text", text: "Agent continued autonomously." }],
    };
    const assistantFrame: TranscriptEntry = {
      timestamp: "2026-07-12T10:00:00.001Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "External turn response" }],
      uuid: "u1",
    };

    handler({ type: "external_turn_started" });
    handler(frameEnvelope(0, noticeFrame));
    handler(frameEnvelope(1, assistantFrame));

    // Appends are chained but fire-and-forget from the handler's perspective.
    await new Promise((r) => setTimeout(r, 10));

    expect(transcriptWrites).toEqual([
      { conversationId: "conv-x", entry: noticeFrame },
      { conversationId: "conv-x", entry: assistantFrame },
    ]);
  });

  it("exposes an active external turn and an activity epoch synchronously", () => {
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine: vi.fn() },
      deps,
    );
    expect(handler.activeTurn).toBe(false);
    expect(handler.activity).toBe(0);

    handler({ type: "external_turn_started" });
    expect(handler.activeTurn).toBe(true);
    expect(handler.activity).toBe(1);

    handler(frameEnvelope(1, { type: "assistant", uuid: "a1" } as never));
    expect(handler.activity).toBe(2);

    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", ref: "sess-1" },
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        contextTokens: 1,
        contextWindowMax: 1,
        contentBlocks: [],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      },
    });
    expect(handler.activeTurn).toBe(false);
    expect(handler.activity).toBe(3);
  });

  it("settles a promise when the external turn completes or the handler stops, and immediately when none is in flight", async () => {
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine: vi.fn() },
      deps,
    );
    await expect(handler.settled()).resolves.toBeUndefined();

    handler({ type: "external_turn_started" });
    let settled = false;
    void handler.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", ref: "sess-1" },
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        contextTokens: 1,
        contextWindowMax: 1,
        contentBlocks: [],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      },
    });
    await Promise.resolve();
    expect(settled).toBe(true);

    handler({ type: "external_turn_started" });
    const stopped = handler.settled();
    await handler.stopAndDrain();
    await expect(stopped).resolves.toBeUndefined();
    expect(handler.activeTurn).toBe(false);
  });

  it("ignores content and backend_init events (not part of the external turn protocol)", () => {
    const sendToMachine = vi.fn();
    const { deps } = makeDeps();
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      deps,
    );

    handler({
      type: "content",
      block: { type: "text", text: "unexpected" },
    });
    handler({
      type: "backend_init",
      backendRef: { backend: "claude", ref: "s" },
    });

    expect(sendToMachine).not.toHaveBeenCalled();
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
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", ref: "sess-1" },
        costUsd: 0.1,
        durationMs: 500,
        numTurns: 2,
        contextTokens: 1000,
        contextWindowMax: 200_000,
        contentBlocks: [{ type: "text", text: "Hello from external turn" }],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      },
    });
    await new Promise((r) => setTimeout(r, 0));

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
      ref: "sess-1",
    });
    expect(event.result.error).toBeNull();
    expect(event.result.aborted).toBe(false);
    expect(event.result.contentBlocks).toEqual([
      { type: "text", text: "Hello from external turn" },
    ]);
  });

  it("sends EXTERNAL_TURN_COMPLETED and drains capabilities only after pending frame appends settle", async () => {
    const sendToMachine = vi.fn();
    const applyCapabilityWhenIdle = vi.fn(async () => {});
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((r) => {
      releaseAppend = r;
    });
    const appended: TranscriptEntry[] = [];
    const safeAppendTranscriptEntry = vi.fn(
      async (_cid: string, entry: TranscriptEntry) => {
        await appendGate;
        appended.push(entry);
      },
    );
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      { safeAppendTranscriptEntry, applyCapabilityWhenIdle },
    );

    const frame: TranscriptEntry = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "slow frame" }],
      uuid: "u-slow",
    };

    handler({ type: "external_turn_started" });
    handler(frameEnvelope(0, frame));
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", ref: "sess-1" },
        costUsd: 0.1,
        durationMs: 500,
        numTurns: 2,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [{ type: "text", text: "slow frame" }],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(
      sendToMachine.mock.calls.some(
        (c) => c[0].type === "EXTERNAL_TURN_COMPLETED",
      ),
    ).toBe(false);
    expect(applyCapabilityWhenIdle).not.toHaveBeenCalled();

    releaseAppend();
    await new Promise((r) => setTimeout(r, 10));

    expect(appended).toEqual([frame]);
    expect(
      sendToMachine.mock.calls.some(
        (c) => c[0].type === "EXTERNAL_TURN_COMPLETED",
      ),
    ).toBe(true);
    expect(applyCapabilityWhenIdle).toHaveBeenCalledTimes(1);
  });

  it("does not let a following turn's EXTERNAL_TURN_STARTED overtake a completion waiting on appends", async () => {
    const sendToMachine = vi.fn();
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((r) => {
      releaseAppend = r;
    });
    const safeAppendTranscriptEntry = vi.fn(async () => {
      await appendGate;
    });
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      { safeAppendTranscriptEntry },
    );

    const frame: TranscriptEntry = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "turn one" }],
      uuid: "u1",
    };

    handler({ type: "external_turn_started" });
    handler(frameEnvelope(0, frame));
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", ref: "sess-1" },
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      },
    });
    handler({ type: "external_turn_started" });

    releaseAppend();
    await new Promise((r) => setTimeout(r, 10));

    const machineEventTypes = sendToMachine.mock.calls.map(
      (c) => c[0].type as string,
    );
    expect(machineEventTypes).toEqual([
      "EXTERNAL_TURN_STARTED",
      "EXTERNAL_TURN_COMPLETED",
      "EXTERNAL_TURN_STARTED",
    ]);
  });

  it("does not throw when safeAppendTranscriptEntry rejects, and keeps appending later frames", async () => {
    const sendToMachine = vi.fn();
    const appended: TranscriptEntry[] = [];
    const safeAppendTranscriptEntry = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async (_cid: string, entry: TranscriptEntry) => {
        appended.push(entry);
      });
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      { safeAppendTranscriptEntry },
    );

    const frame: TranscriptEntry = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    };

    expect(() => {
      handler(frameEnvelope(0, frame));
      handler(frameEnvelope(1, frame));
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
    expect(safeAppendTranscriptEntry).toHaveBeenCalledTimes(2);
    expect(appended).toHaveLength(1);
  });

  it("invokes applyCapabilityWhenIdle on external_turn_completed", async () => {
    const sendToMachine = vi.fn();
    const applyCapabilityWhenIdle = vi.fn(async () => {});
    const { deps } = makeDeps({ applyCapabilityWhenIdle });
    const handler = createExternalTurnHandler(
      makeIdentity({ conversationId: "conv-idle" }),
      { sendToMachine },
      deps,
    );

    handler({ type: "external_turn_started" });
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", ref: "sess-1" },
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [{ type: "text", text: "hi" }],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(applyCapabilityWhenIdle).toHaveBeenCalledTimes(1);
  });

  it("does not throw when applyCapabilityWhenIdle rejects", async () => {
    const sendToMachine = vi.fn();
    const applyCapabilityWhenIdle = vi
      .fn()
      .mockRejectedValue(new Error("apply boom"));
    const { deps } = makeDeps({ applyCapabilityWhenIdle });
    const handler = createExternalTurnHandler(
      makeIdentity(),
      { sendToMachine },
      deps,
    );

    handler({ type: "external_turn_started" });

    expect(() => {
      handler({
        type: "external_turn_completed",
        result: {
          backendRef: { backend: "claude", ref: "sess-1" },
          costUsd: 0,
          durationMs: 0,
          numTurns: 1,
          contextTokens: null,
          contextWindowMax: null,
          contentBlocks: [],
          aborted: false,
          compacted: false,
          failure: null,
          continuationDisposition: "retain",
        },
      });
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
    expect(applyCapabilityWhenIdle).toHaveBeenCalledTimes(1);
  });
});
