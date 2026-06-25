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
  describe("source badges", () => {
    it('renders "INHERITED · GLOBAL" when source is global', () => {
      render(<InspectorConfigBlock {...baseProps} source="global" />);
      expect(screen.getByText("INHERITED · GLOBAL")).toBeInTheDocument();
    });

    it('renders "INHERITED · WORKFLOW" when source is workflow', () => {
      render(<InspectorConfigBlock {...baseProps} source="workflow" />);
      expect(screen.getByText("INHERITED · WORKFLOW")).toBeInTheDocument();
    });

    it('renders "OVERRIDDEN" when source is context-override', () => {
      render(<InspectorConfigBlock {...baseProps} source="context-override" />);
      expect(screen.getByText("OVERRIDDEN")).toBeInTheDocument();
    });

    it('renders "DISABLED" when source is disabled', () => {
      render(<InspectorConfigBlock {...baseProps} source="disabled" />);
      expect(screen.getByText("DISABLED")).toBeInTheDocument();
    });
  });

  describe("source data attribute (drives left-border styling)", () => {
    const sources: Array<
      "global" | "workflow" | "context-override" | "disabled"
    > = ["global", "workflow", "context-override", "disabled"];

    for (const source of sources) {
      it(`exposes data-source="${source}"`, () => {
        const { container } = render(
          <InspectorConfigBlock {...baseProps} source={source} />,
        );
        const block = container.querySelector("[data-source]");
        expect(block?.getAttribute("data-source")).toBe(source);
      });
    }
  });

  describe("default open/closed state", () => {
    it("is collapsed by default when source is global", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="global" />,
      );
      expect(getBody(container)).toBeNull();
    });

    it("is collapsed by default when source is workflow", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="workflow" />,
      );
      expect(getBody(container)).toBeNull();
    });

    it("is expanded by default when source is context-override", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="context-override" />,
      );
      expect(getBody(container)).not.toBeNull();
    });

    it("is expanded by default when source is disabled", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="disabled" />,
      );
      expect(getBody(container)).not.toBeNull();
    });

    it("toggles open/closed when the header is clicked", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="global" />,
      );
      const head = getHead(container);
      expect(getBody(container)).toBeNull();
      fireEvent.click(head);
      expect(getBody(container)).not.toBeNull();
    });
  });

  describe("Radix Collapsible disclosure wiring", () => {
    it("keeps the body out of the DOM while collapsed", () => {
      render(
        <InspectorConfigBlock {...baseProps} source="global">
          <span data-testid="cfg-body">body</span>
        </InspectorConfigBlock>,
      );
      // A Radix-backed disclosure unmounts the closed region (not merely hidden).
      expect(screen.queryByTestId("cfg-body")).toBeNull();
    });

    it("mounts the body when expanded by default (context-override)", () => {
      render(
        <InspectorConfigBlock {...baseProps} source="context-override">
          <span data-testid="cfg-body">body</span>
        </InspectorConfigBlock>,
      );
      expect(screen.getByTestId("cfg-body")).toBeInTheDocument();
    });

    it("wires aria-expanded + aria-controls from the header to the region", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="context-override">
          <span data-testid="cfg-body">body</span>
        </InspectorConfigBlock>,
      );
      const head = getHead(container);
      expect(head.getAttribute("aria-expanded")).toBe("true");
      const controls = head.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      expect(document.getElementById(controls!)).not.toBeNull();
    });
  });

  describe("children readonly wrapper", () => {
    const inherited: Array<"global" | "workflow" | "disabled"> = [
      "global",
      "workflow",
      "disabled",
    ];

    for (const source of inherited) {
      it(`marks children aria-disabled when source is ${source}`, () => {
        const { container } = render(
          <InspectorConfigBlock {...baseProps} source={source} defaultOpen>
            <span data-testid="child">body</span>
          </InspectorConfigBlock>,
        );
        const controls = container.querySelector("[aria-disabled]");
        expect(controls?.getAttribute("aria-disabled")).toBe("true");
      });
    }

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
});
