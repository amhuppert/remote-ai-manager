/**
 * Integration tests for the persistent QuerySession lifecycle.
 *
 * These tests verify multi-turn subprocess reuse, crash recovery,
 * and backward compatibility with queueMessage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Mock the SDK and registry (use real registry for integration tests)
// ---------------------------------------------------------------------------

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("@/lib/shared/sdk-env", () => ({}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createQuerySession, type QuerySessionOptions } from "./query-session";
import { isUndeliveredQuerySessionError } from "./query-session-errors";

// ---------------------------------------------------------------------------
// Helpers — controllable mock Query
// ---------------------------------------------------------------------------

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
    pushMessage(msg: SDKMessage) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: msg, done: false });
      } else {
        messages.push(msg);
      }
    },
    crashPump(err: Error) {
      if (rejectNext) {
        const r = rejectNext;
        rejectNext = null;
        r(err);
      }
    },
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
    conversationId: "conv-integration",
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
    idleTtlMs: 0, // Disable idle TTL for tests
    ...overrides,
  };
}

function makeResultMessage(sessionId: string, uuid: string) {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid,
    total_cost_usd: 0.01,
    duration_ms: 100,
    num_turns: 1,
    result: "",
    is_error: false,
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Multi-turn subprocess reuse", () => {
  it("two consecutive prompts reuse the same session (one SDK query call)", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    // First prompt
    const turn1 = session.sendPrompt("First prompt", emit);
    mock.pushMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      uuid: "u1",
    } as unknown as SDKMessage);
    mock.pushMessage(makeResultMessage("sess-1", "u2"));
    const result1 = await turn1;

    // Verify session is still alive
    expect(session.status).toBe("alive");
    expect(result1.sessionId).toBe("sess-1");

    // Second prompt — same session, same subprocess, same input channel.
    // streamInput must never be used: the SDK closes the CLI's stdin when a
    // streamInput iterable completes.
    const turn2 = session.sendPrompt("Second prompt", emit);
    expect(mock.query.streamInput).not.toHaveBeenCalled();

    mock.pushMessage(makeResultMessage("sess-1", "u3"));
    const result2 = await turn2;

    expect(result2.sessionId).toBe("sess-1");
    expect(session.status).toBe("alive");

    // Only one query() call (not two)
    expect(queryMock).toHaveBeenCalledTimes(1);

    session.close();
  });

  it("raw Query object is accessible for control-plane requests", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    expect(session.query).toBe(mock.query);

    session.close();
  });
});

describe("Crash recovery", () => {
  it("crash during turn rejects promise and marks session dead", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turnPromise = session.sendPrompt("Will crash", emit);
    mock.crashPump(new Error("Subprocess died"));

    await expect(turnPromise).rejects.toThrow("Subprocess died");
    expect(session.status).toBe("dead");
  });

  it("after crash, creating a new session for same conversation works", async () => {
    const mock1 = createControllableMockQuery();
    queryMock.mockReturnValue(mock1.query);

    const session1 = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();
    const turn1 = session1.sendPrompt("Crash me", emit);
    mock1.crashPump(new Error("crash"));
    try {
      await turn1;
    } catch {
      // expected
    }
    expect(session1.status).toBe("dead");

    // Create fresh session (simulates what executePromptStream does)
    const mock2 = createControllableMockQuery();
    queryMock.mockReturnValue(mock2.query);

    const session2 = createQuerySession(
      makeDefaultOptions({ resume: "sess-1" }),
    );
    expect(session2.status).toBe("alive");

    const turn2 = session2.sendPrompt("Recovered", emit);
    mock2.pushMessage(makeResultMessage("sess-2", "u1"));
    const result = await turn2;
    expect(result.sessionId).toBe("sess-2");

    session2.close();
  });

  it("after pump completion between turns, creating a new session works", async () => {
    const mock1 = createControllableMockQuery();
    queryMock.mockReturnValue(mock1.query);

    const session1 = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    const turn1 = session1.sendPrompt("First", emit);
    mock1.pushMessage(makeResultMessage("sess-1", "u1"));
    await turn1;

    // The second prompt sits undelivered in the input channel when the pump dies
    const turn2 = session1.sendPrompt("Second", emit);
    mock1.endPump();

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

    expect(session1.status).toBe("dead");

    const mock2 = createControllableMockQuery();
    queryMock.mockReturnValue(mock2.query);

    const session2 = createQuerySession(
      makeDefaultOptions({ resume: "sess-1" }),
    );
    const turn3 = session2.sendPrompt("Recovered", emit);
    mock2.pushMessage(makeResultMessage("sess-2", "u2"));

    const result = await turn3;
    expect(result.sessionId).toBe("sess-2");

    session2.close();
  });
});

describe("Session deletion cleanup", () => {
  it("close terminates session", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    session.close();
    expect(session.status).toBe("dead");
    expect(mock.query.close).toHaveBeenCalled();
  });
});

describe("Per-turn autonomous flag", () => {
  it("sendPrompt with autonomous flag sets currentTurnOptions", async () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    const emit = vi.fn();

    // Send with autonomous=true
    const turn = session.sendPrompt("Autonomous task", emit, {
      autonomous: true,
    });

    // currentTurnOptions should be set
    expect(session.currentTurnOptions).toEqual({ autonomous: true });

    mock.pushMessage(makeResultMessage("sess-1", "u1"));
    await turn;

    // After turn completes, currentTurnOptions should be cleared
    expect(session.currentTurnOptions).toBeNull();

    session.close();
  });
});

import { _setSdkQueryForTesting } from "./query-session";
import { captureResult, scriptedCaptureSdk } from "./capture-test-support";
import { randomUUID } from "node:crypto";

it("keeps the same capture input pending across a foreign zero-turn result", async () => {
  const uuid = randomUUID();
  const observed: string[] = [];
  _setSdkQueryForTesting(
    scriptedCaptureSdk((user, emit) => {
      expect(user.uuid).toBe(uuid);
      emit(captureResult("lost-background-notice", "notice", 0));
      emit(captureResult(user.uuid, "correlated"));
    }),
  );
  const session = createQuerySession(makeDefaultOptions());
  try {
    const result = await session.sendPrompt(
      "capture",
      (event, data) => {
        if (
          event === "__raw_message" &&
          typeof data === "object" &&
          data !== null &&
          "type" in data
        )
          observed.push(String(data.type));
      },
      { captureInputUuid: uuid },
    );
    expect(result.finalText).toBe("correlated");
    expect(result.numTurns).toBe(1);
    expect(observed).toEqual(["result", "result"]);
  } finally {
    session.close();
    _setSdkQueryForTesting(null);
  }
});

it("awaits pump shutdown even when child collection has already completed", async () => {
  const pump = Promise.withResolvers<void>();
  _setSdkQueryForTesting(
    scriptedCaptureSdk((user, emit) => emit(captureResult(user.uuid)), {
      childCompletion: Promise.resolve(),
      pumpCompletion: pump.promise,
    }),
  );
  const session = createQuerySession(makeDefaultOptions());
  try {
    await session.sendPrompt("capture", () => {}, {
      captureInputUuid: randomUUID(),
    });
    session.close();
    let collected = false;
    const wait = session.awaitClosed().then(() => {
      collected = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collected).toBe(false);
    pump.resolve();
    await wait;
    expect(collected).toBe(true);
  } finally {
    pump.resolve();
    session.close();
    _setSdkQueryForTesting(null);
  }
});
