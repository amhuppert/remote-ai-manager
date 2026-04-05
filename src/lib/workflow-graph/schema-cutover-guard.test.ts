import { describe, expect, it } from "vitest";
import {
  LegacyWorkflowSchemaError,
  assertDefinitionRecordSupported,
  assertExecutionSupported,
  checkRawStateForLegacyWorkflowPayloads,
} from "./schema-cutover-guard";

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
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          agent: { model: "opus", reasoningEffort: "high" },
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
    activeContextId: "ctx-1",
    contextStates: {},
    taskStates: {},
    retryState: {},
    sharedDocuments: [],
    machineSnapshot: null,
    history: [],
    startedAt: timestamp,
    completedAt: null,
    haltReason: null,
    workingDefinition: {
      schemaVersion: 1,
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          agent: { model: "opus", reasoningEffort: "high" },
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
});

describe("assertExecutionSupported", () => {
  it("accepts a valid execution", () => {
    const execution = makeValidExecution();
    const result = assertExecutionSupported(execution);
    expect(result.id).toBe("exec-1");
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

  it("error message instructs operator to clear the stale execution", () => {
    const execution = makeValidExecution();
    (
      execution.workingDefinition.executionContexts[0]!
        .iterationPolicy as Record<string, unknown>
    ).contextSoftLimitTokens = 100000;

    expect(() => assertExecutionSupported(execution)).toThrow(/clear/i);
  });
});

describe("checkRawStateForLegacyWorkflowPayloads", () => {
  it("does not throw for state with no graph workflow executions", () => {
    const rawState = {
      projects: {
        "proj-1": {
          sessions: {
            "session-1": {
              graphWorkflowExecution: null,
            },
          },
        },
      },
    };
    expect(() =>
      checkRawStateForLegacyWorkflowPayloads(rawState),
    ).not.toThrow();
  });

  it("does not throw for state with a valid execution", () => {
    const rawState = {
      projects: {
        "proj-1": {
          sessions: {
            "session-1": {
              graphWorkflowExecution: makeValidExecution(),
            },
          },
        },
      },
    };
    expect(() =>
      checkRawStateForLegacyWorkflowPayloads(rawState),
    ).not.toThrow();
  });

  it("throws LegacyWorkflowSchemaError when a session has a legacy execution", () => {
    const legacyExecution = makeValidExecution();
    (
      legacyExecution.workingDefinition.executionContexts[0]!
        .iterationPolicy as Record<string, unknown>
    ).contextSoftLimitTokens = 100000;

    const rawState = {
      projects: {
        "proj-1": {
          sessions: {
            "session-1": {
              graphWorkflowExecution: legacyExecution,
            },
          },
        },
      },
    };
    expect(() => checkRawStateForLegacyWorkflowPayloads(rawState)).toThrow(
      LegacyWorkflowSchemaError,
    );
  });

  it("does not throw for non-object or null state", () => {
    expect(() => checkRawStateForLegacyWorkflowPayloads(null)).not.toThrow();
    expect(() =>
      checkRawStateForLegacyWorkflowPayloads(undefined),
    ).not.toThrow();
    expect(() =>
      checkRawStateForLegacyWorkflowPayloads("not an object"),
    ).not.toThrow();
  });
});
