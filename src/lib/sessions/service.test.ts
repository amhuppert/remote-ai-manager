import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { GitClient } from "../git/client";
import {
  validateSessionName,
  sanitizeBranchName,
  generateRandomSuffix,
  createSessionService,
  PLANNER_SESSION_NAME,
  type SessionDeps,
} from "./service";
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
  const fastRemoveWorktreeMock = vi
    .fn()
    .mockResolvedValue({ status: "moved", trashPath: "/trash/x" });
  const sweepLaneWorktreesMock = vi.fn().mockResolvedValue([]);

  const deps: SessionDeps = {
    existsSync: existsSyncMock as unknown as SessionDeps["existsSync"],
    rm: vi.fn().mockResolvedValue(undefined),
    execFileAsync: execFileAsyncMock as unknown as SessionDeps["execFileAsync"],
    gitClient: { git: gitMock } as unknown as GitClient,
    fastRemoveWorktree:
      fastRemoveWorktreeMock as unknown as SessionDeps["fastRemoveWorktree"],
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
    readConfig: vi.fn().mockResolvedValue({}),
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
    deleteNotificationsForSession: vi.fn().mockReturnValue(0),
    deleteJobRecordsForSession: vi.fn().mockReturnValue(0),
    deleteNotificationsForProject: vi.fn().mockReturnValue(0),
    deleteJobRecordsForProject: vi.fn().mockReturnValue(0),
    sweepLaneWorktrees: sweepLaneWorktreesMock,
  };

  return {
    deps,
    gitMock,
    readStateMock,
    writeStateMock,
    existsSyncMock,
    execFileAsyncMock,
    fastRemoveWorktreeMock,
    sweepLaneWorktreesMock,
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
            creationMode: "normal" as const,
            tddEnabled: true,
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
let fastRemoveWorktreeMock: Mock;
let sweepLaneWorktreesMock: Mock;
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
  fastRemoveWorktreeMock = testSetup.fastRemoveWorktreeMock;
  sweepLaneWorktreesMock = testSetup.sweepLaneWorktreesMock;
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

  it("rejects the reserved project-conversation sentinel", () => {
    expect(validateSessionName("__project__")).toMatch(/reserved/);
    // Other underscore names remain valid.
    expect(validateSessionName("my_feature")).toBeNull();
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
// 1.2b – Random suffix generation
// ===========================================================================

describe("generateRandomSuffix", () => {
  it("returns a 6-character string", () => {
    const result = generateRandomSuffix();
    expect(result).toHaveLength(6);
  });

  it("returns only lowercase hex characters", () => {
    const result = generateRandomSuffix();
    expect(result).toMatch(/^[a-f0-9]{6}$/);
  });

  it("returns different values on successive calls", () => {
    const a = generateRandomSuffix();
    const b = generateRandomSuffix();
    expect(a).not.toBe(b);
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

  it("passes a sanitized child env (from buildChildEnv) to the SDK so NODE_ENV from CC's parent process does not leak", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Sanitized Env"));
    (deps.buildChildEnv as Mock).mockReturnValue({
      PATH: "/usr/bin",
      HOME: "/home/test",
    });

    await service.generateSessionName("Add feature", "/projects/repo");

    expect(deps.buildChildEnv).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: {
            PATH: "/usr/bin",
            HOME: "/home/test",
            CLAUDECODE: "",
          },
        }),
      }),
    );
  });
});

// ===========================================================================
// 1.4 – Session creation with worktree and state persistence
// ===========================================================================

