"use client";

import { LayoutIcon, TrashIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";

/** What the author right-clicked, and where the pointer was when they did. */
export type CanvasContextMenuTarget = { x: number; y: number } & (
  | { kind: "node"; id: string; title: string }
  | { kind: "edge"; id: string }
);

interface CanvasContextMenuProps {
  target: CanvasContextMenuTarget | null;
  onClose: () => void;
  onDeleteContext: (contextId: string) => void;
  onDeleteDependency: (edgeId: string) => void;
  /** Re-placement without a drag — the keyboard and screen-reader route. */
  onMoveContext: (contextId: string) => void;
}

/**
 * The canvas's right-click menu (README §5: node and edge deletion is the Delete
 * key OR the node's context menu).
 *
 * React Flow reports the right-click as an event on a node or an edge, not as a
 * DOM subtree a menu could wrap, so the menu is anchored to a zero-size element
 * parked at the pointer rather than to a trigger the author interacts with. That
 * anchor is `aria-hidden` and out of the tab order: it is a coordinate, not a
 * control. The menu itself is the shared primitive, so roving focus, type-ahead,
 * Escape and outside-click dismissal are Radix's.
 */
export default function CanvasContextMenu({
  target,
  onClose,
  onDeleteContext,
  onDeleteDependency,
  onMoveContext,
}: CanvasContextMenuProps): React.JSX.Element {
  return (
    <DropdownMenu
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none fixed size-0"
          style={{ left: target?.x ?? 0, top: target?.y ?? 0 }}
        />
      </DropdownMenuTrigger>
      {target !== null && (
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={0}
          layoutClassName="min-w-[180px]"
        >
          {target.kind === "node" ? (
            <>
              <DropdownMenuItem onSelect={() => onMoveContext(target.id)}>
                <LayoutIcon size={12} />
                Move to lane…
              </DropdownMenuItem>
              <DropdownMenuItem
                danger
                onSelect={() => onDeleteContext(target.id)}
              >
                <TrashIcon size={12} />
                {`Delete “${target.title}”`}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              danger
              onSelect={() => onDeleteDependency(target.id)}
            >
              <TrashIcon size={12} />
              Delete dependency
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
