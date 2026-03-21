import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SessionState,
  RalphLoopWorkflow,
  ConversationState,
  GitIterationMetrics,
} from "@/types";
import {
  createOrchestrator,
  type OrchestratorDeps,
  type RunIterationParams,
} from "./orchestrator";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDeps(): OrchestratorDeps {
  const sessions = new Map<string, SessionState>();

  return {
    query: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        // Emit a system message
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
        };
        // Emit an assistant message
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Working on the task..." }],
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 0,
            },
          },
        };
        // Emit a result message
        yield {
          type: "result",
          total_cost_usd: 0.05,
          duration_ms: 30000,
          num_turns: 3,
        };
      },
    })) as unknown as OrchestratorDeps["query"],

    buildChildEnv: vi.fn(() => ({
      PATH: "/usr/bin",
    })) as unknown as OrchestratorDeps["buildChildEnv"],

    mutateSession: vi.fn(
      async (
        _projectPath: string,
        _sessionName: string,
        _label: string,
        mutate: (session: SessionState) => unknown,
      ) => {
        const key = `${_projectPath}::${_sessionName}`;
        const session = sessions.get(key);
        if (session) {
          return mutate(session);
        }
        return null;
      },
    ) as unknown as OrchestratorDeps["mutateSession"],

    acquireSessionLock: vi.fn(() =>
      vi.fn(),
    ) as unknown as OrchestratorDeps["acquireSessionLock"],

    createConversation: vi.fn(async () => ({
      id: "conv-iter-001",
      name: null,
      claudeSessionId: null,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
      createdAt: "2026-03-01T10:00:00Z",
      lastActivityAt: "2026-03-01T10:00:00Z",
      source: "cc" as const,
      summary: null,
      archived: false,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom: null,
      role: "iteration" as const,
    })) as unknown as OrchestratorDeps["createConversation"],

    getTranscriptPath: vi.fn(
      async (id: string) => `/tmp/transcripts/${id}.jsonl`,
    ) as unknown as OrchestratorDeps["getTranscriptPath"],

    safeAppendTranscriptEntry: vi.fn(
      async () => {},
    ) as unknown as OrchestratorDeps["safeAppendTranscriptEntry"],

    broadcast: vi.fn() as unknown as OrchestratorDeps["broadcast"],

    buildIterationPrompt: vi.fn(
      () => "Execute iteration prompt text",
    ) as unknown as OrchestratorDeps["buildIterationPrompt"],

    createToolServer: vi.fn(() => ({
      __mock: true,
    })) as unknown as OrchestratorDeps["createToolServer"],

    processCircuitBreaker: vi.fn((current) => ({
      ...current,
    })) as unknown as OrchestratorDeps["processCircuitBreaker"],

    captureSnapshot: vi.fn(
      async () => "snapshot-hash-abc",
    ) as unknown as OrchestratorDeps["captureSnapshot"],

    computeDiff: vi.fn(
      async (): Promise<GitIterationMetrics> => ({
        filesChanged: 2,
        linesAdded: 50,
        linesRemoved: 10,
        changedFiles: ["src/foo.ts", "src/bar.ts"],
      }),
    ) as unknown as OrchestratorDeps["computeDiff"],

    classifyProgress: vi.fn(
      () => "progress" as const,
    ) as unknown as OrchestratorDeps["classifyProgress"],

    applyFixPlanUpdate: vi.fn((plan, update, iter) => {
      void update;
      void iter;
      return {
        plan,
        completedIds: [],
        skippedIds: [],
        addedIds: [],
      };
    }) as unknown as OrchestratorDeps["applyFixPlanUpdate"],

    workflowStreamEmit:
      vi.fn() as unknown as OrchestratorDeps["workflowStreamEmit"],

    acquireQuerySlot: vi.fn(async () =>
      vi.fn(),
    ) as unknown as OrchestratorDeps["acquireQuerySlot"],

    readConfig: vi.fn(
      async () => ({}),
    ) as unknown as OrchestratorDeps["readConfig"],
  };
}

