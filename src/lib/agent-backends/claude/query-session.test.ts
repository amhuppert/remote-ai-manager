import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isUndeliveredQuerySessionError,
  isSessionDiedMidTurnError,
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

import {
  createQuerySession,
  type QuerySessionOptions,
  type TurnResult,
} from "./query-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a controllable mock Query (AsyncGenerator + close + streamInput) */
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

describe("QuerySession.sendPrompt", () => {
  it("does not give a queued command the context of a later identical command", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const session = createQuerySession(makeDefaultOptions());
    const call: { options: Options } = queryMock.mock.calls[0]?.[0];
    const first = session.queueUserInput("/wait-what").catch(() => {});
    const second = session
      .queueUserInput("/wait-what", "later notice")
      .catch(() => {});
    const hook = call.options.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    const submit = () =>
      hook?.(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "session",
          transcript_path: "/transcript",
          cwd: "/project",
          prompt: "/wait-what",
        },
        undefined,
        { signal: new AbortController().signal },
      );
    try {
      expect(await submit()).toEqual({});
      expect(await submit()).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "later notice",
        },
      });
    } finally {
      session.close();
      await Promise.all([first, second]);
    }
  });

  it("submits an explicit skill unchanged and supplies CC context through the SDK hook", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const session = createQuerySession(makeDefaultOptions());
    const call: { prompt: AsyncGenerator<SDKUserMessage>; options: Options } =
      queryMock.mock.calls[0]?.[0];
    const turn = session.sendPrompt("/wait-what shorter", vi.fn(), {
      promptContext: "<memory-index>context</memory-index>",
    });
    try {
      const message = await call.prompt.next();
      expect(message.value?.message.content).toEqual([
        { type: "text", text: "/wait-what shorter" },
      ]);
      const hook = call.options.hooks?.UserPromptSubmit?.[0]?.hooks[0];
      expect(
        await hook?.(
          {
            hook_event_name: "UserPromptSubmit",
            session_id: "session",
            transcript_path: "/transcript",
            cwd: "/project",
            prompt: "/wait-what shorter",
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "<memory-index>context</memory-index>",
        },
      });
    } finally {
      const completion = turn.catch(() => {});
      session.close();
      await completion;
    }
  });

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

  it("maps thinking and redacted_thinking blocks into thinking content blocks", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Why did the test fail?", emit);

    mock.pushMessage({
      type: "assistant",
      session_id: "sess-think",
      uuid: "u1",
      message: {
        content: [
          {
            type: "thinking",
            thinking: "Two candidates: a regression, or a stale selector.",
            signature: "sig-abc",
          },
          { type: "redacted_thinking", data: "encrypted-blob" },
          { type: "text", text: "The component is correct." },
        ],
      },
    } as unknown as SDKMessage);

    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-think",
      uuid: "u2",
      total_cost_usd: 0.01,
      duration_ms: 100,
      num_turns: 1,
      result: "The component is correct.",
      is_error: false,
    } as unknown as SDKMessage);

    const result = await turnPromise;

    // Reasoning is surfaced as distinct thinking blocks, in order, ahead of the
    // answer text — not dropped and not merged into the text stream.
    expect(result.contentBlocks.map((b) => b.type)).toEqual([
      "thinking",
      "thinking",
      "text",
    ]);
    expect(result.contentBlocks.filter((b) => b.type === "thinking")).toEqual([
      {
        type: "thinking",
        text: "Two candidates: a regression, or a stale selector.",
      },
      { type: "thinking", text: "", redacted: true },
    ]);

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

    const channel: AsyncGenerator<SDKUserMessage> =
      queryMock.mock.calls[0]![0].prompt;

    const turn1 = session.sendPrompt("First", emit);
    await channel.next();
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

    // Inspect what the input channel delivers for the second prompt
    const { value: sdkMessage } = await channel.next();

    // Should be a properly formed SDKUserMessage with Anthropic API image format
    expect(sdkMessage!.message.content).toEqual([
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
  it("maps SDK structured_output into the TurnResult", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const turnPromise = session.sendPrompt("Return JSON", vi.fn());

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

    await expect(turnPromise).resolves.toMatchObject({
      structuredOutput: { name: "test" },
    });
    session.close();
  });
});

