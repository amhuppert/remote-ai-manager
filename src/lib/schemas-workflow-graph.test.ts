import { describe, expect, it } from "vitest";
import {
  getCodexReasoningLevelsForModel,
  globalConfigSchema,
  graphWorkflowAgentValidatorConfigSchema,
  graphWorkflowExecutionSchema,
  graphWorkflowExecutionSessionRefSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowLaneContinuityPolicySchema,
  graphWorkflowLaneStateSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowStatusEventSchema,
  sessionStateSchema,
  workflowAgentValidatorResultSchema,
  workflowDefaultsSchema,
  workflowDefinitionRecordSchema,
  workflowRuntimeEditRequestSchema,
  workflowValidatorDefaultSchema,
} from "./schemas";

const timestamp = "2026-03-27T12:00:00.000Z";

function createSemanticDefinition() {
  return {
    schemaVersion: 1,
    executionContexts: [
      {
        id: "context-1",
        title: "Plan",
        description: "Plan the implementation",
        agent: {
          model: "opus",
          reasoningEffort: "high",
        },
        mutability: {
          allowAgentTaskAdd: true,
        },
        circuitBreaker: {
          consecutiveFailureThreshold: 3,
        },
        iterationPolicy: {
          maxIterations: 5,
          continuity: { enabled: true, contextLimitTokens: 120000 },
        },
        taskValidation: {
          enabled: true,
          instructions: "Validate each completed task.",
          agent: {
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
        contextValidation: {
          agentValidator: {
            enabled: true,
            instructions: "Review the whole context before unlock.",
            agent: {
              model: "opus",
              reasoningEffort: "high",
            },
          },
          scriptValidator: {
            enabled: true,
          },
          onFail: {
            mode: "retry",
            retryScope: "same_context",
            maxAttempts: 2,
          },
        },
      },
      {
        id: "context-2",
        title: "Implement",
        description: "Write the code",
        agent: {
          model: "opus",
          reasoningEffort: "medium",
        },
        mutability: {
          allowAgentTaskAdd: false,
        },
        circuitBreaker: {
          consecutiveFailureThreshold: 2,
        },
        iterationPolicy: {
          maxIterations: 3,
        },
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "context-1",
        order: 1,
        title: "Inspect the current state",
        instructions: "Read the relevant files.",
        metadata: {
          area: "schemas",
        },
        source: "user",
      },
      {
        id: "task-2",
        contextId: "context-2",
        order: 1,
        title: "Implement the slice",
        instructions: "Make the tests pass.",
        source: "agent",
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourceContextId: "context-1",
        targetContextId: "context-2",
      },
    ],
  };
}

describe("workflow graph definition schemas", () => {
  it("parses a saved workflow definition with semantic and layout layers", () => {
    const result = workflowDefinitionRecordSchema.safeParse({
      id: "workflow-1",
      name: "Workflow Graph Builder",
      description: "Foundational workflow for the new execution engine",
      schemaVersion: 1,
      revision: 4,
      definition: createSemanticDefinition(),
      layout: {
        workflowId: "workflow-1",
        contextPositions: {
          "context-1": { x: 120, y: 160 },
          "context-2": { x: 520, y: 160 },
        },
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.definition.executionContexts).toHaveLength(2);
      expect(result.data.layout.contextPositions["context-2"]).toEqual({
        x: 520,
        y: 160,
      });
    }
  });

  it("accepts empty string description on execution context (treated as absent)", () => {
    const def = createSemanticDefinition();
    def.executionContexts[0]!.description = "";

    const result = workflowDefinitionRecordSchema.safeParse({
      id: "workflow-1",
      name: "Test",
      schemaVersion: 1,
      revision: 1,
      definition: def,
      layout: {
        workflowId: "workflow-1",
        contextPositions: {
          "context-1": { x: 0, y: 0 },
          "context-2": { x: 300, y: 0 },
        },
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.definition.executionContexts[0]?.description,
      ).toBeUndefined();
    }
  });
});

describe("workflow graph execution schemas", () => {
  it("parses an active execution with working definition, task state, and history", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "execution-1",
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 4,
      workingDefinition: createSemanticDefinition(),
      status: "running",
      activeContextId: "context-1",
      activeTaskId: "task-1",
      contextStates: {
        "context-1": {
          contextId: "context-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          lastValidationAt: null,
          lastValidationPass: null,
        },
        "context-2": {
          contextId: "context-2",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          lastValidationAt: null,
          lastValidationPass: null,
        },
      },
      taskStates: {
        "task-1": {
          taskId: "task-1",
          contextId: "context-1",
          order: 1,
          status: "running",
          summary: null,
          startedAt: timestamp,
          completedAt: null,
          lastConversationId: "conversation-1",
          reopenedCount: 0,
          lastReopenedAt: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-2": {
          taskId: "task-2",
          contextId: "context-2",
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
      retryState: {
        "context-1": {
          contextId: "context-1",
          attempt: 1,
          maxAttempts: 2,
        },
      },
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Shared implementation plan",
          readWhen: "Read before starting implementation work.",
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUpdatedByConversationId: "conversation-1",
        },
      ],
      history: [
        {
          occurredAt: timestamp,
          event: {
            type: "graph-workflow-validation-result",
            projectName: "remote-ai-manager",
            sessionName: "validator-loop-design-f93878",
            executionId: "execution-1",
            contextId: "context-1",
            validatorType: "task",
            pass: false,
            summary: "Validation requested fixes",
            issues: [
              {
                title: "Missing assertions",
                description:
                  "The schema tests do not cover session persistence.",
              },
            ],
            reopenTaskIds: ["task-1"],
          },
        },
      ],
      machineSnapshot: {
        state: "running",
      },
      startedAt: timestamp,
      completedAt: null,
      haltReason: null,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sharedDocuments).toHaveLength(1);
      expect(result.data.history[0]?.event.type).toBe(
        "graph-workflow-validation-result",
      );
    }
  });
});

describe("workflow graph validator and request schemas", () => {
  it("defaults validator directives collections while preserving issues", () => {
    const emptyResult = workflowAgentValidatorResultSchema.parse({
      pass: true,
      summary: "Looks good",
    });
    expect(emptyResult.issues).toEqual([]);
    expect(emptyResult.reopenTaskIds).toEqual([]);

    const issueResult = workflowAgentValidatorResultSchema.parse({
      pass: false,
      summary: "Needs fixes",
      reopenTaskIds: ["task-1"],
      issues: [
        {
          title: "Missing coverage",
          description: "Add tests for the new graph workflow state fields.",
        },
      ],
    });

    expect(issueResult.issues[0]?.title).toBe("Missing coverage");
  });

  it("parses runtime edit operations for add and move workflows", () => {
    const result = workflowRuntimeEditRequestSchema.safeParse({
      operations: [
        {
          type: "add",
          contextId: "context-1",
          title: "Document the schema",
          instructions: "Write down the intended contracts.",
          metadata: {
            source: "user",
          },
        },
        {
          type: "move",
          taskId: "task-2",
          targetContextId: "context-1",
          targetOrder: 2,
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe("graphWorkflowAgentValidatorConfigSchema discriminated union", () => {
  it("parses a claude validator config with explicit type", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.safeParse({
      type: "claude",
      enabled: true,
      agent: { model: "sonnet", reasoningEffort: "medium" },
      instructions: "Validate each task.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("claude");
      expect(result.data).toHaveProperty("agent");
    }
  });

  it("parses a codex validator config", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.safeParse({
      type: "codex",
      enabled: true,
      codex: { model: "o3", reasoningEffort: "high" },
      instructions: "Validate with Codex.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("codex");
      expect(result.data).toHaveProperty("codex");
    }
  });

  it("parses legacy format without type as claude (backward compat)", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.safeParse({
      enabled: true,
      agent: { model: "opus", reasoningEffort: "high" },
      instructions: "Review the context.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("claude");
    }
  });

  it("defaults codex field to empty object when omitted", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.safeParse({
      type: "codex",
      enabled: false,
      instructions: "Check it.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("codex");
      expect((result.data as { codex: object }).codex).toEqual({});
    }
  });

  it("rejects invalid type value", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.safeParse({
      type: "gpt",
      enabled: true,
      instructions: "Nope.",
    });
    expect(result.success).toBe(false);
  });
});

describe("workflow graph session state and SSE schemas", () => {
  it("adds graph workflow execution state to session persistence with backward-compatible defaults", () => {
    const result = sessionStateSchema.safeParse({
      sessionName: "test-session",
      worktreePath: "/tmp/test",
      branchName: "csm/test",
      createdAt: timestamp,
      lastActivityAt: timestamp,
      archived: false,
      conversations: [],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.graphWorkflowExecution).toBe(null);
      expect(result.data.graphWorkflowExecutionHistory).toEqual([]);
    }
  });

  it("parses graph workflow SSE event payloads", () => {
    const statusEvent = graphWorkflowStatusEventSchema.safeParse({
      type: "graph-workflow-status",
      projectName: "remote-ai-manager",
      sessionName: "validator-loop-design-f93878",
      executionId: "execution-1",
      workflowStatus: "running",
      activeContextId: "context-1",
      activeTaskId: "task-1",
      haltReason: null,
    });
    expect(statusEvent.success).toBe(true);

    const docsEvent = graphWorkflowSharedDocumentsUpdatedEventSchema.safeParse({
      type: "graph-workflow-shared-documents-updated",
      projectName: "remote-ai-manager",
      sessionName: "validator-loop-design-f93878",
      executionId: "execution-1",
      documents: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Shared implementation plan",
          readWhen: "Read before implementation work.",
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUpdatedByConversationId: null,
        },
      ],
    });
    expect(docsEvent.success).toBe(true);
  });
});

describe("workflowValidatorDefaultSchema", () => {
  it("parses a claude validator default with model and effort", () => {
    const result = workflowValidatorDefaultSchema.safeParse({
      type: "claude",
      model: "sonnet",
      reasoningEffort: "high",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("claude");
    }
  });

  it("parses a codex validator default with model and effort", () => {
    const result = workflowValidatorDefaultSchema.safeParse({
      type: "codex",
      model: "o3",
      reasoningEffort: "high",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("codex");
    }
  });

  it("allows model and effort to be optional", () => {
    const result = workflowValidatorDefaultSchema.safeParse({
      type: "codex",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = workflowValidatorDefaultSchema.safeParse({
      type: "gpt",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid claude model", () => {
    const result = workflowValidatorDefaultSchema.safeParse({
      type: "claude",
      model: "gpt-4",
    });
    expect(result.success).toBe(false);
  });

  it("codex allows free-form model strings", () => {
    const result = workflowValidatorDefaultSchema.safeParse({
      type: "codex",
      model: "o4-mini",
    });
    expect(result.success).toBe(true);
  });
});

describe("workflowDefaultsSchema", () => {
  it("parses with both validators specified", () => {
    const result = workflowDefaultsSchema.safeParse({
      executionValidator: {
        type: "codex",
        model: "o3",
        reasoningEffort: "high",
      },
      taskValidator: {
        type: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executionValidator?.type).toBe("codex");
      expect(result.data.taskValidator?.type).toBe("claude");
    }
  });

  it("allows all fields to be optional", () => {
    const result = workflowDefaultsSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("getCodexReasoningLevelsForModel", () => {
  it("returns allowed levels for gpt-5.4", () => {
    expect(getCodexReasoningLevelsForModel("gpt-5.4")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("excludes minimal from gpt-5.4 (not supported by the API)", () => {
    const levels = getCodexReasoningLevelsForModel("gpt-5.4");
    expect(levels).not.toContain("minimal");
  });

  it("returns null for unknown models (all levels allowed)", () => {
    expect(getCodexReasoningLevelsForModel("unknown-model")).toBeNull();
  });
});

describe("graphWorkflowLaneContinuityPolicySchema", () => {
  it("defaults enabled to true when omitted", () => {
    const result = graphWorkflowLaneContinuityPolicySchema.parse({});
    expect(result.enabled).toBe(true);
  });

  it("accepts explicit enabled: false", () => {
    const result = graphWorkflowLaneContinuityPolicySchema.parse({
      enabled: false,
    });
    expect(result.enabled).toBe(false);
  });

  it("accepts contextLimitTokens as a positive integer", () => {
    const result = graphWorkflowLaneContinuityPolicySchema.parse({
      contextLimitTokens: 100000,
    });
    expect(result.contextLimitTokens).toBe(100000);
  });

  it("rejects contextLimitTokens of zero", () => {
    const result = graphWorkflowLaneContinuityPolicySchema.safeParse({
      contextLimitTokens: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative contextLimitTokens", () => {
    const result = graphWorkflowLaneContinuityPolicySchema.safeParse({
      contextLimitTokens: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts omitted contextLimitTokens (no limit configured)", () => {
    const result = graphWorkflowLaneContinuityPolicySchema.parse({
      enabled: true,
    });
    expect(result.contextLimitTokens).toBeUndefined();
  });

  it("rejects float contextLimitTokens", () => {
    const result = graphWorkflowLaneContinuityPolicySchema.safeParse({
      contextLimitTokens: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowIterationPolicySchema with continuity", () => {
  it("defaults continuity to enabled with no limit when omitted", () => {
    const result = graphWorkflowIterationPolicySchema.parse({
      maxIterations: 10,
    });
    expect(result.continuity.enabled).toBe(true);
    expect(result.continuity.contextLimitTokens).toBeUndefined();
  });

  it("accepts explicit continuity with contextLimitTokens", () => {
    const result = graphWorkflowIterationPolicySchema.parse({
      maxIterations: 5,
      continuity: { enabled: true, contextLimitTokens: 80000 },
    });
    expect(result.continuity.enabled).toBe(true);
    expect(result.continuity.contextLimitTokens).toBe(80000);
  });

  it("accepts continuity disabled with no limit", () => {
    const result = graphWorkflowIterationPolicySchema.parse({
      maxIterations: 3,
      continuity: { enabled: false },
    });
    expect(result.continuity.enabled).toBe(false);
    expect(result.continuity.contextLimitTokens).toBeUndefined();
  });
});

describe("graphWorkflowAgentValidatorConfigSchema with continuity", () => {
  it("defaults continuity to enabled for claude validators", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.parse({
      type: "claude",
      enabled: true,
      instructions: "Validate the task.",
      agent: { model: "sonnet", reasoningEffort: "medium" },
    });
    expect(result.continuity.enabled).toBe(true);
    expect(result.continuity.contextLimitTokens).toBeUndefined();
  });

  it("defaults continuity to enabled for codex validators", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.parse({
      type: "codex",
      enabled: true,
      instructions: "Validate with Codex.",
    });
    expect(result.continuity.enabled).toBe(true);
  });

  it("accepts explicit continuity on claude validators", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.parse({
      type: "claude",
      enabled: true,
      instructions: "Check it.",
      agent: { model: "opus", reasoningEffort: "high" },
      continuity: { enabled: false },
    });
    expect(result.continuity.enabled).toBe(false);
  });
});

describe("globalConfigSchema workflowDefaults", () => {
  it("accepts config with workflowDefaults", () => {
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
      stateFilePath: "/tmp/state.json",
      claudeTimeoutMs: 3600000,
      workflowDefaults: {
        executionValidator: { type: "codex", model: "o3" },
        taskValidator: {
          type: "claude",
          model: "sonnet",
          reasoningEffort: "high",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflowDefaults?.executionValidator?.type).toBe(
        "codex",
      );
    }
  });

  it("accepts config without workflowDefaults (backward compat)", () => {
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
      stateFilePath: "/tmp/state.json",
      claudeTimeoutMs: 3600000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflowDefaults).toBeUndefined();
    }
  });
});

describe("graphWorkflowExecutionSessionRefSchema", () => {
  it("parses a claude session ref", () => {
    const result = graphWorkflowExecutionSessionRefSchema.safeParse({
      engine: "claude",
      lane: "implementer",
      conversationId: "conv-123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.engine).toBe("claude");
      expect(result.data.lane).toBe("implementer");
      if (result.data.engine === "claude") {
        expect(result.data.conversationId).toBe("conv-123");
      }
    }
  });

  it("parses a codex session ref", () => {
    const result = graphWorkflowExecutionSessionRefSchema.safeParse({
      engine: "codex",
      lane: "task_validator",
      threadId: "thread-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.engine).toBe("codex");
      expect(result.data.lane).toBe("task_validator");
      if (result.data.engine === "codex") {
        expect(result.data.threadId).toBe("thread-abc");
      }
    }
  });

  it("accepts all lane kinds", () => {
    const lanes = ["implementer", "task_validator"] as const;
    for (const lane of lanes) {
      const result = graphWorkflowExecutionSessionRefSchema.safeParse({
        engine: "claude",
        lane,
        conversationId: "conv-x",
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown engine", () => {
    const result = graphWorkflowExecutionSessionRefSchema.safeParse({
      engine: "openai",
      lane: "implementer",
      conversationId: "conv-x",
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowLaneStateSchema", () => {
  const claudeSessionRef = {
    engine: "claude" as const,
    lane: "implementer" as const,
    conversationId: "conv-123",
  };
  const codexSessionRef = {
    engine: "codex" as const,
    lane: "task_validator" as const,
    threadId: "thread-abc",
  };

  it("parses a claude lane state with supported limit evaluation", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: claudeSessionRef,
      lastContextTokens: 50000,
      lastContextWindowMax: 200000,
      rotateBeforeNextTurn: false,
      limitEvaluation: "supported",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.engine === "claude") {
      expect(result.data.lastContextTokens).toBe(50000);
      expect(result.data.limitEvaluation).toBe("supported");
    }
  });

  it("parses a claude lane state with disabled limit evaluation", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: claudeSessionRef,
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
  });

  it("defaults claude lane fields when omitted", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: claudeSessionRef,
      limitEvaluation: "disabled",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.engine === "claude") {
      expect(result.data.lastContextTokens).toBeNull();
      expect(result.data.lastContextWindowMax).toBeNull();
      expect(result.data.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("parses a codex lane state", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "codex",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: codexSessionRef,
      lastTurnUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
      },
      rotateBeforeNextTurn: false,
      limitEvaluation: "unsupported",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.engine === "codex") {
      expect(result.data.lastTurnUsage?.inputTokens).toBe(1000);
      expect(result.data.limitEvaluation).toBe("unsupported");
    }
  });

  it("defaults codex lane fields when omitted", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "codex",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: codexSessionRef,
      limitEvaluation: "disabled",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.engine === "codex") {
      expect(result.data.lastTurnUsage).toBeNull();
      expect(result.data.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("rejects claude lane state with unsupported limitEvaluation", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      sessionRef: claudeSessionRef,
      limitEvaluation: "unsupported",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(false);
  });

  it("rejects codex lane state with supported limitEvaluation", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "codex",
      lane: "task_validator",
      contextId: "ctx-1",
      sessionRef: codexSessionRef,
      limitEvaluation: "supported",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowExecutionSchema laneStates", () => {
  it("defaults laneStates to empty object", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "exec-1",
      seedDefinitionId: "def-1",
      seedDefinitionRevision: 1,
      workingDefinition: {
        schemaVersion: 1,
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      status: "pending",
      startedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.laneStates).toEqual({});
    }
  });

  it("persists laneStates with claude and codex entries", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "exec-1",
      seedDefinitionId: "def-1",
      seedDefinitionRevision: 1,
      workingDefinition: {
        schemaVersion: 1,
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      status: "running",
      startedAt: timestamp,
      laneStates: {
        implementer: {
          engine: "claude",
          lane: "implementer",
          contextId: "ctx-1",
          sessionRef: {
            engine: "claude",
            lane: "implementer",
            conversationId: "conv-123",
          },
          lastContextTokens: 80000,
          lastContextWindowMax: 200000,
          rotateBeforeNextTurn: true,
          limitEvaluation: "supported",
          lastUsedAt: timestamp,
        },
        task_validator: {
          engine: "codex",
          lane: "task_validator",
          contextId: "ctx-1",
          sessionRef: {
            engine: "codex",
            lane: "task_validator",
            threadId: "thread-xyz",
          },
          lastTurnUsage: null,
          rotateBeforeNextTurn: false,
          limitEvaluation: "unsupported",
          lastUsedAt: timestamp,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.laneStates)).toHaveLength(2);
    }
  });
});