describe("createSessionNormal", () => {
  it("creates a session with user-provided name", async () => {
    mockGitSuccess(); // git worktree add
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );

    expect(session.sessionName).toBe("My Feature");
    expect(session.worktreePath).toMatch(
      /^\/projects\/repo\/\.worktrees\/my-feature-[a-f0-9]{6}$/,
    );
    expect(session.branchName).toMatch(/^csm\/my-feature-[a-f0-9]{6}$/);
    expect(session.creationMode).toBe("normal");
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]).toMatchObject({
      status: "new",
      source: "cc",
      promptCount: 0,
      name: "My Feature 1",
      role: null,
    });
    expect(session.conversations[0]!.id).toBeTruthy();
    expect(session.archived).toBe(false);
    expect(session.source).toBe("cc");
  });

  it("does not persist any session-wide objective", async () => {
    mockGitSuccess(); // git worktree add
    await service.createSessionNormal("/projects/repo", "No Objective");

    const savedState = writeStateMock.mock.calls[0]![0];
    const persisted =
      savedState.projects["/projects/repo"].sessions["No Objective"];
    expect("objective" in persisted).toBe(false);
  });

  it("does not call Claude for name generation", async () => {
    mockGitSuccess(); // git worktree add
    await service.createSessionNormal("/projects/repo", "Direct Name");

    // Only one gitMock call (git worktree add), no claude call
    expect(gitMock).toHaveBeenCalledTimes(1);
    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add"]),
      "/projects/repo",
    );
  });

  it("sets ISO 8601 timestamps for createdAt and lastActivityAt", async () => {
    mockGitSuccess();
    const before = new Date().toISOString();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Timestamp Test",
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
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Build Feature",
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "main",
      ],
      "/projects/repo",
    );
  });

  it("persists session to state via writeState", async () => {
    mockGitSuccess();
    await service.createSessionNormal("/projects/repo", "Persist Test");

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project).toBeDefined();
    expect(project.sessions["Persist Test"]).toBeDefined();
    expect(project.sessions["Persist Test"].creationMode).toBe("normal");
    expect(project.sessions["Persist Test"].conversations).toHaveLength(1);
  });

  it("auto-creates project entry when project not yet in state", async () => {
    readStateMock.mockResolvedValue(emptyState());
    mockGitSuccess();
    await service.createSessionNormal("/new/project", "First Session");

    const savedState = writeStateMock.mock.calls[0]![0];
    expect(savedState.projects["/new/project"]).toBeDefined();
    expect(savedState.projects["/new/project"].rootPath).toBe("/new/project");
  });

  it("throws for empty session name", async () => {
    await expect(
      service.createSessionNormal("/projects/repo", ""),
    ).rejects.toThrow("Session name cannot be empty");
  });

  it("accepts session names with special characters", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "test, with special chars!",
    );

    expect(session.sessionName).toBe("test, with special chars!");
    expect(session.branchName).toMatch(
      /^csm\/test-with-special-chars-[a-f0-9]{6}$/,
    );
    expect(session.worktreePath).toMatch(
      /^\/projects\/repo\/\.worktrees\/test-with-special-chars-[a-f0-9]{6}$/,
    );
  });

  it("throws for duplicate session name in same project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Existing"),
    );
    await expect(
      service.createSessionNormal("/projects/repo", "Existing"),
    ).rejects.toThrow('Session "Existing" already exists in this project');
  });

  it("allows same name in different projects", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo-a", "Shared Name"),
    );
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo-b",
      "Shared Name",
    );
    expect(session.sessionName).toBe("Shared Name");
  });

  it("throws error when worktree directory already exists", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) return true;
      return false;
    });
    await expect(
      service.createSessionNormal("/projects/repo", "Conflict"),
    ).rejects.toThrow("Worktree directory already exists:");
  });

  // =========================================================================
  // Init script execution and rollback
  // =========================================================================

  it("executes init script with correct environment when configured", async () => {
    mockGitSuccess(); // git worktree add

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./setup.sh",
    });

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("setup.sh")) return true;
      return false;
    });

    const session = await service.createSessionNormal(
      "/projects/repo",
      "With Init",
    );

    // execFileAsyncMock should be called for the init script
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const initCall = execFileAsyncMock.mock.calls[0];
    expect(initCall).toBeDefined();
    expect(initCall![0]).toBe("/projects/repo/setup.sh");
    expect(initCall![1]).toEqual([]);
    const opts = initCall![2] as {
      cwd: string;
      env: Record<string, string>;
      timeout?: number;
    };
    expect(opts.cwd).toBe(session.worktreePath);
    expect(opts.env.PROJECT_ROOT).toBe("/projects/repo");
    expect(opts.env.WORKTREE_PATH).toBe(session.worktreePath);
    // No parent session → parent worktree falls back to the project root.
    expect(opts.env.PARENT_WORKTREE_PATH).toBe("/projects/repo");
    expect(opts.env.SESSION_NAME).toBe("With Init");
    expect(opts.env.BRANCH_NAME).toBe(session.branchName);
    expect(opts.timeout).toBeUndefined();
  });

  it("passes the parent session's worktree as PARENT_WORKTREE_PATH when branched", async () => {
    mockGitSuccess(); // git worktree add

    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Parent Session", {
        worktreePath: "/projects/repo/.worktrees/parent-session",
      }),
    );

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./setup.sh",
    });
    existsSyncMock.mockImplementation((p: string) =>
      String(p).includes("setup.sh"),
    );

    await service.provisionSession("/projects/repo", "child-session", {
      mode: "normal",
      baseBranch: "csm/parent-session",
      targetBranch: "csm/parent-session",
      parentSessionName: "Parent Session",
    });

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const opts = execFileAsyncMock.mock.calls[0]![2] as {
      env: Record<string, string>;
    };
    expect(opts.env.PARENT_WORKTREE_PATH).toBe(
      "/projects/repo/.worktrees/parent-session",
    );
    expect(opts.env.PROJECT_ROOT).toBe("/projects/repo");
  });

  it("throws 'Init script not found' when script path doesn't exist", async () => {
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
      service.createSessionNormal("/projects/repo", "Missing Script"),
    ).rejects.toThrow("Init script not found:");
  });

  it("rolls back worktree and branch on init script failure", async () => {
    const scriptError = new Error("script failed");

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
      service.createSessionNormal("/projects/repo", "Fail Session"),
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
      service.createSessionNormal("/projects/repo", "Rm Fallback"),
    ).rejects.toThrow("script failed");

    expect(deps.rm).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees/rm-fallback"),
      { recursive: true, force: true },
    );
  });

  it("rolls back state when creation fails after early persist", async () => {
    mockGitFailure(new Error("git worktree add failed"));

    await expect(
      service.createSessionNormal("/projects/repo", "Should Not Persist"),
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
// 1.5b – Random suffix in branch/worktree paths
// ===========================================================================

describe("provisionSession — random suffix", () => {
  it("branchName includes a 6-char hex suffix", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^csm\/my-feature-[a-f0-9]{6}$/);
  });

  it("worktreePath includes the same suffix", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.worktreePath).toMatch(
      /^\/projects\/repo\/\.worktrees\/my-feature-[a-f0-9]{6}$/,
    );
  });

  it("sessionName does NOT include the suffix", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.sessionName).toBe("My Feature");
  });

  it("git worktree add uses the suffixed branch and path", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "main",
      ],
      "/projects/repo",
    );
  });
});

