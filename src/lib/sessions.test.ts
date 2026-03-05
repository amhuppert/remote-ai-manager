import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { GitClient } from "./git-client";
import {
  validateSessionName,
  sanitizeBranchName,
  createSessionService,
  type SessionDeps,
} from "./sessions";

// ---------------------------------------------------------------------------
// Test dep factory – replaces all vi.mock() calls
// ---------------------------------------------------------------------------

function createTestDeps() {
  const gitMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const readStateMock = vi.fn().mockResolvedValue(emptyState());
  const writeStateMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(false);
  const execFileAsyncMock = vi
    .fn()
    .mockResolvedValue({ stdout: "", stderr: "" });
  const queryMock = vi.fn();

  const deps: SessionDeps = {
    existsSync: existsSyncMock as unknown as SessionDeps["existsSync"],
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    execFileAsync: execFileAsyncMock as unknown as SessionDeps["execFileAsync"],
    gitClient: { git: gitMock } as unknown as GitClient,
    readState: readStateMock,
    mutateState: vi
      .fn()
      .mockImplementation(
        async (_label: string, mutate: (state: unknown) => unknown) => {
          const state = await readStateMock();
          const result = mutate(state);
          writeStateMock(state, _label);
          return result;
        },
      ),
    ensureUniqueName: vi.fn().mockImplementation((name: string) => name),
    readRepoConfig: vi.fn().mockResolvedValue(null),
    stopAllForSession: vi.fn().mockResolvedValue(undefined),
    getProjectDisplayName: vi
      .fn()
      .mockImplementation((p: string) => p.split("/").pop() ?? p),
    executeOptimisticWorkflow: vi.fn(),
    buildChildEnv: vi
      .fn()
      .mockReturnValue({}) as unknown as SessionDeps["buildChildEnv"],
    query: queryMock as unknown as SessionDeps["query"],
  };

  return {
    deps,
    gitMock,
    readStateMock,
    writeStateMock,
    existsSyncMock,
    execFileAsyncMock,
    queryMock,
  };
}

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
            source: "cc",
            objective: null,
            creationMode: "fast" as const,
            workflow: null,
            ...overrides,
          },
        },
      },
    },
    archivedProjects: [] as string[],
    pinnedProjects: [] as string[],
  };
}

/** Create a mock async iterable that yields SDK messages with the given text */
function mockQueryResponse(text: string) {
  async function* generate() {
    yield {
      type: "assistant" as const,
      session_id: "mock-session",
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
      },
    };
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "mock-session",
      total_cost_usd: 0,
      duration_ms: 100,
      num_turns: 1,
    };
  }
  return generate();
}

