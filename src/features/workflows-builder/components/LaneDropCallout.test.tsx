// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import LaneDropCallout from "./LaneDropCallout";

describe("LaneDropCallout", () => {
  it("states the refusal, the remedy and that nothing was written", () => {
    render(
      <LaneDropCallout
        tone="red"
        title="Placement check failed"
        message={
          '"session" admits only read-only contexts. "Implement checkout" is owning (src/checkout, src/risk). Change its grade to read-only, or drop it on a group lane.'
        }
        footnote="Nothing was written. The definition is still at the same dirty state it had before the drag."
        onDismiss={() => {}}
      />,
    );

    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("Placement check failed");
    expect(card).toHaveTextContent("admits only read-only contexts");
    expect(card).toHaveTextContent("Change its grade to read-only");
    expect(card).toHaveTextContent("Nothing was written");
  });

  it("announces an accepted-but-notable placement without crying failure", () => {
    render(
      <LaneDropCallout
        tone="amber"
        title="Placed on delivery"
        message='"Rollout switch" needs exclusive occupancy of lane delivery.'
        onDismiss={() => {}}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("exclusive occupancy");
  });

  it("can be dismissed from the keyboard", async () => {
    const onDismiss = vi.fn();
    render(
      <LaneDropCallout
        tone="red"
        title="Placement check failed"
        message="Refused."
        onDismiss={onDismiss}
      />,
    );

    const dismiss = screen.getByRole("button", {
      name: /Dismiss — Placement check failed/,
    });
    dismiss.focus();
    await userEvent.keyboard("{Enter}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
