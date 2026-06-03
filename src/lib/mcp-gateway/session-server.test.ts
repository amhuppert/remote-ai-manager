import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: [],
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
      conversations: [{ id: "conv-1" }],
    })),
    readConfig: vi.fn(async () => makeConfig()),
    registerReferenceDocumentTools: vi.fn(),
    registerPlannerTools: vi.fn(),
    registerNotificationTool: vi.fn(),
    registerCodexTool: vi.fn(),
    registerAskUserQuestionTool: vi.fn(),
    registerDevServerTools: vi.fn(),
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
      { name: "my-project", session: "test session", conversationId: "conv-1" },
      deps,
    );

    expect(deps.registerReferenceDocumentTools).toHaveBeenCalledOnce();
    expect(deps.registerPlannerTools).toHaveBeenCalledOnce();
    expect(deps.registerDevServerTools).toHaveBeenCalledOnce();
    const devServerCall = (
      deps.registerDevServerTools as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(devServerCall[1]).toMatchObject({
      projectPath: "/projects/test",
      sessionName: "test session",
    });
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
      { name: "my-project", session: "test session", conversationId: "conv-1" },
      deps,
    );

    expect(deps.registerNotificationTool).toHaveBeenCalledOnce();
    expect(deps.registerCodexTool).toHaveBeenCalledOnce();
    const codexCall = (deps.registerCodexTool as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(codexCall[1]).toMatchObject({
      projectPath: "/projects/test",
      worktreePath: "/projects/test/.worktrees/test-session",
      sessionName: "test session",
    });
  });

  it("does not register optional tools when disabled", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps();

    await createSessionMcpServer(
      { name: "my-project", session: "test session", conversationId: "conv-1" },
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
        {
          name: "missing-project",
          session: "test session",
          conversationId: "conv-1",
        },
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
        {
          name: "my-project",
          session: "missing session",
          conversationId: "conv-1",
        },
        deps,
      ),
    ).rejects.toThrow("Session not found");
  });

  it("throws when the conversation cannot be found in the session", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps({
      getSession: vi.fn(async () => ({
        sessionName: "test session",
        worktreePath: "/projects/test/.worktrees/test-session",
        conversations: [{ id: "other-conv" }],
      })),
    });

    await expect(
      createSessionMcpServer(
        {
          name: "my-project",
          session: "test session",
          conversationId: "missing-conv",
        },
        deps,
      ),
    ).rejects.toThrow("Conversation not found");
  });

  it("registers the AskUserQuestion tool with the conversation context", async () => {
    const { createSessionMcpServer } = await import("./session-server");
    const deps = createDeps();

    await createSessionMcpServer(
      { name: "my-project", session: "test session", conversationId: "conv-1" },
      deps,
    );

    expect(deps.registerAskUserQuestionTool).toHaveBeenCalledOnce();
    const call = (deps.registerAskUserQuestionTool as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(call[1]).toMatchObject({
      projectPath: "/projects/test",
      sessionName: "test session",
      conversationId: "conv-1",
    });
  });

  describe("project sentinel (session-less project conversation)", () => {
    it("builds a project-safe server without a session lookup", async () => {
      const { createSessionMcpServer } = await import("./session-server");
      const deps = createDeps();

      const server = await createSessionMcpServer(
        {
          name: "my-project",
          session: "__project__",
          conversationId: "conv-1",
        },
        deps,
      );

      expect(server).toBeDefined();
      // No session row exists for the sentinel — getSession must not be called.
      expect(deps.getSession).not.toHaveBeenCalled();
    });

    it("excludes dev-server and session-scoped tools per the main-worktree guard", async () => {
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
            codex: { enabled: true, model: "gpt-5.4" },
          }),
        ),
      });

      await createSessionMcpServer(
        {
          name: "my-project",
          session: "__project__",
          conversationId: "conv-1",
        },
        deps,
      );

      expect(deps.registerDevServerTools).not.toHaveBeenCalled();
      expect(deps.registerReferenceDocumentTools).not.toHaveBeenCalled();
      expect(deps.registerPlannerTools).not.toHaveBeenCalled();
      expect(deps.registerCodexTool).not.toHaveBeenCalled();
    });

    it("registers AskUserQuestion routed to the project sentinel", async () => {
      const { createSessionMcpServer } = await import("./session-server");
      const deps = createDeps();

      await createSessionMcpServer(
        {
          name: "my-project",
          session: "__project__",
          conversationId: "conv-1",
        },
        deps,
      );

      expect(deps.registerAskUserQuestionTool).toHaveBeenCalledOnce();
      const call = (
        deps.registerAskUserQuestionTool as ReturnType<typeof vi.fn>
      ).mock.calls[0]!;
      expect(call[1]).toMatchObject({
        projectPath: "/projects/test",
        sessionName: "__project__",
        conversationId: "conv-1",
      });
    });
  });
});
