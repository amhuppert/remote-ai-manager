import { describe, expect, it } from "vitest";
import type { WorkflowGraphValidationError } from "@/lib/workflow-graph/definition-schemas";
import {
  routeValidationError,
  validationErrorFieldLabel,
  validationErrorRowLabel,
} from "./validation-error-routing";

function error(
  partial: Partial<WorkflowGraphValidationError> & { code: string },
): WorkflowGraphValidationError {
  return { message: "boom", ...partial };
}

describe("routeValidationError", () => {
  it("routes a placement code to the raising context's Placement screen", () => {
    expect(
      routeValidationError(
        error({
          code: "placement-lane-name-invalid",
          contextId: "ctx_notes",
          field: "executionContexts.0.placement.lane",
        }),
      ),
    ).toEqual({
      contextId: "ctx_notes",
      scope: "context",
      screenPath: ["placement"],
    });
  });

  // The remedy for a missing read-only output contract is declaring the schema,
  // so the row opens the editor that declares it rather than the placement it
  // was raised from.
  it("routes the read-only output-contract code to the Output schema screen", () => {
    expect(
      routeValidationError(
        error({
          code: "placement-readonly-missing-output-schema",
          contextId: "ctx_notes",
          field: "executionContexts.0.outputSchema",
        }),
      ),
    ).toEqual({
      contextId: "ctx_notes",
      scope: "context",
      screenPath: ["brief", "schema"],
    });
  });

  it("routes an unsupported output schema to the Output schema screen", () => {
    expect(
      routeValidationError(
        error({ code: "unsupported-output-schema", contextId: "ctx_checkout" }),
      ).screenPath,
    ).toEqual(["brief", "schema"]);
  });

  it("routes context identity codes to the Brief screen", () => {
    for (const code of [
      "empty-context-title",
      "empty-context-acceptance-criteria",
      "duplicate-context-id",
    ]) {
      expect(
        routeValidationError(error({ code, contextId: "ctx_plan" })),
      ).toEqual({
        contextId: "ctx_plan",
        scope: "context",
        screenPath: ["brief"],
      });
    }
  });

  it("routes a task code to that task's detail screen", () => {
    expect(
      routeValidationError(
        error({
          code: "empty-task-instructions",
          contextId: "ctx_plan",
          taskId: "task-1",
        }),
      ),
    ).toEqual({
      contextId: "ctx_plan",
      scope: "context",
      screenPath: ["tasks", "task:task-1"],
    });
  });

  it("stops at the Tasks list when the task code names no task", () => {
    expect(
      routeValidationError(
        error({ code: "duplicate-task-order", contextId: "ctx_plan" }),
      ).screenPath,
    ).toEqual(["tasks"]);
  });

  it("routes parameter codes to the workflow's Launch parameters screen", () => {
    expect(
      routeValidationError(
        error({
          code: "undeclared-parameter-reference",
          field: "tasks[0].instructions",
          parameterName: "feature",
        }),
      ),
    ).toEqual({
      contextId: null,
      scope: "workflow",
      screenPath: ["params"],
    });
    expect(
      routeValidationError(error({ code: "duplicate-parameter-name" }))
        .screenPath,
    ).toEqual(["params"]);
  });

  // The same lint code fires on charter prose, where the offending text is not
  // reachable from the parameters screen.
  it("routes a placeholder lint on a charter field to the Charter screen", () => {
    expect(
      routeValidationError(
        error({ code: "invalid-placeholder-token", field: "charter.mission" }),
      ),
    ).toEqual({
      contextId: null,
      scope: "workflow",
      screenPath: ["charter"],
    });
  });

  it("routes charter scope codes to the Charter screen", () => {
    for (const code of [
      "unknown-invariant-scope-context",
      "unknown-source-scope-context",
      "retired-source-access-policy",
      "legacy-source-applies-to",
    ]) {
      expect(routeValidationError(error({ code })).screenPath).toEqual([
        "charter",
      ]);
    }
  });

  it("routes cohort codes to their agent and gate screens", () => {
    expect(
      routeValidationError(
        error({
          code: "implementer-effort-unsupported",
          contextId: "ctx_plan",
        }),
      ),
    ).toEqual({
      contextId: "ctx_plan",
      scope: "context",
      screenPath: ["agents", "implementer"],
    });
    expect(
      routeValidationError(
        error({ code: "validator-effort-unsupported", contextId: "ctx_plan" }),
      ).screenPath,
    ).toEqual(["gates", "validator"]);
  });

  // The write-restriction check runs at both tiers; only the context tier's
  // errors name a context, and the workflow tier's cohort screen is its own.
  it("routes the workflow-tier cohort code to the workflow scope", () => {
    expect(
      routeValidationError(
        error({
          code: "validator-write-restriction-unsupported",
          field: "workflowConfig.contextValidator.assignments.0.agent.backend",
        }),
      ),
    ).toEqual({
      contextId: null,
      scope: "workflow",
      screenPath: ["gates", "validator"],
    });
  });

  // Graph-shape errors have no screen: the edge that raised them is edited on
  // the canvas, so the row selects nothing and leaves the panel at its root.
  it("leaves structural graph codes at the panel root", () => {
    for (const code of ["cycle-detected", "unknown-edge-source"]) {
      expect(routeValidationError(error({ code }))).toEqual({
        contextId: null,
        scope: "workflow",
        screenPath: [],
      });
    }
  });

  it("opens an unmapped code at the raising context's root", () => {
    expect(
      routeValidationError(
        error({ code: "some-future-code", contextId: "ctx_plan" }),
      ),
    ).toEqual({
      contextId: "ctx_plan",
      scope: "context",
      screenPath: [],
    });
  });

  it("falls back to the workflow root when a context code names no context", () => {
    expect(
      routeValidationError(error({ code: "empty-context-title" })),
    ).toEqual({
      contextId: null,
      scope: "workflow",
      screenPath: [],
    });
  });
});

describe("validationErrorFieldLabel", () => {
  it("drops collection indices and the collection name", () => {
    expect(
      validationErrorFieldLabel(
        error({ code: "x", field: "executionContexts.0.outputSchema" }),
      ),
    ).toBe("outputSchema");
    expect(
      validationErrorFieldLabel(
        error({ code: "x", field: "executionContexts.0.placement.lane" }),
      ),
    ).toBe("placement.lane");
    expect(
      validationErrorFieldLabel(
        error({ code: "x", field: "tasks[0].instructions" }),
      ),
    ).toBe("instructions");
  });

  it("keeps a charter locator whole", () => {
    expect(
      validationErrorFieldLabel(error({ code: "x", field: "charter.mission" })),
    ).toBe("charter.mission");
  });

  it("names the code when the error carries no field", () => {
    expect(validationErrorFieldLabel(error({ code: "cycle-detected" }))).toBe(
      "cycle-detected",
    );
  });
});

describe("validationErrorRowLabel", () => {
  it("reads as context · field — message", () => {
    expect(
      validationErrorRowLabel(
        error({
          code: "placement-readonly-missing-output-schema",
          contextId: "ctx_notes",
          field: "executionContexts.5.outputSchema",
          message: "a read-only context must declare an output contract",
        }),
      ),
    ).toBe(
      "ctx_notes · outputSchema — a read-only context must declare an output contract",
    );
  });

  it("names the workflow when the error belongs to no context", () => {
    expect(
      validationErrorRowLabel(
        error({
          code: "undeclared-parameter-reference",
          field: "tasks[2].instructions",
          message: "references an undeclared parameter",
        }),
      ),
    ).toBe("workflow · instructions — references an undeclared parameter");
  });
});
