"use client";

import { useCallback } from "react";

import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from "@/components/ui/DropdownMenu";
import { IconButton } from "@/components/ui/IconButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { HOTKEY_REGISTRY, formatHotkeyDisplay } from "@/lib/shared/hotkeys";
import { isQuickTicketAvailable } from "@/lib/tickets/quick-ticket-context";
import { useQuickTicketStore } from "@/stores/quick-ticket.store";

interface QuickTicketButtonProps {
  pathname: string | null;
  presentation?: "icon" | "menu-item";
}

// The size attributes matter in the menu-item presentation: menu items apply no
// CSS sizing to child SVGs (unlike IconButton), so an unsized SVG falls back to
// the replaced-element default of 300×150 and blows out the mobile menu.
function QuickTicketIcon({ size }: { size?: number }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <rect x="1.5" y="4" width="9.5" height="8" rx="1.4" />
      <path d="M3.7 6.8h5.1M3.7 9.2h2.9" />
      <path d="M13.2 5.6v4.8M10.8 8h4.8" />
    </svg>
  );
}

function currentSearchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export default function QuickTicketButton({
  pathname,
  presentation = "icon",
}: QuickTicketButtonProps): React.JSX.Element | null {
  const openQuickTicket = useQuickTicketStore((state) => state.openQuickTicket);
  const handleOpen = useCallback(() => {
    if (pathname === null) return;
    openQuickTicket({ pathname, searchParams: currentSearchParams() });
  }, [openQuickTicket, pathname]);

  if (!isQuickTicketAvailable(pathname)) return null;

  const shortcut = formatHotkeyDisplay(HOTKEY_REGISTRY.quickTicket.keys);
  if (presentation === "menu-item") {
    // This presentation exists for the mobile destinations menu, so the row
    // takes the touch minimum.
    return (
      <DropdownMenuItem onSelect={handleOpen} touch>
        <QuickTicketIcon size={14} />
        Quick ticket
        <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
      </DropdownMenuItem>
    );
  }

  const tooltip = `Quick ticket · ${shortcut}`;
  return (
    <WithTooltip label={tooltip} side="bottom">
      <IconButton
        type="button"
        aria-label="Quick ticket"
        layoutClassName="max-768:hidden"
        onClick={handleOpen}
      >
        <QuickTicketIcon />
      </IconButton>
    </WithTooltip>
  );
}
