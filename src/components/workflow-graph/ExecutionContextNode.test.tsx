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
      placement: { lane: "ctx-1", mode: "full" },
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
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

describe("ExecutionContextNode — skipped contexts (R13.1)", () => {
  const skipped = {
    waitState: { kind: "skipped" } as const,
    skip: {
      at: "2026-01-01T00:00:00.000Z",
      edgeEvaluations: [
        { edgeId: "e-fix", verdict: "inactive" as const },
        { edgeId: "e-seed", verdict: "omitted" as const },
      ],
      decidingEdgeIds: ["e-fix"],
    },
  };

  it("ghosts the node and names the edges that decided the skip", () => {
    const { container } = renderNode(makeData(skipped));

    const node = container.querySelector(".graph-node");
    expect(node).toHaveAttribute("data-skipped", "true");
    const reason = screen.getByTestId("node-skip-reason");
    expect(reason).toHaveTextContent("e-fix");
    // The complete verdict set is recorded, but only the guards that resolved
    // false explain the skip — an omitted edge merely dropped out.
    expect(reason).not.toHaveTextContent("e-seed");
  });

  it("leaves an unskipped node unghosted and reasonless", () => {
    const { container } = renderNode(makeData());

    expect(container.querySelector(".graph-node")).not.toHaveAttribute(
      "data-skipped",
    );
    expect(screen.queryByTestId("node-skip-reason")).toBeNull();
  });
});

describe("ExecutionContextNode — loop pass badge (R13.1)", () => {
  it("renders the pass number against the loop's declared budget", () => {
    renderNode(
      makeData({
        loop: {
          loopGroupId: "loop-a",
          pass: 2,
          maxPasses: 5,
          passCount: 2,
          activation: "running",
          templateVersion: 3,
          authoredContextId: "work",
        },
      }),
    );

    const badge = screen.getByTestId("node-loop-badge");
    expect(badge).toHaveTextContent("Pass 2/5");
    expect(badge).toHaveAccessibleName(/loop loop-a.*pass 2 of 5.*running/i);
  });

  it("renders no loop badge for a context outside every loop", () => {
    renderNode(makeData());
    expect(screen.queryByTestId("node-loop-badge")).toBeNull();
  });
});

describe("ExecutionContextNode — expansion provenance (R13.1)", () => {
  it("badges a runtime-added context with its initiator", () => {
    renderNode(
      makeData({
        provenance: {
          requestId: "req-1",
          invokerContextId: "generator",
          rationale: "Fan out three candidate designs",
          payloadHash: "a".repeat(64),
          acceptedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    const badge = screen.getByTestId("node-provenance-badge");
    expect(badge).toHaveTextContent(/added at runtime/i);
    expect(badge).toHaveAccessibleName(/generator/);
    expect(badge).toHaveAccessibleName(/Fan out three candidate designs/);
  });

  it("renders no provenance badge for an authored context", () => {
    renderNode(makeData());
    expect(screen.queryByTestId("node-provenance-badge")).toBeNull();
  });
});

describe("ExecutionContextNode — advisory response phase (R6.3)", () => {
  it("distinguishes the advisory-response phase from validating and completed", () => {
    const { unmount } = renderNode(
      makeData({ waitState: { kind: "advisory-response" } }),
    );
    expect(screen.getByText("Advisory Response")).toBeInTheDocument();
    expect(screen.getByText("Awaiting advisory response")).toBeInTheDocument();
    unmount();

    renderNode(makeData({ waitState: { kind: "validating" } }));
    expect(screen.queryByText("Advisory Response")).toBeNull();
    expect(screen.getByText("Validating")).toBeInTheDocument();
    expect(screen.getByText("Validating context")).toBeInTheDocument();
  });

  it("does not read as a finished context", () => {
    const { unmount } = renderNode(
      makeData({ waitState: { kind: "advisory-response" } }),
    );
    expect(screen.queryByText("Completed")).toBeNull();
    unmount();

    // A finished context says so twice — badge and footer.
    renderNode(makeData({ waitState: { kind: "completed" } }));
    expect(screen.getAllByText("Completed")).toHaveLength(2);
  });
});
