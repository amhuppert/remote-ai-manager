"use client";

import { useEffect, useRef } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";

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
    <div className="card-menu-wrap" ref={wrapRef}>
      <button
        className={`card-menu-btn${open ? " open" : ""}`}
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
      <div className={`card-dropdown${open ? " open" : ""}`}>
        {items.map((item) => (
          <button
            key={item.label}
            className={`card-dropdown-item${item.danger ? " danger" : ""}`}
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
