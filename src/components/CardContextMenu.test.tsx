// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CardContextMenu from "./CardContextMenu";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const baseItems = [
  { label: "Archive Project", onAction: vi.fn() },
  { label: "Delete Project", danger: true, onAction: vi.fn() },
];

describe("CardContextMenu", () => {
  it("renders the trigger button", () => {
    render(
      <CardContextMenu items={baseItems} open={false} onOpenChange={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: "Project actions" }),
    ).toBeInTheDocument();
  });

  it("requests open when the trigger is activated", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CardContextMenu
        items={baseItems}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("renders items as menuitems when open; danger maps to red", () => {
    render(<CardContextMenu items={baseItems} open onOpenChange={vi.fn()} />);
    expect(
      screen.getByRole("menuitem", { name: "Archive Project" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete Project" }).className,
    ).toContain("text-red");
  });

  it("calls onAction when an item is selected", async () => {
    const user = userEvent.setup();
    const actionFn = vi.fn();
    render(
      <CardContextMenu
        items={[{ label: "Test Action", onAction: actionFn }]}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "Test Action" }));
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it("does not propagate the trigger click to the click-through card", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const ancestorClick = vi.fn();
    render(
      <div onClick={ancestorClick}>
        <CardContextMenu
          items={baseItems}
          open={false}
          onOpenChange={onOpenChange}
        />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Project actions" }));
    expect(onOpenChange).toHaveBeenCalled();
    expect(ancestorClick).not.toHaveBeenCalled();
  });
});
