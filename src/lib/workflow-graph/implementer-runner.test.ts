import { describe, expect, it, vi } from "vitest";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { createGraphWorkflowImplementerRunner } from "./implementer-runner";
import type { ExecutionTarget } from "./execution-target-resolver";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conversation-1",
    name: "Conversation 1",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    ...overrides,
  };
}

describe("graph workflow implementer runner", () => {
  it("executes claude implementer turns through prompt execution", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: 12_345,
      contextWindowMax: 200_000,
    }));
    const getConversation = vi.fn(async () =>
      makeConversation({
        backendRef: { backend: "claude" as const, sessionId: "sdk-session-1" },
      }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    const result = await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: {
        servers: [
          {
            id: "cc-graph-workflow",
            transport: "streamable-http",
            url: "http://127.0.0.1:3000/api/projects/project/sessions/session/mcp/graph-workflow/execution-1/contexts/context-plan",
          },
        ],
      },
    });

    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Inspect the codebase",
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({
        autonomous: true,
        backend: "claude",
        effort: "high",
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "cc-graph-workflow",
                transport: "streamable-http",
                url: "http://127.0.0.1:3000/api/projects/project/sessions/session/mcp/graph-workflow/execution-1/contexts/context-plan",
              },
            ],
          },
        },
      }),
    );
    expect(result).toEqual({
      conversationId: "conversation-1",
      contextTokens: 12_345,
      contextWindowMax: 200_000,
      sessionRef: { backend: "claude", sessionId: "sdk-session-1" },
    });
  });

  it("propagates codex backend to executePromptStream", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-codex",
      contextTokens: null,
      contextWindowMax: null,
    }));
    const getConversation = vi.fn(async () =>
      makeConversation({
        agentBackend: "codex",
        backendRef: { backend: "codex" as const, threadId: "thread-codex-1" },
      }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    const result = await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Implement feature",
      conversationId: "conversation-codex",
      contextId: "context-impl",
      backend: "codex",
      model: "codex-mini",
      reasoningEffort: "medium",
      toolServer: {
        servers: [
          {
            id: "cc-graph-workflow",
            transport: "streamable-http",
            url: "http://127.0.0.1:3000/mcp",
          },
        ],
      },
    });

    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Implement feature",
      expect.any(Function),
      "conversation-codex",
      "codex-mini",
      undefined,
      expect.objectContaining({
        autonomous: true,
        backend: "codex",
        effort: "medium",
      }),
    );
    expect(result).toEqual({
      conversationId: "conversation-codex",
      contextTokens: null,
      contextWindowMax: null,
      sessionRef: { backend: "codex", threadId: "thread-codex-1" },
    });
  });

  it("forwards executionTarget through executePromptStream options when provided", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
    }));
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    const executionTarget: ExecutionTarget = {
      worktreePath: "/repo/.worktrees/session-1.context-plan",
      branchName: "csm/session-1-context-plan",
      isolation: "worktree",
      laneId: null,
    };

    await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      executionTarget,
    });

    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Inspect the codebase",
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({
        executionTarget,
      }),
    );
  });

  it("does not forward an executionTarget when none is provided (solo flow)", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
    }));
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
    });

    expect(executePromptStream).toHaveBeenCalledTimes(1);
    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Inspect the codebase",
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.not.objectContaining({ executionTarget: expect.anything() }),
    );
  });

  it("requests background-task waiting deterministically on every implementer turn", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
    }));
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
    });

    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Inspect the codebase",
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({ waitForBackgroundTasks: true }),
    );
  });

  it("surfaces the backgroundWait summary in the return value when a wait occurred", async () => {
    const backgroundWait = {
      waitedTaskIds: ["task-a"],
      settledTaskIds: ["task-a"],
      timedOut: false,
      durationMs: 4200,
    };
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: 100,
      contextWindowMax: 200_000,
      backgroundWait,
    }));
    const getConversation = vi.fn(async () =>
      makeConversation({
        backendRef: { backend: "claude" as const, sessionId: "sdk-session-1" },
      }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    const result = await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Implement feature",
      conversationId: "conversation-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
    });

    expect(result).toEqual({
      conversationId: "conversation-1",
      contextTokens: 100,
      contextWindowMax: 200_000,
      sessionRef: { backend: "claude", sessionId: "sdk-session-1" },
      backgroundWait,
    });
  });

  it("omits backgroundWait from the return value when no wait occurred", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
    }));
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    const result = await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Implement feature",
      conversationId: "conversation-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
    });

    expect(result).not.toHaveProperty("backgroundWait");
  });

  it("throws when prompt execution returns an SDK error", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      error: "Claude API overloaded",
      aborted: false,
    }));
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation,
    });

    await expect(
      runner.runIteration({
        projectPath: "/repo",
        session: makeSession(),
        prompt: "Implement feature",
        conversationId: "conversation-1",
        contextId: "context-plan",
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
        toolServer: { servers: [] },
      }),
    ).rejects.toThrow("SDK error: Claude API overloaded");

    expect(getConversation).not.toHaveBeenCalled();
  });
});
