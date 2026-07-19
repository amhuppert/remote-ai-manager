import { describe, expect, it, vi } from "vitest";
import {
  createGraphLaneContinuity,
  type GraphLaneContinuityDeps,
} from "./lane-continuity";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type { BackendContinuityAdapter } from "@/lib/agent-backends/continuity";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import type { LaneOutcome } from "@/lib/workflows/primitives/lane-service";
import {
  registerExecutionLogger,
  unregisterExecutionLogger,
  type ExecutionLogger,
} from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { graphLaneId } from "./graph-lane-store";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-04-01T10:00:00.000Z";

function makeDefinition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Plan",
        acceptanceCriteria: "TBD",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        contextValidator: null,
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
      } as never,
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "ctx-1",
        order: 1,
        title: "Do it",
        instructions: "Do the thing.",
        source: "user",
      },
    ],
    edges: [],
    ...overrides,
  };
}

function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    liveRevision: 1,
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    workingDefinition:
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition,
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {
      "ctx-1": {
        pendingApproval: null,
        pendingUserInput: null,
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
    },
    taskStates: {
      "task-1": {
        taskId: "task-1",
        contextId: "ctx-1",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    },
    sharedDocuments: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
    machineSnapshot: null,
    startedAt: NOW,
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingCollaborations: {},
    collaborationContinuations: {},
    pendingMergeRetry: [],
    ...overrides,
  };
}

function laneStatesByContext(
  ...states: GraphWorkflowAgentSessionState[]
): GraphWorkflowExecution["laneStates"] {
  const laneStates: GraphWorkflowExecution["laneStates"] = {};
  for (const state of states) {
    laneStates[state.contextId] = {
      ...laneStates[state.contextId],
      [state.lane]: state,
    };
  }
  return laneStates;
}

function makeClaudeSessionState(
  options: {
    lane?: GraphWorkflowAgentSessionState["lane"];
    contextId?: string;
    conversationId?: string;
    metrics?: Partial<GraphWorkflowAgentSessionState["metrics"]>;
    limitEvaluation?: GraphWorkflowAgentSessionState["limitEvaluation"];
  } = {},
): GraphWorkflowAgentSessionState {
  const lane = options.lane ?? "implementer";
  const contextId = options.contextId ?? "ctx-1";
  const conversationId = options.conversationId ?? "conv-existing";
  return {
    backend: "claude",
    refKind: "conversation",
    lane,
    contextId,
    workflowConversationId: conversationId,
    sessionRef: { backend: "claude", ref: conversationId },
    metrics: { rotateBeforeNextTurn: false, ...options.metrics },
    limitEvaluation: options.limitEvaluation ?? "disabled",
    lastUsedAt: NOW,
  };
}

function makeCodexSessionState(options: {
  lane: GraphWorkflowAgentSessionState["lane"];
  contextId?: string;
  workflowConversationId?: string;
  threadId?: string;
  metrics?: Partial<GraphWorkflowAgentSessionState["metrics"]>;
  limitEvaluation?: GraphWorkflowAgentSessionState["limitEvaluation"];
}): GraphWorkflowAgentSessionState {
  return {
    backend: "codex",
    refKind: "backend",
    lane: options.lane,
    contextId: options.contextId ?? "ctx-1",
    ...(options.workflowConversationId === undefined
      ? {}
      : { workflowConversationId: options.workflowConversationId }),
    ...(options.threadId === undefined
      ? {}
      : { sessionRef: { backend: "codex" as const, ref: options.threadId } }),
    metrics: {
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      ...options.metrics,
    },
    limitEvaluation: options.limitEvaluation ?? "disabled",
    lastUsedAt: NOW,
  };
}

interface FakeThreadAdapter {
  adapter: BackendContinuityAdapter;
  start: ReturnType<typeof vi.fn>;
  resumeOrRecover: ReturnType<typeof vi.fn>;
}

function makeThreadAdapter(
  overrides: Partial<Pick<FakeThreadAdapter, "start" | "resumeOrRecover">> = {},
): FakeThreadAdapter {
  const start =
    overrides.start ??
    vi.fn(async () => ({ backend: "codex" as const, ref: "thread-new" }));
  const resumeOrRecover =
    overrides.resumeOrRecover ??
    vi.fn(async (ref: { backend: "codex"; ref: string }) => ({
      ref,
      recovered: false,
    }));
  const adapter: BackendContinuityAdapter = {
    backend: "codex",
    start,
    resumeOrRecover,
    validate: vi.fn(async () => ({ status: "valid" as const })),
    fork: vi.fn(),
  };
  return { adapter, start, resumeOrRecover };
}

interface Harness {
  deps: GraphLaneContinuityDeps;
  threadAdapter: FakeThreadAdapter;
  setExecution(execution: GraphWorkflowExecution): void;
  readExecution(): GraphWorkflowExecution;
}

function makeHarness(partial: Partial<GraphLaneContinuityDeps> = {}): Harness {
  let current: GraphWorkflowExecution | null = null;
  const threadAdapter = makeThreadAdapter();
  const deps: GraphLaneContinuityDeps = {
    laneService: createLaneService({
      store: createInMemoryLaneStore(),
      now: () => NOW,
    }),
    executionRepository: {
      async mutateActive(_projectPath, _sessionName, fn) {
        if (!current) {
          throw new Error("harness: no execution seeded");
        }
        current = await fn(current);
        return current;
      },
    },
    createConversation: vi.fn().mockResolvedValue({ id: "conv-new" }),
    getConversation: vi.fn().mockResolvedValue({ id: "conv-existing" }),
    continuityAdapter: () => threadAdapter.adapter,
    now: () => NOW,
    ...partial,
  };
  return {
    deps,
    threadAdapter,
    setExecution(execution) {
      current = execution;
    },
    readExecution() {
      if (!current) throw new Error("harness: no execution seeded");
      return current;
    },
  };
}