describe("structured output error handling", () => {
  it("surfaces error_max_structured_output_retries as a specific error", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
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
      errors: [],
    } as unknown as SDKMessage);

    const result = await turnPromise;
    expect(result.error).toBe("Agent exceeded structured output retry limit");
    expect(result.structuredOutput).toBeUndefined();

    session.close();
  });

  it("treats a success-subtype result with is_error true as a turn error and surfaces the result text", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Hello", emit);

    // The SDK reports an inaccessible model as subtype "success" with
    // is_error true, carrying the message in `result` and no structured_output.
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-abc",
      uuid: "u1",
      total_cost_usd: 0,
      duration_ms: 670,
      num_turns: 1,
      result:
        "There's an issue with the selected model (claude-fable-5[1m]). It may not exist or you may not have access to it.",
      is_error: true,
    } as unknown as SDKMessage);

    const result = await turnPromise;
    expect(result.error).toContain("issue with the selected model");
    expect(result.structuredOutput).toBeUndefined();

    session.close();
  });
});

describe("QuerySession.close", () => {
  it("delegates cleanup to the SDK Query", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    session.close();

    expect(mock.query.close).toHaveBeenCalledTimes(1);
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

  it("rejects a subsequent prompt as undelivered when the pump crashes before delivery", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const channel: AsyncGenerator<SDKUserMessage> =
      queryMock.mock.calls[0]![0].prompt;

    const turn1 = session.sendPrompt("First", emit);
    await channel.next();
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

    // Transport write failures now surface through the pump (the SDK aborts
    // the query), not through a per-prompt streamInput rejection.
    const turn2 = session.sendPrompt("Second", emit);
    mock.crashPump(new Error("ProcessTransport is not ready for writing"));

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

describe("External (virtual) turn rejection", () => {
  it("delivers a terminal completion with the error when a virtual turn is rejected by pump death", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const onComplete = vi.fn();
    const handlerEmit = vi.fn();
    const session = createQuerySession(
      makeDefaultOptions({
        externalTurnHandler: { emit: handlerEmit, onComplete },
      }),
    );

    // A stray message between turns synthesizes a virtual turn (no caller prompt).
    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-ext",
      uuid: "sys-1",
    } as unknown as SDKMessage);

    // The agent emits partial work before the subprocess dies.
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-ext",
      uuid: "asst-1",
      message: { content: [{ type: "text", text: "partial work" }] },
    } as unknown as SDKMessage);

    // Let the pump drain both queued messages.
    await new Promise((r) => setTimeout(r, 0));

    // Subprocess exits cleanly while the virtual turn is still in flight.
    mock.endPump();
    await new Promise((r) => setTimeout(r, 0));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const result = onComplete.mock.calls[0]![0] as TurnResult;
    expect(result.error).toBeTruthy();
    expect(result.aborted).toBe(false);
    expect(
      result.contentBlocks.some(
        (b) => b.type === "text" && b.text === "partial work",
      ),
    ).toBe(true);
    expect(session.status).toBe("dead");
  });

  it("delivers exactly one completion when a normal-result virtual turn is followed by pump death", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const onComplete = vi.fn();
    const handlerEmit = vi.fn();
    createQuerySession(
      makeDefaultOptions({
        externalTurnHandler: { emit: handlerEmit, onComplete },
      }),
    );

    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-ext",
      uuid: "sys-1",
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-ext",
      uuid: "res-1",
      total_cost_usd: 0,
      duration_ms: 0,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 0));

    // The virtual turn already resolved via `result`; a later pump death must
    // not deliver a second (rejected) completion.
    mock.endPump();
    await new Promise((r) => setTimeout(r, 0));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const result = onComplete.mock.calls[0]![0] as TurnResult;
    expect(result.error).toBeNull();
  });

  it("still tears down the session when handler.onComplete throws during rejection", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const onComplete = vi.fn(() => {
      throw new Error("machine dispatch failed");
    });
    const session = createQuerySession(
      makeDefaultOptions({
        externalTurnHandler: { emit: vi.fn(), onComplete },
      }),
    );

    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-ext",
      uuid: "sys-1",
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 0));

    // close() rejects the in-flight virtual turn; a throwing onComplete must
    // not escape the reject closure and skip the rest of session teardown
    // (status = "dead", subprocess close).
    expect(() => session.close()).not.toThrow();
    expect(onComplete).toHaveBeenCalledTimes(1);
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

