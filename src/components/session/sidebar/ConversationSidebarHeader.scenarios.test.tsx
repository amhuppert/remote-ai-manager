// @vitest-environment jsdom
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SidebarListFilter } from "./ConversationSidebar.helpers";
import ConversationSidebarHeader from "./ConversationSidebarHeader";
import { useSessionDetailStore } from "@/stores/session-detail.store";

const DEFAULT_COUNTS = { all: 6, needs: 0, running: 4, session: 1 };

function HeaderHarness({
  counts = DEFAULT_COUNTS,
  initialFilter = "",
  initialListFilter = "all",
}: {
  counts?: Record<SidebarListFilter, number>;
  initialFilter?: string;
  initialListFilter?: SidebarListFilter;
}) {
  const [activeFilter, setActiveFilter] =
    useState<SidebarListFilter>(initialListFilter);

  useLayoutEffect(() => {
    useSessionDetailStore.setState({ sidebarFilter: initialFilter });
  }, [initialFilter]);

  return (
    <ConversationSidebarHeader
      counts={counts}
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
    />
  );
}

afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});

describe("ConversationSidebarHeader", () => {
  it("renders an empty search input without density controls", () => {
    render(<HeaderHarness />);
    const input = screen.getByLabelText("Search conversations");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("id", "conversation-sidebar-search");
    expect(input).toHaveAttribute("name", "conversation-search");
    expect(screen.queryByText("⌘K")).toBeNull();
    expect(screen.queryByRole("button", { name: "Comfortable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("renders the initial search filter", () => {
    render(<HeaderHarness initialFilter="validate" />);
    expect(screen.getByLabelText("Search conversations")).toHaveValue(
      "validate",
    );
    expect(screen.getAllByLabelText("Clear search")).toHaveLength(1);
  });

  it("shows the active Needs filter and count", () => {
    render(
      <HeaderHarness
        initialListFilter="needs"
        counts={{ all: 6, needs: 3, running: 2, session: 1 }}
      />,
    );
    const button = screen.getByRole("tab", { name: /needs 3/i });
    expect(button).toHaveAttribute("aria-selected", "true");
    expect(button).toHaveTextContent("3");
  });
});
