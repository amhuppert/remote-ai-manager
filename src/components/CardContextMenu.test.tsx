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
  it("maps a destructive item to its action and danger treatment", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <CardContextMenu
        items={[{ label: "Delete Project", danger: true, onAction }]}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const item = screen.getByRole("menuitem", { name: "Delete Project" });
    expect(item.className).toContain("text-red");
    await user.click(item);
    expect(onAction).toHaveBeenCalledOnce();
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
