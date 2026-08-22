// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import type { LaneBand } from "@/lib/workflow-graph/lane-bands";
import type { LaneBandBox } from "@/lib/workflow-graph/lane-band-geometry";
import type { JoinConflictSummary } from "./join-conflict-summary";

import LaneBandLayer, { LaneBandSurface } from "./LaneBandLayer";

const BOX: LaneBandBox = {
  laneName: "delivery",
  x: 4,
  y: 478,
  width: 1200,
  height: 300,
};

function deliveryBand(overrides: Partial<LaneBand> = {}): LaneBand {
  return {
    laneName: "delivery",
    state: "active",
    reserved: false,
    memberContextIds: ["ctx_checkout", "ctx_settings", "ctx_rollout"],
    memberCount: 3,
    membershipLabel: "3 members",
    gradeSummary: "2 owning · 1 full",
    runtime: {
      status: "active",
      branchLabel: "csm/checkout-v2.delivery",
      worktreeLabel: ".worktrees/checkout-v2.delivery",
      joinLabel: null,
      publicationLabel: "publishes → session",
    },
    ...overrides,
  };
}

const JOIN_CONFLICT: JoinConflictSummary = {
  joinId: "join_delivery_1",
  laneLabel: "delivery",
  mergedCount: 1,
  blockedMember: {
    laneId: "lane-settings",
    contextId: "ctx_settings",
    title: "Settings",
    status: "blocked",
    detail: "both wrote the timeout branch",
  },
  conflictFiles: ["src/checkout/audit.ts"],
  members: [
    {
      laneId: "lane-checkout",
      contextId: "ctx_checkout",
      title: "Checkout",
      status: "merged",
      detail: null,
    },
    {
      laneId: "lane-settings",
      contextId: "ctx_settings",
      title: "Settings",
      status: "blocked",
      detail: "both wrote the timeout branch",
    },
  ],
};

function sessionBand(overrides: Partial<LaneBand> = {}): LaneBand {
  return {
    laneName: "session",
    state: "session",
    reserved: true,
    memberContextIds: ["ctx_notes"],
    memberCount: 1,
    membershipLabel: "1 member",
    gradeSummary: "1 read-only",
    runtime: null,
    ...overrides,
  };
}