/** Seeds the harness repo and records a neutral turn outcome. */
async function record(
  harness: Harness,
  execution: GraphWorkflowExecution,
  lane: GraphWorkflowAgentSessionState["lane"],
  outcome: LaneOutcome,
  contextId = "ctx-1",
): Promise<GraphWorkflowExecution> {
  harness.setExecution(execution);
  const svc = createGraphLaneContinuity(harness.deps);
  return svc.recordLaneTurnOutcome({
    execution,
    projectPath: "/proj",
    sessionName: "sess",
    contextId,
    lane,
    outcome,
  });
}

// ---------------------------------------------------------------------------
// resolveImplementerCall
// ---------------------------------------------------------------------------

describe("resolveImplementerCall", () => {
  it("creates a fresh session when no lane state exists", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution();

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      { role: "iteration", agentBackend: "claude" },
    );
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.conversationId).toBe("conv-new");
    expect(result.execution.laneStates["ctx-1"]?.["implementer"]?.backend).toBe(
      "claude",
    );
    expect(
      result.execution.laneStates["ctx-1"]?.["implementer"]?.contextId,
    ).toBe("ctx-1");
  });

  it("reuses existing lane when continuity enabled and same context, no rotation", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeClaudeSessionState();

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(harness.deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-existing");
  });

  it("creates fresh session when context changes", async () => {
    const harness = makeHarness({
      createConversation: vi.fn().mockResolvedValue({ id: "conv-ctx2" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeClaudeSessionState({
      conversationId: "conv-old",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-2",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(
      result.execution.laneStates["ctx-2"]?.["implementer"]?.contextId,
    ).toBe("ctx-2");
  });

  it("creates fresh session when continuity disabled", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition = makeDefinition();
    definition.executionContexts[0]!.iterationPolicy = {
      maxIterations: 5,
      continuity: { enabled: false },
    };

    const existingLane = makeClaudeSessionState();

    const execution = makeExecution({
      workingDefinition:
        definition as unknown as ResolvedWorkflowSemanticDefinition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
  });

  it("creates fresh session when rotateBeforeNextTurn is true", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeClaudeSessionState({
      conversationId: "conv-old",
      metrics: {
        contextTokens: 180000,
        contextWindowMax: 200000,
        rotateBeforeNextTurn: true,
      },
      limitEvaluation: "supported",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    const newLane = result.execution.laneStates["ctx-1"]?.["implementer"];
    expect(newLane?.backend).toBe("claude");
    expect(newLane?.metrics.rotateBeforeNextTurn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveImplementerCall — rotation handoff capture
// ---------------------------------------------------------------------------

describe("resolveImplementerCall rotation handoff", () => {
  function makeRotatedLane(): GraphWorkflowAgentSessionState {
    return makeClaudeSessionState({
      conversationId: "conv-old",
      metrics: {
        contextTokens: 180000,
        contextWindowMax: 200000,
        rotateBeforeNextTurn: true,
      },
      limitEvaluation: "supported",
    });
  }

  it("carries the retiring conversation's handoff note into the resolved call", async () => {
    const loadRotationHandoff = vi
      .fn()
      .mockResolvedValue("Done task-1. Lesson: use explicit CC_SERVER_URL.");
    const harness = makeHarness({ loadRotationHandoff });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeRotatedLane()),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(loadRotationHandoff).toHaveBeenCalledWith("conv-old");
    expect(result.previousConversationHandoff).toEqual({
      conversationId: "conv-old",
      note: "Done task-1. Lesson: use explicit CC_SERVER_URL.",
    });
  });

  it("resolves without a handoff when the loader dep is absent", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeRotatedLane()),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(result.previousConversationHandoff).toBeUndefined();
    expect(result.sessionAction).toBe("create");
  });

  it("resolves without a handoff when the loader returns null or throws", async () => {
    for (const loadRotationHandoff of [
      vi.fn().mockResolvedValue(null),
      vi.fn().mockRejectedValue(new Error("transcript unreadable")),
    ]) {
      const harness = makeHarness({ loadRotationHandoff });
      const svc = createGraphLaneContinuity(harness.deps);
      const execution = makeExecution({
        laneStates: laneStatesByContext(makeRotatedLane()),
      });

      const result = await svc.resolveImplementerCall({
        execution,
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
      });

      expect(result.previousConversationHandoff).toBeUndefined();
      expect(result.sessionAction).toBe("create");
    }
  });

  it("does not load a handoff for a first lane or a lane inherited from another context", async () => {
    const loadRotationHandoff = vi.fn().mockResolvedValue("stale note");

    // No prior lane at all.
    let svc = createGraphLaneContinuity(
      makeHarness({ loadRotationHandoff }).deps,
    );
    let result = await svc.resolveImplementerCall({
      execution: makeExecution(),
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });
    expect(result.previousConversationHandoff).toBeUndefined();

    // Lane belonged to a different context — its handoff is not ours.
    svc = createGraphLaneContinuity(makeHarness({ loadRotationHandoff }).deps);
    result = await svc.resolveImplementerCall({
      execution: makeExecution({
        laneStates: laneStatesByContext({
          ...makeRotatedLane(),
          contextId: "ctx-other",
          metrics: {
            ...makeRotatedLane().metrics,
            rotateBeforeNextTurn: false,
          },
        }),
      }),
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });
    expect(result.previousConversationHandoff).toBeUndefined();

    expect(loadRotationHandoff).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lane retirement on rotation
// ---------------------------------------------------------------------------

describe("lane retirement on rotation", () => {
  function makeRotatedClaudeLane(): GraphWorkflowAgentSessionState {
    return makeClaudeSessionState({
      conversationId: "conv-old",
      metrics: {
        contextTokens: 180000,
        contextWindowMax: 200000,
        rotateBeforeNextTurn: true,
      },
      limitEvaluation: "supported",
    });
  }

  it("retires the replaced claude implementer conversation on a same-context rotation", async () => {
    const retireLaneConversation = vi.fn();
    const createConversation = vi.fn().mockResolvedValue({ id: "conv-new" });
    const harness = makeHarness({ retireLaneConversation, createConversation });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeRotatedClaudeLane()),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(result.sessionAction).toBe("create");
    expect(retireLaneConversation).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/proj",
      sessionName: "sess",
      conversationId: "conv-old",
    });
    // The retiring conversation is stopped only after its replacement exists,
    // so a failed lane creation never strands the context without any lane.
    const retireOrder =
      retireLaneConversation.mock.invocationCallOrder[0] ?? Infinity;
    const createOrder = createConversation.mock.invocationCallOrder[0] ?? 0;
    expect(retireOrder).toBeGreaterThan(createOrder);
  });

  it("retires after the rotation handoff has been read from the retiring transcript", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      loadRotationHandoff: vi.fn().mockImplementation(async () => {
        calls.push("handoff");
        return "note";
      }),
      retireLaneConversation: vi.fn().mockImplementation(() => {
        calls.push("retire");
      }),
    });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeRotatedClaudeLane()),
    });

    await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(calls).toEqual(["handoff", "retire"]);
  });

  it("retires the replaced conversation on a same-context continuity-disabled rotation", async () => {
    const retireLaneConversation = vi.fn();
    const harness = makeHarness({ retireLaneConversation });
    const svc = createGraphLaneContinuity(harness.deps);
    const definition = makeDefinition();
    (
      definition.executionContexts[0] as unknown as {
        iterationPolicy: { continuity: { enabled: boolean } };
      }
    ).iterationPolicy.continuity.enabled = false;
    const execution = makeExecution({
      workingDefinition:
        definition as unknown as ResolvedWorkflowSemanticDefinition,
      laneStates: laneStatesByContext({
        ...makeRotatedClaudeLane(),
        metrics: {
          ...makeRotatedClaudeLane().metrics,
          rotateBeforeNextTurn: false,
        },
      }),
    });

    await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(retireLaneConversation).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/proj",
      sessionName: "sess",
      conversationId: "conv-old",
    });
  });

  it("does not retire when there is no prior lane or the retiring lane is codex", async () => {
    const retireLaneConversation = vi.fn();

    // No prior lane.
    let svc = createGraphLaneContinuity(
      makeHarness({ retireLaneConversation }).deps,
    );
    await svc.resolveImplementerCall({
      execution: makeExecution(),
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    // Codex retiring lane — no live conversation actor to stop.
    svc = createGraphLaneContinuity(
      makeHarness({ retireLaneConversation }).deps,
    );
    await svc.resolveImplementerCall({
      execution: makeExecution({
        laneStates: laneStatesByContext(
          makeCodexSessionState({
            lane: "implementer",
            workflowConversationId: "conv-codex-old",
            metrics: { rotateBeforeNextTurn: true },
          }),
        ),
      }),
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      backend: "codex",
    });

    expect(retireLaneConversation).not.toHaveBeenCalled();
  });

  it("still resolves the rotation when the retire dep throws", async () => {
    const harness = makeHarness({
      retireLaneConversation: vi.fn().mockImplementation(() => {
        throw new Error("actor registry unavailable");
      }),
    });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeRotatedClaudeLane()),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(result.sessionAction).toBe("create");
    expect(result.conversationId).toBe("conv-new");
  });

  it("retires the replaced claude validator conversation on a same-context rotation", async () => {
    const retireLaneConversation = vi.fn();
    const harness = makeHarness({ retireLaneConversation });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext({
        ...makeRotatedClaudeLane(),
        lane: "context_validator",
        workflowConversationId: "conv-validator-old",
        sessionRef: { backend: "claude", ref: "conv-validator-old" },
      }),
    });

    await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
    });

    expect(retireLaneConversation).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/proj",
      sessionName: "sess",
      conversationId: "conv-validator-old",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveImplementerCall — Codex backend
// ---------------------------------------------------------------------------

describe("resolveImplementerCall (codex)", () => {
  it("creates a fresh CC conversation without fabricating a codex thread when no lane state exists", async () => {
    const harness = makeHarness({
      createConversation: vi.fn().mockResolvedValue({ id: "conv-cc-new" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution();

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      backend: "codex",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      { role: "iteration", agentBackend: "codex" },
    );
    expect(harness.threadAdapter.start).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.conversationId).toBe("conv-cc-new");
    const lane = result.execution.laneStates["ctx-1"]?.["implementer"];
    expect(lane?.backend).toBe("codex");
    expect(lane?.refKind).toBe("conversation");
    expect(lane?.sessionRef).toEqual({
      backend: "codex",
      ref: "conv-cc-new",
    });
    expect(lane?.workflowConversationId).toBe("conv-cc-new");
  });

  it("reuses the CC conversation without touching the thread adapter when continuity enabled", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue({ id: "conv-cc-existing" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeCodexSessionState({
      lane: "implementer",
      workflowConversationId: "conv-cc-existing",
      threadId: "thread-impl-existing",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      backend: "codex",
    });

    expect(harness.deps.getConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      "conv-cc-existing",
    );
    expect(harness.threadAdapter.resumeOrRecover).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-cc-existing");
  });

  it("rotates when engine changes from claude to codex", async () => {
    const harness = makeHarness({
      createConversation: vi.fn().mockResolvedValue({ id: "conv-cc-codex" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const claudeLane = makeClaudeSessionState({
      conversationId: "conv-claude-old",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(claudeLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      backend: "codex",
    });

    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.execution.laneStates["ctx-1"]?.["implementer"]?.backend).toBe(
      "codex",
    );
  });

  it("resumes codex implementer after execution state is deserialized through the schema (restart recovery)", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue({ id: "conv-cc-persisted" }),
      createConversation: vi.fn(),
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const codexLane = makeCodexSessionState({
      lane: "implementer",
      workflowConversationId: "conv-cc-persisted",
      threadId: "thread-impl-abc",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(codexLane),
    });

    // Simulate restart by round-tripping through the schema parser
    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(execution)),
    );

    const result = await svc.resolveImplementerCall({
      execution: deserialized,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      backend: "codex",
    });

    expect(harness.threadAdapter.resumeOrRecover).not.toHaveBeenCalled();
    expect(harness.threadAdapter.start).not.toHaveBeenCalled();
    expect(harness.deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-cc-persisted");
  });

  it("falls back to fresh when CC conversation is gone but thread still exists", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue({ id: "conv-cc-recovery" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const codexLane = makeCodexSessionState({
      lane: "implementer",
      workflowConversationId: "conv-cc-gone",
      threadId: "thread-still-alive",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(codexLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      backend: "codex",
    });

    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.conversationId).toBe("conv-cc-recovery");
  });
});

// ---------------------------------------------------------------------------
// resolveValidatorCall
// ---------------------------------------------------------------------------

describe("resolveValidatorCall", () => {
  it("creates fresh claude validator session when none exists", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution();

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      { role: "validator", agentBackend: "claude" },
    );
    expect(result.sessionAction).toBe("create");
    expect(result.backend).toBe("claude");
    if (result.strategy === "conversation") {
      expect(result.conversationId).toBe("conv-new");
    }
    expect(
      result.execution.laneStates["ctx-1"]?.["context_validator"]?.lane,
    ).toBe("context_validator");
  });

  it("reuses claude validator session when continuity enabled and same context", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeClaudeSessionState({
      lane: "context_validator",
      conversationId: "conv-val",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
    });

    expect(harness.deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.backend).toBe("claude");
    if (result.strategy === "conversation") {
      expect(result.conversationId).toBe("conv-val");
    }
  });

  it("creates fresh codex thread through the continuity adapter when none exists", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution();

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "codex",
      strategy: "task",
    });

    expect(harness.threadAdapter.start).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/proj",
      sessionName: "sess",
    });
    expect(result.sessionAction).toBe("create");
    expect(result.backend).toBe("codex");
    if (result.strategy === "task") {
      expect(result.backendRef.ref).toBe("thread-new");
    }
  });

  it("resumes codex thread through the continuity adapter when continuity enabled and same context", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeCodexSessionState({
      lane: "context_validator",
      threadId: "thread-existing",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "codex",
      strategy: "task",
    });

    expect(harness.threadAdapter.resumeOrRecover).toHaveBeenCalledWith(
      { backend: "codex", ref: "thread-existing" },
      { projectPath: "/proj", sessionName: "sess" },
    );
    expect(result.sessionAction).toBe("reuse");
    expect(result.backend).toBe("codex");
    if (result.strategy === "task") {
      expect(result.backendRef.ref).toBe("thread-existing");
    }
  });

  it("creates fresh session when context_validator continuity is disabled", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition =
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition;
    definition.executionContexts[0]!.contextValidator = {
      type: "claude",
      enabled: true,
      continuity: { enabled: false },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    };

    const existingLane = makeClaudeSessionState({
      lane: "context_validator",
      conversationId: "conv-existing-val",
    });

    const execution = makeExecution({
      workingDefinition: definition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
  });

  it("keeps implementer and validator lanes independent", async () => {
    const harness = makeHarness({
      createConversation: vi
        .fn()
        .mockResolvedValueOnce({ id: "conv-impl" })
        .mockResolvedValueOnce({ id: "conv-val" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution();

    const implResult = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    const valResult = await svc.resolveValidatorCall({
      execution: implResult.execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
    });

    expect(implResult.conversationId).toBe("conv-impl");
    if (valResult.strategy === "conversation") {
      expect(valResult.conversationId).toBe("conv-val");
    }
    expect(
      valResult.execution.laneStates["ctx-1"]?.["implementer"]?.backend,
    ).toBe("claude");
    expect(
      valResult.execution.laneStates["ctx-1"]?.["context_validator"]?.backend,
    ).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// Resume conversation pin
// ---------------------------------------------------------------------------

describe("resolveImplementerCall — resume conversation pin", () => {
  it("reuses the pinned lane conversation even when continuity is disabled", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition = makeDefinition();
    definition.executionContexts[0]!.iterationPolicy = {
      maxIterations: 5,
      continuity: { enabled: false },
    };

    const existingLane = makeClaudeSessionState({
      conversationId: "conv-pinned",
    });

    const execution = makeExecution({
      workingDefinition:
        definition as unknown as ResolvedWorkflowSemanticDefinition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      pinnedConversationId: "conv-pinned",
    });

    expect(harness.deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-pinned");
  });

  it("lets rotateBeforeNextTurn outrank the pin and rotates to a fresh conversation", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition = makeDefinition();
    definition.executionContexts[0]!.iterationPolicy = {
      maxIterations: 5,
      continuity: { enabled: false },
    };

    const existingLane = makeClaudeSessionState({
      conversationId: "conv-pinned",
      metrics: {
        contextTokens: 180000,
        contextWindowMax: 200000,
        rotateBeforeNextTurn: true,
      },
      limitEvaluation: "supported",
    });

    const execution = makeExecution({
      workingDefinition:
        definition as unknown as ResolvedWorkflowSemanticDefinition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      pinnedConversationId: "conv-pinned",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.conversationId).toBe("conv-new");
  });

  it("ignores a pin that does not match the lane conversation when continuity is disabled", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition = makeDefinition();
    definition.executionContexts[0]!.iterationPolicy = {
      maxIterations: 5,
      continuity: { enabled: false },
    };

    const existingLane = makeClaudeSessionState({
      conversationId: "conv-other",
    });

    const execution = makeExecution({
      workingDefinition:
        definition as unknown as ResolvedWorkflowSemanticDefinition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      pinnedConversationId: "conv-pinned",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
  });

  it("pins a Codex implementer lane by its workflow conversation id", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition = makeDefinition();
    definition.executionContexts[0]!.iterationPolicy = {
      maxIterations: 5,
      continuity: { enabled: false },
    };

    const existingLane = makeCodexSessionState({
      lane: "implementer",
      workflowConversationId: "conv-pinned",
      threadId: "thread-existing",
    });

    const execution = makeExecution({
      workingDefinition:
        definition as unknown as ResolvedWorkflowSemanticDefinition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      backend: "codex",
      pinnedConversationId: "conv-pinned",
    });

    expect(harness.deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.conversationId).toBe("conv-pinned");
  });
});

describe("resolveValidatorCall — resume conversation pin", () => {
  it("reuses the pinned claude validator conversation when continuity is disabled", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition =
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition;
    definition.executionContexts[0]!.contextValidator = {
      type: "claude",
      enabled: true,
      continuity: { enabled: false },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    };

    const existingLane = makeClaudeSessionState({
      lane: "context_validator",
      conversationId: "conv-pinned-val",
    });

    const execution = makeExecution({
      workingDefinition: definition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
      pinnedConversationId: "conv-pinned-val",
    });

    expect(harness.deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.backend).toBe("claude");
    if (result.strategy === "conversation") {
      expect(result.conversationId).toBe("conv-pinned-val");
    }
  });

  it("lets rotateBeforeNextTurn outrank the pin for the claude validator", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const definition =
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition;
    definition.executionContexts[0]!.contextValidator = {
      type: "claude",
      enabled: true,
      continuity: { enabled: false },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    };

    const existingLane = makeClaudeSessionState({
      lane: "context_validator",
      conversationId: "conv-pinned-val",
      metrics: {
        contextTokens: 180000,
        contextWindowMax: 200000,
        rotateBeforeNextTurn: true,
      },
      limitEvaluation: "supported",
    });

    const execution = makeExecution({
      workingDefinition: definition,
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
      pinnedConversationId: "conv-pinned-val",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
  });
});

// ---------------------------------------------------------------------------
// recordLaneTurnOutcome — occupancy-metric (claude) lanes
// ---------------------------------------------------------------------------

describe("recordLaneTurnOutcome (occupancy metrics)", () => {
  function makeClaudeLane(
    overrides: Omit<Partial<GraphWorkflowAgentSessionState>, "metrics"> & {
      metrics?: Partial<GraphWorkflowAgentSessionState["metrics"]>;
    } = {},
  ): GraphWorkflowAgentSessionState {
    const lane = makeClaudeSessionState({ conversationId: "conv-1" });
    return {
      ...lane,
      ...overrides,
      metrics: {
        ...lane.metrics,
        ...overrides.metrics,
      },
    };
  }

  it("updates context token metrics on the lane state", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeClaudeLane()),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 50000,
      contextWindowMax: 200000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.backend).toBe("claude");
    expect(updated?.metrics.contextTokens).toBe(50000);
    expect(updated?.metrics.contextWindowMax).toBe(200000);
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(false);
    expect(updated?.limitEvaluation).toBe("disabled");
  });

  it("sets rotateBeforeNextTurn when tokens exceed configured limit", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeClaudeLane()),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 150000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(true);
    expect(updated?.limitEvaluation).toBe("supported");
  });

  it("does not flag rotation and records supported when tokens are under the limit (no prior flag)", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeClaudeLane({
          metrics: {
            contextTokens: 40000,
            contextWindowMax: 200000,
            rotateBeforeNextTurn: false,
          },
        }),
      ),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 40000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(false);
    expect(updated?.limitEvaluation).toBe("supported");
  });

  it("keeps rotation sticky once flagged even when a later turn is under the limit", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeClaudeLane({
          metrics: {
            contextTokens: 150000,
            contextWindowMax: 200000,
            rotateBeforeNextTurn: true,
          },
          limitEvaluation: "supported",
        }),
      ),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 40000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(true);
    expect(updated?.limitEvaluation).toBe("supported");
  });

  it("records metrics_unavailable for a validator turn with no contextTokens under a configured limit", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeClaudeLane({
          lane: "context_validator",
          workflowConversationId: "conv-val",
          sessionRef: { backend: "claude", ref: "conv-val" },
        }),
      ),
    });

    const result = await record(harness, execution, "context_validator", {
      backend: "claude",
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.limitEvaluation).toBe("metrics_unavailable");
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(false);
  });

  it("does not set rotateBeforeNextTurn when no limit is configured", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeClaudeLane()),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 199000,
      contextWindowMax: 200000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(false);
    expect(updated?.limitEvaluation).toBe("disabled");
  });

  it("flags rotation when the turn auto-compacted under a configured limit even with tokens below the limit", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeClaudeLane()),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 40000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
      compactedThisTurn: true,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(true);
    expect(updated?.limitEvaluation).toBe("supported");
  });

  it("does not flag rotation on compaction when no limit is configured", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeClaudeLane()),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 40000,
      contextWindowMax: 200000,
      compactedThisTurn: true,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(false);
    expect(updated?.limitEvaluation).toBe("disabled");
  });

  it("ignores a post-turn ref for a conversation-anchored lane (the CC conversation id never advances)", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeClaudeLane()),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 50000,
      ref: "sdk-session-id-must-not-replace-conversation",
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.sessionRef).toEqual({ backend: "claude", ref: "conv-1" });
  });

  it("emits a rotation.scheduled decision whose reason distinguishes context_over_limit from compaction_detected", async () => {
    const decisions: Array<{ event: string; data?: Record<string, unknown> }> =
      [];
    const capturingLogger: ExecutionLogger = {
      executionId: "exec-1",
      logDir: "",
      writeManifest() {},
      lifecycle() {},
      iteration() {},
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision(event, data) {
        decisions.push({ event, data });
      },
    };
    registerExecutionLogger(capturingLogger);

    try {
      // Over the limit, not compacted → context_over_limit.
      await record(
        makeHarness(),
        makeExecution({ laneStates: laneStatesByContext(makeClaudeLane()) }),
        "implementer",
        {
          backend: "claude",
          contextTokens: 150000,
          contextWindowMax: 200000,
          contextLimitTokens: 100000,
        },
      );

      // Below the limit but compacted → compaction_detected.
      await record(
        makeHarness(),
        makeExecution({ laneStates: laneStatesByContext(makeClaudeLane()) }),
        "implementer",
        {
          backend: "claude",
          contextTokens: 40000,
          contextWindowMax: 200000,
          contextLimitTokens: 100000,
          compactedThisTurn: true,
        },
      );

      const reasons = decisions
        .filter((d) => d.event === "rotation.scheduled")
        .map((d) => d.data?.reason);
      expect(reasons).toEqual(["context_over_limit", "compaction_detected"]);
    } finally {
      unregisterExecutionLogger("exec-1");
    }
  });

  it("isolates lane updates between contexts (rotation flag write to one context does not mutate another)", async () => {
    const harness = makeHarness();
    const ctx1Lane = makeClaudeLane({
      metrics: {
        contextTokens: 10000,
        contextWindowMax: 200000,
        rotateBeforeNextTurn: false,
      },
    });
    const ctx2Lane = makeClaudeLane({
      contextId: "ctx-2",
      workflowConversationId: "conv-2",
      sessionRef: { backend: "claude", ref: "conv-2" },
      metrics: {
        contextTokens: 20000,
        contextWindowMax: 200000,
        rotateBeforeNextTurn: false,
      },
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(ctx1Lane, ctx2Lane),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 150000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const ctx1Updated = result.laneStates["ctx-1"]?.["implementer"];
    const ctx2Untouched = result.laneStates["ctx-2"]?.["implementer"];

    expect(ctx1Updated?.metrics.rotateBeforeNextTurn).toBe(true);
    expect(ctx1Updated?.metrics.contextTokens).toBe(150000);
    expect(ctx2Untouched).toEqual(ctx2Lane);
  });
});

