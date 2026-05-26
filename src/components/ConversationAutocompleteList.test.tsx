// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ConversationAutocompleteList,
  type ConversationAutocompleteListItem,
} from "./ConversationAutocompleteList";

function makeItem(
  overrides: Partial<ConversationAutocompleteListItem> & { id: string },
): ConversationAutocompleteListItem {
  return {
    id: overrides.id,
    displayLabel: overrides.displayLabel ?? `Conversation ${overrides.id}`,
    matchIndices: overrides.matchIndices ?? [],
    projectName: overrides.projectName ?? "proj",
    sessionName: overrides.sessionName ?? "main",
    backend: overrides.backend ?? "claude",
    model: overrides.model ?? null,
    lastActivityRelative: overrides.lastActivityRelative ?? "1h",
    status: overrides.status ?? "new",
    isCurrentProject: overrides.isCurrentProject ?? false,
    archived: overrides.archived ?? false,
  };
}

const NO_OP = () => {};

describe("ConversationAutocompleteList", () => {
  it("renders each item with its display label and project · session sub-line", () => {
    const items = [
      makeItem({
        id: "a",
        displayLabel: "Refactor parser",
        projectName: "my-app",
        sessionName: "main",
      }),
    ];
    render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={1}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );

    expect(screen.getByText("Refactor parser")).toBeInTheDocument();
    expect(screen.getByText(/my-app/)).toBeInTheDocument();
    expect(screen.getByText(/main/)).toBeInTheDocument();
  });

  it("marks the selected row as active", () => {
    const items = [
      makeItem({ id: "a", displayLabel: "first" }),
      makeItem({ id: "b", displayLabel: "second" }),
    ];
    const { container } = render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={1}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={2}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );

    const rows = container.querySelectorAll(".conversation-item");
    expect(rows[0]?.className).not.toContain("active");
    expect(rows[1]?.className).toContain("active");
  });

  it("highlights match indices on the display label", () => {
    const items = [
      makeItem({
        id: "a",
        displayLabel: "foo bar",
        matchIndices: [0, 1, 2],
      }),
    ];
    const { container } = render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={1}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );
    expect(container.querySelectorAll(".conversation-match")).toHaveLength(3);
  });

  it("invokes onSelect when a row is clicked", () => {
    const items = [makeItem({ id: "a" })];
    const onSelect = vi.fn();
    render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={onSelect}
        totalCount={1}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );

    fireEvent.click(screen.getByText("Conversation a"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it("invokes onHover with the index when a row is hovered", () => {
    const items = [
      makeItem({ id: "a", displayLabel: "first" }),
      makeItem({ id: "b", displayLabel: "second" }),
    ];
    const onHover = vi.fn();
    const { container } = render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={onHover}
        onSelect={NO_OP}
        totalCount={2}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );

    const rows = container.querySelectorAll(".conversation-item");
    fireEvent.mouseEnter(rows[1] as Element);
    expect(onHover).toHaveBeenCalledWith(1);
  });

  it("invokes onToggleArchived when the archived button is clicked", () => {
    const onToggleArchived = vi.fn();
    render(
      <ConversationAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={0}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={onToggleArchived}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /archived/i }));
    expect(onToggleArchived).toHaveBeenCalledTimes(1);
  });

  it("reflects includeArchived via aria-pressed on the archived toggle", () => {
    render(
      <ConversationAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={0}
        loading={false}
        error={null}
        includeArchived={true}
        onToggleArchived={NO_OP}
      />,
    );

    expect(screen.getByRole("button", { name: /archived/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the loading slot when loading is true", () => {
    render(
      <ConversationAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={0}
        loading={true}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the error slot with the error message when error is set", () => {
    render(
      <ConversationAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={0}
        loading={false}
        error="Network failure"
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );
    expect(screen.getByText("Network failure")).toBeInTheDocument();
  });

  it("renders the empty slot when not loading and no items", () => {
    render(
      <ConversationAutocompleteList
        items={[]}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={0}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );
    expect(screen.getByText(/no matching conversations/i)).toBeInTheDocument();
  });

  it("shows 'N of M' count when totalCount exceeds displayed items", () => {
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
    render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={50}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );
    expect(screen.getByText("2 of 50")).toBeInTheDocument();
  });

  it("applies the archived modifier class to archived rows", () => {
    const items = [makeItem({ id: "a", archived: true })];
    const { container } = render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={1}
        loading={false}
        error={null}
        includeArchived={true}
        onToggleArchived={NO_OP}
      />,
    );
    expect(
      container.querySelector(".conversation-item--archived"),
    ).not.toBeNull();
  });

  it("renders a status dot only for running or waiting_for_input", () => {
    const items = [
      makeItem({ id: "new", status: "new" }),
      makeItem({ id: "running", status: "running" }),
      makeItem({ id: "waiting", status: "waiting_for_input" }),
    ];
    const { container } = render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={3}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );

    const dots = container.querySelectorAll(".conversation-item__status-dot");
    expect(dots).toHaveLength(2);
  });

  it("shows 'current' as the project label when isCurrentProject is true", () => {
    const items = [
      makeItem({
        id: "a",
        projectName: "elsewhere",
        isCurrentProject: true,
      }),
    ];
    const { container } = render(
      <ConversationAutocompleteList
        items={items}
        selectedIndex={0}
        onHover={NO_OP}
        onSelect={NO_OP}
        totalCount={1}
        loading={false}
        error={null}
        includeArchived={false}
        onToggleArchived={NO_OP}
      />,
    );
    expect(
      container.querySelector(".conversation-item__project")?.textContent,
    ).toBe("current");
    expect(screen.queryByText(/elsewhere/)).not.toBeInTheDocument();
  });
});