describe("LaneBandSurface", () => {
  it("positions the band where the geometry puts it", () => {
    render(<LaneBandSurface band={deliveryBand()} box={BOX} mode="builder" />);

    const band = screen.getByTestId("lane-band");
    expect(band).toHaveStyle({
      left: "4px",
      top: "478px",
      width: "1200px",
      height: "300px",
    });
  });

  it("states membership and the member-grade summary as one lane-scoped line", () => {
    render(<LaneBandSurface band={deliveryBand()} box={BOX} mode="builder" />);

    // The grade never stands alone: it is always a summary OF the members, so
    // a lane can never be read as carrying a grade of its own.
    expect(screen.getByTestId("lane-band-membership")).toHaveTextContent(
      "3 members · 2 owning · 1 full",
    );
    expect(screen.getByTestId("lane-band-name")).toHaveTextContent("delivery");
  });

  it("names the band for assistive technology without claiming a lane grade", () => {
    render(
      <LaneBandSurface band={deliveryBand()} box={BOX} mode="execution" />,
    );

    expect(screen.getByTestId("lane-band")).toHaveAttribute(
      "aria-label",
      "Lane delivery, active — 3 members · 2 owning · 1 full",
    );
  });

  it("shows no runtime facts in builder mode", () => {
    render(<LaneBandSurface band={deliveryBand()} box={BOX} mode="builder" />);

    expect(screen.queryByTestId("lane-band-status")).toBeNull();
    expect(screen.queryByTestId("lane-band-runtime")).toBeNull();
    expect(screen.getByTestId("lane-band")).toHaveAttribute(
      "aria-label",
      "Lane delivery — 3 members · 2 owning · 1 full",
    );
  });

  it("shows the runtime status pill, branch, worktree and publication in execution mode", () => {
    render(
      <LaneBandSurface band={deliveryBand()} box={BOX} mode="execution" />,
    );

    expect(screen.getByTestId("lane-band-status")).toHaveTextContent("active");
    const runtime = screen.getByTestId("lane-band-runtime");
    expect(runtime).toHaveTextContent("csm/checkout-v2.delivery");
    expect(runtime).toHaveTextContent(".worktrees/checkout-v2.delivery");
    expect(runtime).toHaveTextContent("publishes → session");
  });

  it("pulses the lane dot only while the lane is live", () => {
    const { rerender } = render(
      <LaneBandSurface band={deliveryBand()} box={BOX} mode="execution" />,
    );
    expect(screen.getByTestId("lane-band-dot").className).toContain(
      "lane-band-live-dot",
    );

    rerender(
      <LaneBandSurface
        band={deliveryBand({
          state: "merged",
          runtime: { ...deliveryBand().runtime!, status: "merged" },
        })}
        box={BOX}
        mode="execution"
      />,
    );
    expect(screen.getByTestId("lane-band-dot").className).not.toContain(
      "lane-band-live-dot",
    );
  });

  it("keeps a halted lane's band occupied while the pill carries the halt", () => {
    render(
      <LaneBandSurface
        band={deliveryBand({
          runtime: { ...deliveryBand().runtime!, status: "halted" },
        })}
        box={BOX}
        mode="execution"
      />,
    );

    expect(screen.getByTestId("lane-band")).toHaveAttribute(
      "data-lane-state",
      "active",
    );
    expect(screen.getByTestId("lane-band-status")).toHaveTextContent("halted");
    // Occupancy is not liveness. The band stays `active` because the lane still
    // holds the work, but nothing is running on it, and a pulse is reserved for
    // indicators that are actually live.
    expect(screen.getByTestId("lane-band-dot").className).not.toContain(
      "lane-band-live-dot",
    );
  });

  it("renders the reserved session band dashed with read-only membership copy in builder mode", () => {
    render(<LaneBandSurface band={sessionBand()} box={BOX} mode="builder" />);

    const band = screen.getByTestId("lane-band");
    expect(band).toHaveAttribute("data-lane-state", "session");
    expect(band).toHaveAttribute("data-reserved", "true");
    expect(band.className).toContain("border-dashed");
    expect(screen.getByTestId("lane-band-status")).toHaveTextContent(
      "reserved",
    );
    expect(screen.getByTestId("lane-band-membership")).toHaveTextContent(
      "1 member · 1 read-only",
    );
    expect(band).toHaveTextContent("admits read-only contexts only");
  });

  it("marks the session band as the read-only publication target in execution mode", () => {
    render(
      <LaneBandSurface
        band={sessionBand({
          runtime: {
            status: "pending",
            branchLabel: null,
            worktreeLabel: "the session worktree",
            joinLabel: null,
            publicationLabel: "publication target",
          },
        })}
        box={BOX}
        mode="execution"
      />,
    );

    expect(screen.getByTestId("lane-band-status")).toHaveTextContent(
      "reserved · read-only",
    );
    const runtime = screen.getByTestId("lane-band-runtime");
    expect(
      within(runtime).getByText("the session worktree"),
    ).toBeInTheDocument();
    expect(within(runtime).getByText("publication target")).toBeInTheDocument();
  });
});

