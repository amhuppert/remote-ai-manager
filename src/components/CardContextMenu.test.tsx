// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import CardContextMenu from "./CardContextMenu";

describe("CardContextMenu", () => {
  const baseItems = [
    { label: "Archive Project", onAction: vi.fn() },
    { label: "Delete Project", danger: true, onAction: vi.fn() },
  ];

  it("renders trigger button", () => {
    const { container } = render(
      <CardContextMenu items={baseItems} open={false} onToggle={vi.fn()} />,
    );
    const btn = container.querySelector(".card-menu-btn");
    expect(btn).toBeDefined();
    expect(btn).not.toBeNull();
  });

  it("opens menu on trigger click", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CardContextMenu items={baseItems} open={false} onToggle={onToggle} />,
    );
    const btn = container.querySelector(".card-menu-btn")!;
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows dropdown with items when open", () => {
    const { container } = render(
      <CardContextMenu items={baseItems} open={true} onToggle={vi.fn()} />,
    );
    const dropdown = container.querySelector(".card-dropdown.open");
    expect(dropdown).not.toBeNull();
    const items = container.querySelectorAll(".card-dropdown-item");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toBe("Archive Project");
    expect(items[1]!.textContent).toBe("Delete Project");
  });

  it("applies danger class to danger items", () => {
    const { container } = render(
      <CardContextMenu items={baseItems} open={true} onToggle={vi.fn()} />,
    );
    const items = container.querySelectorAll(".card-dropdown-item");
    expect(items[1]!.className).toContain("danger");
  });

  it("calls onAction when item clicked", () => {
    const actionFn = vi.fn();
    const items = [{ label: "Test Action", onAction: actionFn }];
    const { container } = render(
      <CardContextMenu items={items} open={true} onToggle={vi.fn()} />,
    );
    const item = container.querySelector(".card-dropdown-item")!;
    fireEvent.click(item);
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it("stops propagation on trigger click", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <div
        onClick={() => {
          throw new Error("Should not propagate");
        }}
      >
        <CardContextMenu items={baseItems} open={false} onToggle={onToggle} />
      </div>,
    );
    const btn = container.querySelector(".card-menu-btn")!;
    // Should not throw — propagation is stopped
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it("stops propagation on item click", () => {
    const actionFn = vi.fn();
    const items = [{ label: "Action", onAction: actionFn }];
    const { container } = render(
      <div
        onClick={() => {
          throw new Error("Should not propagate");
        }}
      >
        <CardContextMenu items={items} open={true} onToggle={vi.fn()} />
      </div>,
    );
    const item = container.querySelector(".card-dropdown-item")!;
    fireEvent.click(item);
    expect(actionFn).toHaveBeenCalled();
  });

  it("closes on Escape key", () => {
    const onToggle = vi.fn();
    render(
      <CardContextMenu items={baseItems} open={true} onToggle={onToggle} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("closes on click outside", () => {
    const onToggle = vi.fn();
    render(
      <CardContextMenu items={baseItems} open={true} onToggle={onToggle} />,
    );
    fireEvent.mouseDown(document);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
