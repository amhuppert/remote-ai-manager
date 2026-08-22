import { describe, expect, it } from "vitest";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { deriveContextHeader } from "./context-header-model";

function executionWithPlacement(
  placement: ContextPlacement,
): GraphWorkflowExecution {
  const base = createResolvedWorkflowDefinition();
  return createWorkflowExecution({
    status: "running",
    workingDefinition: {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-implement"
          ? { ...context, placement }
          : context,
      ),
    },
  });
}

describe("deriveContextHeader", () => {
  it("names the context, its lane, its grade with owned paths and its iteration", () => {
    const execution = executionWithPlacement({
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["src/checkout", "src/risk"],
    });
    const state = execution.contextStates["context-implement"]!;
    const withIteration: GraphWorkflowExecution = {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-implement": {
          ...state,
          status: "running",
          iterationCount: 2,
        },
      },
      activeContextIds: ["context-implement"],
    };

    const header = deriveContextHeader(withIteration, "context-implement");

    expect(header).not.toBeNull();
    expect(header?.title).toBe("Implement");
    expect(header?.status.label).toBe("Running");
    expect(header?.metaParts).toEqual([
      "context-implement",
      "lane delivery",
      "owning src/checkout, src/risk",
      "iteration 2",
    ]);
  });

  it("states a full-grade context without inventing paths it does not own", () => {
    const header = deriveContextHeader(
      executionWithPlacement({ lane: "delivery", mode: "full" }),
      "context-implement",
    );

    expect(header?.metaParts[2]).toBe("full");
  });

  it("calls the reserved session lane by its name", () => {
    const header = deriveContextHeader(
      executionWithPlacement({ lane: "__session__", mode: "readOnly" }),
      "context-implement",
    );

    expect(header?.metaParts[1]).toBe("lane session");
    expect(header?.metaParts[2]).toBe("read-only");
  });

  it("carries no loop chip for a context outside every loop", () => {
    const header = deriveContextHeader(
      createWorkflowExecution(),
      "context-implement",
    );

    expect(header?.loopLabel).toBeNull();
  });

  it("returns nothing for a context the working definition does not hold", () => {
    expect(deriveContextHeader(createWorkflowExecution(), "ghost")).toBeNull();
  });
});
