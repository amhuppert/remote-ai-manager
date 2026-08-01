/**
 * Durability contract for the D2 read side (R4.2).
 *
 * The repository's own round-trip backstop proves the `contextOutputs` COLUMN
 * survives; this proves the thing callers actually depend on — that after a
 * process restart the typed accessor still reports a completed context's output
 * as `captured`, with a payload that still conforms to the declared schema, and
 * that the downstream context still resolves it as an upstream input.
 *
 * A JS-object fake cannot prove this: the payload is an opaque record inside a
 * serialized runtime blob, so only a real reload through the real repository
 * shows whether it comes back intact.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import type { Db } from "@/lib/state-store/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { getContextOutput, resolveUpstreamInputs } from "./context-outputs";

const PROJECT_PATH = "/projects/demo";
const SESSION_NAME = "session-1";
const NOW = "2026-07-12T10:00:00.000Z";

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One-line plan summary" },
    risks: { type: "array", items: { type: "string" } },
    estimate: { type: "object", properties: { days: { type: "number" } } },
  },
  required: ["summary", "risks"],
  additionalProperties: false,
};

// Deliberately non-flat: nesting and an array are exactly what a lossy
// serialization round-trip would flatten or drop.
const PLAN_OUTPUT = {
  summary: "Migrate the store first",
  risks: ["schema drift", "long migration window"],
  estimate: { days: 3.5 },
};

let fixture: PersistenceFixture;
let db: Db;

beforeEach(() => {
  fixture = createPersistenceFixture();
  db = fixture.db;
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

function seedCompletedPlanContext(): void {
  const definition = createResolvedWorkflowDefinition();
  const execution = createWorkflowExecution({
    status: "running",
    workingDefinition: {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "context-plan"
          ? { ...context, outputSchema: PLAN_SCHEMA }
          : context,
      ),
    },
  });

  createGraphWorkflowExecutionsRepo(db).setActive(
    PROJECT_PATH,
    SESSION_NAME,
    {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...execution.contextStates["context-plan"]!,
          status: "completed",
        },
      },
      contextOutputs: {
        "context-plan": {
          value: PLAN_OUTPUT,
          capturedAt: NOW,
          iteration: 2,
          parse: { source: "fenced", repaired: true },
        },
      },
    },
    NOW,
  );
}

/** A fresh repository over the same database — the restart boundary. */
function reloadAfterRestart() {
  const reloaded = createGraphWorkflowExecutionsRepo(db).getActive(
    PROJECT_PATH,
    SESSION_NAME,
  );
  if (!reloaded) throw new Error("active execution did not survive the reload");
  return reloaded;
}

describe("context outputs survive a server restart (R4.2)", () => {
  it("still reports the completed context's output as captured, schema-conformant, with its capture provenance", () => {
    seedCompletedPlanContext();

    const lookup = getContextOutput(reloadAfterRestart(), "context-plan");

    expect(lookup.kind).toBe("captured");
    if (lookup.kind !== "captured") return;
    expect(lookup.value).toEqual(PLAN_OUTPUT);
    expect(validateJsonSchemaSubset(PLAN_SCHEMA, lookup.value).valid).toBe(
      true,
    );
    expect(lookup.output.capturedAt).toBe(NOW);
    expect(lookup.output.iteration).toBe(2);
    expect(lookup.output.parse).toEqual({
      source: "fenced",
      repaired: true,
    });
  });

  it("still resolves the reloaded output as the downstream context's upstream input", () => {
    seedCompletedPlanContext();

    const inputs = resolveUpstreamInputs(
      reloadAfterRestart(),
      "context-implement",
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      contextId: "context-plan",
      title: "Plan",
      output: PLAN_OUTPUT,
    });
    // The declared schema round-trips too, so the fields stay addressable —
    // but the store canonicalizes key order, so they come back alphabetized
    // rather than in authoring order. Field ORDER is therefore not semantic;
    // only the field set and each field's requiredness are.
    expect(inputs[0]?.schemaFields).toEqual([
      { name: "estimate", type: "object", required: false, description: null },
      { name: "risks", type: "array", required: true, description: null },
      {
        name: "summary",
        type: "string",
        required: true,
        description: "One-line plan summary",
      },
    ]);
  });

  it("reports a schema-declaring context with nothing banked as pending after reload, not captured", () => {
    const definition = createResolvedWorkflowDefinition();
    createGraphWorkflowExecutionsRepo(db).setActive(
      PROJECT_PATH,
      SESSION_NAME,
      createWorkflowExecution({
        status: "running",
        workingDefinition: {
          ...definition,
          executionContexts: definition.executionContexts.map((context) =>
            context.id === "context-plan"
              ? { ...context, outputSchema: PLAN_SCHEMA }
              : context,
          ),
        },
      }),
      NOW,
    );

    const reloaded = reloadAfterRestart();
    expect(reloaded.contextOutputs).toEqual({});
    expect(getContextOutput(reloaded, "context-plan")).toEqual({
      kind: "pending",
      outputSchema: PLAN_SCHEMA,
    });
  });
});