// ===========================================================================
// 1.5c – Configurable branch prefix
// ===========================================================================

describe("provisionSession — configurable branch prefix", () => {
  it("uses global branchPrefix when configured", async () => {
    mockGitSuccess();
    (deps.readConfig as Mock).mockResolvedValue({ branchPrefix: "dev" });

    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^dev\/my-feature-[a-f0-9]{6}$/);
  });

  it("per-project branchPrefix overrides global", async () => {
    mockGitSuccess();
    (deps.readConfig as Mock).mockResolvedValue({ branchPrefix: "dev" });
    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: null,
      branchPrefix: "feature",
    });

    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^feature\/my-feature-[a-f0-9]{6}$/);
  });

  it("defaults to csm when no branchPrefix is configured", async () => {
    mockGitSuccess();
    (deps.readConfig as Mock).mockResolvedValue({});
    (deps.readRepoConfig as Mock).mockResolvedValue(null);

    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^csm\/my-feature-[a-f0-9]{6}$/);
  });
});

// ===========================================================================
// 1.6 – Session deletion (Req 8.1–8.7)
// ===========================================================================

describe("deleteSession", () => {
  it("removes the worktree and removes session from state", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete"),
    );
    existsSyncMock.mockReturnValue(true); // worktree exists

    await service.deleteSession("/projects/repo", "to-delete");

    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/to-delete",
    });
    expect(sweepLaneWorktreesMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      sessionWorktreePath: "/projects/repo/.worktrees/to-delete",
    });

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

    // Helper should NOT be called since worktree doesn't exist
    expect(fastRemoveWorktreeMock).not.toHaveBeenCalled();

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["no-worktree"],
    ).toBeUndefined();
  });

  it("still removes session from state when worktree removal fails", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "rm-fallback"),
    );
    existsSyncMock.mockReturnValue(true);
    fastRemoveWorktreeMock.mockRejectedValueOnce(
      new Error("worktree remove failed"),
    );

    await service.deleteSession("/projects/repo", "rm-fallback");

    // A failed disk cleanup must not block the fused retarget+delete
    // mutation, so the session is still removed from state.
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["rm-fallback"],
    ).toBeUndefined();
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

    const result = await service.deleteSession("/projects/repo", "cc-session");

    expect(result.worktreeRemoved).toBe(true);
    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/cc-session",
    });
  });

  it("removes worktree for imported sessions the same as CC-created ones", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "imported-session", {
        source: "imported",
        worktreePath: "/external/path/imported-session",
      }),
    );
    existsSyncMock.mockReturnValue(true);

    const result = await service.deleteSession(
      "/projects/repo",
      "imported-session",
    );

    expect(result.worktreeRemoved).toBe(true);
    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/external/path/imported-session",
    });
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

    const result = await service.deleteSession(
      "/projects/repo",
      "legacy-session",
    );

    expect(result.worktreeRemoved).toBe(true);
    expect(fastRemoveWorktreeMock).toHaveBeenCalled();
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

  it("purges transcript files, notifications, and job records", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete", {
        conversations: [
          {
            id: "conv-a",
            transcriptPath: "/cfg/transcripts/conv-a.jsonl",
          },
          {
            id: "conv-b",
            transcriptPath: null,
          },
          {
            id: "conv-c",
            transcriptPath: "/cfg/transcripts/conv-c.jsonl",
          },
        ],
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.deleteSession("/projects/repo", "to-delete");

    expect(deps.rm).toHaveBeenCalledWith("/cfg/transcripts/conv-a.jsonl", {
      force: true,
    });
    expect(deps.rm).toHaveBeenCalledWith("/cfg/transcripts/conv-c.jsonl", {
      force: true,
    });
    expect(deps.deleteNotificationsForSession).toHaveBeenCalledWith(
      "repo",
      "to-delete",
    );
    expect(deps.deleteJobRecordsForSession).toHaveBeenCalledWith(
      "repo",
      "to-delete",
    );
  });

  it("does not fail when transcript file removal throws", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete", {
        conversations: [
          { id: "conv-a", transcriptPath: "/cfg/transcripts/conv-a.jsonl" },
        ],
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();
    (deps.rm as Mock).mockImplementation(async (target: string) => {
      if (target.startsWith("/cfg/transcripts")) {
        throw new Error("ENOENT");
      }
    });

    await expect(
      service.deleteSession("/projects/repo", "to-delete"),
    ).resolves.toMatchObject({ worktreeRemoved: true });
    expect(deps.deleteNotificationsForSession).toHaveBeenCalled();
    expect(deps.deleteJobRecordsForSession).toHaveBeenCalled();
  });
});

