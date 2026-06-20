"use client";

import { useEffect, useRef, useState } from "react";
import { KebabIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";

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

// The 44px touch target on mobile is reattached from the row's legacy
// `.v3-row .kebab-trigger` descendant rule onto the trigger itself (KebabMenu
// only renders inside a session row).
const triggerBox =
  "inline-flex items-center justify-center size-[28px] max-768:size-[44px] border border-solid rounded-sm transition-all duration-[120ms] ease-[ease]";
const triggerRest =
  "bg-transparent border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-primary hover:border-border-subtle";
const triggerOpen = "bg-bg-hover border-border-subtle text-text-primary";

const itemBox =
  "flex items-center gap-[8px] w-full py-[7px] px-[10px] bg-transparent border-0 rounded-sm font-mono text-[0.74rem] font-medium text-left transition-[background,color] duration-[100ms] ease-[ease] [&_svg]:shrink-0 [&_svg]:text-text-tertiary hover:[&_svg]:text-current";

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
    <span className="relative inline-flex" ref={ref}>
      <button
        type="button"
        className={cn(triggerBox, open ? triggerOpen : triggerRest)}
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
          className={cn(
            "absolute top-[calc(100%+4px)] z-menu min-w-[180px] animate-[kebab-in_0.12s_ease] rounded-md border border-solid border-border-default bg-bg-elevated p-[4px] shadow-[0_8px_24px_var(--cc-black-a45)]",
            alignRight ? "right-0" : "right-auto left-0",
          )}
          role="menu"
        >
          {items.map((it, i) => {
            if (it === "divider") {
              return (
                <div
                  className="mx-[2px] my-[4px] h-px bg-border-subtle"
                  key={"d" + i}
                />
              );
            }
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={cn(
                  itemBox,
                  it.danger
                    ? "text-red hover:bg-[var(--cc-red-a10)]"
                    : "text-text-primary hover:bg-bg-hover",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onClick?.();
                }}
              >
                {it.icon && it.icon}
                <span>{it.label}</span>
                {it.shortcut && (
                  <span className="ml-auto text-[0.7rem] text-text-tertiary">
                    {it.shortcut}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
