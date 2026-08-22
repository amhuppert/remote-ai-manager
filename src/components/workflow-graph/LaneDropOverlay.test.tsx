// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import LaneDropOverlay from "./LaneDropOverlay";

function renderOverlay(accepted: boolean) {
  return render(
    <ReactFlowProvider>
      <ReactFlow nodes={[]} edges={[]}>
        <LaneDropOverlay
          ghost={{
            x: 200,
            y: 900,
            width: 264,
            height: 150,
            laneName: "session",
          }}
          preview={{
            x: 330,
            y: 120,
            label: "Re-place → lane: delivery · grade: read-only · unchanged",
            accepted,
          }}
        />
      </ReactFlow>
    </ReactFlowProvider>,
  );
}

describe("LaneDropOverlay", () => {
  it("names the pending change in full while a valid drop is in flight", () => {
    renderOverlay(true);

    expect(screen.getByTestId("lane-drop-preview")).toHaveTextContent(
      "Re-place → lane: delivery · grade: read-only · unchanged",
    );
  });

  it("still names the pending change in full when the drop will be refused", () => {
    renderOverlay(false);

    const preview = screen.getByTestId("lane-drop-preview");
    expect(preview).toHaveTextContent("Drop refused");
    expect(preview).toHaveTextContent(
      "Re-place → lane: delivery · grade: read-only · unchanged",
    );
  });

  it("leaves a ghost naming the lane the card came from", () => {
    renderOverlay(true);

    const ghost = screen.getByTestId("lane-drop-ghost");
    expect(ghost).toHaveTextContent("was: lane session");
    expect(ghost).toHaveStyle({ left: "200px", top: "900px" });
  });

  it("is inert: a drag overlay is never a focus stop", () => {
    renderOverlay(true);

    const overlay = screen.getByTestId("lane-drop-overlay");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay.querySelector("button, a, input, [tabindex]")).toBeNull();
  });
});
