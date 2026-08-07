import { describe, expect, it } from "vitest";
import { findCriteriaWithoutMustRunCoverage } from "./criterion-coverage";
import type {
  RouteProjectionContext,
  RouteProjectionEdge,
} from "./route-projection";

const CLASSIFIER_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["ship", "hold"] } },
  required: ["verdict"],
};

const SHIP_GUARD = {
  schema: {
    type: "object",
    properties: { verdict: { const: "ship" } },
    required: ["verdict"],
  },
};

function contexts(...ids: string[]): RouteProjectionContext[] {
  return ids.map((id) =>
    id === "classify" ? { id, outputSchema: CLASSIFIER_SCHEMA } : { id },
  );
}

function edge(
  sourceContextId: string,
  targetContextId: string,
  when?: RouteProjectionEdge["when"],
): RouteProjectionEdge {
  return {
    id: `${sourceContextId}__${targetContextId}`,
    sourceContextId,
    targetContextId,
    ...(when === undefined ? {} : { when }),
  };
}

describe("findCriteriaWithoutMustRunCoverage — R5.1/R5.2", () => {
  it("finds no gap when a covering context runs on every path", () => {
    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify", "implement"),
        edges: [edge("classify", "implement")],
        coverageByCriterionId: { "criterion-1": ["implement"] },
      }),
    ).toEqual([]);
  });

  it("reports a criterion whose only covering context carries a direct guard", () => {
    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify", "ship"),
        edges: [edge("classify", "ship", SHIP_GUARD)],
        coverageByCriterionId: { "criterion-1": ["ship"] },
      }),
    ).toEqual([{ criterionId: "criterion-1", coveringContextIds: ["ship"] }]);
  });

  it("reports a criterion covered only downstream of a conditional ancestor", () => {
    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify", "ship", "announce"),
        edges: [edge("classify", "ship", SHIP_GUARD), edge("ship", "announce")],
        coverageByCriterionId: { "criterion-1": ["announce"] },
      }),
    ).toEqual([
      { criterionId: "criterion-1", coveringContextIds: ["announce"] },
    ]);
  });

  it("accepts a criterion once any one of its covering contexts is must-run", () => {
    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify", "ship", "audit"),
        edges: [
          edge("classify", "ship", SHIP_GUARD),
          edge("classify", "audit"),
        ],
        coverageByCriterionId: { "criterion-1": ["ship", "audit"] },
      }),
    ).toEqual([]);
  });

  it("reports a criterion with no covering context at all", () => {
    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify", "implement"),
        edges: [edge("classify", "implement")],
        coverageByCriterionId: { "criterion-1": [] },
      }),
    ).toEqual([{ criterionId: "criterion-1", coveringContextIds: [] }]);
  });

  it("reports a criterion whose covering context is not in the graph", () => {
    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify", "implement"),
        edges: [edge("classify", "implement")],
        coverageByCriterionId: { "criterion-1": ["removed"] },
      }),
    ).toEqual([
      { criterionId: "criterion-1", coveringContextIds: ["removed"] },
    ]);
  });

  it("reads only own criterion entries", () => {
    const coverageByCriterionId = Object.create({
      inherited: ["implement"],
    }) as Record<string, string[]>;
    coverageByCriterionId["criterion-1"] = ["implement"];

    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify", "implement"),
        edges: [edge("classify", "implement")],
        coverageByCriterionId,
      }),
    ).toEqual([]);
  });

  it("returns nothing for an empty coverage map", () => {
    expect(
      findCriteriaWithoutMustRunCoverage({
        executionContexts: contexts("classify"),
        edges: [],
        coverageByCriterionId: {},
      }),
    ).toEqual([]);
  });
});