// ---------------------------------------------------------------------------
// recordLaneTurnOutcome — thread-anchored (codex) lanes
// ---------------------------------------------------------------------------

describe("recordLaneTurnOutcome (thread lanes)", () => {
  function makeCodexValidatorLane(
    threadId = "thread-1",
  ): GraphWorkflowAgentSessionState {
    return makeCodexSessionState({ lane: "context_validator", threadId });
  }

  it("updates turn usage and always keeps rotateBeforeNextTurn false", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeCodexValidatorLane()),
    });

    const result = await record(harness, execution, "context_validator", {
      backend: "codex",
      lastTurnUsage: {
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 300,
      },
      contextLimitTokens: 50000,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.metrics.lastTurnUsage?.inputTokens).toBe(1000);
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(false);
    // Even with a limit configured, a backend without occupancy metrics
    // records an honest unsupported.
    expect(updated?.limitEvaluation).toBe("unsupported");
  });

  it("records disabled limitEvaluation when no limit is configured", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeCodexValidatorLane()),
    });

    const result = await record(harness, execution, "context_validator", {
      backend: "codex",
      lastTurnUsage: null,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.limitEvaluation).toBe("disabled");
  });

  it("updates sessionRef.threadId when a post-turn ref is provided", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeCodexValidatorLane("thread-placeholder"),
      ),
    });

    const result = await record(harness, execution, "context_validator", {
      backend: "codex",
      lastTurnUsage: null,
      ref: "real-thread-abc",
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.sessionRef).toEqual({
      backend: "codex",
      ref: "real-thread-abc",
    });
  });

  it("creates a codex sessionRef when the implementer lane starts without one", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: {
        "ctx-1": {
          implementer: {
            backend: "codex",
            refKind: "backend",
            lane: "implementer",
            contextId: "ctx-1",
            workflowConversationId: "conv-cc-new",
            metrics: {
              lastTurnUsage: null,
              rotateBeforeNextTurn: false,
            },
            limitEvaluation: "disabled",
            lastUsedAt: NOW,
          },
        },
      },
    });

    const result = await record(harness, execution, "implementer", {
      backend: "codex",
      lastTurnUsage: null,
      ref: "real-thread-123",
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.backend).toBe("codex");
    expect(updated?.sessionRef).toEqual({
      backend: "codex",
      ref: "real-thread-123",
    });
    expect(updated?.workflowConversationId).toBe("conv-cc-new");
  });

  it("preserves existing threadId when no post-turn ref is provided", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeCodexValidatorLane("thread-keep")),
    });

    const result = await record(harness, execution, "context_validator", {
      backend: "codex",
      lastTurnUsage: null,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.sessionRef?.ref).toBe("thread-keep");
  });

  it("sets rotateBeforeNextTurn=true when continuation must be cleared", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeCodexValidatorLane("thread-phantom")),
    });

    const result = await record(harness, execution, "context_validator", {
      backend: "codex",
      lastTurnUsage: null,
      continuationDisposition: "clear",
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(true);
  });

  it("returns the execution unchanged when the lane backend does not match the outcome backend", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeCodexValidatorLane()),
    });
    harness.setExecution(execution);
    const svc = createGraphLaneContinuity(harness.deps);

    const result = await svc.recordLaneTurnOutcome({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      outcome: { backend: "claude", contextTokens: 100 },
    });

    expect(result).toBe(execution);
  });
});

