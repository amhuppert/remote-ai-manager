// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ContextTabs from "./ContextTabs";
import type { InspectorTab } from "./navigation";

function renderTabs(
  activeTab: InspectorTab,
  onTabChange: (tab: InspectorTab) => void = vi.fn(),
) {
  return render(
    <ContextTabs
      activeTab={activeTab}
      onTabChange={onTabChange}
      above={<p>2 parked questions</p>}
      tasks={<p>tasks surface</p>}
      config={<p>config surface</p>}
      history={<p>history surface</p>}
    />,
  );
}

describe("ContextTabs", () => {
  it("offers Tasks, Config and History as real tabs", () => {
    renderTabs("tasks");

    expect(
      screen.getByRole("tablist", { name: "Context inspector sections" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Tasks",
      "Config",
      "History",
    ]);
  });

  it("shows only the active tab's surface", () => {
    const { rerender } = renderTabs("tasks");

    expect(screen.getByText("tasks surface")).toBeInTheDocument();
    expect(screen.queryByText("config surface")).not.toBeInTheDocument();

    rerender(
      <ContextTabs
        activeTab="config"
        onTabChange={vi.fn()}
        tasks={<p>tasks surface</p>}
        config={<p>config surface</p>}
        history={<p>history surface</p>}
      />,
    );

    expect(screen.getByText("config surface")).toBeInTheDocument();
    expect(screen.queryByText("tasks surface")).not.toBeInTheDocument();
  });

  it("keeps the above-panel content visible on every tab", () => {
    renderTabs("history");

    expect(screen.getByText("2 parked questions")).toBeInTheDocument();
    expect(screen.getByText("history surface")).toBeInTheDocument();
  });

  it("reports the tab the reader picked rather than switching itself", async () => {
    const onTabChange = vi.fn();
    renderTabs("tasks", onTabChange);

    await userEvent.click(screen.getByRole("tab", { name: "History" }));

    expect(onTabChange).toHaveBeenCalledWith("history");
    expect(screen.getByText("tasks surface")).toBeInTheDocument();
  });

  it("moves between tabs with the arrow keys", async () => {
    const onTabChange = vi.fn();
    renderTabs("tasks", onTabChange);

    screen.getByRole("tab", { name: "Tasks" }).focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Config" })).toHaveFocus();
    expect(onTabChange).toHaveBeenCalledWith("config");
  });
});
