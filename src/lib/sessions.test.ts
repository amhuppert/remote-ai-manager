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
  mutateStateMock,
  ensureUniqueNameMock,
  queryMock,
  readRepoConfigMock,
  executeOptimisticWorkflowMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn<(p: string) => boolean>(),
  rmMock: vi.fn(),
  readFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  readStateMock: vi.fn(),
  writeStateMock: vi.fn(),
  mutateStateMock: vi.fn(),
  ensureUniqueNameMock: vi.fn(),
  queryMock: vi.fn(),
  readRepoConfigMock: vi.fn(),
  executeOptimisticWorkflowMock: vi.fn(),
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
  mutateState: mutateStateMock,
}));

vi.mock("./worktrees", () => ({
  ensureUniqueName: ensureUniqueNameMock,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("./repo-config", () => ({
  readRepoConfig: readRepoConfigMock,
}));

vi.mock("./optimistic", () => ({
  executeOptimisticWorkflow: executeOptimisticWorkflowMock,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
import {
  validateSessionName,
  sanitizeBranchName,
  createSessionFast,
  createSessionFocus,
  createSessionOptimistic,
  deleteSession,
  generateSessionName,
  provisionSession,
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
// Reset mocks between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  readStateMock.mockResolvedValue(emptyState());
  writeStateMock.mockResolvedValue(undefined);
  mutateStateMock.mockImplementation(
    async (_label: string, mutate: (state: unknown) => unknown) => {
      const state = await readStateMock();
      const result = await mutate(state);
      await writeStateMock(state, _label);
      return result;
    },
  );
  existsSyncMock.mockReturnValue(false);
  rmMock.mockResolvedValue(undefined);
  readFileMock.mockRejectedValue(new Error("file not found"));
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  ensureUniqueNameMock.mockImplementation((name: string) => name);
  readRepoConfigMock.mockResolvedValue(null);
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
  it("uses Agent SDK output when valid", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Add Auth"));
    const name = await generateSessionName(
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
      generateSessionName("Add auth feature", "/projects/repo"),
    ).rejects.toThrow("SDK connection error");
  });

  it("throws when Claude returns empty output", async () => {
    queryMock.mockReturnValue(mockQueryResponse(""));
    await expect(
      generateSessionName("Implement search", "/projects/repo"),
    ).rejects.toThrow("Session name generation returned empty result");
  });

  it("throws when Claude returns invalid name", async () => {
    queryMock.mockReturnValue(mockQueryResponse("-invalid-name"));
    await expect(
      generateSessionName("Bad name", "/projects/repo"),
    ).rejects.toThrow("Generated session name is invalid");
  });
});

// ===========================================================================
// 1.4 – Session creation with worktree and state persistence
// ===========================================================================

describe("createSessionFocus", () => {
  it("creates a session with correct properties", async () => {
    queryMock.mockReturnValue(mockQueryResponse("My Feature"));
    mockExecFileSuccess(); // git worktree add
    const session = await createSessionFocus(
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
    mockExecFileSuccess();
    const before = new Date().toISOString();
    const session = await createSessionFocus(
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
    mockExecFileSuccess();
    await createSessionFocus("/projects/repo", "Build feature");

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
    queryMock.mockReturnValue(mockQueryResponse("Auth Feature"));
    mockExecFileSuccess();
    await createSessionFocus("/projects/repo", "Add user authentication");

    expect(mkdirMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/auth-feature/memory-bank",
      { recursive: true },
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/auth-feature/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nAdd user authentication\n\n> This focus document will be enriched after objective analysis.\n",
      "utf-8",
    );
  });

  it("persists session to state via writeState", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Persist Test"));
    mockExecFileSuccess();
    await createSessionFocus("/projects/repo", "Persist test objective");

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
    mockExecFileSuccess();
    await createSessionFocus("/new/project", "First session objective");

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
    queryMock.mockReturnValue(mockQueryResponse("Existing"));
    mockExecFileSuccess();

    const session = await createSessionFocus(
      "/projects/repo",
      "Another feature",
    );

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
    queryMock.mockReturnValue(mockQueryResponse("Shared Name"));
    mockExecFileSuccess();
    const session = await createSessionFocus(
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
      createSessionFocus("/projects/repo", "Conflict objective"),
    ).rejects.toThrow("Worktree directory already exists:");
  });

  // =========================================================================
  // Init script execution and rollback
  // =========================================================================

  it("executes init script with correct environment when configured", async () => {
    queryMock.mockReturnValue(mockQueryResponse("With Init"));
    mockExecFileSequence([
      { stdout: "" }, // git worktree add
      { stdout: "" }, // init script
    ]);

    readRepoConfigMock.mockResolvedValue({ initScriptPath: "./setup.sh" });

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("setup.sh")) return true;
      return false;
    });

    await createSessionFocus("/projects/repo", "With init objective");

    // Second execFile call should be the init script (0=git, 1=init)
    const initCall = execFileMock.mock.calls[1];
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
    queryMock.mockReturnValue(mockQueryResponse("Missing Script"));
    mockExecFileSuccess(); // git worktree add

    readRepoConfigMock.mockResolvedValue({ initScriptPath: "./missing.sh" });

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
      createSessionFocus("/projects/repo", "Missing script objective"),
    ).rejects.toThrow("Init script not found:");
  });

  it("rolls back worktree and branch on init script failure", async () => {
    const scriptError = new Error("script failed");

    queryMock.mockReturnValue(mockQueryResponse("Fail Session"));
    mockExecFileSequence([
      { stdout: "" }, // git worktree add
      { error: scriptError }, // init script fails
      { stdout: "" }, // rollback: worktree remove
      { stdout: "" }, // rollback: branch delete
    ]);

    readRepoConfigMock.mockResolvedValue({ initScriptPath: "./fail.sh" });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    await expect(
      createSessionFocus("/projects/repo", "Fail session objective"),
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

    queryMock.mockReturnValue(mockQueryResponse("Rm Fallback"));
    mockExecFileSequence([
      { stdout: "" }, // git worktree add
      { error: scriptError }, // init script
      { error: removeError }, // git worktree remove fails
      { stdout: "" }, // git branch -D
    ]);

    readRepoConfigMock.mockResolvedValue({ initScriptPath: "./fail.sh" });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    await expect(
      createSessionFocus("/projects/repo", "RM fallback objective"),
    ).rejects.toThrow("script failed");

    expect(rmMock).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees/rm-fallback"),
      { recursive: true, force: true },
    );
  });

  it("does not persist state when creation fails", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Should Not Persist"));
    mockExecFileFailure(new Error("git worktree add failed"));

    await expect(
      createSessionFocus("/projects/repo", "Should not persist"),
    ).rejects.toThrow("git worktree add failed");

    expect(writeStateMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 1.5 – Fast session creation (user-provided name)
// ===========================================================================

describe("createSessionFast", () => {
  it("creates a session with user-provided name", async () => {
    mockExecFileSuccess(); // git worktree add
    const session = await createSessionFast("/projects/repo", "My Feature");

    expect(session.sessionName).toBe("My Feature");
    expect(session.worktreePath).toBe("/projects/repo/.worktrees/my-feature");
    expect(session.branchName).toBe("csm/my-feature");
    expect(session.objective).toBeNull();
    expect(session.creationMode).toBe("fast");
    expect(session.conversations).toHaveLength(1);
  });

  it("does not call Claude for name generation", async () => {
    mockExecFileSuccess(); // git worktree add
    await createSessionFast("/projects/repo", "Direct Name");

    // Only one execFile call (git), no claude call
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "add"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("writes focus.md with session name as fallback objective", async () => {
    mockExecFileSuccess(); // git worktree add
    await createSessionFast("/projects/repo", "Quick Fix");

    expect(writeFileMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/quick-fix/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nQuick Fix\n",
      "utf-8",
    );
  });

  it("throws for invalid session name", async () => {
    await expect(createSessionFast("/projects/repo", "")).rejects.toThrow(
      "Session name cannot be empty",
    );
  });

  it("throws for duplicate session name in same project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Existing"),
    );
    await expect(
      createSessionFast("/projects/repo", "Existing"),
    ).rejects.toThrow('Session "Existing" already exists in this project');
  });

  it("persists session to state", async () => {
    mockExecFileSuccess(); // git worktree add
    await createSessionFast("/projects/repo", "Persist Test");

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

  it("returns worktreeRemoved=true for CC-created sessions", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "cc-session", { source: "cc" }),
    );
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess();

    const result = await deleteSession("/projects/repo", "cc-session");

    expect(result.worktreeRemoved).toBe(true);
    expect(execFileMock).toHaveBeenCalled();
  });

  it("removes worktree for imported sessions the same as CC-created ones", async () => {
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

// ===========================================================================
// 1.7 – Optimistic mode provisioning (Task 1.2)
// ===========================================================================

describe("provisionSession — optimistic mode gets fast-mode treatment", () => {
  it("writes fast-mode focus.md content for optimistic sessions", async () => {
    mockExecFileSuccess();
    await provisionSession("/projects/repo", "opt-task", {
      mode: "optimistic",
      objective: "Fix the bug in login",
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/opt-task/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nFix the bug in login\n",
      "utf-8",
    );
  });

  it("sets conversation role to null for optimistic sessions (no initialization)", async () => {
    mockExecFileSuccess();
    const session = await provisionSession("/projects/repo", "opt-null-role", {
      mode: "optimistic",
      objective: "Add a feature",
    });

    expect(session.conversations[0]!.role).toBeNull();
  });

  it("still writes focus-mode content for focus sessions", async () => {
    mockExecFileSuccess();
    await provisionSession("/projects/repo", "focus-check", {
      mode: "focus",
      objective: "Research the auth system",
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      "/projects/repo/.worktrees/focus-check/memory-bank/focus.md",
      "# Session Focus\n\n## Objective\n\nResearch the auth system\n\n> This focus document will be enriched after objective analysis.\n",
      "utf-8",
    );
  });

  it("still sets conversation role to initialization for focus sessions", async () => {
    mockExecFileSuccess();
    const session = await provisionSession("/projects/repo", "focus-role", {
      mode: "focus",
      objective: "Research something",
    });

    expect(session.conversations[0]!.role).toBe("initialization");
  });

  it("records creationMode as optimistic in session state", async () => {
    mockExecFileSuccess();
    const session = await provisionSession("/projects/repo", "opt-mode", {
      mode: "optimistic",
      objective: "Do the thing",
    });

    expect(session.creationMode).toBe("optimistic");
  });
});

// ===========================================================================
// 1.8 – Optimistic session creation (Task 3.1)
// ===========================================================================

describe("createSessionOptimistic", () => {
  it("generates a session name from instructions via Agent SDK", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Fix Login"));
    mockExecFileSuccess();

    const session = await createSessionOptimistic(
      "/projects/repo",
      "Fix the login page bug",
    );

    expect(session.sessionName).toBe("Fix Login");
    expect(queryMock).toHaveBeenCalled();
  });

  it("provisions session with optimistic mode and instructions as objective", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Auth Fix"));
    mockExecFileSuccess();

    const session = await createSessionOptimistic(
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
    ensureUniqueNameMock.mockReturnValue("Duplicate 2");
    queryMock.mockReturnValue(mockQueryResponse("Duplicate"));
    mockExecFileSuccess();

    const session = await createSessionOptimistic(
      "/projects/repo",
      "Something duplicated",
    );

    expect(ensureUniqueNameMock).toHaveBeenCalledWith(
      "Duplicate",
      new Set(["Duplicate"]),
    );
    expect(session.sessionName).toBe("Duplicate 2");
  });

  it("launches orchestrator as fire-and-forget and returns session immediately", async () => {
    queryMock.mockReturnValue(mockQueryResponse("Quick Task"));
    mockExecFileSuccess();

    const session = await createSessionOptimistic(
      "/projects/repo",
      "Do something quick",
    );

    // Session returned immediately
    expect(session.sessionName).toBe("Quick Task");

    // Orchestrator was launched with correct params
    expect(executeOptimisticWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeOptimisticWorkflowMock).toHaveBeenCalledWith({
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
    mockExecFileSuccess();

    // Make orchestrator take a long time (simulating prompt execution)
    executeOptimisticWorkflowMock.mockReturnValue(
      new Promise(() => {}), // never resolves
    );

    const session = await createSessionOptimistic(
      "/projects/repo",
      "Long running task",
    );

    // Session returned even though orchestrator hasn't finished
    expect(session.sessionName).toBe("Fast Return");
    expect(session.creationMode).toBe("optimistic");
  });
});
