// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TicketChildSummary } from "./TicketChildSummary";

afterEach(cleanup);

describe("TicketChildSummary", () => {
  it("identifies parents and shows every child status without counting closed tickets as done", () => {
    render(
      <TicketChildSummary
        counts={[
          { status: "done", count: 2 },
          { status: "in_progress", count: 1 },
          { status: "blocked", count: 1 },
          { status: "not_started", count: 3 },
          { status: "closed", count: 1 },
        ]}
      />,
    );
    expect(
      screen.getByRole("group", { name: "Child ticket status" }),
    ).toBeInTheDocument();
    expect(screen.getByText("8 children")).toBeInTheDocument();
    expect(screen.getByText("2 of 8 done")).toBeInTheDocument();
    for (const label of [
      "2 Done",
      "1 In Progress",
      "1 Blocked",
      "3 Not Started",
      "1 Closed",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("does not render for tickets without children", () => {
    const { container, rerender } = render(<TicketChildSummary />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TicketChildSummary counts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