/** Create a mock async iterable that throws an error */
function mockQueryError(error: Error) {
  async function* generate() {
    throw error;

    yield undefined as never;
  }
  return generate();
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let deps: SessionDeps;
let gitMock: Mock;
let readStateMock: Mock;
let writeStateMock: Mock;
let existsSyncMock: Mock;
let execFileAsyncMock: Mock;
let queryMock: Mock;
let service: ReturnType<typeof createSessionService>;

/** Make gitMock resolve with { stdout, stderr } */
function mockGitSuccess(stdout = "", stderr = "") {
  gitMock.mockResolvedValue({ stdout, stderr });
}

function mockGitFailure(error: Error) {
  gitMock.mockRejectedValue(error);
}

/** Queue sequential resolve/reject results for successive gitMock calls */
function mockGitSequence(
  results: Array<{ error?: Error; stdout?: string; stderr?: string }>,
) {
  for (const result of results) {
    if (result.error) {
      gitMock.mockRejectedValueOnce(result.error);
    } else {
      gitMock.mockResolvedValueOnce({
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  const testSetup = createTestDeps();
  deps = testSetup.deps;
  gitMock = testSetup.gitMock;
  readStateMock = testSetup.readStateMock;
  writeStateMock = testSetup.writeStateMock;
  existsSyncMock = testSetup.existsSyncMock;
  execFileAsyncMock = testSetup.execFileAsyncMock;
  queryMock = testSetup.queryMock;
  service = createSessionService(deps);
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

  it("returns error for name with only special characters (no alphanumeric)", () => {
    expect(validateSessionName("---")).toBe(
      "Session name must contain at least one letter or number",
    );
    expect(validateSessionName("!@#$%")).toBe(
      "Session name must contain at least one letter or number",
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

  it("returns null for names with special characters (commas, dots, etc.)", () => {
    expect(validateSessionName("test, with special chars!")).toBeNull();
    expect(validateSessionName("test@name")).toBeNull();
    expect(validateSessionName("test#name")).toBeNull();
    expect(validateSessionName("test.name")).toBeNull();
    expect(validateSessionName("-starts-with-hyphen")).toBeNull();
    expect(validateSessionName("feat: add auth")).toBeNull();
    expect(validateSessionName("fix(login): handle edge case")).toBeNull();
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

  it("handles names with commas and special characters", () => {
    expect(sanitizeBranchName("test, with special chars!")).toBe(
      "test-with-special-chars",
    );
    expect(sanitizeBranchName("feat: add auth")).toBe("feat-add-auth");
    expect(sanitizeBranchName("fix(login): handle edge case")).toBe(
      "fix-login-handle-edge-case",
    );
    expect(sanitizeBranchName("test@name#value")).toBe("test-name-value");
  });

  it("returns empty string for names with no alphanumeric characters", () => {
    expect(sanitizeBranchName("---")).toBe("");
    expect(sanitizeBranchName("!@#$%")).toBe("");
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
  it("uses Agent SDK output when valid", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Add Auth"));
    const name = await service.generateSessionName(
      "Add user authentication",
      "/projects/repo",
    );
    expect(name).toBe("Add Auth");

    // Verify SDK was called with haiku model and no tools
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Add user authentication"),
        options: expect.objectContaining({
          model: "haiku",
          maxTurns: 1,
          tools: [],
          mcpServers: {},
        }),
      }),
    );
  });

  it("throws when SDK query fails", async () => {
    queryMock.mockReturnValue(
      mockQueryError(new Error("SDK connection error")),
    );
    await expect(
      service.generateSessionName("Add auth feature", "/projects/repo"),
    ).rejects.toThrow("SDK connection error");
  });

  it("throws when Claude returns empty output", async () => {
    queryMock.mockReturnValue(mockQueryResponse(""));
    await expect(
      service.generateSessionName("Implement search", "/projects/repo"),
    ).rejects.toThrow("Session name generation returned empty result");
  });

  it("throws when Claude returns name with no alphanumeric characters", async () => {
    queryMock.mockReturnValue(mockQueryResponse("---!!!"));
    await expect(
      service.generateSessionName("Bad name", "/projects/repo"),
    ).rejects.toThrow("Generated session name is invalid");
  });
});

// ===========================================================================
// 1.4 – Session creation with worktree and state persistence
// ===========================================================================

describe("createSessionFocus", () => {
  it("creates a session with correct properties", async () => {
    queryMock.mockReturnValue(mockQueryResponse("My Feature"));
    mockGitSuccess(); // git worktree add
    const session = await service.createSessionFocus(
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
      source: "cc",
      promptCount: 0,
      name: "My Feature 1",
    });
    expect(session.conversations[0]!.id).toBeTruthy();
    expect(session.archived).toBe(false);
    expect(session.source).toBe("cc");
  });

  it("sets ISO 8601 timestamps for createdAt and lastActivityAt", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Timestamp Test"));
    mockGitSuccess();
    const before = new Date().toISOString();
    const session = await service.createSessionFocus(
      "/projects/repo",
      "Test timestamps",
    );
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
    queryMock.mockReturnValue(mockQueryResponse("Build Feature"));
    mockGitSuccess();
    await service.createSessionFocus("/projects/repo", "Build feature");

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        "csm/build-feature",
        "/projects/repo/.worktrees/build-feature",
        "main",
      ],
      "/projects/repo",
    );
  });

  it("writes memory-bank/focus.md with objective", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Auth Feature"));
    mockGitSuccess();
    await service.createSessionFocus(
      "/projects/repo",
      "Add user authentication",
    );

    expect(deps.mkdir).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/auth-feature/memory-bank",
      { recursive: true },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/auth-feature/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nAdd user authentication\n\n> This focus document will be enriched after objective analysis.\n",
      "utf-8",
    );
  });

  it("persists session to state via writeState", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Persist Test"));
    mockGitSuccess();
    await service.createSessionFocus(
      "/projects/repo",
      "Persist test objective",
    );

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
    queryMock.mockReturnValue(mockQueryResponse("First Session"));
    mockGitSuccess();
    await service.createSessionFocus("/new/project", "First session objective");

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
    (deps.ensureUniqueName as Mock).mockReturnValue("Existing 2");
    queryMock.mockReturnValue(mockQueryResponse("Existing"));
    mockGitSuccess();

    const session = await service.createSessionFocus(
      "/projects/repo",
      "Another feature",
    );

    expect(deps.ensureUniqueName).toHaveBeenCalledWith(
      "Existing",
      new Set(["Existing"]),
    );
    expect(session.sessionName).toBe("Existing 2");
  });

  it("allows same generated name in different projects", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo-a", "Shared Name"),
    );
    queryMock.mockReturnValue(mockQueryResponse("Shared Name"));
    mockGitSuccess();
    const session = await service.createSessionFocus(
      "/projects/repo-b",
      "Shared name objective",
    );
    expect(session.sessionName).toBe("Shared Name");
  });

  it("throws error when worktree directory already exists", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Conflict"));
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) return true;
      return false;
    });
    await expect(
      service.createSessionFocus("/projects/repo", "Conflict objective"),
    ).rejects.toThrow("Worktree directory already exists:");
  });

  // =========================================================================
  // Init script execution and rollback
  // =========================================================================

  it("executes init script with correct environment when configured", async () => {
    queryMock.mockReturnValue(mockQueryResponse("With Init"));
    mockGitSuccess(); // git worktree add

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./setup.sh",
    });

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("setup.sh")) return true;
      return false;
    });

    await service.createSessionFocus("/projects/repo", "With init objective");

    // execFileAsyncMock should be called for the init script
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const initCall = execFileAsyncMock.mock.calls[0];
    expect(initCall).toBeDefined();
    expect(initCall![0]).toBe("/projects/repo/setup.sh");
    expect(initCall![1]).toEqual([]);
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
    queryMock.mockReturnValue(mockQueryResponse("Missing Script"));
    mockGitSuccess(); // git worktree add

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./missing.sh",
    });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true after
      }
      if (String(p).includes("missing.sh")) return false;
      return false;
    });

    await expect(
      service.createSessionFocus("/projects/repo", "Missing script objective"),
    ).rejects.toThrow("Init script not found:");
  });

  it("rolls back worktree and branch on init script failure", async () => {
    const scriptError = new Error("script failed");

    queryMock.mockReturnValue(mockQueryResponse("Fail Session"));
    mockGitSequence([
      { stdout: "" }, // git worktree add
      { stdout: "" }, // rollback: worktree remove
      { stdout: "" }, // rollback: branch delete
    ]);

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./fail.sh",
    });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    // Init script fails
    execFileAsyncMock.mockRejectedValue(scriptError);

    await expect(
      service.createSessionFocus("/projects/repo", "Fail session objective"),
    ).rejects.toThrow("script failed");

    // Verify rollback: git worktree remove --force was called via gitMock
    const worktreeRemoveCall = gitMock.mock.calls[1];
    expect(worktreeRemoveCall![0]).toContain("worktree");
    expect(worktreeRemoveCall![0]).toContain("remove");
    expect(worktreeRemoveCall![0]).toContain("--force");

    // Verify rollback: git branch -D was called via gitMock
    const branchDeleteCall = gitMock.mock.calls[2];
    expect(branchDeleteCall![0]).toContain("branch");
    expect(branchDeleteCall![0]).toContain("-D");
  });

  it("falls back to filesystem rm when git worktree remove fails during rollback", async () => {
    const scriptError = new Error("script failed");
    const removeError = new Error("worktree remove failed");

    queryMock.mockReturnValue(mockQueryResponse("Rm Fallback"));
    mockGitSequence([
      { stdout: "" }, // git worktree add
      { error: removeError }, // git worktree remove fails
      { stdout: "" }, // git branch -D
    ]);

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./fail.sh",
    });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    // Init script fails
    execFileAsyncMock.mockRejectedValue(scriptError);

    await expect(
      service.createSessionFocus("/projects/repo", "RM fallback objective"),
    ).rejects.toThrow("script failed");

    expect(deps.rm).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees/rm-fallback"),
      { recursive: true, force: true },
    );
  });

  it("rolls back state when creation fails after early persist", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Should Not Persist"));
    mockGitFailure(new Error("git worktree add failed"));

    await expect(
      service.createSessionFocus("/projects/repo", "Should not persist"),
    ).rejects.toThrow("git worktree add failed");

    // State is persisted first (createSession) then rolled back (rollbackSession)
    expect(writeStateMock).toHaveBeenCalledTimes(2);
    expect(writeStateMock.mock.calls[0]![1]).toBe("createSession");
    expect(writeStateMock.mock.calls[1]![1]).toBe("rollbackSession");

    // After rollback, the session should not exist in state
    const finalState = writeStateMock.mock.calls[1]![0];
    const project = finalState.projects["/projects/repo"];
    expect(project?.sessions["Should Not Persist"]).toBeUndefined();
  });
});

