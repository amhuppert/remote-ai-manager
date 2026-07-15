// @vitest-environment jsdom
import * as matchers from "@testing-library/jest-dom/matchers";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ScopedAgentCapabilitiesConfig from "./ScopedAgentCapabilitiesConfig";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";

expect.extend(matchers);

// The drawer composes ui/Dialog (Radix) — it locks scroll / manages focus on
// open, and jsdom implements none of the pointer-capture APIs it reaches for.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

vi.mock("./AgentCapabilitiesConfigurator", () => ({
  AgentCapabilitiesConfigurator: ({
    layerOptions,
    initialScope,
    onClose,
  }: {
    layerOptions: readonly {
      label: string;
      scope: AgentCapabilityScope;
      disabled?: boolean;
    }[];
    initialScope?: AgentCapabilityScope;
    onClose: () => void;
  }) => (
    <div data-testid="configurator-stub">
      <span data-testid="initial-scope">{JSON.stringify(initialScope)}</span>
      <span data-testid="layer-labels">
        {layerOptions.map((option) => option.label).join("|")}
      </span>
      <span data-testid="layer-scopes">
        {JSON.stringify(layerOptions.map((option) => option.scope))}
      </span>
      <span data-testid="layer-disabled">
        {JSON.stringify(layerOptions.map((option) => option.disabled ?? false))}
      </span>
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

  it("calls onOpenChange(false) when the drawer is dismissed with Escape", () => {
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
    // Radix owns dismissal now (the drawer composes ui/Dialog's unstyled
    // edge-anchored variant), so Escape drives onOpenChange(false).
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
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

describe("ScopedAgentCapabilitiesConfig — project conversation scope", () => {
  it("starts at the active project conversation and exposes global, project, and conversation layers only", () => {
    render(
      <ScopedAgentCapabilitiesConfig
        level="conversation"
        conversationScope="project"
        projectName="my-project"
        conversationId="plc-1"
        open={true}
        renderTrigger={false}
      />,
    );

    expect(screen.getByTestId("initial-scope")).toHaveTextContent(
      JSON.stringify({
        level: "conversation",
        projectName: "my-project",
        conversationScope: "project",
        conversationId: "plc-1",
      }),
    );
    expect(screen.getByTestId("layer-labels")).toHaveTextContent(
      "Global|Project|Conversation",
    );
    expect(screen.getByTestId("layer-scopes")).toHaveTextContent(
      JSON.stringify([
        { level: "global" },
        { level: "project", projectName: "my-project" },
        {
          level: "conversation",
          projectName: "my-project",
          conversationScope: "project",
          conversationId: "plc-1",
        },
      ]),
    );
    expect(screen.getByTestId("layer-scopes")).not.toHaveTextContent(
      "sessionName",
    );
  });

  it("keeps the conversation layer disabled when no project conversation is selected", () => {
    render(
      <ScopedAgentCapabilitiesConfig
        level="conversation"
        conversationScope="project"
        projectName="my-project"
        open={true}
        renderTrigger={false}
      />,
    );

    expect(screen.getByTestId("initial-scope")).toHaveTextContent(
      JSON.stringify({ level: "project", projectName: "my-project" }),
    );
    expect(screen.getByTestId("layer-labels")).toHaveTextContent(
      "Global|Project|Conversation",
    );
    expect(screen.getByTestId("layer-disabled")).toHaveTextContent(
      JSON.stringify([false, false, true]),
    );
  });

  it("does not expose a backend-change control for project conversations", () => {
    render(
      <ScopedAgentCapabilitiesConfig
        level="conversation"
        conversationScope="project"
        projectName="my-project"
        conversationId="plc-1"
        open={true}
        renderTrigger={false}
      />,
    );

    expect(screen.queryByRole("combobox", { name: /backend/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /change backend/i }),
    ).toBeNull();
  });
});
