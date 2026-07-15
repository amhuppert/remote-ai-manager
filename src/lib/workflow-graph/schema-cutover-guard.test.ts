import { describe, expect, it } from "vitest";
import {
  LegacyWorkflowSchemaError,
  assertDefinitionRecordSupported,
  assertExecutionSupported,
} from "./schema-cutover-guard";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

const timestamp = "2026-04-04T00:00:00.000Z";

function makeValidDefinitionRecord() {
  return {
    id: "wf-1",
    name: "My Workflow",
    description: "test",
    schemaVersion: 1,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    layout: {
      workflowId: "wf-1",
      contextPositions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    definition: {
      schemaVersion: 1,
      workflowConfig: {},
      charter: makeTestCharter(),
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          acceptanceCriteria: "All tasks complete",
          implementer: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "high",
          },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            continuity: { enabled: true },
          },
        },
      ],
      tasks: [],
      edges: [],
    },
  };
}

function makeValidExecution() {
  return {
    id: "exec-1",
    seedDefinitionId: "wf-1",
    seedDefinitionRevision: 1,
    status: "running",
    activeContextIds: ["ctx-1"],
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    machineSnapshot: null,
    history: [],
    startedAt: timestamp,
    completedAt: null,
    haltReason: null,
    charter: makeTestCharter(),
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          acceptanceCriteria: "All tasks complete",
          implementer: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "high",
          },
          contextValidator: null,
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            continuity: { enabled: true },
          },
        },
      ],
      tasks: [],
      edges: [],
    },
  };
}

