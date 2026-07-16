// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isOverlayOpen } from "@/stores/overlay-scope.store";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ContextMenu";

// Radix DOM-method polyfills are global (vitest.jsdom.setup.ts).
afterEach(cleanup);

function renderMenu(itemProps: { onSelect?: () => void } = {}) {
  return render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-testid="area">Right-click me</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={itemProps.onSelect}>
          Rename
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
}

describe("ContextMenu", () => {
  it("opens on right-click and registers with the global overlay scope", () => {
    renderMenu();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(isOverlayOpen()).toBe(false);

    fireEvent.contextMenu(screen.getByTestId("area"));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(isOverlayOpen()).toBe(true);
  });

  it("renders items with the shared menu recipe; danger maps to red", () => {
    renderMenu();
    fireEvent.contextMenu(screen.getByTestId("area"));

    const rename = screen.getByRole("menuitem", { name: /Rename/ });
    expect(rename.className).toContain("font-mono");
    expect(rename.className).toContain(
      "data-[highlighted]:bg-[var(--cc-cyan-a08)]",
    );
    expect(rename.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );

    expect(screen.getByRole("separator")).toBeInTheDocument();
    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(del.className).toContain("text-red");
  });

  it("renders the menu on the canonical elevated surface", () => {
    renderMenu();
    fireEvent.contextMenu(screen.getByTestId("area"));

    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("bg-bg-elevated");
    expect(menu.className).toContain("shadow-menu");
    expect(menu.className).toContain("z-menu");
  });

  it("fires onSelect and closes when an item is chosen", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderMenu({ onSelect });

    fireEvent.contextMenu(screen.getByTestId("area"));
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
