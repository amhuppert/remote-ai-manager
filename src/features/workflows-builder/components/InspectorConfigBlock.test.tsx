// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import InspectorConfigBlock from "./InspectorConfigBlock";

const baseProps = {
  label: "Implementer",
  summary: "claude · sonnet · high",
};

function getHead(container: HTMLElement): HTMLElement {
  const head = container.querySelector<HTMLElement>("button[aria-expanded]");
  expect(head).not.toBeNull();
  return head as HTMLElement;
}

// The Radix-backed disclosure unmounts the closed region, so the body resolves
// only while open. Find it via the trigger's aria-controls (absent → collapsed).
function getBody(container: HTMLElement): HTMLElement | null {
  const head = getHead(container);
  const controls = head.getAttribute("aria-controls");
  return controls ? container.ownerDocument.getElementById(controls) : null;
}

describe("InspectorConfigBlock", () => {
  describe("default open/closed state", () => {
    it("is collapsed by default when source is global", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="global" />,
      );
      expect(getBody(container)).toBeNull();
    });

    it("is expanded by default when source is context-override", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="context-override" />,
      );
      expect(getBody(container)).not.toBeNull();
    });
  });

  describe("children readonly wrapper", () => {
    it("marks inherited children aria-disabled", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="global" defaultOpen>
          <span data-testid="child">body</span>
        </InspectorConfigBlock>,
      );
      const controls = container.querySelector("[aria-disabled]");
      expect(controls?.getAttribute("aria-disabled")).toBe("true");
    });

    it("does NOT mark children aria-disabled when source is context-override", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="context-override">
          <span data-testid="child">body</span>
        </InspectorConfigBlock>,
      );
      expect(container.querySelector("[aria-disabled]")).toBeNull();
    });
  });

  describe("footer buttons and callbacks", () => {
    it("fires onOverride from inherited state", () => {
      const onOverride = vi.fn();
      render(
        <InspectorConfigBlock
          {...baseProps}
          source="global"
          defaultOpen
          onOverride={onOverride}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Override" }));
      expect(onOverride).toHaveBeenCalledTimes(1);
    });

    it("fires onReset from context-override state", () => {
      const onReset = vi.fn();
      render(
        <InspectorConfigBlock
          {...baseProps}
          source="context-override"
          onReset={onReset}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Reset to inherit" }));
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it("fires onToggleDisabled from context-override state (validator)", () => {
      const onToggleDisabled = vi.fn();
      render(
        <InspectorConfigBlock
          {...baseProps}
          source="context-override"
          onToggleDisabled={onToggleDisabled}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Disable for this context" }),
      );
      expect(onToggleDisabled).toHaveBeenCalledTimes(1);
    });

    it("renders Re-enable + Override with custom validator from disabled state", () => {
      const onToggleDisabled = vi.fn();
      const onOverride = vi.fn();
      render(
        <InspectorConfigBlock
          {...baseProps}
          source="disabled"
          onToggleDisabled={onToggleDisabled}
          onOverride={onOverride}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Re-enable (inherit)" }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "Override with custom validator",
        }),
      );
      expect(onToggleDisabled).toHaveBeenCalledTimes(1);
      expect(onOverride).toHaveBeenCalledTimes(1);
    });

    it("omits Override button in inherited state when onOverride is not provided", () => {
      render(
        <InspectorConfigBlock {...baseProps} source="global" defaultOpen />,
      );
      expect(screen.queryByRole("button", { name: "Override" })).toBeNull();
    });

    it("omits Reset to inherit in override state when onReset is not provided", () => {
      render(<InspectorConfigBlock {...baseProps} source="context-override" />);
      expect(
        screen.queryByRole("button", { name: "Reset to inherit" }),
      ).toBeNull();
    });
  });

  describe("non-collapsible gate variant", () => {
    const gateProps = {
      label: "Script validator",
      source: "global" as const,
      collapsible: false,
      description: "Runs selected registered commands.",
    };

    it("hosts a design-system switch in the header and fires onCheckedChange", () => {
      const onCheckedChange = vi.fn();
      render(
        <InspectorConfigBlock
          {...gateProps}
          headerSwitch={{
            checked: false,
            onCheckedChange,
            ariaLabel: "Script validator",
          }}
        />,
      );
      const toggle = screen.getByRole("switch", { name: "Script validator" });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(toggle);
      expect(onCheckedChange).toHaveBeenCalledWith(true);
    });

    it("renders no disclosure trigger and shows the description", () => {
      const { container } = render(
        <InspectorConfigBlock
          {...gateProps}
          headerSwitch={{
            checked: true,
            onCheckedChange: vi.fn(),
            ariaLabel: "Script validator",
          }}
        />,
      );
      expect(container.querySelector("button[aria-expanded]")).toBeNull();
      expect(
        screen.getByText("Runs selected registered commands."),
      ).toBeInTheDocument();
    });

    it("shows an always-visible Reset to inherit when overridden", () => {
      const onReset = vi.fn();
      render(
        <InspectorConfigBlock
          {...gateProps}
          source="context-override"
          onReset={onReset}
          headerSwitch={{
            checked: true,
            onCheckedChange: vi.fn(),
            ariaLabel: "Script validator",
          }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Reset to inherit" }));
      expect(onReset).toHaveBeenCalledTimes(1);
    });
  });
});
