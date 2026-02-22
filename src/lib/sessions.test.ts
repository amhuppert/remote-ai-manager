import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks – vi.hoisted ensures variables are available in vi.mock factories
// ---------------------------------------------------------------------------

const {
  execFileMock,
  existsSyncMock,
  rmMock,
  readFileMock,
  readStateMock,
  writeStateMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn<(p: string) => boolean>(),
  rmMock: vi.fn(),
  readFileMock: vi.fn(),
  readStateMock: vi.fn(),
  writeStateMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:fs/promises", () => ({
  rm: rmMock,
  readFile: readFileMock,
}));

vi.mock("./state", () => ({
  readState: readStateMock,
  writeState: writeStateMock,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
import {
  validateSessionName,
  sanitizeBranchName,
  createSession,
  deleteSession,
} from "./sessions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    projects: {},
    archivedProjects: [] as string[],
    pinnedProjects: [] as string[],
  };
}

function stateWithSession(
  projectPath: string,
  sessionName: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    projects: {
      [projectPath]: {
        rootPath: projectPath,
        sessions: {
          [sessionName]: {
            sessionName,
            worktreePath: `${projectPath}/.worktrees/${sessionName}`,
            branchName: `csm/${sessionName}`,
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            archived: false,
            finished: false,
            conversations: [],
            source: "csm",
            ...overrides,
          },
        },
      },
    },
    archivedProjects: [] as string[],
    pinnedProjects: [] as string[],
  };
}

