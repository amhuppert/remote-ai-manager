import type { QueryClient } from "@tanstack/react-query";
import { addSseListener, type SseEventTarget } from "@/lib/api/sse";
import { subscriptionsChangedEventSchema } from "./controls-schemas";
import { subscriptionKeys } from "./query-keys";
import {
  conversationCreatedEventSchema,
  conversationRenamedEventSchema,
  conversationArchivedEventSchema,
  conversationDeletedEventSchema,
} from "@/lib/conversations/schemas";
import { notepadChangedEventSchema } from "@/lib/notepads/schemas";
import { ticketChangedEventSchema } from "@/lib/tickets/schemas";
import { specChangedEventSchema } from "@/lib/api/sse-events";
export function registerSubscriptionSseReactions(
  es: SseEventTarget,
  deps: { queryClient: QueryClient },
): void {
  const refresh = () => {
    void deps.queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });
  };
  addSseListener(
    es,
    "subscriptions-changed",
    subscriptionsChangedEventSchema,
    refresh,
  );
  addSseListener(
    es,
    "conversation-created",
    conversationCreatedEventSchema,
    refresh,
  );
  addSseListener(
    es,
    "conversation-renamed",
    conversationRenamedEventSchema,
    refresh,
  );
  addSseListener(
    es,
    "conversation-archived",
    conversationArchivedEventSchema,
    refresh,
  );
  addSseListener(
    es,
    "conversation-deleted",
    conversationDeletedEventSchema,
    refresh,
  );
  addSseListener(es, "notepad-changed", notepadChangedEventSchema, refresh);
  addSseListener(es, "ticket-changed", ticketChangedEventSchema, refresh);
  addSseListener(es, "spec-changed", specChangedEventSchema, refresh);
  es.addEventListener("open", refresh);
}
