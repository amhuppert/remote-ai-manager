"use client";

import { useEffect, useRef, useState } from "react";
import { KebabIcon } from "@/components/icons";

export type KebabItem =
  | {
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      danger?: boolean;
      onClick?: () => void;
    }
  | "divider";

interface KebabMenuProps {
  items: KebabItem[];
  alignRight?: boolean;
  ariaLabel?: string;
}

export default function KebabMenu({
  items,
  alignRight = true,
  ariaLabel = "More actions",
}: KebabMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  return (
    <span className="kebab-host" ref={ref}>
      <button
        type="button"
        className={"kebab-trigger" + (open ? " open" : "")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <KebabIcon size={16} />
      </button>
      {open && (
        <div
          className="kebab-menu"
          role="menu"
          style={alignRight ? undefined : { left: 0, right: "auto" }}
        >
          {items.map((it, i) => {
            if (it === "divider") {
              return <div className="kebab-divider" key={"d" + i} />;
            }
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={"kebab-item" + (it.danger ? " danger" : "")}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onClick?.();
                }}
              >
                {it.icon && it.icon}
                <span>{it.label}</span>
                {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
