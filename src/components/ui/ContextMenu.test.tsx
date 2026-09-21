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

  it("exposes action names, shortcut text, and the group separator", () => {
    renderMenu();
    fireEvent.contextMenu(screen.getByTestId("area"));

    expect(
      screen.getByRole("menuitem", { name: /Rename/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
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
