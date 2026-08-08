import { describe, expect, it, vi } from "vitest";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
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
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    profileSnapshot: null,
    id: "conversation-1",
    name: "Conversation 1",
    status: "new",
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    ...overrides,
  });
}

describe("graph workflow implementer runner", () => {
  it("mints the lane capability at dispatch and threads it into the lane identity", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    }));
    const mintLaneCapability = vi.fn(() => "cclc1.payload.signature");

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation: vi.fn(async () => makeConversation()),
      mintLaneCapability,
    });

    await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
    });

    // Scoped to all three facts — the route refuses a capability whose
    // conversation is no longer the context's bound implementer.
    expect(mintLaneCapability).toHaveBeenCalledWith({
      executionId: "execution-1",
      contextId: "context-plan",
      conversationId: "conversation-1",
    });
    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.anything(),
      expect.any(String),
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({
        workflowContext: {
          executionId: "execution-1",
          contextId: "context-plan",
          laneCapability: "cclc1.payload.signature",
        },
      }),
    );
  });

  it("dispatches without a capability when the server has no signing token", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    }));

    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream,
      getConversation: vi.fn(async () => makeConversation()),
      mintLaneCapability: () => null,
    });

    await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
    });

    // Fail-closed rather than fail-open: the lane still runs, it simply holds
    // no credential (exact match — no `laneCapability` key at all), so its
    // expansion attempts are refused at the route.
    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.anything(),
      expect.any(String),
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({
        workflowContext: {
          executionId: "execution-1",
          contextId: "context-plan",
        },
      }),
    );
  });

  it("executes claude implementer turns through prompt execution", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: 12_345,
      contextWindowMax: 200_000,
      compacted: false,
    }));
    const getConversation = vi.fn(async () =>
      makeConversation({
        backendRef: { backend: "claude" as const, ref: "sdk-session-1" },
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: {
        servers: [
          {
            id: "transient-tool",
            transport: "streamable-http",
            url: "http://127.0.0.1:3000/api/projects/project/sessions/session/mcp/graph-workflow/execution-1/contexts/context-plan",
          },
        ],
      },
      placement: { lane: "build", mode: "full" },
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
        workflowContext: {
          executionId: "execution-1",
          contextId: "context-plan",
        },
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "transient-tool",
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
      compacted: false,
      sessionRef: { backend: "claude", ref: "sdk-session-1" },
    });
  });

  it("propagates codex backend to executePromptStream", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-codex",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    }));
    const getConversation = vi.fn(async () =>
      makeConversation({
        agentBackend: "codex",
        backendRef: { backend: "codex" as const, ref: "thread-codex-1" },
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
      executionId: "execution-1",
      contextId: "context-impl",
      backend: "codex",
      model: "codex-mini",
      reasoningEffort: "medium",
      toolServer: {
        servers: [
          {
            id: "transient-tool",
            transport: "streamable-http",
            url: "http://127.0.0.1:3000/mcp",
          },
        ],
      },
      placement: { lane: "build", mode: "full" },
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
      compacted: false,
      sessionRef: { backend: "codex", ref: "thread-codex-1" },
    });
  });

  it("forwards executionTarget through executePromptStream options when provided", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
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
      compacted: false,
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
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

  it("never passes an outputFormat, so the implementer turn keeps its streaming markdown body (R2.3)", async () => {
    // The D2 per-context `outputSchema` is captured by a dedicated format turn,
    // never by schema-constraining the work turn: an outputFormat here would
    // suppress the streaming turn body the UI renders. Contexts with and
    // without a declared schema must dispatch the identical request shape.
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
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
      expect.not.objectContaining({ outputFormat: expect.anything() }),
    );
  });

  it("requests background-task waiting deterministically on every implementer turn", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
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
        waitForBackgroundTasks: true,
        waitForConversationReady: true,
      }),
    );
  });

  it("forwards askUserQuestionsEnabled into executePromptStream options when set (Req 8.1)", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
      askUserQuestionsEnabled: true,
    });

    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Inspect the codebase",
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({ askUserQuestionsEnabled: true }),
    );
  });

  it("forwards askUserQuestionsEnabled false into executePromptStream options when disabled", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
      askUserQuestionsEnabled: false,
    });

    expect(executePromptStream).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ sessionName: "session-1" }),
      "Inspect the codebase",
      expect.any(Function),
      "conversation-1",
      "opus",
      undefined,
      expect.objectContaining({ askUserQuestionsEnabled: false }),
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
      compacted: false,
      backgroundWait,
    }));
    const getConversation = vi.fn(async () =>
      makeConversation({
        backendRef: { backend: "claude" as const, ref: "sdk-session-1" },
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
    });

    expect(result).toEqual({
      conversationId: "conversation-1",
      contextTokens: 100,
      contextWindowMax: 200_000,
      compacted: false,
      sessionRef: { backend: "claude", ref: "sdk-session-1" },
      backgroundWait,
    });
  });

  it("omits backgroundWait from the return value when no wait occurred", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
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
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
      toolServer: { servers: [] },
      placement: { lane: "build", mode: "full" },
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
      compacted: false,
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
        executionId: "execution-1",
        contextId: "context-plan",
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
        toolServer: { servers: [] },
        placement: { lane: "build", mode: "full" },
      }),
    ).rejects.toThrow("SDK error: Claude API overloaded");

    expect(getConversation).not.toHaveBeenCalled();
  });

  it("throws a timeout-specific error when prompt execution times out", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      aborted: true,
      compacted: false,
      abortReason: "timeout" as const,
      timeoutMs: 10_800_000,
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
        executionId: "execution-1",
        contextId: "context-plan",
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
        toolServer: { servers: [] },
        placement: { lane: "build", mode: "full" },
      }),
    ).rejects.toMatchObject({
      cause: "timeout",
      originalMessage: "Prompt execution timed out after 10800000ms",
    });

    expect(getConversation).not.toHaveBeenCalled();
  });

  it("throws a stall-specific error when the turn's inactivity watchdog fired", async () => {
    const executePromptStream = vi.fn(async () => ({
      conversationId: "conversation-1",
      contextTokens: null,
      contextWindowMax: null,
      aborted: true,
      compacted: false,
      abortReason: "stalled" as const,
      timeoutMs: 1_200_000,
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
        executionId: "execution-1",
        contextId: "context-plan",
        backend: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        toolServer: { servers: [] },
        placement: { lane: "build", mode: "full" },
      }),
    ).rejects.toMatchObject({
      cause: "stall",
      originalMessage:
        "Prompt execution stalled: no agent activity for 1200000ms",
    });

    expect(getConversation).not.toHaveBeenCalled();
  });
});
