"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useOverlayScope } from "@/hooks/useOverlayScope";

interface ContextMenuActionItem {
  kind: "item";
  label: string;
  onSelect: () => void;
  hotkey?: string;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuDivider {
  kind: "divider";
}

export type ContextMenuItem = ContextMenuActionItem | ContextMenuDivider;

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const VIEWPORT_PADDING = 8;

export default function ConversationSidebarRowContextMenu({
  x,
  y,
  items,
  onClose,
}: Props): React.JSX.Element | null {
  const [pos, setPos] = useState<{ x: number; y: number }>({ x, y });

  const measureAndPosition = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const rect = node.getBoundingClientRect();
      let nextX = x;
      let nextY = y;
      if (x + rect.width > window.innerWidth - VIEWPORT_PADDING) {
        nextX = Math.max(
          VIEWPORT_PADDING,
          window.innerWidth - rect.width - VIEWPORT_PADDING,
        );
      }
      if (y + rect.height > window.innerHeight - VIEWPORT_PADDING) {
        nextY = Math.max(
          VIEWPORT_PADDING,
          window.innerHeight - rect.height - VIEWPORT_PADDING,
        );
      }
      setPos((prev) =>
        prev.x === nextX && prev.y === nextY ? prev : { x: nextX, y: nextY },
      );
    },
    [x, y],
  );

  useEffect(() => {
    const onDown = (event: MouseEvent | TouchEvent): void => {
      const target = event.target as Element | null;
      if (target && target.closest(".ctx-menu")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("touchstart", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("touchstart", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useOverlayScope(true);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={measureAndPosition}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.kind === "divider") {
          return (
            <div
              key={`div-${index}`}
              className="ctx-menu__div"
              aria-hidden="true"
            />
          );
        }
        const className = ["ctx-menu__item", item.danger ? "danger" : null]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={`item-${index}-${item.label}`}
            type="button"
            role="menuitem"
            className={className}
            disabled={item.disabled === true}
            onClick={() => {
              if (item.disabled === true) return;
              item.onSelect();
              onClose();
            }}
          >
            <span className="ctx-menu__label">{item.label}</span>
            {item.hotkey !== undefined && (
              <span className="ctx-menu__kbd">{item.hotkey}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