// ===========================================================================
// 1.5 – Fast session creation (user-provided name)
// ===========================================================================

describe("createSessionFast", () => {
  it("creates a session with user-provided name", async () => {
    mockGitSuccess(); // git worktree add
    const session = await service.createSessionFast(
      "/projects/repo",
      "My Feature",
    );

    expect(session.sessionName).toBe("My Feature");
    expect(session.worktreePath).toBe("/projects/repo/.worktrees/my-feature");
    expect(session.branchName).toBe("csm/my-feature");
    expect(session.objective).toBeNull();
    expect(session.creationMode).toBe("fast");
    expect(session.conversations).toHaveLength(1);
  });

  it("does not call Claude for name generation", async () => {
    mockGitSuccess(); // git worktree add
    await service.createSessionFast("/projects/repo", "Direct Name");

    // Only one gitMock call (git worktree add), no claude call
    expect(gitMock).toHaveBeenCalledTimes(1);
    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add"]),
      "/projects/repo",
    );
  });

  it("writes focus.md with session name as fallback objective", async () => {
    mockGitSuccess(); // git worktree add
    await service.createSessionFast("/projects/repo", "Quick Fix");

    expect(deps.writeFile).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/quick-fix/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nQuick Fix\n",
      "utf-8",
    );
  });

  it("throws for empty session name", async () => {
    await expect(
      service.createSessionFast("/projects/repo", ""),
    ).rejects.toThrow("Session name cannot be empty");
  });

  it("accepts session names with special characters", async () => {
    mockGitSuccess();
    const session = await service.createSessionFast(
      "/projects/repo",
      "test, with special chars!",
    );

    expect(session.sessionName).toBe("test, with special chars!");
    expect(session.branchName).toBe("csm/test-with-special-chars");
    expect(session.worktreePath).toBe(
      "/projects/repo/.worktrees/test-with-special-chars",
    );
  });

  it("throws for duplicate session name in same project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Existing"),
    );
    await expect(
      service.createSessionFast("/projects/repo", "Existing"),
    ).rejects.toThrow('Session "Existing" already exists in this project');
  });

  it("persists session to state", async () => {
    mockGitSuccess(); // git worktree add
    await service.createSessionFast("/projects/repo", "Persist Test");

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project.sessions["Persist Test"]).toBeDefined();
    expect(project.sessions["Persist Test"].creationMode).toBe("fast");
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
    mockGitSuccess();

    await service.deleteSession("/projects/repo", "to-delete");

    // Verify git worktree remove --force was called
    expect(gitMock).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", "/projects/repo/.worktrees/to-delete"],
      "/projects/repo",
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

    await service.deleteSession("/projects/repo", "no-worktree");

    // Git should NOT be called since worktree doesn't exist
    expect(gitMock).not.toHaveBeenCalled();

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
    mockGitFailure(new Error("worktree remove failed"));

    await service.deleteSession("/projects/repo", "rm-fallback");

    // Verify rm was called as fallback
    expect(deps.rm).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/rm-fallback",
      { recursive: true, force: true },
    );

    // Session still removed from state
    expect(writeStateMock).toHaveBeenCalledTimes(1);
  });

  it("throws error for non-existent project", async () => {
    readStateMock.mockResolvedValue(emptyState());
    await expect(service.deleteSession("/nonexistent", "any")).rejects.toThrow(
      "Project not found: /nonexistent",
    );
  });

  it("returns worktreeRemoved=true for CC-created sessions", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "cc-session", { source: "cc" }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    const result = await service.deleteSession("/projects/repo", "cc-session");

    expect(result.worktreeRemoved).toBe(true);
    expect(gitMock).toHaveBeenCalled();
  });

  it("removes worktree for imported sessions the same as CC-created ones", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "imported-session", {
        source: "imported",
        worktreePath: "/external/path/imported-session",
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    const result = await service.deleteSession(
      "/projects/repo",
      "imported-session",
    );

    expect(result.worktreeRemoved).toBe(true);
    expect(gitMock).toHaveBeenCalled();
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["imported-session"],
    ).toBeUndefined();
  });

  it("treats sessions without source field as CC-created (backward compat)", async () => {
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
    mockGitSuccess();

    const result = await service.deleteSession(
      "/projects/repo",
      "legacy-session",
    );

    expect(result.worktreeRemoved).toBe(true);
    expect(gitMock).toHaveBeenCalled();
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
    await expect(
      service.deleteSession("/projects/repo", "ghost"),
    ).rejects.toThrow('Session "ghost" not found in project');
  });
});

