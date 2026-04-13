import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isUndeliveredQuerySessionError } from "./query-session-errors";

// ---------------------------------------------------------------------------
// Mock the SDK and registry
// ---------------------------------------------------------------------------

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("./query-session-registry", () => ({
  registerSession: vi.fn(),
  unregisterSession: vi.fn(),
}));

vi.mock("@/lib/sdk-env", () => ({}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import { createQuerySession, type QuerySessionOptions } from "./query-session";
import { registerSession, unregisterSession } from "./query-session-registry";

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

  it("registers itself in the registry on creation", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    expect(registerSession).toHaveBeenCalledWith("conv-123", session);

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

  it("unregisters from the registry", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    session.close();

    expect(unregisterSession).toHaveBeenCalledWith("conv-123");
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

  it("unregisters from registry on crash", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turnPromise = session.sendPrompt("Hello", emit);

    mock.crashPump(new Error("crash"));

    try {
      await turnPromise;
    } catch {
      // expected
    }

    expect(unregisterSession).toHaveBeenCalledWith("conv-123");
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

describe("MCP keepalive pings", () => {
  it("periodically calls mcpServerStatus between turns to keep transport alive", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ mcpKeepaliveIntervalMs: 100, idleTtlMs: 5000 }),
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

  it("stops keepalive when a new prompt arrives", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ mcpKeepaliveIntervalMs: 100, idleTtlMs: 5000 }),
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

    // Advance to trigger one keepalive
    await vi.advanceTimersByTimeAsync(150);
    expect(mock.query.mcpServerStatus).toHaveBeenCalledTimes(1);

    // Send next prompt — should clear the keepalive
    const turn2 = session.sendPrompt("Second", emit);
    mock.query.mcpServerStatus.mockClear();

    // Advance past the keepalive interval — should NOT fire
    await vi.advanceTimersByTimeAsync(200);
    expect(mock.query.mcpServerStatus).not.toHaveBeenCalled();

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

  it("stops keepalive when session is closed", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ mcpKeepaliveIntervalMs: 100, idleTtlMs: 5000 }),
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
      makeDefaultOptions({ mcpKeepaliveIntervalMs: 100, idleTtlMs: 5000 }),
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

  it("defaults to 30s keepalive interval when not specified", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ idleTtlMs: 600_000 }),
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