describe("assertDefinitionRecordSupported", () => {
  it("accepts a valid definition record", () => {
    const record = makeValidDefinitionRecord();
    const result = assertDefinitionRecordSupported(record);
    expect(result.id).toBe("wf-1");
  });

  it("rejects a record with contextSoftLimitTokens", () => {
    const record = makeValidDefinitionRecord();
    (
      record.definition.executionContexts[0]!.iterationPolicy as Record<
        string,
        unknown
      >
    ).contextSoftLimitTokens = 100000;

    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("rejects a record with contextHardLimitTokens", () => {
    const record = makeValidDefinitionRecord();
    (
      record.definition.executionContexts[0]!.iterationPolicy as Record<
        string,
        unknown
      >
    ).contextHardLimitTokens = 150000;

    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("error message names the removed fields", () => {
    const record = makeValidDefinitionRecord();
    (
      record.definition.executionContexts[0]!.iterationPolicy as Record<
        string,
        unknown
      >
    ).contextSoftLimitTokens = 100000;

    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      /contextSoftLimitTokens/,
    );
    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      /contextHardLimitTokens/,
    );
  });

  it("error message instructs operator to recreate the workflow definition", () => {
    const record = makeValidDefinitionRecord();
    (
      record.definition.executionContexts[0]!.iterationPolicy as Record<
        string,
        unknown
      >
    ).contextSoftLimitTokens = 100000;

    expect(() => assertDefinitionRecordSupported(record)).toThrow(/recreate/i);
  });

  it("rejects a record with taskValidation", () => {
    const record = makeValidDefinitionRecord();
    (
      record.definition.executionContexts[0]! as Record<string, unknown>
    ).taskValidation = {
      type: "claude",
      enabled: true,
      acceptanceCriteria: "legacy",
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      continuity: { enabled: true },
    };

    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("rejects a record with a legacy context (agent + contextValidation old shape)", () => {
    const record = makeValidDefinitionRecord();
    const context = record.definition.executionContexts[0]! as Record<
      string,
      unknown
    >;
    delete context.implementer;
    context.agent = {
      backend: "claude",
      model: "opus",
      reasoningEffort: "high",
    };
    context.contextValidation = {
      type: "claude",
      enabled: true,
      agent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      continuity: { enabled: true },
    };

    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      LegacyWorkflowSchemaError,
    );
    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      /cascade refactor/,
    );
  });

  it("rejects a record whose validator carries acceptanceCriteria", () => {
    const record = makeValidDefinitionRecord();
    const context = record.definition.executionContexts[0]! as Record<
      string,
      unknown
    >;
    context.contextValidator = {
      kind: "use",
      value: {
        type: "claude",
        enabled: true,
        acceptanceCriteria: "legacy AC on validator",
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        continuity: { enabled: true },
      },
    };

    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("rejects a record whose context has implementer but no acceptanceCriteria", () => {
    const record = makeValidDefinitionRecord();
    const context = record.definition.executionContexts[0]! as Record<
      string,
      unknown
    >;
    delete context.acceptanceCriteria;

    expect(() => assertDefinitionRecordSupported(record)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });
});

describe("assertExecutionSupported", () => {
  it("accepts a valid execution", () => {
    const execution = makeValidExecution();
    const result = assertExecutionSupported(execution);
    expect(result.id).toBe("exec-1");
  });

  it("accepts an execution whose Claude lane carries limitEvaluation metrics_unavailable", () => {
    const execution = makeValidExecution();
    (execution as Record<string, unknown>).laneStates = {
      "ctx-1": {
        context_validator: {
          engine: "claude",
          lane: "context_validator",
          contextId: "ctx-1",
          sessionRef: {
            engine: "claude",
            lane: "context_validator",
            conversationId: "conv-1",
          },
          lastContextTokens: null,
          lastContextWindowMax: null,
          rotateBeforeNextTurn: false,
          limitEvaluation: "metrics_unavailable",
          lastUsedAt: timestamp,
        },
      },
    };

    const result = assertExecutionSupported(execution);
    const lane = result.laneStates["ctx-1"]?.["context_validator"];
    expect(lane?.backend).toBe("claude");
    if (lane?.backend === "claude") {
      expect(lane.limitEvaluation).toBe("metrics_unavailable");
    }
  });

  it("rejects an execution whose workingDefinition has contextSoftLimitTokens", () => {
    const execution = makeValidExecution();
    (
      execution.workingDefinition.executionContexts[0]!
        .iterationPolicy as Record<string, unknown>
    ).contextSoftLimitTokens = 100000;

    expect(() => assertExecutionSupported(execution)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("rejects an execution whose workingDefinition has contextHardLimitTokens", () => {
    const execution = makeValidExecution();
    (
      execution.workingDefinition.executionContexts[0]!
        .iterationPolicy as Record<string, unknown>
    ).contextHardLimitTokens = 150000;

    expect(() => assertExecutionSupported(execution)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("error message instructs operator to run the one-time cleanup", () => {
    const execution = makeValidExecution();
    (
      execution.workingDefinition.executionContexts[0]!
        .iterationPolicy as Record<string, unknown>
    ).contextSoftLimitTokens = 100000;

    expect(() => assertExecutionSupported(execution)).toThrow(/cleanup/i);
  });

  it("rejects an execution whose workingDefinition has taskValidation", () => {
    const execution = makeValidExecution();
    (
      execution.workingDefinition.executionContexts[0]! as Record<
        string,
        unknown
      >
    ).taskValidation = {
      type: "claude",
      enabled: true,
      acceptanceCriteria: "legacy",
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      continuity: { enabled: true },
    };

    expect(() => assertExecutionSupported(execution)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("rejects an execution with a task validator lane", () => {
    const execution = makeValidExecution();
    (execution as Record<string, unknown>).laneStates = {
      task_validator: {
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
        lastUsedAt: timestamp,
      },
    };

    expect(() => assertExecutionSupported(execution)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("rejects an execution with a task validation event", () => {
    const execution = makeValidExecution();
    (execution as Record<string, unknown>).history = [
      {
        occurredAt: timestamp,
        event: {
          type: "graph-workflow-validation-result",
          projectName: "proj",
          sessionName: "session",
          executionId: "exec-1",
          contextId: "ctx-1",
          validatorType: "task",
          pass: false,
          summary: "legacy",
          issues: [],
          reopenTaskIds: ["task-1"],
        },
      },
    ];

    expect(() => assertExecutionSupported(execution)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });
});
