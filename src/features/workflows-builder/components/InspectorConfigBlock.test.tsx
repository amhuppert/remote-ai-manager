// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import InspectorConfigBlock from "./InspectorConfigBlock";

const baseProps = {
  label: "Implementer",
  summary: "claude · sonnet · high",
};

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

  describe("source variant class (drives left border)", () => {
    const cases: Array<{
      source: "global" | "workflow" | "context-override" | "disabled";
      cls: string;
    }> = [
      { source: "global", cls: "wb-inspector-block--source-global" },
      { source: "workflow", cls: "wb-inspector-block--source-workflow" },
      {
        source: "context-override",
        cls: "wb-inspector-block--source-context-override",
      },
      { source: "disabled", cls: "wb-inspector-block--source-disabled" },
    ];

    for (const { source, cls } of cases) {
      it(`applies ${cls} when source is ${source}`, () => {
        const { container } = render(
          <InspectorConfigBlock {...baseProps} source={source} />,
        );
        const block = container.querySelector(".wb-inspector-block");
        expect(block).not.toBeNull();
        expect(block?.classList.contains(cls)).toBe(true);
      });
    }
  });

  describe("default open/closed state", () => {
    it("is collapsed by default when source is global", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="global" />,
      );
      const body = container.querySelector(".wb-inspector-block__body");
      expect(body).not.toBeNull();
      expect(body?.hasAttribute("hidden")).toBe(true);
    });

    it("is collapsed by default when source is workflow", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="workflow" />,
      );
      const body = container.querySelector(".wb-inspector-block__body");
      expect(body?.hasAttribute("hidden")).toBe(true);
    });

    it("is expanded by default when source is context-override", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="context-override" />,
      );
      const body = container.querySelector(".wb-inspector-block__body");
      expect(body?.hasAttribute("hidden")).toBe(false);
    });

    it("is expanded by default when source is disabled", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="disabled" />,
      );
      const body = container.querySelector(".wb-inspector-block__body");
      expect(body?.hasAttribute("hidden")).toBe(false);
    });

    it("toggles open/closed when the header is clicked", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="global" />,
      );
      const head = container.querySelector(".wb-inspector-block__head");
      const body = container.querySelector(".wb-inspector-block__body");
      expect(body?.hasAttribute("hidden")).toBe(true);
      fireEvent.click(head as Element);
      expect(body?.hasAttribute("hidden")).toBe(false);
    });
  });

  describe("children readonly wrapper", () => {
    const inherited: Array<"global" | "workflow" | "disabled"> = [
      "global",
      "workflow",
      "disabled",
    ];

    for (const source of inherited) {
      it(`wraps children with --readonly when source is ${source}`, () => {
        const { container } = render(
          <InspectorConfigBlock {...baseProps} source={source} defaultOpen>
            <span data-testid="child">body</span>
          </InspectorConfigBlock>,
        );
        const controls = container.querySelector(
          ".wb-inspector-block__controls",
        );
        expect(
          controls?.classList.contains(
            "wb-inspector-block__controls--readonly",
          ),
        ).toBe(true);
      });
    }

    it("does NOT wrap children with --readonly when source is context-override", () => {
      const { container } = render(
        <InspectorConfigBlock {...baseProps} source="context-override">
          <span data-testid="child">body</span>
        </InspectorConfigBlock>,
      );
      const controls = container.querySelector(".wb-inspector-block__controls");
      expect(
        controls?.classList.contains("wb-inspector-block__controls--readonly"),
      ).toBe(false);
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

  describe("mobile footer buttons", () => {
    it("CSS rules give footer buttons min-height var(--touch-target-min) at max-width: 768px", () => {
      const css = readFileSync(
        path.resolve(__dirname, "../styles/workflows-builder.css"),
        "utf8",
      );
      const match = css.match(
        /@media \(max-width: 768px\) \{[\s\S]*?\.wb-inspector-block__foot[\s\S]*?min-height: var\(--touch-target-min\)[\s\S]*?\}/,
      );
      expect(match).not.toBeNull();
    });
  });
});
