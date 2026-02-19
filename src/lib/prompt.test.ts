import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  execFileMock,
  getSessionMock,
  updateSessionMock,
  readConfigMock,
  acquireSessionLockMock,
  getConversationMock,
  createConversationMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getSessionMock: vi.fn(),
  updateSessionMock: vi.fn(),
  readConfigMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  getConversationMock: vi.fn(),
  createConversationMock: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => execFileMock,
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

vi.mock("./conversations", () => ({
  getConversation: getConversationMock,
  createConversation: createConversationMock,
  encodeProjectPath: (p: string) => "-" + p.slice(1).replace(/[/.]/g, "-"),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import { executePrompt } from "./prompt";
import type { SessionState } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    ...overrides,
  };
}

function makeConversation() {
  return {
    id: "conv-123",
    claudeSessionId: null,
    transcriptPath: null,
    status: "ready" as const,
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "csm" as const,
    summary: null,
    archived: false,
  };
}

function makeJsonOutput(
  result = "Claude output here",
  sessionId = "sess-abc-123",
): string {
  return JSON.stringify({ result, session_id: sessionId });
}

const defaultConfig = {
  baseDir: "/tmp/projects",
  ignorePatterns: [],
  stateFilePath: "/tmp/csm/state.json",
  claudeTimeoutMs: 300_000,
};

function mockExecFileSuccess(stdout?: string) {
  const output = stdout ?? makeJsonOutput();
  execFileMock.mockImplementation(() => {
    const promise = Promise.resolve({ stdout: output, stderr: "" }) as
      Promise<{ stdout: string; stderr: string }> & { child: { stdin: { end: () => void } } };
    // promisify(execFile) attaches .child on the promise object itself
    promise.child = { stdin: { end: vi.fn() } };
    return promise;
  });
}

function mockExecFileFailure(error: Error) {
  execFileMock.mockImplementation(() => {
    const promise = Promise.reject(error) as
      Promise<never> & { child: { stdin: { end: () => void } } };
    // promisify(execFile) attaches .child on the promise object itself
    promise.child = { stdin: { end: vi.fn() } };
    return promise;
  });
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/** Deep-copy snapshots of each updateSession call (avoids shared-ref mutation) */
let updateSnapshots: SessionState[] = [];

beforeEach(() => {
  vi.clearAllMocks();
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
});

// ===========================================================================
// 2.3 – Prompt execution lifecycle (Req 1.1, 1.2, 1.5, 4.1, 4.2, 4.4, 2.3)
// ===========================================================================

describe("executePrompt", () => {
  it("returns CLI stdout and parsed response on success", async () => {
    const jsonOut = makeJsonOutput("Hello from Claude", "sess-123");
    mockExecFileSuccess(jsonOut);
    const result = await executePrompt(
      "/projects/repo",
      makeSession(),
      "What is 2+2?",
    );
    expect(result.output).toBe(jsonOut);
    expect(result.claudeResponse).toBe("Hello from Claude");
  });

  it("transitions status to running then back to ready", async () => {
    mockExecFileSuccess();
    await executePrompt("/projects/repo", makeSession(), "test prompt");

    // updateSession should be called at least 3 times:
    // 1. status -> running
    // 2. promptCount++
    // 3. status -> ready (finally block)
    expect(updateSnapshots.length).toBeGreaterThanOrEqual(3);

    // First snapshot: conversation status should be "running"
    expect(updateSnapshots[0]!.conversations[0]!.status).toBe("running");

    // Last snapshot: conversation status should be "ready"
    const last = updateSnapshots[updateSnapshots.length - 1]!;
    expect(last.conversations[0]!.status).toBe("ready");
  });

  it("increments promptCount by one on success", async () => {
    mockExecFileSuccess();
    await executePrompt(
      "/projects/repo",
      makeSession(),
      "test",
    );

    // Second snapshot should have conversation promptCount incremented
    expect(updateSnapshots[1]!.conversations[0]!.promptCount).toBe(1);
  });

  it("updates lastActivityAt on each state mutation", async () => {
    mockExecFileSuccess();
    await executePrompt("/projects/repo", makeSession(), "test");

    // All snapshots should have lastActivityAt set
    for (const snapshot of updateSnapshots) {
      expect(snapshot.lastActivityAt).toBeTruthy();
      // Should be a valid ISO string (not the original fixture timestamp)
      expect(new Date(snapshot.lastActivityAt).getTime()).toBeGreaterThan(
        new Date("2024-01-01T00:00:00Z").getTime(),
      );
    }
  });

  it("acquires and releases the session lock", async () => {
    mockExecFileSuccess();
    const releaseMock = vi.fn();
    acquireSessionLockMock.mockReturnValue(releaseMock);

    await executePrompt("/projects/repo", makeSession(), "test");

    expect(acquireSessionLockMock).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // 2.4 – Conversation continuity and CLI configuration (Req 2.1, 2.2, 1.2–1.4, 5.1, 5.3)
  // =========================================================================

  it("invokes CLI without --resume on new conversation", async () => {
    mockExecFileSuccess();
    await executePrompt(
      "/projects/repo",
      makeSession(),
      "first prompt",
    );

    const cliCall = execFileMock.mock.calls[0]!;
    const args = cliCall[1] as string[];
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args).toContain("-p");
    expect(args).toContain("first prompt");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("50");
  });

  it("invokes CLI with --resume on existing conversation", async () => {
    // Mock conversation with an existing Claude session ID
    const convo = { ...makeConversation(), claudeSessionId: "existing-session-id" };
    getConversationMock.mockResolvedValue(convo);

    // Set up session with this conversation
    const session = makeSession();
    session.conversations = [convo];
    getSessionMock.mockImplementation(() => Promise.resolve(session));

    mockExecFileSuccess();
    await executePrompt(
      "/projects/repo",
      session,
      "follow-up",
      convo.id,
    );

    const cliCall = execFileMock.mock.calls[0]!;
    const args = cliCall[1] as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("existing-session-id");
    expect(args).not.toContain("--session-id");
    expect(args).toContain("-p");
    expect(args).toContain("follow-up");
  });

  it("sets working directory to worktree path", async () => {
    mockExecFileSuccess();
    await executePrompt(
      "/projects/repo",
      makeSession({ worktreePath: "/projects/repo/.worktrees/my-session" }),
      "test",
    );

    const cliCall = execFileMock.mock.calls[0]!;
    const opts = cliCall[2] as { cwd: string };
    expect(opts.cwd).toBe("/projects/repo/.worktrees/my-session");
  });

  it("does not set CI environment variable", async () => {
    mockExecFileSuccess();
    await executePrompt("/projects/repo", makeSession(), "test");

    const cliCall = execFileMock.mock.calls[0]!;
    const opts = cliCall[2] as { env: Record<string, string> };
    expect(opts.env.CI).toBeUndefined();
  });

  it("filters out CLAUDE-prefixed environment variables", async () => {
    process.env.CLAUDE_CODE_SSE_PORT = "12345";
    process.env.CLAUDECODE = "true";
    try {
      mockExecFileSuccess();
      await executePrompt("/projects/repo", makeSession(), "test");

      const cliCall = execFileMock.mock.calls[0]!;
      const opts = cliCall[2] as { env: Record<string, string> };
      expect(opts.env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
      expect(opts.env.CLAUDECODE).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_SSE_PORT;
      delete process.env.CLAUDECODE;
    }
  });

  it("uses claudeTimeoutMs from config and sets 10MB maxBuffer", async () => {
    readConfigMock.mockResolvedValue({
      ...defaultConfig,
      claudeTimeoutMs: 60_000,
    });
    mockExecFileSuccess();
    await executePrompt("/projects/repo", makeSession(), "test");

    const cliCall = execFileMock.mock.calls[0]!;
    const opts = cliCall[2] as { timeout: number; maxBuffer: number };
    expect(opts.timeout).toBe(60_000);
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
  });

  // =========================================================================
  // Session ID and transcript path from JSON output
  // =========================================================================

  it("sets claudeSessionId from JSON output", async () => {
    mockExecFileSuccess(makeJsonOutput("response", "sess-abc-456"));
    await executePrompt("/projects/repo", makeSession(), "test");

    expect(updateSnapshots[1]!.conversations[0]!.claudeSessionId).toBe("sess-abc-456");
  });

  it("falls back to raw stdout when JSON parsing fails", async () => {
    mockExecFileSuccess("plain text response");
    const result = await executePrompt("/projects/repo", makeSession(), "test");

    expect(result.claudeResponse).toBe("plain text response");
  });

  // =========================================================================
  // 2.5 – Error recovery and timeout handling (Req 6.1–6.4, 4.3, 5.2)
  // =========================================================================

  it("wraps CLI error with 'Prompt execution failed:' prefix", async () => {
    mockExecFileFailure(new Error("CLI crashed"));
    await expect(
      executePrompt("/projects/repo", makeSession(), "test"),
    ).rejects.toThrow("Prompt execution failed: CLI crashed");
  });

  it("resets conversation status to ready after failure", async () => {
    mockExecFileFailure(new Error("CLI crashed"));
    try {
      await executePrompt("/projects/repo", makeSession(), "test");
    } catch {
      // expected
    }

    // Last snapshot should set conversation status to "ready"
    const last = updateSnapshots[updateSnapshots.length - 1]!;
    expect(last.conversations[0]!.status).toBe("ready");
  });

  it("releases lock after failure", async () => {
    const releaseMock = vi.fn();
    acquireSessionLockMock.mockReturnValue(releaseMock);
    mockExecFileFailure(new Error("CLI crashed"));

    try {
      await executePrompt("/projects/repo", makeSession(), "test");
    } catch {
      // expected
    }

    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("does not increment promptCount on failure", async () => {
    mockExecFileFailure(new Error("CLI crashed"));
    try {
      await executePrompt(
        "/projects/repo",
        makeSession(),
        "test",
      );
    } catch {
      // expected
    }

    // No snapshot should have incremented conversation promptCount
    for (const snapshot of updateSnapshots) {
      const convo = snapshot.conversations[0];
      // promptCount should remain 0 (never incremented on failure)
      if (convo) {
        expect(convo.promptCount).toBe(0);
      }
    }
  });

  it("releases lock even when status recovery fails (best-effort)", async () => {
    const releaseMock = vi.fn();
    acquireSessionLockMock.mockReturnValue(releaseMock);
    mockExecFileFailure(new Error("CLI crashed"));

    // Make the final status reset call fail
    let callCount = 0;
    updateSessionMock.mockImplementation((_path: string, s: SessionState) => {
      callCount++;
      updateSnapshots.push(JSON.parse(JSON.stringify(s)));
      // Fail on the finally-block status reset (the second updateSession call)
      if (callCount >= 2) {
        return Promise.reject(new Error("state write failed"));
      }
      return Promise.resolve();
    });

    await expect(
      executePrompt("/projects/repo", makeSession(), "test"),
    ).rejects.toThrow("Prompt execution failed: CLI crashed");

    // Lock should still be released
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("handles timeout errors with proper cleanup", async () => {
    const timeoutError = new Error("Command timed out");
    (timeoutError as NodeJS.ErrnoException).code =
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    mockExecFileFailure(timeoutError);

    const releaseMock = vi.fn();
    acquireSessionLockMock.mockReturnValue(releaseMock);

    await expect(
      executePrompt("/projects/repo", makeSession(), "long prompt"),
    ).rejects.toThrow("Prompt execution failed:");

    // Lock released and conversation status reset
    expect(releaseMock).toHaveBeenCalledTimes(1);
    const last = updateSnapshots[updateSnapshots.length - 1]!;
    expect(last.conversations[0]!.status).toBe("ready");
  });
});
