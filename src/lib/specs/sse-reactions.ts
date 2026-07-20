import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import {
  specApprovalChangedEventSchema,
  specAttentionChangedEventSchema,
  specChangedEventSchema,
  specEvidenceChangedEventSchema,
  specExecutionChangedEventSchema,
  specRevisionChangedEventSchema,
} from "@/lib/api/sse-events";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { graphWorkflowTaskStatusEventSchema } from "@/lib/workflow-graph/event-schemas";
import { specKeys } from "./query-keys";
import { applySpecSseEvent } from "./sse-reducer";

export interface SpecSseReactionDeps {
  queryClient: QueryClient;
}

function reactToSpecEvent(
  queryClient: QueryClient,
  event: Parameters<typeof applySpecSseEvent>[1],
): void {
  applySpecSseEvent(queryClient, event);
  // Spec events carry durable project paths and current slugs, while query
  // keys use project names and may retain an alias slug. The shared prefix
  // is the narrowest invalidation that cannot strand an alias-backed chip.
  void queryClient.invalidateQueries({ queryKey: specKeys.all });
}

export function registerSpecSseReactions(
  es: EventSource,
  deps: SpecSseReactionDeps,
): void {
  addSseListener(es, "spec-changed", specChangedEventSchema, (event) => {
    reactToSpecEvent(deps.queryClient, event);
  });
  addSseListener(
    es,
    "spec-revision-changed",
    specRevisionChangedEventSchema,
    (event) => {
      reactToSpecEvent(deps.queryClient, event);
    },
  );
  addSseListener(
    es,
    "spec-approval-changed",
    specApprovalChangedEventSchema,
    (event) => {
      reactToSpecEvent(deps.queryClient, event);
    },
  );
  addSseListener(
    es,
    "spec-execution-changed",
    specExecutionChangedEventSchema,
    (event) => {
      reactToSpecEvent(deps.queryClient, event);
      // Active executions ride the active-conversations feed into the
      // sidebar's Active Work rail; execution lifecycle changes must refresh
      // that feed too, not only the Studio spec queries.
      void deps.queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  );
  addSseListener(
    es,
    "spec-evidence-changed",
    specEvidenceChangedEventSchema,
    (event) => {
      reactToSpecEvent(deps.queryClient, event);
    },
  );
  addSseListener(
    es,
    "spec-attention-changed",
    specAttentionChangedEventSchema,
    (event) => {
      reactToSpecEvent(deps.queryClient, event);
    },
  );
  addSseListener(
    es,
    "graph-workflow-task-status",
    graphWorkflowTaskStatusEventSchema,
    () => {
      void deps.queryClient.invalidateQueries({
        queryKey: specKeys.ticketReadThroughs(),
      });
    },
  );
}
