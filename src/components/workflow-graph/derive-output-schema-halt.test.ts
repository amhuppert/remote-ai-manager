import { describe, expect, it } from "vitest";
import {
  deriveOutputSchemaHaltEvidence,
  deriveOutputSchemaHaltEvidenceByContext,
} from "./derive-output-schema-halt";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowValidationResultEvent } from "@/lib/workflow-graph/event-schemas";

const outputSchema = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

function executionWithSchema(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition();
  definition.executionContexts = definition.executionContexts.map((context) =>
    context.id === "context-plan"
      ? {
          ...context,
          outputSchema,
          circuitBreaker: { consecutiveFailureThreshold: 3 },
          iterationPolicy: { maxIterations: 4, continuity: { enabled: true } },
        }
      : context,
  );
  return createWorkflowExecution({
    workingDefinition: definition,
    ...overrides,
  });
}

function rejection(): GraphWorkflowValidationResultEvent & {
  occurredAt: string;
} {
  return {
    type: "graph-workflow-validation-result",
    projectName: "project",
    sessionName: "session-1",
    executionId: "execution-1",
    contextId: "context-plan",
    validatorType: "context",
    kind: "output_schema",
    pass: false,
    summary: "Output rejected — 2 issues",
    reopenTaskIds: [],
    issues: [
      {
        title: "/verdict",
        description: "not one of the allowed values",
        path: "/verdict",
      },
      { title: "/confidence", description: "wrong type", path: "/confidence" },
    ],
    rejectedOutput: '{ "verdict": "partial" }',
    gateRepairAttempts: null,
    gateRepairBudget: null,
    occurredAt: "2026-03-27T09:41:00.000Z",
  };
}

const breakerHalt = {
  type: "circuit_breaker",
  contextId: "context-plan",
  condition: "output_schema_validation",
  failureCount: 3,
  summary: "Output schema not satisfied",
} as const;