describe("LaneBandLayer on the canvas", () => {
  it("renders one band per lane inside the pannable viewport", () => {
    render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={[
            {
              id: "ctx_checkout",
              position: { x: 200, y: 500 },
              data: {},
            },
            { id: "ctx_notes", position: { x: 200, y: 900 }, data: {} },
          ]}
          edges={[]}
        >
          <LaneBandLayer
            bands={[
              deliveryBand({ memberContextIds: ["ctx_checkout"] }),
              sessionBand(),
            ]}
            mode="execution"
          />
        </ReactFlow>
      </ReactFlowProvider>,
    );

    const bands = screen.getAllByTestId("lane-band");
    expect(bands.map((band) => band.getAttribute("data-lane-name"))).toEqual([
      "delivery",
      "session",
    ]);
    // Bands live in the transformed viewport, so panning and zooming move them
    // with the nodes rather than leaving them pinned to the pane.
    expect(
      screen.getByTestId("lane-band-layer").closest(".react-flow__viewport"),
    ).not.toBeNull();
  });

  // §2.1 / B2: the band a cross-lane drag is over says whether it can take the
  // context, and the band the node is leaving stays where it was.
  it("highlights the band a valid drop is hovering", () => {
    render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={[
            { id: "ctx_checkout", position: { x: 200, y: 500 }, data: {} },
            { id: "ctx_notes", position: { x: 200, y: 520 }, data: {} },
          ]}
          edges={[]}
        >
          <LaneBandLayer
            bands={[
              deliveryBand({ memberContextIds: ["ctx_checkout"] }),
              sessionBand(),
            ]}
            mode="builder"
            dropTarget={{ laneName: "delivery", accepted: true }}
            pinnedNode={{ id: "ctx_notes", x: 200, y: 900 }}
          />
        </ReactFlow>
      </ReactFlowProvider>,
    );

    const bands = screen.getAllByTestId("lane-band");
    const delivery = bands.find(
      (band) => band.getAttribute("data-lane-name") === "delivery",
    );
    const session = bands.find(
      (band) => band.getAttribute("data-lane-name") === "session",
    );
    expect(delivery).toHaveAttribute("data-drop-state", "accepted");
    expect(
      within(delivery!).getByTestId("lane-band-drop-caption"),
    ).toHaveTextContent("drop to re-place here");
    expect(delivery).toHaveAccessibleName(/drop to re-place here/);
    expect(session).not.toHaveAttribute("data-drop-state");
    // The dragged node is pinned at 900, so the band it is leaving keeps its
    // own geometry instead of following the card across the canvas.
    expect(session).toHaveStyle({ top: "878px" });
  });

  it("marks a band that cannot accept the dragged context", () => {
    render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={[{ id: "ctx_notes", position: { x: 200, y: 900 }, data: {} }]}
          edges={[]}
        >
          <LaneBandLayer
            bands={[sessionBand()]}
            mode="builder"
            dropTarget={{ laneName: "session", accepted: false }}
          />
        </ReactFlow>
      </ReactFlowProvider>,
    );

    const band = screen.getByTestId("lane-band");
    expect(band).toHaveAttribute("data-drop-state", "refused");
    expect(screen.getByTestId("lane-band-drop-caption")).toHaveTextContent(
      "cannot accept this context",
    );
  });

  // README §11: a join conflict is reachable on the LANE RAIL, not only behind
  // the status bar's halt row.
  it("hangs a conflicted join's card on the band of the lane it merged into", () => {
    render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={[
            { id: "ctx_checkout", position: { x: 200, y: 500 }, data: {} },
          ]}
          edges={[]}
        >
          <LaneBandLayer
            bands={[deliveryBand({ memberContextIds: ["ctx_checkout"] })]}
            mode="execution"
            joinConflict={JOIN_CONFLICT}
          />
        </ReactFlow>
      </ReactFlowProvider>,
    );

    const card = screen.getByTestId("lane-join-conflict-card");
    expect(card).toHaveAttribute("data-lane-name", "delivery");
    expect(card).toHaveTextContent("Join conflict — delivery");
    // The band layer sits behind the nodes; the card carries controls, so it
    // must not be in that non-interactive layer.
    expect(card.closest('[data-testid="lane-band-layer"]')).toBeNull();
  });

  // Every band spans the same column, from the header to the widest node plus
  // padding, so a card that starts at or beyond a band's right edge cannot
  // cover a node in any band.
  it("places the join card clear of every node in the band", () => {
    render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={[
            { id: "ctx_checkout", position: { x: 200, y: 500 }, data: {} },
          ]}
          edges={[]}
        >
          <LaneBandLayer
            bands={[deliveryBand({ memberContextIds: ["ctx_checkout"] })]}
            mode="execution"
            joinConflict={JOIN_CONFLICT}
          />
        </ReactFlow>
      </ReactFlowProvider>,
    );

    const band = screen.getByTestId("lane-band");
    const anchor = screen.getByTestId("lane-join-conflict-anchor");
    const bandRight =
      Number.parseFloat(band.style.left) + Number.parseFloat(band.style.width);

    expect(Number.parseFloat(anchor.style.left)).toBeGreaterThanOrEqual(
      bandRight,
    );
  });

  // A final publish merges into the reserved session lane, which ordinarily
  // holds no context of its own and so contributes no band. The conflict is
  // still the run's blocking state, so the card falls back to the bottom of the
  // stack rather than disappearing — the same rule the publication pill uses.
  it("still draws the join card when the target lane has no band", () => {
    render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={[
            { id: "ctx_checkout", position: { x: 200, y: 500 }, data: {} },
          ]}
          edges={[]}
        >
          <LaneBandLayer
            bands={[deliveryBand({ memberContextIds: ["ctx_checkout"] })]}
            mode="execution"
            joinConflict={{ ...JOIN_CONFLICT, laneLabel: "__session__" }}
          />
        </ReactFlow>
      </ReactFlowProvider>,
    );

    const card = screen.getByTestId("lane-join-conflict-card");
    expect(card).toHaveAttribute("data-lane-name", "__session__");
    expect(card).toHaveTextContent("Join conflict — __session__");
  });

  it("renders nothing until a node has a position to wrap", () => {
    render(
      <ReactFlowProvider>
        <ReactFlow nodes={[]} edges={[]}>
          <LaneBandLayer bands={[deliveryBand()]} mode="builder" />
        </ReactFlow>
      </ReactFlowProvider>,
    );

    expect(screen.queryByTestId("lane-band")).toBeNull();
  });
});
