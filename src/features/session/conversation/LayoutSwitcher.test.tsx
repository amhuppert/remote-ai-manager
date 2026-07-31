// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LayoutSwitcher from "@/features/session/conversation/LayoutSwitcher";

// The tooltip label doubles as each icon-only button's accessible name
// (aria-label), so buttons are found by role name.
function buttonByLabel(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("LayoutSwitcher", () => {
  it("renders four layout mode buttons (Req 3.1)", () => {
    render(
      <LayoutSwitcher activeLayout="conversation" onLayoutChange={vi.fn()} />,
    );
    expect(screen.getAllByRole("button").length).toBe(4);
  });

  it("orders panes after split and before conversation-only (Req 3.1)", () => {
    render(
      <LayoutSwitcher activeLayout="conversation" onLayoutChange={vi.fn()} />,
    );
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Split 50/50",
      "Panes (split-screen)",
      "Conversation only",
      "Right panel only",
    ]);
  });

  it("activates panes layout on click (Req 3.1)", () => {
    const onLayoutChange = vi.fn();
    render(
      <LayoutSwitcher
        activeLayout="conversation"
        onLayoutChange={onLayoutChange}
      />,
    );
    fireEvent.click(buttonByLabel("Panes (split-screen)"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("panes");
  });

  it("highlights the panes mode when active (Req 3.1)", () => {
    render(<LayoutSwitcher activeLayout="panes" onLayoutChange={vi.fn()} />);
    expect(
      buttonByLabel("Panes (split-screen)").getAttribute("data-active"),
    ).toBe("true");
    expect(buttonByLabel("Split 50/50").getAttribute("data-active")).toBe(
      "false",
    );
  });

  it("calls onLayoutChange with correct mode on click (Req 4.4)", () => {
    const onLayoutChange = vi.fn();
    render(
      <LayoutSwitcher
        activeLayout="conversation"
        onLayoutChange={onLayoutChange}
      />,
    );
    fireEvent.click(buttonByLabel("Conversation only"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("conversation");

    fireEvent.click(buttonByLabel("Split 50/50"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("split");

    fireEvent.click(buttonByLabel("Right panel only"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("diff");
  });

  it("highlights the active mode (Req 4.4)", () => {
    render(<LayoutSwitcher activeLayout="split" onLayoutChange={vi.fn()} />);
    expect(buttonByLabel("Split 50/50").getAttribute("data-active")).toBe(
      "true",
    );
    expect(buttonByLabel("Conversation only").getAttribute("data-active")).toBe(
      "false",
    );
    expect(buttonByLabel("Right panel only").getAttribute("data-active")).toBe(
      "false",
    );
  });

  it("exposes an accessible name for each mode", () => {
    render(
      <LayoutSwitcher activeLayout="conversation" onLayoutChange={vi.fn()} />,
    );
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(
      expect.arrayContaining([
        "Conversation only",
        "Split 50/50",
        "Right panel only",
      ]),
    );
  });

  it("exposes the selected layout as a labeled toggle group", () => {
    render(
      <LayoutSwitcher activeLayout="conversation" onLayoutChange={vi.fn()} />,
    );

    expect(
      screen.getByRole("group", { name: "Conversation layout" }),
    ).toBeInTheDocument();
    expect(buttonByLabel("Conversation only")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(buttonByLabel("Split 50/50")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(buttonByLabel("Conversation only").type).toBe("button");
  });
});
