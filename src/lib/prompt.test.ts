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
  getConversationMock,
  createConversationMock,
  execInContainerMock,
  buildContainerEnvMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  getSessionMock: vi.fn(),
  updateSessionMock: vi.fn(),
  readConfigMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  getConversationMock: vi.fn(),
  createConversationMock: vi.fn(),
  execInContainerMock: vi.fn(),
  buildContainerEnvMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./devcontainer", () => ({
  execInContainer: execInContainerMock,
  buildContainerEnv: buildContainerEnvMock,
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

vi.mock("./conversations", () => ({
  getConversation: getConversationMock,
  createConversation: createConversationMock,
  encodeProjectPath: (p: string) => "-" + p.slice(1).replace(/[/.]/g, "-"),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import { executePromptStream } from "./prompt";
import type { SessionState } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-123",
    name: null,
    claudeSessionId: null,
    transcriptPath: null,
    status: "ready" as const,
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "csm" as const,
    summary: null,
    archived: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "test-session",
    worktreePath: "/projects/repo/.worktrees/test-session",
    branchName: "csm/test-session",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "csm" as const,
    containerId: "test-container-abc123",
    containerStatus: "running" as const,
    containerError: null,
    claudeHostDir: "/home/user/.config/csm/containers/test-session-abc123",
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

/** Deep-copy snapshots of each updateSession call (avoids shared-ref mutation) */
let updateSnapshots: SessionState[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  readConfigMock.mockResolvedValue(defaultConfig);
  updateSnapshots = [];

  const releaseMock = vi.fn();
  acquireSessionLockMock.mockReturnValue(releaseMock);

  // Mock conversation creation
  const conversation = makeConversation();
  createConversationMock.mockResolvedValue(conversation);
  getConversationMock.mockResolvedValue(conversation);

  // getSession returns the session with the conversation for mutation tracking
  const session = makeSession();
  session.conversations = [conversation];
  getSessionMock.mockImplementation(() => Promise.resolve(session));
  updateSessionMock.mockImplementation((_path: string, s: SessionState) => {
    updateSnapshots.push(JSON.parse(JSON.stringify(s)));
    return Promise.resolve();
  });

  // Mock devcontainer functions: execInContainer delegates to spawnMock
  execInContainerMock.mockImplementation(
    (_projectPath: string, _worktreePath: string, _command: string[], _env: Record<string, string>) => {
      return spawnMock();
    },
  );
  buildContainerEnvMock.mockReturnValue({
    ANTHROPIC_API_KEY: "test-key",
    CSM_PROJECT_PATH: "/projects/repo",
    CSM_SESSION_NAME: "test-session",
    DEVCONTAINER: "true",
  });
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

  it("updates conversation metadata on completion with content", async () => {
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

    // updateSession should be called at least 3 times:
    // 1. status -> running
    // 2. promptCount++ and claudeSessionId
    // 3. status -> ready (finally block)
    expect(updateSnapshots.length).toBeGreaterThanOrEqual(3);

    // First snapshot: conversation status should be "running"
    expect(updateSnapshots[0]!.conversations[0]!.status).toBe("running");

    // Second snapshot should have conversation promptCount incremented
    expect(updateSnapshots[1]!.conversations[0]!.promptCount).toBe(1);

    // Last snapshot: conversation status should be "ready"
    const last = updateSnapshots[updateSnapshots.length - 1]!;
    expect(last.conversations[0]!.status).toBe("ready");
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

  it("resets conversation status to ready in finally block", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    // Last snapshot should set conversation status to "ready"
    const last = updateSnapshots[updateSnapshots.length - 1]!;
    expect(last.conversations[0]!.status).toBe("ready");
  });

  it("uses --resume for existing conversation with claudeSessionId", async () => {
    const convo = makeConversation({ claudeSessionId: "existing-session-id" });
    getConversationMock.mockResolvedValue(convo);

    const session = makeSession({
      containerId: "abc123",
      containerStatus: "running",
    });
    session.conversations = [convo];
    getSessionMock.mockImplementation(() => Promise.resolve(session));

    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream(
      "/projects/repo",
      session,
      "follow-up",
      vi.fn(),
      convo.id,
    );

    // execInContainer is called with (projectPath, worktreePath, command[], env)
    const [,, command] = execInContainerMock.mock.calls[0]! as [string, string, string[], Record<string, string>];
    expect(command[0]).toBe("claude");
    expect(command).toContain("--resume");
    expect(command).toContain("existing-session-id");
    expect(command).toContain("--output-format");
    expect(command).toContain("stream-json");
  });

  it("does not use --resume for new conversation", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    const session = makeSession({
      containerId: "abc123",
      containerStatus: "running",
    });
    getSessionMock.mockImplementation(() => Promise.resolve(session));

    await executePromptStream(
      "/projects/repo",
      session,
      "first prompt",
      vi.fn(),
    );

    // execInContainer is called with (projectPath, worktreePath, command[], env)
    const [,, command] = execInContainerMock.mock.calls[0]! as [string, string, string[], Record<string, string>];
    expect(command).not.toContain("--resume");
  });

  it("throws when session has no container", async () => {
    await expect(
      executePromptStream(
        "/projects/repo",
        makeSession({ containerId: null, containerStatus: "none" }),
        "test prompt",
        vi.fn(),
      ),
    ).rejects.toThrow("No container has been created for this session");
  });

  it("throws when container is not running", async () => {
    await expect(
      executePromptStream(
        "/projects/repo",
        makeSession({ containerId: "abc123", containerStatus: "stopped" }),
        "test prompt",
        vi.fn(),
      ),
    ).rejects.toThrow("Container is not running (status: stopped)");
  });

  it("closes stdin immediately", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("returns conversationId", async () => {
    const child = createMockChild([]);
    spawnMock.mockReturnValue(child);

    const result = await executePromptStream(
      "/projects/repo",
      makeSession(),
      "test",
      vi.fn(),
    );

    expect(result.conversationId).toBe("conv-123");
  });

  it("sets claudeSessionId from stream events", async () => {
    const lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-abc-456",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "response" }],
        },
      }),
    ];
    const child = createMockChild(lines);
    spawnMock.mockReturnValue(child);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    // The metadata update snapshot should have the claude session ID
    const metadataSnapshot = updateSnapshots.find(
      (s) => s.conversations[0]!.claudeSessionId === "sess-abc-456",
    );
    expect(metadataSnapshot).toBeTruthy();
  });

  it("updates lastActivityAt on conversation mutations", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "response" }],
        },
      }),
    ];
    const child = createMockChild(lines);
    spawnMock.mockReturnValue(child);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    // All snapshots should have lastActivityAt set
    for (const snapshot of updateSnapshots) {
      expect(snapshot.lastActivityAt).toBeTruthy();
      // Should be a valid ISO string (not the original fixture timestamp)
      expect(new Date(snapshot.lastActivityAt).getTime()).toBeGreaterThan(
        new Date("2024-01-01T00:00:00Z").getTime(),
      );
    }
  });
});