/** Make execFileMock resolve via the promisified callback pattern */
function mockExecFileSuccess(stdout = "", stderr = "") {
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
        cb(null, { stdout, stderr });
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

/** Make execFileMock resolve for the first N calls, then fail */
function mockExecFileSequence(
  results: Array<{ error?: Error; stdout?: string; stderr?: string }>,
) {
  let callIndex = 0;
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
      const result = results[callIndex] ?? results[results.length - 1]!;
      callIndex++;
      if (cb) {
        if (result.error) {
          cb(result.error, { stdout: "", stderr: "" });
        } else {
          cb(null, {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          });
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  readStateMock.mockResolvedValue(emptyState());
  writeStateMock.mockResolvedValue(undefined);
  existsSyncMock.mockReturnValue(false);
  rmMock.mockResolvedValue(undefined);
  readFileMock.mockRejectedValue(new Error("file not found"));
});

// ===========================================================================
// 1.1 – Session name validation (Req 1.1–1.5)
// ===========================================================================

describe("validateSessionName", () => {
  it("returns error for empty string", () => {
    expect(validateSessionName("")).toBe("Session name cannot be empty");
  });

  it("returns error for whitespace-only string", () => {
    expect(validateSessionName("   ")).toBe("Session name cannot be empty");
  });

  it("returns error for name over 100 characters", () => {
    const longName = "a".repeat(101);
    expect(validateSessionName(longName)).toBe(
      "Session name must be 100 characters or less",
    );
  });

  it("returns error for name starting with special character", () => {
    const result = validateSessionName("-starts-with-hyphen");
    expect(result).toContain("must start with a letter or number");
  });

  it("returns error for name with invalid characters (@, #, .)", () => {
    expect(validateSessionName("test@name")).toContain(
      "must start with a letter or number",
    );
    expect(validateSessionName("test#name")).toContain(
      "must start with a letter or number",
    );
    expect(validateSessionName("test.name")).toContain(
      "must start with a letter or number",
    );
  });

  it("returns null for valid alphanumeric name", () => {
    expect(validateSessionName("myFeature")).toBeNull();
  });

  it("returns null for name with spaces, hyphens, underscores", () => {
    expect(validateSessionName("My Feature")).toBeNull();
    expect(validateSessionName("my-feature")).toBeNull();
    expect(validateSessionName("my_feature")).toBeNull();
    expect(validateSessionName("Feature 123")).toBeNull();
  });

  it("returns null for name starting with a number", () => {
    expect(validateSessionName("1st-session")).toBeNull();
  });

  it("returns null for exactly 100 character name", () => {
    expect(validateSessionName("a".repeat(100))).toBeNull();
  });
});

// ===========================================================================
// 1.2 – Branch name sanitization (Req 2.1–2.5)
// ===========================================================================

describe("sanitizeBranchName", () => {
  it("converts to lowercase", () => {
    expect(sanitizeBranchName("MyFeature")).toBe("myfeature");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(sanitizeBranchName("hello world")).toBe("hello-world");
    expect(sanitizeBranchName("hello_world")).toBe("hello-world");
    expect(sanitizeBranchName("hello.world")).toBe("hello-world");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeBranchName("test__name")).toBe("test-name");
    expect(sanitizeBranchName("a---b")).toBe("a-b");
  });

  it("strips leading and trailing hyphens", () => {
    expect(sanitizeBranchName("-leading")).toBe("leading");
    expect(sanitizeBranchName("trailing-")).toBe("trailing");
    expect(sanitizeBranchName("-both-")).toBe("both");
  });

  it("handles representative inputs from spec", () => {
    expect(sanitizeBranchName("My Feature")).toBe("my-feature");
    expect(sanitizeBranchName("test__name")).toBe("test-name");
  });

  it("handles complex mixed input", () => {
    expect(sanitizeBranchName("  Hello World!! ")).toBe("hello-world");
  });

  it("caller adds csm/ prefix (branch name pattern)", () => {
    const sanitized = sanitizeBranchName("My Feature");
    expect(`csm/${sanitized}`).toBe("csm/my-feature");
  });
});

// ===========================================================================
// 1.3 – Session creation with worktree and state persistence (Req 3.1–3.2, 7.1–7.4)
// ===========================================================================

describe("createSession", () => {
  it("creates a session with correct properties", async () => {
    mockExecFileSuccess();
    const session = await createSession("/projects/repo", "My Feature");

    expect(session.sessionName).toBe("My Feature");
    expect(session.worktreePath).toBe("/projects/repo/.worktrees/my-feature");
    expect(session.branchName).toBe("csm/my-feature");
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]).toMatchObject({
      status: "ready",
      source: "csm",
      promptCount: 0,
      name: null,
    });
    expect(session.conversations[0]!.id).toBeTruthy();
    expect(session.archived).toBe(false);
    expect(session.source).toBe("csm");
  });

  it("sets ISO 8601 timestamps for createdAt and lastActivityAt", async () => {
    mockExecFileSuccess();
    const before = new Date().toISOString();
    const session = await createSession("/projects/repo", "timestamp test");
    const after = new Date().toISOString();

    expect(session.createdAt).toBeTruthy();
    expect(session.lastActivityAt).toBeTruthy();
    expect(session.createdAt).toBe(session.lastActivityAt);
    // Verify timestamps are in valid range
    expect(new Date(session.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
    expect(new Date(session.createdAt).getTime()).toBeLessThanOrEqual(
      new Date(after).getTime(),
    );
  });

  it("calls git worktree add with correct arguments", async () => {
    mockExecFileSuccess();
    await createSession("/projects/repo", "feature");

    // First call should be git worktree add
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "csm/feature",
        "/projects/repo/.worktrees/feature",
        "main",
      ],
      { cwd: "/projects/repo" },
      expect.any(Function),
    );
  });

  it("persists session to state via writeState", async () => {
    mockExecFileSuccess();
    await createSession("/projects/repo", "persist test");

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project).toBeDefined();
    expect(project.sessions["persist test"]).toBeDefined();
    expect(project.sessions["persist test"].conversations).toHaveLength(1);
  });

  it("auto-creates project entry when project not yet in state", async () => {
    readStateMock.mockResolvedValue(emptyState());
    mockExecFileSuccess();
    await createSession("/new/project", "first session");

    const savedState = writeStateMock.mock.calls[0]![0];
    expect(savedState.projects["/new/project"]).toBeDefined();
    expect(savedState.projects["/new/project"].rootPath).toBe("/new/project");
  });

  // =========================================================================
  // 1.4 – Session uniqueness and conflicts (Req 4.1–4.2, 3.3)
  // =========================================================================

  it("throws error for duplicate session name in same project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "existing"),
    );
    await expect(createSession("/projects/repo", "existing")).rejects.toThrow(
      'Session "existing" already exists in this project',
    );
  });

  it("allows same session name in different projects", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo-a", "shared-name"),
    );
    mockExecFileSuccess();
    const session = await createSession("/projects/repo-b", "shared-name");
    expect(session.sessionName).toBe("shared-name");
  });

  it("throws error when worktree directory already exists", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      // Simulate worktree path already existing
      if (String(p).includes(".worktrees/")) return true;
      return false;
    });
    await expect(createSession("/projects/repo", "conflict")).rejects.toThrow(
      "Worktree directory already exists:",
    );
  });

  // =========================================================================
  // 1.5 – Init script execution and rollback (Req 5.1–5.6, 6.1–6.5, 3.4)
  // =========================================================================

  it("executes init script with correct environment when configured", async () => {
    // First call: git worktree add (success)
    // Second call: init script execution (success)
    mockExecFileSequence([
      { stdout: "" }, // git worktree add
      { stdout: "" }, // init script
    ]);

    // Mock readFile for ClaudeSessionManager.json
    readFileMock.mockResolvedValue(
      JSON.stringify({ initScriptPath: "./setup.sh" }),
    );

    // existsSync: worktree path doesn't exist (no conflict),
    // config file exists, script file exists
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("ClaudeSessionManager.json")) return true;
      if (String(p).includes("setup.sh")) return true;
      return false;
    });

    await createSession("/projects/repo", "with init");

    // Second execFile call should be the init script
    const initCall = execFileMock.mock.calls[1];
    expect(initCall).toBeDefined();
    // The init script path
    expect(initCall![0]).toBe("/projects/repo/setup.sh");
    // options
    const opts = initCall![2] as {
      cwd: string;
      env: Record<string, string>;
      timeout: number;
    };
    expect(opts.cwd).toBe("/projects/repo/.worktrees/with-init");
    expect(opts.env.PROJECT_ROOT).toBe("/projects/repo");
    expect(opts.env.WORKTREE_PATH).toBe("/projects/repo/.worktrees/with-init");
    expect(opts.env.SESSION_NAME).toBe("with init");
    expect(opts.env.BRANCH_NAME).toBe("csm/with-init");
    expect(opts.timeout).toBe(60_000);
  });

  it("throws 'Init script not found' when script path doesn't exist", async () => {
    mockExecFileSequence([{ stdout: "" }]); // git worktree add

    readFileMock.mockResolvedValue(
      JSON.stringify({ initScriptPath: "./missing.sh" }),
    );

    // Track worktree path checks: first call = pre-creation (false),
    // subsequent calls = cleanup (true)
    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true after
      }
      if (String(p).includes("ClaudeSessionManager.json")) return true;
      if (String(p).includes("missing.sh")) return false;
      return false;
    });

    await expect(
      createSession("/projects/repo", "missing script"),
    ).rejects.toThrow("Init script not found:");
  });

  it("rolls back worktree and branch on init script failure", async () => {
    const scriptError = new Error("script failed");

    // Call sequence: git worktree add (success), init script (fail),
    // git worktree remove (success), git branch -D (success)
    mockExecFileSequence([
      { stdout: "" },
      { error: scriptError },
      { stdout: "" }, // rollback: worktree remove
      { stdout: "" }, // rollback: branch delete
    ]);

    readFileMock.mockResolvedValue(
      JSON.stringify({ initScriptPath: "./fail.sh" }),
    );

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("ClaudeSessionManager.json")) return true;
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    await expect(
      createSession("/projects/repo", "fail session"),
    ).rejects.toThrow("script failed");

    // Verify rollback: git worktree remove --force was called
    const worktreeRemoveCall = execFileMock.mock.calls[2];
    expect(worktreeRemoveCall![0]).toBe("git");
    expect(worktreeRemoveCall![1]).toContain("worktree");
    expect(worktreeRemoveCall![1]).toContain("remove");
    expect(worktreeRemoveCall![1]).toContain("--force");

    // Verify rollback: git branch -D was called
    const branchDeleteCall = execFileMock.mock.calls[3];
    expect(branchDeleteCall![0]).toBe("git");
    expect(branchDeleteCall![1]).toContain("branch");
    expect(branchDeleteCall![1]).toContain("-D");
  });

  it("falls back to filesystem rm when git worktree remove fails during rollback", async () => {
    const scriptError = new Error("script failed");
    const removeError = new Error("worktree remove failed");

    mockExecFileSequence([
      { stdout: "" }, // git worktree add
      { error: scriptError }, // init script
      { error: removeError }, // git worktree remove fails
      { stdout: "" }, // git branch -D
    ]);

    readFileMock.mockResolvedValue(
      JSON.stringify({ initScriptPath: "./fail.sh" }),
    );

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("ClaudeSessionManager.json")) return true;
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    await expect(
      createSession("/projects/repo", "rm fallback"),
    ).rejects.toThrow("script failed");

    // Verify rm was called as fallback
    expect(rmMock).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees/rm-fallback"),
      { recursive: true, force: true },
    );
  });

  it("does not persist state when creation fails", async () => {
    mockExecFileFailure(new Error("git worktree add failed"));

    await expect(
      createSession("/projects/repo", "should not persist"),
    ).rejects.toThrow("git worktree add failed");

    // writeState should never be called on failure
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("throws validation error for empty name (via createSession)", async () => {
    await expect(createSession("/projects/repo", "")).rejects.toThrow(
      "Session name cannot be empty",
    );
    // No git or state calls should have been made
    expect(execFileMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 1.6 – Session deletion (Req 8.1–8.7)
// ===========================================================================

describe("deleteSession", () => {
  it("removes worktree via git and removes session from state", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete"),
    );
    existsSyncMock.mockReturnValue(true); // worktree exists
    mockExecFileSuccess();

    await deleteSession("/projects/repo", "to-delete");

    // Verify git worktree remove --force was called
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/projects/repo/.worktrees/to-delete"],
      { cwd: "/projects/repo" },
      expect.any(Function),
    );

    // Verify session removed from state
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["to-delete"],
    ).toBeUndefined();
  });

  it("removes session from state even when worktree doesn't exist on disk", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "no-worktree"),
    );
    existsSyncMock.mockReturnValue(false); // worktree missing

    await deleteSession("/projects/repo", "no-worktree");

    // Git should NOT be called since worktree doesn't exist
    expect(execFileMock).not.toHaveBeenCalled();

    // Session should still be removed from state
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["no-worktree"],
    ).toBeUndefined();
  });

  it("falls back to filesystem rm when git worktree remove fails", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "rm-fallback"),
    );
    existsSyncMock.mockReturnValue(true);
    mockExecFileFailure(new Error("worktree remove failed"));

    await deleteSession("/projects/repo", "rm-fallback");

    // Verify rm was called as fallback
    expect(rmMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/rm-fallback",
      { recursive: true, force: true },
    );

    // Session still removed from state
    expect(writeStateMock).toHaveBeenCalledTimes(1);
  });

  it("throws error for non-existent project", async () => {
    readStateMock.mockResolvedValue(emptyState());
    await expect(deleteSession("/nonexistent", "any")).rejects.toThrow(
      "Project not found: /nonexistent",
    );
  });

  it("returns worktreeRemoved=true for CSM-created sessions", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "csm-session", { source: "csm" }),
    );
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess();

    const result = await deleteSession("/projects/repo", "csm-session");

    expect(result.worktreeRemoved).toBe(true);
    // Git worktree remove should have been called
    expect(execFileMock).toHaveBeenCalled();
  });

  it("removes worktree for imported sessions the same as CSM-created ones", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "imported-session", {
        source: "imported",
        worktreePath: "/external/path/imported-session",
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess();

    const result = await deleteSession("/projects/repo", "imported-session");

    expect(result.worktreeRemoved).toBe(true);
    // Git worktree remove should be called for imported sessions
    expect(execFileMock).toHaveBeenCalled();
    // Session should be removed from state
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["imported-session"],
    ).toBeUndefined();
  });

  it("treats sessions without source field as CSM-created (backward compat)", async () => {
    // Simulate old state without source field — Zod default kicks in
    const stateWithoutSource = {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: {
            "legacy-session": {
              sessionName: "legacy-session",
              worktreePath: "/projects/repo/.worktrees/legacy-session",
              branchName: "csm/legacy-session",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              // no source field
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };
    readStateMock.mockResolvedValue(stateWithoutSource);
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess();

    const result = await deleteSession("/projects/repo", "legacy-session");

    // Should behave like source: "csm" — remove worktree
    expect(result.worktreeRemoved).toBe(true);
    expect(execFileMock).toHaveBeenCalled();
  });

  it("throws error for non-existent session in existing project", async () => {
    readStateMock.mockResolvedValue({
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: {},
        },
      },
      archivedProjects: [],
    });
    await expect(deleteSession("/projects/repo", "ghost")).rejects.toThrow(
      'Session "ghost" not found in project',
    );
  });
});
