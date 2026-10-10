/**
 * The run cache's one refresh (design r2 §9): mutations and SSE reactions ask
 * for a run's page, a session's list or every session's current runs to be
 * read again, and every request in
 * a short window is served by one refetch per query. A request arriving while
 * a read is in flight is still honoured: the next window refetches.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { runKeys } from "./query-keys";

export const RUN_REFRESH_WINDOW_MS = 100;

interface Window {
  keys: Map<string, QueryKey>;
  done: Promise<void>;
}

const windows = new WeakMap<QueryClient, Window>();

function refresh(queryClient: QueryClient, keys: QueryKey[]): Promise<void> {
  let window = windows.get(queryClient);
  if (window === undefined) {
    const opened: Window = {
      keys: new Map(),
      done: new Promise<void>((resolve) => {
        setTimeout(() => {
          windows.delete(queryClient);
          void Promise.all(
            [...opened.keys.values()].map((queryKey) =>
              queryClient.invalidateQueries({ queryKey, exact: true }),
            ),
          ).then(() => resolve());
        }, RUN_REFRESH_WINDOW_MS);
      }),
    };
    windows.set(queryClient, opened);
    window = opened;
  }
  for (const key of keys) window.keys.set(JSON.stringify(key), key);
  return window.done;
}

/** A run changed: its page, its session's list, and every session's current runs. */
export function refreshRun(
  queryClient: QueryClient,
  run: { projectName: string; sessionName: string; runId: string },
): Promise<void> {
  return refresh(queryClient, [
    runKeys.page(run.projectName, run.sessionName, run.runId),
    runKeys.list(run.projectName, run.sessionName),
    runKeys.active(),
  ]);
}

/** Particular cached pages, and the session's list when a listed field changed. */
export function refreshRunReads(
  queryClient: QueryClient,
  reads: { pages: QueryKey[]; list: QueryKey | null },
): Promise<void> {
  return refresh(
    queryClient,
    reads.list === null ? reads.pages : [...reads.pages, reads.list],
  );
}
