import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowContinuityService,
  type WorkflowContinuityServiceDeps,
} from "./workflow-continuity-service";
import { graphWorkflowExecutionSchema } from "@/lib/schemas";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import type { LaneState } from "@/lib/workflows/primitives/lane-vocabulary";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneState,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/types";

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
    workingDefinition:
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition,
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {
      "ctx-1": {
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
    machineSnapshot: null,
    history: [],
    startedAt: NOW,
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingMergeRetry: [],
    ...overrides,
  };
}

function laneStatesByContext(
  ...states: GraphWorkflowLaneState[]
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

function makeDeps(
  partial: Partial<WorkflowContinuityServiceDeps> = {},
): WorkflowContinuityServiceDeps {
  return {
    createConversation: vi.fn().mockResolvedValue({ id: "conv-new" }),
    getConversation: vi.fn().mockResolvedValue({ id: "conv-existing" }),
    startCodexThread: vi.fn().mockResolvedValue({ threadId: "thread-new" }),
    resumeCodexThread: vi
      .fn()
      .mockResolvedValue({ threadId: "thread-existing" }),
    now: () => NOW,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// resolveImplementerCall
// ---------------------------------------------------------------------------

describe("resolveImplementerCall", () => {
  it("creates a fresh session when no lane state exists", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);
    const execution = makeExecution();

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(deps.createConversation).toHaveBeenCalledWith("/proj", "sess", {
      role: "iteration",
      agentBackend: "claude",
    });
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.conversationId).toBe("conv-new");
    expect(result.execution.laneStates["ctx-1"]?.["implementer"]?.engine).toBe(
      "claude",
    );
    expect(
      result.execution.laneStates["ctx-1"]?.["implementer"]?.contextId,
    ).toBe("ctx-1");
  });

  it("reuses existing lane when continuity enabled and same context, no rotation", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-existing",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-existing");
  });

  it("creates fresh session when context changes", async () => {
    const deps = makeDeps({
      createConversation: vi.fn().mockResolvedValue({ id: "conv-ctx2" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-old",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-2",
    });

    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(
      result.execution.laneStates["ctx-2"]?.["implementer"]?.contextId,
    ).toBe("ctx-2");
  });

  it("creates fresh session when continuity disabled", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const definition = makeDefinition();
    // Override continuity to disabled
    definition.executionContexts[0]!.iterationPolicy = {
      maxIterations: 5,
      continuity: { enabled: false },
    };

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-existing",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

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

    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
  });

  it("creates fresh session when rotateBeforeNextTurn is true", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-old",
      },
      lastContextTokens: 180000,
      lastContextWindowMax: 200000,
      rotateBeforeNextTurn: true,
      limitEvaluation: "supported",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    // rotateBeforeNextTurn should be reset on the new lane state
    const newLane = result.execution.laneStates["ctx-1"]?.["implementer"];
    if (newLane?.engine === "claude") {
      expect(newLane.rotateBeforeNextTurn).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveImplementerCall — Codex backend
// ---------------------------------------------------------------------------

describe("resolveImplementerCall (codex)", () => {
  it("creates a fresh CC conversation without fabricating a codex thread when no lane state exists", async () => {
    const deps = makeDeps({
      createConversation: vi.fn().mockResolvedValue({ id: "conv-cc-new" }),
      startCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-impl-new" }),
    });
    const svc = createWorkflowContinuityService(deps);
    const execution = makeExecution();

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      engine: "codex",
    });

    expect(deps.createConversation).toHaveBeenCalledWith("/proj", "sess", {
      role: "iteration",
      agentBackend: "codex",
    });
    expect(deps.startCodexThread).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.conversationId).toBe("conv-cc-new");
    const lane = result.execution.laneStates["ctx-1"]?.["implementer"];
    expect(lane?.engine).toBe("codex");
    if (lane?.engine === "codex") {
      expect(lane.sessionRef).toBeUndefined();
      expect(lane.workflowConversationId).toBe("conv-cc-new");
    }
  });

  it("resumes codex thread and reuses CC conversation when continuity enabled", async () => {
    const deps = makeDeps({
      getConversation: vi.fn().mockResolvedValue({ id: "conv-cc-existing" }),
      resumeCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-impl-existing" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-cc-existing",
      sessionRef: {
        engine: "codex",
        lane: "implementer",
        threadId: "thread-impl-existing",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      engine: "codex",
    });

    expect(deps.getConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      "conv-cc-existing",
    );
    expect(deps.resumeCodexThread).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-cc-existing");
  });

  it("falls back to fresh session when resumeCodexThread throws", async () => {
    const deps = makeDeps({
      getConversation: vi.fn().mockResolvedValue({ id: "conv-cc-existing" }),
      resumeCodexThread: vi.fn().mockRejectedValue(new Error("Thread expired")),
      createConversation: vi.fn().mockResolvedValue({ id: "conv-cc-fresh" }),
      startCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-impl-fresh" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-cc-existing",
      sessionRef: {
        engine: "codex",
        lane: "implementer",
        threadId: "thread-impl-gone",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      engine: "codex",
    });

    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-cc-existing");
  });

  it("rotates when engine changes from claude to codex", async () => {
    const deps = makeDeps({
      createConversation: vi.fn().mockResolvedValue({ id: "conv-cc-codex" }),
      startCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-impl-new" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const claudeLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-claude-old",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(claudeLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      engine: "codex",
    });

    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.execution.laneStates["ctx-1"]?.["implementer"]?.engine).toBe(
      "codex",
    );
  });

  it("resumes codex implementer after execution state is deserialized through the schema (restart recovery)", async () => {
    const deps = makeDeps({
      getConversation: vi.fn().mockResolvedValue({ id: "conv-cc-persisted" }),
      resumeCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-impl-abc" }),
      startCodexThread: vi.fn(),
      createConversation: vi.fn(),
    });
    const svc = createWorkflowContinuityService(deps);

    const codexLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-cc-persisted",
      sessionRef: {
        engine: "codex",
        lane: "implementer",
        threadId: "thread-impl-abc",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

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
      engine: "codex",
    });

    expect(deps.resumeCodexThread).not.toHaveBeenCalled();
    expect(deps.startCodexThread).not.toHaveBeenCalled();
    expect(deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.promptMode).toBe("follow_up");
    expect(result.conversationId).toBe("conv-cc-persisted");
  });

  it("falls back to fresh when CC conversation is gone but thread still exists", async () => {
    const deps = makeDeps({
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue({ id: "conv-cc-recovery" }),
      startCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-impl-recovery" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const codexLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-cc-gone",
      sessionRef: {
        engine: "codex",
        lane: "implementer",
        threadId: "thread-still-alive",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(codexLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      engine: "codex",
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
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);
    const execution = makeExecution();

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "claude",
    });

    expect(deps.createConversation).toHaveBeenCalledWith("/proj", "sess", {
      role: "validator",
      agentBackend: "claude",
    });
    expect(result.sessionAction).toBe("create");
    expect(result.engine).toBe("claude");
    if (result.engine === "claude") {
      expect(result.conversationId).toBe("conv-new");
    }
    expect(
      result.execution.laneStates["ctx-1"]?.["context_validator"]?.lane,
    ).toBe("context_validator");
  });

  it("reuses claude validator session when continuity enabled and same context", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-val",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "claude",
    });

    expect(deps.createConversation).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.engine).toBe("claude");
    if (result.engine === "claude") {
      expect(result.conversationId).toBe("conv-val");
    }
  });

  it("creates fresh codex thread when none exists", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);
    const execution = makeExecution();

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "codex",
    });

    expect(deps.startCodexThread).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.engine).toBe("codex");
    if (result.engine === "codex") {
      expect(result.threadId).toBe("thread-new");
    }
  });

  it("resumes codex thread when continuity enabled and same context", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-existing",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "codex",
    });

    expect(deps.resumeCodexThread).toHaveBeenCalledWith("thread-existing");
    expect(result.sessionAction).toBe("reuse");
    expect(result.engine).toBe("codex");
    if (result.engine === "codex") {
      expect(result.threadId).toBe("thread-existing");
    }
  });

  it("creates fresh session when context_validator continuity is disabled", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const definition =
      makeDefinition() as unknown as ResolvedWorkflowSemanticDefinition;
    definition.executionContexts[0]!.contextValidator = {
      type: "claude",
      enabled: true,
      continuity: { enabled: false },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    };

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-existing-val",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

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
      engine: "claude",
    });

    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
  });

  it("keeps implementer and validator lanes independent", async () => {
    const deps = makeDeps({
      createConversation: vi
        .fn()
        .mockResolvedValueOnce({ id: "conv-impl" })
        .mockResolvedValueOnce({ id: "conv-val" }),
    });
    const svc = createWorkflowContinuityService(deps);
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
      engine: "claude",
    });

    expect(implResult.conversationId).toBe("conv-impl");
    if (valResult.engine === "claude") {
      expect(valResult.conversationId).toBe("conv-val");
    }
    expect(
      valResult.execution.laneStates["ctx-1"]?.["implementer"]?.engine,
    ).toBe("claude");
    expect(
      valResult.execution.laneStates["ctx-1"]?.["context_validator"]?.engine,
    ).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// recordClaudeTurnOutcome
