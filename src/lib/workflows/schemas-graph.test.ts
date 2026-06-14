import { describe, expect, it } from "vitest";
import { getCodexReasoningLevelsForModel } from "@/lib/agent-backends/schemas";
import {
  graphWorkflowAgentValidatorConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowLaneContinuityPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  graphWorkflowApprovalDecisionSchema,
  graphWorkflowApprovalPendingEventSchema,
  graphWorkflowApprovalResolvedEventSchema,
  graphWorkflowBatchScheduledEventSchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowPendingApprovalSchema,
  graphWorkflowContextStatusSchema,
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowExecutionContextStateSchema,
  graphWorkflowExecutionEventSchema,
  graphWorkflowExecutionJoinStateSchema,
  graphWorkflowExecutionLaneStateSchema,
  graphWorkflowExecutionSchema,
  graphWorkflowExecutionSessionRefSchema,
  graphWorkflowHaltReasonSchema,
  workflowCollaborationStatusSchema,
  workflowCollaborationResultSchema,
  graphWorkflowAgentSessionStateSchema,
  graphWorkflowMergeStatusEventSchema,
  graphWorkflowPendingHaltReasonEventSchema,
  graphWorkflowResolvedContextSchema,
  graphWorkflowSharedDocumentEntrySchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowStatusEventSchema,
  resetExecutionContextRequestSchema,
  workflowAgentValidatorResultSchema,
  workflowConfigOverrideSchema,
  workflowDefinitionRecordSchema,
  workflowRuntimeEditRequestSchema,
  workflowSemanticDefinitionSchema,
} from "./schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  globalConfigSchema,
  workflowDefaultsSchema,
} from "@/lib/config/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";

const timestamp = "2026-03-27T12:00:00.000Z";

