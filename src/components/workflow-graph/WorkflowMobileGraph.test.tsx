// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LaneBand } from "@/lib/workflow-graph/lane-bands";
import type { ExecutionContextNodeData } from "./derive-graph";
import WorkflowMobileGraph, {
  type WorkflowMobileGraphNode,
} from "./WorkflowMobileGraph";

function nodeData(
  id: string,
  lane: string,
  overrides: Partial<ExecutionContextNodeData> = {},
): ExecutionContextNodeData {
  return {
    context: {
      id,
      title: `Context ${id}`,
      acceptanceCriteria: "A verdict is recorded.",
      placement: { lane, mode: "full" },
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: {
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
      },
      mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 3 },
    },
    tasks: [],
    mode: "builder",
    laneState: "pending",
    configOverrides: [],
    ...overrides,
  };
}

function node(id: string, lane: string): WorkflowMobileGraphNode {
  return { id, data: nodeData(id, lane) };
}

function band(overrides: Partial<LaneBand> = {}): LaneBand {
  return {
    laneName: "delivery",
    state: "pending",
    reserved: false,
    memberContextIds: ["ctx_checkout", "ctx_settings"],
    memberCount: 2,
    membershipLabel: "2 members",
    gradeSummary: "2 full",
    runtime: null,
    ...overrides,
  };
}

function renderGraph(
  props: Partial<React.ComponentProps<typeof WorkflowMobileGraph>> = {},
) {
  const onSelectContext = vi.fn();
  const result = render(
    <WorkflowMobileGraph
      bands={[band()]}
      mode="builder"
      nodes={[
        node("ctx_checkout", "delivery"),
        node("ctx_settings", "delivery"),
      ]}
      selectedContextId={null}
      onSelectContext={onSelectContext}
      {...props}
    />,
  );
  return { ...result, onSelectContext };
}

describe("WorkflowMobileGraph", () => {
  it("stacks one band per lane with its members inside it", () => {
    renderGraph({
      bands: [
        band(),
        band({
          laneName: "plan",
          memberContextIds: ["ctx_plan"],
          memberCount: 1,
          membershipLabel: "1 member",
          gradeSummary: "1 full",
        }),
      ],
      nodes: [
        node("ctx_checkout", "delivery"),
        node("ctx_settings", "delivery"),
        node("ctx_plan", "plan"),
      ],
    });

    const bands = screen.getAllByTestId("mobile-lane-band");
    expect(bands.map((element) => element.getAttribute("data-lane"))).toEqual([
      "delivery",
      "plan",
    ]);
    expect(
      within(bands[0] as HTMLElement).getAllByTestId("mobile-lane-member"),
    ).toHaveLength(2);
    expect(
      within(bands[1] as HTMLElement).getAllByTestId("mobile-lane-member"),
    ).toHaveLength(1);
  });

  it("states membership and a member-grade summary, never a lane grade", () => {
    renderGraph();
    expect(screen.getByTestId("mobile-lane-band-name")).toHaveTextContent(
      "delivery",
    );
    // A lane has no grade (README §4): the grade is always a summary OF the
    // members, so it never appears without the membership it summarises.
    expect(screen.getByTestId("mobile-lane-band-membership")).toHaveTextContent(
      "2 members · 2 full",
    );
  });

  it("selects the context a member card is tapped on", async () => {
    const user = userEvent.setup();
    const { onSelectContext } = renderGraph();

    await user.click(
      screen.getAllByTestId("mobile-lane-member")[0] as HTMLElement,
    );
    expect(onSelectContext).toHaveBeenCalledWith("ctx_checkout");
  });

  it("marks the selected member as current", () => {
    renderGraph({ selectedContextId: "ctx_settings" });
    const members = screen.getAllByTestId("mobile-lane-member");
    expect(members[0]).not.toHaveAttribute("aria-current");
    expect(members[1]).toHaveAttribute("aria-current", "true");
  });

  it("draws an ephemeral lane that holds nothing yet", () => {
    renderGraph({ emptyLaneNames: ["candidate-rules"] });
    const bands = screen.getAllByTestId("mobile-lane-band");
    const ephemeral = bands.find(
      (element) => element.getAttribute("data-lane") === "candidate-rules",
    );
    expect(ephemeral).toBeDefined();
    expect(
      within(ephemeral as HTMLElement).queryAllByTestId("mobile-lane-member"),
    ).toHaveLength(0);
  });

  it("floats fit and zoom controls above the bottom toolbar", () => {
    renderGraph();
    expect(screen.getByRole("button", { name: "Fit graph" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeVisible();
  });

  it("zooms the stacked lanes and fits them back", async () => {
    const user = userEvent.setup();
    renderGraph();
    const lanes = screen.getByTestId("workflow-mobile-graph").firstElementChild
      ?.firstElementChild as HTMLElement;

    expect(lanes.style.transform).toBe("scale(1)");

    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(lanes.style.transform).toBe("scale(0.75)");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(lanes.style.transform).toBe("scale(1)");

    // Fit is "show me all of it": the smallest step, back at the top.
    await user.click(screen.getByRole("button", { name: "Fit graph" }));
    expect(lanes.style.transform).toBe("scale(0.6)");
  });
});

// README §12 — "Re-placement on touch is a long-press on the node, then a lane
// picker." The gesture has to survive being shaped like a scroll: a lane's
// members scroll horizontally under the same finger.
describe("WorkflowMobileGraph — long-press", () => {
  function press(element: HTMLElement) {
    fireEvent.pointerDown(element);
  }

  it("opens the re-placement route once the press is held", async () => {
    const onLongPressContext = vi.fn();
    const { onSelectContext } = renderGraph({ onLongPressContext });

    press(screen.getAllByTestId("mobile-lane-member")[0] as HTMLElement);

    await waitFor(() =>
      expect(onLongPressContext).toHaveBeenCalledWith("ctx_checkout"),
    );
    expect(onSelectContext).not.toHaveBeenCalled();
  });

  // The click that ends a long press must not also be read as a tap, or every
  // re-placement would silently change the selection behind the picker.
  it("does not also select the context the press opened", async () => {
    const onLongPressContext = vi.fn();
    const { onSelectContext } = renderGraph({ onLongPressContext });
    const card = screen.getAllByTestId("mobile-lane-member")[0] as HTMLElement;

    press(card);
    await waitFor(() => expect(onLongPressContext).toHaveBeenCalled());
    fireEvent.pointerUp(card);
    fireEvent.click(card);

    expect(onSelectContext).not.toHaveBeenCalled();
  });

  it("abandons the press when the finger scrolls the lane", async () => {
    const onLongPressContext = vi.fn();
    renderGraph({ onLongPressContext });
    const card = screen.getAllByTestId("mobile-lane-member")[0] as HTMLElement;

    press(card);
    fireEvent.pointerMove(card);
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(onLongPressContext).not.toHaveBeenCalled();
  });

  it("renders the accessible re-placement control a press has no keyboard form of", () => {
    renderGraph({
      renderMemberActions: (contextId) => (
        <button type="button">{`Move ${contextId}`}</button>
      ),
    });

    expect(
      screen.getByRole("button", { name: "Move ctx_checkout" }),
    ).toBeInTheDocument();
  });
});
