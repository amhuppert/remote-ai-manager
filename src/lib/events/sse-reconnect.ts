import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import { agentCapabilityKeys } from "@/lib/agent-capabilities/query-keys";
import { collaborationKeys } from "@/lib/workflows/query-keys";
import { devServerKeys } from "@/lib/dev-server/query-keys";
import { notificationKeys } from "@/lib/notifications/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { stampedTranscriptMessageSchema } from "@/lib/conversations/schemas";
const stampedMessagesResponseSchema = z.array(stampedTranscriptMessageSchema);

type StampedMessage = z.infer<typeof stampedTranscriptMessageSchema>;

export type ReconcileJobsFn = (jobs: unknown) => void;

/**
 * Reconcile cached query state after an SSE reconnect.
 *
 * Walks every cached `conversationKeys.messages` query, asks the server for
 * entries newer than the last-seen `seq`, and appends the returned messages
 * via `setQueryData` — so an open transcript stays current after a stream
 * interruption without a full refetch storm. Per-feature caches that depend
 * on event coverage (sessions, collaboration, notifications, dev servers,
 * MCP config/tools) are invalidated narrowly so React Query refetches only
 * what is mounted. Jobs are reconciled via the existing `/api/jobs` payload.
 *
 * Pure & deps-injected so tests can stub `fetchFn` and inspect the resulting
 * cache state without mocking modules.
 */
export async function reconnectReconcile(
  queryClient: QueryClient,
  reconcileJobs: ReconcileJobsFn,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const messageQueries = queryClient.getQueriesData({
    queryKey: conversationKeys.messagesAll(),
  });

  await Promise.all(
    messageQueries.map(async ([queryKey, cached]) => {
      const tail = queryKey.slice(-3);
      const [projectName, sessionName, conversationId] = tail;
      if (
        typeof projectName !== "string" ||
        typeof sessionName !== "string" ||
        typeof conversationId !== "string"
      ) {
        return;
      }
      const lastSeq = highestSeq(cached);

      const url =
        `/api/projects/${encodeURIComponent(projectName)}` +
        `/sessions/${encodeURIComponent(sessionName)}` +
        `/conversations/${encodeURIComponent(conversationId)}` +
        `/messages?since=${lastSeq}`;

      try {
        const res = await fetchFn(url);
        if (!res.ok) return;
        const body: unknown = await res.json();
        const parsed = stampedMessagesResponseSchema.safeParse(body);
        if (!parsed.success || parsed.data.length === 0) return;
        const additions = parsed.data;
        queryClient.setQueryData(queryKey, (prev: unknown) => {
          const base = Array.isArray(prev) ? (prev as StampedMessage[]) : [];
          return [...base, ...additions];
        });
      } catch {
        // best-effort: a per-query reconcile failure shouldn't break the rest
      }
    }),
  );

  const sessionDetailQueries = queryClient.getQueriesData({
    queryKey: sessionKeys.details(),
  });
  for (const [queryKey] of sessionDetailQueries) {
    void queryClient.invalidateQueries({ queryKey });
  }

  void queryClient.invalidateQueries({ queryKey: conversationKeys.active() });
  void queryClient.invalidateQueries({ queryKey: collaborationKeys.all });
  void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  void queryClient.invalidateQueries({ queryKey: projectConversationKeys.all });
  void queryClient.invalidateQueries({ queryKey: devServerKeys.all });
  void queryClient.invalidateQueries({ queryKey: mcpConfigKeys.all });
  void queryClient.invalidateQueries({ queryKey: mcpToolsKeys.all });
  void queryClient.invalidateQueries({ queryKey: agentCapabilityKeys.all });

  try {
    const res = await fetchFn("/api/jobs");
    if (!res.ok) return;
    const data: unknown = await res.json();
    if (
      data !== null &&
      typeof data === "object" &&
      "jobs" in data &&
      (data as { jobs?: unknown }).jobs !== undefined
    ) {
      reconcileJobs((data as { jobs: unknown }).jobs);
    }
  } catch {
    // best-effort: job reconciliation is opportunistic
  }
}

function highestSeq(cached: unknown): number {
  if (!Array.isArray(cached) || cached.length === 0) return 0;
  const last = cached[cached.length - 1];
  if (
    last !== null &&
    typeof last === "object" &&
    "seq" in last &&
    typeof (last as { seq: unknown }).seq === "number"
  ) {
    return (last as { seq: number }).seq;
  }
  return 0;
}
