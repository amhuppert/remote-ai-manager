// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import ExecutionContextNode from "./ExecutionContextNode";
import type { ExecutionContextNodeData } from "./derive-graph";

function makeData(
  overrides: Partial<ExecutionContextNodeData> = {},
): ExecutionContextNodeData {
  return {
    context: {
      id: "ctx-1",
      title: "Triage the failure report",
      acceptanceCriteria: "A verdict is recorded.",
      implementer: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
    },
    tasks: [],
    mode: "execution",
    ...overrides,
  };
}

function renderNode(data: ExecutionContextNodeData) {
  // The full React Flow node contract, satisfied rather than asserted: a cast
  // would let the component drift onto a prop this fixture never supplies.
  const props: NodeProps<Node<ExecutionContextNodeData, "executionContext">> = {
    id: "ctx-1",
    data,
    selected: false,
    type: "executionContext",
    dragging: false,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    deletable: false,
    draggable: false,
    selectable: false,
    width: 260,
    height: 120,
    parentId: undefined,
  };

  return render(
    <ReactFlowProvider>
      <ExecutionContextNode {...props} />
    </ReactFlowProvider>,
  );
}

describe("ExecutionContextNode — output schema glyph (R7.7)", () => {
  it("renders no glyph for a context that declares no output schema", () => {
    renderNode(makeData());
    expect(screen.queryByTestId("node-output-schema-glyph")).toBeNull();
  });

  it("renders a hollow, labelled glyph while a declared schema is uncaptured", () => {
    renderNode(makeData({ outputSchema: { captured: false } }));

    const glyph = screen.getByTestId("node-output-schema-glyph");
    expect(glyph).toHaveAttribute("data-captured", "false");
    // The meaning must not live only in a tooltip.
    expect(glyph).toHaveAccessibleName(/output schema declared/i);
  });

  it("renders a filled green glyph once the output is captured", () => {
    renderNode(makeData({ outputSchema: { captured: true } }));

    const glyph = screen.getByTestId("node-output-schema-glyph");
    expect(glyph).toHaveAttribute("data-captured", "true");
    expect(glyph).toHaveAccessibleName(/output captured/i);
  });

  it("places the glyph beside the status badge", () => {
    renderNode(makeData({ outputSchema: { captured: true } }));

    const glyph = screen.getByTestId("node-output-schema-glyph");
    const badge = screen.getByText("Pending");
    expect(glyph.parentElement).toBe(badge.parentElement);
  });
});
