import { describe, expect, it } from "vitest";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import {
  GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES,
  contextOwesOutput,
  getContextOutput,
  projectGraphWorkflowResultOutputs,
  resolveDefinitionUpstreamInputs,
  resolveUpstreamInputs,
} from "./context-outputs";

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One-line plan summary" },
    risks: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["summary", "risks"],
  additionalProperties: false,
};

const PLAN_OUTPUT = {
  summary: "Migrate the store first",
  risks: ["schema drift"],
  confidence: 0.8,
};

/**
 * The fixture graph is plan → implement → verify. `schemas` declares which
 * contexts carry an `outputSchema`; `outputs` which of them have banked one.
 */
function makeExecution(options: {
  schemas?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, Record<string, unknown>>;
  extraEdges?: Array<{
    id: string;
    sourceContextId: string;
    targetContextId: string;
  }>;
}): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition();
  const withSchemas = {
    ...definition,
    executionContexts: definition.executionContexts.map((context) => {
      const outputSchema = options.schemas?.[context.id];
      return outputSchema ? { ...context, outputSchema } : context;
    }),
    edges: [...definition.edges, ...(options.extraEdges ?? [])],
  };

  const base = createWorkflowExecution({ workingDefinition: withSchemas });
  return {
    ...base,
    contextOutputs: Object.fromEntries(
      Object.entries(options.outputs ?? {}).map(([contextId, value]) => [
        contextId,
        {
          value,
          capturedAt: "2026-03-27T16:10:00.000Z",
          iteration: 1,
          parse: { source: "raw_json" as const },
        },
      ]),
    ),
  };
}

/** Settle `contextId` as skipped, the way the scheduler's skip write leaves it. */
function withSkippedContext(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowExecution {
  return {
    ...execution,
    contextStates: {
      ...execution.contextStates,
      [contextId]: {
        ...execution.contextStates[contextId]!,
        status: "skipped",
        skipReason: {
          edgeEvaluations: [{ edgeId: "edge-in", verdict: "inactive" }],
          at: "2026-03-27T16:20:00.000Z",
        },
      },
    },
  };
}

describe("getContextOutput", () => {
  it("returns the captured output for a context that banked one", () => {
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
      outputs: { "context-plan": PLAN_OUTPUT },
    });

    const result = getContextOutput(execution, "context-plan");

    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") return;
    expect(result.value).toEqual(PLAN_OUTPUT);
    expect(result.output.capturedAt).toBe("2026-03-27T16:10:00.000Z");
    expect(result.output.parse).toEqual({ source: "raw_json" });
  });

  it("distinguishes a context still owing an output from one that never owed one", () => {
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
    });

    // Declares a contract, has not satisfied it yet.
    expect(getContextOutput(execution, "context-plan")).toEqual({
      kind: "pending",
      outputSchema: PLAN_SCHEMA,
    });
    // Free-form context: absence is the steady state, not a missing value.
    expect(getContextOutput(execution, "context-implement")).toEqual({
      kind: "none",
    });
  });

  it("reports an unknown context id as none rather than throwing", () => {
    const execution = makeExecution({});

    expect(getContextOutput(execution, "context-does-not-exist")).toEqual({
      kind: "none",
    });
  });

  // The declaration is what makes a payload an OUTPUT: one banked against a
  // contract that no longer exists is evidence about nothing the current
  // definition promises. It stays readable (the CLI outline still reports it)
  // but it is not `captured`, so no surface can present it as the contract's
  // satisfied result.
  it("reports a banked payload whose schema is no longer declared as orphaned", () => {
    const execution = makeExecution({
      outputs: { "context-plan": PLAN_OUTPUT },
    });

    const lookup = getContextOutput(execution, "context-plan");
    expect(lookup.kind).toBe("orphaned");
    if (lookup.kind !== "orphaned") return;
    expect(lookup.output.value).toEqual(PLAN_OUTPUT);
    // Nothing owes it and nothing downstream may consume it as an input.
    expect(contextOwesOutput(execution, "context-plan")).toBe(false);
    expect(
      resolveUpstreamInputs(execution, "context-implement")[0]?.output,
    ).toBeNull();
  });

  // D4 R4: a skipped context owes no output debt. The lookup is layered here
  // rather than in the raw read because "skipped" is lifecycle, not evidence:
  // the raw read still answers "was a payload captured", which is what guards
  // evaluate against.
  describe("a skipped context (D4 R4)", () => {
    it("reports skipped instead of pending even when it declared a contract", () => {
      const execution = withSkippedContext(
        makeExecution({ schemas: { "context-plan": PLAN_SCHEMA } }),
        "context-plan",
      );

      expect(getContextOutput(execution, "context-plan")).toEqual({
        kind: "skipped",
      });
      expect(contextOwesOutput(execution, "context-plan")).toBe(false);
    });

    it("reports skipped for a free-form context too", () => {
      const execution = withSkippedContext(makeExecution({}), "context-plan");

      expect(getContextOutput(execution, "context-plan")).toEqual({
        kind: "skipped",
      });
    });
  });
});

