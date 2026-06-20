"use client";

import { useEffect, useRef } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onAction: () => void;
}

interface CardContextMenuProps {
  items: ContextMenuItem[];
  open: boolean;
  onToggle: () => void;
}

export default function CardContextMenu({
  items,
  open,
  onToggle,
}: CardContextMenuProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent | TouchEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onToggle();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onToggle();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onToggle]);

  useOverlayScope(open);

  return (
    <div className={wrapClass} ref={wrapRef}>
      <button
        className={triggerClass}
        data-open={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onToggle();
        }}
        aria-label="Project actions"
        type="button"
      >
        &#8942;
      </button>
      <div className={dropdownClass} data-open={open}>
        {items.map((item) => (
          <button
            key={item.label}
            className={cn(itemBase, item.danger ? itemDanger : itemNormal)}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              item.onAction();
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const wrapClass = "relative shrink-0";

// `.card-menu-btn` is a 24px square (NOT the 30px IconButton `square` recipe), so
// it is kept as local utilities to preserve parity rather than swapped for the
// primitive. Open and hover share one appearance (legacy `.open` == `:hover`).
const triggerClass =
  "flex items-center justify-center w-[24px] h-[24px] p-0 border border-solid border-transparent rounded-sm " +
  "bg-transparent text-text-tertiary font-mono text-[1rem] leading-none cursor-pointer transition-all duration-150 ease-[ease] " +
  "hover:bg-bg-hover hover:border-border-default hover:text-text-secondary " +
  "data-[open=true]:bg-bg-hover data-[open=true]:border-border-default data-[open=true]:text-text-secondary";

// Two-layer black drop shadow, distinct from the single-layer --cc-shadow-dropdown.
const dropdownClass =
  "absolute top-[calc(100%+4px)] right-0 z-header min-w-[180px] p-[4px] bg-bg-raised border border-solid border-border-default rounded-md " +
  "[box-shadow:var(--cc-shadow-card-dropdown)] " +
  "opacity-0 [transform:translateY(-4px)_scale(0.97)] pointer-events-none [transition:opacity_0.12s_ease,transform_0.12s_ease] " +
  "data-[open=true]:opacity-100 data-[open=true]:[transform:translateY(0)_scale(1)] data-[open=true]:pointer-events-auto";

// Color + hover-bg are partitioned into mutually-exclusive normal/danger maps so
// no two utilities target one property (legacy `.danger` won on specificity; here
// only one variant's utilities are present).
const itemBase =
  "flex items-center w-full py-[8px] px-[12px] border-0 rounded-sm bg-transparent font-mono text-[0.75rem] font-medium text-left cursor-pointer transition-all duration-100 ease-[ease]";

const itemNormal = "text-text-primary hover:bg-bg-hover";
const itemDanger = "text-red hover:bg-red-glow";
