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
  it("renders five layout mode buttons (Req 3.1)", () => {
    render(<LayoutSwitcher activeLayout="default" onLayoutChange={vi.fn()} />);
    expect(screen.getAllByRole("button").length).toBe(5);
  });

  it("orders panes after split and before diff (Req 3.1)", () => {
    render(<LayoutSwitcher activeLayout="default" onLayoutChange={vi.fn()} />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Conversation + Diff sidebar",
      "Split 50/50",
      "Panes (split-screen)",
      "Conversation only",
      "Diff only",
    ]);
  });

  it("activates panes layout on click (Req 3.1)", () => {
    const onLayoutChange = vi.fn();
    render(
      <LayoutSwitcher activeLayout="default" onLayoutChange={onLayoutChange} />,
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
      <LayoutSwitcher activeLayout="default" onLayoutChange={onLayoutChange} />,
    );
    fireEvent.click(buttonByLabel("Conversation only"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("conversation");

    fireEvent.click(buttonByLabel("Split 50/50"));
    expect(onLayoutChange).toHaveBeenLastCalledWith("split");

    fireEvent.click(buttonByLabel("Diff only"));
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
    expect(
      buttonByLabel("Conversation + Diff sidebar").getAttribute("data-active"),
    ).toBe("false");
    expect(buttonByLabel("Diff only").getAttribute("data-active")).toBe(
      "false",
    );
  });

  it("exposes an accessible name for each mode", () => {
    render(<LayoutSwitcher activeLayout="default" onLayoutChange={vi.fn()} />);
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(
      expect.arrayContaining([
        "Conversation only",
        "Conversation + Diff sidebar",
        "Split 50/50",
        "Diff only",
      ]),
    );
  });
});
