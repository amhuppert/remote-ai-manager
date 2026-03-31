import { describe, expect, it } from "vitest";
import {
  graphWorkflowExecutionSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowStatusEventSchema,
  sessionStateSchema,
  workflowAgentValidatorResultSchema,
  workflowDefinitionRecordSchema,
  workflowRuntimeEditRequestSchema,
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
          contextSoftLimitTokens: 120000,
          contextHardLimitTokens: 150000,
        },
        taskValidation: {
          enabled: true,
          autoCreateFixTasks: true,
          instructions: "Validate each completed task.",
          agent: {
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
        contextValidation: {
          agentValidator: {
            enabled: true,
            autoCreateFixTasks: true,
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
            validatorType: "context",
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
