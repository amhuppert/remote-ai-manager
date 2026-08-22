// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WorkflowMobileTabBar } from "./WorkflowMobileTabBar";

const tabs = [
  { value: "graph", label: "Graph", icon: "graph" },
  { value: "definitions", label: "Defs", icon: "list" },
  { value: "inspector", label: "Inspector", icon: "panel" },
] as const;

describe("WorkflowMobileTabBar", () => {
  it("renders all provided tabs", () => {
    render(
      <WorkflowMobileTabBar
        tabs={tabs}
        activePanel="graph"
        onChange={() => {}}
        label="Builder panels"
      />,
    );
    expect(screen.getByText("Graph")).toBeInTheDocument();
    expect(screen.getByText("Defs")).toBeInTheDocument();
    expect(screen.getByText("Inspector")).toBeInTheDocument();
  });

  it("marks the selected tab active only", () => {
    render(
      <WorkflowMobileTabBar
        tabs={tabs}
        activePanel="definitions"
        onChange={() => {}}
        label="Builder panels"
      />,
    );
    const defsBtn = screen.getByText("Defs").closest("button");
    const graphBtn = screen.getByText("Graph").closest("button");

    expect(defsBtn?.getAttribute("data-active")).toBe("true");
    expect(graphBtn?.getAttribute("data-active")).toBe("false");
  });

  it("calls onChange with the clicked tab value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkflowMobileTabBar
        tabs={tabs}
        activePanel="graph"
        onChange={onChange}
        label="Builder panels"
      />,
    );

    await user.click(screen.getByText("Inspector"));
    expect(onChange).toHaveBeenCalledWith("inspector");
  });

  it("does not call onChange when clicking the active tab", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkflowMobileTabBar
        tabs={tabs}
        activePanel="graph"
        onChange={onChange}
        label="Builder panels"
      />,
    );

    await user.click(screen.getByText("Graph"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
