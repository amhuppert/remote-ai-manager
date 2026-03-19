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

vi.mock("@/lib/sdk-env", () => ({}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createQuerySession, type QuerySessionOptions } from "./query-session";
import {
  getSession,
  closeAllSessions,
  _resetForTesting as resetRegistry,
} from "./query-session-registry";

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
  resetRegistry();
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

    // Second prompt — same session, same subprocess
    const turn2 = session.sendPrompt("Second prompt", emit);

    // streamInput should have been called for the second prompt
    expect(mock.query.streamInput).toHaveBeenCalledTimes(1);

    mock.pushMessage(makeResultMessage("sess-1", "u3"));
    const result2 = await turn2;

    expect(result2.sessionId).toBe("sess-1");
    expect(session.status).toBe("alive");

    // Only one query() call (not two)
    expect(queryMock).toHaveBeenCalledTimes(1);

    session.close();
  });

  it("session is retrievable from registry after creation", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(
      makeDefaultOptions({ conversationId: "conv-reg-test" }),
    );

    const retrieved = getSession("conv-reg-test");
    expect(retrieved).toBe(session);

    session.close();
  });

  it("raw Query object is accessible for queueMessage compatibility", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());

    // The query property should expose the SDK Query for streamInput
    expect(session.query).toBe(mock.query);
    expect(session.query.streamInput).toBeDefined();

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
    expect(getSession("conv-integration")).toBeUndefined();
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
});

describe("Session deletion cleanup", () => {
  it("close terminates session and removes from registry", () => {
    const mock = createControllableMockQuery();
    queryMock.mockReturnValue(mock.query);

    const session = createQuerySession(makeDefaultOptions());
    expect(getSession("conv-integration")).toBe(session);

    session.close();
    expect(session.status).toBe("dead");
    expect(getSession("conv-integration")).toBeUndefined();
    expect(mock.query.close).toHaveBeenCalled();
  });

  it("closeAllSessions terminates all active sessions", () => {
    const mock1 = createControllableMockQuery();
    const mock2 = createControllableMockQuery();

    queryMock.mockReturnValueOnce(mock1.query).mockReturnValueOnce(mock2.query);

    const s1 = createQuerySession(
      makeDefaultOptions({ conversationId: "conv-1" }),
    );
    const s2 = createQuerySession(
      makeDefaultOptions({ conversationId: "conv-2" }),
    );

    expect(getSession("conv-1")).toBe(s1);
    expect(getSession("conv-2")).toBe(s2);

    closeAllSessions();

    expect(getSession("conv-1")).toBeUndefined();
    expect(getSession("conv-2")).toBeUndefined();
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
