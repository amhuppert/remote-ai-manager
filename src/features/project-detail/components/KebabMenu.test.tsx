// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import KebabMenu, { type KebabItem } from "./KebabMenu";

describe("KebabMenu", () => {
  it("opens on trigger click and renders items", () => {
    const items: KebabItem[] = [
      { label: "First", onClick: () => {} },
      "divider",
      { label: "Second", onClick: () => {} },
    ];
    render(<KebabMenu items={items} />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "First" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Second" }),
    ).toBeInTheDocument();
  });

  it("invokes the item's onClick and closes the menu", () => {
    const handler = vi.fn();
    render(<KebabMenu items={[{ label: "Run", onClick: handler }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Run" }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes when a mousedown happens outside the host", () => {
    render(
      <div>
        <KebabMenu items={[{ label: "X" }]} />
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders divider elements between items", () => {
    render(<KebabMenu items={[{ label: "A" }, "divider", { label: "B" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu");
    // The menu has two menuitems plus one divider div => 3 direct children.
    expect(menu.children.length).toBe(3);
  });
});