function makeWorkflow(
  overrides?: Partial<RalphLoopWorkflow>,
): RalphLoopWorkflow {
  return {
    status: "running",
    objective: "Implement feature X",
    fixPlan: [],
    references: [],
    config: {
      maxIterations: 20,
      iterationTimeoutMs: 3_600_000,
      contextSoftLimitTokens: 160_000,
      contextHardLimitTokens: 180_000,
      circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
    },
    circuitBreaker: {
      state: "closed" as const,
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 0,
    },
    iterations: [],
    haltReason: null,
    generatingPlan: false,
    createdAt: "2026-03-01T09:00:00Z",
    startedAt: "2026-03-01T10:00:00Z",
    completedAt: null,
    totalCostUsd: 0,
    totalDurationMs: 0,
    currentIterationConversationId: null,
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionName: "test-session",
    branchName: "csm/test-session",
    worktreePath: "/tmp/worktrees/test-session",
    createdAt: "2026-03-01T09:00:00Z",
    lastActivityAt: "2026-03-01T10:00:00Z",
    objective: "Feature X",
    conversations: [] as ConversationState[],
    mode: "worktree" as const,
    workflow: makeWorkflow(),
    ...overrides,
  } as SessionState;
}

function makeIterationParams(
  overrides?: Partial<RunIterationParams>,
): RunIterationParams {
  const session = makeSession();
  return {
    projectPath: "/home/user/project",
    sessionName: "test-session",
    projectName: "project",
    session,
    workflow: session.workflow!,
    iterationNumber: 1,
    abortController: new AbortController(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orchestrator", () => {
  let deps: OrchestratorDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createTestDeps();
  });

  describe("runIteration", () => {
    it("creates a conversation and sets up transcript path", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.createConversation).toHaveBeenCalledWith(
        params.projectPath,
        params.sessionName,
        { role: "iteration" },
      );
      expect(deps.getTranscriptPath).toHaveBeenCalledWith("conv-iter-001");
    });

    it("acquires query slot and session lock", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.acquireQuerySlot).toHaveBeenCalledWith(
        "ralph:test-session:iter1",
      );
      expect(deps.acquireSessionLock).toHaveBeenCalledWith(
        params.projectPath,
        params.sessionName,
      );
    });

    it("releases query slot and session lock after iteration", async () => {
      const releaseSlot = vi.fn();
      const releaseLock = vi.fn();
      deps.acquireQuerySlot = vi.fn(
        async () => releaseSlot,
      ) as unknown as OrchestratorDeps["acquireQuerySlot"];
      deps.acquireSessionLock = vi.fn(
        () => releaseLock,
      ) as unknown as OrchestratorDeps["acquireSessionLock"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(releaseSlot).toHaveBeenCalled();
      expect(releaseLock).toHaveBeenCalled();
    });

    it("captures git snapshot before and computes diff after iteration", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.captureSnapshot).toHaveBeenCalledWith(
        params.session.worktreePath,
      );
      expect(deps.computeDiff).toHaveBeenCalledWith(
        params.session.worktreePath,
        "snapshot-hash-abc",
      );
    });

    it("calls SDK query with correct configuration", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.query).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Execute iteration prompt text",
          options: expect.objectContaining({
            permissionMode: "bypassPermissions",
            persistSession: false,
            cwd: params.session.worktreePath,
          }),
        }),
      );
    });

    it("appends transcript entries for SDK messages", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      // User prompt + system + assistant + result = 4 entries
      expect(deps.safeAppendTranscriptEntry).toHaveBeenCalledTimes(4);

      // First call: user prompt
      expect(deps.safeAppendTranscriptEntry).toHaveBeenCalledWith(
        "conv-iter-001",
        expect.objectContaining({ type: "user", role: "user" }),
      );

      // System message
      expect(deps.safeAppendTranscriptEntry).toHaveBeenCalledWith(
        "conv-iter-001",
        expect.objectContaining({ type: "system" }),
      );

      // Assistant message
      expect(deps.safeAppendTranscriptEntry).toHaveBeenCalledWith(
        "conv-iter-001",
        expect.objectContaining({ type: "assistant", role: "assistant" }),
      );

      // Result
      expect(deps.safeAppendTranscriptEntry).toHaveBeenCalledWith(
        "conv-iter-001",
        expect.objectContaining({ type: "result" }),
      );
    });

    it("emits iteration-boundary events for start and completion", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.workflowStreamEmit).toHaveBeenCalledWith(
        params.projectPath,
        params.sessionName,
        { type: "iteration-boundary", iterationNumber: 1, status: "started" },
      );
      expect(deps.workflowStreamEmit).toHaveBeenCalledWith(
        params.projectPath,
        params.sessionName,
        {
          type: "iteration-boundary",
          iterationNumber: 1,
          status: "completed",
        },
      );
    });

    it("streams assistant content blocks to workflow stream", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.workflowStreamEmit).toHaveBeenCalledWith(
        params.projectPath,
        params.sessionName,
        expect.objectContaining({
          type: "content",
          iterationNumber: 1,
          content: { type: "text", text: "Working on the task..." },
        }),
      );
    });

    it("returns iteration metadata with correct structure", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      const result = await orchestrator.runIteration(params);

      expect(result.iterationNumber).toBe(1);
      expect(result.conversationId).toBe("conv-iter-001");
      expect(result.status).toBe("completed");
      expect(result.costUsd).toBe(0.05);
      expect(result.turns).toBe(3);
      expect(result.gitMetrics.filesChanged).toBe(2);
      expect(result.progressClassification).toBe("progress");
      expect(result.startedAt).toBeDefined();
      expect(result.completedAt).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("classifies progress using git metrics and status report", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.classifyProgress).toHaveBeenCalledWith(
        expect.objectContaining({ filesChanged: 2 }),
        null, // no status report from tool
        0, // no tasks completed
      );
    });

    it("marks conversation as awaiting/archived in cleanup", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      // The finally block calls mutateSession for cleanup
      expect(deps.mutateSession).toHaveBeenCalledWith(
        params.projectPath,
        params.sessionName,
        "workflow.conversationCleanup",
        expect.any(Function),
      );
    });

    it("builds child env and adds CLAUDECODE empty string", async () => {
      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(deps.buildChildEnv).toHaveBeenCalled();
      // Check query was called with env containing CLAUDECODE: ""
      expect(deps.query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({ CLAUDECODE: "" }),
          }),
        }),
      );
    });
  });

  describe("runIteration - context token limits", () => {
    it("sets context_limit status when hard limit is reached", async () => {
      // Create a query that returns high token usage
      deps.query = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Response" }],
              usage: {
                input_tokens: 180_001,
                output_tokens: 100,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          };
          // The abort will throw after this iteration
        },
      })) as unknown as OrchestratorDeps["query"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      const result = await orchestrator.runIteration(params);

      expect(result.status).toBe("context_limit");
      expect(result.peakContextTokens).toBe(180_001);
    });
  });

  describe("runIteration - timeout behavior", () => {
    it("sets timeout status when iteration times out", async () => {
      // Use a very short timeout
      const session = makeSession({
        workflow: makeWorkflow({
          config: {
            maxIterations: 20,
            iterationTimeoutMs: 1, // 1ms timeout
            contextSoftLimitTokens: 160_000,
            contextHardLimitTokens: 180_000,
            circuitBreaker: { noProgressThreshold: 3, sameErrorThreshold: 5 },
          },
        }),
      });

      // Make query hang until aborted, then throw abort error
      deps.query = vi.fn(
        ({ options }: { options: { abortController: AbortController } }) => ({
          async *[Symbol.asyncIterator]() {
            // Wait for the abort signal
            await new Promise<void>((resolve) => {
              if (options.abortController.signal.aborted) {
                resolve();
                return;
              }
              options.abortController.signal.addEventListener("abort", () =>
                resolve(),
              );
            });
            throw new Error("Aborted");
          },
        }),
      ) as unknown as OrchestratorDeps["query"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams({
        session,
        workflow: session.workflow!,
      });

      const result = await orchestrator.runIteration(params);

      expect(result.status).toBe("timeout");
    });
  });

  describe("runIteration - error handling", () => {
    it("sets error status on SDK query failure", async () => {
      deps.query = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("SDK connection failed");
        },
      })) as unknown as OrchestratorDeps["query"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      const result = await orchestrator.runIteration(params);

      expect(result.status).toBe("error");
    });

    it("sets aborted status when parent abort controller fires", async () => {
      const parentAbort = new AbortController();

      deps.query = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          parentAbort.abort();
          throw new Error("Aborted");
        },
      })) as unknown as OrchestratorDeps["query"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams({ abortController: parentAbort });

      const result = await orchestrator.runIteration(params);

      expect(result.status).toBe("aborted");
    });

    it("releases lock on error during SDK execution", async () => {
      const releaseLock = vi.fn();
      deps.acquireSessionLock = vi.fn(
        () => releaseLock,
      ) as unknown as OrchestratorDeps["acquireSessionLock"];

      deps.query = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("SDK crash");
        },
      })) as unknown as OrchestratorDeps["query"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(releaseLock).toHaveBeenCalled();
    });

    it("exits the message loop after receiving result even if generator stays open", async () => {
      // Simulate SDK behavior where the async generator doesn't close after
      // yielding the result message (e.g., MCP server keeps it alive).
      // Without the fix, this test would hang forever.
      deps.query = vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.1,
            duration_ms: 5000,
            num_turns: 2,
            session_id: "sdk-session-1",
          };
          // Generator stays open — simulates MCP server keeping connection alive
          await new Promise(() => {});
        },
      })) as unknown as OrchestratorDeps["query"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      const result = await orchestrator.runIteration(params);

      expect(result.status).toBe("completed");
      expect(result.costUsd).toBe(0.1);
      expect(result.turns).toBe(2);
    });

    it("handles setup errors (e.g. lock acquisition failure)", async () => {
      deps.acquireSessionLock = vi.fn(() => {
        throw new Error("Lock already held");
      }) as unknown as OrchestratorDeps["acquireSessionLock"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      const result = await orchestrator.runIteration(params);

      expect(result.status).toBe("error");
      // query should NOT have been called
      expect(deps.query).not.toHaveBeenCalled();
    });
  });

  describe("Codex tool registration", () => {
    it("includes codex-tool in mcpServers when config.codex.enabled is true", async () => {
      const readConfig = vi.fn(async () => ({
        codex: { enabled: true, model: "o3" },
      }));
      deps.readConfig = readConfig as unknown as OrchestratorDeps["readConfig"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      expect(readConfig).toHaveBeenCalledTimes(1);
      const queryCallArgs = (deps.query as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as { options: { mcpServers: Record<string, unknown> } };
      expect(queryCallArgs.options.mcpServers["codex-tool"]).toBeDefined();
    });

    it("does not include codex-tool when config.codex is disabled", async () => {
      deps.readConfig = vi.fn(async () => ({
        codex: { enabled: false },
      })) as unknown as OrchestratorDeps["readConfig"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      const queryCallArgs = (deps.query as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as { options: { mcpServers: Record<string, unknown> } };
      expect(queryCallArgs.options.mcpServers["codex-tool"]).toBeUndefined();
    });

    it("does not include codex-tool when config.codex is absent", async () => {
      deps.readConfig = vi.fn(
        async () => ({}),
      ) as unknown as OrchestratorDeps["readConfig"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      const queryCallArgs = (deps.query as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as { options: { mcpServers: Record<string, unknown> } };
      expect(queryCallArgs.options.mcpServers["codex-tool"]).toBeUndefined();
    });

    it("includes Codex hint in system prompt when enabled", async () => {
      deps.readConfig = vi.fn(async () => ({
        codex: { enabled: true },
      })) as unknown as OrchestratorDeps["readConfig"];

      const orchestrator = createOrchestrator(deps);
      const params = makeIterationParams();

      await orchestrator.runIteration(params);

      const queryCallArgs = (deps.query as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as {
        options: { systemPrompt: { append: string } };
      };
      expect(queryCallArgs.options.systemPrompt.append).toContain("run_codex");
    });
  });

  describe("persistIterationResults", () => {
    it("updates workflow state with iteration metadata", async () => {
      const session = makeSession();
      // Store session so mutateSession can find it
      (deps.mutateSession as ReturnType<typeof vi.fn>).mockImplementation(
        async (
          _pp: string,
          _sn: string,
          _label: string,
          mutate: (s: SessionState) => unknown,
        ) => mutate(session),
      );

      const orchestrator = createOrchestrator(deps);
      const iteration = {
        iterationNumber: 1,
        conversationId: "conv-001",
        status: "completed" as const,
        startedAt: "2026-03-01T10:00:00Z",
        completedAt: "2026-03-01T10:30:00Z",
        durationMs: 1800000,
        costUsd: 0.05,
        turns: 3,
        gitMetrics: {
          filesChanged: 2,
          linesAdded: 50,
          linesRemoved: 10,
          changedFiles: ["a.ts"],
        },
        statusReport: null,
        tasksCompleted: [],
        tasksSkipped: [],
        tasksAdded: [],
        progressClassification: "progress" as const,
        peakContextTokens: 50000,
      };

      await orchestrator.persistIterationResults(
        "/home/user/project",
        "test-session",
        "project",
        iteration,
      );

      // Check iteration was pushed to workflow history
      expect(session.workflow!.iterations).toHaveLength(1);
      expect(session.workflow!.iterations[0]!.conversationId).toBe("conv-001");

      // Check totals accumulated
      expect(session.workflow!.totalCostUsd).toBe(0.05);
      expect(session.workflow!.totalDurationMs).toBe(1800000);
    });

    it("processes circuit breaker with iteration result", async () => {
      const session = makeSession();
      (deps.mutateSession as ReturnType<typeof vi.fn>).mockImplementation(
        async (
          _pp: string,
          _sn: string,
          _label: string,
          mutate: (s: SessionState) => unknown,
        ) => mutate(session),
      );

      const orchestrator = createOrchestrator(deps);
      const iteration = {
        iterationNumber: 1,
        conversationId: "conv-001",
        status: "error" as const,
        startedAt: "2026-03-01T10:00:00Z",
        completedAt: "2026-03-01T10:30:00Z",
        durationMs: 1800000,
        costUsd: 0,
        turns: 0,
        gitMetrics: {
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          changedFiles: [],
        },
        statusReport: null,
        tasksCompleted: [],
        tasksSkipped: [],
        tasksAdded: [],
        progressClassification: "no_progress" as const,
        peakContextTokens: 0,
      };

      await orchestrator.persistIterationResults(
        "/home/user/project",
        "test-session",
        "project",
        iteration,
      );

      expect(deps.processCircuitBreaker).toHaveBeenCalledWith(
        session.workflow!.circuitBreaker,
        expect.objectContaining({
          classification: "no_progress",
          errorPattern: "error",
        }),
        session.workflow!.config.circuitBreaker,
      );
    });

    it("broadcasts workflow-iteration-complete event", async () => {
      const orchestrator = createOrchestrator(deps);
      const iteration = {
        iterationNumber: 1,
        conversationId: "conv-001",
        status: "completed" as const,
        startedAt: "2026-03-01T10:00:00Z",
        completedAt: "2026-03-01T10:30:00Z",
        durationMs: 1800000,
        costUsd: 0.05,
        turns: 3,
        gitMetrics: {
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          changedFiles: [],
        },
        statusReport: null,
        tasksCompleted: [],
        tasksSkipped: [],
        tasksAdded: [],
        progressClassification: "progress" as const,
        peakContextTokens: 0,
      };

      await orchestrator.persistIterationResults(
        "/home/user/project",
        "test-session",
        "project",
        iteration,
      );

      expect(deps.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workflow-iteration-complete",
          projectName: "project",
          sessionName: "test-session",
          iteration,
        }),
      );
    });

    it("broadcasts circuit breaker event when state is returned", async () => {
      const circuitBreakerState = {
        state: "open" as const,
        consecutiveNoProgress: 3,
        consecutiveSameError: 0,
        lastErrorPattern: null,
        lastProgressIteration: 0,
      };

      (deps.mutateSession as ReturnType<typeof vi.fn>).mockResolvedValue(
        circuitBreakerState,
      );

      const orchestrator = createOrchestrator(deps);
      const iteration = {
        iterationNumber: 4,
        conversationId: "conv-004",
        status: "completed" as const,
        startedAt: "2026-03-01T10:00:00Z",
        completedAt: "2026-03-01T10:30:00Z",
        durationMs: 1800000,
        costUsd: 0.05,
        turns: 3,
        gitMetrics: {
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          changedFiles: [],
        },
        statusReport: null,
        tasksCompleted: [],
        tasksSkipped: [],
        tasksAdded: [],
        progressClassification: "no_progress" as const,
        peakContextTokens: 0,
      };

      await orchestrator.persistIterationResults(
        "/home/user/project",
        "test-session",
        "project",
        iteration,
      );

      expect(deps.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workflow-circuit-breaker",
          circuitBreaker: circuitBreakerState,
        }),
      );
    });
  });
});
