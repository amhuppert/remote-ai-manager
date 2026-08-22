// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import CanvasControls, { zoomPercentLabel } from "./CanvasControls";

function renderControls() {
  return render(
    <ReactFlowProvider>
      <ReactFlow nodes={[]} edges={[]}>
        <CanvasControls />
      </ReactFlow>
    </ReactFlowProvider>,
  );
}

describe("zoomPercentLabel", () => {
  it("reads the viewport zoom as a whole percentage", () => {
    expect(zoomPercentLabel(1)).toBe("100%");
    expect(zoomPercentLabel(0.3)).toBe("30%");
    expect(zoomPercentLabel(1.756)).toBe("176%");
  });
});

describe("CanvasControls", () => {
  it("offers zoom out, zoom in and fit as real named controls", () => {
    renderControls();

    for (const name of ["Zoom out", "Zoom in", "Fit view"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeEnabled();
      // A real focusable control, not a div with a click handler.
      control.focus();
      expect(control).toHaveFocus();
    }
  });

  it("reports the current zoom level next to the controls", () => {
    renderControls();

    expect(screen.getByTestId("canvas-zoom-level")).toHaveTextContent("100%");
  });

  it("marks the zoom glyphs decorative so the button label is the only name", () => {
    renderControls();

    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    expect(zoomIn.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