function createSemanticDefinition() {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
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
      charter: makeTestCharter(),
      status: "running",
      activeContextIds: ["context-1"],
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

describe("workflow charter requirement on persisted schemas", () => {
  it("rejects a semantic definition that omits the charter", () => {
    const def = createSemanticDefinition();
    const { charter: _charter, ...withoutCharter } = def;
    void _charter;

    const result = workflowSemanticDefinitionSchema.safeParse(withoutCharter);

    expect(result.success).toBe(false);
  });

  it("parses a semantic definition that includes a valid charter", () => {
    const result = workflowSemanticDefinitionSchema.safeParse(
      createSemanticDefinition(),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.charter.sourcesOfTruth).toHaveLength(2);
    }
  });

  it("rejects an execution snapshot that omits the charter", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "execution-no-charter",
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 1,
      workingDefinition: createResolvedDefinition(),
      status: "pending",
      startedAt: timestamp,
    });

    expect(result.success).toBe(false);
  });

  it("parses an execution snapshot that includes a valid charter", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "execution-with-charter",
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 1,
      workingDefinition: createResolvedDefinition(),
      status: "pending",
      startedAt: timestamp,
      charter: makeTestCharter(),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.charter.mission).toBe(makeTestCharter().mission);
    }
  });

  it("defaults a shared-document entry without an explicit kind to 'shared'", () => {
    const result = graphWorkflowSharedDocumentEntrySchema.safeParse({
      id: "doc-1",
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Shared implementation plan",
      readWhen: "Read before starting implementation work.",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("shared");
    }
  });

  it("accepts a shared-document entry with an explicit charter kind", () => {
    const result = graphWorkflowSharedDocumentEntrySchema.safeParse({
      id: "charter-doc",
      relativePath: ".cc/graph-workflow-docs/charter.md",
      description: "The governing charter",
      readWhen: "Read before resolving any source conflict.",
      createdAt: timestamp,
      updatedAt: timestamp,
      kind: "charter",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("charter");
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
      activeContextIds: ["context-1", "context-2"],
      activeBatchIds: ["batch-1"],
      haltReason: null,
      pendingHaltReason: null,
    });
    expect(statusEvent.success).toBe(true);
    if (statusEvent.success) {
      expect(statusEvent.data.activeContextIds).toEqual([
        "context-1",
        "context-2",
      ]);
      expect(statusEvent.data.activeBatchIds).toEqual(["batch-1"]);
      expect(statusEvent.data.pendingHaltReason).toBeNull();
    }

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

  it("parses graph-workflow-pending-halt-reason events", () => {
    const event = graphWorkflowPendingHaltReasonEventSchema.safeParse({
      type: "graph-workflow-pending-halt-reason",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      pendingHaltReason: {
        type: "circuit_breaker",
        contextId: "context-1",
        condition: "retry_exhaustion",
      },
    });
    expect(event.success).toBe(true);
    if (event.success) {
      expect(event.data.pendingHaltReason).toEqual({
        type: "circuit_breaker",
        contextId: "context-1",
        condition: "retry_exhaustion",
        summary: null,
      });
    }

    const nullEvent = graphWorkflowPendingHaltReasonEventSchema.safeParse({
      type: "graph-workflow-pending-halt-reason",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      pendingHaltReason: null,
    });
    expect(nullEvent.success).toBe(true);
  });

  it("parses graph-workflow-merge-status events", () => {
    const event = graphWorkflowMergeStatusEventSchema.safeParse({
      type: "graph-workflow-merge-status",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-1",
      branchName: "csm/session-1-context-1",
      mergeStatus: "in-progress",
      cleanupStatus: "pending",
      lastMergeError: null,
    });
    expect(event.success).toBe(true);
    if (event.success) {
      expect(event.data.mergeStatus).toBe("in-progress");
      expect(event.data.cleanupStatus).toBe("pending");
    }
  });

  it("parses graph-workflow-batch-scheduled events", () => {
    const event = graphWorkflowBatchScheduledEventSchema.safeParse({
      type: "graph-workflow-batch-scheduled",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      batchId: "batch-1",
      contextIds: ["context-1", "context-2"],
    });
    expect(event.success).toBe(true);
    if (event.success) {
      expect(event.data.batchId).toBe("batch-1");
      expect(event.data.contextIds).toEqual(["context-1", "context-2"]);
    }
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
    humanApprovalGate: { enabled: false },
    iterationPolicy: {
      maxIterations: 20,
      continuity: { enabled: true },
    },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    mutability: { allowAgentTaskAdd: false },
    collaboration: {
      secondAgent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
  };
}

describe("workflowDefaultsSchema", () => {
  it("parses with every block specified", () => {
    const result = workflowDefaultsSchema.safeParse(createWorkflowDefaults());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextValidator.type).toBe("claude");
      expect(result.data.scriptValidator.enabled).toBe(false);
      expect(result.data.collaboration.negotiationRounds).toBe(3);
    }
  });

  it("requires every top-level block", () => {
    const result = workflowDefaultsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects workflowDefaults missing the scriptValidator block", () => {
    const defaults = createWorkflowDefaults();
    const { scriptValidator: _removed, ...withoutScriptValidator } = defaults;
    const result = workflowDefaultsSchema.safeParse(withoutScriptValidator);
    expect(result.success).toBe(false);
  });

  it("rejects workflowDefaults missing the collaboration block", () => {
    const defaults = createWorkflowDefaults();
    const { collaboration: _removed, ...withoutCollaboration } = defaults;
    const result = workflowDefaultsSchema.safeParse(withoutCollaboration);
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

describe("graphWorkflowAgentSessionStateSchema", () => {
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
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
      charter: makeTestCharter(),
      status: "pending",
      startedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.laneStates).toEqual({});
    }
  });

  it("persists laneStates keyed first by contextId then by lane", () => {
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
      charter: makeTestCharter(),
      status: "running",
      startedAt: timestamp,
      laneStates: {
        "ctx-1": {
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
        "ctx-2": {
          implementer: {
            engine: "claude",
            lane: "implementer",
            contextId: "ctx-2",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-456",
            },
            lastContextTokens: 0,
            lastContextWindowMax: 200000,
            rotateBeforeNextTurn: false,
            limitEvaluation: "supported",
            lastUsedAt: timestamp,
          },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.laneStates)).toEqual(["ctx-1", "ctx-2"]);
      expect(Object.keys(result.data.laneStates["ctx-1"] ?? {}).sort()).toEqual(
        ["context_validator", "implementer"],
      );
      expect(result.data.laneStates["ctx-2"]?.implementer?.contextId).toBe(
        "ctx-2",
      );
    }
  });

  it("rejects legacy lane keying that places lane state directly under the lane key", () => {
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
      charter: makeTestCharter(),
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
          lastContextTokens: null,
          lastContextWindowMax: null,
          rotateBeforeNextTurn: false,
          limitEvaluation: "disabled",
          lastUsedAt: timestamp,
        },
      },
    });
    expect(result.success).toBe(false);
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

  it("accepts a merge_failure halt reason with contextId, message, and conflictFiles", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "merge_failure",
      contextId: "ctx-1",
      message: "Merge conflict could not be resolved automatically",
      conflictFiles: ["src/lib/foo.ts", "src/lib/bar.ts"],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "merge_failure") {
      expect(result.data.contextId).toBe("ctx-1");
      expect(result.data.message).toContain("Merge conflict");
      expect(result.data.conflictFiles).toEqual([
        "src/lib/foo.ts",
        "src/lib/bar.ts",
      ]);
    }
  });

  it("defaults conflictFiles to an empty array on merge_failure", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "merge_failure",
      contextId: "ctx-1",
      message: "Merge failed",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "merge_failure") {
      expect(result.data.conflictFiles).toEqual([]);
    }
  });

  it("rejects a merge_failure halt reason with a blank contextId", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "merge_failure",
      contextId: "",
      message: "Merge failed",
      conflictFiles: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a collaboration_failure halt reason with all required fields", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "collaboration_failure",
      status: "objective_disagreement",
      brief: "Should we use Postgres or DynamoDB?",
      executionContextId: "ctx-1",
      conversationId: "conv-1",
      summary: "Agents disagreed on core data-store choice",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "collaboration_failure") {
      expect(result.data.status).toBe("objective_disagreement");
      expect(result.data.brief).toBe("Should we use Postgres or DynamoDB?");
      expect(result.data.executionContextId).toBe("ctx-1");
      expect(result.data.conversationId).toBe("conv-1");
      expect(result.data.summary).toBe(
        "Agents disagreed on core data-store choice",
      );
    }
  });

  it("accepts every collaboration_failure status variant", () => {
    for (const status of [
      "converged",
      "rounds_exhausted",
      "requires_user_input",
      "objective_disagreement",
    ] as const) {
      const result = graphWorkflowHaltReasonSchema.safeParse({
        type: "collaboration_failure",
        status,
        brief: "brief",
        executionContextId: "ctx-1",
        conversationId: "conv-1",
        summary: "summary",
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a collaboration_failure halt reason with an unknown status", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "collaboration_failure",
      status: "nonsense",
      brief: "brief",
      executionContextId: "ctx-1",
      conversationId: "conv-1",
      summary: "summary",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a collaboration_failure halt reason missing any required field", () => {
    const required = [
      "status",
      "brief",
      "executionContextId",
      "conversationId",
      "summary",
    ] as const;
    const base = {
      type: "collaboration_failure" as const,
      status: "objective_disagreement",
      brief: "brief",
      executionContextId: "ctx-1",
      conversationId: "conv-1",
      summary: "summary",
    };
    for (const key of required) {
      const variant: Record<string, unknown> = { ...base };
      delete variant[key];
      const result = graphWorkflowHaltReasonSchema.safeParse(variant);
      expect(result.success).toBe(false);
    }
  });
});

describe("workflowCollaborationStatusSchema", () => {
  it("accepts every named status", () => {
    for (const status of [
      "converged",
      "rounds_exhausted",
      "requires_user_input",
      "objective_disagreement",
    ] as const) {
      expect(workflowCollaborationStatusSchema.safeParse(status).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown statuses", () => {
    expect(workflowCollaborationStatusSchema.safeParse("unknown").success).toBe(
      false,
    );
  });
});

describe("workflowCollaborationResultSchema", () => {
  it("accepts a converged result with a finalAnswer and no openConflicts", () => {
    const result = workflowCollaborationResultSchema.safeParse({
      status: "converged",
      finalAnswer: "Final decision: use Postgres.",
      openConflicts: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.finalAnswer).toBe("Final decision: use Postgres.");
      expect(result.data.openConflicts).toEqual([]);
    }
  });

  it("defaults openConflicts to an empty array on converged results", () => {
    const result = workflowCollaborationResultSchema.safeParse({
      status: "converged",
      finalAnswer: "Done.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.openConflicts).toEqual([]);
    }
  });

  it("rejects converged results with a null finalAnswer", () => {
    const result = workflowCollaborationResultSchema.safeParse({
      status: "converged",
      finalAnswer: null,
      openConflicts: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an objective_disagreement result with a populated openConflicts list", () => {
    const result = workflowCollaborationResultSchema.safeParse({
      status: "objective_disagreement",
      finalAnswer: null,
      openConflicts: [
        {
          rejectingAgent: "agent_two",
          disputedPoint: "Choice of database technology",
          severity: "blocking",
          category: "objective",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.openConflicts).toHaveLength(1);
      expect(result.data.openConflicts[0]?.rejectingAgent).toBe("agent_two");
    }
  });

  it("rejects a non-converged result with no openConflicts", () => {
    for (const status of [
      "rounds_exhausted",
      "requires_user_input",
      "objective_disagreement",
    ] as const) {
      const result = workflowCollaborationResultSchema.safeParse({
        status,
        finalAnswer: null,
        openConflicts: [],
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an openConflict with an unknown severity", () => {
    const result = workflowCollaborationResultSchema.safeParse({
      status: "objective_disagreement",
      finalAnswer: null,
      openConflicts: [
        {
          rejectingAgent: "agent_one",
          disputedPoint: "Disputed thing",
          severity: "nonsense",
          category: "objective",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an openConflict with a blank disputedPoint", () => {
    const result = workflowCollaborationResultSchema.safeParse({
      status: "objective_disagreement",
      finalAnswer: null,
      openConflicts: [
        {
          rejectingAgent: "agent_one",
          disputedPoint: "",
          severity: "blocking",
          category: "objective",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowExecutionContextStateSchema parallel-execution fields", () => {
  const baseContextState = {
    contextId: "ctx-1",
    status: "ready",
    totalTaskCount: 1,
  };

  it("defaults the new parallel-execution fields when omitted", () => {
    const result =
      graphWorkflowExecutionContextStateSchema.safeParse(baseContextState);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.worktreePath).toBeNull();
      expect(result.data.branchName).toBeNull();
      expect(result.data.isolation).toBe("session");
      expect(result.data.batchId).toBeNull();
      expect(result.data.mergeStatus).toBe("not-applicable");
      expect(result.data.cleanupStatus).toBe("not-applicable");
      expect(result.data.lastMergeError).toBeNull();
    }
  });

  it("parses fully populated parallel-execution fields", () => {
    const result = graphWorkflowExecutionContextStateSchema.safeParse({
      ...baseContextState,
      status: "running",
      worktreePath: "/tmp/.worktrees/session.ctx-1",
      branchName: "csm/session-ctx-1",
      isolation: "worktree",
      batchId: "batch-uuid-1",
      mergeStatus: "in-progress",
      cleanupStatus: "pending",
      lastMergeError: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.worktreePath).toBe("/tmp/.worktrees/session.ctx-1");
      expect(result.data.branchName).toBe("csm/session-ctx-1");
      expect(result.data.isolation).toBe("worktree");
      expect(result.data.batchId).toBe("batch-uuid-1");
      expect(result.data.mergeStatus).toBe("in-progress");
      expect(result.data.cleanupStatus).toBe("pending");
    }
  });

  it("accepts every mergeStatus enum value", () => {
    for (const mergeStatus of [
      "not-applicable",
      "pending",
      "in-progress",
      "merged-success",
      "merged-failed",
      "conflicts",
    ] as const) {
      const result = graphWorkflowExecutionContextStateSchema.safeParse({
        ...baseContextState,
        mergeStatus,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts every cleanupStatus enum value", () => {
    for (const cleanupStatus of [
      "not-applicable",
      "pending",
      "removed",
      "failed",
    ] as const) {
      const result = graphWorkflowExecutionContextStateSchema.safeParse({
        ...baseContextState,
        cleanupStatus,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown isolation values", () => {
    const result = graphWorkflowExecutionContextStateSchema.safeParse({
      ...baseContextState,
      isolation: "shared",
    });
    expect(result.success).toBe(false);
  });

  it("populates lastMergeError when a merge failed", () => {
    const result = graphWorkflowExecutionContextStateSchema.safeParse({
      ...baseContextState,
      mergeStatus: "merged-failed",
      lastMergeError: "Conflict in src/lib/foo.ts",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastMergeError).toBe("Conflict in src/lib/foo.ts");
    }
  });
});

describe("graphWorkflowExecutionSchema parallel-execution fields", () => {
  const minimalExecution = {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [],
      tasks: [],
      edges: [],
    },
    charter: makeTestCharter(),
    status: "running" as const,
    startedAt: timestamp,
  };

  it("defaults activeContextIds to an empty array when omitted", () => {
    const result = graphWorkflowExecutionSchema.safeParse(minimalExecution);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeContextIds).toEqual([]);
    }
  });

  it("defaults pendingHaltReason to null when omitted", () => {
    const result = graphWorkflowExecutionSchema.safeParse(minimalExecution);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingHaltReason).toBeNull();
    }
  });

  it("defaults collaboration wait-state fields to empty maps when omitted", () => {
    const result = graphWorkflowExecutionSchema.safeParse(minimalExecution);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingCollaborations).toEqual({});
      expect(result.data.collaborationContinuations).toEqual({});
    }
  });

  it("round-trips pending collaboration and continuation state", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      ...minimalExecution,
      pendingCollaborations: {
        "ctx-1": {
          workflowId: "collab-1",
          contextId: "ctx-1",
          conversationId: "conv-1",
          parentImplementerTurnId: "impl-turn-1",
          brief: "Choose the data-store strategy.",
          startedAt: timestamp,
        },
      },
      collaborationContinuations: {
        "ctx-1": [
          {
            workflowId: "collab-0",
            brief: "Choose the queue strategy.",
            result: {
              status: "converged",
              finalAnswer: "Use the existing job queue.",
              openConflicts: [],
            },
            roundsConsumed: 1,
            completedAt: timestamp,
            deliveredAt: null,
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingCollaborations["ctx-1"]?.workflowId).toBe(
        "collab-1",
      );
      expect(
        result.data.collaborationContinuations["ctx-1"]?.[0]?.result
          .finalAnswer,
      ).toBe("Use the existing job queue.");
    }
  });

  it("parses activeContextIds as a string array", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      ...minimalExecution,
      activeContextIds: ["ctx-1", "ctx-2"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeContextIds).toEqual(["ctx-1", "ctx-2"]);
    }
  });

  it("persists pendingHaltReason as a merge_failure variant", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      ...minimalExecution,
      pendingHaltReason: {
        type: "merge_failure",
        contextId: "ctx-2",
        message: "Auto-resolution exhausted",
        conflictFiles: ["src/lib/foo.ts"],
      },
    });
    expect(result.success).toBe(true);
    if (
      result.success &&
      result.data.pendingHaltReason?.type === "merge_failure"
    ) {
      expect(result.data.pendingHaltReason.contextId).toBe("ctx-2");
      expect(result.data.pendingHaltReason.conflictFiles).toEqual([
        "src/lib/foo.ts",
      ]);
    }
  });

  it("round-trips a fully populated execution with parallel fields", () => {
    const fullExecution = {
      id: "exec-1",
      seedDefinitionId: "def-1",
      seedDefinitionRevision: 1,
      workingDefinition: {
        schemaVersion: 1,
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      charter: makeTestCharter(),
      status: "running" as const,
      activeContextIds: ["ctx-1", "ctx-2"],
      pendingHaltReason: {
        type: "merge_failure" as const,
        contextId: "ctx-2",
        message: "Conflict resolution failed after 3 attempts",
        conflictFiles: ["src/lib/foo.ts", "src/lib/bar.ts"],
      },
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running" as const,
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: "/tmp/.worktrees/session.ctx-1",
          branchName: "csm/session-ctx-1",
          isolation: "worktree" as const,
          batchId: "batch-1",
          mergeStatus: "in-progress" as const,
          cleanupStatus: "pending" as const,
          lastMergeError: null,
        },
        "ctx-2": {
          contextId: "ctx-2",
          status: "running" as const,
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: "/tmp/.worktrees/session.ctx-2",
          branchName: "csm/session-ctx-2",
          isolation: "worktree" as const,
          batchId: "batch-1",
          mergeStatus: "merged-failed" as const,
          cleanupStatus: "not-applicable" as const,
          lastMergeError: "Conflict in src/lib/foo.ts",
        },
      },
      taskStates: {},
      sharedDocuments: [],
      laneStates: {},
      machineSnapshot: null,
      history: [],
      startedAt: timestamp,
      completedAt: null,
      haltReason: null,
    };

    const parsed = graphWorkflowExecutionSchema.parse(fullExecution);
    const reparsed = graphWorkflowExecutionSchema.parse(parsed);
    expect(reparsed.activeContextIds).toEqual(["ctx-1", "ctx-2"]);
    expect(reparsed.pendingHaltReason?.type).toBe("merge_failure");
    if (reparsed.pendingHaltReason?.type === "merge_failure") {
      expect(reparsed.pendingHaltReason.conflictFiles).toEqual([
        "src/lib/foo.ts",
        "src/lib/bar.ts",
      ]);
    }
    expect(reparsed.contextStates["ctx-1"]?.isolation).toBe("worktree");
    expect(reparsed.contextStates["ctx-2"]?.mergeStatus).toBe("merged-failed");
    expect(reparsed.contextStates["ctx-2"]?.lastMergeError).toBe(
      "Conflict in src/lib/foo.ts",
    );
  });
});

describe("graphWorkflowExecutionLaneStateSchema", () => {
  const baseValidLane = {
    laneId: "lane-session",
    kind: "session" as const,
    status: "active" as const,
    branchName: "csm/session-1",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  it("parses a minimal valid session lane and defaults audit/recovery fields", () => {
    const result =
      graphWorkflowExecutionLaneStateSchema.safeParse(baseValidLane);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("session");
      expect(result.data.worktreePath).toBeNull();
      expect(result.data.includedContextIds).toEqual([]);
      expect(result.data.lastCommittingContextId).toBeNull();
      expect(result.data.commitSnapshots).toEqual([]);
    }
  });

  it("parses a fully populated worktree lane with commit snapshots", () => {
    const result = graphWorkflowExecutionLaneStateSchema.safeParse({
      laneId: "lane-ctx-1",
      kind: "worktree",
      status: "active",
      worktreePath: "/tmp/.worktrees/ctx-1",
      branchName: "csm/session-1-ctx-1",
      includedContextIds: ["ctx-1"],
      lastCommittingContextId: "ctx-1",
      commitSnapshots: [
        {
          contextId: "ctx-1",
          sha: "abc1234",
          committedAt: timestamp,
        },
        {
          contextId: "ctx-1",
          sha: "def5678",
          committedAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("worktree");
      expect(result.data.worktreePath).toBe("/tmp/.worktrees/ctx-1");
      expect(result.data.commitSnapshots).toHaveLength(2);
      expect(result.data.commitSnapshots[1]?.sha).toBe("def5678");
      expect(result.data.lastCommittingContextId).toBe("ctx-1");
    }
  });

  it("accepts every lane status enum value", () => {
    for (const status of ["pending", "active", "merged", "halted"] as const) {
      const result = graphWorkflowExecutionLaneStateSchema.safeParse({
        ...baseValidLane,
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown lane kind", () => {
    const result = graphWorkflowExecutionLaneStateSchema.safeParse({
      ...baseValidLane,
      kind: "shared",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown lane status", () => {
    const result = graphWorkflowExecutionLaneStateSchema.safeParse({
      ...baseValidLane,
      status: "queued",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a lane with a blank branch name", () => {
    const result = graphWorkflowExecutionLaneStateSchema.safeParse({
      ...baseValidLane,
      branchName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a commit snapshot missing the sha", () => {
    const result = graphWorkflowExecutionLaneStateSchema.safeParse({
      ...baseValidLane,
      commitSnapshots: [
        {
          contextId: "ctx-1",
          committedAt: timestamp,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a lane missing required laneId", () => {
    const { laneId: _omit, ...withoutLaneId } = baseValidLane;
    const result =
      graphWorkflowExecutionLaneStateSchema.safeParse(withoutLaneId);
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowExecutionJoinStateSchema", () => {
  const baseValidJoin = {
    joinId: "join-1",
    kind: "context_merge" as const,
    contextId: "ctx-2",
    targetLaneId: "lane-session",
    sourceLaneIds: ["lane-ctx-2"],
    status: "pending" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  it("parses a minimal valid context_merge join with defaults", () => {
    const result =
      graphWorkflowExecutionJoinStateSchema.safeParse(baseValidJoin);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("context_merge");
      expect(result.data.errorMessage).toBeNull();
      expect(result.data.conflicts).toBeNull();
      expect(result.data.completedAt).toBeNull();
      expect(result.data.contextId).toBe("ctx-2");
    }
  });

  it("parses a final_publish join state with multiple source lanes", () => {
    const result = graphWorkflowExecutionJoinStateSchema.safeParse({
      joinId: "join-final",
      kind: "final_publish",
      contextId: null,
      targetLaneId: "lane-session",
      sourceLaneIds: ["lane-ctx-1", "lane-ctx-2"],
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("final_publish");
      expect(result.data.contextId).toBeNull();
      expect(result.data.sourceLaneIds).toEqual(["lane-ctx-1", "lane-ctx-2"]);
    }
  });

  it("captures conflicts and error details when a join fails", () => {
    const result = graphWorkflowExecutionJoinStateSchema.safeParse({
      ...baseValidJoin,
      status: "conflicts",
      errorMessage: "Automatic merge failed",
      conflicts: {
        files: ["src/lib/foo.ts", "src/lib/bar.ts"],
        message: "Conflicts in two files",
      },
      completedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("conflicts");
      expect(result.data.conflicts?.files).toEqual([
        "src/lib/foo.ts",
        "src/lib/bar.ts",
      ]);
      expect(result.data.errorMessage).toBe("Automatic merge failed");
    }
  });

  it("accepts every join status enum value", () => {
    for (const status of [
      "pending",
      "running",
      "succeeded",
      "failed",
      "conflicts",
    ] as const) {
      const result = graphWorkflowExecutionJoinStateSchema.safeParse({
        ...baseValidJoin,
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown join kind", () => {
    const result = graphWorkflowExecutionJoinStateSchema.safeParse({
      ...baseValidJoin,
      kind: "rebase",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a join with an empty sourceLaneIds list", () => {
    const result = graphWorkflowExecutionJoinStateSchema.safeParse({
      ...baseValidJoin,
      sourceLaneIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a join missing the target lane id", () => {
    const { targetLaneId: _omit, ...withoutTarget } = baseValidJoin;
    const result =
      graphWorkflowExecutionJoinStateSchema.safeParse(withoutTarget);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown join status", () => {
    const result = graphWorkflowExecutionJoinStateSchema.safeParse({
      ...baseValidJoin,
      status: "queued",
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowExecutionContextStateSchema lane/join references", () => {
  const baseContextState = {
    contextId: "ctx-1",
    status: "ready" as const,
    totalTaskCount: 1,
  };

  it("defaults laneId and joinId to null for legacy context state", () => {
    const result =
      graphWorkflowExecutionContextStateSchema.safeParse(baseContextState);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.laneId).toBeNull();
      expect(result.data.joinId).toBeNull();
    }
  });

  it("parses populated laneId and joinId references", () => {
    const result = graphWorkflowExecutionContextStateSchema.safeParse({
      ...baseContextState,
      laneId: "lane-ctx-1",
      joinId: "join-ctx-1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.laneId).toBe("lane-ctx-1");
      expect(result.data.joinId).toBe("join-ctx-1");
    }
  });

  it("rejects a blank laneId reference", () => {
    const result = graphWorkflowExecutionContextStateSchema.safeParse({
      ...baseContextState,
      laneId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowContextStatusSchema lifecycle constraints", () => {
  it("accepts the five permitted lifecycle statuses", () => {
    for (const status of [
      "pending",
      "ready",
      "running",
      "completed",
      "halted",
    ] as const) {
      const result = graphWorkflowContextStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }
  });

  it("rejects 'queued' as a context lifecycle status", () => {
    const result = graphWorkflowContextStatusSchema.safeParse("queued");
    expect(result.success).toBe(false);
  });

  it("rejects 'waiting' to confirm wait state is derived, not persisted", () => {
    const result = graphWorkflowContextStatusSchema.safeParse("waiting");
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowExecutionSchema lane/join maps", () => {
  const minimalExecution = {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [],
      tasks: [],
      edges: [],
    },
    charter: makeTestCharter(),
    status: "running" as const,
    startedAt: timestamp,
  };

  it("defaults executionLanes and joins to empty maps for legacy executions", () => {
    const result = graphWorkflowExecutionSchema.safeParse(minimalExecution);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executionLanes).toEqual({});
      expect(result.data.joins).toEqual({});
    }
  });

  it("rejects an unrecognised top-level field via the schema's strict context lifecycle (queued not allowed in context state)", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      ...minimalExecution,
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "queued",
          totalTaskCount: 1,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("persists executionLanes and joins keyed by id with cross-references", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      ...minimalExecution,
      executionLanes: {
        "lane-session": {
          laneId: "lane-session",
          kind: "session",
          status: "active",
          branchName: "csm/session-1",
          includedContextIds: ["ctx-1"],
          lastCommittingContextId: "ctx-1",
          commitSnapshots: [
            {
              contextId: "ctx-1",
              sha: "abc1234",
              committedAt: timestamp,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        "lane-ctx-2": {
          laneId: "lane-ctx-2",
          kind: "worktree",
          status: "pending",
          worktreePath: "/tmp/.worktrees/ctx-2",
          branchName: "csm/session-1-ctx-2",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      joins: {
        "join-final": {
          joinId: "join-final",
          kind: "final_publish",
          contextId: null,
          targetLaneId: "lane-session",
          sourceLaneIds: ["lane-session", "lane-ctx-2"],
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "completed",
          totalTaskCount: 1,
          laneId: "lane-session",
          joinId: null,
        },
        "ctx-2": {
          contextId: "ctx-2",
          status: "ready",
          totalTaskCount: 1,
          laneId: "lane-ctx-2",
          joinId: "join-final",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.executionLanes).sort()).toEqual([
        "lane-ctx-2",
        "lane-session",
      ]);
      expect(result.data.joins["join-final"]?.kind).toBe("final_publish");
      expect(result.data.contextStates["ctx-2"]?.joinId).toBe("join-final");
      expect(result.data.contextStates["ctx-1"]?.laneId).toBe("lane-session");
    }
  });

  it("does not expose a waitReason field — wait state must be derived", () => {
    const parsed = graphWorkflowExecutionSchema.parse(minimalExecution);
    expect(parsed).not.toHaveProperty("waitReason");
    const ctxState = graphWorkflowExecutionContextStateSchema.parse({
      contextId: "ctx-1",
      status: "ready",
      totalTaskCount: 1,
    });
    expect(ctxState).not.toHaveProperty("waitReason");
  });
});

describe("graphWorkflowContextStatusSchema awaiting_approval", () => {
  it("accepts awaiting_approval", () => {
    const result =
      graphWorkflowContextStatusSchema.safeParse("awaiting_approval");
    expect(result.success).toBe(true);
  });
});

describe("graphWorkflowHumanApprovalGateConfigSchema", () => {
  it("defaults enabled to false when the block is passed empty", () => {
    const result = graphWorkflowHumanApprovalGateConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it("accepts { enabled: true }", () => {
    const result = graphWorkflowHumanApprovalGateConfigSchema.safeParse({
      enabled: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it("rejects non-boolean enabled values", () => {
    const result = graphWorkflowHumanApprovalGateConfigSchema.safeParse({
      enabled: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("humanApprovalGate cascade fields", () => {
  it("accepts a workflow-level override that sets humanApprovalGate", () => {
    const result = workflowConfigOverrideSchema.safeParse({
      humanApprovalGate: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.humanApprovalGate?.enabled).toBe(true);
    }
  });

  it("accepts a workflow-level override that omits humanApprovalGate (inherits)", () => {
    const result = workflowConfigOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.humanApprovalGate).toBeUndefined();
    }
  });

  it("accepts a context definition that sets humanApprovalGate", () => {
    const result = graphWorkflowExecutionContextDefinitionSchema.safeParse({
      id: "ctx-1",
      title: "Context",
      acceptanceCriteria: "AC",
      humanApprovalGate: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.humanApprovalGate?.enabled).toBe(true);
    }
  });

  it("accepts a context definition that omits humanApprovalGate (inherits)", () => {
    const result = graphWorkflowExecutionContextDefinitionSchema.safeParse({
      id: "ctx-1",
      title: "Context",
      acceptanceCriteria: "AC",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.humanApprovalGate).toBeUndefined();
    }
  });

  it("rejects workflowDefaults missing the humanApprovalGate block", () => {
    const defaults = createWorkflowDefaults();
    const { humanApprovalGate: _removed, ...withoutGate } = defaults;
    const result = workflowDefaultsSchema.safeParse(withoutGate);
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowApprovalDecisionSchema", () => {
  it("parses an approved decision", () => {
    const result = graphWorkflowApprovalDecisionSchema.safeParse({
      type: "approved",
      decidedAt: timestamp,
    });
    expect(result.success).toBe(true);
  });

  it("parses a rejected decision with a message", () => {
    const result = graphWorkflowApprovalDecisionSchema.safeParse({
      type: "rejected",
      message: "Please add tests for the edge cases.",
      decidedAt: timestamp,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a rejected decision with an empty message", () => {
    const result = graphWorkflowApprovalDecisionSchema.safeParse({
      type: "rejected",
      message: "   ",
      decidedAt: timestamp,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown decision type", () => {
    const result = graphWorkflowApprovalDecisionSchema.safeParse({
      type: "unknown",
      decidedAt: timestamp,
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowPendingApprovalSchema", () => {
  it("defaults decision to null", () => {
    const result = graphWorkflowPendingApprovalSchema.safeParse({
      conversationId: "conversation-1",
      requestedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decision).toBeNull();
    }
  });

  it("parses with a recorded rejection decision", () => {
    const result = graphWorkflowPendingApprovalSchema.safeParse({
      conversationId: "conversation-1",
      requestedAt: timestamp,
      decision: {
        type: "rejected",
        message: "Fix the failing edge case.",
        decidedAt: timestamp,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty conversationId", () => {
    const result = graphWorkflowPendingApprovalSchema.safeParse({
      conversationId: "",
      requestedAt: timestamp,
    });
    expect(result.success).toBe(false);
  });
});

describe("context state pendingApproval", () => {
  it("defaults pendingApproval to null on legacy payloads", () => {
    const result = graphWorkflowExecutionContextStateSchema.safeParse({
      contextId: "ctx-1",
      status: "running",
      totalTaskCount: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingApproval).toBeNull();
    }
  });

  it("parses an awaiting_approval context with a pending approval record", () => {
    const result = graphWorkflowExecutionContextStateSchema.safeParse({
      contextId: "ctx-1",
      status: "awaiting_approval",
      totalTaskCount: 1,
      pendingApproval: {
        conversationId: "conversation-1",
        requestedAt: timestamp,
        decision: null,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("awaiting_approval");
      expect(result.data.pendingApproval?.conversationId).toBe(
        "conversation-1",
      );
    }
  });
});

describe("approval gate SSE event schemas", () => {
  it("parses graph-workflow-approval-pending events", () => {
    const event = graphWorkflowApprovalPendingEventSchema.safeParse({
      type: "graph-workflow-approval-pending",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-1",
      contextTitle: "Plan",
      conversationId: "conversation-1",
      requestedAt: timestamp,
    });
    expect(event.success).toBe(true);

    const nullTitle = graphWorkflowApprovalPendingEventSchema.safeParse({
      type: "graph-workflow-approval-pending",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-1",
      contextTitle: null,
      conversationId: "conversation-1",
      requestedAt: timestamp,
    });
    expect(nullTitle.success).toBe(true);
  });

  it("parses graph-workflow-approval-resolved events", () => {
    const approved = graphWorkflowApprovalResolvedEventSchema.safeParse({
      type: "graph-workflow-approval-resolved",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-1",
      conversationId: "conversation-1",
      decision: "approved",
      message: null,
      decidedAt: timestamp,
    });
    expect(approved.success).toBe(true);

    const rejected = graphWorkflowApprovalResolvedEventSchema.safeParse({
      type: "graph-workflow-approval-resolved",
      projectName: "remote-ai-manager",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-1",
      conversationId: "conversation-1",
      decision: "rejected",
      message: "Needs more tests.",
      decidedAt: timestamp,
    });
    expect(rejected.success).toBe(true);
  });

  it("accepts approval events in the execution history event union", () => {
    const result = graphWorkflowExecutionEventSchema.safeParse({
      occurredAt: timestamp,
      event: {
        type: "graph-workflow-approval-pending",
        projectName: "remote-ai-manager",
        sessionName: "session-1",
        executionId: "execution-1",
        contextId: "context-1",
        contextTitle: "Plan",
        conversationId: "conversation-1",
        requestedAt: timestamp,
      },
    });
    expect(result.success).toBe(true);

    const resolved = graphWorkflowExecutionEventSchema.safeParse({
      occurredAt: timestamp,
      event: {
        type: "graph-workflow-approval-resolved",
        projectName: "remote-ai-manager",
        sessionName: "session-1",
        executionId: "execution-1",
        contextId: "context-1",
        conversationId: "conversation-1",
        decision: "approved",
        message: null,
        decidedAt: timestamp,
      },
    });
    expect(resolved.success).toBe(true);
  });
});
