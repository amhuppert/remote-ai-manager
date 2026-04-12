import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowContinuityService,
  type WorkflowContinuityServiceDeps,
} from "./workflow-continuity-service";
import { graphWorkflowExecutionSchema } from "@/lib/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneState,
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
    executionContexts: [
      {
        id: "ctx-1",
        title: "Plan",
        agent: { model: "sonnet", reasoningEffort: "medium" },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
      },
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
    workingDefinition: makeDefinition(),
    status: "running",
    activeContextId: "ctx-1",
    contextStates: {
      "ctx-1": {
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 1,
        consecutiveFailureCount: 0,
        lastValidationAt: null,
        lastValidationPass: null,
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
        reopenedCount: 0,
        lastReopenedAt: null,
        failureMessage: null,
        failureHistory: [],
      },
    },
    retryState: {},
    sharedDocuments: [],
    laneStates: {},
    machineSnapshot: null,
    history: [],
    startedAt: NOW,
    completedAt: null,
    haltReason: null,
    ...overrides,
  };
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

    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.promptMode).toBe("iteration_seed");
    expect(result.conversationId).toBe("conv-new");
    expect(result.execution.laneStates["implementer"]?.engine).toBe("claude");
    expect(result.execution.laneStates["implementer"]?.contextId).toBe("ctx-1");
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
      laneStates: { implementer: existingLane },
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
      laneStates: { implementer: existingLane },
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
    expect(result.execution.laneStates["implementer"]?.contextId).toBe("ctx-2");
  });

  it("creates fresh session when continuity disabled", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const definition = makeDefinition();
    // Override continuity to disabled
    definition.executionContexts[0]!.iterationPolicy.continuity = {
      enabled: false,
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
      workingDefinition: definition,
      laneStates: { implementer: existingLane },
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
      laneStates: { implementer: existingLane },
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
    const newLane = result.execution.laneStates["implementer"];
    if (newLane?.engine === "claude") {
      expect(newLane.rotateBeforeNextTurn).toBe(false);
    }
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
      lane: "task_validator",
      engine: "claude",
    });

    expect(deps.createConversation).toHaveBeenCalledOnce();
    expect(result.sessionAction).toBe("create");
    expect(result.engine).toBe("claude");
    if (result.engine === "claude") {
      expect(result.conversationId).toBe("conv-new");
    }
    expect(result.execution.laneStates["task_validator"]?.lane).toBe(
      "task_validator",
    );
  });

  it("reuses claude validator session when continuity enabled and same context", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: "conv-val",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "task_validator",
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
      lane: "task_validator",
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
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-existing",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "task_validator",
      engine: "codex",
    });

    expect(deps.resumeCodexThread).toHaveBeenCalledWith("thread-existing");
    expect(result.sessionAction).toBe("reuse");
    expect(result.engine).toBe("codex");
    if (result.engine === "codex") {
      expect(result.threadId).toBe("thread-existing");
    }
  });

  it("creates fresh session when task_validator continuity is disabled", async () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const definition = makeDefinition();
    definition.executionContexts[0]!.taskValidation = {
      type: "claude",
      enabled: true,
      continuity: { enabled: false },
      agent: { model: "sonnet", reasoningEffort: "medium" },
      instructions: "Validate.",
    };

    const existingLane: GraphWorkflowLaneState = {
      engine: "claude",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
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
      laneStates: { task_validator: existingLane },
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "task_validator",
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
      lane: "task_validator",
      engine: "claude",
    });

    expect(implResult.conversationId).toBe("conv-impl");
    if (valResult.engine === "claude") {
      expect(valResult.conversationId).toBe("conv-val");
    }
    expect(valResult.execution.laneStates["implementer"]?.engine).toBe(
      "claude",
    );
    expect(valResult.execution.laneStates["task_validator"]?.engine).toBe(
      "claude",
    );
  });
});

// ---------------------------------------------------------------------------
// recordClaudeTurnOutcome
// ---------------------------------------------------------------------------

