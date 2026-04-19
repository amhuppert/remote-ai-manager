import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("@/lib/sdk-env", () => ({}));

import { claudeConversationBackendFactory } from "./conversation-runtime";
import type { ConversationBackendEvent } from "../conversation";

function createControllableMockQuery() {
  const messages: SDKMessage[] = [];
  let resolveNext: ((value: IteratorResult<SDKMessage, void>) => void) | null =
    null;
  let done = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generator: any = {
    close: vi.fn(() => {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    }),
    streamInput: vi.fn(),
    interrupt: vi.fn(),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    setMcpServers: vi
      .fn()
      .mockResolvedValue({ added: [], removed: [], errors: {} }),
    next() {
      if (messages.length > 0) {
        return Promise.resolve({
          value: messages.shift()!,
          done: false,
        } as IteratorResult<SDKMessage, void>);
      }
      if (done) {
        return Promise.resolve({
          value: undefined,
          done: true,
        } as IteratorResult<SDKMessage, void>);
      }
      return new Promise<IteratorResult<SDKMessage, void>>((resolve) => {
        resolveNext = resolve;
      });
    },
    return() {
      done = true;
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: Error) {
      done = true;
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return {
    query: generator,
    pushMessage(msg: SDKMessage) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: msg, done: false });
      } else {
        messages.push(msg);
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ClaudeConversationRuntime — external turn events", () => {
  it("emits external_turn_started, provider_events, and external_turn_completed for a virtual turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalEvents: ConversationBackendEvent[] = [];

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-ext-1",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      onExternalTurnEvent: (event: ConversationBackendEvent) => {
        externalEvents.push(event);
      },
    });

    // Run one caller-initiated turn so the session is past first-prompt state
    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      images: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);

    await turnPromise;

    // Now simulate an auto-continuation turn
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<task-notification>done</task-notification>",
          },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u3",
      message: {
        content: [{ type: "text", text: "External response" }],
      },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u4",
      total_cost_usd: 0.12,
      duration_ms: 500,
      num_turns: 2,
      result: "External response",
      is_error: false,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));

    const startedIdx = externalEvents.findIndex(
      (e) => e.type === "external_turn_started",
    );
    const completedIdx = externalEvents.findIndex(
      (e) => e.type === "external_turn_completed",
    );
    const providerEvents = externalEvents.filter(
      (e) => e.type === "provider_event",
    );

    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(startedIdx);
    expect(providerEvents.length).toBeGreaterThanOrEqual(3);

    const completedEvent = externalEvents[completedIdx]!;
    if (completedEvent.type !== "external_turn_completed") {
      throw new Error("expected external_turn_completed");
    }
    expect(completedEvent.result.costUsd).toBe(0.12);
    expect(completedEvent.result.durationMs).toBe(500);
    expect(completedEvent.result.numTurns).toBe(2);
    expect(completedEvent.result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sess-1",
    });

    runtime.close();
  });

  it("emits external_turn_started only once per virtual turn (resets between virtual turns)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalEvents: ConversationBackendEvent[] = [];

    const runtime = await claudeConversationBackendFactory.createRuntime({
      conversationId: "conv-ext-2",
      projectPath: "/project",
      projectName: "proj",
      sessionName: "sess",
      worktreePath: "/project/.worktrees/sess",
      persistedRef: null,
      sessionInstructions: [],
      tooling: {},
      onExternalTurnEvent: (event: ConversationBackendEvent) => {
        externalEvents.push(event);
      },
    });

    const turnPromise = runtime.sendTurn({
      promptText: "hello",
      images: [],
      sessionInstructions: [],
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;

    // Virtual turn #1
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "v1-user",
      message: {
        role: "user",
        content: [{ type: "text", text: "first notif" }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "v1-result",
      total_cost_usd: 0.01,
      duration_ms: 10,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 10));

    // Virtual turn #2
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "v2-user",
      message: {
        role: "user",
        content: [{ type: "text", text: "second notif" }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "v2-result",
      total_cost_usd: 0.02,
      duration_ms: 20,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 10));

    const startedCount = externalEvents.filter(
      (e) => e.type === "external_turn_started",
    ).length;
    const completedCount = externalEvents.filter(
      (e) => e.type === "external_turn_completed",
    ).length;

    expect(startedCount).toBe(2);
    expect(completedCount).toBe(2);

    runtime.close();
  });
});