// ---------------------------------------------------------------------------
// Recovery: stale contextId and thread resume failure
// ---------------------------------------------------------------------------

describe("recovery behaviors", () => {
  it("creates a fresh session when lane contextId does not match (stale reference)", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const staleLane = makeClaudeSessionState({
      conversationId: "conv-stale",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(staleLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-2",
    });

    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.conversationId).not.toBe("conv-stale");
    expect(
      result.execution.laneStates["ctx-2"]?.["implementer"]?.contextId,
    ).toBe("ctx-2");
  });

  it("falls back to fresh claude session when implementer conversation is not found", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue({ id: "conv-recovery" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeClaudeSessionState({
      conversationId: "conv-gone",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(harness.deps.getConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      "conv-gone",
    );
    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.conversationId).toBe("conv-recovery");
    expect(result.promptMode).toBe("iteration_seed");
  });

  it("falls back to fresh claude session when validator conversation is not found", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi
        .fn()
        .mockResolvedValue({ id: "conv-val-recovery" }),
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeClaudeSessionState({
      lane: "context_validator",
      conversationId: "conv-val-gone",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "claude",
      strategy: "conversation",
    });

    expect(harness.deps.getConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      "conv-val-gone",
    );
    expect(harness.deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    if (result.strategy === "conversation") {
      expect(result.conversationId).toBe("conv-val-recovery");
    }
  });

  it("falls back to a fresh thread when the adapter resume throws", async () => {
    const threadAdapter = makeThreadAdapter({
      resumeOrRecover: vi.fn().mockRejectedValue(new Error("Thread not found")),
      start: vi.fn(async () => ({
        backend: "codex" as const,
        ref: "thread-fallback",
      })),
    });
    const harness = makeHarness({
      continuityAdapter: () => threadAdapter.adapter,
    });
    const svc = createGraphLaneContinuity(harness.deps);

    const existingLane = makeCodexSessionState({
      lane: "context_validator",
      threadId: "thread-gone",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "codex",
      strategy: "task",
    });

    expect(threadAdapter.resumeOrRecover).toHaveBeenCalledWith(
      { backend: "codex", ref: "thread-gone" },
      { projectPath: "/proj", sessionName: "sess" },
    );
    expect(threadAdapter.start).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.backend).toBe("codex");
    if (result.strategy === "task") {
      expect(result.backendRef.ref).toBe("thread-fallback");
    }
  });

  it("persists an adapter-recovered thread without starting a second one", async () => {
    const threadAdapter = makeThreadAdapter({
      resumeOrRecover: vi.fn(async () => ({
        ref: { backend: "codex" as const, ref: "thread-recovered" },
        recovered: true,
      })),
      start: vi.fn(async () => ({
        backend: "codex" as const,
        ref: "thread-duplicate",
      })),
    });
    const harness = makeHarness({
      continuityAdapter: () => threadAdapter.adapter,
    });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeCodexSessionState({
          lane: "context_validator",
          threadId: "thread-stale",
        }),
      ),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "codex",
      strategy: "task",
    });

    expect(threadAdapter.start).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("create");
    if (result.strategy === "task") {
      expect(result.backendRef).toEqual({
        backend: "codex",
        ref: "thread-recovered",
      });
    }
    expect(
      result.execution.laneStates["ctx-1"]?.context_validator?.sessionRef,
    ).toEqual({ backend: "codex", ref: "thread-recovered" });
    const persisted = await harness.deps.laneService.resolve({
      workflowId: execution.id,
      laneId: graphLaneId("context_validator", "ctx-1"),
    });
    expect(persisted?.ref).toBe("thread-recovered");
  });

  it("resumes the codex thread after execution state is deserialized through the schema (restart recovery)", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const codexLane = makeCodexSessionState({
      lane: "context_validator",
      threadId: "thread-codex-abc",
      limitEvaluation: "unsupported",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(codexLane),
    });

    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(execution)),
    );

    const result = await svc.resolveValidatorCall({
      execution: deserialized,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      backend: "codex",
      strategy: "task",
    });

    expect(harness.threadAdapter.resumeOrRecover).toHaveBeenCalledWith(
      { backend: "codex", ref: "thread-codex-abc" },
      { projectPath: "/proj", sessionName: "sess" },
    );
    expect(harness.threadAdapter.start).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.backend).toBe("codex");
    if (result.strategy === "task") {
      expect(result.backendRef.ref).toBe("thread-codex-abc");
    }
  });
});

