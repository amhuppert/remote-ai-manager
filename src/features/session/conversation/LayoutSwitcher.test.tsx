// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import LayoutSwitcher from "@/features/session/conversation/LayoutSwitcher";

function buttonByTooltip(
  container: HTMLElement,
  tooltip: string,
): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    `.layout-btn[data-tooltip="${tooltip}"]`,
  );
  if (!btn) throw new Error(`No layout-btn with tooltip ${tooltip}`);
  return btn;
}

describe("LayoutSwitcher", () => {
  it("renders four layout mode buttons (Req 4.1)", () => {
    const { container } = render(
      <LayoutSwitcher activeLayout="default" onLayoutChange={vi.fn()} />,
    );
    const buttons = container.querySelectorAll(".layout-btn");
    expect(buttons.length).toBe(4);
  });

  it("calls onLayoutChange with correct mode on click (Req 4.4)", () => {
    const onLayoutChange = vi.fn();
    const { container } = render(
      <LayoutSwitcher activeLayout="default" onLayoutChange={onLayoutChange} />,
    );
    fireEvent.click(buttonByTooltip(container, "Conversation only"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("conversation");

    fireEvent.click(buttonByTooltip(container, "Split 50/50"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("split");

    fireEvent.click(buttonByTooltip(container, "Diff only"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("diff");
  });

  it("highlights the active mode (Req 4.4)", () => {
    const { container } = render(
      <LayoutSwitcher activeLayout="split" onLayoutChange={vi.fn()} />,
    );
    expect(buttonByTooltip(container, "Split 50/50").className).toContain(
      "active",
    );
    expect(
      buttonByTooltip(container, "Conversation only").className,
    ).not.toContain("active");
    expect(
      buttonByTooltip(container, "Conversation + Diff sidebar").className,
    ).not.toContain("active");
    expect(buttonByTooltip(container, "Diff only").className).not.toContain(
      "active",
    );
  });

  it("shows tooltips for each mode", () => {
    const { container } = render(
      <LayoutSwitcher activeLayout="default" onLayoutChange={vi.fn()} />,
    );
    const tooltips = Array.from(container.querySelectorAll(".layout-btn")).map(
      (b) => b.getAttribute("data-tooltip"),
    );
    expect(tooltips).toEqual(
      expect.arrayContaining([
        "Conversation only",
        "Conversation + Diff sidebar",
        "Split 50/50",
        "Diff only",
      ]),
    );
  });
});