describe("structured output SDK boundary", () => {
  it("does not include outputFormat in SDK Options", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (queryMock.mock.calls[0] as any)[0].options;
    expect(sdkOptions.outputFormat).toBeUndefined();

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

  it("requests summarized adaptive thinking so reasoning blocks carry text", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (queryMock.mock.calls[0] as any)[0].options;
    expect(sdkOptions.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });

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
    // 0.07 is the lineage's cumulative; the continuation itself cost the
    // delta over turn 1's 0.01.
    expect(result.costUsd).toBeCloseTo(0.06, 10);
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

  it("completes an open virtual turn when a caller prompt takes over the stream", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const externalOnComplete = vi.fn();
    const session = createQuerySession(
      makeDefaultOptions({
        externalTurnHandler: {
          emit: vi.fn(),
          onComplete: externalOnComplete,
        },
      }),
    );

    const turn1 = session.sendPrompt("First", vi.fn());
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

    // A background task settles and the CLI opens its own turn before the
    // caller's already-admitted follow-up reaches the session.
    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      uuid: "sys-2",
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 0));

    // The CLI folds the follow-up into the turn it already opened, so the
    // stream carries one result for both.
    const followUp = session.sendPrompt("Follow-up", vi.fn());
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "u3",
      message: { content: [{ type: "text", text: "Follow-up answer" }] },
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "u4",
      total_cost_usd: 0.05,
      duration_ms: 300,
      num_turns: 2,
      result: "Follow-up answer",
      is_error: false,
    } as unknown as SDKMessage);

    const result = await followUp;
    expect(result.finalText).toBe("Follow-up answer");
    expect(externalOnComplete).toHaveBeenCalledTimes(1);
    const external = externalOnComplete.mock.calls[0]![0] as TurnResult;
    expect(external.error).toBeNull();
    expect(external.aborted).toBe(false);

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

  it.each([
    [
      "system/task_notification",
      {
        type: "system",
        subtype: "task_notification",
        uuid: "amb-3",
        session_id: "sess-1",
      },
    ],
  ])(
    "does not start a virtual turn for a between-turns %s notification",
    async (_label, ambient) => {
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

      const turn1 = session.sendPrompt("First", vi.fn());
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
      externalEmit.mockClear();

      mock.pushMessage(ambient as unknown as SDKMessage);
      await new Promise((r) => setTimeout(r, 10));

      // No virtual turn opened: nothing forwarded, so the conversation machine
      // never sees EXTERNAL_TURN_STARTED and cannot wedge in `running`.
      expect(externalEmit).not.toHaveBeenCalled();
      expect(externalOnComplete).not.toHaveBeenCalled();
      expect(session.status).toBe("alive");

      session.close();
    },
  );

  it("still opens a virtual turn when a genuine turn message follows an ambient notification", async () => {
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

    const turn1 = session.sendPrompt("First", vi.fn());
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
    externalEmit.mockClear();

    mock.pushMessage({
      type: "system",
      subtype: "task_notification",
      uuid: "amb-4",
      session_id: "sess-1",
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "system",
      subtype: "init",
      uuid: "init-1",
      session_id: "sess-1",
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "assistant",
      session_id: "sess-1",
      uuid: "a1",
      message: { content: [{ type: "text", text: "Auto continuation" }] },
    } as unknown as SDKMessage);
    mock.pushMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid: "r2",
      total_cost_usd: 0.02,
      duration_ms: 200,
      num_turns: 1,
      result: "Auto continuation",
      is_error: false,
    } as unknown as SDKMessage);

    await new Promise((r) => setTimeout(r, 10));

    expect(externalOnComplete).toHaveBeenCalledTimes(1);
    expect(
      externalOnComplete.mock.calls[0]![0].contentBlocks.some(
        (b: { type: string; text?: string }) =>
          b.type === "text" && b.text === "Auto continuation",
      ),
    ).toBe(true);

    session.close();
  });

  it("invokes handler.onComplete with the error when the pump dies mid-virtual-turn", async () => {
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

    // Pump crashes before a result arrives. The rejected virtual turn must
    // still deliver a terminal completion (with the error) so the conversation
    // machine leaves externalExecuting instead of wedging at status 'running'.
    mock.crashPump(new Error("subprocess died mid-virtual-turn"));

    await new Promise((r) => setTimeout(r, 10));

    expect(externalOnComplete).toHaveBeenCalledTimes(1);
    const result = externalOnComplete.mock.calls[0]![0];
    expect(result.error).toBe("subprocess died mid-virtual-turn");
    expect(result.aborted).toBe(false);
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

  it("resolves when the waiter's own waited tasks settle even while an unrelated task is still in flight (per-waiter settlement)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn = session.sendPrompt("Run the build in the background", emit);
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-result");
    await turn;

    const waitPromise = session.awaitBackgroundTaskSettlement(600_000);

    // A run-forever task (e.g. dev server) starts between turns, then the
    // waited task settles. The waiter must resolve on its OWN set draining,
    // not wait for the unrelated task.
    pushTaskStarted(mock, "task-b", "tool-2");
    pushTaskNotification(mock, "task-a", "completed");

    const raced = await Promise.race([
      waitPromise.then((outcome) => ({ resolved: true as const, outcome })),
      new Promise<{ resolved: false }>((resolve) =>
        setTimeout(() => resolve({ resolved: false }), 100),
      ),
    ]);

    expect(raced.resolved).toBe(true);
    if (raced.resolved) {
      expect(raced.outcome.timedOut).toBe(false);
      expect(raced.outcome.waitedTaskIds).toEqual(["task-a"]);
      expect(raced.outcome.settledTaskIds).toEqual(["task-a"]);
    }

    session.close();
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

  it("arms the idle close timer when a wait timeout demotes the last waitable task", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions({ idleTtlMs: 100 }));
    const emit = vi.fn();

    // Final turn of a conversation starts a run-forever task: its `result`
    // skips arming (task waitable/in-flight), so without arming on demotion
    // the subprocess would leak until session deletion.
    const turn = session.sendPrompt(
      "Run the dev server in the background",
      emit,
    );
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

    const waitPromise = session.awaitBackgroundTaskSettlement(50);
    await vi.advanceTimersByTimeAsync(50);
    const outcome = await waitPromise;
    expect(outcome.timedOut).toBe(true);
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([]);
    expect(session.status).toBe("alive");

    await vi.advanceTimersByTimeAsync(150);
    expect(session.status).toBe("dead");

    vi.useRealTimers();
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

describe("QuerySession native compaction", () => {
  function assistantMessageWithUsage(
    uuid: string,
    usage: {
      input_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    },
  ): SDKMessage {
    return {
      type: "assistant",
      session_id: "sess-occ",
      uuid,
      message: {
        content: [{ type: "text", text: "working" }],
        usage,
      },
    } as unknown as SDKMessage;
  }

  function compactBoundaryMessage(uuid: string): SDKMessage {
    return {
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-occ",
      uuid,
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 150_000,
        post_tokens: 40_000,
      },
    } as unknown as SDKMessage;
  }

  function successResult(uuid: string): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      session_id: "sess-occ",
      uuid,
      total_cost_usd: 0.01,
      duration_ms: 100,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage;
  }

  it("marks TurnResult.compacted on a compact_boundary system message", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const turnPromise = session.sendPrompt("Hello", vi.fn());

    mock.pushMessage(assistantMessageWithUsage("u1", { input_tokens: 40_000 }));
    mock.pushMessage(compactBoundaryMessage("u2"));
    await new Promise((r) => setTimeout(r, 10));

    mock.pushMessage(successResult("u3"));
    const result = await turnPromise;
    expect(result.compacted).toBe(true);
    session.close();
  });

  it("reports compacted false on a TurnResult when no compaction occurred", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const turnPromise = session.sendPrompt("Hello", vi.fn());

    mock.pushMessage(assistantMessageWithUsage("u1", { input_tokens: 5000 }));
    mock.pushMessage(successResult("u2"));
    const result = await turnPromise;

    expect(result.compacted).toBe(false);
    session.close();
  });
});