// ---------------------------------------------------------------------------
// LaneService primitive integration
// ---------------------------------------------------------------------------

describe("primitive lane-service integration", () => {
  it("seeds the LaneService store when resolving a fresh implementer call", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });
    const initializeSpy = vi.spyOn(laneService, "initialize");

    const harness = makeHarness({ laneService });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution();

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(initializeSpy).toHaveBeenCalledTimes(1);
    const persisted = await store.read({
      workflowId: execution.id,
      laneId: graphLaneId("implementer", "ctx-1"),
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.backend).toBe("claude");
    expect(persisted?.workflowId).toBe(execution.id);
    expect(persisted?.laneId).toBe(graphLaneId("implementer", "ctx-1"));
    expect(persisted?.ref).toBe("conv-new");
    // The graph execution still carries the same lane state for callers.
    expect(result.execution.laneStates["ctx-1"]?.["implementer"]?.backend).toBe(
      "claude",
    );
    expect(
      result.execution.laneStates["ctx-1"]?.["implementer"]?.contextId,
    ).toBe("ctx-1");
  });

  it("applies the lane service's outcome decision onto graph state in one recording", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });

    const harness = makeHarness({ laneService });

    const existingLane = makeClaudeSessionState({
      conversationId: "conv-claude-1",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await record(harness, execution, "implementer", {
      backend: "claude",
      contextTokens: 150_000,
      contextWindowMax: 200_000,
      contextLimitTokens: 100_000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.backend).toBe("claude");
    expect(updated?.metrics.contextTokens).toBe(150_000);
    expect(updated?.metrics.contextWindowMax).toBe(200_000);
    // Over the configured limit: the service flags rotation and the graph
    // label collapses the occupancy verdict to "supported".
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(true);
    expect(updated?.limitEvaluation).toBe("supported");
  });

  it("records a cleared task-lane continuation as a rotation on graph state", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });

    const harness = makeHarness({ laneService });

    const existingLane = makeCodexSessionState({
      lane: "context_validator",
      threadId: "thread-1",
    });

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await record(harness, execution, "context_validator", {
      backend: "codex",
      lastTurnUsage: null,
      continuationDisposition: "clear",
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.backend).toBe("codex");
    expect(updated?.metrics.rotateBeforeNextTurn).toBe(true);
  });

  it("preserves graph state unchanged when LaneService throws during initialize", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });
    const initSpy = vi
      .spyOn(laneService, "initialize")
      .mockImplementation(async () => {
        throw new Error("synthetic store failure");
      });

    const harness = makeHarness({ laneService });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution();

    await expect(
      svc.resolveImplementerCall({
        execution,
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
      }),
    ).rejects.toThrow(/synthetic store failure/i);

    expect(initSpy).toHaveBeenCalled();
  });

  it("isolates lane state across executions (workflowId scoped)", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });

    const harness = makeHarness({ laneService });
    const svc = createGraphLaneContinuity(harness.deps);

    const execA = makeExecution({ id: "exec-A" });
    const execB = makeExecution({ id: "exec-B" });

    await svc.resolveImplementerCall({
      execution: execA,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    await svc.resolveImplementerCall({
      execution: execB,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    const lanesA = await store.listByWorkflow("exec-A");
    const lanesB = await store.listByWorkflow("exec-B");
    expect(lanesA).toHaveLength(1);
    expect(lanesB).toHaveLength(1);
    expect(lanesA[0]?.workflowId).toBe("exec-A");
    expect(lanesB[0]?.workflowId).toBe("exec-B");
  });
});