describe("projectGraphWorkflowResultOutputs", () => {
  const scope = { projectName: "repo", sessionName: "session-1" };

  it("projects declared scalar and object values under their context id", () => {
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
      outputs: {
        "context-plan": {
          summary: "Migrate the store first",
          details: { riskCount: 1 },
        },
      },
    });

    expect(projectGraphWorkflowResultOutputs({ ...scope, execution })).toEqual({
      kind: "declared_outputs",
      byContext: {
        "context-plan": {
          details: { riskCount: 1 },
          summary: "Migrate the store first",
        },
      },
    });
  });

  it("returns an explicit marker when no reached context has a declared result", () => {
    const execution = makeExecution({
      outputs: { "context-plan": { incidental: "not declared" } },
    });

    expect(projectGraphWorkflowResultOutputs({ ...scope, execution })).toEqual({
      kind: "no_declared_structured_result",
    });
  });

  it("inlines a value just below the cap and references one just above it", () => {
    const below = "b".repeat(GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES - 3);
    const above = "a".repeat(GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES - 1);
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
      outputs: { "context-plan": { below, above } },
    });

    const projection = projectGraphWorkflowResultOutputs({
      ...scope,
      execution,
    });

    expect(projection).toMatchObject({
      kind: "declared_outputs",
      byContext: {
        "context-plan": {
          below,
          above: {
            kind: "output_reference",
            executionId: execution.id,
            contextId: "context-plan",
            outputName: "above",
            deepLink: `/projects/repo/session-1/workflow?execution=${execution.id}`,
          },
        },
      },
    });
    expect(JSON.stringify(projection)).not.toContain(above);
    expect(execution.contextOutputs["context-plan"]?.value.above).toBe(above);
  });

  it("references every oversized value independently with stable coordinates", () => {
    const first = "1".repeat(GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES);
    const second = "2".repeat(GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES);
    const execution = makeExecution({
      schemas: {
        "context-plan": PLAN_SCHEMA,
        "context-implement": PLAN_SCHEMA,
      },
      outputs: {
        "context-plan": { first },
        "context-implement": { second },
      },
    });

    const projection = projectGraphWorkflowResultOutputs({
      ...scope,
      execution,
    });
    expect(projection).toMatchObject({
      kind: "declared_outputs",
      byContext: {
        "context-plan": {
          first: {
            kind: "output_reference",
            executionId: execution.id,
            contextId: "context-plan",
            outputName: "first",
          },
        },
        "context-implement": {
          second: {
            kind: "output_reference",
            executionId: execution.id,
            contextId: "context-implement",
            outputName: "second",
          },
        },
      },
    });
    expect(JSON.stringify(projection)).not.toContain(first);
    expect(JSON.stringify(projection)).not.toContain(second);
  });
});

