import { describe, expect, it } from "vitest";
import {
  LegacyWorkflowSchemaError,
  assertDefinitionRecordSupported,
  assertExecutionSupported,
  assertNoLegacyWorkflowFields,
} from "./schema-cutover-guard";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";

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

  // A declared `outputSchema` is an author-supplied document whose property
  // names are the AGENT'S output vocabulary, not this repo's config vocabulary.
  // Scanning it for removed CC field names makes an arbitrary word collision
  // ("taskValidation") an unrecoverable save/reload failure, so the subtree is
  // opaque to legacy detection.
  it("accepts a record whose outputSchema declares properties named after removed config fields", () => {
    const record = makeValidDefinitionRecord();
    const context = record.definition.executionContexts[0]! as Record<
      string,
      unknown
    >;
    context.outputSchema = {
      type: "object",
      properties: {
        taskValidation: { type: "string" },
        contextSoftLimitTokens: { type: "number" },
        contextValidation: { type: "string" },
        agent: { type: "string" },
      },
      required: ["taskValidation"],
    };

    const result = assertDefinitionRecordSupported(record);
    expect(result.definition.executionContexts[0]?.outputSchema).toMatchObject({
      required: ["taskValidation"],
    });
  });

  it("accepts a record whose outputSchema describes a context-shaped or validator-shaped payload", () => {
    const record = makeValidDefinitionRecord();
    const context = record.definition.executionContexts[0]! as Record<
      string,
      unknown
    >;
    // `id` + `title` string values would read as an execution context missing
    // acceptanceCriteria; `type: "claude"` beside `acceptanceCriteria` would
    // read as a validator carrying AC. Both are ordinary schema content here.
    context.outputSchema = {
      type: "object",
      properties: {
        report: {
          type: "object",
          id: "report-id",
          title: "Report",
          properties: {
            type: { type: "string", const: "claude" },
            acceptanceCriteria: { type: "string" },
          },
        },
      },
    };

    expect(() => assertDefinitionRecordSupported(record)).not.toThrow();
  });
});

describe("assertExecutionSupported", () => {
  it("accepts a valid execution", () => {
    const execution = makeValidExecution();
    const result = assertExecutionSupported(execution);
    expect(result.id).toBe("exec-1");
  });

  // A captured `contextOutputs` value is the AGENT'S output in the author's own
  // vocabulary — the same hazard as a declared `outputSchema`, one step further
  // removed because nobody hand-writes it. Scanning it for removed CC field
  // names would make an execution that ran successfully unloadable on the next
  // read, so the subtree is opaque to legacy detection.
  it("accepts an execution whose captured contextOutputs value uses removed config field names", () => {
    const execution = makeValidExecution();
    // An output only exists for a context that declared a schema, so the
    // fixture declares one that accepts exactly this payload. Both subtrees are
    // opaque to the guard, which is the point: the collision survives whether
    // the word appears in the declaration or in the captured value.
    const context = execution.workingDefinition.executionContexts[0] as Record<
      string,
      unknown
    >;
    context.outputSchema = {
      type: "object",
      properties: {
        taskValidation: { type: "string" },
        contextSoftLimitTokens: { type: "integer" },
        report: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            type: { type: "string" },
            acceptanceCriteria: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    (execution as Record<string, unknown>).contextOutputs = {
      "ctx-1": {
        value: {
          taskValidation: "reviewed",
          contextSoftLimitTokens: 1000,
          // `id` + `title` would otherwise read as an execution context missing
          // acceptanceCriteria; `type: "claude"` beside `acceptanceCriteria`
          // would read as a validator carrying AC.
          report: {
            id: "report-1",
            title: "Report",
            type: "claude",
            acceptanceCriteria: "n/a",
          },
        },
        capturedAt: timestamp,
        iteration: 2,
        parse: { source: "native" },
      },
    };

    const result = assertExecutionSupported(execution);
    expect(result.contextOutputs["ctx-1"]?.value).toMatchObject({
      taskValidation: "reviewed",
    });
    // The payload really is one this context would have accepted, so the
    // fixture models a reachable state rather than an invented one.
    expect(
      validateJsonSchemaSubset(
        context.outputSchema as Record<string, unknown>,
        result.contextOutputs["ctx-1"]?.value,
      ),
    ).toEqual({ valid: true });
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

  it("accepts an execution whose outputSchema declares properties named after removed config fields", () => {
    const execution = makeValidExecution();
    (
      execution.workingDefinition.executionContexts[0]! as Record<
        string,
        unknown
      >
    ).outputSchema = {
      type: "object",
      properties: {
        taskValidation: { type: "string" },
        contextHardLimitTokens: { type: "number" },
      },
      required: ["taskValidation"],
    };

    const result = assertExecutionSupported(execution);
    expect(
      result.workingDefinition.executionContexts[0]?.outputSchema,
    ).toMatchObject({ required: ["taskValidation"] });
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

// The third entry point: the definition save boundary and the execution-seed
// boundary both call this directly rather than going through a record/execution
// parse, so the opacity rule is pinned here too.
describe("assertNoLegacyWorkflowFields", () => {
  it("still rejects a removed field on the definition itself", () => {
    const definition = makeValidDefinitionRecord().definition;
    (
      definition.executionContexts[0]! as Record<string, unknown>
    ).taskValidation = { type: "claude", enabled: true };

    expect(() =>
      assertNoLegacyWorkflowFields(definition, "Workflow definition (save)"),
    ).toThrow(LegacyWorkflowSchemaError);
  });

  it("accepts the same word as a property name inside a declared outputSchema", () => {
    const definition = makeValidDefinitionRecord().definition;
    (definition.executionContexts[0]! as Record<string, unknown>).outputSchema =
      {
        type: "object",
        properties: { taskValidation: { type: "string" } },
        required: ["taskValidation"],
      };

    expect(() =>
      assertNoLegacyWorkflowFields(definition, "Workflow definition (save)"),
    ).not.toThrow();
  });
});
