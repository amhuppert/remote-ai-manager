import { describe, it, expect, vi } from "vitest";
import { createRepoConfig, type RepoConfigDeps } from "./repo-config";

// ---------------------------------------------------------------------------
// Test Deps
// ---------------------------------------------------------------------------

function createTestDeps(): RepoConfigDeps {
  return {
    existsSync: vi.fn().mockReturnValue(false),
    readFile: vi.fn().mockRejectedValue(new Error("file not found")),
    execFileAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    buildChildEnv: vi.fn().mockReturnValue({}),
  };
}

const BASE_PARAMS = {
  projectPath: "/projects/foo",
  worktreePath: "/projects/foo/.worktrees/my-session",
  sessionName: "my-session",
  branchName: "csm/my-session",
  targetBranch: "main",
  timeoutMs: 300_000,
};

// ===========================================================================
// readRepoConfig
// ===========================================================================

describe("readRepoConfig", () => {
  it("returns null when no config file exists", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { readRepoConfig } = createRepoConfig(deps);

    const result = await readRepoConfig("/projects/foo");
    expect(result).toBeNull();
  });

  it("parses config with both initScriptPath and preMergeCommand", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: "./setup.sh",
        preMergeCommand: "./validate.sh",
      }),
    );
    const { readRepoConfig } = createRepoConfig(deps);

    const result = await readRepoConfig("/projects/foo");
    expect(result).toEqual({
      initScriptPath: "./setup.sh",
      preMergeCommand: "./validate.sh",
    });
  });

  it("parses config with only preMergeCommand (no initScriptPath)", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ preMergeCommand: "scripts/validate.sh" }),
    );
    const { readRepoConfig } = createRepoConfig(deps);

    const result = await readRepoConfig("/projects/foo");
    expect(result).toEqual({
      preMergeCommand: "scripts/validate.sh",
    });
    expect(result?.initScriptPath).toBeUndefined();
  });

  it("backward compat: parses config without preMergeCommand", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ initScriptPath: null }),
    );
    const { readRepoConfig } = createRepoConfig(deps);

    const result = await readRepoConfig("/projects/foo");
    expect(result).toEqual({ initScriptPath: null });
    expect(result?.preMergeCommand).toBeUndefined();
  });
});

// ===========================================================================
// executeRepoValidationCommand
// ===========================================================================

describe("executeRepoValidationCommand", () => {
  it("reports not-executed when no config file exists", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    const result = await executeRepoValidationCommand(BASE_PARAMS);

    expect(result.executed).toBe(false);
    expect(result.pass).toBe(true);
    expect(deps.execFileAsync).not.toHaveBeenCalled();
  });

  it("reports not-executed when preMergeCommand is null", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ initScriptPath: null, preMergeCommand: null }),
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    const result = await executeRepoValidationCommand(BASE_PARAMS);

    expect(result.executed).toBe(false);
    expect(deps.execFileAsync).not.toHaveBeenCalled();
  });

  it("reports not-executed when preMergeCommand is absent", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ initScriptPath: null }),
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    const result = await executeRepoValidationCommand(BASE_PARAMS);

    expect(result.executed).toBe(false);
    expect(deps.execFileAsync).not.toHaveBeenCalled();
  });

  it("executes script with correct env vars", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        if (String(p).includes("validate.sh")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    await executeRepoValidationCommand(BASE_PARAMS);

    expect(deps.execFileAsync).toHaveBeenCalledWith(
      "/projects/foo/validate.sh",
      [],
      expect.objectContaining({
        cwd: BASE_PARAMS.worktreePath,
        timeout: BASE_PARAMS.timeoutMs,
        env: expect.objectContaining({
          PROJECT_ROOT: BASE_PARAMS.worktreePath,
          CLAUDE_PROJECT_DIR: BASE_PARAMS.projectPath,
          WORKTREE_PATH: BASE_PARAMS.worktreePath,
          SESSION_NAME: BASE_PARAMS.sessionName,
          BRANCH_NAME: BASE_PARAMS.branchName,
          TARGET_BRANCH: BASE_PARAMS.targetBranch,
        }),
      }),
    );
  });

  it("forwards a non-main targetBranch as TARGET_BRANCH for stacked sessions", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        if (String(p).includes("validate.sh")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    await executeRepoValidationCommand({
      ...BASE_PARAMS,
      targetBranch: "csm/parent",
    });

    expect(deps.execFileAsync).toHaveBeenCalledWith(
      "/projects/foo/validate.sh",
      [],
      expect.objectContaining({
        env: expect.objectContaining({ TARGET_BRANCH: "csm/parent" }),
      }),
    );
  });

  it("throws when script file does not exist", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        if (String(p).includes("validate.sh")) return false;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    await expect(executeRepoValidationCommand(BASE_PARAMS)).rejects.toThrow(
      "Pre-merge validation script not found:",
    );
  });

  it("reports a failure with the combined script output", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        if (String(p).includes("validate.sh")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    const scriptErr = Object.assign(new Error("Command failed"), {
      stderr: "lint errors found",
      stdout: "2 problems",
    });
    (deps.execFileAsync as ReturnType<typeof vi.fn>).mockRejectedValue(
      scriptErr,
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    const result = await executeRepoValidationCommand(BASE_PARAMS);

    expect(result.executed).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.message).toBe("Pre-merge validation failed");
    expect(result.output).toContain("lint errors found");
    expect(result.output).toContain("2 problems");
  });

  it("reports a timeout with timedOut set when the script is killed by timeout", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        if (String(p).includes("validate.sh")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    const timeoutErr = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "",
      stdout: "All checks passed!\ntests starting...",
    });
    (deps.execFileAsync as ReturnType<typeof vi.fn>).mockRejectedValue(
      timeoutErr,
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    const result = await executeRepoValidationCommand(BASE_PARAMS);

    expect(result.executed).toBe(true);
    expect(result.pass).toBe(false);
    // The timeout-ness must survive on the result so the validation-fix loop
    // can distinguish an unfixable timeout from a fixable validation failure.
    expect(result.timedOut).toBe(true);
    expect(result.message).toContain("timed out");
    expect(result.message).toContain("300");
    expect(result.output).toContain("All checks passed!");
  });

  it("returns the raw script result on success", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        if (String(p).includes("validate.sh")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    const result = await executeRepoValidationCommand(BASE_PARAMS);

    expect(result).toEqual({
      executed: true,
      pass: true,
      stdout: "",
      stderr: "",
      output: "",
      timedOut: false,
      message: null,
      command: "/projects/foo/validate.sh",
    });
  });

  it("omits TARGET_BRANCH from the env when no targetBranch is given", async () => {
    const deps = createTestDeps();
    (deps.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        if (String(p).includes("CommandCenter.json")) return true;
        if (String(p).includes("validate.sh")) return true;
        return false;
      },
    );
    (deps.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        initScriptPath: null,
        preMergeCommand: "./validate.sh",
      }),
    );
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    (deps.execFileAsync as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _cmd: string,
        _args: string[],
        opts?: { env?: NodeJS.ProcessEnv },
      ) => {
        capturedEnv = opts?.env;
        return { stdout: "", stderr: "" };
      },
    );
    const { executeRepoValidationCommand } = createRepoConfig(deps);

    const { targetBranch: _omitted, ...paramsWithoutTarget } = BASE_PARAMS;
    await executeRepoValidationCommand(paramsWithoutTarget);

    expect(capturedEnv).toHaveProperty("BRANCH_NAME", BASE_PARAMS.branchName);
    expect(capturedEnv).not.toHaveProperty("TARGET_BRANCH");
  });
});
