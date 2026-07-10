import { describe, it, expect, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
    projectPath: "/projects/repo",
    projectName: "repo",
    sessionName: "test",
    conversationId: "conv-ext-1",
    worktreePath: "/projects/repo/.worktrees/test",
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
        compacted: false,
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
        compacted: false,
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
        compacted: false,
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

  it("invokes applyCapabilityWhenIdle on external_turn_completed for the conversation", async () => {
    const sendToMachine = vi.fn();
    const applyCapabilityWhenIdle = vi.fn(async () => {});
    const { deps } = makeDeps({ applyCapabilityWhenIdle });
    const handler = createExternalTurnHandler(
      makeIdentity({
        projectPath: "/projects/repo",
        projectName: "repo",
        sessionName: "test",
        conversationId: "conv-idle",
        worktreePath: "/projects/repo/.worktrees/test",
      }),
      { sendToMachine },
      deps,
    );

    handler({ type: "external_turn_started" });
    handler({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", sessionId: "sess-1" },
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [{ type: "text", text: "hi" }],
        aborted: false,
        compacted: false,
        error: null,
      },
    });

    // applyCapabilityWhenIdle is dispatched asynchronously after the
    // completion event is forwarded to the machine; let microtasks run.
    await new Promise((r) => setTimeout(r, 10));

    expect(applyCapabilityWhenIdle).toHaveBeenCalledTimes(1);
    expect(applyCapabilityWhenIdle).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "test",
      conversationId: "conv-idle",
      worktreePath: "/projects/repo/.worktrees/test",
      backend: "claude",
    });
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
          backendRef: { backend: "claude", sessionId: "sess-1" },
          costUsd: 0,
          durationMs: 0,
          numTurns: 1,
          contextTokens: null,
          contextWindowMax: null,
          contentBlocks: [],
          aborted: false,
          compacted: false,
          error: null,
        },
      });
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
    expect(applyCapabilityWhenIdle).toHaveBeenCalledTimes(1);
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

  describe("wake marker notice", () => {
    function assistantMsg(uuid: string, text: string): SDKMessage {
      return {
        type: "assistant",
        session_id: "sess-1",
        uuid,
        message: { content: [{ type: "text", text }] },
      } as unknown as SDKMessage;
    }

    function taskNotification(taskId: string, summary?: string): SDKMessage {
      return {
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status: "completed",
        output_file: "/tmp/out.txt",
        ...(summary ? { summary } : {}),
        session_id: "sess-1",
        uuid: `u-notify-${taskId}`,
      } as unknown as SDKMessage;
    }

    it("appends a wake-marker notice before the external turn's first assistant entry", async () => {
      const { deps, transcriptWrites } = makeDeps();
      const handler = createExternalTurnHandler(
        makeIdentity(),
        { sendToMachine: vi.fn() },
        deps,
      );

      handler({ type: "external_turn_started" });
      handler({ type: "provider_event", payload: assistantMsg("u1", "woke") });
      await new Promise((r) => setTimeout(r, 10));

      const roles = transcriptWrites.map((w) => w.entry.role);
      const noticeIdx = roles.indexOf("notice");
      const assistantIdx = roles.indexOf("assistant");
      expect(noticeIdx).not.toBe(-1);
      expect(assistantIdx).not.toBe(-1);
      expect(noticeIdx).toBeLessThan(assistantIdx);
      const noticeText = (
        transcriptWrites[noticeIdx]!.entry.content![0] as {
          type: "text";
          text: string;
        }
      ).text;
      expect(noticeText).toMatch(/continued autonomously/i);
    });

    it("appends the marker once per external turn even across multiple assistant messages", async () => {
      const { deps, transcriptWrites } = makeDeps();
      const handler = createExternalTurnHandler(
        makeIdentity(),
        { sendToMachine: vi.fn() },
        deps,
      );

      handler({ type: "external_turn_started" });
      handler({ type: "provider_event", payload: assistantMsg("u1", "one") });
      handler({ type: "provider_event", payload: assistantMsg("u2", "two") });
      await new Promise((r) => setTimeout(r, 10));

      expect(
        transcriptWrites.filter((w) => w.entry.role === "notice"),
      ).toHaveLength(1);
    });

    it("appends no marker for an external turn with no assistant output (notification-only noise)", async () => {
      const { deps, transcriptWrites } = makeDeps();
      const handler = createExternalTurnHandler(
        makeIdentity(),
        { sendToMachine: vi.fn() },
        deps,
      );

      handler({ type: "external_turn_started" });
      handler({
        type: "provider_event",
        payload: taskNotification("task-a"),
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(
        transcriptWrites.filter((w) => w.entry.role === "notice"),
      ).toHaveLength(0);
    });

    it("includes the settled task's summary when a task_notification preceded the assistant output", async () => {
      const { deps, transcriptWrites } = makeDeps();
      const handler = createExternalTurnHandler(
        makeIdentity(),
        { sendToMachine: vi.fn() },
        deps,
      );

      handler({ type: "external_turn_started" });
      handler({
        type: "provider_event",
        payload: taskNotification("task-a", "full suite finished"),
      });
      handler({ type: "provider_event", payload: assistantMsg("u1", "done") });
      await new Promise((r) => setTimeout(r, 10));

      const notice = transcriptWrites.find((w) => w.entry.role === "notice");
      expect(notice).toBeDefined();
      const text = (notice!.entry.content![0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("full suite finished");
    });

    it("re-arms the marker for each new external turn", async () => {
      const { deps, transcriptWrites } = makeDeps();
      const handler = createExternalTurnHandler(
        makeIdentity(),
        { sendToMachine: vi.fn() },
        deps,
      );

      for (const uuid of ["u1", "u2"]) {
        handler({ type: "external_turn_started" });
        handler({
          type: "provider_event",
          payload: assistantMsg(uuid, "turn"),
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
            contentBlocks: [],
            aborted: false,
            compacted: false,
            error: null,
          },
        });
      }

      expect(
        transcriptWrites.filter((w) => w.entry.role === "notice"),
      ).toHaveLength(2);
    });
  });
});