// ---------------------------------------------------------------------------

describe("recordClaudeTurnOutcome", () => {
  it("updates context token metrics on the lane state", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-1",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordClaudeTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "implementer",
      contextTokens: 50000,
      contextWindowMax: 200000,
      contextLimitTokens: undefined,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.engine).toBe("claude");
    if (updated?.engine === "claude") {
      expect(updated.lastContextTokens).toBe(50000);
      expect(updated.lastContextWindowMax).toBe(200000);
      expect(updated.rotateBeforeNextTurn).toBe(false);
      expect(updated.limitEvaluation).toBe("disabled");
    }
  });

  it("sets rotateBeforeNextTurn when tokens exceed configured limit", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-1",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordClaudeTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "implementer",
      contextTokens: 150000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    if (updated?.engine === "claude") {
      expect(updated.rotateBeforeNextTurn).toBe(true);
      expect(updated.limitEvaluation).toBe("supported");
    }
  });

  it("clears rotateBeforeNextTurn when tokens are under the limit", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-1",
      },
      lastContextTokens: 150000,
      lastContextWindowMax: 200000,
      rotateBeforeNextTurn: true,
      limitEvaluation: "supported",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordClaudeTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "implementer",
      contextTokens: 40000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    if (updated?.engine === "claude") {
      expect(updated.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("does not set rotateBeforeNextTurn when no limit is configured", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-1",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    // Even with very high tokens, no limit means no rotation
    const result = await svc.recordClaudeTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "implementer",
      contextTokens: 199000,
      contextWindowMax: 200000,
      contextLimitTokens: undefined,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    if (updated?.engine === "claude") {
      expect(updated.rotateBeforeNextTurn).toBe(false);
      expect(updated.limitEvaluation).toBe("disabled");
    }
  });

  it("isolates lane updates between contexts (rotation flag write to one context does not mutate another)", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const ctx1Lane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-1",
      },
      lastContextTokens: 10000,
      lastContextWindowMax: 200000,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };
    const ctx2Lane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-2",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-2",
      },
      lastContextTokens: 20000,
      lastContextWindowMax: 200000,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(ctx1Lane, ctx2Lane),
    });

    const result = await svc.recordClaudeTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "implementer",
      contextTokens: 150000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const ctx1Updated = result.laneStates["ctx-1"]?.["implementer"];
    const ctx2Untouched = result.laneStates["ctx-2"]?.["implementer"];

    if (ctx1Updated?.engine === "claude") {
      expect(ctx1Updated.rotateBeforeNextTurn).toBe(true);
      expect(ctx1Updated.lastContextTokens).toBe(150000);
    }
    expect(ctx2Untouched).toEqual(ctx2Lane);
  });
});