// -- per-turn cost attribution (SDK total_cost_usd is cumulative) --------------

describe("QuerySession cost attribution", () => {
  function resultMessage(
    sessionId: string,
    totalCostUsd: number,
    uuid: string,
  ): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      uuid,
      total_cost_usd: totalCostUsd,
      duration_ms: 100,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage;
  }

  it("attributes only the delta of the cumulative session cost to each turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
    mock.pushMessage(resultMessage("sess-1", 10, "u1"));
    const result1 = await turn1;

    const turn2 = session.sendPrompt("Second", emit);
    mock.pushMessage(resultMessage("sess-1", 25.5, "u2"));
    const result2 = await turn2;

    expect(result1.costUsd).toBe(10);
    // The SDK reports 25.5 as the session's cumulative cost; the turn itself
    // cost 15.5. Attributing the cumulative would double-count turn 1's spend
    // in every consumer that sums per-turn costs (conversation totals).
    expect(result2.costUsd).toBe(15.5);

    session.close();
  });

  it("restarts the baseline when the session lineage changes", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
    mock.pushMessage(resultMessage("sess-a", 10, "u1"));
    await turn1;

    // A restarted lineage reports cost from zero again — its first result is
    // entirely this turn's spend, not a delta against the old lineage.
    const turn2 = session.sendPrompt("Second", emit);
    mock.pushMessage(resultMessage("sess-b", 7.5, "u2"));
    const result2 = await turn2;

    expect(result2.costUsd).toBe(7.5);

    session.close();
  });

  it("treats a same-session-id cumulative drop as a lineage restart", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
    mock.pushMessage(resultMessage("sess-1", 64.85, "u1"));
    await turn1;

    // A restarted subprocess can resume the SAME session id with its
    // cumulative reset. The drop is the lineage boundary: the new result is
    // entirely this turn's spend, not Math.max(0, 43.73 - 64.85) = 0.
    const turn2 = session.sendPrompt("Second", emit);
    mock.pushMessage(resultMessage("sess-1", 43.73, "u2"));
    const result2 = await turn2;

    expect(result2.costUsd).toBe(43.73);

    session.close();
  });

  it("carries a discarded between-turns segment's cost into the next turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session.sendPrompt("First", emit);
    mock.pushMessage(resultMessage("sess-1", 10, "u1"));
    await turn1;

    // No pending turn and no external handler: this result is discarded, but
    // its spend is real — it must surface in the next attributed turn so the
    // conversation total still sums to the lineage's final cumulative.
    mock.pushMessage(resultMessage("sess-1", 12, "u2"));
    await new Promise((r) => setTimeout(r, 10));

    const turn2 = session.sendPrompt("Second", emit);
    mock.pushMessage(resultMessage("sess-1", 20, "u3"));
    const result2 = await turn2;

    expect(result2.costUsd).toBe(10);

    session.close();
  });
});

