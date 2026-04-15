import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/types";

function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: [],
    stateFilePath: "/tmp/state.json",
    claudeTimeoutMs: 3_600_000,
    defaultModel: "opus",
    defaultAgentBackend: "claude",
    pushNotification: {
      enabled: false,
      provider: "ntfy",
      serverUrl: "https://ntfy.sh",
      topic: "",
      triggers: {
        jobCompleted: true,
        waitingForInput: true,
        workflowCompleted: true,
        workflowHalted: true,
        conversationIdle: true,
      },
    },
    codex: {
      enabled: false,
      model: "gpt-5.4",
    },
    ...overrides,
  };
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    resolveProjectPath: vi.fn(async () => "/projects/test"),
    getSession: vi.fn(async () => ({
      sessionName: "test session",
      worktreePath: "/projects/test/.worktrees/test-session",
    })),
    readConfig: vi.fn(async () => makeConfig()),
    registerRoadmapTools: vi.fn(),
    registerReferenceDocumentTools: vi.fn(),
    registerPlannerTools: vi.fn(),
    registerNotificationTool: vi.fn(),
    registerCodexTool: vi.fn(),
    ...overrides,
  };
}

describe("mcp-gateway/session-server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the static session tools", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps();

    await createSessionMcpServer(
      { name: "my-project", session: "test session" },
      deps,
    );

    expect(deps.registerRoadmapTools).toHaveBeenCalledOnce();
    expect(deps.registerReferenceDocumentTools).toHaveBeenCalledOnce();
    expect(deps.registerPlannerTools).toHaveBeenCalledOnce();
  });

  it("registers notification and Codex tools only when enabled", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps({
      readConfig: vi.fn(async () =>
        makeConfig({
          pushNotification: {
            enabled: true,
            provider: "ntfy",
            serverUrl: "https://ntfy.sh",
            topic: "alerts",
            triggers: {
              jobCompleted: true,
              waitingForInput: true,
              workflowCompleted: true,
              workflowHalted: true,
              conversationIdle: true,
            },
          },
          codex: {
            enabled: true,
            model: "gpt-5.4",
          },
        }),
      ),
    });

    await createSessionMcpServer(
      { name: "my-project", session: "test session" },
      deps,
    );

    expect(deps.registerNotificationTool).toHaveBeenCalledOnce();
    expect(deps.registerCodexTool).toHaveBeenCalledOnce();
  });

  it("does not register optional tools when disabled", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps();

    await createSessionMcpServer(
      { name: "my-project", session: "test session" },
      deps,
    );

    expect(deps.registerNotificationTool).not.toHaveBeenCalled();
    expect(deps.registerCodexTool).not.toHaveBeenCalled();
  });

  it("throws when the project cannot be resolved", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps({
      resolveProjectPath: vi.fn(async () => null),
    });

    await expect(
      createSessionMcpServer(
        { name: "missing-project", session: "test session" },
        deps,
      ),
    ).rejects.toThrow("Project not found");
  });

  it("throws when the session cannot be loaded", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps({
      getSession: vi.fn(async () => null),
    });

    await expect(
      createSessionMcpServer(
        { name: "my-project", session: "missing session" },
        deps,
      ),
    ).rejects.toThrow("Session not found");
  });
});
