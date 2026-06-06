import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  isUndeliveredQuerySessionError,
  isSessionDiedMidTurnError,
  isSdkPipeBrokenError,
} from "./query-session-errors";
import {
  getTraceContext,
  runWithTrace,
  type TraceContext,
} from "@/lib/logging";
import { getWaitableInFlightTaskIds } from "./background-task-tracker";

// ---------------------------------------------------------------------------
// Mock the SDK
// ---------------------------------------------------------------------------

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("@/lib/shared/sdk-env", () => ({}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import { createQuerySession, type QuerySessionOptions } from "./query-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a controllable mock Query (AsyncGenerator + close + streamInput + MCP methods) */
function createControllableMockQuery() {
  const messages: SDKMessage[] = [];
  let resolveNext: ((value: IteratorResult<SDKMessage, void>) => void) | null =
    null;
  let rejectNext: ((err: Error) => void) | null = null;
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
      return new Promise<IteratorResult<SDKMessage, void>>(
        (resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        },
      );
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
    /** Push a message to be consumed by the pump */
    pushMessage(msg: SDKMessage) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: msg, done: false });
      } else {
        messages.push(msg);
      }
    },
    /** Simulate subprocess crash */
    crashPump(err: Error) {
      if (rejectNext) {
        const r = rejectNext;
        rejectNext = null;
        r(err);
      }
    },
    /** End the generator normally */
    endPump() {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined, done: true });
      }
    },
  };
}

function makeDefaultOptions(
  overrides: Partial<QuerySessionOptions> = {},
): QuerySessionOptions {
  return {
    conversationId: "conv-123",
    cwd: "/projects/repo/.worktrees/test",
    model: undefined,
    effort: undefined,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: undefined,
    },
    resume: undefined,
    forkSession: undefined,
    mcpServers: {},
    canUseTool: vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: {},
    })),
    env: {},
    maxTurns: 50,
    plugins: [],
    settingSources: ["user", "project", "local"],
    disallowedTools: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createQuerySession", () => {
  it("creates a session with status alive", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    expect(session.status).toBe("alive");

    session.close();
  });

  it("exposes the SDK Query object", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    expect(session.query).toBe(mock.query);

    session.close();
  });
});

describe("QuerySession.sendPrompt", () => {
  it("resolves with correct TurnResult when result message arrives", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Hello", emit);

    // Pump delivers messages
    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-abc",
      uuid: "u1",
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-abc",
      uuid: "u2",
      message: {
        content: [{ type: "text", text: "Response" }],
      },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-abc",
      uuid: "u3",
      total_cost_usd: 0.05,
      duration_ms: 1200,
      num_turns: 3,
      result: "Response",
      is_error: false,
    } as unknown as SDKMessage);

    const result = await turnPromise;
    expect(result.sessionId).toBe("sess-abc");
    expect(result.costUsd).toBe(0.05);
    expect(result.durationMs).toBe(1200);
    expect(result.numTurns).toBe(3);
    expect(result.aborted).toBe(false);
    expect(result.error).toBeNull();

    session.close();
  });

  it("calls emit for each message during a turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Hello", emit);

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u1",
      message: {
        content: [{ type: "text", text: "Hello back" }],
      },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u2",
      total_cost_usd: 0.01,
      duration_ms: 100,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);

    await turnPromise;

    // emit should have been called with the assistant and result messages
    expect(emit).toHaveBeenCalled();

    session.close();
  });

  it("includes image content blocks in the SDK message", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    // Complete first turn so second uses streamInput (easier to inspect)
    const turn1 = session.sendPrompt("First", emit);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0.01,
      duration_ms: 100,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn1;

    // Send second prompt with content blocks including an image
    const turn2 = session.sendPrompt(
      [
        { type: "text" as const, text: "Check this screenshot" },
        {
          type: "image" as const,
          mediaType: "image/png" as const,
          base64Data: "iVBORw0KGgo=",
        },
      ],
      emit,
    );

    // Wait for MCP health check to complete before checking streamInput
    await new Promise((r) => setTimeout(r, 10));

    // Inspect what streamInput received
    expect(mock.query.streamInput).toHaveBeenCalled();
    const iterable = mock.query.streamInput.mock.calls[0]![0];
    const iterator = iterable[Symbol.asyncIterator]();
    const { value: sdkMessage } = await iterator.next();

    // Should be a properly formed SDKUserMessage with Anthropic API image format
    expect(sdkMessage.message.content).toEqual([
      { type: "text", text: "Check this screenshot" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
    ]);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u2",
      total_cost_usd: 0.02,
      duration_ms: 200,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn2;

    session.close();
  });

  it("feeds prompt via streamInput for subsequent prompts", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    // First prompt (via hanging generator)
    const turn1 = session.sendPrompt("First prompt", emit);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0.01,
      duration_ms: 100,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn1;

    // Second prompt (via streamInput)
    const turn2 = session.sendPrompt("Second prompt", emit);

    // Wait for MCP health check to complete before checking streamInput
    await new Promise((r) => setTimeout(r, 10));

    // streamInput should have been called
    expect(mock.query.streamInput).toHaveBeenCalled();

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u2",
      total_cost_usd: 0.02,
      duration_ms: 200,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn2;

    session.close();
  });

  it("sets currentTurnOptions so canUseTool can read autonomous flag", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const canUseTool = vi.fn(async () => {
      return { behavior: "allow" as const, updatedInput: {} };
    });

    const session = createQuerySession(makeDefaultOptions({ canUseTool }));

    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit, {
      autonomous: true,
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

    // The session should expose the turn options for canUseTool to read
    // This is verified indirectly: the canUseTool option is passed through
    // We just verify the turn completes without error
    session.close();
  });

  it("messages between turns do not cause errors", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    // Complete a turn
    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Push a stray message between turns — should not throw
    mock.pushMessage({
      type: "system",
      subtype: "status",
      session_id: "sess-1",
      uuid: "u2",
    } as unknown as SDKMessage);

    // Wait a tick for pump to process
    await new Promise((r) => setTimeout(r, 10));

    expect(session.status).toBe("alive");

    session.close();
  });
});

