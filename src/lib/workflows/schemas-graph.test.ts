import { describe, expect, it } from "vitest";
import { getCodexReasoningLevelsForModel } from "@/lib/agent-backends/schemas";
import {
  graphWorkflowExecutionEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowStatusEventSchema,
  graphWorkflowValidationResultEventSchema,
} from "@/lib/workflow-graph/event-schemas";
import {
  graphWorkflowAgentSessionStateSchema,
  graphWorkflowApprovalDecisionSchema,
  graphWorkflowExecutionContextStateSchema,
  graphWorkflowExecutionJoinStateSchema,
  graphWorkflowExecutionLaneStateSchema,
  graphWorkflowExecutionSchema,
  graphWorkflowHaltReasonSchema,
  graphWorkflowPendingApprovalSchema,
  graphWorkflowValidationReviewArtifactSchema,
  graphWorkflowValidationSessionRefSchema,
  resetExecutionContextRequestSchema,
} from "@/lib/workflow-graph/schemas";
import {
  workflowCollaborationResultSchema,
  workflowCollaborationStatusSchema,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowScriptValidatorConfigSchema,
} from "@/lib/workflow-graph/config-schemas";
import {
  graphWorkflowContextStatusSchema,
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowResolvedContextSchema,
  graphWorkflowSharedDocumentEntrySchema,
  workflowBlockingValidatorResultSchema,
  workflowConfigOverrideSchema,
  workflowDefinitionRecordSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflow-graph/definition-schemas";
import {
  workflowLiveEditOperationSchema,
  workflowLiveEditRequestSchema,
} from "@/lib/workflows/edit-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  globalConfigSchema,
  workflowDefaultsSchema,
} from "@/lib/config/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { makeProfileSnapshot } from "@/lib/workflow-graph/test-fixtures";

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
        placement: { lane: "plan", mode: "full" },
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
          },
        },
        mutability: {
          allowAgentTaskAdd: true,
        },
        circuitBreaker: {
          consecutiveFailureThreshold: 3,
        },
        iterationPolicy: {
          maxIterations: 5,
        },
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              agent: {
                backend: "claude",
                modelSelection: {
                  modelId: "sonnet",
                  parameters: { effort: "medium" },
                },
              },
            },
          ],
        },
      },
      {
        id: "context-2",
        title: "Implement",
        description: "Write the code",
        acceptanceCriteria: "Code compiles and tests pass.",
        placement: {
          lane: "implement",
          mode: "owned",
          ownedPaths: ["src/lib/workflows"],
        },
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "medium" },
            },
          },
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
        placement: { lane: "context-1", mode: "full" },
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          profileSnapshot: makeProfileSnapshot(),
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
          },
        },
        mutability: { allowAgentTaskAdd: true },
        circuitBreaker: { consecutiveFailureThreshold: 3 },
        iterationPolicy: {
          maxIterations: 5,
        },
        contextValidator: {
          enabled: true,
          assignments: [
            {
              id: "general",
              profile: { tier: "builtin", id: "general-reviewer" },
              profileSnapshot: makeProfileSnapshot(),
              agent: {
                backend: "claude",
                modelSelection: {
                  modelId: "sonnet",
                  parameters: { effort: "medium" },
                },
              },
            },
          ],
        },
      },
      {
        id: "context-2",
        title: "Implement",
        description: "Write the code",
        acceptanceCriteria: "Code compiles and tests pass.",
        placement: { lane: "context-2", mode: "full" },
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          profileSnapshot: makeProfileSnapshot(),
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "medium" },
            },
          },
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: { consecutiveFailureThreshold: 2 },
        iterationPolicy: { maxIterations: 3 },
        contextValidator: { enabled: false, assignments: [] },
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
  it("parses an active execution with working definition, task state, and shared documents", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "execution-1",
      origin: {
        kind: "template",
        definitionId: "workflow-1",
        definitionRevision: 4,
        tier: "project",
      },
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
          consecutiveCandidateMismatchCount: 0,
        },
        "context-2": {
          contextId: "context-2",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
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
    }
  });

  it("defaults loopEpoch to 0 for execution rows written before the field existed", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "execution-legacy",
      origin: {
        kind: "template",
        definitionId: "workflow-1",
        definitionRevision: 1,
        tier: "project",
      },
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 1,
      workingDefinition: createResolvedDefinition(),
      charter: makeTestCharter(),
      status: "running",
      startedAt: timestamp,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loopEpoch).toBe(0);
    }
  });

  it("round-trips an explicit loopEpoch and rejects non-integer values", () => {
    const base = {
      id: "execution-epoch",
      origin: {
        kind: "template",
        definitionId: "workflow-1",
        definitionRevision: 1,
        tier: "project",
      },
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 1,
      workingDefinition: createResolvedDefinition(),
      charter: makeTestCharter(),
      status: "running",
      startedAt: timestamp,
    };

    const parsed = graphWorkflowExecutionSchema.safeParse({
      ...base,
      loopEpoch: 3,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loopEpoch).toBe(3);
    }

    expect(
      graphWorkflowExecutionSchema.safeParse({ ...base, loopEpoch: -1 })
        .success,
    ).toBe(false);
    expect(
      graphWorkflowExecutionSchema.safeParse({ ...base, loopEpoch: 1.5 })
        .success,
    ).toBe(false);
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

  it("rejects an execution snapshot that omits the charter", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "execution-no-charter",
      origin: {
        kind: "template",
        definitionId: "workflow-1",
        definitionRevision: 1,
        tier: "project",
      },
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 1,
      workingDefinition: createResolvedDefinition(),
      status: "pending",
      startedAt: timestamp,
    });

    expect(result.success).toBe(false);
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
});

