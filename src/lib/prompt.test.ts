import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  spawnMock,
  getSessionMock,
  updateSessionMock,
  readConfigMock,
  acquireSessionLockMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  getSessionMock: vi.fn(),
  updateSessionMock: vi.fn(),
  readConfigMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./state", () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}));

vi.mock("./config", () => ({
  readConfig: readConfigMock,
}));

vi.mock("./lock", () => ({
  acquireSessionLock: acquireSessionLockMock,
}));

// Mock logging
vi.mock("./logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import { executePromptStream } from "./prompt";
import type { SessionState } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "test-session",
    worktreePath: "/projects/repo/.worktrees/test-session",
    branchName: "csm/test-session",
    claudeSessionId: null,
    transcriptPath: null,
    status: "ready",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    promptCount: 0,
    archived: false,
    finished: false,
    messages: [],
    ...overrides,
  };
}

interface MockChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

/**
 * Create a mock child process that emits stream-json lines then closes.
 * Lines are written to stdout, then the process emits 'close' with the given code.
 */
function createMockChild(lines: string[] = [], exitCode = 0): MockChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  child.pid = 12345;

  // Schedule writing lines and closing after a microtask
  queueMicrotask(() => {
    for (const line of lines) {
      stdout.write(line + "\n");
    }
    stdout.end();
    // Emit close after stdout is fully consumed
    setTimeout(() => {
      child.emit("close", exitCode);
    }, 10);
  });

  return child;
}

const defaultConfig = {
  baseDir: "/tmp/projects",
  ignorePatterns: [],
  stateFilePath: "/tmp/csm/state.json",
  claudeTimeoutMs: 300_000,
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  readConfigMock.mockResolvedValue(defaultConfig);

  const releaseMock = vi.fn();
  acquireSessionLockMock.mockReturnValue(releaseMock);

  getSessionMock.mockImplementation(() => Promise.resolve(makeSession()));
  updateSessionMock.mockResolvedValue(undefined);
});

// ===========================================================================
// Tests for executePromptStream
// ===========================================================================

describe("executePromptStream", () => {
  it("emits init event from system message", async () => {
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-123",
      }),
    ];
    const child = createMockChild(lines);
    spawnMock.mockReturnValue(child);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello Claude",
      emit,
    );

    expect(events.find(([e]) => e === "init")).toEqual([
      "init",
      { sessionId: "sess-123" },
    ]);
  });

  it("emits content events for text blocks", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello!" }],
        },
      }),
    ];
    const child = createMockChild(lines);
    spawnMock.mockReturnValue(child);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "Hi", emit);

    const contentEvents = events.filter(([e]) => e === "content");
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0]![1]).toEqual({ type: "text", text: "Hello!" });
  });

  it("emits content events for tool_use blocks", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      }),
    ];
    const child = createMockChild(lines);
    spawnMock.mockReturnValue(child);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Read a.ts",
      emit,
    );

    const contentEvents = events.filter(([e]) => e === "content");
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0]![1]).toEqual({
      type: "tool_use",
      name: "Read",
      input: { file_path: "a.ts" },
    });
  });

  it("stores accumulated content blocks as assistant message on completion", async () => {
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-abc",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check..." },
            { type: "tool_use", name: "Read", input: { file_path: "x.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the result." }],
        },
      }),
    ];
    const child = createMockChild(lines);
    spawnMock.mockReturnValue(child);

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Help me",
      vi.fn(),
    );

    // Find the updateSession call that stored the assistant message
    const assistantCall = updateSessionMock.mock.calls.find(
      (call: unknown[]) => {
        const s = call[1] as SessionState;
        return s.messages.some((m: { role: string }) => m.role === "assistant");
      },
    );
    expect(assistantCall).toBeTruthy();

    const stored = (assistantCall![1] as SessionState).messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(stored!.content).toEqual([
      { type: "text", text: "Let me check..." },
      { type: "tool_use", name: "Read", input: { file_path: "x.ts" } },
      { type: "text", text: "Here is the result." },
    ]);
  });

  it("stores user message in block format", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "My prompt",
      vi.fn(),
    );

    // First updateSession call stores the user message
    const firstUpdate = updateSessionMock.mock.calls[0]![1] as SessionState;
    const userMsg = firstUpdate.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toEqual([{ type: "text", text: "My prompt" }]);
  });

  it("handles non-zero exit with accumulated content", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Partial response" }],
        },
      }),
    ];
    const child = createMockChild(lines, 1);
    spawnMock.mockReturnValue(child);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    // Should still store the response
    const assistantCall = updateSessionMock.mock.calls.find(
      (call: unknown[]) => {
        const s = call[1] as SessionState;
        return s.messages.some((m: { role: string }) => m.role === "assistant");
      },
    );
    expect(assistantCall).toBeTruthy();

    // Should emit done, not error (since there is content)
    expect(events.find(([e]) => e === "error")).toBeUndefined();
    expect(events.find(([e]) => e === "done")).toBeTruthy();
  });

  it("emits error event for non-zero exit with no content", async () => {
    const child = createMockChild([], 1);
    spawnMock.mockReturnValue(child);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    const errorEvent = events.find(([e]) => e === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent![1] as { message: string }).message).toContain(
      "exited with code 1",
    );
  });

  it("always emits done event", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    expect(events.find(([e]) => e === "done")).toBeTruthy();
  });

  it("acquires and releases the session lock", async () => {
    const releaseMock = vi.fn();
    acquireSessionLockMock.mockReturnValue(releaseMock);
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    expect(acquireSessionLockMock).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("resets session status to ready in finally block", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    // Last updateSession call should set status to "ready"
    const lastCallIdx = updateSessionMock.mock.calls.length - 1;
    const lastUpdate = updateSessionMock.mock.calls[
      lastCallIdx
    ]![1] as SessionState;
    expect(lastUpdate.status).toBe("ready");
  });

  it("uses -c flag for subsequent prompts", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream(
      "/projects/repo",
      makeSession({ promptCount: 3 }),
      "follow-up",
      vi.fn(),
    );

    const [cmd, args] = spawnMock.mock.calls[0]! as [string, string[]];
    expect(cmd).toBe("claude");
    expect(args).toContain("-c");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("does not use -c flag for first prompt", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream(
      "/projects/repo",
      makeSession({ promptCount: 0 }),
      "first prompt",
      vi.fn(),
    );

    const [, args] = spawnMock.mock.calls[0]! as [string, string[]];
    expect(args).not.toContain("-c");
  });

  it("closes stdin immediately", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    expect(child.stdin.end).toHaveBeenCalled();
  });
});
