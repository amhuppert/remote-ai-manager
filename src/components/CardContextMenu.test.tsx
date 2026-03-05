// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CardContextMenu from "./CardContextMenu";

describe("CardContextMenu", () => {
  const baseItems = [
    { label: "Archive Project", onAction: vi.fn() },
    { label: "Delete Project", danger: true, onAction: vi.fn() },
  ];

  it("renders trigger button", () => {
    render(
      <CardContextMenu items={baseItems} open={false} onToggle={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: "Project actions" }),
    ).toBeInTheDocument();
  });

  it("opens menu on trigger click", () => {
    const onToggle = vi.fn();
    render(
      <CardContextMenu items={baseItems} open={false} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows dropdown with items when open", () => {
    render(
      <CardContextMenu items={baseItems} open={true} onToggle={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: "Archive Project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete Project" }),
    ).toBeInTheDocument();
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
    render(<CardContextMenu items={items} open={true} onToggle={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test Action" }));
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it("stops propagation on trigger click", () => {
    const onToggle = vi.fn();
    render(
      <div
        onClick={() => {
          throw new Error("Should not propagate");
        }}
      >
        <CardContextMenu items={baseItems} open={false} onToggle={onToggle} />
      </div>,
    );
    // Should not throw — propagation is stopped
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(onToggle).toHaveBeenCalled();
  });

  it("stops propagation on item click", () => {
    const actionFn = vi.fn();
    const items = [{ label: "Action", onAction: actionFn }];
    render(
      <div
        onClick={() => {
          throw new Error("Should not propagate");
        }}
      >
        <CardContextMenu items={items} open={true} onToggle={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Action" }));
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
