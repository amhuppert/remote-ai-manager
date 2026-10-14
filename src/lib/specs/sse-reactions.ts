import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import {
  specApprovalChangedEventSchema,
  specAttentionChangedEventSchema,
  specChangedEventSchema,
  specRevisionChangedEventSchema,
} from "@/lib/api/sse-events";
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
    "spec-attention-changed",
    specAttentionChangedEventSchema,
    (event) => {
      reactToSpecEvent(deps.queryClient, event);
    },
  );
}
