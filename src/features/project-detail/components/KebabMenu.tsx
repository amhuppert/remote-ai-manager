"use client";

import { KebabIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/DropdownMenu";
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

// Config-driven adapter over the canonical DropdownMenu primitive (the menu
// behaviour — roving focus, type-ahead, Escape, outside-click, portal/positioning,
// ARIA — is Radix's). The 28px trigger is preserved from the legacy
// `.v3-row .kebab-trigger` descendant size (the IconButton `square` recipe is
// 30px); the open state is read off Radix's `data-state`.
const triggerBox =
  "inline-flex items-center justify-center size-[28px] max-768:size-[44px] border border-solid rounded-sm transition-all duration-[120ms] ease-[ease] cursor-pointer";
const triggerRest =
  "bg-transparent border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-primary hover:border-border-subtle";
const triggerOpen =
  "data-[state=open]:bg-bg-hover data-[state=open]:border-border-subtle data-[state=open]:text-text-primary";

export default function KebabMenu({
  items,
  alignRight = true,
  ariaLabel = "More actions",
}: KebabMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(triggerBox, triggerRest, triggerOpen)}
          aria-label={ariaLabel}
          // Keep the row (the click-through ancestor) from reacting when the menu
          // is toggled — the legacy trigger stopped propagation too.
          onClick={(e) => e.stopPropagation()}
        >
          <KebabIcon size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={alignRight ? "end" : "start"}>
        {items.map((it, i) =>
          it === "divider" ? (
            <DropdownMenuSeparator key={"d" + i} />
          ) : (
            <DropdownMenuItem
              touch
              key={i}
              danger={it.danger}
              onSelect={it.onClick}
            >
              {it.icon}
              <span>{it.label}</span>
              {it.shortcut && (
                <DropdownMenuShortcut>{it.shortcut}</DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