describe("workflow graph validator and request schemas", () => {
  it("requires both verdict arrays and a taskId on each issue", () => {
    const issueResult = workflowBlockingValidatorResultSchema.parse({
      summary: "Needs fixes",
      issues: [
        {
          taskId: "task-1",
          title: "Missing coverage",
          description: "Add tests for the new graph workflow state fields.",
        },
      ],
      advisories: [],
    });

    expect(issueResult.issues[0]?.title).toBe("Missing coverage");
    expect(issueResult.issues[0]?.taskId).toBe("task-1");

    // A summary alone is not a verdict: both arrays are required by the
    // dispatched schema, so defaulting them here would let a validator that
    // never considered advisories read as one that found none.
    expect(
      workflowBlockingValidatorResultSchema.safeParse({
        summary: "Looks good",
      }).success,
    ).toBe(false);

    const missingTaskId = workflowBlockingValidatorResultSchema.safeParse({
      summary: "Needs fixes",
      issues: [
        {
          title: "Missing coverage",
          description: "Add tests for the new graph workflow state fields.",
        },
      ],
      advisories: [],
    });
    expect(missingTaskId.success).toBe(false);
  });

  it("carries per-issue instance paths and the refused payload on an output-schema result (R3.2)", () => {
    const parsed = graphWorkflowValidationResultEventSchema.parse({
      type: "graph-workflow-validation-result",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "context-1",
      validatorType: "context",
      kind: "output_schema",
      pass: false,
      summary: "Output rejected",
      issues: [
        {
          title: "/verdict",
          description: "not one of the allowed values",
          path: "/verdict",
        },
      ],
      rejectedOutput: '{ "verdict": "partial" }',
    });

    expect(parsed.kind).toBe("output_schema");
    expect(parsed.issues[0]?.path).toBe("/verdict");
    expect(parsed.rejectedOutput).toBe('{ "verdict": "partial" }');
  });

  it("carries the structured-output gate's repair spend and budget on an output-schema result (R3.2)", () => {
    const parsed = graphWorkflowValidationResultEventSchema.parse({
      type: "graph-workflow-validation-result",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "context-1",
      validatorType: "context",
      kind: "output_schema",
      pass: false,
      summary: "Output rejected",
      issues: [{ title: "/verdict", description: "bad", path: "/verdict" }],
      rejectedOutput: "{}",
      gateRepairAttempts: 1,
      gateRepairBudget: 1,
    });

    expect(parsed.gateRepairAttempts).toBe(1);
    expect(parsed.gateRepairBudget).toBe(1);
  });

  it("defaults a result written before the output-schema discriminator to the validator kind, with no path and no payload (R3.2)", () => {
    const parsed = graphWorkflowValidationResultEventSchema.parse({
      type: "graph-workflow-validation-result",
      projectName: "proj",
      sessionName: "sess",
      executionId: "exec-1",
      contextId: "context-1",
      validatorType: "context",
      pass: false,
      summary: "Criterion 1 unmet",
      issues: [{ title: "Missing job reference", description: "prose" }],
    });

    expect(parsed.kind).toBe("context_validation");
    expect(parsed.issues[0]?.path).toBeUndefined();
    expect(parsed.rejectedOutput).toBeNull();
    expect(parsed.gateRepairAttempts).toBeNull();
    expect(parsed.gateRepairBudget).toBeNull();
  });

  it("rejects an empty instance path rather than recording a locator that points nowhere (R3.2)", () => {
    expect(
      graphWorkflowValidationResultEventSchema.safeParse({
        type: "graph-workflow-validation-result",
        projectName: "proj",
        sessionName: "sess",
        executionId: "exec-1",
        contextId: "context-1",
        validatorType: "context",
        kind: "output_schema",
        pass: false,
        summary: "Output rejected",
        issues: [{ title: "/verdict", description: "bad", path: "" }],
      }).success,
    ).toBe(false);
  });

  it("names the lane conversation on a session ref and a review artifact alike", () => {
    expect(
      graphWorkflowValidationSessionRefSchema.parse({
        backend: "claude",
        ref: "conversation-1",
        lane: "context_validator",
        assignmentId: "general",
        workflowConversationId: "conversation-1",
      }),
    ).toEqual({
      backend: "claude",
      ref: "conversation-1",
      lane: "context_validator",
      assignmentId: "general",
      workflowConversationId: "conversation-1",
    });
    expect(
      graphWorkflowValidationReviewArtifactSchema.parse({
        backend: "codex",
        kind: "conversation",
        ref: "conversation-1",
      }),
    ).toEqual({
      backend: "codex",
      kind: "conversation",
      ref: "conversation-1",
      usage: null,
    });
  });

  it("refuses the retired response artifact and a session ref without a lane", () => {
    expect(
      graphWorkflowValidationReviewArtifactSchema.safeParse({
        backend: "codex",
        kind: "response",
        ref: "thread-1",
        response: "Reviewed",
        usage: null,
      }).success,
    ).toBe(false);
    expect(
      graphWorkflowValidationSessionRefSchema.safeParse({
        backend: "claude",
        ref: "backend-session-1",
      }).success,
    ).toBe(false);
  });

  it("accepts a third backend without projecting it onto a built-in provider", () => {
    expect(
      graphWorkflowValidationReviewArtifactSchema.parse({
        backend: "testfake",
        kind: "conversation",
        ref: "testfake-conversation",
        usage: { costUsd: 0.5, apiTurns: 3 },
      }),
    ).toEqual({
      backend: "testfake",
      kind: "conversation",
      ref: "testfake-conversation",
      usage: { costUsd: 0.5, apiTurns: 3 },
    });
  });
});

