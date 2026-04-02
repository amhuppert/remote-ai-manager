import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import { generateWorkflowLayout, type NodeDimensions } from "./layout";

describe("workflow-graph layout", () => {
  it("places contexts by dependency depth when no layout exists", () => {
    const definition = createWorkflowDefinition();
    const layout = generateWorkflowLayout(definition);

    expect(layout.contextPositions["context-plan"]?.x).toBe(0);
    expect(layout.contextPositions["context-implement"]?.x).toBeGreaterThan(
      layout.contextPositions["context-plan"]?.x ?? 0,
    );
    expect(layout.contextPositions["context-verify"]?.x).toBeGreaterThan(
      layout.contextPositions["context-implement"]?.x ?? 0,
    );
  });

  it("preserves manual positions for unchanged contexts and fills missing ones", () => {
    const definition = createWorkflowDefinition();
    const layout = generateWorkflowLayout(
      definition,
      createWorkflowLayout({
        contextPositions: {
          "context-plan": { x: 111, y: 222 },
        },
      }),
    );

    expect(layout.contextPositions["context-plan"]).toEqual({ x: 111, y: 222 });
    expect(layout.contextPositions["context-implement"]).toBeDefined();
    expect(layout.contextPositions["context-verify"]).toBeDefined();
  });

  it("avoids overlapping generated positions with preserved manual positions at the same depth", () => {
    const definition = createWorkflowDefinition({
      edges: [
        {
          id: "edge-plan-implement",
          sourceContextId: "context-plan",
          targetContextId: "context-implement",
        },
        {
          id: "edge-plan-verify",
          sourceContextId: "context-plan",
          targetContextId: "context-verify",
        },
      ],
    });

    const layout = generateWorkflowLayout(
      definition,
      createWorkflowLayout({
        contextPositions: {
          "context-plan": { x: 0, y: 0 },
          "context-implement": { x: 360, y: 0 },
        },
      }),
    );

    expect(layout.contextPositions["context-verify"]).toEqual({
      x: 360,
      y: 240,
    });
  });

  describe("with nodeDimensions", () => {
    it("spaces nodes vertically based on actual heights", () => {
      const definition = createWorkflowDefinition({
        edges: [],
      });
      const dims: NodeDimensions = new Map([
        ["context-plan", { width: 248, height: 350 }],
        ["context-implement", { width: 248, height: 200 }],
        ["context-verify", { width: 248, height: 280 }],
      ]);

      const layout = generateWorkflowLayout(definition, null, dims);

      expect(layout.contextPositions["context-plan"]).toEqual({ x: 0, y: 0 });
      expect(layout.contextPositions["context-implement"]?.y).toBe(350 + 40);
      expect(layout.contextPositions["context-verify"]?.y).toBe(
        350 + 40 + 200 + 40,
      );
    });

    it("spaces depth columns based on max node width in each column", () => {
      const definition = createWorkflowDefinition();
      const dims: NodeDimensions = new Map([
        ["context-plan", { width: 300, height: 200 }],
        ["context-implement", { width: 400, height: 200 }],
        ["context-verify", { width: 250, height: 200 }],
      ]);

      const layout = generateWorkflowLayout(definition, null, dims);

      expect(layout.contextPositions["context-plan"]?.x).toBe(0);
      expect(layout.contextPositions["context-implement"]?.x).toBe(300 + 112);
      expect(layout.contextPositions["context-verify"]?.x).toBe(
        300 + 112 + 400 + 112,
      );
    });

    it("avoids overlap with preserved positions using actual heights", () => {
      const definition = createWorkflowDefinition({
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-plan-verify",
            sourceContextId: "context-plan",
            targetContextId: "context-verify",
          },
        ],
      });
      const dims: NodeDimensions = new Map([
        ["context-plan", { width: 248, height: 200 }],
        ["context-implement", { width: 248, height: 350 }],
        ["context-verify", { width: 248, height: 200 }],
      ]);

      const layout = generateWorkflowLayout(
        definition,
        createWorkflowLayout({
          contextPositions: {
            "context-plan": { x: 0, y: 0 },
            "context-implement": { x: 360, y: 0 },
          },
        }),
        dims,
      );

      expect(layout.contextPositions["context-verify"]?.y).toBe(350 + 40);
    });
  });
});