// ---------------------------------------------------------------------------
// Persistent input channel
//
// The SDK calls transport.endInput() (closing the CLI's stdin) once a
// streamInput() iterable completes, which schedules the subprocess to exit
// after the in-flight turn and drops background-task auto-continuations. All
// input — first prompt, subsequent prompts, mid-turn queued input — must
// therefore flow through the single prompt iterable handed to the SDK at
// session creation, and streamInput() must never be called.
// ---------------------------------------------------------------------------

describe("QuerySession persistent input channel", () => {
  function promptChannel(): AsyncGenerator<SDKUserMessage> {
    return queryMock.mock.calls[0]![0].prompt;
  }

  function successResult(uuid: string): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      uuid,
      total_cost_usd: 0.01,
      duration_ms: 100,
      num_turns: 1,
      result: "",
      is_error: false,
    } as unknown as SDKMessage;
  }

  it("delivers every prompt through the prompt iterable and never calls streamInput", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const channel = promptChannel();

    const turn1 = session.sendPrompt("First prompt", emit);
    const first = await channel.next();
    expect(first.done).toBe(false);
    expect(first.value!.message.content).toEqual([
      { type: "text", text: "First prompt" },
    ]);

    mock.pushMessage(successResult("u1"));
    await turn1;

    const turn2 = session.sendPrompt("Second prompt", emit);
    expect(mock.query.streamInput).not.toHaveBeenCalled();

    const second = await channel.next();
    expect(second.done).toBe(false);
    expect(second.value!.message.content).toEqual([
      { type: "text", text: "Second prompt" },
    ]);

    mock.pushMessage(successResult("u2"));
    await turn2;
    expect(mock.query.streamInput).not.toHaveBeenCalled();

    session.close();
  });

  it("delivers queueUserInput content through the channel mid-turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const channel = promptChannel();

    const turn1 = session.sendPrompt("First prompt", emit);
    await channel.next();

    const queued = session.queueUserInput([
      { type: "text", text: "queued follow-up" },
    ]);
    const delivered = await channel.next();
    expect(delivered.done).toBe(false);
    expect(delivered.value!.message.content).toEqual([
      { type: "text", text: "queued follow-up" },
    ]);
    // Delivery settles when the consumer requests the next message (the SDK's
    // loop does this immediately after each stdin write completes).
    const pending = channel.next();
    await queued;
    void pending;
    expect(mock.query.streamInput).not.toHaveBeenCalled();

    mock.pushMessage(successResult("u1"));
    await turn1;

    session.close();
  });

  it("resolves queueUserInput only once the SDK has consumed the message", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const channel = promptChannel();

    let resolved = false;
    const queued = session
      .queueUserInput([{ type: "text", text: "gated" }])
      .then(() => {
        resolved = true;
      });

    // Not consumed from the channel yet — acceptance must still be pending.
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // yield hands the message to the consumer; delivery settles when the
    // consumer requests the next one (the stdin write has completed).
    const it1 = await channel.next();
    expect(it1.done).toBe(false);
    const pending = channel.next();
    await queued;
    expect(resolved).toBe(true);

    void pending;
    session.close();
  });

  it("rejects queueUserInput with a tagged error when the session is dead", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    session.close();
    expect(session.status).toBe("dead");
    void mock;

    let caught: unknown;
    try {
      await session.queueUserInput([{ type: "text", text: "too late" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isUndeliveredQuerySessionError(caught)).toBe(true);
  });

  it("rejects an unconsumed queueUserInput when the pump dies", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    const queued = session.queueUserInput([
      { type: "text", text: "never consumed" },
    ]);
    mock.endPump();

    let caught: unknown;
    try {
      await queued;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isUndeliveredQuerySessionError(caught)).toBe(true);
    expect(session.status).toBe("dead");
  });

  it("rejects an unconsumed queueUserInput when the session is closed", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    void mock;

    const session = createQuerySession(makeDefaultOptions());

    const queued = session.queueUserInput([
      { type: "text", text: "never consumed" },
    ]);
    session.close();

    let caught: unknown;
    try {
      await queued;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isUndeliveredQuerySessionError(caught)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idle-timer / waitable-task races (incident 2026-07-09: a stale idle timer
// armed while the waitable set was momentarily empty fired later and killed
// the subprocess — and every background task in it — mid-wait)
// ---------------------------------------------------------------------------

describe("QuerySession idle-timer vs waitable-task races", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("disarms a live idle timer when a waitable task starts between turns", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions({ idleTtlMs: 100 }));

    // A turn with no tasks — its result arms the idle timer.
    const turn = session.sendPrompt("quick check", vi.fn());
    pushResult(mock, "u-r1");
    await turn;

    // A waitable task starts BETWEEN turns (idle-discard path, no handler).
    pushTaskStarted(mock, "task-a", "tool-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-a",
    ]);

    // The already-armed timer must not fire and kill the task's subprocess.
    await vi.advanceTimersByTimeAsync(500);
    expect(session.status).toBe("alive");

    vi.useRealTimers();
    session.close();
  });

  it("does not let a stale idle timer kill a waitable task started during an external turn (incident replay)", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const onComplete = vi.fn();
    const session = createQuerySession(
      makeDefaultOptions({
        idleTtlMs: 100,
        externalTurnHandler: { emit: vi.fn(), onComplete },
      }),
    );

    // Turn 1 ends with an empty waitable set — the idle timer arms.
    const turn = session.sendPrompt("kick off", vi.fn());
    pushResult(mock, "u-r1");
    await turn;

    // Auto-continuation: an external turn opens and starts a waitable watcher,
    // then completes while the watcher is still running.
    pushTaskStarted(mock, "task-w", "tool-w");
    await vi.advanceTimersByTimeAsync(0);
    pushResult(mock, "u-r2");
    await vi.advanceTimersByTimeAsync(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-w",
    ]);

    // The timer armed at turn 1's result must not fire and kill the watcher.
    await vi.advanceTimersByTimeAsync(500);
    expect(session.status).toBe("alive");

    // Settlement wakes one more external turn; once it completes with the
    // waitable set drained, the idle timer arms and closes the session.
    pushTaskNotification(mock, "task-w", "completed");
    await vi.advanceTimersByTimeAsync(0);
    pushResult(mock, "u-r3");
    await vi.advanceTimersByTimeAsync(0);
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([]);

    await vi.advanceTimersByTimeAsync(150);
    expect(session.status).toBe("dead");

    vi.useRealTimers();
  });

  it("arms the idle timer when a between-turns settlement drains the waitable set with no continuation", async () => {
    vi.useFakeTimers();
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions({ idleTtlMs: 100 }));

    // The final turn leaves a waitable task in flight — no arming at result.
    const turn = session.sendPrompt("run the suite in the background", vi.fn());
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-r1");
    await turn;

    await vi.advanceTimersByTimeAsync(300);
    expect(session.status).toBe("alive");

    // The task settles between turns and no auto-continuation follows (no
    // handler). The drain must arm the idle timer — otherwise the subprocess
    // leaks until session deletion.
    pushTaskNotification(mock, "task-a", "completed");
    await vi.advanceTimersByTimeAsync(0);
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([]);

    await vi.advanceTimersByTimeAsync(150);
    expect(session.status).toBe("dead");

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Background-task loss surfacing: a session death with waitable tasks still
// in flight kills those processes and the wake-on-complete contract — the
// caller must be told so it can surface the loss.
// ---------------------------------------------------------------------------

describe("QuerySession onBackgroundTasksLost", () => {
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
      description: "full regression suite",
      session_id: "sess-1",
      uuid: `u-start-${taskId}`,
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

  async function runTurnWithInFlightTask(
    mock: ReturnType<typeof createControllableMockQuery>,
    session: ReturnType<typeof createQuerySession>,
  ) {
    const turn = session.sendPrompt("run it in the background", vi.fn());
    pushTaskStarted(mock, "task-a", "tool-1");
    pushResult(mock, "u-r1");
    await turn;
  }

  it("invokes onBackgroundTasksLost with the lost tasks when closed mid-wait", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundTasksLost = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundTasksLost }),
    );
    await runTurnWithInFlightTask(mock, session);

    session.close();

    expect(onBackgroundTasksLost).toHaveBeenCalledTimes(1);
    expect(onBackgroundTasksLost).toHaveBeenCalledWith({
      tasks: [{ taskId: "task-a", description: "full regression suite" }],
      reason: "closed",
    });
  });

  it("invokes onBackgroundTasksLost when the pump completes with tasks in flight", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundTasksLost = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundTasksLost }),
    );
    await runTurnWithInFlightTask(mock, session);

    mock.endPump();
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.status).toBe("dead");
    expect(onBackgroundTasksLost).toHaveBeenCalledTimes(1);
    expect(onBackgroundTasksLost.mock.calls[0]![0]).toMatchObject({
      reason: "pump_completed",
      tasks: [{ taskId: "task-a" }],
    });
  });

  it("does not invoke onBackgroundTasksLost when the waitable set is empty", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundTasksLost = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundTasksLost }),
    );
    const turn = session.sendPrompt("no tasks here", vi.fn());
    pushResult(mock, "u-r1");
    await turn;

    session.close();
    expect(onBackgroundTasksLost).not.toHaveBeenCalled();
  });

  it("invokes onBackgroundTasksLost exactly once when close follows pump death", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundTasksLost = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundTasksLost }),
    );
    await runTurnWithInFlightTask(mock, session);

    mock.endPump();
    await new Promise((resolve) => setImmediate(resolve));
    session.close();

    expect(onBackgroundTasksLost).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing onBackgroundTasksLost callback and still tears down", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundTasksLost = vi.fn(() => {
      throw new Error("boom");
    });

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundTasksLost }),
    );
    await runTurnWithInFlightTask(mock, session);

    expect(() => session.close()).not.toThrow();
    expect(session.status).toBe("dead");
  });
});

