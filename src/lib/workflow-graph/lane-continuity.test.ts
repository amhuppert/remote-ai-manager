import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
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
import { laneStateKey } from "./lane-identity";
import { makeProfileSnapshot } from "./test-fixtures";
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
        placement: { lane: "ctx-1", mode: "full" as const },
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          profileSnapshot: makeProfileSnapshot(),
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        },
        contextValidator: { enabled: false, assignments: [] },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5 },
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
    origin: {
      kind: "template",
      definitionId: "def-1",
      definitionRevision: 1,
      tier: "project",
    },
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    launchDocument: null,
    liveSessionReadOnlyPinned: false,
    abandonment: null,
    liveRevision: 1,
    executionStateRevision: 0,
    structuralRevision: 0,
    charterAmendments: [],
    planRepairRounds: [],
    loopControlAmendments: [],
    contextOutputs: {},
    routeControlRevisions: {},
    routeSettlements: {},
    expansionReceipts: { accepted: [], refusals: [] },
    loopStates: {},
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    ownerConversationId: null,
    definitionApproval: null,
    definitionApprovalClaim: null,
    workingDefinition:
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition,
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {
      "ctx-1": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
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
    advisoryIndex: [],
    laneStates: {},
    executionLanes: {},
    laneReservations: {},
    joins: {},
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

/**
 * Validator lanes are per-assignment, so a fixture lane lands under its
 * assignment's key. `DEFAULT_ASSIGNMENT_ID` matches `makeValidatorAssignment`'s
 * seeded id, which is the single reviewer these tests resolve against.
 */
const DEFAULT_ASSIGNMENT_ID = "general";
const VALIDATOR_LANE_KEY = laneStateKey(
  "context_validator",
  DEFAULT_ASSIGNMENT_ID,
);

function laneStatesByContext(
  ...states: GraphWorkflowAgentSessionState[]
): GraphWorkflowExecution["laneStates"] {
  const laneStates: GraphWorkflowExecution["laneStates"] = {};
  for (const state of states) {
    laneStates[state.contextId] = {
      ...laneStates[state.contextId],
      [laneStateKey(state.lane, state.assignmentId)]: state,
    };
  }
  return laneStates;
}

function assignmentIdFor(
  lane: GraphWorkflowAgentSessionState["lane"],
): { assignmentId: string } | Record<string, never> {
  return lane === "context_validator"
    ? { assignmentId: DEFAULT_ASSIGNMENT_ID }
    : {};
}

function makeClaudeSessionState(
  options: {
    lane?: GraphWorkflowAgentSessionState["lane"];
    contextId?: string;
    conversationId?: string;
    metrics?: Partial<GraphWorkflowAgentSessionState["metrics"]>;
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
    ...assignmentIdFor(lane),
    workflowConversationId: conversationId,
    sessionRef: { backend: "claude", ref: conversationId },
    metrics: { ...options.metrics },
    lastUsedAt: NOW,
  };
}

function makeCodexSessionState(options: {
  lane: GraphWorkflowAgentSessionState["lane"];
  contextId?: string;
  workflowConversationId?: string;
  threadId?: string;
  metrics?: Partial<GraphWorkflowAgentSessionState["metrics"]>;
}): GraphWorkflowAgentSessionState {
  return {
    backend: "codex",
    refKind: options.lane === "implementer" ? "conversation" : "backend",
    lane: options.lane,
    contextId: options.contextId ?? "ctx-1",
    ...assignmentIdFor(options.lane),
    ...(options.workflowConversationId === undefined
      ? {}
      : { workflowConversationId: options.workflowConversationId }),
    ...(options.threadId === undefined
      ? {}
      : { sessionRef: { backend: "codex" as const, ref: options.threadId } }),
    metrics: {
      lastTurnUsage: null,
      ...options.metrics,
    },
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
        return applyFixtureMutation(current, fn, (next) => {
          current = next;
        });
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
    // Validator lanes are per-assignment; these fixtures carry the single
    // seeded reviewer.
    ...(lane === "context_validator"
      ? { assignmentId: DEFAULT_ASSIGNMENT_ID }
      : {}),
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

  it("reuses the CC conversation without touching the thread adapter", async () => {
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
      assignmentId: "general",
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
      result.execution.laneStates["ctx-1"]?.[VALIDATOR_LANE_KEY]?.lane,
    ).toBe("context_validator");
  });

  it("reuses claude validator session within the same context", async () => {
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
      assignmentId: "general",
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
      assignmentId: "general",
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

  it("resumes codex thread through the continuity adapter within the same context", async () => {
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
      assignmentId: "general",
      backend: "codex",
      strategy: "task",
    });

    expect(harness.threadAdapter.adapter.validate).toHaveBeenCalledWith(
      { backend: "codex", ref: "thread-existing" },
      { projectPath: "/proj", sessionName: "sess" },
    );
    expect(result.sessionAction).toBe("reuse");
    expect(result.backend).toBe("codex");
    if (result.strategy === "task") {
      expect(result.backendRef.ref).toBe("thread-existing");
    }
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
      assignmentId: "general",
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
      valResult.execution.laneStates["ctx-1"]?.[VALIDATOR_LANE_KEY]?.backend,
    ).toBe("claude");
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
    const merged = { ...lane, ...overrides };
    return {
      ...merged,
      ...assignmentIdFor(merged.lane),
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

    const updated = result.laneStates["ctx-1"]?.[VALIDATOR_LANE_KEY];
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
            },
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

    const updated = result.laneStates["ctx-1"]?.[VALIDATOR_LANE_KEY];
    expect(updated?.sessionRef?.ref).toBe("thread-keep");
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
      assignmentId: "general",
      outcome: { backend: "claude", contextTokens: 100 },
    });

    expect(result).toBe(execution);
  });
});