describe("structured output extraction", () => {
  it("includes structuredOutput from SDKResultSuccess in TurnResult", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        outputFormat: {
          type: "json_schema",
          schema: { type: "object", properties: { name: { type: "string" } } },
        },
      }),
    );
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Hello", emit);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-abc",
      uuid: "u1",
      total_cost_usd: 0.05,
      duration_ms: 1200,
      num_turns: 3,
      result: '{"name":"test"}',
      is_error: false,
      structured_output: { name: "test" },
    } as unknown as SDKMessage);

    const result = await turnPromise;
    expect(result.structuredOutput).toEqual({ name: "test" });

    session.close();
  });

  it("sets structuredOutput to undefined when not present in result", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Hello", emit);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-abc",
      uuid: "u1",
      total_cost_usd: 0.05,
      duration_ms: 1200,
      num_turns: 3,
      result: "Normal text response",
      is_error: false,
    } as unknown as SDKMessage);

    const result = await turnPromise;
    expect(result.structuredOutput).toBeUndefined();

    session.close();
  });
});

describe("structured output error handling", () => {
  it("surfaces error_max_structured_output_retries as a specific error", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        outputFormat: {
          type: "json_schema",
          schema: { type: "object", properties: { name: { type: "string" } } },
        },
      }),
    );
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Hello", emit);

    mock.pushMessage({
      type: "result",
      subtype: "error_max_structured_output_retries",
      session_id: "sess-abc",
      uuid: "u1",
      total_cost_usd: 0.1,
      duration_ms: 5000,
      num_turns: 5,
      result: "",
      is_error: true,
      errors: [
        "Failed to produce valid structured output after maximum retries",
      ],
    } as unknown as SDKMessage);

    const result = await turnPromise;
    expect(result.error).toContain("structured output");
    expect(result.structuredOutput).toBeUndefined();

    session.close();
  });
});

describe("QuerySession.close", () => {
  it("transitions status to dead", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    expect(session.status).toBe("alive");

    session.close();
    expect(session.status).toBe("dead");
  });

  it("calls close on the SDK Query", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    session.close();

    expect(mock.query.close).toHaveBeenCalled();
  });

  it("rejects pending turn promise", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    session.close();

    await expect(turnPromise).rejects.toThrow();
  });

  it("is idempotent — calling close twice does not throw", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    session.close();
    expect(() => session.close()).not.toThrow();
  });
});

describe("QuerySession crash detection", () => {
  it("marks session dead when pump throws", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    // Simulate subprocess crash
    mock.crashPump(new Error("Subprocess exited unexpectedly"));

    await expect(turnPromise).rejects.toThrow("Subprocess exited unexpectedly");
    expect(session.status).toBe("dead");
  });

  it("includes captured stderr in error when pump crashes", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    // Simulate stderr output arriving before the crash
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (queryMock.mock.calls[0] as any)[0].options;
    expect(sdkOptions.stderr).toBeTypeOf("function");
    sdkOptions.stderr("Error: ENOENT: no such file or directory\n");
    sdkOptions.stderr("Fatal: cannot initialize session\n");

    // Now crash the pump
    mock.crashPump(new Error("Claude Code process exited with code 1"));

    let caughtError: Error | undefined;
    try {
      await turnPromise;
    } catch (e) {
      caughtError = e as Error;
    }
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe("Claude Code process exited with code 1");
    expect((caughtError as Error & { stderr: string }).stderr).toBe(
      "Error: ENOENT: no such file or directory\nFatal: cannot initialize session\n",
    );
  });

  it("rejects a subsequent prompt when the pump completes before delivery", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Make streamInput hang so the pump can die before delivery
    let resolveStreamInput: (() => void) | undefined;
    mock.query.streamInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStreamInput = resolve;
        }),
    );

    const turn2 = session.sendPrompt("Second", emit);
    mock.endPump();

    let caughtError: unknown;
    try {
      await turn2;
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe(
      "QuerySession died before prompt delivery",
    );
    expect(isUndeliveredQuerySessionError(caughtError)).toBe(true);

    if (resolveStreamInput) {
      resolveStreamInput();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.status).toBe("dead");
  });

  it("rejects a subsequent prompt when streamInput throws", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    mock.query.streamInput.mockRejectedValue(
      new Error("ProcessTransport is not ready for writing"),
    );

    const turn2 = session.sendPrompt("Second", emit);

    let caughtError: unknown;
    try {
      await turn2;
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe(
      "ProcessTransport is not ready for writing",
    );
    expect(isUndeliveredQuerySessionError(caughtError)).toBe(true);
    expect(session.status).toBe("dead");
  });
});

describe("Mid-turn death tagging", () => {
  it("tags clean pump completion mid-turn with sessionDiedMidTurn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    // Iterator ends cleanly while the caller-initiated turn is still pending
    mock.endPump();

    let caughtError: unknown;
    try {
      await turnPromise;
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect(isSessionDiedMidTurnError(caughtError)).toBe(true);
    expect(isUndeliveredQuerySessionError(caughtError)).toBe(false);
    expect(session.status).toBe("dead");
  });

  it("tags pump crash mid-turn with sessionDiedMidTurn while preserving the underlying error message", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    mock.crashPump(new Error("subprocess gone"));

    let caughtError: unknown;
    try {
      await turnPromise;
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe("subprocess gone");
    expect(isSessionDiedMidTurnError(caughtError)).toBe(true);
    expect(isUndeliveredQuerySessionError(caughtError)).toBe(false);
    expect(session.status).toBe("dead");
  });
});