describe("recordClaudeTurnOutcome", () => {
  it("updates context token metrics on the lane state", () => {
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
      laneStates: { implementer: existingLane },
    });

    const result = svc.recordClaudeTurnOutcome({
      execution,
      lane: "implementer",
      contextTokens: 50000,
      contextWindowMax: 200000,
      contextLimitTokens: undefined,
    });

    const updated = result.laneStates["implementer"];
    expect(updated?.engine).toBe("claude");
    if (updated?.engine === "claude") {
      expect(updated.lastContextTokens).toBe(50000);
      expect(updated.lastContextWindowMax).toBe(200000);
      expect(updated.rotateBeforeNextTurn).toBe(false);
      expect(updated.limitEvaluation).toBe("disabled");
    }
  });

  it("sets rotateBeforeNextTurn when tokens exceed configured limit", () => {
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
      laneStates: { implementer: existingLane },
    });

    const result = svc.recordClaudeTurnOutcome({
      execution,
      lane: "implementer",
      contextTokens: 150000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["implementer"];
    if (updated?.engine === "claude") {
      expect(updated.rotateBeforeNextTurn).toBe(true);
      expect(updated.limitEvaluation).toBe("supported");
    }
  });

  it("clears rotateBeforeNextTurn when tokens are under the limit", () => {
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
      laneStates: { implementer: existingLane },
    });

    const result = svc.recordClaudeTurnOutcome({
      execution,
      lane: "implementer",
      contextTokens: 40000,
      contextWindowMax: 200000,
      contextLimitTokens: 100000,
    });

    const updated = result.laneStates["implementer"];
    if (updated?.engine === "claude") {
      expect(updated.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("does not set rotateBeforeNextTurn when no limit is configured", () => {
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
      laneStates: { implementer: existingLane },
    });

    // Even with very high tokens, no limit means no rotation
    const result = svc.recordClaudeTurnOutcome({
      execution,
      lane: "implementer",
      contextTokens: 199000,
      contextWindowMax: 200000,
      contextLimitTokens: undefined,
    });

    const updated = result.laneStates["implementer"];
    if (updated?.engine === "claude") {
      expect(updated.rotateBeforeNextTurn).toBe(false);
      expect(updated.limitEvaluation).toBe("disabled");
    }
  });
});

// ---------------------------------------------------------------------------
// recordCodexTurnOutcome
// ---------------------------------------------------------------------------

describe("recordCodexTurnOutcome", () => {
  it("updates turn usage and always keeps rotateBeforeNextTurn false", () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-1",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = svc.recordCodexTurnOutcome({
      execution,
      lane: "task_validator",
      usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300 },
      contextLimitTokens: 50000,
    });

    const updated = result.laneStates["task_validator"];
    if (updated?.engine === "codex") {
      expect(updated.lastTurnUsage?.inputTokens).toBe(1000);
      expect(updated.rotateBeforeNextTurn).toBe(false);
      // Even with a limit configured, Codex always records unsupported
      expect(updated.limitEvaluation).toBe("unsupported");
    }
  });

  it("records disabled limitEvaluation when no limit is configured", () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-1",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = svc.recordCodexTurnOutcome({
      execution,
      lane: "task_validator",
      usage: null,
      contextLimitTokens: undefined,
    });

    const updated = result.laneStates["task_validator"];
    if (updated?.engine === "codex") {
      expect(updated.limitEvaluation).toBe("disabled");
    }
  });

  it("updates sessionRef.threadId when newThreadId is provided", () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-placeholder",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = svc.recordCodexTurnOutcome({
      execution,
      lane: "task_validator",
      usage: null,
      contextLimitTokens: undefined,
      newThreadId: "real-thread-abc",
    });

    const updated = result.laneStates["task_validator"];
    if (updated?.engine === "codex" && updated.sessionRef.engine === "codex") {
      expect(updated.sessionRef.threadId).toBe("real-thread-abc");
    }
  });

  it("preserves existing threadId when newThreadId is null", () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const existingLane: GraphWorkflowLaneState = {
      engine: "codex",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-keep",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = svc.recordCodexTurnOutcome({
      execution,
      lane: "task_validator",
      usage: null,
      contextLimitTokens: undefined,
      newThreadId: null,
    });

    const updated = result.laneStates["task_validator"];
    if (updated?.engine === "codex" && updated.sessionRef.engine === "codex") {
      expect(updated.sessionRef.threadId).toBe("thread-keep");
    }
  });
});

// ---------------------------------------------------------------------------
// clearForNewContext
// ---------------------------------------------------------------------------

describe("clearForNewContext", () => {
  it("removes all lane state when context changes", () => {
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
      laneStates: { implementer: existingLane },
    });

    const result = svc.clearForNewContext(execution, "ctx-2");

    expect(result.laneStates).toEqual({});
  });

  it("preserves other execution state when clearing lane states", () => {
    const deps = makeDeps();
    const svc = createWorkflowContinuityService(deps);

    const execution = makeExecution({
      laneStates: {
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
    });

    const result = svc.clearForNewContext(execution, "ctx-2");

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

    const execution = makeExecution({ laneStates: { implementer: staleLane } });

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
    expect(result.execution.laneStates["implementer"]?.contextId).toBe("ctx-2");
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
      laneStates: { implementer: existingLane },
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
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "claude",
        lane: "task_validator",
        conversationId: "conv-val-gone",
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "task_validator",
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
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-gone",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: existingLane },
    });

    const result = await svc.resolveValidatorCall({
      execution,
      projectPath: "/proj",
      sessionName: "sess",
      contextId: "ctx-1",
      lane: "task_validator",
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
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: {
        engine: "codex",
        lane: "task_validator",
        threadId: "thread-codex-abc",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "unsupported",
      lastUsedAt: NOW,
    };

    const execution = makeExecution({
      laneStates: { task_validator: codexLane },
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
      lane: "task_validator",
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
