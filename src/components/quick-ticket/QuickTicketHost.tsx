"use client";

import { useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { useAppHotkey } from "@/hooks/useAppHotkey";
import { initializeClientErrorCapture } from "@/lib/client-errors/ring-buffer";
import { isQuickTicketAvailable } from "@/lib/tickets/quick-ticket-context";
import {
  isQuickTicketDraftDirty,
  useQuickTicketStore,
} from "@/stores/quick-ticket.store";
import QuickTicketDialog from "./QuickTicketDialog";

export default function QuickTicketHost(): React.JSX.Element {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const open = useQuickTicketStore((state) => state.open);

  useEffect(() => {
    initializeClientErrorCapture(queryClient);
  }, [queryClient]);

  const toggle = useCallback(() => {
    const store = useQuickTicketStore.getState();
    if (store.open) {
      store.closeQuickTicket({ stashDraft: isQuickTicketDraftDirty(store) });
      return;
    }
    store.openQuickTicket({
      pathname,
      searchParams: new URLSearchParams(window.location.search),
    });
  }, [pathname]);

  useAppHotkey("quickTicket", toggle, {
    enabled: !open && isQuickTicketAvailable(pathname),
  });

  return <QuickTicketDialog />;
}
