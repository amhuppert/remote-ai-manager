import { describe, expect, it } from "vitest";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { evaluateLaneDrop, laneDropPreviewLabel } from "./lane-drop";
import { createWorkflowDefinition } from "./test-fixtures";

/**
 * The canonical bundle fixture (README §3.2): six contexts across `plan`,
 * `candidate-rules`, `delivery` and the reserved `session` lane, kept in the
 * dependency order the fixture states so lane concurrency is exact.
 */
function fixture(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  const base = createWorkflowDefinition();
  const context = (
    id: string,
    title: string,
    placement: WorkflowSemanticDefinition["executionContexts"][number]["placement"],
    extra: Partial<
      WorkflowSemanticDefinition["executionContexts"][number]
    > = {},
  ): WorkflowSemanticDefinition["executionContexts"][number] => ({
    id,
    title,
    acceptanceCriteria: `${title} is done`,
    placement,
    ...extra,
  });

  return {
    ...base,
    executionContexts: [
      context("ctx_plan", "Plan the migration", { lane: "plan", mode: "full" }),
      context("ctx_rules", "Evaluate rules engine", {
        lane: "candidate-rules",
        mode: "owned",
        ownedPaths: ["docs/eval"],
      }),
      context("ctx_checkout", "Implement checkout", {
        lane: "delivery",
        mode: "owned",
        ownedPaths: ["src/checkout", "src/risk"],
      }),
      context("ctx_settings", "Settings surface", {
        lane: "delivery",
        mode: "owned",
        ownedPaths: ["src/settings"],
      }),
      context("ctx_rollout", "Rollout switch", {
        lane: "delivery",
        mode: "full",
      }),
      context(
        "ctx_notes",
        "Release notes",
        { lane: "session", mode: "readOnly" },
        {
          // A read-only context delivers through its output contract alone, so
          // the fixture declares one rather than carrying a standing error.
          outputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        },
      ),
    ],
    tasks: [],
    edges: [
      {
        id: "edge-plan-rules",
        sourceContextId: "ctx_plan",
        targetContextId: "ctx_rules",
      },
      {
        id: "edge-rules-checkout",
        sourceContextId: "ctx_rules",
        targetContextId: "ctx_checkout",
      },
      {
        id: "edge-checkout-settings",
        sourceContextId: "ctx_checkout",
        targetContextId: "ctx_settings",
      },
      {
        id: "edge-settings-rollout",
        sourceContextId: "ctx_settings",
        targetContextId: "ctx_rollout",
      },
      {
        id: "edge-rollout-notes",
        sourceContextId: "ctx_rollout",
        targetContextId: "ctx_notes",
      },
    ],
    ...overrides,
  };
}

function placementOf(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): WorkflowSemanticDefinition["executionContexts"][number]["placement"] {
  const context = definition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) throw new Error(`no context ${contextId}`);
  return context.placement;
}

describe("laneDropPreviewLabel", () => {
  it("names the target lane, the carried grade with its paths, and that the grade is unchanged", () => {
    expect(laneDropPreviewLabel(fixture(), "ctx_checkout", "delivery")).toBe(
      "Re-place → lane: delivery · grade: owned (src/checkout, src/risk) · unchanged",
    );
  });

  it("spells a read-only grade the way every other surface does", () => {
    expect(laneDropPreviewLabel(fixture(), "ctx_notes", "delivery")).toBe(
      "Re-place → lane: delivery · grade: read-only · unchanged",
    );
  });

  it("names a full grade without paths", () => {
    expect(laneDropPreviewLabel(fixture(), "ctx_rollout", "plan")).toBe(
      "Re-place → lane: plan · grade: full · unchanged",
    );
  });
});

describe("evaluateLaneDrop — valid drop", () => {
  it("writes only that context's placement.lane and carries the grade verbatim", () => {
    const definition = fixture();
    const result = evaluateLaneDrop({
      definition,
      contextId: "ctx_notes",
      targetLane: "delivery",
    });

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;

    expect(placementOf(result.definition, "ctx_notes")).toEqual({
      lane: "delivery",
      mode: "readOnly",
    });
    // Every other context, and every other field of this one, is untouched.
    expect({
      ...result.definition,
      executionContexts: result.definition.executionContexts.filter(
        (context) => context.id !== "ctx_notes",
      ),
    }).toEqual({
      ...definition,
      executionContexts: definition.executionContexts.filter(
        (context) => context.id !== "ctx_notes",
      ),
    });
  });

  it("carries owned paths across verbatim", () => {
    const result = evaluateLaneDrop({
      definition: fixture(),
      contextId: "ctx_checkout",
      targetLane: "candidate-rules-2",
    });

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(placementOf(result.definition, "ctx_checkout")).toEqual({
      lane: "candidate-rules-2",
      mode: "owned",
      ownedPaths: ["src/checkout", "src/risk"],
    });
  });

  it("never mutates the definition it was handed", () => {
    const definition = fixture();
    const before = JSON.stringify(definition);
    evaluateLaneDrop({
      definition,
      contextId: "ctx_notes",
      targetLane: "delivery",
    });
    expect(JSON.stringify(definition)).toBe(before);
  });

  it("reports a drop onto the context's own lane as unchanged", () => {
    const result = evaluateLaneDrop({
      definition: fixture(),
      contextId: "ctx_checkout",
      targetLane: "delivery",
    });
    expect(result.outcome).toBe("unchanged");
  });

  it("accepts a drop even while the draft carries an unrelated pre-existing error", () => {
    const definition = fixture();
    const broken: WorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "ctx_plan"
          ? { ...context, acceptanceCriteria: "" }
          : context,
      ),
    };

    const result = evaluateLaneDrop({
      definition: broken,
      contextId: "ctx_notes",
      targetLane: "delivery",
    });
    expect(result.outcome).toBe("accepted");
  });
});

