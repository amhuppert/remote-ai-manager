// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SidebarGroupBy } from "./ConversationSidebar.helpers";
import ConversationSidebarFilters from "./ConversationSidebarFilters";
import { GROUP_BY_STORAGE_KEY } from "@/hooks/use-sidebar-persistent-filters";
import { useSessionDetailStore } from "@/stores/session-detail.store";

function FiltersHarness({
  initialGroupBy,
}: {
  initialGroupBy: SidebarGroupBy;
}) {
  useLayoutEffect(() => {
    window.sessionStorage.setItem(
      GROUP_BY_STORAGE_KEY,
      JSON.stringify(initialGroupBy),
    );
    return () => window.sessionStorage.removeItem(GROUP_BY_STORAGE_KEY);
  }, [initialGroupBy]);

  return <ConversationSidebarFilters key={initialGroupBy} />;
}

afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});

describe("ConversationSidebarFilters", () => {
  it("activates the Session group", () => {
    render(<FiltersHarness initialGroupBy="session" />);
    expect(screen.getByRole("radio", { name: "Session" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("radio", { name: "None" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Status" })).toBeNull();
  });

  it("activates the Project group", () => {
    render(<FiltersHarness initialGroupBy="project" />);
    expect(screen.getByRole("radio", { name: "Project" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
