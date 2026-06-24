// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KebabMenu, { type KebabItem } from "./KebabMenu";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

describe("KebabMenu", () => {
  it("opens on trigger click and renders items + divider", async () => {
    const user = userEvent.setup();
    const items: KebabItem[] = [
      { label: "First", onClick: () => {} },
      "divider",
      { label: "Second", onClick: () => {} },
    ];
    render(<KebabMenu items={items} />);

    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "First" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Second" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("invokes the item's onClick and closes the menu", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<KebabMenu items={[{ label: "Run", onClick: handler }]} />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Run" }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("maps the danger flag to the destructive item treatment", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={[{ label: "Delete", danger: true }]} />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Delete" }).className,
    ).toContain("text-red");
  });
});