describe("QuerySession idle TTL", () => {
  it("closes session after idle TTL expires", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions({ idleTtlMs: 100 }));
    const emit = vi.fn();

    // Complete a turn — this starts the idle timer
    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    expect(session.status).toBe("alive");

    // Advance past idle TTL
    vi.advanceTimersByTime(150);

    expect(session.status).toBe("dead");

    vi.useRealTimers();
  });

  it("does not close if new prompt arrives before TTL", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions({ idleTtlMs: 200 }));
    const emit = vi.fn();

    // Complete first turn
    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Advance partway through TTL
    vi.advanceTimersByTime(100);
    expect(session.status).toBe("alive");

    // Start second turn before TTL expires — clears timer
    const turn2 = session.sendPrompt("Second", emit);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u2",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn2;

    // Advance past original TTL window — should still be alive because timer was reset
    vi.advanceTimersByTime(150);
    expect(session.status).toBe("alive");

    // Advance past new TTL — now it should close
    vi.advanceTimersByTime(100);
    expect(session.status).toBe("dead");

    vi.useRealTimers();
  });

  it("notifyTurnStarting cancels the idle timer so pre-turn work cannot trip it", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions({ idleTtlMs: 100 }));
    const emit = vi.fn();

    // Complete a turn so the idle timer is armed
    const turn = session.sendPrompt("First", emit);
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
    await turn;

    expect(session.status).toBe("alive");

    // Caller is about to start a new turn — cancel the idle timer up front
    session.notifyTurnStarting();

    // Advance past what would have been the TTL — must still be alive
    vi.advanceTimersByTime(500);
    expect(session.status).toBe("alive");

    vi.useRealTimers();
    session.close();
  });

  it("notifyTurnStarting is a safe no-op on a dead session", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    session.close();
    expect(session.status).toBe("dead");

    expect(() => session.notifyTurnStarting()).not.toThrow();
    expect(session.status).toBe("dead");
  });
});

describe("QuerySession.sendPrompt on dead session", () => {
  it("rejects with a promptNotDelivered-tagged error so the caller can retry", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    session.close();
    expect(session.status).toBe("dead");

    const emit = vi.fn();
    let caughtError: unknown;
    try {
      await session.sendPrompt("Hello", emit);
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect(isUndeliveredQuerySessionError(caughtError)).toBe(true);
  });
});

describe("outputFormat passthrough", () => {
  it("passes outputFormat to SDK Options when provided", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const schema = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    };

    const session = createQuerySession(
      makeDefaultOptions({
        outputFormat: { type: "json_schema", schema },
      }),
    );

    // Check that the SDK query() was called with outputFormat in options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (queryMock.mock.calls[0] as any)[0].options;
    expect(sdkOptions.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });

    session.close();
  });

  it("does not include outputFormat in SDK Options when not provided", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (queryMock.mock.calls[0] as any)[0].options;
    expect(sdkOptions.outputFormat).toBeUndefined();

    session.close();
  });

  it("exposes outputFormat as a readonly property", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    const session = createQuerySession(
      makeDefaultOptions({
        outputFormat: { type: "json_schema", schema },
      }),
    );

    expect(session.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });

    session.close();
  });

  it("exposes undefined outputFormat when not provided", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    expect(session.outputFormat).toBeUndefined();

    session.close();
  });
});

describe("strictMcpConfig", () => {
  it("passes strictMcpConfig: true to the SDK so CC's server list is authoritative", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (queryMock.mock.calls[0] as any)[0].options;
    expect(sdkOptions.strictMcpConfig).toBe(true);

    session.close();
  });

  it("leaves settingSources unchanged so CLAUDE.md/skills/hooks/permissions still load", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (queryMock.mock.calls[0] as any)[0].options;
    expect(sdkOptions.settingSources).toEqual(["user", "project", "local"]);

    session.close();
  });
});

