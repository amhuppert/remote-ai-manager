/**
 * Validation SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 *
 * The service publishes `validation-run` at every lifecycle phase through one
 * choke point, so these frames already cover every transition that can move
 * the global budget — admission, queueing, start, retirement, and release.
 * The frame is deliberately thin (it names one run, not the capacity), so the
 * reaction invalidates and lets the budget endpoint recompute rather than
 * trying to patch a total from a single run's phase.
 */

import type { QueryClient } from "@tanstack/react-query";

import { addSseListener } from "@/lib/api/sse";

import { validationKeys } from "./query-keys";
import { validationRunEventSchema } from "./schemas";

export interface ValidationSseReactionDeps {
  queryClient: QueryClient;
}

export function registerValidationSseReactions(
  es: EventSource,
  deps: ValidationSseReactionDeps,
): void {
  const { queryClient } = deps;

  addSseListener(es, "validation-run", validationRunEventSchema, (event) => {
    // `requested` is published before admission is even attempted, and is
    // always followed by the phase that does move the ledger (queued,
    // started, or rejected). Skipping it halves the refetches per submission
    // without ever dropping a real transition.
    if (event.phase === "requested") return;

    void queryClient.invalidateQueries({ queryKey: validationKeys.budget() });
  });
}
