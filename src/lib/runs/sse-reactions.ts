/**
 * Run SSE reactions, registered on the shared `/api/events` EventSource by
 * `NotificationListener`. A run's page and its session's list are read again
 * when the run changes, and when a conversation they show changes what they
 * show of it: a seat's turn starting or ending and what it spent, and a seat's
 * or owner's name or removal. Requests are merged through the run cache.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import {
  conversationDeletedEventSchema,
  conversationRenamedEventSchema,
  conversationStatusEventSchema,
  conversationUsageUpdatedEventSchema,
} from "@/lib/conversations/schemas";
import { refreshRun, refreshRunReads } from "./cache";
import { runChangedEventSchema } from "./event-schemas";
import { runKeys } from "./query-keys";
import type { RunPage, RunSummary } from "./schemas";

/** Whether a conversation held one of the page's seats, in any pass. */
function seatedIn(page: RunPage, conversationId: string): boolean {
  return page.contexts.some((context) =>
    [context, ...context.previousInvocations].some((invocation) =>
      invocation.agents.some(
        (agent) => agent.conversationId === conversationId,
      ),
    ),
  );
}

function pagesWhere(
  queryClient: QueryClient,
  session: { projectName: string; sessionName: string },
  names: (page: RunPage) => boolean,
): QueryKey[] {
  return queryClient
    .getQueriesData<RunPage>({
      queryKey: runKeys.pages(session.projectName, session.sessionName),
    })
    .flatMap(([queryKey, page]) =>
      page !== undefined && names(page) ? [queryKey] : [],
    );
}

function listedOwner(
  queryClient: QueryClient,
  session: { projectName: string; sessionName: string },
  conversationId: string,
): boolean {
  const list = queryClient.getQueryData<RunSummary[]>(
    runKeys.list(session.projectName, session.sessionName),
  );
  return (
    list?.some((run) => run.owner.conversationId === conversationId) ?? false
  );
}

export function registerRunSseReactions(
  es: EventSource,
  deps: { queryClient: QueryClient },
): void {
  const { queryClient } = deps;
  addSseListener(es, "run-changed", runChangedEventSchema, (event) => {
    void refreshRun(queryClient, event);
  });
  // A seat's running state is on the page; its owner's is not.
  addSseListener(
    es,
    "conversation-status",
    conversationStatusEventSchema,
    (event) => {
      if (event.scope !== "session") return;
      void refreshRunReads(queryClient, {
        pages: pagesWhere(queryClient, event, (page) =>
          seatedIn(page, event.conversationId),
        ),
        list: null,
      });
    },
  );
  // What a seat spent is in its page's costs and its run's total in the list.
  addSseListener(
    es,
    "conversation-usage-updated",
    conversationUsageUpdatedEventSchema,
    (event) => {
      if (event.scope !== "session") return;
      void refreshRunReads(queryClient, {
        pages: pagesWhere(queryClient, event, (page) =>
          seatedIn(page, event.conversationId),
        ),
        list: runKeys.list(event.projectName, event.sessionName),
      });
    },
  );
  // An owner's name is on its runs' pages and list rows.
  addSseListener(
    es,
    "conversation-renamed",
    conversationRenamedEventSchema,
    (event) => {
      if (event.scope !== "session") return;
      const named = (page: RunPage) =>
        page.owner.conversationId === event.conversationId;
      void refreshRunReads(queryClient, {
        pages: pagesWhere(queryClient, event, named),
        list: listedOwner(queryClient, event, event.conversationId)
          ? runKeys.list(event.projectName, event.sessionName)
          : null,
      });
    },
  );
  // A removed owner or seat leaves the page without its name, or its cost unknown.
  addSseListener(
    es,
    "conversation-deleted",
    conversationDeletedEventSchema,
    (event) => {
      const pages = pagesWhere(
        queryClient,
        event,
        (page) =>
          page.owner.conversationId === event.conversationId ||
          seatedIn(page, event.conversationId),
      );
      void refreshRunReads(queryClient, {
        pages,
        list: runKeys.list(event.projectName, event.sessionName),
      });
    },
  );
}
