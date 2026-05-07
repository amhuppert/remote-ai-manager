import { describe, expect, it } from "vitest";
import {
  getCodexReasoningLevelsForModel,
  globalConfigSchema,
  graphWorkflowAgentValidatorConfigSchema,
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowExecutionEventSchema,
  graphWorkflowExecutionSchema,
  graphWorkflowExecutionSessionRefSchema,
  graphWorkflowHaltReasonSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowLaneContinuityPolicySchema,
  graphWorkflowLaneStateSchema,
  graphWorkflowResolvedContextSchema,
  graphWorkflowScriptValidatorConfigSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowStatusEventSchema,
  resetExecutionContextRequestSchema,
  sessionStateSchema,
  workflowAgentValidatorResultSchema,
  workflowConfigOverrideSchema,
  workflowDefaultsSchema,
  workflowDefinitionRecordSchema,
  workflowRuntimeEditRequestSchema,
} from "./schemas";

const timestamp = "2026-03-27T12:00:00.000Z";

function createSemanticDefinition() {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    executionContexts: [
      {
        id: "context-1",
        title: "Plan",
        description: "Plan the implementation",
        acceptanceCriteria: "All tasks are complete and verified.",
        implementer: {
          backend: "claude",
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
        contextValidator: {
          kind: "use",
          value: {
            type: "claude",
            enabled: true,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        },
      },
      {
        id: "context-2",
        title: "Implement",
        description: "Write the code",
        acceptanceCriteria: "Code compiles and tests pass.",
        implementer: {
          backend: "claude",
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

function createResolvedDefinition() {
  return {
    schemaVersion: 1,
    executionContexts: [
      {
        id: "context-1",
        title: "Plan",
        description: "Plan the implementation",
        acceptanceCriteria: "All tasks are complete and verified.",
        implementer: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "high",
        },
        mutability: { allowAgentTaskAdd: true },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: {
          maxIterations: 5,
          continuity: { enabled: true, contextLimitTokens: 120000 },
        },
        contextValidator: {
          type: "claude",
          enabled: true,
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          continuity: { enabled: true },
        },
      },
      {
        id: "context-2",
        title: "Implement",
        description: "Write the code",
        acceptanceCriteria: "Code compiles and tests pass.",
        implementer: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 2 },
        iterationPolicy: { maxIterations: 3 },
        contextValidator: null,
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "context-1",
        order: 1,
        title: "Inspect the current state",
        instructions: "Read the relevant files.",
        metadata: { area: "schemas" },
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
      workingDefinition: createResolvedDefinition(),
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
        },
        "context-2": {
          contextId: "context-2",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
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
          failureMessage: null,
          failureHistory: [],
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
            validatorType: "context",
            pass: false,
            summary: "Validation requested fixes",
            reopenTaskIds: ["task-1"],
            issues: [
              {
                taskId: "task-1",
                title: "Missing assertions",
                description:
                  "The schema tests do not cover session persistence.",
              },
            ],
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
  it("defaults issues to an empty array and requires taskId on each issue", () => {
    const emptyResult = workflowAgentValidatorResultSchema.parse({
      summary: "Looks good",
    });
    expect(emptyResult.issues).toEqual([]);

    const issueResult = workflowAgentValidatorResultSchema.parse({
      summary: "Needs fixes",
      issues: [
        {
          taskId: "task-1",
          title: "Missing coverage",
          description: "Add tests for the new graph workflow state fields.",
        },
      ],
    });

    expect(issueResult.issues[0]?.title).toBe("Missing coverage");
    expect(issueResult.issues[0]?.taskId).toBe("task-1");

    const missingTaskId = workflowAgentValidatorResultSchema.safeParse({
      summary: "Needs fixes",
      issues: [
        {
          title: "Missing coverage",
          description: "Add tests for the new graph workflow state fields.",
        },
      ],
    });
    expect(missingTaskId.success).toBe(false);
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
      acceptanceCriteria: "All tasks are complete and verified.",
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
      codex: { model: "gpt-5.4", reasoningEffort: "high" },
      acceptanceCriteria: "All tasks are complete and verified.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("codex");
      expect(result.data).toHaveProperty("codex");
    }
  });

  it("defaults codex field to empty object when omitted", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.safeParse({
      type: "codex",
      enabled: false,
      acceptanceCriteria: "Check it.",
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
      acceptanceCriteria: "Nope.",
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

function createWorkflowDefaults() {
  return {
    implementer: {
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
    },
    contextValidator: {
      type: "claude",
      enabled: true,
      agent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      continuity: { enabled: true },
    },
    scriptValidator: { enabled: false },
    iterationPolicy: {
      maxIterations: 20,
      continuity: { enabled: true },
    },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    mutability: { allowAgentTaskAdd: false },
  };
}

describe("workflowDefaultsSchema", () => {
  it("parses with all six blocks specified", () => {
    const result = workflowDefaultsSchema.safeParse(createWorkflowDefaults());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextValidator.type).toBe("claude");
      expect(result.data.scriptValidator.enabled).toBe(false);
    }
  });

  it("requires all six blocks including scriptValidator", () => {
    const result = workflowDefaultsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects workflowDefaults missing the scriptValidator block", () => {
    const defaults = createWorkflowDefaults();
    const { scriptValidator: _removed, ...withoutScriptValidator } = defaults;
    const result = workflowDefaultsSchema.safeParse(withoutScriptValidator);
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowScriptValidatorConfigSchema", () => {
  it("accepts { enabled: true }", () => {
    const result = graphWorkflowScriptValidatorConfigSchema.safeParse({
      enabled: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it("accepts { enabled: false }", () => {
    const result = graphWorkflowScriptValidatorConfigSchema.safeParse({
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  it("defaults enabled to false when the block is passed empty", () => {
    const result = graphWorkflowScriptValidatorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it("rejects non-boolean enabled values", () => {
    const result = graphWorkflowScriptValidatorConfigSchema.safeParse({
      enabled: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("workflowConfigOverrideSchema scriptValidator", () => {
  it("accepts an override that sets scriptValidator", () => {
    const result = workflowConfigOverrideSchema.safeParse({
      scriptValidator: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scriptValidator?.enabled).toBe(true);
    }
  });

  it("accepts an override that omits scriptValidator (inherits)", () => {
    const result = workflowConfigOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scriptValidator).toBeUndefined();
    }
  });
});

describe("graphWorkflowExecutionContextDefinitionSchema scriptValidator", () => {
  const base = {
    id: "ctx-1",
    title: "Context",
    acceptanceCriteria: "AC",
  };

  it("accepts a context that sets scriptValidator", () => {
    const result = graphWorkflowExecutionContextDefinitionSchema.safeParse({
      ...base,
      scriptValidator: { enabled: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a context that omits scriptValidator (inherits)", () => {
    const result =
      graphWorkflowExecutionContextDefinitionSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scriptValidator).toBeUndefined();
    }
  });
});

describe("graphWorkflowResolvedContextSchema scriptValidator", () => {
  const base = {
    id: "ctx-1",
    title: "Context",
    acceptanceCriteria: "AC",
    implementer: {
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
    },
    contextValidator: null,
    mutability: { allowAgentTaskAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  };

  it("defaults scriptValidator to { enabled: false } when missing (legacy state)", () => {
    const result = graphWorkflowResolvedContextSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scriptValidator).toEqual({ enabled: false });
    }
  });

  it("parses a resolved context with scriptValidator.enabled=true", () => {
    const result = graphWorkflowResolvedContextSchema.safeParse({
      ...base,
      scriptValidator: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scriptValidator.enabled).toBe(true);
    }
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

  it("returns the same allowed levels for gpt-5.5 as for gpt-5.4", () => {
    expect(getCodexReasoningLevelsForModel("gpt-5.5")).toEqual(
      getCodexReasoningLevelsForModel("gpt-5.4"),
    );
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
      acceptanceCriteria: "Validate the context.",
      agent: { model: "sonnet", reasoningEffort: "medium" },
    });
    expect(result.continuity.enabled).toBe(true);
    expect(result.continuity.contextLimitTokens).toBeUndefined();
  });

  it("defaults continuity to enabled for codex validators", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.parse({
      type: "codex",
      enabled: true,
      acceptanceCriteria: "Validate with Codex.",
    });
    expect(result.continuity.enabled).toBe(true);
  });

  it("accepts explicit continuity on claude validators", () => {
    const result = graphWorkflowAgentValidatorConfigSchema.parse({
      type: "claude",
      enabled: true,
      acceptanceCriteria: "Check it.",
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
      claudeTimeoutMs: 3600000,
      workflowDefaults: createWorkflowDefaults(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflowDefaults?.contextValidator?.type).toBe(
        "claude",
      );
    }
  });

  it("accepts config without workflowDefaults (backward compat)", () => {
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
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
      lane: "context_validator",
      threadId: "thread-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.engine).toBe("codex");
      expect(result.data.lane).toBe("context_validator");
      if (result.data.engine === "codex") {
        expect(result.data.threadId).toBe("thread-abc");
      }
    }
  });

  it("accepts all lane kinds", () => {
    const lanes = ["implementer", "context_validator"] as const;
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
    lane: "context_validator" as const,
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
      lane: "context_validator",
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
      lane: "context_validator",
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
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: codexSessionRef,
      limitEvaluation: "supported",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(false);
  });

  it("parses a codex implementer lane state with workflowConversationId", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "codex",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-cc-123",
      sessionRef: {
        engine: "codex",
        lane: "implementer",
        threadId: "thread-impl",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.engine === "codex") {
      expect(result.data.workflowConversationId).toBe("conv-cc-123");
      expect(result.data.lane).toBe("implementer");
      expect(result.data.sessionRef).toEqual({
        engine: "codex",
        lane: "implementer",
        threadId: "thread-impl",
      });
    }
  });

  it("allows a codex implementer lane state to omit sessionRef before the first turn", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "codex",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-cc-123",
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.engine === "codex") {
      expect(result.data.workflowConversationId).toBe("conv-cc-123");
      expect(result.data.sessionRef).toBeUndefined();
    }
  });

  it("allows workflowConversationId on claude lane state", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-123",
      sessionRef: claudeSessionRef,
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.engine === "claude") {
      expect(result.data.workflowConversationId).toBe("conv-123");
    }
  });

  it("defaults workflowConversationId to undefined when omitted", () => {
    const result = graphWorkflowLaneStateSchema.safeParse({
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      sessionRef: codexSessionRef,
      limitEvaluation: "disabled",
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflowConversationId).toBeUndefined();
    }
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
        context_validator: {
          engine: "codex",
          lane: "context_validator",
          contextId: "ctx-1",
          sessionRef: {
            engine: "codex",
            lane: "context_validator",
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

describe("resetExecutionContextRequestSchema", () => {
  it("parses a well-formed request with executionId and contextId", () => {
    const result = resetExecutionContextRequestSchema.safeParse({
      executionId: "exec-1",
      contextId: "ctx-1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executionId).toBe("exec-1");
      expect(result.data.contextId).toBe("ctx-1");
    }
  });

  it("rejects a request missing contextId", () => {
    const result = resetExecutionContextRequestSchema.safeParse({
      executionId: "exec-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects blank executionId or contextId", () => {
    expect(
      resetExecutionContextRequestSchema.safeParse({
        executionId: "",
        contextId: "ctx-1",
      }).success,
    ).toBe(false);
    expect(
      resetExecutionContextRequestSchema.safeParse({
        executionId: "exec-1",
        contextId: "   ",
      }).success,
    ).toBe(false);
  });
});

describe("graphWorkflowExecutionEventSchema preReset marker", () => {
  const baseEvent = {
    occurredAt: timestamp,
    event: {
      type: "graph-workflow-context-status" as const,
      projectName: "p",
      sessionName: "s",
      executionId: "exec-1",
      contextId: "ctx-1",
      status: "running" as const,
      remainingTaskCount: 0,
      iterationCount: 1,
    },
  };

  it("defaults preReset to false when omitted", () => {
    const result = graphWorkflowExecutionEventSchema.safeParse(baseEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preReset).toBe(false);
    }
  });

  it("persists preReset: true when specified", () => {
    const result = graphWorkflowExecutionEventSchema.safeParse({
      ...baseEvent,
      preReset: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preReset).toBe(true);
    }
  });

  it("rejects a non-boolean preReset value", () => {
    const result = graphWorkflowExecutionEventSchema.safeParse({
      ...baseEvent,
      preReset: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowHaltReasonSchema", () => {
  it("accepts a validator_infra_error halt reason", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "validator_infra_error",
      contextId: "ctx-1",
      engine: "codex",
      infraReason: "exception",
      message: "Codex process terminated unexpectedly",
      summary: null,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "validator_infra_error") {
      expect(result.data.engine).toBe("codex");
      expect(result.data.infraReason).toBe("exception");
      expect(result.data.message).toBe("Codex process terminated unexpectedly");
      expect(result.data.contextId).toBe("ctx-1");
    }
  });

  it("accepts all infraReason variants", () => {
    for (const infraReason of [
      "exception",
      "unparseable",
      "schema_mismatch",
    ] as const) {
      const result = graphWorkflowHaltReasonSchema.safeParse({
        type: "validator_infra_error",
        contextId: "ctx-1",
        engine: "claude",
        infraReason,
        message: "msg",
        summary: null,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts both engines for validator_infra_error", () => {
    for (const engine of ["claude", "codex"] as const) {
      const result = graphWorkflowHaltReasonSchema.safeParse({
        type: "validator_infra_error",
        contextId: "ctx-1",
        engine,
        infraReason: "exception",
        message: "msg",
        summary: null,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects validator_infra_error with an unknown engine", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "validator_infra_error",
      contextId: "ctx-1",
      engine: "nonsense",
      infraReason: "exception",
      message: "msg",
      summary: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects validator_infra_error with an unknown infraReason", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "validator_infra_error",
      contextId: "ctx-1",
      engine: "codex",
      infraReason: "nonsense",
      message: "msg",
      summary: null,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a script_validator_missing_command halt reason", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "script_validator_missing_command",
      contextId: "ctx-1",
      message: "Script validator enabled but preMergeCommand is not configured",
    });
    expect(result.success).toBe(true);
    if (
      result.success &&
      result.data.type === "script_validator_missing_command"
    ) {
      expect(result.data.contextId).toBe("ctx-1");
      expect(result.data.message).toContain("preMergeCommand");
    }
  });
});
