import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks – vi.hoisted ensures variables are available in vi.mock factories
// ---------------------------------------------------------------------------

const {
  execFileMock,
  existsSyncMock,
  readFileMock,
  hasUncommittedChangesMock,
  commitChangesMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn<(p: string) => boolean>(),
  readFileMock: vi.fn(),
  hasUncommittedChangesMock: vi.fn(),
  commitChangesMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

vi.mock("./git-operations", () => ({
  hasUncommittedChanges: hasUncommittedChangesMock,
  commitChanges: commitChangesMock,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
import { readRepoConfig, runPreMergeValidation } from "./repo-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const BASE_PARAMS = {
  projectPath: "/projects/foo",
  worktreePath: "/projects/foo/.worktrees/my-session",
  sessionName: "my-session",
  branchName: "csm/my-session",
  timeoutMs: 300_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(false);
  readFileMock.mockRejectedValue(new Error("file not found"));
  hasUncommittedChangesMock.mockResolvedValue(false);
  commitChangesMock.mockResolvedValue({ hash: "autofix123" });
});

// ===========================================================================
// readRepoConfig
// ===========================================================================

describe("readRepoConfig", () => {
  it("returns null when no config file exists", async () => {
    existsSyncMock.mockReturnValue(false);
    const result = await readRepoConfig("/projects/foo");
    expect(result).toBeNull();
  });

  it("parses config with both initScriptPath and preMergeCommand", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        initScriptPath: "./setup.sh",
        preMergeCommand: "./validate.sh",
      }),
    );
    const result = await readRepoConfig("/projects/foo");
    expect(result).toEqual({
      initScriptPath: "./setup.sh",
      preMergeCommand: "./validate.sh",
    });
  });

  it("backward compat: parses config without preMergeCommand", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(JSON.stringify({ initScriptPath: null }));
    const result = await readRepoConfig("/projects/foo");
    expect(result).toEqual({ initScriptPath: null });
    expect(result?.preMergeCommand).toBeUndefined();
  });
});

// ===========================================================================
// runPreMergeValidation
// ===========================================================================

describe("runPreMergeValidation", () => {
  it("no-op when no config file exists", async () => {
    existsSyncMock.mockReturnValue(false);
    await runPreMergeValidation(BASE_PARAMS);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("no-op when preMergeCommand is null", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("CommandCenter.json")) return true;
      return false;
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({ initScriptPath: null, preMergeCommand: null }),
    );
    await runPreMergeValidation(BASE_PARAMS);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("no-op when preMergeCommand is absent", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("CommandCenter.json")) return true;
      return false;
    });
    readFileMock.mockResolvedValue(JSON.stringify({ initScriptPath: null }));
    await runPreMergeValidation(BASE_PARAMS);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("executes script with correct env vars", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("CommandCenter.json")) return true;
      if (String(p).includes("validate.sh")) return true;
      return false;
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    mockExecFileSuccess();

    await runPreMergeValidation(BASE_PARAMS);

    expect(execFileMock).toHaveBeenCalledWith(
      "/projects/foo/validate.sh",
      [],
      expect.objectContaining({
        cwd: BASE_PARAMS.worktreePath,
        timeout: BASE_PARAMS.timeoutMs,
        env: expect.objectContaining({
          PROJECT_ROOT: BASE_PARAMS.projectPath,
          WORKTREE_PATH: BASE_PARAMS.worktreePath,
          SESSION_NAME: BASE_PARAMS.sessionName,
          BRANCH_NAME: BASE_PARAMS.branchName,
        }),
      }),
      expect.any(Function),
    );
  });

  it("throws when script file does not exist", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("CommandCenter.json")) return true;
      if (String(p).includes("validate.sh")) return false;
      return false;
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );

    await expect(runPreMergeValidation(BASE_PARAMS)).rejects.toThrow(
      "Pre-merge validation script not found:",
    );
  });

  it("throws with gitOutput on script failure", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("CommandCenter.json")) return true;
      if (String(p).includes("validate.sh")) return true;
      return false;
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );

    const scriptErr = Object.assign(new Error("Command failed"), {
      stderr: "lint errors found",
      stdout: "2 problems",
    });
    mockExecFileFailure(scriptErr);

    try {
      await runPreMergeValidation(BASE_PARAMS);
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as Error & { gitOutput?: string };
      expect(e.message).toBe("Pre-merge validation failed");
      expect(e.gitOutput).toContain("lint errors found");
      expect(e.gitOutput).toContain("2 problems");
    }
  });

  it("commits auto-fixes when script modifies files", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("CommandCenter.json")) return true;
      if (String(p).includes("validate.sh")) return true;
      return false;
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    mockExecFileSuccess();
    hasUncommittedChangesMock.mockResolvedValue(true);

    await runPreMergeValidation(BASE_PARAMS);

    expect(commitChangesMock).toHaveBeenCalledWith(
      BASE_PARAMS.worktreePath,
      "auto-fix: pre-merge validation",
      { skipHooks: true },
    );
  });

  it("does not commit when script leaves no changes", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("CommandCenter.json")) return true;
      if (String(p).includes("validate.sh")) return true;
      return false;
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    mockExecFileSuccess();
    hasUncommittedChangesMock.mockResolvedValue(false);

    await runPreMergeValidation(BASE_PARAMS);

    expect(commitChangesMock).not.toHaveBeenCalled();
  });
});
