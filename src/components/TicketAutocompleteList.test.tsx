// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TicketAutocompleteList,
  type TicketAutocompleteListItem,
} from "./TicketAutocompleteList";

const items: TicketAutocompleteListItem[] = [
  {
    id: "t1",
    identifier: "alpha#12",
    title: "Harden authentication",
    titleMatchIndices: [7, 8, 9, 10],
    projectName: "alpha",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 3,
    activeSessionName: "Ticket: Harden authentication",
    isCurrentProject: true,
  },
  {
    id: "t2",
    identifier: "beta#7",
    title: "Investigate flaky test",
    titleMatchIndices: [],
    projectName: "beta",
    workType: "bug",
    status: "blocked",
    attachmentCount: 1,
    activeSessionName: null,
    isCurrentProject: false,
  },
];

describe("TicketAutocompleteList", () => {
  it("renders ticket identity, title, status, type, and context metadata", () => {
    render(
      <TicketAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        totalCount={2}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByText("alpha#12")).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "Harden authentication",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(screen.getByText("3 context")).toBeInTheDocument();
  });

  it("selects and hovers ticket rows", () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    render(
      <TicketAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={onHover}
        onSelect={onSelect}
        totalCount={2}
        loading={false}
        error={null}
      />,
    );

    const rows = screen.getAllByRole("option");
    fireEvent.mouseEnter(rows[1]!);
    fireEvent.click(rows[1]!);
    expect(onHover).toHaveBeenCalledWith(1);
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("renders loading, empty, and error states", () => {
    const { rerender } = render(
      <TicketAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        totalCount={0}
        loading
        error={null}
      />,
    );
    expect(screen.getByText("Loading tickets...")).toBeInTheDocument();

    rerender(
      <TicketAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        totalCount={0}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText("No matching tickets")).toBeInTheDocument();

    rerender(
      <TicketAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={() => {}}
        onSelect={() => {}}
        totalCount={0}
        loading={false}
        error="ticket query failed"
      />,
    );
    expect(screen.getByText("ticket query failed")).toBeInTheDocument();
  });
});
