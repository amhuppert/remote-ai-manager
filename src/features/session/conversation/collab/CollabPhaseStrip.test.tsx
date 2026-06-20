// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CollabPhaseStrip from "@/features/session/conversation/collab/CollabPhaseStrip";

describe("CollabPhaseStrip", () => {
  it("renders pips with status data attributes for each phase", () => {
    const { container } = render(
      <CollabPhaseStrip
        phases={[
          { kind: { kind: "initial_draft" }, status: "done" },
          { kind: { kind: "cross_review" }, status: "done" },
          { kind: { kind: "negotiation", round: 1 }, status: "active" },
          { kind: { kind: "final_answer" }, status: "pending" },
        ]}
      />,
    );

    const pips = Array.from(container.querySelectorAll("[data-status]"));
    expect(pips).toHaveLength(4);
    expect(pips[0]?.getAttribute("data-status")).toBe("done");
    expect(pips[2]?.getAttribute("data-status")).toBe("active");
    expect(pips[2]?.getAttribute("aria-current")).toBe("step");
    expect(pips[3]?.getAttribute("data-status")).toBe("pending");
    expect(pips[3]?.getAttribute("aria-current")).toBeNull();
  });

  it("decorates the strip with the verdict pill when terminal", () => {
    const { container } = render(
      <CollabPhaseStrip
        phases={[
          { kind: { kind: "initial_draft" }, status: "done" },
          { kind: { kind: "final_answer" }, status: "done" },
        ]}
        verdict="converged"
      />,
    );

    const verdict = container.querySelector("li[data-verdict]");
    expect(verdict).not.toBeNull();
    expect(verdict?.getAttribute("data-verdict")).toBe("converged");
    expect(verdict?.textContent ?? "").toContain("converged");
  });

  it("shows the Stop button only while at least one phase is active and onStop is provided", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const { rerender } = render(
      <CollabPhaseStrip
        phases={[
          { kind: { kind: "initial_draft" }, status: "done" },
          { kind: { kind: "negotiation", round: 1 }, status: "active" },
        ]}
        onStop={onStop}
      />,
    );

    const stop = screen.getByRole("button", { name: /stop collaboration/i });
    await user.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(
      <CollabPhaseStrip
        phases={[
          { kind: { kind: "initial_draft" }, status: "done" },
          { kind: { kind: "final_answer" }, status: "done" },
        ]}
        verdict="converged"
        onStop={onStop}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /stop collaboration/i }),
    ).toBeNull();
  });

  it("toggles the compact data attribute for the pinned bottom variant", () => {
    const { container, rerender } = render(
      <CollabPhaseStrip
        phases={[{ kind: { kind: "initial_draft" }, status: "done" }]}
      />,
    );

    expect(
      container.querySelector("[data-compact]")?.getAttribute("data-compact"),
    ).toBe("false");

    rerender(
      <CollabPhaseStrip
        phases={[{ kind: { kind: "initial_draft" }, status: "done" }]}
        compact
      />,
    );

    expect(
      container.querySelector("[data-compact]")?.getAttribute("data-compact"),
    ).toBe("true");
  });
});
