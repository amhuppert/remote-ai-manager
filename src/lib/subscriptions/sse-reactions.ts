import type { QueryClient } from "@tanstack/react-query";
import { addSseListener, type SseEventTarget } from "@/lib/api/sse";
import {
  subscriptionScopeSchema,
  type SubscriptionScope,
  subscriptionsChangedEventSchema,
} from "./controls-schemas";
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
  function invalidateScope(changed: SubscriptionScope, recipientId?: string) {
    void deps.queryClient.invalidateQueries({
      queryKey: subscriptionKeys.all,
      predicate(query) {
        if (query.queryKey[1] === "preferences")
          return recipientId !== undefined && query.queryKey[2] === recipientId;
        const parsed = subscriptionScopeSchema
          .passthrough()
          .safeParse(query.queryKey[2]);
        if (!parsed.success) return false;
        const scope = parsed.data;
        if (query.queryKey[1] === "recipients" && changed.sourceKind)
          return false;
        return (
          (scope.project === undefined ||
            changed.project === undefined ||
            scope.project === changed.project) &&
          (scope.session === undefined ||
            changed.session === undefined ||
            scope.session === changed.session) &&
          (scope.conversation === undefined ||
            changed.conversation === undefined ||
            scope.conversation === changed.conversation) &&
          (scope.sourceKind === undefined ||
            changed.sourceKind === undefined ||
            scope.sourceKind === changed.sourceKind) &&
          (scope.sourceId === undefined ||
            changed.sourceId === undefined ||
            scope.sourceId === changed.sourceId)
        );
      },
    });
  }
  const projectName = (path: string) =>
    path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  addSseListener(
    es,
    "subscriptions-changed",
    subscriptionsChangedEventSchema,
    (event) =>
      invalidateScope(
        {
          project: projectName(event.projectPath),
          conversation: event.conversationId,
          ...(event.source
            ? { sourceKind: event.source.kind, sourceId: event.source.id }
            : {}),
        },
        event.conversationId,
      ),
  );
  addSseListener(
    es,
    "conversation-created",
    conversationCreatedEventSchema,
    (event) =>
      invalidateScope({
        project: event.projectName,
        ...(event.scope === "session" ? { session: event.sessionName } : {}),
        conversation: event.conversation.id,
      }),
  );
  addSseListener(
    es,
    "conversation-renamed",
    conversationRenamedEventSchema,
    (event) =>
      invalidateScope({
        project: event.projectName,
        ...(event.scope === "session" ? { session: event.sessionName } : {}),
        conversation: event.conversationId,
      }),
  );
  addSseListener(
    es,
    "conversation-archived",
    conversationArchivedEventSchema,
    (event) =>
      invalidateScope({
        project: event.projectName,
        ...(event.scope === "session" ? { session: event.sessionName } : {}),
        conversation: event.conversationId,
      }),
  );
  addSseListener(
    es,
    "conversation-deleted",
    conversationDeletedEventSchema,
    (event) =>
      invalidateScope({
        project: event.projectName,
        session: event.sessionName,
        conversation: event.conversationId,
      }),
  );
  addSseListener(es, "notepad-changed", notepadChangedEventSchema, (event) =>
    invalidateScope({
      project: event.projectPath ? projectName(event.projectPath) : undefined,
      sourceKind: "notepad",
      sourceId: event.notepadId,
    }),
  );
  addSseListener(es, "ticket-changed", ticketChangedEventSchema, (event) =>
    invalidateScope({
      project: event.projectName,
      sourceKind: "ticket",
      sourceId: event.listItem?.id,
    }),
  );
  addSseListener(es, "spec-changed", specChangedEventSchema, (event) =>
    invalidateScope({
      project: projectName(event.projectPath),
      sourceKind: "spec",
      sourceId: event.specId,
    }),
  );
  let disconnected = false;
  es.addEventListener("error", () => {
    disconnected = true;
  });
  es.addEventListener("open", () => {
    if (!disconnected) return;
    disconnected = false;
    refresh();
  });
}
