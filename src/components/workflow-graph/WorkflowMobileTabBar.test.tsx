// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WorkflowMobileTabBar } from "./WorkflowMobileTabBar";

const tabs = [
  { value: "graph", label: "Graph" },
  { value: "definitions", label: "Defs" },
  { value: "inspector", label: "Inspector" },
] as const;

describe("WorkflowMobileTabBar", () => {
  it("renders all provided tabs", () => {
    render(
      <WorkflowMobileTabBar
        tabs={tabs}
        activePanel="graph"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Graph")).toBeInTheDocument();
    expect(screen.getByText("Defs")).toBeInTheDocument();
    expect(screen.getByText("Inspector")).toBeInTheDocument();
  });

  it("applies active class to the selected tab only", () => {
    render(
      <WorkflowMobileTabBar
        tabs={tabs}
        activePanel="definitions"
        onChange={() => {}}
      />,
    );
    const defsBtn = screen.getByText("Defs").closest("button");
    const graphBtn = screen.getByText("Graph").closest("button");

    expect(defsBtn?.classList.contains("active")).toBe(true);
    expect(graphBtn?.classList.contains("active")).toBe(false);
  });

  it("calls onChange with the clicked tab value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkflowMobileTabBar
        tabs={tabs}
        activePanel="graph"
        onChange={onChange}
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
      />,
    );

    await user.click(screen.getByText("Graph"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