describe("deriveOutputSchemaHaltEvidence (R3.2)", () => {
  it("returns null for a halt that is not an output-schema breaker trip", () => {
    expect(
      deriveOutputSchemaHaltEvidence({
        execution: executionWithSchema(),
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          failureCount: 3,
          summary: null,
        },
        validationEvents: [rejection()],
      }),
    ).toBeNull();
  });

  it("returns null for a non-breaker halt", () => {
    expect(
      deriveOutputSchemaHaltEvidence({
        execution: executionWithSchema(),
        haltReason: { type: "aborted", cause: null, summary: null },
        validationEvents: [rejection()],
      }),
    ).toBeNull();
  });

  it("collects the path-keyed issues, refused payload and declared contract", () => {
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: executionWithSchema(),
      haltReason: breakerHalt,
      validationEvents: [rejection()],
    });

    expect(evidence?.issues).toEqual([
      {
        path: "/verdict",
        title: "/verdict",
        description: "not one of the allowed values",
      },
      { path: "/confidence", title: "/confidence", description: "wrong type" },
    ]);
    expect(evidence?.rejectedOutput).toBe('{ "verdict": "partial" }');
    expect(evidence?.declaredSchema).toEqual(outputSchema);
  });

  it("reports the breaker and iteration budgets for the chips", () => {
    const execution = executionWithSchema();
    const planState = execution.contextStates["context-plan"];
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: {
        ...execution,
        contextStates: {
          ...execution.contextStates,
          ...(planState
            ? { "context-plan": { ...planState, iterationCount: 3 } }
            : {}),
        },
      },
      haltReason: breakerHalt,
      validationEvents: [rejection()],
    });

    expect(evidence?.failureCount).toBe(3);
    expect(evidence?.breakerThreshold).toBe(3);
    expect(evidence?.iteration).toBe(3);
    expect(evidence?.maxIterations).toBe(4);
  });

  it("reports the engine's effective breaker threshold when the policy declares none", () => {
    const execution = executionWithSchema();
    execution.workingDefinition.executionContexts =
      execution.workingDefinition.executionContexts.map((context) =>
        context.id === "context-plan"
          ? { ...context, circuitBreaker: {} }
          : context,
      );

    const evidence = deriveOutputSchemaHaltEvidence({
      execution,
      haltReason: breakerHalt,
      validationEvents: [rejection()],
    });

    // An empty policy is valid and the engine trips at the default 3, so the
    // chip must read "3 of 3" rather than dropping the budget half.
    expect(evidence?.breakerThreshold).toBe(3);
  });

  it("pairs the rejection with the contract that refused it after a live schema edit", () => {
    const replacement = {
      type: "object",
      properties: {
        verdict: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["verdict", "confidence"],
    };
    const execution = executionWithSchema();
    execution.workingDefinition.executionContexts =
      execution.workingDefinition.executionContexts.map((context) =>
        context.id === "context-plan"
          ? { ...context, outputSchema: replacement }
          : context,
      );

    const evidence = deriveOutputSchemaHaltEvidence({
      execution,
      haltReason: breakerHalt,
      validationEvents: [
        { ...rejection(), rejectedAgainstSchema: outputSchema },
      ],
    });

    // The Edit-schema action can replace the contract while the halt is still
    // active; showing the refused payload beside the NEW schema would pair
    // evidence that never met (R3.2).
    expect(evidence?.declaredSchema).toEqual(outputSchema);
    // …and the surface is told the contract has moved on, so it does not
    // present the refusing schema as the one the context declares now.
    expect(evidence?.schemaEditedSinceRejection).toBe(true);
  });

  it("does not flag an edit when the refusing contract is still the declared one", () => {
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: executionWithSchema(),
      haltReason: breakerHalt,
      validationEvents: [
        // Same contract, different key order — persistence canonicalizes JSON.
        {
          ...rejection(),
          rejectedAgainstSchema: {
            required: [...outputSchema.required],
            properties: { ...outputSchema.properties },
            type: outputSchema.type,
          },
        },
      ],
    });

    expect(evidence?.schemaEditedSinceRejection).toBe(false);
  });

  it("falls back to the context's contract for a rejection recorded before the snapshot existed", () => {
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: executionWithSchema(),
      haltReason: breakerHalt,
      validationEvents: [rejection()],
    });

    expect(evidence?.declaredSchema).toEqual(outputSchema);
  });

  // Resume restarts the refused turn against whatever the context declares NOW,
  // so the surfaces that offer Resume need the positive form of the edit
  // question — "the contract that refused is provably still in force" — which
  // `schemaEditedSinceRejection` cannot express: false there also means "no
  // snapshot was recorded, so nothing can be compared".
  describe("contractUnchangedSinceRejection", () => {
    it("is true while the refusing contract is still the declared one", () => {
      const evidence = deriveOutputSchemaHaltEvidence({
        execution: executionWithSchema(),
        haltReason: breakerHalt,
        validationEvents: [
          { ...rejection(), rejectedAgainstSchema: { ...outputSchema } },
        ],
      });

      expect(evidence?.contractUnchangedSinceRejection).toBe(true);
    });

    it("is false once the contract has been edited since the rejection", () => {
      const evidence = deriveOutputSchemaHaltEvidence({
        execution: executionWithSchema(),
        haltReason: breakerHalt,
        validationEvents: [
          {
            ...rejection(),
            rejectedAgainstSchema: { type: "object", properties: {} },
          },
        ],
      });

      expect(evidence?.contractUnchangedSinceRejection).toBe(false);
    });

    // Nothing to compare is not proof the contract still refuses, and a run
    // that can never be resumed is worse than one resumed a turn too early.
    it("is false when the rejection recorded no contract snapshot", () => {
      const evidence = deriveOutputSchemaHaltEvidence({
        execution: executionWithSchema(),
        haltReason: breakerHalt,
        validationEvents: [rejection()],
      });

      expect(evidence?.contractUnchangedSinceRejection).toBe(false);
    });
  });

  it("reports the structured-output gate's repair spend from the rejection record", () => {
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: executionWithSchema(),
      haltReason: breakerHalt,
      validationEvents: [
        { ...rejection(), gateRepairAttempts: 1, gateRepairBudget: 2 },
      ],
    });

    expect(evidence?.gateRepairAttempts).toBe(1);
    expect(evidence?.gateRepairBudget).toBe(2);
  });

  it("omits the repair chip when no repair turn ran, even while D1 plan repair did", () => {
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: executionWithSchema({
        // A settled plan-repair round belongs to a different repair system
        // (D1's restricted-op agent). Counting it here would label an unrelated
        // later round as the gate's repair spend on this rejection.
        planRepairRounds: [
          {
            seq: 1,
            contextId: "context-plan",
            haltType: "circuit_breaker",
            loopGroupId: null,
            startedAt: "2026-03-27T09:40:00.000Z",
            settledAt: "2026-03-27T09:41:00.000Z",
            outcome: "declined",
            planningDefect: false,
            diagnosis: null,
            operationCount: 0,
            resumed: false,
            conversationId: null,
          },
        ],
      }),
      haltReason: breakerHalt,
      validationEvents: [{ ...rejection(), gateRepairAttempts: 0 }],
    });

    expect(evidence?.gateRepairAttempts).toBeNull();
  });

  it("still reports the contract when no rejection record survives", () => {
    const evidence = deriveOutputSchemaHaltEvidence({
      execution: executionWithSchema(),
      haltReason: breakerHalt,
      validationEvents: [],
    });

    expect(evidence).not.toBeNull();
    expect(evidence?.issues).toEqual([]);
    expect(evidence?.rejectedOutput).toBeNull();
    expect(evidence?.declaredSchema).toEqual(outputSchema);
    expect(evidence?.gateRepairAttempts).toBeNull();
    expect(evidence?.gateRepairBudget).toBeNull();
  });
});

describe("deriveOutputSchemaHaltEvidenceByContext (R3.2)", () => {
  it("derives evidence for a secondary output-schema reason as well as the primary", () => {
    const execution = executionWithSchema();
    const secondaryReason = {
      type: "circuit_breaker",
      contextId: "context-build",
      condition: "output_schema_validation",
      failureCount: 2,
      summary: "Output schema not satisfied",
    } as const;

    const byContext = deriveOutputSchemaHaltEvidenceByContext({
      execution,
      haltReasons: [breakerHalt, secondaryReason],
      validationEvents: [
        rejection(),
        {
          ...rejection(),
          contextId: "context-build",
          issues: [
            { title: "/artifact", description: "missing", path: "/artifact" },
          ],
          rejectedOutput: "{}",
          gateRepairAttempts: null,
          gateRepairBudget: null,
        },
      ],
    });

    expect(byContext["context-plan"]?.issues).toHaveLength(2);
    expect(byContext["context-build"]?.issues).toEqual([
      { path: "/artifact", title: "/artifact", description: "missing" },
    ]);
    expect(byContext["context-build"]?.rejectedOutput).toBe("{}");
  });

  it("skips halt reasons that are not output-schema trips", () => {
    const byContext = deriveOutputSchemaHaltEvidenceByContext({
      execution: executionWithSchema(),
      haltReasons: [
        { type: "aborted", cause: null, summary: null },
        {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "retry_exhaustion",
          failureCount: 3,
          summary: null,
        },
      ],
      validationEvents: [rejection()],
    });

    expect(byContext).toEqual({});
  });
});
