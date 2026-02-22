import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  execFileMock,
  existsSyncMock,
  mkdirMock,
  writeFileMock,
  getConfigDirPathMock,
  homedirMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn<(p: string) => boolean>(),
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  getConfigDirPathMock: vi.fn(),
  homedirMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: execFileMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

vi.mock("node:os", () => ({
  default: { homedir: homedirMock },
  homedir: homedirMock,
}));

vi.mock("./config", () => ({
  getConfigDirPath: getConfigDirPathMock,
}));

vi.mock("./logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import {
  resolveConfig,
  buildContainerEnv,
  containerName,
  prepareSessionEnvironment,
  stopAndRemoveContainer,
  isContainerRunning,
  getContainerLogs,
  reconcileContainers,
} from "./devcontainer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      if (cb) cb(null, { stdout, stderr });
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
      if (cb) cb(error, { stdout: "", stderr: "" });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(false);
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  getConfigDirPathMock.mockReturnValue("/tmp/csm-config");
  homedirMock.mockReturnValue("/home/testuser");
});

// ===========================================================================
// resolveConfig
// ===========================================================================

describe("resolveConfig", () => {
  it("returns project config when .devcontainer/devcontainer.json exists", () => {
    existsSyncMock.mockImplementation((p: string) =>
      String(p).includes(".devcontainer/devcontainer.json"),
    );

    const result = resolveConfig("/home/user/project");

    expect(result.isDefault).toBe(false);
    expect(result.configPath).toContain(".devcontainer/devcontainer.json");
  });

  it("returns CSM default config when project has no devcontainer.json", () => {
    existsSyncMock.mockReturnValue(false);

    const result = resolveConfig("/home/user/project");

    expect(result.isDefault).toBe(true);
    expect(result.configPath).toContain(
      "devcontainer-defaults/devcontainer.json",
    );
  });
});

// ===========================================================================
// buildContainerEnv
// ===========================================================================

describe("buildContainerEnv", () => {
  // Helper to save/restore env vars around each test
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_CONFIG",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("includes ANTHROPIC_API_KEY when set", () => {
    process.env["ANTHROPIC_API_KEY"] = "test-api-key-123";

    const env = buildContainerEnv("/project/path", "my-session");

    expect(env.ANTHROPIC_API_KEY).toBe("test-api-key-123");
    expect(env.CSM_PROJECT_PATH).toBe("/project/path");
    expect(env.CSM_SESSION_NAME).toBe("my-session");
    expect(env.DEVCONTAINER).toBe("true");
  });

  it("includes CLAUDE_CODE_OAUTH_TOKEN when set", () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-test";

    const env = buildContainerEnv("/project", "session");

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("succeeds with no env vars when credentials file exists", () => {
    existsSyncMock.mockImplementation((p: string) =>
      String(p).includes(".credentials.json"),
    );

    const env = buildContainerEnv("/project", "session");

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CSM_PROJECT_PATH).toBe("/project");
  });

  it("throws when no auth method is available", () => {
    existsSyncMock.mockReturnValue(false);

    expect(() => buildContainerEnv("/project", "session")).toThrow(
      "No authentication method available",
    );
  });

  it("does not include CLAUDE* host environment variables", () => {
    process.env["ANTHROPIC_API_KEY"] = "key";
    process.env["CLAUDE_CODE_CONFIG"] = "something";

    const env = buildContainerEnv("/project", "session");

    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "CSM_PROJECT_PATH",
      "CSM_SESSION_NAME",
      "DEVCONTAINER",
    ]);
  });
});

// ===========================================================================
// containerName
// ===========================================================================

describe("containerName", () => {
  it("generates name with csm- prefix and short hash", () => {
    const name = containerName("my-feature");

    expect(name).toMatch(/^csm-my-feature-[a-f0-9]{8}$/);
  });

  it("sanitizes special characters", () => {
    const name = containerName("My Feature Session!");

    expect(name).toMatch(/^csm-my-feature-session-[a-f0-9]{8}$/);
  });

  it("generates deterministic names for same input", () => {
    expect(containerName("test")).toBe(containerName("test"));
  });

  it("generates different names for different inputs", () => {
    expect(containerName("session-a")).not.toBe(containerName("session-b"));
  });
});

// ===========================================================================
// prepareSessionEnvironment
// ===========================================================================

