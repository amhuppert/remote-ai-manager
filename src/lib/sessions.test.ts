import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks – vi.hoisted ensures variables are available in vi.mock factories
// ---------------------------------------------------------------------------

const {
  execFileMock,
  existsSyncMock,
  rmMock,
  readFileMock,
  mkdirMock,
  writeFileMock,
  readStateMock,
  writeStateMock,
  ensureUniqueNameMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn<(p: string) => boolean>(),
  rmMock: vi.fn(),
  readFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  readStateMock: vi.fn(),
  writeStateMock: vi.fn(),
  ensureUniqueNameMock: vi.fn(),
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
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

vi.mock("./state", () => ({
  readState: readStateMock,
  writeState: writeStateMock,
}));

vi.mock("./worktrees", () => ({
  ensureUniqueName: ensureUniqueNameMock,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
import {
  validateSessionName,
  sanitizeBranchName,
  createSession,
  deleteSession,
  generateSessionName,
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
            objective: null,
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
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  ensureUniqueNameMock.mockImplementation((name: string) => name);
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
// 1.3 – generateSessionName
// ===========================================================================

describe("generateSessionName", () => {
  it("uses Claude Haiku output when valid", async () => {
    mockExecFileSuccess("Add Auth\n");
    const name = await generateSessionName(
      "Add user authentication",
      "/projects/repo",
    );
    expect(name).toBe("Add Auth");

    // Verify claude was called with haiku model
    expect(execFileMock).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--model", "haiku"]),
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it("falls back to heuristic when Claude fails", async () => {
    mockExecFileFailure(new Error("claude not found"));
    const name = await generateSessionName(
      "Add auth feature",
      "/projects/repo",
    );
    // Fallback: take first 4 words, remove fillers, Title Case
    expect(name).toBe("Add Auth Feature");
  });

  it("falls back to heuristic when Claude returns invalid name", async () => {
    mockExecFileSuccess(""); // empty output
    const name = await generateSessionName(
      "Implement search",
      "/projects/repo",
    );
    expect(name).toBe("Implement Search");
  });

  it("removes filler words in fallback", async () => {
    mockExecFileFailure(new Error("timeout"));
    const name = await generateSessionName(
      "Add a new feature to the app",
      "/projects/repo",
    );
    // Removes "a", "to", "the" → ["Add", "New", "Feature", "App"]
    expect(name).toBe("Add New Feature App");
  });

  it("returns 'Session' when fallback produces empty name", async () => {
    mockExecFileFailure(new Error("timeout"));
    const name = await generateSessionName("the", "/projects/repo");
    // All words are filler → empty → "Session"
    expect(name).toBe("Session");
  });
});

// ===========================================================================
// 1.4 – Session creation with worktree and state persistence
// ===========================================================================

describe("createSession", () => {
  it("creates a session with correct properties", async () => {
    mockExecFileSequence([
      { stdout: "My Feature\n" }, // claude haiku
      { stdout: "" }, // git worktree add
    ]);
    const session = await createSession(
      "/projects/repo",
      "Implement my feature",
    );

    expect(session.sessionName).toBe("My Feature");
    expect(session.worktreePath).toBe("/projects/repo/.worktrees/my-feature");
    expect(session.branchName).toBe("csm/my-feature");
    expect(session.objective).toBe("Implement my feature");
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]).toMatchObject({
      status: "new",
      source: "csm",
      promptCount: 0,
      name: "My Feature 1",
    });
    expect(session.conversations[0]!.id).toBeTruthy();
    expect(session.archived).toBe(false);
    expect(session.source).toBe("csm");
  });

  it("sets ISO 8601 timestamps for createdAt and lastActivityAt", async () => {
    mockExecFileSequence([{ stdout: "Timestamp Test\n" }, { stdout: "" }]);
    const before = new Date().toISOString();
    const session = await createSession("/projects/repo", "Test timestamps");
    const after = new Date().toISOString();

    expect(session.createdAt).toBeTruthy();
    expect(session.lastActivityAt).toBeTruthy();
    expect(session.createdAt).toBe(session.lastActivityAt);
    expect(new Date(session.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
    expect(new Date(session.createdAt).getTime()).toBeLessThanOrEqual(
      new Date(after).getTime(),
    );
  });

  it("calls git worktree add with correct arguments", async () => {
    mockExecFileSequence([
      { stdout: "Build Feature\n" }, // claude haiku
      { stdout: "" }, // git worktree add
    ]);
    await createSession("/projects/repo", "Build feature");

    // Second call should be git worktree add (first is claude)
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "csm/build-feature",
        "/projects/repo/.worktrees/build-feature",
        "main",
      ],
      { cwd: "/projects/repo" },
      expect.any(Function),
    );
  });

  it("writes memory-bank/focus.md with objective", async () => {
    mockExecFileSequence([{ stdout: "Auth Feature\n" }, { stdout: "" }]);
    await createSession("/projects/repo", "Add user authentication");

    expect(mkdirMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/auth-feature/memory-bank",
      { recursive: true },
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/auth-feature/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nAdd user authentication\n",
      "utf-8",
    );
  });

  it("persists session to state via writeState", async () => {
    mockExecFileSequence([{ stdout: "Persist Test\n" }, { stdout: "" }]);
    await createSession("/projects/repo", "Persist test objective");

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project).toBeDefined();
    expect(project.sessions["Persist Test"]).toBeDefined();
    expect(project.sessions["Persist Test"].objective).toBe(
      "Persist test objective",
    );
    expect(project.sessions["Persist Test"].conversations).toHaveLength(1);
  });

  it("auto-creates project entry when project not yet in state", async () => {
    readStateMock.mockResolvedValue(emptyState());
    mockExecFileSequence([{ stdout: "First Session\n" }, { stdout: "" }]);
    await createSession("/new/project", "First session objective");

    const savedState = writeStateMock.mock.calls[0]![0];
    expect(savedState.projects["/new/project"]).toBeDefined();
    expect(savedState.projects["/new/project"].rootPath).toBe("/new/project");
  });

  // =========================================================================
  // Session uniqueness via ensureUniqueName
  // =========================================================================

  it("uses ensureUniqueName to avoid conflicts", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Existing"),
    );
    ensureUniqueNameMock.mockReturnValue("Existing 2");
    mockExecFileSequence([{ stdout: "Existing\n" }, { stdout: "" }]);

    const session = await createSession("/projects/repo", "Another feature");

    expect(ensureUniqueNameMock).toHaveBeenCalledWith(
      "Existing",
      new Set(["Existing"]),
    );
    expect(session.sessionName).toBe("Existing 2");
  });

  it("allows same generated name in different projects", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo-a", "Shared Name"),
    );
    mockExecFileSequence([{ stdout: "Shared Name\n" }, { stdout: "" }]);
    const session = await createSession(
      "/projects/repo-b",
      "Shared name objective",
    );
    expect(session.sessionName).toBe("Shared Name");
  });

  it("throws error when worktree directory already exists", async () => {
    mockExecFileSequence([{ stdout: "Conflict\n" }]);
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) return true;
      return false;
    });
    await expect(
      createSession("/projects/repo", "Conflict objective"),
    ).rejects.toThrow("Worktree directory already exists:");
  });

  // =========================================================================
  // Init script execution and rollback
  // =========================================================================

  it("executes init script with correct environment when configured", async () => {
    mockExecFileSequence([
      { stdout: "With Init\n" }, // claude haiku
      { stdout: "" }, // git worktree add
      { stdout: "" }, // init script
    ]);

    readFileMock.mockResolvedValue(
      JSON.stringify({ initScriptPath: "./setup.sh" }),
    );

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("ClaudeSessionManager.json")) return true;
      if (String(p).includes("setup.sh")) return true;
      return false;
    });

    await createSession("/projects/repo", "With init objective");

    // Third execFile call should be the init script (0=claude, 1=git, 2=init)
    const initCall = execFileMock.mock.calls[2];
    expect(initCall).toBeDefined();
    expect(initCall![0]).toBe("/projects/repo/setup.sh");
    const opts = initCall![2] as {
      cwd: string;
      env: Record<string, string>;
      timeout: number;
    };
    expect(opts.cwd).toBe("/projects/repo/.worktrees/with-init");
    expect(opts.env.PROJECT_ROOT).toBe("/projects/repo");
    expect(opts.env.WORKTREE_PATH).toBe("/projects/repo/.worktrees/with-init");
    expect(opts.env.SESSION_NAME).toBe("With Init");
    expect(opts.env.BRANCH_NAME).toBe("csm/with-init");
    expect(opts.timeout).toBe(60_000);
  });

  it("throws 'Init script not found' when script path doesn't exist", async () => {
    mockExecFileSequence([
      { stdout: "Missing Script\n" }, // claude haiku
      { stdout: "" }, // git worktree add
    ]);

    readFileMock.mockResolvedValue(
      JSON.stringify({ initScriptPath: "./missing.sh" }),
    );

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
      createSession("/projects/repo", "Missing script objective"),
    ).rejects.toThrow("Init script not found:");
  });

  it("rolls back worktree and branch on init script failure", async () => {
    const scriptError = new Error("script failed");

    mockExecFileSequence([
      { stdout: "Fail Session\n" }, // claude haiku
      { stdout: "" }, // git worktree add
      { error: scriptError }, // init script fails
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
      createSession("/projects/repo", "Fail session objective"),
    ).rejects.toThrow("script failed");

    // Verify rollback: git worktree remove --force was called
    const worktreeRemoveCall = execFileMock.mock.calls[3];
    expect(worktreeRemoveCall![0]).toBe("git");
    expect(worktreeRemoveCall![1]).toContain("worktree");
    expect(worktreeRemoveCall![1]).toContain("remove");
    expect(worktreeRemoveCall![1]).toContain("--force");

    // Verify rollback: git branch -D was called
    const branchDeleteCall = execFileMock.mock.calls[4];
    expect(branchDeleteCall![0]).toBe("git");
    expect(branchDeleteCall![1]).toContain("branch");
    expect(branchDeleteCall![1]).toContain("-D");
  });

  it("falls back to filesystem rm when git worktree remove fails during rollback", async () => {
    const scriptError = new Error("script failed");
    const removeError = new Error("worktree remove failed");

    mockExecFileSequence([
      { stdout: "Rm Fallback\n" }, // claude haiku
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
      createSession("/projects/repo", "RM fallback objective"),
    ).rejects.toThrow("script failed");

    expect(rmMock).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees/rm-fallback"),
      { recursive: true, force: true },
    );
  });

  it("does not persist state when creation fails", async () => {
    mockExecFileSequence([
      { stdout: "Should Not Persist\n" }, // claude haiku
      { error: new Error("git worktree add failed") }, // git fails
    ]);

    await expect(
      createSession("/projects/repo", "Should not persist"),
    ).rejects.toThrow("git worktree add failed");

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
    expect(execFileMock).toHaveBeenCalled();
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["imported-session"],
    ).toBeUndefined();
  });

  it("treats sessions without source field as CSM-created (backward compat)", async () => {
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