// ===========================================================================
// 1.7 – Optimistic mode provisioning (Task 1.2)
// ===========================================================================

describe("provisionSession — optimistic mode gets fast-mode treatment", () => {
  it("writes fast-mode focus.md content for optimistic sessions", async () => {
    mockGitSuccess();
    await service.provisionSession("/projects/repo", "opt-task", {
      mode: "optimistic",
      objective: "Fix the bug in login",
    });

    expect(deps.writeFile).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/opt-task/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nFix the bug in login\n",
      "utf-8",
    );
  });

  it("sets conversation role to null for optimistic sessions (no initialization)", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "opt-null-role",
      {
        mode: "optimistic",
        objective: "Add a feature",
      },
    );

    expect(session.conversations[0]!.role).toBeNull();
  });

  it("still writes focus-mode content for focus sessions", async () => {
    mockGitSuccess();
    await service.provisionSession("/projects/repo", "focus-check", {
      mode: "focus",
      objective: "Research the auth system",
    });

    expect(deps.writeFile).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/focus-check/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nResearch the auth system\n\n> This focus document will be enriched after objective analysis.\n",
      "utf-8",
    );
  });

  it("still sets conversation role to initialization for focus sessions", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "focus-role",
      {
        mode: "focus",
        objective: "Research something",
      },
    );

    expect(session.conversations[0]!.role).toBe("initialization");
  });

  it("records creationMode as optimistic in session state", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "opt-mode",
      {
        mode: "optimistic",
        objective: "Do the thing",
      },
    );

    expect(session.creationMode).toBe("optimistic");
  });
});