// ===========================================================================
// 1.6.b – Project deletion
// ===========================================================================

describe("deleteProject", () => {
  function stateWithProject(
    projectPath: string,
    sessions: Record<string, Record<string, unknown>> = {},
  ) {
    const sessionEntries: Record<string, unknown> = {};
    for (const [name, overrides] of Object.entries(sessions)) {
      sessionEntries[name] = {
        sessionName: name,
        worktreePath: `${projectPath}/.worktrees/${name}`,
        branchName: `csm/${name}`,
        createdAt: "2024-01-01T00:00:00Z",
        lastActivityAt: "2024-01-01T00:00:00Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal" as const,
        tddEnabled: true,
        ...overrides,
      };
    }
    return {
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: sessionEntries,
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("removes each session, the project row, and project-level notifications/jobs", async () => {
    readStateMock.mockResolvedValue(
      stateWithProject("/projects/repo", {
        alpha: {
          conversations: [
            { id: "conv-a", transcriptPath: "/cfg/transcripts/conv-a.jsonl" },
          ],
        },
        beta: {
          conversations: [],
        },
      }),
    );
    existsSyncMock.mockReturnValue(true);

    const result = await service.deleteProject("/projects/repo");

    expect(result.sessionsRemoved).toBe(2);

    // Each session's worktree should have been routed through the fast helper
    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/alpha",
    });
    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/beta",
    });

    // Transcript for alpha's conversation should be removed
    expect(deps.rm).toHaveBeenCalledWith("/cfg/transcripts/conv-a.jsonl", {
      force: true,
    });

    // Project-level bulk purge
    expect(deps.deleteNotificationsForProject).toHaveBeenCalledWith("repo");
    expect(deps.deleteJobRecordsForProject).toHaveBeenCalledWith("repo");

    // Final mutateState call removes the project entry
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/repo"]).toBeUndefined();
  });

  it("succeeds for a project with zero sessions", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/empty"));

    const result = await service.deleteProject("/projects/empty");

    expect(result.sessionsRemoved).toBe(0);
    expect(deps.deleteNotificationsForProject).toHaveBeenCalledWith("empty");
    expect(deps.deleteJobRecordsForProject).toHaveBeenCalledWith("empty");
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/empty"]).toBeUndefined();
  });

  it("throws when the project does not exist in state", async () => {
    readStateMock.mockResolvedValue(emptyState());

    await expect(service.deleteProject("/projects/ghost")).rejects.toThrow(
      "Project not found: /projects/ghost",
    );
    expect(deps.deleteNotificationsForProject).not.toHaveBeenCalled();
    expect(deps.deleteJobRecordsForProject).not.toHaveBeenCalled();
  });

  it("continues purging when one session's worktree removal fails", async () => {
    readStateMock.mockResolvedValue(
      stateWithProject("/projects/repo", {
        alpha: { conversations: [] },
        beta: { conversations: [] },
      }),
    );
    existsSyncMock.mockReturnValue(true);
    // First removal fails; subsequent succeed. deleteProject must still
    // purge both sessions from state.
    fastRemoveWorktreeMock
      .mockRejectedValueOnce(new Error("worktree remove failed"))
      .mockResolvedValue({ status: "moved", trashPath: "/trash/x" });

    const result = await service.deleteProject("/projects/repo");

    expect(result.sessionsRemoved).toBe(2);
    expect(deps.deleteNotificationsForProject).toHaveBeenCalledWith("repo");
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/repo"]).toBeUndefined();
  });
});

