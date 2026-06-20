"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";

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
      className="ctx-menu fixed z-[1000] max-w-[320px] min-w-[240px] rounded-md border border-solid border-border-subtle bg-bg-elevated p-xs font-mono text-[12px] text-text-secondary shadow-[0_4px_16px_var(--cc-black-a45),0_0_0_1px_var(--cc-white-a02)_inset] select-none"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.kind === "divider") {
          return (
            <div
              key={`div-${index}`}
              className="my-xs h-px bg-border-subtle"
              role="separator"
            />
          );
        }
        return (
          <button
            key={`item-${index}-${item.label}`}
            type="button"
            role="menuitem"
            className={cn(
              "flex min-h-[32px] w-full cursor-pointer items-center justify-between gap-sm rounded-[calc(var(--radius-md)-2px)] border-0 bg-transparent px-sm py-xs text-left [font:inherit] enabled:focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 max-768:min-h-[44px] max-768:text-[13px]",
              item.danger
                ? "text-red-text enabled:hover:bg-red-glow enabled:hover:text-red enabled:focus-visible:bg-red-glow enabled:focus-visible:text-red"
                : "text-inherit enabled:hover:bg-bg-hover enabled:hover:text-text-primary enabled:focus-visible:bg-bg-hover enabled:focus-visible:text-text-primary",
            )}
            disabled={item.disabled === true}
            onClick={() => {
              if (item.disabled === true) return;
              item.onSelect();
              onClose();
            }}
          >
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {item.label}
            </span>
            {item.hotkey !== undefined && (
              <span className="shrink-0 rounded-[3px] border border-solid border-border-subtle bg-bg-surface px-[6px] py-px text-[10px] tracking-[0.04em] text-text-tertiary uppercase">
                {item.hotkey}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