describe("resolveUpstreamInputs", () => {
  it("returns only direct predecessors, in graph order", () => {
    // plan → implement → verify, plus a direct plan → verify edge, so verify
    // has two direct predecessors and implement has one.
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
      outputs: { "context-plan": PLAN_OUTPUT },
      extraEdges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });

    expect(
      resolveUpstreamInputs(execution, "context-verify").map(
        (entry) => entry.contextId,
      ),
      // Declared edge order is implement→verify then plan→verify; graph order
      // (the context list) puts plan first.
    ).toEqual(["context-plan", "context-implement"]);

    // A transitive ancestor is NOT an input: only direct predecessors are.
    expect(
      resolveUpstreamInputs(execution, "context-implement").map(
        (entry) => entry.contextId,
      ),
    ).toEqual(["context-plan"]);
    expect(resolveUpstreamInputs(execution, "context-plan")).toEqual([]);
  });

  it("carries each predecessor's title, declared fields, and captured output", () => {
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
      outputs: { "context-plan": PLAN_OUTPUT },
    });

    const [plan] = resolveUpstreamInputs(execution, "context-implement");

    expect(plan).toMatchObject({
      contextId: "context-plan",
      title: "Plan",
      output: PLAN_OUTPUT,
    });
    expect(plan?.schemaFields).toEqual([
      {
        name: "summary",
        type: "string",
        required: true,
        description: "One-line plan summary",
      },
      { name: "risks", type: "array", required: true, description: null },
      {
        name: "confidence",
        type: "number",
        required: false,
        description: null,
      },
    ]);
  });

  it("carries a schema-declaring predecessor that has not produced its output yet", () => {
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
    });

    const [plan] = resolveUpstreamInputs(execution, "context-implement");

    expect(plan?.output).toBeNull();
    expect(plan?.schemaFields).not.toBeNull();
  });

  it("carries a free-form predecessor with null fields and null output", () => {
    const execution = makeExecution({});

    const [plan] = resolveUpstreamInputs(execution, "context-implement");

    expect(plan).toEqual({
      contextId: "context-plan",
      title: "Plan",
      declared: false,
      schemaFields: null,
      output: null,
      skipped: false,
    });
  });

  // D4 R4.3: the row survives so the downstream prompt can say the branch was
  // not taken. Dropping it would be indistinguishable from a predecessor still
  // working, which is exactly the ambiguity the flag removes.
  it("marks a skipped predecessor as skipped rather than dropping the row", () => {
    const execution = withSkippedContext(
      makeExecution({ schemas: { "context-plan": PLAN_SCHEMA } }),
      "context-plan",
    );

    const [plan] = resolveUpstreamInputs(execution, "context-implement");

    expect(plan?.skipped).toBe(true);
    expect(plan?.output).toBeNull();
    expect(plan?.declared).toBe(true);
  });

  it("does not mark a predecessor that merely has not produced its output", () => {
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
    });

    expect(
      resolveUpstreamInputs(execution, "context-implement")[0]?.skipped,
    ).toBe(false);
  });

  it("reports a declared bare-object schema as declared, with no field list to show", () => {
    // A valid subset declaration: it constrains the payload to an object
    // without naming properties. `schemaFields` is null because there is no
    // field list, which is NOT the same as declaring nothing.
    const execution = makeExecution({
      schemas: { "context-plan": { type: "object" } },
      outputs: { "context-plan": PLAN_OUTPUT },
    });

    const [plan] = resolveUpstreamInputs(execution, "context-implement");

    expect(plan?.declared).toBe(true);
    expect(plan?.schemaFields).toBeNull();
    expect(plan?.output).toEqual(PLAN_OUTPUT);
  });

  it("reports a declared root-oneOf schema as declared", () => {
    const execution = makeExecution({
      schemas: {
        "context-plan": {
          oneOf: [
            { type: "object", properties: { ok: { type: "boolean" } } },
            { type: "object", properties: { error: { type: "string" } } },
          ],
        },
      },
    });

    const [plan] = resolveUpstreamInputs(execution, "context-implement");

    expect(plan?.declared).toBe(true);
    expect(plan?.schemaFields).toBeNull();
  });
});

describe("resolveDefinitionUpstreamInputs", () => {
  it("answers Q2 the same way for an authored definition, with no output banked", () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-plan"
          ? { ...context, outputSchema: PLAN_SCHEMA }
          : context,
      ),
      edges: [
        ...base.edges,
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    };

    // Direct predecessors only, in graph order — a definition has nowhere to
    // bank an output, so every row reports `output: null`.
    expect(
      resolveDefinitionUpstreamInputs(definition, "context-verify"),
    ).toEqual([
      {
        skipped: false,
        contextId: "context-plan",
        title: "Plan",
        declared: true,
        schemaFields: [
          {
            name: "summary",
            type: "string",
            required: true,
            description: "One-line plan summary",
          },
          { name: "risks", type: "array", required: true, description: null },
          {
            name: "confidence",
            type: "number",
            required: false,
            description: null,
          },
        ],
        output: null,
      },
      {
        skipped: false,
        contextId: "context-implement",
        title: "Implement",
        declared: false,
        schemaFields: null,
        output: null,
      },
    ]);
    expect(resolveDefinitionUpstreamInputs(definition, "context-plan")).toEqual(
      [],
    );
  });

  it("is the single edge-walk behind the execution-side resolver", () => {
    const execution = makeExecution({
      schemas: { "context-plan": PLAN_SCHEMA },
      outputs: { "context-plan": PLAN_OUTPUT },
      extraEdges: [
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });

    // Same rows, same order; the execution-side resolver adds only the banked
    // payloads, so the Q2 scope answer cannot drift between the two surfaces.
    expect(
      resolveUpstreamInputs(execution, "context-verify").map(
        ({ output: _output, ...row }) => row,
      ),
    ).toEqual(
      resolveDefinitionUpstreamInputs(
        execution.workingDefinition,
        "context-verify",
      ).map(({ output: _output, ...row }) => row),
    );
  });
});