// ---------------------------------------------------------------------------
// recordCodexTurnOutcome
// ---------------------------------------------------------------------------

describe("recordCodexTurnOutcome", () => {
  it("updates turn usage and always keeps rotateBeforeNextTurn false", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-1",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordCodexTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "context_validator",
      usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300 },
      contextLimitTokens: 50000,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    if (updated?.engine === "codex") {
      expect(updated.lastTurnUsage?.inputTokens).toBe(1000);
      expect(updated.rotateBeforeNextTurn).toBe(false);
      // Even with a limit configured, Codex always records unsupported
      expect(updated.limitEvaluation).toBe("unsupported");
    }
  });

  it("records disabled limitEvaluation when no limit is configured", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-1",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordCodexTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "context_validator",
      usage: null,
      contextLimitTokens: undefined,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    if (updated?.engine === "codex") {
      expect(updated.limitEvaluation).toBe("disabled");
    }
  });

  it("updates sessionRef.threadId when newThreadId is provided", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-placeholder",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordCodexTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "context_validator",
      usage: null,
      contextLimitTokens: undefined,
      newThreadId: "real-thread-abc",
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    if (updated?.engine === "codex" && updated.sessionRef?.engine === "codex") {
      expect(updated.sessionRef.threadId).toBe("real-thread-abc");
    }
  });

  it("creates a codex sessionRef when the implementer lane starts without one", async () => {
    const svc = createWorkflowContinuityService(makeDeps());
    const execution = makeExecution({
      laneStates: {
        "ctx-1": {
          implementer: {
            engine: "codex",
            lane: "implementer",
            contextId: "ctx-1",
            workflowConversationId: "conv-cc-new",
            lastTurnUsage: null,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: NOW,
          },
        },
      },
    });

    const result = await svc.recordCodexTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "implementer",
      usage: null,
      contextLimitTokens: undefined,
      newThreadId: "real-thread-123",
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    expect(updated?.engine).toBe("codex");
    if (updated?.engine === "codex") {
      expect(updated.sessionRef).toEqual({
        engine: "codex",
        lane: "implementer",
        threadId: "real-thread-123",
      });
    }
  });

  it("preserves existing threadId when newThreadId is null", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-keep",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordCodexTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "context_validator",
      usage: null,
      contextLimitTokens: undefined,
      newThreadId: null,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    if (updated?.engine === "codex" && updated.sessionRef?.engine === "codex") {
      expect(updated.sessionRef.threadId).toBe("thread-keep");
    }
  });

  it("sets rotateBeforeNextTurn=true when failed is true to recover from phantom threads", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-phantom",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordCodexTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "context_validator",
      usage: null,
      contextLimitTokens: undefined,
      newThreadId: null,
      failed: true,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.rotateBeforeNextTurn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearForNewContext
// ---------------------------------------------------------------------------

describe("clearForNewContext", () => {
  it("removes lane state for the target context", () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-1",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = svc.clearForNewContext(execution, "ctx-1");

    expect(result.laneStates).toEqual({});
  });

  it("preserves other execution state when clearing lane states", () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const execution = makeExecution({
      laneStates: {
        "ctx-1": {
          implementer: {
            engine: "claude",
            lane: "implementer",
            contextId: "ctx-1",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-1",
            },
            lastContextTokens: null,
            lastContextWindowMax: null,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: NOW,
          },
        },
      },
    });

    const result = svc.clearForNewContext(execution, "ctx-1");

    expect(result.id).toBe("exec-1");
    expect(result.status).toBe("running");
    expect(result.laneStates).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Recovery: stale contextId and Codex resume failure
// ---------------------------------------------------------------------------

describe("recovery behaviors", () => {
  it("creates a fresh session when lane contextId does not match (stale reference)", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    // Lane was used for ctx-1 but we're now requesting ctx-2
    const staleLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-stale",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(staleLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-2",
    });

    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.conversationId).not.toBe("conv-stale");
    // New lane state reflects the new contextId
    expect(
      result.execution.laneStates["ctx-2"]?.["implementer"]?.contextId,
    ).toBe("ctx-2");
  });

  it("falls back to fresh claude session when implementer conversation is not found", async () => {
    const deps = makeDeps({
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue({ id: "conv-recovery" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-gone",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveImplementerCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
    });

    expect(deps.getConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      "conv-gone",
    );
    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.conversationId).toBe("conv-recovery");
    expect(result.promptMode).toBe("iteration_seed");
  });

  it("falls back to fresh claude session when validator conversation is not found", async () => {
    const deps = makeDeps({
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi
        .fn()
        .mockResolvedValue({ id: "conv-val-recovery" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-val-gone",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "claude",
    });

    expect(deps.getConversation).toHaveBeenCalledWith(
      "/proj",
      "sess",
      "conv-val-gone",
    );
    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    if (result.engine === "claude") {
      expect(result.conversationId).toBe("conv-val-recovery");
    }
  });

  it("falls back to fresh codex thread when resumeCodexThread throws", async () => {
    const deps = makeDeps({
      resumeCodexThread: vi
        .fn()
        .mockRejectedValue(new Error("Thread not found")),
      startCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-fallback" }),
    });
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-gone",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "codex",
    });

    expect(deps.resumeCodexThread).toHaveBeenCalledWith("thread-gone");
    expect(deps.startCodexThread).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.engine).toBe("codex");
    if (result.engine === "codex") {
      expect(result.threadId).toBe("thread-fallback");
    }
  });

  it("resumes the codex thread after execution state is deserialized through the schema (restart recovery)", async () => {
    const deps = makeDeps({
      resumeCodexThread: vi
        .fn()
        .mockResolvedValue({ threadId: "thread-codex-abc" }),
      startCodexThread: vi.fn(),
    });
    const svc = createWorkflowContinuityService(deps);

    const codexLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-codex-abc",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "unsupported",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(codexLane),
    });

    // Simulate a restart by round-tripping the execution through the schema parser
    const deserialized = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(execution)),
    );

    const result = await svc.resolveValidatorCall({
      execution: deserialized,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "codex",
    });

    // Thread must be resumed from the persisted thread ID, not created fresh
    expect(deps.resumeCodexThread).toHaveBeenCalledWith("thread-codex-abc");
    expect(deps.startCodexThread).not.toHaveBeenCalled();
    expect(result.sessionAction).toBe("reuse");
    expect(result.engine).toBe("codex");
    if (result.engine === "codex") {
      expect(result.threadId).toBe("thread-codex-abc");
    }
  });
});

