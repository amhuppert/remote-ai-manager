import { describe, expect, it } from "vitest";

import {
  emptyDeliveryPlanDocument,
  type DeliveryPlanDocument,
} from "@/lib/specs/delivery-plan";

import { deliveryPlanGraph } from "./delivery-plan-graph";

function context(
  contextId: string,
  criterionElementIds: readonly string[] = [],
  contextType: DeliveryPlanDocument["contexts"][number]["contextType"] = "delivery",
): DeliveryPlanDocument["contexts"][number] {
  return {
    contextId,
    title: `Context ${contextId}`,
    contextType,
    criterionElementIds: [...criterionElementIds],
    acceptanceContract: [`${contextId} is observable.`],
    proofPlan: [],
  };
}

function task(
  taskId: string,
  contextId: string,
  order: number,
): DeliveryPlanDocument["tasks"][number] {
  return {
    taskId,
    contextId,
    title: `Task ${taskId}`,
    instructions: `Do ${taskId}.`,
    order,
    contributesToCriterionElementIds: [],
  };
}

function edge(
  fromContextId: string,
  toContextId: string,
): DeliveryPlanDocument["edges"][number] {
  return {
    edgeId: `${fromContextId}->${toContextId}`,
    fromContextId,
    toContextId,
  };
}

/** A diamond: one root, two parallel middles, one join. */
function diamond(): DeliveryPlanDocument {
  return {
    ...emptyDeliveryPlanDocument(),
    contexts: [
      context("a", ["c-1", "c-2"]),
      context("b", ["c-3"]),
      context("c", []),
      context("d", [], "closeout"),
    ],
    tasks: [task("t1", "a", 0), task("t2", "a", 1), task("t3", "b", 0)],
    edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
  };
}

describe("deliveryPlanGraph", () => {
  it("ranks each context one layer past its deepest dependency", () => {
    const graph = deliveryPlanGraph(diamond());

    expect(
      graph.ranks.map((rank) => rank.map((node) => node.contextId)),
    ).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("carries the owned-criterion and task counts each node renders", () => {
    const graph = deliveryPlanGraph(diamond());
    const nodes = graph.ranks.flat();

    expect(
      nodes.map((node) => ({
        contextId: node.contextId,
        ownedCriterionCount: node.ownedCriterionCount,
        taskCount: node.taskCount,
        contextType: node.contextType,
      })),
    ).toEqual([
      {
        contextId: "a",
        ownedCriterionCount: 2,
        taskCount: 2,
        contextType: "delivery",
      },
      {
        contextId: "b",
        ownedCriterionCount: 1,
        taskCount: 1,
        contextType: "delivery",
      },
      {
        contextId: "c",
        ownedCriterionCount: 0,
        taskCount: 0,
        contextType: "delivery",
      },
      {
        contextId: "d",
        ownedCriterionCount: 0,
        taskCount: 0,
        contextType: "closeout",
      },
    ]);
  });

  it("gives every context its incoming dependency list", () => {
    const graph = deliveryPlanGraph(diamond());
    const join = graph.ranks.flat().find((node) => node.contextId === "d");

    expect(join?.dependsOnContextIds).toEqual(["b", "c"]);
  });

  /**
   * Plan lint refuses a cycle, but the review surface renders a draft that
   * still has one. Laying the cycle out in a trailing rank keeps the graph
   * drawable — dropping the contexts would hide the very thing the reviewer
   * has to fix.
   */
  it("lays out a cyclic draft in a trailing rank instead of looping", () => {
    const cyclic: DeliveryPlanDocument = {
      ...emptyDeliveryPlanDocument(),
      contexts: [context("a"), context("b"), context("c")],
      edges: [edge("a", "b"), edge("b", "c"), edge("c", "b")],
    };

    const graph = deliveryPlanGraph(cyclic);

    expect(
      graph.ranks
        .flat()
        .map((node) => node.contextId)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(graph.cyclicContextIds).toEqual(["b", "c"]);
  });

  /**
   * An edge naming a context the document does not carry is authored breakage
   * the reviewer must see, so it is reported rather than silently skipped.
   */
  it("reports an edge whose endpoint no context defines", () => {
    const broken: DeliveryPlanDocument = {
      ...emptyDeliveryPlanDocument(),
      contexts: [context("a")],
      edges: [edge("a", "ghost")],
    };

    const graph = deliveryPlanGraph(broken);

    expect(graph.danglingEdges).toEqual([
      { edgeId: "a->ghost", fromContextId: "a", toContextId: "ghost" },
    ]);
    expect(graph.ranks.flat().map((node) => node.contextId)).toEqual(["a"]);
  });

  it("renders a plan with no edges as a single rank", () => {
    const flat: DeliveryPlanDocument = {
      ...emptyDeliveryPlanDocument(),
      contexts: [context("a"), context("b")],
    };

    expect(
      deliveryPlanGraph(flat).ranks.map((rank) =>
        rank.map((node) => node.contextId),
      ),
    ).toEqual([["a", "b"]]);
  });
});