// ---------------------------------------------------------------------------
// Recovery: stale contextId and thread resume failure
// ---------------------------------------------------------------------------

describe("recovery behaviors", () => {
  it("refuses to replace an unrecoverable implementer conversation", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue(null),
    });
    const svc = createGraphLaneContinuity(harness.deps);
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeClaudeSessionState({ conversationId: "conv-gone" }),
      ),
    });
    await expect(
      svc.resolveImplementerCall({
        execution,
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
      }),
    ).rejects.toThrow(/cannot continue/i);
    expect(harness.deps.createConversation).not.toHaveBeenCalled();
  });

  it("resumes the codex thread after execution state is deserialized through the schema (restart recovery)", async () => {
    const harness = makeHarness();
    const svc = createGraphLaneContinuity(harness.deps);

    const codexLane = makeCodexSessionState({
      lane: "context_validator",
      threadId: "thread-codex-abc",
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
      assignmentId: "general",
      backend: "codex",
      strategy: "task",
    });

    expect(harness.threadAdapter.adapter.validate).toHaveBeenCalledWith(
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
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.backend).toBe("claude");
    expect(updated?.metrics.contextTokens).toBe(150_000);
    expect(updated?.metrics.contextWindowMax).toBe(200_000);
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

describe("continuous lane failures", () => {
  it("refuses to restart a used conversation whose backend continuation was lost", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-existing",
        promptCount: 1,
        backendRef: null,
      }),
    });
    const execution = makeExecution({
      laneStates: laneStatesByContext(makeClaudeSessionState()),
    });
    await expect(
      createGraphLaneContinuity(harness.deps).resolveImplementerCall({
        execution,
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
      }),
    ).rejects.toThrow("backend continuation was lost");
    expect(harness.deps.createConversation).not.toHaveBeenCalled();
  });

  it("refuses a missing validator conversation without replacing it", async () => {
    const harness = makeHarness({
      getConversation: vi.fn().mockResolvedValue(null),
    });
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeClaudeSessionState({ lane: "context_validator" }),
      ),
    });
    await expect(
      createGraphLaneContinuity(harness.deps).resolveValidatorCall({
        execution,
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
        lane: "context_validator",
        assignmentId: "general",
        backend: "claude",
        strategy: "conversation",
      }),
    ).rejects.toThrow(/cannot continue/i);
    expect(harness.deps.createConversation).not.toHaveBeenCalled();
  });

  it("refuses a stale validator handle without invoking backend recovery", async () => {
    const harness = makeHarness();
    harness.threadAdapter.adapter.validate = vi.fn(async () => ({
      status: "stale" as const,
      reason: "Thread missing",
    }));
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeCodexSessionState({
          lane: "context_validator",
          threadId: "thread-original",
        }),
      ),
    });
    await expect(
      createGraphLaneContinuity(harness.deps).resolveValidatorCall({
        execution,
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
        lane: "context_validator",
        assignmentId: "general",
        backend: "codex",
        strategy: "task",
      }),
    ).rejects.toThrow("Thread missing");
    expect(harness.threadAdapter.start).not.toHaveBeenCalled();
    expect(harness.threadAdapter.resumeOrRecover).not.toHaveBeenCalled();
  });

  it("preserves a cleared backend handle as unusable across restart", async () => {
    const harness = makeHarness();
    const execution = makeExecution({
      laneStates: laneStatesByContext(
        makeCodexSessionState({
          lane: "context_validator",
          threadId: "thread-original",
        }),
      ),
    });
    const recorded = await record(harness, execution, "context_validator", {
      backend: "codex",
      continuationDisposition: "clear",
    });
    const restored = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(recorded)),
    );
    expect(
      restored.laneStates["ctx-1"]?.[VALIDATOR_LANE_KEY]?.staleSession,
    ).toBe(true);
    await expect(
      createGraphLaneContinuity(harness.deps).resolveValidatorCall({
        execution: restored,
        projectPath: "/proj",
        sessionName: "sess",
        contextId: "ctx-1",
        lane: "context_validator",
        assignmentId: "general",
        backend: "codex",
        strategy: "task",
      }),
    ).rejects.toThrow(/cannot continue/i);
    expect(harness.threadAdapter.start).not.toHaveBeenCalled();
  });
});