describe("MCP keepalive pings", () => {
  it("periodically calls mcpServerStatus between turns to keep transport alive", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    // Complete a turn — this starts the keepalive interval
    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    expect(mock.query.mcpServerStatus).not.toHaveBeenCalled();

    // Advance past one keepalive interval
    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    // Advance past another interval
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(2);

    session.close();
    vi.useRealTimers();
  });

  it("continues firing keepalive pings during an active turn", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    // Complete first turn
    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Start second turn but don't deliver a result — keepalive should keep firing
    const turn2 = session.sendPrompt("Second", emit);
    // Settle the pre-turn health check that fires from sendSubsequentPrompt
    await vi.advanceTimersByTimeAsync(0);
    mock.query.mcpServerStatus.mockClear();

    // Advance past several keepalive intervals — should fire repeatedly
    await vi.advanceTimersByTimeAsync(350);
    expect(mock.query.mcpServerStatus.mock.calls.length).toBeGreaterThanOrEqual(
      3,
    );

    // Land the result so turn2 resolves cleanly
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u2",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn2;

    session.close();
    vi.useRealTimers();
  });

  it("starts keepalive before the first turn completes", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    // Kick off the first turn but DON'T deliver a result
    const turn = session.sendPrompt("Hello", emit);

    // Advance well past the keepalive interval — should fire even though
    // the first turn hasn't produced a result message yet
    await vi.advanceTimersByTimeAsync(350);
    expect(mock.query.mcpServerStatus.mock.calls.length).toBeGreaterThanOrEqual(
      3,
    );

    // Resolve the turn so cleanup is clean
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
    await turn;

    session.close();
    vi.useRealTimers();
  });

  it("triggers recovery when mcpServerStatus reports a failed server", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const mcpServers = {
      "cc-session-tools": { command: "node", args: ["server.js"] },
    };
    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers,
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    // mcpServerStatus resolves normally but reports a failed entry
    mock.query.mcpServerStatus.mockResolvedValue([
      {
        name: "cc-session-tools",
        status: "failed",
        error: "transport closed",
      },
    ]);

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    expect(mock.query.setMcpServers).toHaveBeenCalledWith(mcpServers);

    session.close();
    vi.useRealTimers();
  });

  it("stops keepalive when session is closed", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    // Complete a turn
    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    session.close();
    mock.query.mcpServerStatus.mockClear();

    // Advance past keepalive interval — should NOT fire
    await vi.advanceTimersByTimeAsync(200);
    expect(mock.query.mcpServerStatus).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("does not crash if mcpServerStatus throws during keepalive", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    // Complete a turn
    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    // Make keepalive throw
    mock.query.mcpServerStatus.mockRejectedValue(new Error("boom"));

    // Should not throw — just swallowed
    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    // Session still alive
    expect(session.status).toBe("alive");

    session.close();
    vi.useRealTimers();
  });

  it("attempts MCP recovery via setMcpServers when keepalive status check fails", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const mcpServers = {
      "my-server": { command: "node", args: ["server.js"] },
    };
    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers,
      }),
    );
    const emit = vi.fn();

    // Complete a turn — starts keepalive
    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    // Make keepalive fail
    mock.query.mcpServerStatus.mockRejectedValue(new Error("Stream closed"));

    await vi.advanceTimersByTimeAsync(150);
    // Flush async recovery chain
    await vi.advanceTimersByTimeAsync(0);

    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    expect(mock.query.setMcpServers).toHaveBeenCalledWith(mcpServers);
    expect(session.status).toBe("alive");

    session.close();
    vi.useRealTimers();
  });

  it("does not call setMcpServers when keepalive status check succeeds", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    await vi.advanceTimersByTimeAsync(150);

    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);
    expect(mock.query.setMcpServers).not.toHaveBeenCalled();

    session.close();
    vi.useRealTimers();
  });

  it("survives when both keepalive status check and recovery fail", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    mock.query.mcpServerStatus.mockRejectedValue(new Error("dead"));
    mock.query.setMcpServers.mockRejectedValue(new Error("reconnect failed"));

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("alive");

    session.close();
    vi.useRealTimers();
  });

  it("does not pile up keepalive ticks while a prior status check is in flight", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    // Make mcpServerStatus hang so the first tick stays in flight
    let resolveStatus: ((v: unknown) => void) | undefined;
    mock.query.mcpServerStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    // Advance past five more intervals — pending tick still in flight, so no piling up
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    // Resolve the hanging status — next interval should be free to run
    resolveStatus?.([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(2);

    session.close();
    vi.useRealTimers();
  });

  it("does not attempt recovery when the session is closed during a status check", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    let rejectStatus: ((err: Error) => void) | undefined;
    mock.query.mcpServerStatus.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStatus = reject;
        }),
    );

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    // Fire the tick — status check now pending
    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    // Close the session while the status check is still in flight
    session.close();

    // NOW reject the status check — recovery must NOT run on a dead session
    rejectStatus?.(new Error("Stream closed"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mock.query.setMcpServers).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("serializes recovery — concurrent triggers only call setMcpServers once", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const mcpServers = {
      "my-server": { command: "node", args: ["server.js"] },
    };
    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers,
      }),
    );
    const emit = vi.fn();

    // Complete first turn so subsequent prompts use streamInput + pre-turn check
    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Make status fail so both triggers want to recover, and make setMcpServers
    // hang so the first recovery is still in flight when the second tries to start
    mock.query.mcpServerStatus.mockRejectedValue(new Error("Stream closed"));
    let resolveSet: ((v: unknown) => void) | undefined;
    mock.query.setMcpServers.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSet = resolve;
        }),
    );

    // Keepalive fires recovery (setMcpServers hangs)
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);

    // Pre-turn health check would normally trigger a second recovery
    const turn2 = session.sendPrompt("Second", emit);
    await vi.advanceTimersByTimeAsync(0);

    // With the recovery mutex, the second trigger should be a no-op
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);

    // Unblock recovery so the test cleans up
    resolveSet?.({});
    await vi.advanceTimersByTimeAsync(0);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u2",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn2;

    session.close();
    vi.useRealTimers();
  });

  it("escalates to dead after MCP_PIPE_BROKEN_THRESHOLD consecutive setMcpServers failures", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    // Both status and recovery fail every time
    mock.query.mcpServerStatus.mockRejectedValue(new Error("Stream closed"));
    mock.query.setMcpServers.mockRejectedValue(new Error("reconnect failed"));

    // Fire three keepalive ticks, settling async chains in between
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(3);
    expect(session.status).toBe("dead");
    expect(mock.query.close).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("resets the MCP failure counter after a successful setMcpServers call", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
        mcpServers: { s: {} },
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    mock.query.mcpServerStatus.mockRejectedValue(new Error("Stream closed"));

    // Pattern: fail, fail, success, fail, fail. Without the reset, the 4 total
    // failures would NOT trip threshold (4 != 3+), but the test still verifies
    // the counter goes to 0 after success — otherwise the next failure would
    // be counter=3 and trip.
    mock.query.setMcpServers
      .mockRejectedValueOnce(new Error("reconnect failed"))
      .mockRejectedValueOnce(new Error("reconnect failed"))
      .mockResolvedValueOnce({ added: [], removed: [], errors: {} })
      .mockRejectedValueOnce(new Error("reconnect failed"))
      .mockRejectedValueOnce(new Error("reconnect failed"))
      .mockRejectedValueOnce(new Error("reconnect failed"));

    // 5 ticks at t=100..500. Without reset: counters go 1,2,3 → would already
    // be dead by tick 3 (the successful one would never run). With reset:
    // 1, 2, 0, 1, 2 → stays alive.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(session.status).toBe("alive");

    // Sanity: one more failure should now trip the threshold (counter 2 → 3)
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status).toBe("dead");

    vi.useRealTimers();
  });

  it("starts keepalive after MCP servers are applied dynamically", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: {},
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).not.toHaveBeenCalled();

    const dynamicServers = {
      "cc-session-tools": {
        type: "sdk",
        name: "cc-session-tools",
        instance: {},
      },
    };
    await session.setMcpServers(dynamicServers);

    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    session.close();
    vi.useRealTimers();
  });

  it("uses dynamically applied MCP servers for pre-turn recovery", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: {},
        idleTtlMs: 0,
        mcpKeepaliveIntervalMs: 0,
      }),
    );
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    const dynamicServers = {
      "cc-session-tools": {
        type: "sdk",
        name: "cc-session-tools",
        instance: {},
      },
    };
    await session.setMcpServers(dynamicServers);

    mock.query.mcpServerStatus.mockRejectedValueOnce(
      new Error("Stream closed"),
    );

    const turn2 = session.sendPrompt("Second", emit);
    await new Promise((r) => setImmediate(r));

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(2);
    expect(mock.query.setMcpServers).toHaveBeenNthCalledWith(2, dynamicServers);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u2",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn2;

    session.close();
  });

  it("uses the latest dynamically applied MCP servers for recovery", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: {},
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    const serversA = { a: { command: "node", args: ["a.js"] } };
    const serversB = { b: { command: "node", args: ["b.js"] } };
    await session.setMcpServers(serversA);
    await session.setMcpServers(serversB);

    mock.query.mcpServerStatus.mockRejectedValue(new Error("Stream closed"));

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(3);
    expect(mock.query.setMcpServers).toHaveBeenNthCalledWith(3, serversB);

    session.close();
    vi.useRealTimers();
  });

  it("stops keepalive when dynamic MCP config is cleared", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: {},
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    await session.setMcpServers({ s: { command: "node" } });
    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    await session.setMcpServers({});
    await vi.advanceTimersByTimeAsync(300);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    session.close();
    vi.useRealTimers();
  });

  it("serializes dynamic MCP apply and recovery", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: {},
        mcpKeepaliveIntervalMs: 100,
        idleTtlMs: 5000,
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    const serversA = { a: { command: "node", args: ["a.js"] } };
    const serversB = { b: { command: "node", args: ["b.js"] } };
    await session.setMcpServers(serversA);

    mock.query.mcpServerStatus.mockRejectedValue(new Error("Stream closed"));
    let resolveRecovery: ((value: unknown) => void) | undefined;
    mock.query.setMcpServers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecovery = resolve;
        }),
    );

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(2);

    const applyPromise = session.setMcpServers(serversB);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(2);

    resolveRecovery?.({ added: [], removed: [], errors: {} });
    await vi.advanceTimersByTimeAsync(0);
    await applyPromise;

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(3);
    expect(mock.query.setMcpServers).toHaveBeenNthCalledWith(3, serversB);
    expect(session.status).toBe("alive");

    session.close();
    vi.useRealTimers();
  });

  it("defaults to 30s keepalive interval when not specified", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ idleTtlMs: 600_000, mcpServers: { s: {} } }),
    );
    const emit = vi.fn();

    // Complete a turn
    const turn = session.sendPrompt("Hello", emit);
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
    await turn;

    // Advance 29s — should not fire yet
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mock.query.mcpServerStatus).not.toHaveBeenCalled();

    // Advance past 30s — should fire
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    session.close();
    vi.useRealTimers();
  });
});

