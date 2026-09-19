import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import { describe, expect, it, vi } from "vitest";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SessionState } from "@/lib/sessions/schemas";
import { createGraphWorkflowImplementerRunner } from "./implementer-runner";
import type { ExecutionTarget } from "./execution-target-resolver";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { ConversationTurnSettlementError } from "./errors";
import { ConversationTurnNotStartedError } from "./conversation-turn-result";
import type { ConversationTurnExecution } from "@/lib/workflows/conversation/manager";

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
  it("declares the lane identity at dispatch and threads it into the lane identity", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
      getConversation: vi.fn(async () => makeConversation()),
    });

    await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
        }),
        turn: expect.objectContaining({
          promptText: expect.any(String),
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        }),
        executionContext: expect.objectContaining({
          workflowContext: {
            executionId: "execution-1",
            contextId: "context-plan",
          },
        }),
        waitUntilReady: true,
      }),
    );
  });

  it("dispatches without a identity when the server has no extra credentials", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
      getConversation: vi.fn(async () => makeConversation()),
    });

    await runner.runIteration({
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Inspect the codebase",
      conversationId: "conversation-1",
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
        }),
        turn: expect.objectContaining({
          promptText: expect.any(String),
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        }),
        executionContext: expect.objectContaining({
          workflowContext: {
            executionId: "execution-1",
            contextId: "context-plan",
          },
        }),
        waitUntilReady: true,
      }),
    );
  });

  it("executes claude implementer turns through prompt execution", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({
        usage: { contextTokens: 12_345, contextWindowMax: 200_000 },
      }),
    );
    const getConversation = vi.fn(async () =>
      makeConversation({
        backendRef: { backend: "claude" as const, ref: "sdk-session-1" },
      }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
        }),
        turn: expect.objectContaining({
          promptText: "Inspect the codebase",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
          autonomous: true,
          backend: "claude",
        }),
        executionContext: expect.objectContaining({
          workflowContext: {
            executionId: "execution-1",
            contextId: "context-plan",
          },
        }),
        waitUntilReady: true,
      }),
    );
    expect(result).toEqual({
      conversationId: "conversation-1",
      contextTokens: 12_345,
      contextWindowMax: 200_000,
      sessionRef: { backend: "claude", ref: "sdk-session-1" },
    });
  });

  it("propagates codex backend to executeConversationTurn", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () =>
      makeConversation({
        agentBackend: "codex",
        backendRef: { backend: "codex" as const, ref: "thread-codex-1" },
      }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "codex-mini",
        parameters: { reasoning: "medium", fast: "false" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-codex",
            }),
          }),
        }),
        turn: expect.objectContaining({
          promptText: "Implement feature",
          modelSelection: {
            modelId: "codex-mini",
            parameters: { reasoning: "medium", fast: "false" },
          },
          autonomous: true,
          backend: "codex",
        }),
        waitUntilReady: true,
      }),
    );
    expect(result).toEqual({
      conversationId: "conversation-codex",
      contextTokens: null,
      contextWindowMax: null,
      sessionRef: { backend: "codex", ref: "thread-codex-1" },
    });
  });

  it("forwards executionTarget through executeConversationTurn options when provided", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
      executionTarget,
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
          worktreePath: executionTarget.worktreePath,
        }),
        turn: expect.objectContaining({
          promptText: "Inspect the codebase",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        }),
        waitUntilReady: true,
      }),
    );
  });

  it("does not forward an executionTarget when none is provided (solo flow)", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(executeConversationTurn).toHaveBeenCalledTimes(1);
    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
          worktreePath: "/repo/.worktrees/session-1",
        }),
        turn: expect.objectContaining({
          promptText: "Inspect the codebase",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        }),
        waitUntilReady: true,
      }),
    );
  });

  it("never passes an outputFormat, so the implementer turn keeps its streaming markdown body (R2.3)", async () => {
    // The D2 per-context `outputSchema` is captured by a dedicated format turn,
    // never by schema-constraining the work turn: an outputFormat here would
    // suppress the streaming turn body the UI renders. Contexts with and
    // without a declared schema must dispatch the identical request shape.
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(executeConversationTurn).toHaveBeenCalledTimes(1);
    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
        }),
        turn: expect.not.objectContaining({ outputFormat: expect.anything() }),
        waitUntilReady: true,
      }),
    );
  });

  it("requests background-task waiting deterministically on every implementer turn", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
        }),
        turn: expect.objectContaining({
          promptText: "Inspect the codebase",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
          waitForBackgroundTasks: true,
        }),
        waitUntilReady: true,
      }),
    );
  });

  it("forwards askUserQuestionsEnabled into executeConversationTurn options when set (Req 8.1)", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
      askUserQuestionsEnabled: true,
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
        }),
        turn: expect.objectContaining({
          promptText: "Inspect the codebase",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
          askUserQuestionsEnabled: true,
        }),
        waitUntilReady: true,
      }),
    );
  });

  it("forwards askUserQuestionsEnabled false into executeConversationTurn options when disabled", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
      askUserQuestionsEnabled: false,
    });

    expect(executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          kind: "durable",
          address: expect.objectContaining({
            projectPath: "/repo",
            target: expect.objectContaining({
              scope: "session",
              conversationId: "conversation-1",
            }),
          }),
        }),
        turn: expect.objectContaining({
          promptText: "Inspect the codebase",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
          askUserQuestionsEnabled: false,
        }),
        waitUntilReady: true,
      }),
    );
  });

  it("surfaces the backgroundWait summary in the return value when a wait occurred", async () => {
    const backgroundWait = {
      waitedTaskIds: ["task-a"],
      settledTaskIds: ["task-a"],
      timedOut: false,
      durationMs: 4200,
    };
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({
        usage: { contextTokens: 100, contextWindowMax: 200_000 },
        backgroundWait: backgroundWait,
      }),
    );
    const getConversation = vi.fn(async () =>
      makeConversation({
        backendRef: { backend: "claude" as const, ref: "sdk-session-1" },
      }),
    );

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(result).toEqual({
      conversationId: "conversation-1",
      contextTokens: 100,
      contextWindowMax: 200_000,
      sessionRef: { backend: "claude", ref: "sdk-session-1" },
      backgroundWait,
    });
  });

  it("omits backgroundWait from the return value when no wait occurred", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({ usage: {}, compacted: false }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build", mode: "full" },
    });

    expect(result).not.toHaveProperty("backgroundWait");
  });

  it("throws when prompt execution returns an SDK error", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn({
        usage: {},
        outcome: {
          kind: "failed",
          error: {
            backend: "claude",
            failureKind: "backend_error",
            message: "Claude API overloaded",
            retryable: false,
          },
        },
      }),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        placement: { lane: "build", mode: "full" },
      }),
    ).rejects.toThrow("SDK error: Claude API overloaded");

    expect(getConversation).not.toHaveBeenCalled();
  });

  it("throws a timeout-specific error when prompt execution times out", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn(
        {
          usage: {},
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "aborted",
              message: "Turn aborted",
              retryable: false,
            },
          },
        },
        { reason: "timeout" as const, timeoutMs: 10_800_000 },
      ),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        placement: { lane: "build", mode: "full" },
      }),
    ).rejects.toMatchObject({
      cause: "timeout",
      originalMessage: "Prompt execution timed out after 10800000ms",
    });

    expect(getConversation).not.toHaveBeenCalled();
  });

  it("throws a stall-specific error when the turn's inactivity watchdog fired", async () => {
    const executeConversationTurn = vi.fn(async () =>
      settledConversationTurn(
        {
          usage: {},
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "aborted",
              message: "Turn aborted",
              retryable: false,
            },
          },
        },
        { reason: "stalled" as const, timeoutMs: 1_200_000 },
      ),
    );
    const getConversation = vi.fn(async () => makeConversation());

    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn,
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
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { reasoning: "xhigh", fast: "false" },
        },
        placement: { lane: "build", mode: "full" },
      }),
    ).rejects.toMatchObject({
      cause: "stall",
      originalMessage:
        "Prompt execution stalled: no agent activity for 1200000ms",
    });

    expect(getConversation).not.toHaveBeenCalled();
  });

  function baseInput() {
    return {
      projectPath: "/repo",
      session: makeSession(),
      prompt: "Implement feature",
      conversationId: "conversation-1",
      executionId: "execution-1",
      contextId: "context-plan",
      backend: "claude" as const,
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      placement: { lane: "build" as const, mode: "full" as const },
    };
  }

  it("reports a settlement failure truthfully and rethrows the same typed error", async () => {
    const completedTurn = settledConversationTurn({
      usage: { costUsd: 0.4, inputTokens: 12 },
      outcome: {
        kind: "completed",
        text: "secret-ish provider text 5150",
        contentBlocks: [
          { type: "text", text: "secret-ish provider text 5150" },
        ],
      },
    });
    if (
      completedTurn.kind !== "settled" ||
      completedTurn.turn.outcome.kind !== "call_result"
    )
      throw new Error("Fixture did not produce a call result");
    const execution: ConversationTurnExecution = {
      kind: "settled",
      turn: {
        attemptId: "attempt-settle-1",
        status: "awaiting",
        pendingQuestion: null,
        outcome: {
          kind: "settlement_failed",
          code: "delivery_receipt",
          message: "receipt sink unavailable",
          result: completedTurn.turn.outcome.result,
        },
      },
    };
    const logger = createCapturingLogger();
    const getConversation = vi.fn(async () => makeConversation());
    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn: vi.fn(async () => execution),
      getConversation,
      logger,
    });

    const thrown = await runner.runIteration(baseInput()).then(
      () => {
        throw new Error("expected rejection");
      },
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(ConversationTurnSettlementError);
    if (!(thrown instanceof ConversationTurnSettlementError))
      throw new Error("unreachable");
    expect(thrown.outcome).toBe(execution.turn.outcome);
    expect(getConversation).not.toHaveBeenCalled();

    const warning = logger.entries.find(
      (entry) => entry.message === "graph-workflow.implementer.turn_failed",
    );
    expect(warning?.level).toBe("warn");
    expect(warning?.fields).toEqual({
      sessionName: "session-1",
      conversationId: "conversation-1",
      contextId: "context-plan",
      backend: "claude",
      error: "receipt sink unavailable",
      cause: "settlement_failed",
      settlementCode: "delivery_receipt",
      attemptId: "attempt-settle-1",
    });
    expect(JSON.stringify(logger.allFieldValues())).not.toContain(
      "secret-ish provider text 5150",
    );
  });

  it("keeps a genuine admission refusal classified as not_started", async () => {
    const logger = createCapturingLogger();
    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn: vi.fn(async () => ({
        kind: "refused" as const,
        code: "busy" as const,
        message: "Conversation is busy",
      })),
      getConversation: vi.fn(async () => makeConversation()),
      logger,
    });
    await expect(runner.runIteration(baseInput())).rejects.toBeInstanceOf(
      ConversationTurnNotStartedError,
    );
    const warning = logger.entries.find(
      (entry) => entry.message === "graph-workflow.implementer.turn_failed",
    );
    expect(warning?.fields).toMatchObject({ cause: "not_started" });
    expect(warning?.fields).not.toHaveProperty("settlementCode");
  });

  it("does not label an unexpected paused outcome as an admission refusal", async () => {
    const logger = createCapturingLogger();
    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn: vi.fn(async () =>
        settledConversationTurn({
          outcome: {
            kind: "paused",
            pauseKind: "post_turn",
            resumeToken: "pending",
          },
        }),
      ),
      getConversation: vi.fn(async () => makeConversation()),
      logger,
    });
    const thrown = await runner.runIteration(baseInput()).then(
      () => {
        throw new Error("expected rejection");
      },
      (error: unknown) => error,
    );
    expect(thrown).not.toBeInstanceOf(ConversationTurnNotStartedError);
    expect(thrown).not.toBeInstanceOf(ConversationTurnSettlementError);
    const warning = logger.entries.find(
      (entry) => entry.message === "graph-workflow.implementer.turn_failed",
    );
    expect(warning?.fields).toMatchObject({ cause: "unknown" });
  });
});