describe("prepareSessionEnvironment", () => {
  it("creates claude dir and writes hook script and settings", async () => {
    const claudeDir = await prepareSessionEnvironment(
      "test-session",
      "/project",
      3000,
    );

    expect(mkdirMock).toHaveBeenCalledWith(
      expect.stringContaining("containers/"),
      {
        recursive: true,
      },
    );

    // Should write hook script
    const hookCall = writeFileMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("csm-hook.sh"),
    );
    expect(hookCall).toBeDefined();
    expect(hookCall![1]).toContain("host.docker.internal");
    expect(hookCall![1]).toContain("CSM_PROJECT_PATH");
    expect(hookCall![1]).toContain("CSM_SESSION_NAME");
    expect(hookCall![2]).toEqual({ mode: 0o755 });

    // Should write settings.json
    const settingsCall = writeFileMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("settings.json"),
    );
    expect(settingsCall).toBeDefined();
    const settings = JSON.parse(settingsCall![1] as string);
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();

    // Should write onboarding.json
    const onboardingCall = writeFileMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("onboarding.json"),
    );
    expect(onboardingCall).toBeDefined();
    const onboarding = JSON.parse(onboardingCall![1] as string);
    expect(onboarding.hasCompletedOnboarding).toBe(true);

    // Returns the claude dir path
    expect(claudeDir).toContain("containers/");
  });

  it("does not copy credentials (bind-mounted at container start instead)", async () => {
    existsSyncMock.mockReturnValue(false);

    await prepareSessionEnvironment("test-session", "/project", 3000);

    // Credentials are bind-mounted read-only by startContainer, not copied here
    const writeTargets = writeFileMock.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      writeTargets.every((t: string) => !t.includes(".credentials.json")),
    ).toBe(true);
  });
});

// ===========================================================================
// stopAndRemoveContainer
// ===========================================================================

describe("stopAndRemoveContainer", () => {
  it("calls docker stop then docker rm", async () => {
    mockExecFileSuccess();

    await stopAndRemoveContainer("container-abc");

    expect(execFileMock).toHaveBeenCalledTimes(2);
    // First call: docker stop
    expect(execFileMock.mock.calls[0]![0]).toBe("docker");
    expect(execFileMock.mock.calls[0]![1]).toContain("stop");
    // Second call: docker rm
    expect(execFileMock.mock.calls[1]![0]).toBe("docker");
    expect(execFileMock.mock.calls[1]![1]).toContain("rm");
  });

  it("handles already-stopped container gracefully", async () => {
    let callCount = 0;
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
        callCount++;
        if (callCount === 1 && cb) {
          cb(new Error("is not running"), { stdout: "", stderr: "" });
        } else if (cb) {
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    // Should not throw
    await stopAndRemoveContainer("already-stopped");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("handles already-removed container gracefully", async () => {
    mockExecFileFailure(new Error("No such container"));

    // Should not throw
    await stopAndRemoveContainer("already-removed");
  });
});

// ===========================================================================
// isContainerRunning
// ===========================================================================

describe("isContainerRunning", () => {
  it("returns true when container is running", async () => {
    mockExecFileSuccess("true\n");
    expect(await isContainerRunning("abc")).toBe(true);
  });

  it("returns false when container is stopped", async () => {
    mockExecFileSuccess("false\n");
    expect(await isContainerRunning("abc")).toBe(false);
  });

  it("returns false when docker inspect fails", async () => {
    mockExecFileFailure(new Error("No such container"));
    expect(await isContainerRunning("nonexistent")).toBe(false);
  });
});

// ===========================================================================
// getContainerLogs
// ===========================================================================

describe("getContainerLogs", () => {
  it("returns combined stdout and stderr", async () => {
    mockExecFileSuccess("log line 1\nlog line 2\n", "error line\n");
    const logs = await getContainerLogs("abc", 50);

    expect(logs).toContain("log line 1");
    expect(logs).toContain("error line");
    expect(execFileMock.mock.calls[0]![1]).toContain("--tail");
    expect(execFileMock.mock.calls[0]![1]).toContain("50");
  });

  it("throws on docker logs failure", async () => {
    mockExecFileFailure(new Error("container gone"));
    await expect(getContainerLogs("gone")).rejects.toThrow(
      "Failed to get container logs",
    );
  });
});

// ===========================================================================
// reconcileContainers
// ===========================================================================

describe("reconcileContainers", () => {
  it("skips sessions without containerId", async () => {
    const actions = await reconcileContainers([
      { containerId: null, sessionName: "no-container" },
    ]);
    expect(actions).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("marks non-running containers as unhealthy", async () => {
    mockExecFileSuccess("false\n"); // docker inspect returns false

    const actions = await reconcileContainers([
      { containerId: "stale-abc", sessionName: "stale-session" },
    ]);

    expect(actions).toEqual([
      { sessionName: "stale-session", action: "marked-unhealthy" },
    ]);
  });

  it("takes no action for running containers", async () => {
    mockExecFileSuccess("true\n");

    const actions = await reconcileContainers([
      { containerId: "running-abc", sessionName: "healthy-session" },
    ]);

    expect(actions).toEqual([]);
  });
});