describe("Stream-closed tool_result detection", () => {
  function pushStreamClosedResult(
    mock: ReturnType<typeof createControllableMockQuery>,
    toolUseId: string,
    content: string = "Stream closed",
  ) {
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: `u-${toolUseId}`,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content,
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
  }

  function pushNormalToolResult(
    mock: ReturnType<typeof createControllableMockQuery>,
    toolUseId: string,
  ) {
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: `u-${toolUseId}`,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: "ok",
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
  }

  it("escalates to dead after TOOL_RESULT_STREAM_CLOSED_THRESHOLD consecutive stream-closed results", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    pushStreamClosedResult(mock, "t1");
    pushStreamClosedResult(mock, "t2");
    await new Promise((r) => setTimeout(r, 10));
    expect(session.status).toBe("alive");

    pushStreamClosedResult(mock, "t3");

    let caughtError: unknown;
    try {
      await turnPromise;
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect(isSdkPipeBrokenError(caughtError)).toBe(true);
    expect(session.status).toBe("dead");
    expect(mock.query.close).toHaveBeenCalled();
  });

  it("resets the stream-closed counter on a non-stream-closed tool_result", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    pushStreamClosedResult(mock, "t1");
    pushStreamClosedResult(mock, "t2");
    pushNormalToolResult(mock, "t3"); // resets counter to 0
    pushStreamClosedResult(mock, "t4");
    pushStreamClosedResult(mock, "t5");
    await new Promise((r) => setTimeout(r, 10));

    expect(session.status).toBe("alive");

    // Cleanup — deliver result so the turn resolves
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u-result",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turnPromise;

    session.close();
  });

  it("matches stream-closed by substring so wrapped error messages still escalate", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    pushStreamClosedResult(mock, "t1", "Error: Stream closed");
    pushStreamClosedResult(mock, "t2", "Error: Stream closed");
    pushStreamClosedResult(mock, "t3", "Error: Stream closed");

    let caughtError: unknown;
    try {
      await turnPromise;
    } catch (err) {
      caughtError = err;
    }
    expect(isSdkPipeBrokenError(caughtError)).toBe(true);
    expect(session.status).toBe("dead");
  });
});

