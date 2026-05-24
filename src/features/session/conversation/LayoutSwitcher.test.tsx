// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import LayoutSwitcher from "@/features/session/conversation/LayoutSwitcher";

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
    const buttons = container.querySelectorAll(".layout-btn");
    // Buttons order: conversation, default, split, diff
    fireEvent.click(buttons[0]!);
    expect(onLayoutChange).toHaveBeenCalledWith("conversation");

    fireEvent.click(buttons[2]!);
    expect(onLayoutChange).toHaveBeenCalledWith("split");

    fireEvent.click(buttons[3]!);
    expect(onLayoutChange).toHaveBeenCalledWith("diff");
  });

  it("highlights the active mode (Req 4.4)", () => {
    const { container } = render(
      <LayoutSwitcher activeLayout="split" onLayoutChange={vi.fn()} />,
    );
    const buttons = container.querySelectorAll(".layout-btn");
    // "split" is the 3rd button (index 2)
    expect(buttons[2]!.className).toContain("active");
    // Others should not have active
    expect(buttons[0]!.className).not.toContain("active");
    expect(buttons[1]!.className).not.toContain("active");
    expect(buttons[3]!.className).not.toContain("active");
  });

  it("shows tooltips for each mode", () => {
    const { container } = render(
      <LayoutSwitcher activeLayout="default" onLayoutChange={vi.fn()} />,
    );
    const buttons = container.querySelectorAll(".layout-btn");
    expect(buttons[0]!.getAttribute("data-tooltip")).toBe("Conversation only");
    expect(buttons[1]!.getAttribute("data-tooltip")).toBe("Default split");
    expect(buttons[2]!.getAttribute("data-tooltip")).toBe("50 / 50 split");
    expect(buttons[3]!.getAttribute("data-tooltip")).toBe("Diff only");
  });
});