describe("evaluateLaneDrop — refusals", () => {
  it("refuses a write-capable context on the reserved session lane, naming the grade and the remedy", () => {
    const definition = fixture();
    const result = evaluateLaneDrop({
      definition,
      contextId: "ctx_checkout",
      targetLane: "session",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.reason).toBe(
      '"session" admits only read-only contexts. "Implement checkout" is owning (src/checkout, src/risk).',
    );
    expect(result.remedy).toBe(
      "Change its grade to read-only, or drop it on a group lane.",
    );
    // A refusal carries no post-drop draft: there is nothing to apply.
    expect("definition" in result).toBe(false);
  });

  it("refuses the engine's internal session id and says how the session lane is authored", () => {
    const result = evaluateLaneDrop({
      definition: fixture(),
      contextId: "ctx_notes",
      targetLane: "__session__",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.reason).toContain("__session__");
    expect(result.remedy).toContain('"session"');
  });

  it("refuses a lane name the branch and worktree grammar rejects", () => {
    const result = evaluateLaneDrop({
      definition: fixture(),
      contextId: "ctx_notes",
      targetLane: "release train",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.reason).toContain("release train");
    expect(result.reason).toContain("/^[A-Za-z0-9_.-]+$/");
    expect(result.remedy).toContain("branch");
  });

  it("refuses a drop that makes two unordered members claim overlapping owned paths, naming the overlap", () => {
    const definition = fixture();
    // `ctx_rules` owns `docs/eval` and is upstream of nothing on `plan`, so
    // moving it beside an unordered owner of the same prefix creates the clash.
    const overlapping: WorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "ctx_plan"
          ? {
              ...context,
              placement: {
                lane: "plan",
                mode: "owned" as const,
                ownedPaths: ["docs/eval"],
              },
            }
          : context,
      ),
      edges: definition.edges.filter(
        (edge) =>
          edge.id !== "edge-plan-rules" && edge.id !== "edge-rules-checkout",
      ),
    };

    const result = evaluateLaneDrop({
      definition: overlapping,
      contextId: "ctx_rules",
      targetLane: "plan",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.reason).toContain("docs/eval");
    expect(result.remedy).toContain("disjoint");
  });

  it("refuses a full-access member that would share a lane with an unordered write-capable member", () => {
    const definition = fixture();
    const unordered: WorkflowSemanticDefinition = {
      ...definition,
      edges: definition.edges.filter(
        (edge) => edge.id !== "edge-settings-rollout",
      ),
    };

    const result = evaluateLaneDrop({
      definition: unordered,
      contextId: "ctx_plan",
      targetLane: "delivery",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.reason).toContain("delivery");
    expect(result.remedy).toContain("dependency");
  });

  it("refuses a read-only context with no output contract, even though the draft was already invalid that way", () => {
    const definition = fixture();
    const contractless: WorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "ctx_notes"
          ? { ...context, outputSchema: undefined }
          : context,
      ),
    };

    const result = evaluateLaneDrop({
      definition: contractless,
      contextId: "ctx_notes",
      targetLane: "delivery",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.reason).toContain("Release notes");
    expect(result.reason).toContain("output contract");
    expect(result.remedy).toContain("outputSchema");
  });

  it("still accepts a drop when the dragged context's own pre-existing error is not about placement", () => {
    const definition = fixture();
    const untitled: WorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "ctx_notes"
          ? { ...context, acceptanceCriteria: "" }
          : context,
      ),
    };

    const result = evaluateLaneDrop({
      definition: untitled,
      contextId: "ctx_notes",
      targetLane: "delivery",
    });
    expect(result.outcome).toBe("accepted");
  });

  it("refuses a context it cannot find rather than inventing a placement", () => {
    const result = evaluateLaneDrop({
      definition: fixture(),
      contextId: "ctx_missing",
      targetLane: "delivery",
    });
    expect(result.outcome).toBe("refused");
  });
});

describe("evaluateLaneDrop — exclusive-occupancy notice", () => {
  /**
   * `ctx_settings` owns `src/settings` on `delivery` alone; the two contexts
   * that may join it both run after it, so a drop is legal and the only
   * question the lane raises is occupancy.
   */
  function joinerFixture(): WorkflowSemanticDefinition {
    const base = fixture();
    return {
      ...base,
      executionContexts: base.executionContexts
        .filter((context) =>
          ["ctx_settings", "ctx_rollout", "ctx_notes"].includes(context.id),
        )
        .map((context) =>
          context.id === "ctx_rollout"
            ? {
                ...context,
                placement: { lane: "spare", mode: "full" as const },
              }
            : context,
        ),
      edges: [
        {
          id: "edge-settings-rollout",
          sourceContextId: "ctx_settings",
          targetContextId: "ctx_rollout",
        },
        {
          id: "edge-settings-notes",
          sourceContextId: "ctx_settings",
          targetContextId: "ctx_notes",
        },
      ],
    };
  }

  it("accepts a second full-grade member and says it waits for exclusive occupancy", () => {
    const result = evaluateLaneDrop({
      definition: joinerFixture(),
      contextId: "ctx_rollout",
      targetLane: "delivery",
    });

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.notice).toContain("exclusive occupancy");
    expect(result.notice).toContain("delivery");
    expect(result.notice).toContain("Rollout switch");
  });

  it("says nothing about occupancy for a lane with one write-capable member", () => {
    const result = evaluateLaneDrop({
      definition: joinerFixture(),
      contextId: "ctx_notes",
      targetLane: "delivery",
    });

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.notice).toBeNull();
  });
});
