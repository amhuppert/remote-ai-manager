// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AutoLayout from "./AutoLayout";
import type {
  GraphWorkflowVisualLayout,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  LANE_BAND_GAP,
  LANE_BAND_MIN_HEIGHT,
  LANE_BAND_PADDING_Y,
} from "@/lib/workflow-graph/lane-band-geometry";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

/**
 * `a` and `b` sit in lanes of their own, so `b` opens the second band and its
 * top is decided by how tall `a`'s band grew — which is what makes it the
 * observable proof that a measurement change re-ran the layout.
 */
function secondBandTop(firstMemberHeight: number): number {
  return (
    LANE_BAND_PADDING_Y +
    Math.max(
      firstMemberHeight + LANE_BAND_PADDING_Y * 2,
      LANE_BAND_MIN_HEIGHT,
    ) +
    LANE_BAND_GAP
  );
}
type MeasuredNode = {
  id: string;
  measured?: { width: number; height: number };
};

let mockedNodes: MeasuredNode[] = [];
let mockedInitialized = false;

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ getNodes: () => mockedNodes }),
  useNodesInitialized: () => mockedInitialized,
  useNodes: () => mockedNodes,
}));

function makeContext(id: string) {
  return {
    id,
    title: id,
    acceptanceCriteria: "TBD",
    placement: { lane: id, mode: "full" as const },
    implementer: {
      id: "implementer",
      profile: { tier: "builtin" as const, id: "general-implementer" },
      agent: {
        backend: "claude" as const,
        modelSelection: {
          modelId: "sonnet" as const,
          parameters: { effort: "medium" as const },
        },
      },
    },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
  };
}

function makeDefinition(contextIds: string[]): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: contextIds.map(makeContext),
    tasks: [],
    edges: [],
  };
}

describe("AutoLayout", () => {
  it("regenerates layout when measured node dimensions change", () => {
    const onLayout = vi.fn();
    const definition = makeDefinition(["a", "b"]);

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];
    mockedInitialized = true;

    const { rerender } = render(
      <AutoLayout
        definition={definition}
        existingLayout={null}
        onLayout={onLayout}
      />,
    );

    expect(onLayout).toHaveBeenCalledTimes(1);
    const firstLayout = onLayout.mock.calls[0]![0];
    expect(firstLayout.contextPositions["b"]?.y).toBe(secondBandTop(200));

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 350 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];

    rerender(
      <AutoLayout
        definition={definition}
        existingLayout={null}
        onLayout={onLayout}
      />,
    );

    expect(onLayout).toHaveBeenCalledTimes(2);
    const secondLayout = onLayout.mock.calls[1]![0];
    expect(secondLayout.contextPositions["b"]?.y).toBe(secondBandTop(350));
  });

  /**
   * The defect this pins: measurement is not an instruction to re-place. A
   * position a human dragged and the draft persisted has to survive the pane
   * measuring its cards, or every mount silently discards the saved layout and
   * Re-layout stops being a distinct act.
   */
  it("keeps a persisted position when measurement re-runs the layout", () => {
    const onLayout = vi.fn();
    const definition = makeDefinition(["a", "b"]);
    const existingLayout: GraphWorkflowVisualLayout = {
      workflowId: "wf-1",
      contextPositions: { b: { x: 900, y: 40 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];
    mockedInitialized = true;

    render(
      <AutoLayout
        definition={definition}
        existingLayout={existingLayout}
        onLayout={onLayout}
      />,
    );

    expect(onLayout).toHaveBeenCalledTimes(1);
    const layout = onLayout.mock.calls[0]![0];
    expect(layout.contextPositions["b"]).toEqual({ x: 900, y: 40 });
    // The unpositioned context still gets band-aware geometry.
    expect(layout.contextPositions["a"]).toBeDefined();
  });

  it("stays silent when every context already has a persisted position", () => {
    const onLayout = vi.fn();
    const definition = makeDefinition(["a", "b"]);
    const existingLayout: GraphWorkflowVisualLayout = {
      workflowId: "wf-1",
      contextPositions: { a: { x: 10, y: 20 }, b: { x: 900, y: 40 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];
    mockedInitialized = true;

    render(
      <AutoLayout
        definition={definition}
        existingLayout={existingLayout}
        onLayout={onLayout}
      />,
    );

    // Reporting an identical layout would mark a clean draft dirty.
    expect(onLayout).not.toHaveBeenCalled();
  });

  it("does not regenerate when nodes render but dimensions are unchanged", () => {
    const onLayout = vi.fn();
    const definition = makeDefinition(["a", "b"]);

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];
    mockedInitialized = true;

    const { rerender } = render(
      <AutoLayout
        definition={definition}
        existingLayout={null}
        onLayout={onLayout}
      />,
    );

    expect(onLayout).toHaveBeenCalledTimes(1);

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];

    rerender(
      <AutoLayout
        definition={definition}
        existingLayout={null}
        onLayout={onLayout}
      />,
    );

    expect(onLayout).toHaveBeenCalledTimes(1);
  });
});
