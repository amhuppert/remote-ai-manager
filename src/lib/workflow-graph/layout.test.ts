import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "./test-fixtures";
import { generateWorkflowLayout } from "./layout";

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
});