// ===========================================================================
// 1.7 – Optimistic mode provisioning (Task 1.2)
// ===========================================================================

describe("provisionSession — optimistic mode", () => {
  it("sets conversation role to null for optimistic sessions", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "opt-null-role",
      {
        mode: "optimistic",
      },
    );

    expect(session.conversations[0]!.role).toBeNull();
  });

  it("records creationMode as optimistic in session state", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "opt-mode",
      {
        mode: "optimistic",
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

  it("stores no session-wide objective and seeds the kickoff prompt with the instructions", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Auth Fix"));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Fix authentication flow",
    );

    expect(session.creationMode).toBe("optimistic");
    // The instructions no longer become a session-wide objective field.
    expect("objective" in session).toBe(false);
    const savedState = writeStateMock.mock.calls[0]![0];
    const persisted =
      savedState.projects["/projects/repo"].sessions["Auth Fix"];
    expect("objective" in persisted).toBe(false);
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]!.role).toBeNull();

    // The instructions flow to the conversation kickoff prompt path: the
    // optimistic orchestrator receives them as the first-turn prompt text.
    expect(deps.executeOptimisticWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: "Fix authentication flow" }),
    );
  });

  it("ensures generated name is unique within project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Duplicate"),
    );
    queryMock.mockReturnValue(mockQueryResponse("Duplicate"));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Something duplicated",
    );

    expect(session.sessionName).toBe("Duplicate-2");
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

// ===========================================================================
// Task 3.1 – Child session provisioning from a parent branch
// ===========================================================================

describe("provisionSession — child session branching", () => {
  it("uses baseBranch in git worktree add instead of main", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "child-session",
      {
        mode: "normal",
        baseBranch: "csm/parent-branch-abc123",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "csm/parent-branch-abc123",
      ],
      "/projects/repo",
    );
  });

  it("defaults baseBranch to main when not provided", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "regular-session",
      {
        mode: "normal",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "main",
      ],
      "/projects/repo",
    );
  });

  it("stores targetBranch on session state", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "child-target",
      {
        mode: "normal",
        targetBranch: "csm/parent-branch-abc123",
      },
    );

    expect(session.targetBranch).toBe("csm/parent-branch-abc123");
  });

  it("stores parentSessionName on session state", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "child-parent",
      {
        mode: "normal",
        parentSessionName: "Parent Session",
      },
    );

    expect(session.parentSessionName).toBe("Parent Session");
  });

  it("defaults targetBranch to main and parentSessionName to null", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "default-session",
      {
        mode: "normal",
      },
    );

    expect(session.targetBranch).toBe("main");
    expect(session.parentSessionName).toBeNull();
  });

  it("persists targetBranch and parentSessionName in state", async () => {
    mockGitSuccess();
    await service.provisionSession("/projects/repo", "persisted-child", {
      mode: "normal",
      targetBranch: "csm/parent-abc",
      parentSessionName: "Parent",
    });

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const session =
      savedState.projects["/projects/repo"].sessions["persisted-child"];
    expect(session.targetBranch).toBe("csm/parent-abc");
    expect(session.parentSessionName).toBe("Parent");
  });
});

// ===========================================================================
// Task 3.1 – Threading branching opts through creation modes
// ===========================================================================

describe("createSessionNormal — branching opts", () => {
  it("threads baseBranch, targetBranch, parentSessionName to provisionSession", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Child Normal",
      undefined,
      {
        baseBranch: "csm/parent-abc",
        targetBranch: "csm/parent-abc",
        parentSessionName: "Parent",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(["csm/parent-abc"]),
      "/projects/repo",
    );
    expect(session.targetBranch).toBe("csm/parent-abc");
    expect(session.parentSessionName).toBe("Parent");
  });
});

describe("createSessionOptimistic — branching opts", () => {
  it("threads baseBranch, targetBranch, parentSessionName to provisionSession", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Child Opt"));
    mockGitSuccess();
    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Build child optimistic",
      undefined,
      undefined,
      {
        baseBranch: "csm/parent-abc",
        targetBranch: "csm/parent-abc",
        parentSessionName: "Parent",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(["csm/parent-abc"]),
      "/projects/repo",
    );
    expect(session.targetBranch).toBe("csm/parent-abc");
    expect(session.parentSessionName).toBe("Parent");
  });
});