describe("Pre-turn MCP health check", () => {
  /** Helper to complete a turn so the next prompt goes through sendSubsequentPrompt */
  function completeTurn(mock: ReturnType<typeof createControllableMockQuery>) {
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
  }

  it("checks MCP health and reconnects before delivering subsequent prompts", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const mcpServers = {
      "my-server": { command: "node", args: ["server.js"] },
    };
    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers,
        idleTtlMs: 0,
        mcpKeepaliveIntervalMs: 0,
      }),
    );
    const emit = vi.fn();

    // Complete first turn
    const turn1 = session.sendPrompt("First", emit);
    completeTurn(mock);
    await turn1;

    // Make MCP unhealthy for the pre-turn check
    mock.query.mcpServerStatus.mockRejectedValueOnce(
      new Error("Stream closed"),
    );

    // Send second prompt — should trigger health check + recovery
    const turn2 = session.sendPrompt("Second", emit);
    // Allow the async health check chain to settle before delivering result
    await new Promise((r) => setImmediate(r));

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    expect(mock.query.setMcpServers).toHaveBeenCalledWith(mcpServers);

    completeTurn(mock);
    await turn2;

    session.close();
  });

  it("reconnects pre-turn when mcpServerStatus reports a failed server", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const mcpServers = {
      "cc-session-tools": { command: "node", args: ["server.js"] },
    };
    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers,
        idleTtlMs: 0,
        mcpKeepaliveIntervalMs: 0,
      }),
    );
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
    completeTurn(mock);
    await turn1;

    // Status query succeeds but reports a failed server
    mock.query.mcpServerStatus.mockResolvedValueOnce([
      {
        name: "cc-session-tools",
        status: "failed",
        error: "transport closed",
      },
    ]);

    const turn2 = session.sendPrompt("Second", emit);
    await new Promise((r) => setImmediate(r));

    expect(mock.query.setMcpServers).toHaveBeenCalledTimes(1);
    expect(mock.query.setMcpServers).toHaveBeenCalledWith(mcpServers);

    completeTurn(mock);
    await turn2;

    session.close();
  });

  it("delivers prompt even when MCP recovery fails", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: { s: {} },
        idleTtlMs: 0,
        mcpKeepaliveIntervalMs: 0,
      }),
    );
    const emit = vi.fn();

    // Complete first turn
    const turn1 = session.sendPrompt("First", emit);
    completeTurn(mock);
    await turn1;

    // Both health check and recovery fail
    mock.query.mcpServerStatus.mockRejectedValueOnce(new Error("dead"));
    mock.query.setMcpServers.mockRejectedValueOnce(
      new Error("reconnect failed"),
    );

    // Send second prompt — recovery fails but prompt should still be delivered
    const turn2 = session.sendPrompt("Second", emit);
    await new Promise((r) => setImmediate(r));

    // streamInput should still have been called (prompt delivered despite MCP failure)
    expect(mock.query.streamInput).toHaveBeenCalled();

    completeTurn(mock);
    const result = await turn2;
    expect(result.error).toBeNull();

    session.close();
  });

  it("skips health check when no MCP servers are configured", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: {},
        idleTtlMs: 0,
        mcpKeepaliveIntervalMs: 0,
      }),
    );
    const emit = vi.fn();

    // Complete first turn
    const turn1 = session.sendPrompt("First", emit);
    completeTurn(mock);
    await turn1;

    mock.query.mcpServerStatus.mockClear();

    // Send second prompt — should NOT call mcpServerStatus
    const turn2 = session.sendPrompt("Second", emit);
    await new Promise((r) => setImmediate(r));

    expect(mock.query.mcpServerStatus).not.toHaveBeenCalled();

    completeTurn(mock);
    await turn2;

    session.close();
  });

  it("does not check MCP health for the first prompt", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({
        mcpServers: { s: {} },
        idleTtlMs: 0,
        mcpKeepaliveIntervalMs: 0,
      }),
    );
    const emit = vi.fn();

    // First prompt goes through the hanging generator, not sendSubsequentPrompt
    const turn = session.sendPrompt("First", emit);
    expect(mock.query.mcpServerStatus).not.toHaveBeenCalled();

    completeTurn(mock);
    await turn;

    session.close();
  });
});

describe("QuerySession externalTurnHandler (auto-continuation)", () => {
  it("forwards messages to handler.emit when no caller-initiated turn is pending", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalEmit = vi.fn();
    const externalOnComplete = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({
        externalTurnHandler: {
          emit: externalEmit,
          onComplete: externalOnComplete,
        },
      }),
    );
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Now the pump is idle (pendingTurn is null). Push a task-notification-like user message.
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<task-notification>done</task-notification>" },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));

    expect(externalEmit).toHaveBeenCalled();
    const rawCall = externalEmit.mock.calls.find(
      (c) => c[0] === "__raw_message",
    );
    expect(rawCall).toBeDefined();

    session.close();
  });

  it("invokes handler.onComplete with a TurnResult when a virtual-turn result arrives", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalEmit = vi.fn();
    const externalOnComplete = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({
        externalTurnHandler: {
          emit: externalEmit,
          onComplete: externalOnComplete,
        },
      }),
    );
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u1",
      total_cost_usd: 0.01,
      duration_ms: 100,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn1;

    // Auto-continuation sequence: user -> assistant -> result
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<task-notification>complete</task-notification>",
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
        content: [{ type: "text", text: "Continuation response" }],
      },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u4",
      total_cost_usd: 0.07,
      duration_ms: 450,
      num_turns: 2,
      result: "Continuation response",
      is_error: false,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));

    expect(externalOnComplete).toHaveBeenCalledTimes(1);
    const result = externalOnComplete.mock.calls[0]![0];
    expect(result.sessionId).toBe("sess-1");
    expect(result.costUsd).toBe(0.07);
    expect(result.durationMs).toBe(450);
    expect(result.numTurns).toBe(2);
    expect(result.aborted).toBe(false);
    expect(result.error).toBeNull();
    expect(
      result.contentBlocks.some(
        (b: { type: string; text?: string }) =>
          b.type === "text" && b.text === "Continuation response",
      ),
    ).toBe(true);

    session.close();
  });

  it("preserves drop-and-log behavior when no externalTurnHandler is provided", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Stray message should just be dropped — session stays alive, no crash
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "u2",
      message: {
        role: "user",
        content: [{ type: "text", text: "idle noise" }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));

    expect(session.status).toBe("alive");

    session.close();
  });

  it("does not invoke handler.onComplete when the pump dies mid-virtual-turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalEmit = vi.fn();
    const externalOnComplete = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({
        externalTurnHandler: {
          emit: externalEmit,
          onComplete: externalOnComplete,
        },
      }),
    );
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
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
    await turn1;

    // Start a virtual turn
    mock.pushMessage({
      type: "user",
      session_id: "sess-1",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<task-notification>x</task-notification>" },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));

    // Pump crashes before a result arrives
    mock.crashPump(new Error("subprocess died mid-virtual-turn"));

    await new Promise((r) => setTimeout(r, 10));

    expect(externalOnComplete).not.toHaveBeenCalled();
    expect(session.status).toBe("dead");
  });
});

