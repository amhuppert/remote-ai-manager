import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  LAYOUT_COLUMN_GAP,
  LAYOUT_ROW_GAP,
  generateWorkflowLayout,
  type NodeDimensions,
} from "./layout";
import {
  LANE_BAND_CONTENT_OFFSET_X,
  LANE_BAND_GAP,
  LANE_BAND_MIN_HEIGHT,
  LANE_BAND_PADDING_Y,
} from "./lane-band-geometry";
import type {
  GraphWorkflowContextEdge,
  WorkflowSemanticDefinition,
} from "./definition-schemas";

/** The `plan` → `implement` → `verify` fixture, re-laned as the test needs. */
function definitionWithLanes(
  lanes: Record<string, string>,
  edges?: GraphWorkflowContextEdge[],
): WorkflowSemanticDefinition {
  const base = createWorkflowDefinition();
  return {
    ...base,
    executionContexts: base.executionContexts.map((context) => ({
      ...context,
      placement: {
        lane: lanes[context.id] ?? context.placement.lane,
        mode: "full" as const,
      },
    })),
    ...(edges ? { edges } : {}),
  };
}

function edge(sourceContextId: string, targetContextId: string) {
  return {
    id: `edge-${sourceContextId}-${targetContextId}`,
    sourceContextId,
    targetContextId,
  };
}

/** Where the nth stacked band's members sit, at the default card height. */
function bandContentTop(index: number): number {
  const bandHeight = Math.max(
    DEFAULT_NODE_HEIGHT + LANE_BAND_PADDING_Y * 2,
    LANE_BAND_MIN_HEIGHT,
  );
  return LANE_BAND_PADDING_Y + index * (bandHeight + LANE_BAND_GAP);
}

const COLUMN_PITCH = DEFAULT_NODE_WIDTH + LAYOUT_COLUMN_GAP;