// ===========================================================================
// 1.8 – Optimistic session creation (Task 3.1)
// ===========================================================================

describe("createSessionOptimistic", () => {
  it("generates a session name from instructions via Agent SDK", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Fix Login"));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Fix the login page bug",
    );

    expect(session.sessionName).toBe("Fix Login");
    expect(queryMock).toHaveBeenCalled();
  });

  it("provisions session with optimistic mode and instructions as objective", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Auth Fix"));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Fix authentication flow",
    );

    expect(session.creationMode).toBe("optimistic");
    expect(session.objective).toBe("Fix authentication flow");
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]!.role).toBeNull();
  });

  it("ensures generated name is unique within project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Duplicate"),
    );
    (deps.ensureUniqueName as Mock).mockReturnValue("Duplicate 2");
    queryMock.mockReturnValue(mockQueryResponse("Duplicate"));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Something duplicated",
    );

    expect(deps.ensureUniqueName).toHaveBeenCalledWith(
      "Duplicate",
      new Set(["Duplicate"]),
    );
    expect(session.sessionName).toBe("Duplicate 2");
  });

  it("launches orchestrator as fire-and-forget and returns session immediately", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Quick Task"));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Do something quick",
    );

    // Session returned immediately
    expect(session.sessionName).toBe("Quick Task");

    // Orchestrator was launched with correct params
    expect(deps.executeOptimisticWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.executeOptimisticWorkflow).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      session: expect.objectContaining({
        sessionName: "Quick Task",
        creationMode: "optimistic",
      }),
      instructions: "Do something quick",
    });
  });

  it("returns SessionState before orchestrator completes", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Fast Return"));
    mockGitSuccess();

    // Make orchestrator take a long time (simulating prompt execution)
    (deps.executeOptimisticWorkflow as Mock).mockReturnValue(
      new Promise(() => {}), // never resolves
    );

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Long running task",
    );

    // Session returned even though orchestrator hasn't finished
    expect(session.sessionName).toBe("Fast Return");
    expect(session.creationMode).toBe("optimistic");
  });
});