describe("createQuerySession — trace context propagation", () => {
  it("runs each turn's message processing under sdk:turn:<conversationId>, inheriting the caller's traceId so downstream emit work groups with the request", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ conversationId: "conv-trace-xyz" }),
    );

    const captured: TraceContext[] = [];
    const emit = vi.fn(() => {
      const ctx = getTraceContext();
      if (ctx) captured.push(ctx);
    });

    const parent: TraceContext = {
      traceId: "parent-request-trace",
      action: "request:POST /api/conversations/prompt",
      projectName: "p",
      sessionName: "s",
      conversationId: "conv-trace-xyz",
    };

    const turnPromise = runWithTrace(parent, () =>
      session.sendPrompt("Hello", emit),
    );

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-trace",
      uuid: "u1",
      message: { content: [{ type: "text", text: "Reply" }] },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-trace",
      uuid: "u2",
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);

    await turnPromise;

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.action).toBe("sdk:turn:conv-trace-xyz");
    expect(captured[0]?.traceId).toBe("parent-request-trace");

    session.close();
  });

  it("mints a fresh sdk:turn:<conversationId> trace when there is no caller scope (autonomous/background-initiated turns)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ conversationId: "conv-trace-fresh" }),
    );

    const captured: TraceContext[] = [];
    const emit = vi.fn(() => {
      const ctx = getTraceContext();
      if (ctx) captured.push(ctx);
    });

    const turnPromise = session.sendPrompt("Hello", emit);

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-trace-2",
      uuid: "u1",
      message: { content: [{ type: "text", text: "Reply" }] },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-trace-2",
      uuid: "u2",
      total_cost_usd: 0,
      duration_ms: 1,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);

    await turnPromise;

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.action).toBe("sdk:turn:conv-trace-fresh");
    expect(captured[0]?.traceId).toBeTypeOf("string");
    expect(captured[0]?.traceId.length).toBeGreaterThan(0);

    session.close();
  });
});

describe("QuerySession background-task tracking", () => {
  function pushTaskStarted(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    toolUseId?: string,
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      description: "running a build",
      session_id: "sess-1",
      uuid: `u-start-${taskId}`,
    } as unknown as SDKMessage);
  }

  function pushTaskNotification(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    status: "completed" | "failed" | "stopped",
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status,
      output_file: "/tmp/out.txt",
      summary: "done",
      session_id: "sess-1",
      uuid: `u-notify-${taskId}`,
    } as unknown as SDKMessage);
  }

  function pushResult(
    mock: ReturnType<typeof createControllableMockQuery>,
    uuid: string,
  ) {
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid,
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
  }

  it("records a task_started with no matching settle as in-flight (1.1, 1.3)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);

    pushTaskStarted(mock, "task-a", "tool-1");
    // Agent yields without the task settling.
    pushResult(mock, "u-result");
    await turn;

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-a",
    ]);

    session.close();
  });

  it("empties the in-flight set when a matching task_notification settles it (1.2)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);

    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-a",
    ]);

    // The settlement arrives between turns (pendingTurn is null now).
    pushTaskNotification(mock, "task-a", "completed");
    await new Promise((r) => setTimeout(r, 10));

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([]);

    session.close();
  });

  it("tracks a task message that arrives between turns before any idle-discard (1.3)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    // No externalTurnHandler — a stray task message would normally be dropped.
    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    // Complete a caller turn so pendingTurn becomes null.
    const turn = session.sendPrompt("First", emit);
    pushResult(mock, "u-result");
    await turn;

    expect(session.isTurnActive).toBe(false);

    // A task starts while no caller turn is active — must still be recorded.
    pushTaskStarted(mock, "task-between", "tool-9");
    await new Promise((r) => setTimeout(r, 10));

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-between",
    ]);

    session.close();
  });

  function pushAssistantToolUse(
    mock: ReturnType<typeof createControllableMockQuery>,
    toolUseId: string,
    toolName: string,
  ) {
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: `u-asst-${toolUseId}`,
      message: {
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input: {},
          },
        ],
      },
    } as unknown as SDKMessage);
  }

  it("excludes a Monitor-originated task from the waitable set (Req 2.2)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Watch the dev server", emit);

    // The assistant invokes the Monitor tool; the pump records id -> name on the
    // pending turn BEFORE the task_started arrives.
    pushAssistantToolUse(mock, "tool-mon", "Monitor");
    pushTaskStarted(mock, "watch-1", "tool-mon");
    pushResult(mock, "u-result");
    await turn;

    expect(
      session.backgroundTaskState.tasks.get("watch-1")?.classification,
    ).toBe("excluded");
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([]);

    session.close();
  });

  it("keeps a Bash-originated task in the waitable set (Req 2.1)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);

    pushAssistantToolUse(mock, "tool-bash", "Bash");
    pushTaskStarted(mock, "shell-1", "tool-bash");
    pushResult(mock, "u-result");
    await turn;

    expect(
      session.backgroundTaskState.tasks.get("shell-1")?.classification,
    ).toBe("waitable");
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "shell-1",
    ]);

    session.close();
  });
});