// ===========================================================================
// Task 3.2 – retargetOrphanedChildren
// ===========================================================================

describe("retargetOrphanedChildren", () => {
  function stateWithChildren(
    parentName: string,
    children: Array<{
      name: string;
      targetBranch: string;
      parentSessionName: string | null;
    }>,
  ) {
    const sessions: Record<string, Record<string, unknown>> = {
      [parentName]: {
        sessionName: parentName,
        worktreePath: `/projects/repo/.worktrees/${parentName}`,
        branchName: `csm/${parentName}`,
        createdAt: "2024-01-01T00:00:00Z",
        lastActivityAt: "2024-01-01T00:00:00Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal",
        tddEnabled: true,
        targetBranch: "main",
        parentSessionName: null,
      },
    };
    for (const child of children) {
      sessions[child.name] = {
        sessionName: child.name,
        worktreePath: `/projects/repo/.worktrees/${child.name}`,
        branchName: `csm/${child.name}`,
        createdAt: "2024-01-01T00:00:00Z",
        lastActivityAt: "2024-01-01T00:00:00Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal",
        tddEnabled: true,
        targetBranch: child.targetBranch,
        parentSessionName: child.parentSessionName,
      };
    }
    return {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions,
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("resets direct children targetBranch to main and parentSessionName to null", async () => {
    const state = stateWithChildren("Parent", [
      {
        name: "Child1",
        targetBranch: "csm/Parent",
        parentSessionName: "Parent",
      },
      {
        name: "Child2",
        targetBranch: "csm/Parent",
        parentSessionName: "Parent",
      },
    ]);
    readStateMock.mockResolvedValue(state);

    await service.retargetOrphanedChildren("/projects/repo", "Parent");

    expect(writeStateMock).toHaveBeenCalled();
    const savedState = writeStateMock.mock.calls[0]![0];
    const child1 = savedState.projects["/projects/repo"].sessions["Child1"];
    const child2 = savedState.projects["/projects/repo"].sessions["Child2"];
    expect(child1.targetBranch).toBe("main");
    expect(child1.parentSessionName).toBeNull();
    expect(child2.targetBranch).toBe("main");
    expect(child2.parentSessionName).toBeNull();
  });

  it("does not affect sessions that are not children of the parent", async () => {
    const state = stateWithChildren("Parent", [
      {
        name: "Child",
        targetBranch: "csm/Parent",
        parentSessionName: "Parent",
      },
      { name: "Unrelated", targetBranch: "main", parentSessionName: null },
    ]);
    readStateMock.mockResolvedValue(state);

    await service.retargetOrphanedChildren("/projects/repo", "Parent");

    const savedState = writeStateMock.mock.calls[0]![0];
    const unrelated =
      savedState.projects["/projects/repo"].sessions["Unrelated"];
    expect(unrelated.targetBranch).toBe("main");
    expect(unrelated.parentSessionName).toBeNull();
  });

  it("does not cascade to transitive descendants (grandchildren)", async () => {
    const state = stateWithChildren("Parent", [
      {
        name: "Child",
        targetBranch: "csm/Parent",
        parentSessionName: "Parent",
      },
      {
        name: "Grandchild",
        targetBranch: "csm/Child",
        parentSessionName: "Child",
      },
    ]);
    readStateMock.mockResolvedValue(state);

    await service.retargetOrphanedChildren("/projects/repo", "Parent");

    const savedState = writeStateMock.mock.calls[0]![0];
    const grandchild =
      savedState.projects["/projects/repo"].sessions["Grandchild"];
    // Grandchild still points to Child — not retargeted
    expect(grandchild.targetBranch).toBe("csm/Child");
    expect(grandchild.parentSessionName).toBe("Child");
  });

  it("is a no-op when no children exist", async () => {
    const state = stateWithChildren("Parent", []);
    readStateMock.mockResolvedValue(state);

    await service.retargetOrphanedChildren("/projects/repo", "Parent");

    // mutateState still called but no sessions changed
    expect(deps.mutateState).toHaveBeenCalled();
  });
});

// ===========================================================================
// deleteSession – fused retarget + remove (single mutateState)
// ===========================================================================

describe("deleteSession — orphan retargeting", () => {
  function stateWithParentAndChild() {
    return {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: {
            Parent: {
              sessionName: "Parent",
              worktreePath: "/projects/repo/.worktrees/parent",
              branchName: "csm/parent",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            Child: {
              sessionName: "Child",
              worktreePath: "/projects/repo/.worktrees/child",
              branchName: "csm/child",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "csm/parent",
              parentSessionName: "Parent",
            },
          },
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("performs retarget + remove in a single mutateState labeled deleteSession", async () => {
    readStateMock.mockResolvedValue(stateWithParentAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.deleteSession("/projects/repo", "Parent");

    const mutateLabels = (deps.mutateState as Mock).mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(mutateLabels).toEqual(["deleteSession"]);
  });

  it("the single deleteSession mutator retargets children and removes the parent in one pass", async () => {
    readStateMock.mockResolvedValue(stateWithParentAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.deleteSession("/projects/repo", "Parent");

    const writeCalls = writeStateMock.mock.calls;
    expect(writeCalls).toHaveLength(1);
    const [savedState, label] = writeCalls[0]!;
    expect(label).toBe("deleteSession");

    const project = savedState.projects["/projects/repo"];
    expect(project.sessions["Parent"]).toBeUndefined();
    const child = project.sessions["Child"];
    expect(child.targetBranch).toBe("main");
    expect(child.parentSessionName).toBeNull();
  });
});

// ===========================================================================
// bulkDeleteSessions – one mutateState for N sessions
// ===========================================================================

describe("bulkDeleteSessions", () => {
  function stateWithThreeSiblingsAndChild() {
    return {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: {
            A: {
              sessionName: "A",
              worktreePath: "/projects/repo/.worktrees/A",
              branchName: "csm/A",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            B: {
              sessionName: "B",
              worktreePath: "/projects/repo/.worktrees/B",
              branchName: "csm/B",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            C: {
              sessionName: "C",
              worktreePath: "/projects/repo/.worktrees/C",
              branchName: "csm/C",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            ChildOfA: {
              sessionName: "ChildOfA",
              worktreePath: "/projects/repo/.worktrees/ChildOfA",
              branchName: "csm/ChildOfA",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "csm/A",
              parentSessionName: "A",
            },
          },
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("performs the entire batch's state change in a single mutateState labeled bulkDeleteSessions", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.bulkDeleteSessions("/projects/repo", ["A", "B", "C"]);

    const mutateLabels = (deps.mutateState as Mock).mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(mutateLabels).toEqual(["bulkDeleteSessions"]);
  });

  it("removes all sessions and retargets orphaned children in one pass", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.bulkDeleteSessions("/projects/repo", ["A", "B", "C"]);

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project.sessions["A"]).toBeUndefined();
    expect(project.sessions["B"]).toBeUndefined();
    expect(project.sessions["C"]).toBeUndefined();

    const child = project.sessions["ChildOfA"];
    expect(child.targetBranch).toBe("main");
    expect(child.parentSessionName).toBeNull();
  });

  it("a worktree-cleanup failure is non-fatal and does not abort the batch", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    // Worktree cleanup throws for B; A and C clean up fine. A failed disk
    // cleanup must not block deletion, so B is still removed from state.
    fastRemoveWorktreeMock.mockImplementation(
      async ({ worktreePath }: { worktreePath: string }) => {
        if (worktreePath === "/projects/repo/.worktrees/B") {
          throw new Error("worktree busy");
        }
        return { status: "moved", trashPath: "/trash/x" };
      },
    );

    const results = await service.bulkDeleteSessions("/projects/repo", [
      "A",
      "B",
      "C",
    ]);

    expect(results).toEqual([
      { sessionName: "A", success: true },
      { sessionName: "B", success: true },
      { sessionName: "C", success: true },
    ]);

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project.sessions["A"]).toBeUndefined();
    expect(project.sessions["B"]).toBeUndefined();
    expect(project.sessions["C"]).toBeUndefined();
  });

  it("reports session-not-found as a failure result and still processes the rest", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    const results = await service.bulkDeleteSessions("/projects/repo", [
      "A",
      "GhostSession",
      "C",
    ]);

    expect(results[0]).toEqual({ sessionName: "A", success: true });
    expect(results[1]?.sessionName).toBe("GhostSession");
    expect(results[1]?.success).toBe(false);
    expect(results[1]?.error).toMatch(/not found/);
    expect(results[2]).toEqual({ sessionName: "C", success: true });
  });

  it("throws when the project does not exist", async () => {
    readStateMock.mockResolvedValue(emptyState());
    await expect(
      service.bulkDeleteSessions("/nonexistent", ["A"]),
    ).rejects.toThrow("Project not found: /nonexistent");
  });

  it("skips the state mutation entirely when no sessions were successfully prepared", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);

    const results = await service.bulkDeleteSessions("/projects/repo", [
      "Ghost1",
      "Ghost2",
    ]);

    expect(results.every((r) => !r.success)).toBe(true);
    expect(writeStateMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Reserved planner session — lazily created per project
// ===========================================================================

describe("ensurePlannerSession", () => {
  it("creates a __planner__ session with a deterministic worktree on first call", async () => {
    mockGitSuccess();

    const session = await service.ensurePlannerSession("/projects/repo");

    expect(session.sessionName).toBe(PLANNER_SESSION_NAME);
    expect(session.worktreePath).toBe(
      `/projects/repo/.worktrees/${PLANNER_SESSION_NAME}`,
    );
    expect(session.branchName).toBe(`csm/${PLANNER_SESSION_NAME}`);
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]!.id).toBeTruthy();

    // The worktree was provisioned via git (deterministic path, no random suffix).
    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        `csm/${PLANNER_SESSION_NAME}`,
        `/projects/repo/.worktrees/${PLANNER_SESSION_NAME}`,
        "main",
      ],
      "/projects/repo",
    );
  });

  it("returns the existing __planner__ session without provisioning again", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", PLANNER_SESSION_NAME, {
        worktreePath: `/projects/repo/.worktrees/${PLANNER_SESSION_NAME}`,
        branchName: `csm/${PLANNER_SESSION_NAME}`,
        conversations: [
          {
            id: "planner-conv-1",
            name: `${PLANNER_SESSION_NAME} 1`,
            status: "idle",
            promptCount: 0,
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            source: "cc",
            summary: null,
            archived: false,
            totalCostUsd: null,
            totalDurationMs: null,
            totalTurns: null,
            transcriptPath: null,
            pendingQuestionId: null,
            pendingQuestions: null,
            pendingPromptText: null,
            forkedFrom: null,
            role: null,
            contextTokens: null,
            contextWindowMax: null,
            debugMode: null,
            machineSnapshot: null,
            agentBackend: "claude",
            backendRef: null,
          },
        ],
      }),
    );

    const session = await service.ensurePlannerSession("/projects/repo");

    expect(session.sessionName).toBe(PLANNER_SESSION_NAME);
    expect(session.conversations[0]?.id).toBe("planner-conv-1");
    expect(gitMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// createSpawnedSession (chat-spawning creation path) — derives the branch from
// the name (slug + prefix + uniqueness suffix) exactly like the New Session
// dialog, reuses provisionSession, validates the name, and never auto-runs.
// ===========================================================================
describe("createSpawnedSession", () => {
  it("derives the branch from the name (prefix + slug + suffix), not an agent-supplied branch", async () => {
    mockGitSuccess(); // git worktree add
    const session = await service.createSpawnedSession("/projects/repo", {
      name: "Login form",
      targetBranch: "main",
      mode: "normal",
      baseBranch: "HEADSHA",
    });

    // Empty global config + null repo config → the default "csm" prefix; the
    // slug comes from the name and the 6-hex suffix guarantees uniqueness.
    expect(session.branchName).toMatch(/^csm\/login-form-[0-9a-f]{6}$/);
    expect(session.sessionName).toBe("Login form");
    expect(session.creationMode).toBe("normal");
    // git worktree add -b <derived branch> <worktree> <committed-HEAD base>
    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "HEADSHA",
      ],
      "/projects/repo",
    );
  });

  it("never fires the optimistic auto-run workflow, even for optimistic mode", async () => {
    mockGitSuccess();
    await service.createSpawnedSession("/projects/repo", {
      name: "Auto task",
      targetBranch: "main",
      mode: "optimistic",
      baseBranch: "HEADSHA",
    });
    expect(deps.executeOptimisticWorkflow).not.toHaveBeenCalled();
  });

  it("rejects an invalid session name", async () => {
    await expect(
      service.createSpawnedSession("/projects/repo", {
        name: "",
        targetBranch: "main",
        mode: "normal",
        baseBranch: "HEADSHA",
      }),
    ).rejects.toThrow("Session name cannot be empty");
    expect(gitMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate session name in the same project", async () => {
    readStateMock.mockResolvedValue(stateWithSession("/projects/repo", "dup"));
    await expect(
      service.createSpawnedSession("/projects/repo", {
        name: "dup",
        targetBranch: "main",
        mode: "normal",
        baseBranch: "HEADSHA",
      }),
    ).rejects.toThrow('Session "dup" already exists');
    expect(gitMock).not.toHaveBeenCalled();
  });

  it("propagates a worktree-add failure (e.g. duplicate/invalid branch) so the batch can record it", async () => {
    mockGitFailure(
      new Error("fatal: a branch named 'csm/login-form' already exists"),
    );
    await expect(
      service.createSpawnedSession("/projects/repo", {
        name: "Login form",
        targetBranch: "main",
        mode: "normal",
        baseBranch: "HEADSHA",
      }),
    ).rejects.toThrow("already exists");
  });
});
