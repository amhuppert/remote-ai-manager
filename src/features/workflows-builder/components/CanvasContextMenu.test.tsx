// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CanvasContextMenu, {
  type CanvasContextMenuTarget,
} from "./CanvasContextMenu";

function renderMenu(
  target: CanvasContextMenuTarget | null,
  handlers: Partial<{
    onClose: () => void;
    onDeleteContext: (id: string) => void;
    onDeleteDependency: (id: string) => void;
    onMoveContext: (id: string) => void;
  }> = {},
) {
  const props = {
    target,
    onClose: handlers.onClose ?? vi.fn(),
    onDeleteContext: handlers.onDeleteContext ?? vi.fn(),
    onDeleteDependency: handlers.onDeleteDependency ?? vi.fn(),
    onMoveContext: handlers.onMoveContext ?? vi.fn(),
  };
  return { ...render(<CanvasContextMenu {...props} />), props };
}

describe("CanvasContextMenu", () => {
  it("stays closed with no target", () => {
    renderMenu(null);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("deletes the context a node menu names", () => {
    const onDeleteContext = vi.fn();
    renderMenu(
      {
        kind: "node",
        id: "context-plan",
        title: "Plan the work",
        x: 120,
        y: 80,
      },
      { onDeleteContext },
    );

    // The title, not the id: the author picked the node they can see.
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Delete “Plan the work”/ }),
    );

    expect(onDeleteContext).toHaveBeenCalledWith("context-plan");
  });

  it("deletes the dependency an edge menu names", () => {
    const onDeleteDependency = vi.fn();
    renderMenu(
      { kind: "edge", id: "edge-plan-implement", x: 40, y: 40 },
      { onDeleteDependency },
    );

    fireEvent.click(
      screen.getByRole("menuitem", { name: /Delete dependency/ }),
    );

    expect(onDeleteDependency).toHaveBeenCalledWith("edge-plan-implement");
  });

  // README §12 — the keyboard and screen-reader route to re-placement, which a
  // long-press and a canvas drag both lack.
  it("re-places the context a node menu names", () => {
    const onMoveContext = vi.fn();
    renderMenu(
      { kind: "node", id: "context-plan", title: "Plan the work", x: 0, y: 0 },
      { onMoveContext },
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Move to lane/ }));

    expect(onMoveContext).toHaveBeenCalledWith("context-plan");
  });

  it("offers only the action its target supports", () => {
    renderMenu({ kind: "edge", id: "edge-plan-implement", x: 0, y: 0 });
    expect(
      screen.queryByRole("menuitem", { name: /Delete “/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Move to lane/ }),
    ).not.toBeInTheDocument();
  });

  it("closes on Escape without deleting anything", () => {
    const onClose = vi.fn();
    const onDeleteContext = vi.fn();
    renderMenu(
      { kind: "node", id: "context-plan", title: "Plan the work", x: 0, y: 0 },
      { onClose, onDeleteContext },
    );

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(onDeleteContext).not.toHaveBeenCalled();
  });
});
