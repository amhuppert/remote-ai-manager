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
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getSessionMock: vi.fn(),
  updateSessionMock: vi.fn(),
  readConfigMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
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
    claudeSessionId: null,
    transcriptPath: null,
    status: "ready",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    promptCount: 0,
    archived: false,
    messages: [],
    ...overrides,
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
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (cb) {
        cb(null, { stdout: output, stderr: "" });
      }
    },
  );
}

function mockExecFileFailure(error: Error) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (cb) {
        cb(error, { stdout: "", stderr: "" });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  readConfigMock.mockResolvedValue(defaultConfig);

  const releaseMock = vi.fn();
  acquireSessionLockMock.mockReturnValue(releaseMock);

  // getSession returns the session for mutation tracking
  getSessionMock.mockImplementation(() => Promise.resolve(makeSession()));
  updateSessionMock.mockResolvedValue(undefined);
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
    expect(updateSessionMock).toHaveBeenCalled();

    // First update call: status should be "running"
    const firstUpdate = updateSessionMock.mock.calls[0]![1] as SessionState;
    expect(firstUpdate.status).toBe("running");

    // Last update call: status should be "ready"
    const lastCallIdx = updateSessionMock.mock.calls.length - 1;
    const lastUpdate = updateSessionMock.mock.calls[
      lastCallIdx
    ]![1] as SessionState;
    expect(lastUpdate.status).toBe("ready");
  });

  it("increments promptCount by one on success", async () => {
    mockExecFileSuccess();
    await executePrompt(
      "/projects/repo",
      makeSession({ promptCount: 0 }),
      "test",
    );

    // Second updateSession call should have promptCount incremented
    const secondUpdate = updateSessionMock.mock.calls[1]![1] as SessionState;
    expect(secondUpdate.promptCount).toBe(1);
  });

  it("updates lastActivityAt on each state mutation", async () => {
    mockExecFileSuccess();
    await executePrompt("/projects/repo", makeSession(), "test");

    // All updateSession calls should have lastActivityAt set
    for (const call of updateSessionMock.mock.calls) {
      const session = call[1] as SessionState;
      expect(session.lastActivityAt).toBeTruthy();
      // Should be a valid ISO string (not the original fixture timestamp)
      expect(new Date(session.lastActivityAt).getTime()).toBeGreaterThan(
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

  it("invokes CLI without -c flag on first prompt (promptCount=0)", async () => {
    mockExecFileSuccess();
    await executePrompt(
      "/projects/repo",
      makeSession({ promptCount: 0 }),
      "first prompt",
    );

    const cliCall = execFileMock.mock.calls[0]!;
    const args = cliCall[1] as string[];
    expect(args).not.toContain("-c");
    expect(args).toContain("-p");
    expect(args).toContain("first prompt");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("50");
  });

  it("invokes CLI with -c flag on subsequent prompts (promptCount>0)", async () => {
    mockExecFileSuccess();
    await executePrompt(
      "/projects/repo",
      makeSession({ promptCount: 3 }),
      "follow-up",
    );

    const cliCall = execFileMock.mock.calls[0]!;
    const args = cliCall[1] as string[];
    expect(args).toContain("-c");
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
  // Message storage and session ID from JSON output
  // =========================================================================

  it("stores user message in session state before execution", async () => {
    mockExecFileSuccess();
    await executePrompt("/projects/repo", makeSession(), "Hello Claude");

    // First updateSession call sets status=running and appends user message
    const firstUpdate = updateSessionMock.mock.calls[0]![1] as SessionState;
    expect(firstUpdate.status).toBe("running");
    expect(firstUpdate.messages).toHaveLength(1);
    expect(firstUpdate.messages[0]!.role).toBe("user");
    expect(firstUpdate.messages[0]!.content).toBe("Hello Claude");
  });

  it("stores assistant response in session state after execution", async () => {
    mockExecFileSuccess(makeJsonOutput("I am Claude", "sess-xyz"));
    await executePrompt("/projects/repo", makeSession(), "Hi");

    // Second updateSession call (promptCount++ / assistant message)
    const secondUpdate = updateSessionMock.mock.calls[1]![1] as SessionState;
    expect(secondUpdate.messages).toHaveLength(1);
    expect(secondUpdate.messages[0]!.role).toBe("assistant");
    expect(secondUpdate.messages[0]!.content).toBe("I am Claude");
  });

  it("sets claudeSessionId from JSON output", async () => {
    mockExecFileSuccess(makeJsonOutput("response", "sess-abc-456"));
    await executePrompt("/projects/repo", makeSession(), "test");

    const secondUpdate = updateSessionMock.mock.calls[1]![1] as SessionState;
    expect(secondUpdate.claudeSessionId).toBe("sess-abc-456");
  });

  it("falls back to raw stdout when JSON parsing fails", async () => {
    mockExecFileSuccess("plain text response");
    const result = await executePrompt(
      "/projects/repo",
      makeSession(),
      "test",
    );

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

  it("resets session status to ready after failure", async () => {
    mockExecFileFailure(new Error("CLI crashed"));
    try {
      await executePrompt("/projects/repo", makeSession(), "test");
    } catch {
      // expected
    }

    // Last updateSession call should set status to "ready"
    const lastCallIdx = updateSessionMock.mock.calls.length - 1;
    const lastUpdate = updateSessionMock.mock.calls[
      lastCallIdx
    ]![1] as SessionState;
    expect(lastUpdate.status).toBe("ready");
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
        makeSession({ promptCount: 5 }),
        "test",
      );
    } catch {
      // expected
    }

    // No updateSession call should have incremented promptCount
    for (const call of updateSessionMock.mock.calls) {
      const session = call[1] as SessionState;
      // promptCount should never be 6 (original was 5)
      expect(session.promptCount).not.toBe(6);
    }
  });

  it("releases lock even when status recovery fails (best-effort)", async () => {
    const releaseMock = vi.fn();
    acquireSessionLockMock.mockReturnValue(releaseMock);
    mockExecFileFailure(new Error("CLI crashed"));

    // Make the final status reset call fail
    let callCount = 0;
    updateSessionMock.mockImplementation(() => {
      callCount++;
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

    // Lock released and status reset
    expect(releaseMock).toHaveBeenCalledTimes(1);
    const lastCallIdx = updateSessionMock.mock.calls.length - 1;
    const lastUpdate = updateSessionMock.mock.calls[
      lastCallIdx
    ]![1] as SessionState;
    expect(lastUpdate.status).toBe("ready");
  });
});