// ---------------------------------------------------------------------------
// Rotation decision reconciliation (scheduled vs applied telemetry)
// ---------------------------------------------------------------------------

describe("rotation decision reconciliation", () => {
  function captureDecisions(): {
    decisions: Array<{ event: string; data?: Record<string, unknown> }>;
    unregister: () => void;
  } {
    const decisions: Array<{ event: string; data?: Record<string, unknown> }> =
      [];
    const capturingLogger: ExecutionLogger = {
      executionId: "exec-1",
      logDir: "",
      writeManifest() {},
      lifecycle() {},
      iteration() {},
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision(event, data) {
        decisions.push({ event, data });
      },
    };
    registerExecutionLogger(capturingLogger);
    return { decisions, unregister: () => unregisterExecutionLogger("exec-1") };
  }

  it("suppresses duplicate rotation.scheduled while a rotation is already pending", async () => {
    const { decisions, unregister } = captureDecisions();
    try {
      const lane = makeClaudeSessionState({ conversationId: "conv-1" });
      const flaggedLane = {
        ...lane,
        metrics: { ...lane.metrics, rotateBeforeNextTurn: true },
      };
      await record(
        makeHarness(),
        makeExecution({ laneStates: laneStatesByContext(flaggedLane) }),
        "implementer",
        {
          backend: "claude",
          contextTokens: 150000,
          contextWindowMax: 200000,
          contextLimitTokens: 100000,
        },
      );
      expect(
        decisions.filter((d) => d.event === "rotation.scheduled"),
      ).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it("emits a validator.rotation decision when a validator lane rotates", async () => {
    const { decisions, unregister } = captureDecisions();
    try {
      const harness = makeHarness();
      const svc = createGraphLaneContinuity(harness.deps);
      await svc.resolveValidatorCall({
        execution: makeExecution(),
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
        lane: "context_validator",
        backend: "claude",
        strategy: "conversation",
      });
      const rotations = decisions.filter(
        (d) => d.event === "validator.rotation",
      );
      expect(rotations).toHaveLength(1);
      expect(rotations[0]?.data).toMatchObject({
        contextId: "ctx-1",
        lane: "context_validator",
        engine: "claude",
        reason: "no_prior_lane",
      });
    } finally {
      unregister();
    }
  });

  it("emits no validator.rotation decision on the reuse path", async () => {
    const { decisions, unregister } = captureDecisions();
    try {
      const harness = makeHarness();
      const svc = createGraphLaneContinuity(harness.deps);
      const existingLane = makeClaudeSessionState({
        lane: "context_validator",
        conversationId: "conv-val",
      });
      await svc.resolveValidatorCall({
        execution: makeExecution({
          laneStates: laneStatesByContext(existingLane),
        }),
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
        lane: "context_validator",
        backend: "claude",
        strategy: "conversation",
      });
      expect(
        decisions.filter((d) => d.event === "validator.rotation"),
      ).toHaveLength(0);
    } finally {
      unregister();
    }
  });
});