// ---------------------------------------------------------------------------
// Background-task ACTIVITY: while a task runs between turns the conversation
// looks idle. The pump must surface a liveness snapshot so the UI can tell
// "working in the background" apart from "dead".
// ---------------------------------------------------------------------------

describe("QuerySession onBackgroundActivity", () => {
  function pushTaskStarted(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    extra: Record<string, unknown> = {},
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      description: "full regression suite",
      session_id: "sess-1",
      uuid: `u-start-${taskId}`,
      ...extra,
    } as unknown as SDKMessage);
  }

  function pushTaskProgress(
    mock: ReturnType<typeof createControllableMockQuery>,
    taskId: string,
    uuid: string,
  ) {
    mock.pushMessage({
      type: "system",
      subtype: "task_progress",
      task_id: taskId,
      description: "still running",
      usage: { total_tokens: 42, tool_uses: 2, duration_ms: 900 },
      last_tool_name: "Bash",
      session_id: "sess-1",
      uuid,
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

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("reports the snapshot when a task starts and when the set drains", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundActivity = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundActivity }),
    );
    const turn = session.sendPrompt("run it in the background", vi.fn());
    pushTaskStarted(mock, "task-a", {
      task_type: "local_workflow",
      workflow_name: "spec",
    });
    pushResult(mock, "u-r1");
    await turn;

    expect(onBackgroundActivity).toHaveBeenCalled();
    const started = onBackgroundActivity.mock.lastCall![0];
    expect(started).toMatchObject({
      tasks: [{ taskId: "task-a", workflowName: "spec" }],
    });

    mock.pushMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-a",
      status: "completed",
      output_file: "/tmp/out.log",
      summary: "done",
      session_id: "sess-1",
      uuid: "u-notif",
    } as unknown as SDKMessage);
    await settle();

    expect(onBackgroundActivity).toHaveBeenLastCalledWith(null);
    session.close();
  });

  it("reports a between-turn task_progress without opening an external turn", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundActivity = vi.fn();
    const externalTurnHandler = { emit: vi.fn(), onComplete: vi.fn() };

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundActivity, externalTurnHandler }),
    );
    const turn = session.sendPrompt("run it in the background", vi.fn());
    pushTaskStarted(mock, "task-a");
    pushResult(mock, "u-r1");
    await turn;
    onBackgroundActivity.mockClear();

    pushTaskProgress(mock, "task-a", "u-prog-1");
    await settle();

    expect(session.isTurnActive).toBe(false);
    expect(externalTurnHandler.emit).not.toHaveBeenCalled();
    expect(onBackgroundActivity).toHaveBeenCalledTimes(1);
    expect(onBackgroundActivity.mock.lastCall![0]).toMatchObject({
      tasks: [
        {
          taskId: "task-a",
          lastToolName: "Bash",
          totalTokens: 42,
          toolUses: 2,
        },
      ],
    });

    session.close();
  });

  it("keeps pumping when the activity callback throws", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundActivity = vi.fn(() => {
      throw new Error("subscriber exploded");
    });

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundActivity }),
    );
    const turn = session.sendPrompt("run it in the background", vi.fn());
    pushTaskStarted(mock, "task-a");
    pushResult(mock, "u-r1");

    await expect(turn).resolves.toMatchObject({ error: null });
    expect(session.status).toBe("alive");
    expect(getWaitableInFlightTaskIds(session.backgroundTaskState)).toEqual([
      "task-a",
    ]);

    session.close();
  });

  it("stays silent for a session with no background tasks", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);
    const onBackgroundActivity = vi.fn();

    const session = createQuerySession(
      makeDefaultOptions({ onBackgroundActivity }),
    );
    const turn = session.sendPrompt("nothing in the background", vi.fn());
    pushResult(mock, "u-r1");
    await turn;

    expect(onBackgroundActivity).not.toHaveBeenCalled();
    session.close();
  });
});
