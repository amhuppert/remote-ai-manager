// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ScopedAgentCapabilitiesConfig from "./ScopedAgentCapabilitiesConfig";

vi.mock("./AgentCapabilitiesConfigurator", () => ({
  AgentCapabilitiesConfigurator: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="configurator-stub">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

describe("ScopedAgentCapabilitiesConfig — uncontrolled mode (default)", () => {
  it("renders the trigger button and toggles the drawer", () => {
    render(
      <ScopedAgentCapabilitiesConfig
        level="project"
        projectName="my-project"
      />,
    );
    const trigger = screen.getByRole("button", { name: /capabilit/i });
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByTestId("configurator-stub")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId("configurator-stub")).toBeInTheDocument();
  });
});

describe("ScopedAgentCapabilitiesConfig — controlled mode", () => {
  it("renders the drawer when open={true} without a trigger when renderTrigger={false}", () => {
    render(
      <ScopedAgentCapabilitiesConfig
        level="project"
        projectName="my-project"
        open={true}
        onOpenChange={vi.fn()}
        renderTrigger={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /capabilit/i })).toBeNull();
    expect(screen.getByTestId("configurator-stub")).toBeInTheDocument();
  });

  it("hides the drawer when open={false}", () => {
    render(
      <ScopedAgentCapabilitiesConfig
        level="project"
        projectName="my-project"
        open={false}
        onOpenChange={vi.fn()}
        renderTrigger={false}
      />,
    );
    expect(screen.queryByTestId("configurator-stub")).toBeNull();
  });

  it("calls onOpenChange(false) when overlay is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <ScopedAgentCapabilitiesConfig
        level="project"
        projectName="my-project"
        open={true}
        onOpenChange={onOpenChange}
        renderTrigger={false}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-capabilities-drawer-overlay"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onOpenChange(true) when the trigger is clicked in controlled mode", () => {
    const onOpenChange = vi.fn();
    render(
      <ScopedAgentCapabilitiesConfig
        level="project"
        projectName="my-project"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /capabilit/i }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
