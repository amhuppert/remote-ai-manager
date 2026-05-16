// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import ConversationSidebarRowContextMenu, {
  type ContextMenuItem,
} from "./ConversationSidebarRowContextMenu";

afterEach(() => {
  cleanup();
});

function buildItems(
  overrides: Partial<ContextMenuItem>[] = [],
): ContextMenuItem[] {
  const base: ContextMenuItem[] = [
    {
      kind: "item",
      label: "Open conversation",
      onSelect: vi.fn(),
      hotkey: "Enter",
    },
    { kind: "divider" },
    { kind: "item", label: "Rename…", onSelect: vi.fn() },
    { kind: "item", label: "Archive", onSelect: vi.fn() },
  ];
  return overrides.length === 0
    ? base
    : base.map((item, i) =>
        overrides[i] !== undefined
          ? ({ ...item, ...overrides[i] } as ContextMenuItem)
          : item,
      );
}

describe("ConversationSidebarRowContextMenu", () => {
  it("renders items and dividers", () => {
    const onClose = vi.fn();
    const { getByText } = render(
      <ConversationSidebarRowContextMenu
        x={100}
        y={100}
        items={buildItems()}
        onClose={onClose}
      />,
    );
    expect(getByText("Open conversation")).toBeDefined();
    expect(getByText("Rename…")).toBeDefined();
    expect(document.querySelectorAll(".ctx-menu__div").length).toBe(1);
  });

  it("renders hotkey hint when provided", () => {
    const { getByText } = render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={buildItems()}
        onClose={vi.fn()}
      />,
    );
    expect(getByText("Enter")).toBeDefined();
  });

  it("fires onSelect then onClose when an item is clicked", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [
      { kind: "item", label: "Rename…", onSelect },
    ];
    const { getByText } = render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={items}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByText("Rename…"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fire onSelect when item is disabled", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [
      { kind: "item", label: "Pin as tab", onSelect, disabled: true },
    ];
    const { getByText } = render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={items}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByText("Pin as tab"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("applies the danger class to danger items", () => {
    const items: ContextMenuItem[] = [
      { kind: "item", label: "Delete…", onSelect: vi.fn(), danger: true },
    ];
    const { getByText } = render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={items}
        onClose={vi.fn()}
      />,
    );
    expect(getByText("Delete…").closest("button")?.className).toMatch(/danger/);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={buildItems()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on outside mousedown", () => {
    const onClose = vi.fn();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={buildItems()}
        onClose={onClose}
      />,
    );
    fireEvent.mouseDown(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it("does not close when clicking inside the menu", () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={buildItems()}
        onClose={onClose}
      />,
    );
    const menu = container.ownerDocument.querySelector(".ctx-menu");
    expect(menu).not.toBeNull();
    fireEvent.mouseDown(menu!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("prevents native context menu on the portal", () => {
    render(
      <ConversationSidebarRowContextMenu
        x={0}
        y={0}
        items={buildItems()}
        onClose={vi.fn()}
      />,
    );
    const menu = document.querySelector(".ctx-menu");
    expect(menu).not.toBeNull();
    const evt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    const prevented = !menu!.dispatchEvent(evt);
    expect(prevented).toBe(true);
  });
});
