import { describe, expect, it } from "vitest";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { LaneBandBox } from "@/lib/workflow-graph/lane-band-geometry";
import { createWorkflowDefinition } from "@/lib/workflow-graph/test-fixtures";
import {
  laneDropCalloutFor,
  resolveLaneChoiceDrop,
  resolveLaneDragDrop,
  resolveLaneDragHover,
  type LaneDragOrigin,
} from "./lane-drag";

/** Two lanes, one member each: the smallest graph a lane crossing needs. */
function definition(): WorkflowSemanticDefinition {
  return {
    ...createWorkflowDefinition(),
    executionContexts: [
      {
        id: "ctx_checkout",
        title: "Implement checkout",
        acceptanceCriteria: "Checkout works",
        placement: {
          lane: "delivery",
          mode: "owned",
          ownedPaths: ["src/checkout"],
        },
      },
      {
        id: "ctx_notes",
        title: "Release notes",
        acceptanceCriteria: "Notes are written",
        placement: { lane: "session", mode: "readOnly" },
        outputSchema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    ],
    tasks: [],
    edges: [],
  };
}

const boxes: LaneBandBox[] = [
  { laneName: "delivery", x: 0, y: 0, width: 900, height: 200 },
  { laneName: "session", x: 0, y: 220, width: 900, height: 200 },
];

const SIZE = { width: 264, height: 170 };

function origin(contextId: string, lane: string, y: number): LaneDragOrigin {
  return { contextId, lane, position: { x: 200, y }, size: SIZE };
}

describe("resolveLaneDragHover", () => {
  it("reports no crossing while the node stays inside its own band", () => {
    const hover = resolveLaneDragHover({
      definition: definition(),
      boxes,
      origin: origin("ctx_notes", "session", 240),
      position: { x: 420, y: 250 },
    });

    expect(hover).toEqual({ targetLane: null, evaluation: null });
  });

  it("names the band the node is over and previews the pending change", () => {
    const hover = resolveLaneDragHover({
      definition: definition(),
      boxes,
      origin: origin("ctx_notes", "session", 240),
      position: { x: 420, y: 20 },
    });

    expect(hover.targetLane).toBe("delivery");
    expect(hover.evaluation?.outcome).toBe("accepted");
    expect(hover.evaluation?.previewLabel).toBe(
      "Re-place → lane: delivery · grade: read-only · unchanged",
    );
  });

  it("reports a band that cannot accept the context as refused", () => {
    const hover = resolveLaneDragHover({
      definition: definition(),
      boxes,
      origin: origin("ctx_checkout", "delivery", 20),
      position: { x: 420, y: 240 },
    });

    expect(hover.targetLane).toBe("session");
    expect(hover.evaluation?.outcome).toBe("refused");
  });

  it("reports no crossing in the gutter between two bands", () => {
    const hover = resolveLaneDragHover({
      definition: definition(),
      boxes,
      origin: origin("ctx_notes", "session", 240),
      // Node top at 130 puts its centre at 215 — between the two bands.
      position: { x: 420, y: 130 },
    });

    expect(hover.targetLane).toBeNull();
  });
});

describe("resolveLaneDragDrop", () => {
  it("keeps a within-lane drag layout-only", () => {
    const drop = resolveLaneDragDrop({
      definition: definition(),
      boxes,
      origin: origin("ctx_notes", "session", 240),
      position: { x: 500, y: 250 },
    });

    expect(drop).toEqual({ kind: "layout" });
  });

  it("keeps a drag dropped outside every band layout-only", () => {
    const drop = resolveLaneDragDrop({
      definition: definition(),
      boxes,
      origin: origin("ctx_notes", "session", 240),
      position: { x: 500, y: 2000 },
    });

    expect(drop).toEqual({ kind: "layout" });
  });

  it("re-places the context on a valid cross-lane drop", () => {
    const drop = resolveLaneDragDrop({
      definition: definition(),
      boxes,
      origin: origin("ctx_notes", "session", 240),
      position: { x: 500, y: 20 },
    });

    expect(drop.kind).toBe("replace");
    if (drop.kind !== "replace") return;
    expect(
      drop.definition.executionContexts.find(
        (context) => context.id === "ctx_notes",
      )?.placement,
    ).toEqual({ lane: "delivery", mode: "readOnly" });
    expect(drop.notice).toBeNull();
  });

  it("refuses an invalid cross-lane drop with the reason and the remedy", () => {
    const source = definition();
    const drop = resolveLaneDragDrop({
      definition: source,
      boxes,
      origin: origin("ctx_checkout", "delivery", 20),
      position: { x: 500, y: 240 },
    });

    expect(drop.kind).toBe("refused");
    if (drop.kind !== "refused") return;
    expect(drop.reason).toContain("admits only read-only contexts");
    expect(drop.remedy).toContain("read-only");
    // The refusal carries no draft, so nothing downstream can write one.
    expect("definition" in drop).toBe(false);
  });
});

// README §12 — touch re-placement names its lane instead of dropping on it, and
// gets the same verdict for it. These assert the SAME outcomes the drag tests
// above assert, reached by name, so a divergence between the two routes fails
// here rather than on a phone.
describe("resolveLaneChoiceDrop", () => {
  it("re-places the context on a lane chosen by name", () => {
    const drop = resolveLaneChoiceDrop(definition(), "ctx_notes", "delivery");

    expect(drop).toMatchObject({ kind: "replace", targetLane: "delivery" });
    if (drop.kind !== "replace") throw new Error("expected a replacement");
    expect(
      drop.definition.executionContexts.find(
        (context) => context.id === "ctx_notes",
      )?.placement,
    ).toEqual({ lane: "delivery", mode: "readOnly" });
  });

  it("refuses an illegal choice with the drag's reason and remedy", () => {
    const drop = resolveLaneChoiceDrop(definition(), "ctx_checkout", "session");

    expect(drop.kind).toBe("refused");
    if (drop.kind !== "refused") throw new Error("expected a refusal");
    expect(drop.reason).toContain("admits only read-only contexts");
    expect(drop.remedy).toContain("read-only");
    expect("definition" in drop).toBe(false);
  });

  it("writes nothing when the chosen lane is the one already declared", () => {
    expect(resolveLaneChoiceDrop(definition(), "ctx_notes", "session")).toEqual(
      {
        kind: "layout",
      },
    );
  });
});

// README §2.2 — an ephemeral lane is a band like any other as far as the drag
// is concerned: it is on the canvas, so it is a drop target, and landing a
// context on it is the ordinary `placement.lane` write.
describe("dropping onto an empty lane", () => {
  const withEmptyBand: LaneBandBox[] = [
    ...boxes,
    { laneName: "rollback", x: 0, y: 440, width: 900, height: 132 },
  ];

  it("names the empty lane as the crossing being made", () => {
    const hover = resolveLaneDragHover({
      definition: definition(),
      boxes: withEmptyBand,
      origin: origin("ctx_checkout", "delivery", 20),
      position: { x: 200, y: 450 },
    });

    expect(hover.targetLane).toBe("rollback");
    expect(hover.evaluation?.outcome).toBe("accepted");
    expect(hover.evaluation?.previewLabel).toBe(
      "Re-place → lane: rollback · grade: owned (src/checkout) · unchanged",
    );
  });

  it("writes the lane and reports which band took the context", () => {
    const drop = resolveLaneDragDrop({
      definition: definition(),
      boxes: withEmptyBand,
      origin: origin("ctx_checkout", "delivery", 20),
      position: { x: 200, y: 450 },
    });

    expect(drop).toMatchObject({ kind: "replace", targetLane: "rollback" });
    if (drop.kind !== "replace") throw new Error("expected a replacement");
    expect(
      drop.definition.executionContexts.find(
        (context) => context.id === "ctx_checkout",
      )?.placement,
    ).toEqual({
      lane: "rollback",
      mode: "owned",
      ownedPaths: ["src/checkout"],
    });
  });
});

// README §4, said where it bites: an accepted placement that costs something
// still has to say so, and a refusal has to name what it refused over. Both
// arrive as the same card, which is why one function decides it.
describe("laneDropCalloutFor", () => {
  it("says nothing about a drag that only moved a node inside its lane", () => {
    expect(laneDropCalloutFor({ kind: "layout" })).toBeNull();
  });

  it("says nothing about an accepted drop with no consequence to report", () => {
    expect(
      laneDropCalloutFor({
        kind: "replace",
        targetLane: "delivery",
        definition: definition(),
        notice: null,
      }),
    ).toBeNull();
  });

  it("reports an accepted placement's occupancy cost in amber", () => {
    const callout = laneDropCalloutFor({
      kind: "replace",
      targetLane: "delivery",
      definition: definition(),
      notice: '"Rollout switch" needs exclusive occupancy of lane delivery.',
    });

    expect(callout).toEqual({
      tone: "amber",
      title: "Placement accepted",
      message: '"Rollout switch" needs exclusive occupancy of lane delivery.',
      footnote:
        "The placement was written. Only placement.lane changed — the grade and its owned paths carried across.",
    });
  });

  it("states a refusal's reason and remedy in red, and that nothing was written", () => {
    const callout = laneDropCalloutFor({
      kind: "refused",
      reason: '"session" admits only read-only contexts.',
      remedy: "Change its grade to read-only.",
    });

    expect(callout).toEqual({
      tone: "red",
      title: "Placement check failed",
      message:
        '"session" admits only read-only contexts. Change its grade to read-only.',
      footnote:
        "Nothing was written. The definition is still at the same dirty state it had before the drag.",
    });
  });
});
