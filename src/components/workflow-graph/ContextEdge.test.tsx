// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Position } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";
import ContextEdge from "./ContextEdge";
import type { ContextEdgeData } from "./derive-graph";

function renderEdge(data: ContextEdgeData) {
  // The full React Flow edge contract, satisfied rather than cast, so the
  // component cannot drift onto a prop this fixture never supplies.
  const props: EdgeProps<Edge<ContextEdgeData, "contextEdge">> = {
    id: "e-fix",
    source: "classify",
    target: "fix",
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data,
    selected: false,
    animated: false,
    deletable: false,
    selectable: false,
    interactionWidth: 20,
    sourceHandleId: null,
    targetHandleId: null,
    markerStart: undefined,
    markerEnd: undefined,
    label: undefined,
    labelStyle: undefined,
    labelShowBg: undefined,
    labelBgStyle: undefined,
    labelBgPadding: undefined,
    labelBgBorderRadius: undefined,
    style: undefined,
    type: "contextEdge",
  };

  return render(
    <svg>
      <ContextEdge {...props} />
    </svg>,
  );
}

describe("ContextEdge — conditional guards (R13.1)", () => {
  it("draws an unguarded edge solid, with no chip", () => {
    const { container } = renderEdge({ sourceStatus: "completed" });

    const path = container.querySelector("path#e-fix");
    expect(path).not.toHaveAttribute("data-guard");
    expect(screen.queryByTestId("edge-guard-chip")).toBeNull();
  });

  it("dashes a guarded edge and chips it with the guard verdict", () => {
    const { container } = renderEdge({
      sourceStatus: "completed",
      targetStatus: "running",
      guard: { kind: "schema", resolution: "active" },
    });

    const path = container.querySelector("path#e-fix");
    expect(path).toHaveAttribute("data-guard", "schema");
    expect(path).toHaveAttribute("data-guard-resolution", "active");
    expect(path?.getAttribute("class")).toContain("stroke-dasharray");

    const chip = screen.getByTestId("edge-guard-chip");
    expect(chip).toHaveTextContent("when");
    expect(chip).toHaveAccessibleName(/guarded edge.*active/i);
  });

  it("labels the else branch as such", () => {
    renderEdge({ guard: { kind: "else", resolution: "inactive" } });

    const chip = screen.getByTestId("edge-guard-chip");
    expect(chip).toHaveTextContent("else");
    expect(chip).toHaveAccessibleName(/inactive/i);
  });

  it("reports the effective source of a concluded loop's external edge", () => {
    renderEdge({
      sourceStatus: "completed",
      effectiveSourceId: "loop-a__p3__judge",
    });

    expect(screen.getByTestId("edge-effective-source")).toHaveTextContent(
      "loop-a__p3__judge",
    );
  });
});

describe("ContextEdge — lifecycle states", () => {
  it("draws a pending edge as a neutral dashed line with no animation", () => {
    const { container } = renderEdge({});

    const path = container.querySelector("path#e-fix");
    expect(path).toHaveAttribute("data-edge-state", "pending");
    const className = path?.getAttribute("class") ?? "";
    expect(className).toContain("stroke-border-strong");
    expect(className).toContain("stroke-dasharray:3_5");
    expect(className).not.toContain("animation");
  });

  it("draws an active edge as a marching cyan dash", () => {
    const { container } = renderEdge({
      sourceStatus: "completed",
      targetStatus: "running",
    });

    const path = container.querySelector("path#e-fix");
    expect(path).toHaveAttribute("data-edge-state", "active");
    const className = path?.getAttribute("class") ?? "";
    expect(className).toContain("stroke-cyan");
    expect(className).toContain("dash-flow");
  });

  it("draws a satisfied edge solid in green, with the motion dropped", () => {
    const { container } = renderEdge({
      sourceStatus: "completed",
      targetStatus: "completed",
    });

    const path = container.querySelector("path#e-fix");
    expect(path).toHaveAttribute("data-edge-state", "satisfied");
    const className = path?.getAttribute("class") ?? "";
    expect(className).toContain("stroke-green-dim");
    expect(className).not.toContain("stroke-dasharray");
    expect(className).not.toContain("animation");
  });
});