describe("workflow-graph layout", () => {
  it("steps each band's chain right of its cross-band dependency", () => {
    const layout = generateWorkflowLayout(createWorkflowDefinition());

    // plan → implement → verify are three single-member lanes: each opens its
    // own band, and each member sits one column right of the dependency it
    // waits on in the band above — the flow reads left to right even though
    // the chain crosses bands.
    expect(layout.contextPositions).toEqual({
      "context-plan": { x: LANE_BAND_CONTENT_OFFSET_X, y: bandContentTop(0) },
      "context-implement": {
        x: LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH,
        y: bandContentTop(1),
      },
      "context-verify": {
        x: LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH * 2,
        y: bandContentTop(2),
      },
    });
  });

  it("keeps a context right of a dependency that lives between its band mates", () => {
    // Lane `delivery` holds both ends of the chain; `review` holds the middle.
    // The review band's only member is depth 1, so a per-band column rank
    // would open it at column 0 — directly below `context-plan`, left of the
    // flow it depends on.
    const definition = definitionWithLanes(
      {
        "context-plan": "delivery",
        "context-implement": "review",
        "context-verify": "delivery",
      },
      [
        edge("context-plan", "context-implement"),
        edge("context-implement", "context-verify"),
      ],
    );

    const layout = generateWorkflowLayout(definition);

    expect(layout.contextPositions["context-implement"]?.x).toBe(
      LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH,
    );
    expect(layout.contextPositions["context-verify"]?.x).toBe(
      LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH * 2,
    );
  });

  it("flows a band's members left to right by dependency depth", () => {
    const definition = definitionWithLanes({
      "context-plan": "delivery",
      "context-implement": "delivery",
      "context-verify": "delivery",
    });

    const layout = generateWorkflowLayout(definition);

    const top = bandContentTop(0);
    expect(layout.contextPositions).toEqual({
      "context-plan": { x: LANE_BAND_CONTENT_OFFSET_X, y: top },
      "context-implement": {
        x: LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH,
        y: top,
      },
      "context-verify": {
        x: LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH * 2,
        y: top,
      },
    });
  });

  it("stacks same-depth band mates inside the band instead of widening it", () => {
    const definition = definitionWithLanes(
      {
        "context-plan": "delivery",
        "context-implement": "delivery",
        "context-verify": "delivery",
      },
      [
        edge("context-plan", "context-implement"),
        edge("context-plan", "context-verify"),
      ],
    );

    const layout = generateWorkflowLayout(definition);

    const top = bandContentTop(0);
    // Both dependents share depth 1, so they share a column and stack.
    expect(layout.contextPositions["context-implement"]).toEqual({
      x: LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH,
      y: top,
    });
    expect(layout.contextPositions["context-verify"]).toEqual({
      x: LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH,
      y: top + DEFAULT_NODE_HEIGHT + LAYOUT_ROW_GAP,
    });
  });

  it("keeps a taller band from overlapping the band beneath it", () => {
    const definition = definitionWithLanes(
      {
        "context-plan": "delivery",
        "context-implement": "delivery",
        "context-verify": "session",
      },
      [
        edge("context-plan", "context-implement"),
        edge("context-plan", "context-verify"),
      ],
    );
    const dims: NodeDimensions = new Map([
      ["context-plan", { width: 264, height: 500 }],
      ["context-implement", { width: 264, height: 200 }],
      ["context-verify", { width: 264, height: 200 }],
    ]);

    const layout = generateWorkflowLayout(definition, null, dims);

    const deliveryBandBottom = LANE_BAND_PADDING_Y + 500 + LANE_BAND_PADDING_Y;
    expect(layout.contextPositions["context-verify"]?.y).toBe(
      deliveryBandBottom + LANE_BAND_GAP + LANE_BAND_PADDING_Y,
    );
  });

  it("aligns columns across bands using the widest card in each column", () => {
    // Two roots share depth 0 across two bands; `context-verify` waits on both.
    const definition = definitionWithLanes(
      {
        "context-plan": "plan",
        "context-implement": "delivery",
        "context-verify": "delivery",
      },
      [
        edge("context-plan", "context-verify"),
        edge("context-implement", "context-verify"),
      ],
    );
    const dims: NodeDimensions = new Map([
      ["context-plan", { width: 400, height: 200 }],
      ["context-implement", { width: 264, height: 200 }],
      ["context-verify", { width: 264, height: 200 }],
    ]);

    const layout = generateWorkflowLayout(definition, null, dims);

    // `context-plan` (400 wide) shares column 0 with `context-implement`, so
    // column 1 clears the widest card in column 0, not each band's own.
    expect(layout.contextPositions["context-verify"]?.x).toBe(
      LANE_BAND_CONTENT_OFFSET_X + 400 + LAYOUT_COLUMN_GAP,
    );
  });

  it("preserves an explicit position and fills the rest of the graph around it", () => {
    const layout = generateWorkflowLayout(
      createWorkflowDefinition(),
      createWorkflowLayout({
        contextPositions: { "context-plan": { x: 111, y: 222 } },
      }),
    );

    expect(layout.contextPositions["context-plan"]).toEqual({ x: 111, y: 222 });
    expect(layout.contextPositions["context-implement"]).toBeDefined();
    expect(layout.contextPositions["context-verify"]).toBeDefined();
  });

  it("drops a generated band mate below a preserved one in the same column", () => {
    const definition = definitionWithLanes(
      {
        "context-plan": "delivery",
        "context-implement": "delivery",
        "context-verify": "delivery",
      },
      [
        edge("context-plan", "context-implement"),
        edge("context-plan", "context-verify"),
      ],
    );

    const layout = generateWorkflowLayout(
      definition,
      createWorkflowLayout({
        contextPositions: {
          "context-implement": { x: 999, y: 700 },
        },
      }),
    );

    expect(layout.contextPositions["context-implement"]).toEqual({
      x: 999,
      y: 700,
    });
    expect(layout.contextPositions["context-verify"]).toEqual({
      x: LANE_BAND_CONTENT_OFFSET_X + COLUMN_PITCH,
      y: 700 + DEFAULT_NODE_HEIGHT + LAYOUT_ROW_GAP,
    });
  });

  it("regenerates band-aware positions when re-layout discards the old ones", () => {
    const stale = createWorkflowLayout({
      workflowId: "workflow-1",
      contextPositions: {
        "context-plan": { x: -900, y: -900 },
        "context-implement": { x: -900, y: -400 },
        "context-verify": { x: -900, y: 100 },
      },
    });

    const relaid = generateWorkflowLayout(createWorkflowDefinition(), null);

    expect(relaid.contextPositions).not.toEqual(stale.contextPositions);
    expect(relaid.contextPositions["context-plan"]).toEqual({
      x: LANE_BAND_CONTENT_OFFSET_X,
      y: bandContentTop(0),
    });
  });

  it("spaces stacked band mates by their measured heights", () => {
    const definition = definitionWithLanes(
      {
        "context-plan": "delivery",
        "context-implement": "delivery",
        "context-verify": "delivery",
      },
      [],
    );
    const dims: NodeDimensions = new Map([
      ["context-plan", { width: 264, height: 350 }],
      ["context-implement", { width: 264, height: 200 }],
      ["context-verify", { width: 264, height: 280 }],
    ]);

    const layout = generateWorkflowLayout(definition, null, dims);

    // No edges: all three are depth 0, so they stack in one column.
    const top = LANE_BAND_PADDING_Y;
    expect(layout.contextPositions["context-plan"]?.y).toBe(top);
    expect(layout.contextPositions["context-implement"]?.y).toBe(
      top + 350 + LAYOUT_ROW_GAP,
    );
    expect(layout.contextPositions["context-verify"]?.y).toBe(
      top + 350 + LAYOUT_ROW_GAP + 200 + LAYOUT_ROW_GAP,
    );
  });

  it("carries the existing workflow id and viewport through", () => {
    const layout = generateWorkflowLayout(
      createWorkflowDefinition(),
      createWorkflowLayout({ workflowId: "workflow-1" }),
    );

    expect(layout.workflowId).toBe("workflow-1");
  });
});