describe("workflowLiveEditOperationSchema", () => {
  const resolvedCollaboration = {
    secondAgent: {
      value: {
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
      source: "global" as const,
    },
    negotiationRounds: { value: 3, source: "global" as const },
    autonomousResolutionThreshold: {
      value: "minor" as const,
      source: "global" as const,
    },
  };

  it("parses every non-structural op shape with concrete resolved config", () => {
    const ops = [
      {
        type: "update-context",
        contextId: "impl",
        title: "Build it",
        description: null,
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
          },
        },
        contextValidator: { enabled: false, assignments: [] },
        scriptValidator: { commands: ["pre-merge"] },
        humanApprovalGate: { enabled: true },
        askUserQuestions: { enabled: false },
        iterationPolicy: { maxIterations: 12 },
        circuitBreaker: { consecutiveFailureThreshold: 2 },
        mutability: { allowAgentTaskAdd: true },
        collaboration: resolvedCollaboration,
      },
      {
        type: "add-task",
        contextId: "impl",
        title: "Add tests",
        instructions: "Cover the new behavior.",
        position: { at: "end" },
      },
      {
        type: "update-task",
        taskId: "impl-1",
        instructions: "Revised instructions.",
      },
      { type: "remove-task", taskId: "impl-2" },
      {
        type: "move-task",
        taskId: "impl-3",
        targetContextId: "verify",
        position: { after: "verify-1" },
      },
      {
        type: "reorder-tasks",
        contextId: "impl",
        orderedTaskIds: ["impl-1", "impl-3"],
      },
    ];
    for (const op of ops) {
      const result = workflowLiveEditOperationSchema.safeParse(op);
      expect(result.success, `${op.type} should parse`).toBe(true);
    }
  });

  it("parses every structural op shape", () => {
    const ops = [
      {
        type: "add-context",
        id: "docs",
        title: "Document",
        acceptanceCriteria: "Docs written",
        configFromContextId: "impl",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "high", fast: "false" },
            },
          },
        },
      },
      { type: "remove-context", contextId: "docs", deleteTasks: true },
      { type: "add-edge", sourceContextId: "impl", targetContextId: "docs" },
      { type: "remove-edge", sourceContextId: "impl", targetContextId: "docs" },
    ];
    for (const op of ops) {
      const result = workflowLiveEditOperationSchema.safeParse(op);
      expect(result.success, `${op.type} should parse`).toBe(true);
    }
  });

  it("rejects an update-context with no editable field present", () => {
    const result = workflowLiveEditOperationSchema.safeParse({
      type: "update-context",
      contextId: "impl",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an update-task with no field to change", () => {
    const result = workflowLiveEditOperationSchema.safeParse({
      type: "update-task",
      taskId: "impl-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a move-task missing the required targetContextId", () => {
    const result = workflowLiveEditOperationSchema.safeParse({
      type: "move-task",
      taskId: "impl-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an add-context missing its id", () => {
    const result = workflowLiveEditOperationSchema.safeParse({
      type: "add-context",
      title: "Document",
      acceptanceCriteria: "Docs written",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown op type", () => {
    const result = workflowLiveEditOperationSchema.safeParse({
      type: "rename-context",
      contextId: "impl",
    });
    expect(result.success).toBe(false);
  });
});

describe("workflowLiveEditRequestSchema", () => {
  const validOp = { type: "remove-task", taskId: "impl-1" };

  it("parses a well-formed request envelope", () => {
    const result = workflowLiveEditRequestSchema.safeParse({
      executionId: "exec-7",
      baseLiveRevision: 4,
      source: "cli",
      dryRun: true,
      operations: [validOp],
    });
    expect(result.success).toBe(true);
  });

  it("rejects the server-derived lane-agent source (D15)", () => {
    const result = workflowLiveEditRequestSchema.safeParse({
      executionId: "exec-7",
      baseLiveRevision: 1,
      source: "lane-agent",
      operations: [validOp],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty operations array", () => {
    const result = workflowLiveEditRequestSchema.safeParse({
      executionId: "exec-7",
      baseLiveRevision: 1,
      source: "cli",
      operations: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a baseLiveRevision below 1", () => {
    const result = workflowLiveEditRequestSchema.safeParse({
      executionId: "exec-7",
      baseLiveRevision: 0,
      source: "cli",
      operations: [validOp],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty executionId", () => {
    const result = workflowLiveEditRequestSchema.safeParse({
      executionId: "",
      baseLiveRevision: 1,
      source: "cli",
      operations: [validOp],
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
});

function createWorkflowDefaults() {
  return {
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
    },
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        },
      ],
    },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    iterationPolicy: {
      maxIterations: 20,
    },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    mutability: { allowAgentTaskAdd: false },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    collaboration: {
      secondAgent: {
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
    agentValidation: {
      implementer: { mode: "all", except: [] },
      contextValidator: { mode: "only", commands: [] },
    },
    laneMergeValidation: {
      strategy: "final-only",
      commands: { mode: "project" },
    },
    memory: {
      implementer: { read: "ambient", contribute: "on" },
      validator: { read: "linked-only", contribute: "off" },
    },
  };
}

describe("workflowDefaultsSchema", () => {
  it("parses with every block specified", () => {
    const result = workflowDefaultsSchema.safeParse(createWorkflowDefaults());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextValidator.assignments).toHaveLength(1);
      expect(result.data.scriptValidator.commands).toEqual([]);
      expect(result.data.askUserQuestions.enabled).toBe(false);
      expect(result.data.collaboration.negotiationRounds).toBe(3);
      expect(result.data.memory.validator.read).toBe("linked-only");
    }
  });

  it("rejects workflowDefaults missing the askUserQuestions block", () => {
    const defaults = createWorkflowDefaults();
    const { askUserQuestions: _removed, ...withoutAskUserQuestions } = defaults;
    const result = workflowDefaultsSchema.safeParse(withoutAskUserQuestions);
    expect(result.success).toBe(false);
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
  it("defaults commands to an empty selection when the block is empty", () => {
    const result = graphWorkflowScriptValidatorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toEqual([]);
    }
  });

  it("rejects the removed enabled flag", () => {
    const result = graphWorkflowScriptValidatorConfigSchema.safeParse({
      enabled: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowResolvedContextSchema scriptValidator", () => {
  const base = {
    id: "ctx-1",
    title: "Context",
    acceptanceCriteria: "AC",
    placement: { lane: "ctx-1", mode: "full" },
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "medium" },
        },
      },
    },
    contextValidator: { enabled: false, assignments: [] },
    mutability: { allowAgentTaskAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20 },
  };

  it("defaults scriptValidator to an empty command selection when missing", () => {
    const result = graphWorkflowResolvedContextSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scriptValidator).toEqual({ commands: [] });
    }
  });
});

describe("execution context outputSchema (D2 R1)", () => {
  const authoredBase = {
    id: "ctx-1",
    title: "Context",
    acceptanceCriteria: "AC",
    placement: { lane: "ctx-1", mode: "full" },
  };

  // A nested object schema with an array and an enum: the persisted value is an
  // opaque JSON Schema document, so the round trip must preserve nesting and key
  // order-insensitive structure verbatim rather than a flattened summary.
  const OUTPUT_SCHEMA = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: { file: { type: "string" } },
          required: ["file"],
        },
      },
    },
    required: ["verdict"],
    additionalProperties: false,
  };

  it("accepts an authored context declaring outputSchema and preserves the document verbatim", () => {
    const result = graphWorkflowExecutionContextDefinitionSchema.safeParse({
      ...authoredBase,
      outputSchema: OUTPUT_SCHEMA,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputSchema).toEqual(OUTPUT_SCHEMA);
    }
  });

  it("rejects a non-object outputSchema at parse time", () => {
    expect(
      graphWorkflowExecutionContextDefinitionSchema.safeParse({
        ...authoredBase,
        outputSchema: "type: object",
      }).success,
    ).toBe(false);
    expect(
      graphWorkflowExecutionContextDefinitionSchema.safeParse({
        ...authoredBase,
        outputSchema: [{ type: "object" }],
      }).success,
    ).toBe(false);
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

  it("gives gpt-5.6-sol the max and ultra levels", () => {
    expect(getCodexReasoningLevelsForModel("gpt-5.6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("withholds max and ultra from gpt-5.6-terra and gpt-5.6-luna", () => {
    for (const model of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
      const levels = getCodexReasoningLevelsForModel(model);
      expect(levels).not.toContain("max");
      expect(levels).not.toContain("ultra");
    }
  });

  it("returns null for unknown models (all levels allowed)", () => {
    expect(getCodexReasoningLevelsForModel("unknown-model")).toBeNull();
  });
});

describe("globalConfigSchema workflowDefaults", () => {
  it("accepts config without workflowDefaults (backward compat)", () => {
    const result = globalConfigSchema.safeParse({
      baseDir: "/projects",
      ignorePatterns: [],
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
          timeoutMs: 3_600_000,
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "high", fast: "false" },
          },
          timeoutMs: null,
        },
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
          timeoutMs: null,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflowDefaults).toBeUndefined();
    }
  });
});

describe("graphWorkflowAgentSessionStateSchema", () => {
  it("parses a claude lane state with context metrics", () => {
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
      backend: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      workflowConversationId: "conv-123",
      metrics: { contextTokens: 50000, contextWindowMax: 200000 },
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metrics.contextTokens).toBe(50000);
      expect(result.data.metrics.contextWindowMax).toBe(200000);
      expect(result.data.workflowConversationId).toBe("conv-123");
    }
  });

  it("parses a codex validator lane keyed to its assignment", () => {
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
      backend: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      assignmentId: "general",
      assignmentFingerprint: "sha256:abc|advisory||codex|gpt-5.4|high|false",
      workflowConversationId: "conv-cc-123",
      staleSession: false,
      metrics: { lastTurnUsage: null },
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lane).toBe("context_validator");
      expect(result.data.assignmentId).toBe("general");
      expect(result.data.workflowConversationId).toBe("conv-cc-123");
    }
  });

  // Every graph lane is anchored to one durable CC conversation; a lane that
  // names none has no continuity handle at all.
  it("requires workflowConversationId", () => {
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
      backend: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      metrics: {},
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some(
        (issue) => issue.path[0] === "workflowConversationId",
      ),
    ).toBe(true);
  });

  it("drops the retired backend session ref from an older row", () => {
    const result = graphWorkflowAgentSessionStateSchema.safeParse({
      backend: "codex",
      lane: "context_validator",
      contextId: "ctx-1",
      workflowConversationId: "conv-cc-123",
      refKind: "backend",
      sessionRef: { backend: "codex", ref: "thread-abc" },
      metrics: {},
      lastUsedAt: timestamp,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("sessionRef");
      expect(result.data).not.toHaveProperty("refKind");
    }
  });
});

describe("graphWorkflowExecutionSchema laneStates", () => {
  it("defaults laneStates to empty object", () => {
    const result = graphWorkflowExecutionSchema.safeParse({
      id: "exec-1",
      origin: {
        kind: "template",
        definitionId: "def-1",
        definitionRevision: 1,
        tier: "project",
      },
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
      origin: {
        kind: "template",
        definitionId: "def-1",
        definitionRevision: 1,
        tier: "project",
      },
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
            backend: "claude",
            lane: "implementer",
            contextId: "ctx-1",
            workflowConversationId: "conv-123",
            metrics: { contextTokens: 80000, contextWindowMax: 200000 },
            lastUsedAt: timestamp,
          },
          context_validator: {
            backend: "codex",
            lane: "context_validator",
            contextId: "ctx-1",
            workflowConversationId: "conv-xyz",
            metrics: { lastTurnUsage: null },
            lastUsedAt: timestamp,
          },
        },
        "ctx-2": {
          implementer: {
            backend: "claude",
            lane: "implementer",
            contextId: "ctx-2",
            workflowConversationId: "conv-456",
            metrics: { contextTokens: 0, contextWindowMax: 200000 },
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
      origin: {
        kind: "template",
        definitionId: "def-1",
        definitionRevision: 1,
        tier: "project",
      },
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
          backend: "claude",
          lane: "implementer",
          contextId: "ctx-1",
          workflowConversationId: "conv-123",
          metrics: {},
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

  it("rejects a non-boolean preReset value", () => {
    const result = graphWorkflowExecutionEventSchema.safeParse({
      ...baseEvent,
      preReset: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("graphWorkflowHaltReasonSchema", () => {
  it("accepts an agent_turn_failed timeout halt reason", () => {
    const result = graphWorkflowHaltReasonSchema.safeParse({
      type: "agent_turn_failed",
      contextId: "ctx-1",
      engine: "claude",
      cause: "timeout",
      message: "Prompt execution timed out after 10800000ms",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "agent_turn_failed") {
      expect(result.data.cause).toBe("timeout");
      expect(result.data.message).toContain("10800000ms");
    }
  });

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
      message: "Stored script-validator configuration was incomplete",
    });
    expect(result.success).toBe(true);
    if (
      result.success &&
      result.data.type === "script_validator_missing_command"
    ) {
      expect(result.data.contextId).toBe("ctx-1");
      expect(result.data.message).toContain("incomplete");
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
    origin: {
      kind: "template",
      definitionId: "def-1",
      definitionRevision: 1,
      tier: "project",
    },
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

  it("round-trips a fully populated execution with parallel fields", () => {
    const fullExecution = {
      id: "exec-1",
      origin: {
        kind: "template",
        definitionId: "def-1",
        definitionRevision: 1,
        tier: "project",
      },
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
          consecutiveCandidateMismatchCount: 0,
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
          consecutiveCandidateMismatchCount: 0,
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

  // D4 R4: unlike `waiting`, a skip IS persisted — it is a settled routing
  // decision the engine must not re-derive after a restart.
  it("accepts 'skipped' as a persisted terminal status", () => {
    expect(graphWorkflowContextStatusSchema.safeParse("skipped").success).toBe(
      true,
    );
  });
});

describe("graphWorkflowExecutionSchema lane/join maps", () => {
  const minimalExecution = {
    id: "exec-1",
    origin: {
      kind: "template",
      definitionId: "def-1",
      definitionRevision: 1,
      tier: "project",
    },
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
      placement: { lane: "ctx-1", mode: "full" },
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
      placement: { lane: "ctx-1", mode: "full" },
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
