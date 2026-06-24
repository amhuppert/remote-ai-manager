"use client";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/DropdownMenu";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onAction: () => void;
}

interface CardContextMenuProps {
  items: ContextMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// 24px trigger (`.card-menu-btn`, smaller than the 30px IconButton `square`
// recipe) preserved as local utilities; the open state is read off Radix's
// `data-state`. Open and hover share one appearance (legacy `.open` == `:hover`).
const triggerClass =
  "flex items-center justify-center w-[24px] h-[24px] p-0 border border-solid border-transparent rounded-sm " +
  "bg-transparent text-text-tertiary font-mono text-[1rem] leading-none cursor-pointer transition-all duration-150 ease-[ease] " +
  "hover:bg-bg-hover hover:border-border-default hover:text-text-secondary " +
  "data-[state=open]:bg-bg-hover data-[state=open]:border-border-default data-[state=open]:text-text-secondary";

export default function CardContextMenu({
  items,
  open,
  onOpenChange,
}: CardContextMenuProps): React.JSX.Element {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={triggerClass}
          aria-label="Project actions"
          // The card is click-through (navigates); opening the menu must not
          // trigger it (legacy trigger stopped propagation + default too).
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          &#8942;
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            danger={item.danger}
            onSelect={item.onAction}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