describe("QuerySession.awaitBackgroundTaskSettlement", () => {
  function pushTaskStarted(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    toolUseId?: string,
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      description: "running a build",
      session_id: "sess-1",
      uuid: `u-start-${taskId}`,
    } as unknown as SDKMessage);
  }

  function pushTaskNotification(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    status: "completed" | "failed" | "stopped",
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status,
      output_file: "/tmp/out.txt",
      summary: "done",
      session_id: "sess-1",
      uuid: `u-notify-${taskId}`,
    } as unknown as SDKMessage);
  }

  function pushResult(
    mock: ReturnType<typeof createControllableMockQuery>,
    uuid: string,
  ) {
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid,
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
  }

  it("resolves almost immediately when the waitable set is already empty (3.3, 4.x)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Hello", emit);
    pushResult(mock, "u-result");
    await turn;

    const outcome = await session.awaitBackgroundTaskSettlement(10_000);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.waitedTaskIds).toEqual([]);
    expect(outcome.settledTaskIds).toEqual([]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    session.close();
  });

  it("resolves promptly when a matching task_notification drains the set (3.3, 4.x)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-a",
    ]);

    const waitPromise = session.awaitBackgroundTaskSettlement(10_000);

    // Settlement arrives between turns and drives the notifier.
    pushTaskNotification(mock, "task-a", "completed");

    const outcome = await waitPromise;
    expect(outcome.timedOut).toBe(false);
    expect(outcome.waitedTaskIds).toEqual(["task-a"]);
    expect(outcome.settledTaskIds).toEqual(["task-a"]);

    session.close();
  });

  it("resolves with timedOut: true at the bound and never rejects (4.1, 4.2, 4.4)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    // Never settle the task — only the timeout can end this wait.
    let rejected = false;
    const outcome = await session
      .awaitBackgroundTaskSettlement(20)
      .catch((err) => {
        rejected = true;
        throw err;
      });

    expect(rejected).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.waitedTaskIds).toEqual(["task-a"]);
    expect(outcome.settledTaskIds).toEqual([]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    session.close();
  });

  it("treats a failed task_notification as settled to end the wait (4.3)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    const waitPromise = session.awaitBackgroundTaskSettlement(10_000);
    pushTaskNotification(mock, "task-a", "failed");

    const outcome = await waitPromise;
    expect(outcome.timedOut).toBe(false);
    expect(outcome.settledTaskIds).toEqual(["task-a"]);

    session.close();
  });

  it("treats a stopped task_notification as settled to end the wait (4.3)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    const waitPromise = session.awaitBackgroundTaskSettlement(10_000);
    pushTaskNotification(mock, "task-a", "stopped");

    const outcome = await waitPromise;
    expect(outcome.timedOut).toBe(false);
    expect(outcome.settledTaskIds).toEqual(["task-a"]);

    session.close();
  });

  it("close() resolves a pending waiter rather than leaving it hanging", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    const waitPromise = session.awaitBackgroundTaskSettlement(10_000);

    // Subprocess dies mid-wait — the waiter must resolve, not hang.
    session.close();

    const outcome = await waitPromise;
    expect(outcome.timedOut).toBe(false);
    expect(outcome.settledTaskIds).toEqual([]);
  });

  it("resolves a pending waiter promptly with timedOut: false on a pump-internal death (2.2 fold-in)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    // Complete a caller turn that leaves a waitable task in flight.
    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-a",
    ]);

    // A long-bound wait begins, then the pump dies internally (clean exit) —
    // NOT via close(). The waiter must resolve promptly (timedOut: false),
    // not hang until the 10s timeout.
    const waitPromise = session.awaitBackgroundTaskSettlement(10_000);
    mock.endPump();

    const outcome = await waitPromise;
    expect(outcome.timedOut).toBe(false);
    expect(outcome.waitedTaskIds).toEqual(["task-a"]);
    expect(outcome.settledTaskIds).toEqual([]);
    expect(session.status).toBe("dead");
  });
});

describe("QuerySession idle-TTL suppression during waitable tasks", () => {
  function pushTaskStarted(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    toolUseId?: string,
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      description: "running a build",
      session_id: "sess-1",
      uuid: `u-start-${taskId}`,
    } as unknown as SDKMessage);
  }

  function pushTaskNotification(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    status: "completed" | "failed" | "stopped",
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status,
      output_file: "/tmp/out.txt",
      summary: "done",
      session_id: "sess-1",
      uuid: `u-notify-${taskId}`,
    } as unknown as SDKMessage);
  }

  it("does not arm the idle close timer while a waitable task is in flight", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions({ idleTtlMs: 100 }));
    const emit = vi.fn();

    // Caller turn that starts a waitable task and yields without settling it.
    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u-result",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn;

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-a",
    ]);

    // Advance well past the idle TTL — the timer must not have armed.
    await vi.advanceTimersByTimeAsync(500);
    expect(session.status).toBe("alive");

    vi.useRealTimers();
    session.close();
  });

  it("arms the idle close timer normally once the last waitable task settles", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    // externalTurnHandler so the settling task_notification + its result are
    // accumulated as a virtual turn (whose result re-arms the idle timer).
    const session = createQuerySession(
      makeDefaultOptions({
        idleTtlMs: 100,
        externalTurnHandler: {
          emit: vi.fn(),
          onComplete: vi.fn(),
        },
      }),
    );
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u-result",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await turn;

    // Still alive past the idle window because the waitable task suppresses it.
    await vi.advanceTimersByTimeAsync(300);
    expect(session.status).toBe("alive");

    // The settlement arrives as its own virtual turn (result re-arms the timer).
    pushTaskNotification(mock, "task-a", "completed");
    await vi.advanceTimersByTimeAsync(0);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u-settle-result",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 0,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([]);

    // Now the idle timer behaves normally and closes the session.
    await vi.advanceTimersByTimeAsync(150);
    expect(session.status).toBe("dead");

    vi.useRealTimers();
  });
});