// ---------------------------------------------------------------------------
// LaneService primitive integration (Task 6.2 — adapter-backed continuity)
// ---------------------------------------------------------------------------

describe("primitive lane-service integration", () => {
  it("seeds the LaneService store when resolving a fresh implementer call", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });
    const initializeSpy = vi.spyOn(laneService, "initialize");

    const deps = makeDeps();
    const svc = createWorkflowContinuityService({ ...deps, laneService });
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
      laneId: "implementer",
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.backend).toBe("claude");
    expect(persisted?.workflowId).toBe(execution.id);
    expect(persisted?.laneId).toBe("implementer");
    if (persisted?.backendState.backend === "claude") {
      expect(persisted.backendState.conversationId).toBe("conv-new");
    }
    // The graph execution still carries the same lane state for callers.
    expect(result.execution.laneStates["ctx-1"]?.["implementer"]?.engine).toBe(
      "claude",
    );
    expect(
      result.execution.laneStates["ctx-1"]?.["implementer"]?.contextId,
    ).toBe("ctx-1");
  });

  it("routes recordClaudeTurnOutcome through LaneService.recordOutcome and projects the result back to graph state", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });
    const recordSpy = vi.spyOn(laneService, "recordOutcome");

    const deps = makeDeps();
    const svc = createWorkflowContinuityService({ ...deps, laneService });

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-claude-1",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordClaudeTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "implementer",
      contextTokens: 150_000,
      contextWindowMax: 200_000,
      contextLimitTokens: 100_000,
    });

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const callArgs = recordSpy.mock.calls[0]!;
    expect(callArgs[0]).toEqual({
      workflowId: execution.id,
      laneId: "implementer",
    });
    expect(callArgs[1]).toMatchObject({
      backend: "claude",
      contextTokens: 150_000,
      contextWindowMax: 200_000,
      contextLimitTokens: 100_000,
    });

    const updated = result.laneStates["ctx-1"]?.["implementer"];
    if (updated?.engine === "claude") {
      expect(updated.lastContextTokens).toBe(150_000);
      expect(updated.lastContextWindowMax).toBe(200_000);
      expect(updated.rotateBeforeNextTurn).toBe(true);
      expect(updated.limitEvaluation).toBe("supported");
    }

    const persisted = await store.read({
      workflowId: execution.id,
      laneId: "implementer",
    });
    expect(persisted).not.toBeNull();
    if (persisted?.metrics.backend === "claude") {
      expect(persisted.metrics.contextTokens).toBe(150_000);
      expect(persisted.metrics.rotateBeforeNextTurn).toBe(true);
    }
  });

  it("routes recordCodexTurnOutcome through LaneService.recordOutcome with failed=true", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });
    const recordSpy = vi.spyOn(laneService, "recordOutcome");

    const deps = makeDeps();
    const svc = createWorkflowContinuityService({ ...deps, laneService });

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-1",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: laneStatesByContext(existingLane),
    });

    const result = await svc.recordCodexTurnOutcome({
      execution,
      contextId: "ctx-1",
      lane: "context_validator",
      usage: null,
      contextLimitTokens: undefined,
      failed: true,
    });

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const callArgs = recordSpy.mock.calls[0]!;
    expect(callArgs[0]).toEqual({
      workflowId: execution.id,
      laneId: "context_validator",
    });
    expect(callArgs[1]).toMatchObject({
      backend: "codex",
      failed: true,
    });

    const updated = result.laneStates["ctx-1"]?.["context_validator"];
    expect(updated?.engine).toBe("codex");
    if (updated?.engine === "codex") {
      expect(updated.rotateBeforeNextTurn).toBe(true);
    }
  });

  it("preserves graph state unchanged when LaneService throws during initialize", async () => {
    const store = createInMemoryLaneStore();
    const laneService = createLaneService({ store, now: () => NOW });
    const initSpy = vi
      .spyOn(laneService, "initialize")
      .mockImplementation(async (_state: LaneState) => {
        throw new Error("synthetic store failure");
      });

    const deps = makeDeps();
    const svc = createWorkflowContinuityService({ ...deps, laneService });
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

    const deps = makeDeps();
    const svc = createWorkflowContinuityService({ ...deps, laneService });

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
