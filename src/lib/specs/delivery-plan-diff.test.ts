import { describe, expect, it } from "vitest";

import {
  emptyDeliveryPlanDocument,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import { deliveryPlanDocumentDiff } from "./delivery-plan-diff";

function baseDocument(): DeliveryPlanDocument {
  return {
    ...emptyDeliveryPlanDocument(),
    dispositions: [
      {
        criterionElementId: "c-1",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
      {
        criterionElementId: "c-2",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ],
    contexts: [
      {
        contextId: "ctx-a",
        title: "Author the document",
        contextType: "delivery",
        criterionElementIds: ["c-1"],
        acceptanceContract: ["The document persists."],
        proofPlan: [],
      },
      {
        contextId: "ctx-b",
        title: "Close out",
        contextType: "closeout",
        criterionElementIds: [],
        acceptanceContract: ["The shim is gone."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "t-1",
        contextId: "ctx-a",
        title: "Add the table",
        instructions: "Write the DDL and the migration.",
        order: 0,
        contributesToCriterionElementIds: ["c-1"],
      },
    ],
    edges: [{ edgeId: "e-1", fromContextId: "ctx-a", toContextId: "ctx-b" }],
  };
}

describe("deliveryPlanDocumentDiff", () => {
  it("classifies an unchanged document as changing nothing", () => {
    const diff = deliveryPlanDocumentDiff(baseDocument(), baseDocument());

    expect(
      diff.contexts.every((context) => context.class === "unchanged"),
    ).toBe(true);
    expect(diff.dispositions).toEqual([]);
  });

  it("reports an added and a removed context", () => {
    const target = baseDocument();
    target.contexts = [
      target.contexts[0]!,
      {
        contextId: "ctx-c",
        title: "Integrate",
        contextType: "integration",
        criterionElementIds: [],
        acceptanceContract: ["The surfaces compose."],
        proofPlan: [],
      },
    ];
    target.edges = [];

    const diff = deliveryPlanDocumentDiff(baseDocument(), target);

    expect(
      diff.contexts.map((context) => [context.contextId, context.class]),
    ).toEqual([
      ["ctx-a", "changed"],
      ["ctx-b", "removed"],
      ["ctx-c", "added"],
    ]);
  });

  it("names the title, contract, ownership, and task aspects that moved", () => {
    const target = baseDocument();
    target.contexts[0] = {
      ...target.contexts[0]!,
      title: "Author the attempt document",
      criterionElementIds: ["c-1", "c-2"],
      acceptanceContract: ["The document persists with round-trip coverage."],
    };
    target.tasks = [
      { ...target.tasks[0]!, instructions: "Write the DDL, floor, migration." },
    ];

    const diff = deliveryPlanDocumentDiff(baseDocument(), target);
    const changed = diff.contexts.find(
      (context) => context.contextId === "ctx-a",
    );

    expect(changed?.class).toBe("changed");
    expect(changed?.changed).toEqual([
      "title",
      "acceptance_contract",
      "criterion_ownership",
      "tasks",
    ]);
  });

  /**
   * An edge belongs to both of its endpoints, so a reader looking at either
   * context has to see that its position in the graph moved.
   */
  it("attributes an edge change to both endpoint contexts", () => {
    const target = baseDocument();
    target.edges = [
      { edgeId: "e-1", fromContextId: "ctx-b", toContextId: "ctx-a" },
    ];

    const diff = deliveryPlanDocumentDiff(baseDocument(), target);

    expect(
      diff.contexts
        .filter((context) => context.changed.includes("edges"))
        .map((context) => context.contextId),
    ).toEqual(["ctx-a", "ctx-b"]);
  });

  it("reports a context whose declared type changed", () => {
    const target = baseDocument();
    target.contexts[1] = { ...target.contexts[1]!, contextType: "integration" };

    const diff = deliveryPlanDocumentDiff(baseDocument(), target);

    expect(
      diff.contexts.find((context) => context.contextId === "ctx-b")?.changed,
    ).toEqual(["context_type"]);
  });

  it("reports every disposition that moved, added, or disappeared", () => {
    const target = baseDocument();
    target.dispositions = [
      { ...target.dispositions[0]!, disposition: "deferred" },
      {
        criterionElementId: "c-3",
        disposition: "waived",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ];

    const diff = deliveryPlanDocumentDiff(baseDocument(), target);

    expect(diff.dispositions).toEqual([
      { criterionElementId: "c-1", from: "selected", to: "deferred" },
      { criterionElementId: "c-2", from: "pending_reaffirmation", to: null },
      { criterionElementId: "c-3", from: null, to: "waived" },
    ]);
  });
});
