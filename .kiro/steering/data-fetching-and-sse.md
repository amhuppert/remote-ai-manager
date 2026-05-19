# Data Fetching & SSE

Ideal patterns for SSE, TanStack Query, optimistic updates, cache invalidation, and polling. This describes the target architecture — write new code to these rules and refactor existing code toward them.

## Core Model

Two responsibilities, never conflated:

| Concern | Mechanism |
|---|---|
| Bulk data, paginated/filtered lists, large objects | TanStack Query — HTTP `GET`, cached, observable |
| Lightweight "something changed" notifications | SSE — single global bus, fan-out to all tabs |

SSE never delivers bulk data. TanStack Query never polls when an SSE channel can push. The two collaborate: SSE tells the client *what* changed; TanStack Query (or `setQueryData`) decides *how* the cache reacts.

---

## SSE

### Single global notification bus

- One `EventSource("/api/events")` per tab, opened by `NotificationListener` mounted at the root layout.
- Per-feature streams are forbidden except for genuinely high-frequency content streams (live token streaming for an active prompt). Lifecycle/status updates ride the global bus.
- The broadcaster (`src/lib/sse-broadcaster.ts`) is the **sole** publication mechanism for cross-client events. API route handlers and workflow primitives publish through it (directly or via `StatusBus`); they never open their own streams for lifecycle/status concerns.

### Typed events, discriminator-driven

Every SSE frame uses a typed event name and a Zod-validated payload:

```typescript
type SSEEvent =
  | { type: "session-status"; projectName: string; sessionName: string; status: SessionStatus }
  | { type: "conversation-status"; projectName: string; sessionName: string; conversationId: string; status: ConvStatus }
  | { type: "message-delta"; projectName: string; sessionName: string; conversationId: string; seq: number; delta: MessageDelta }
  | { type: "job-update"; jobId: string; status: JobStatus }
  | { type: "mcp-config"; scope: McpScope; change: McpChange }
  | { type: "notification"; notification: Notification };
```

- `event.type` is the discriminator clients switch on.
- Payload schemas live in `src/lib/schemas.ts`; types via `z.infer`.
- Listener parses with `safeParse` — invalid frames are logged and dropped, never thrown.

### Payload shape

Keep frames small. ≤1–2 KB per event is the target. Two valid shapes:

1. **Inline data** — the change *is* the payload (status enum flip, rename, new notification record).
2. **Identifier + change descriptor** — for anything larger than ~1 KB, send `{ entityId, changeType }` and let the client refetch the affected query or apply a delta.

Never broadcast a full conversation transcript, full session list, or full diff. If a listener handler reaches for `invalidateQueries` on a large list because the SSE payload was too thin, the event needed to carry a delta instead.

### Reconnect correctness

- Server emits `id: <seq>\n` on every frame and a periodic `: heartbeat\n\n` comment every 15s.
- Client uses native `EventSource` `Last-Event-ID` semantics; server replays any frames newer than the supplied seq from an in-memory ring buffer (configurable depth, default 256).
- On reconnect, the client also issues `?since=<seq>` reconciliation requests for cursors it owns (active conversations, in-flight jobs, message tails). This catches anything older than the replay window.

### Publication path

```
domain code → StatusBus.publish(event) → sse-broadcaster.broadcast(event) → all clients
```

- `StatusBus` (`src/lib/workflows/primitives/status-bus.ts`) is the canonical publication surface. New broadcast sites add a `publish` call there; they do not import `sse-broadcaster` directly except inside the bus itself.
- Every route that mutates state and would otherwise require the client to poll publishes one event before returning.

---

## TanStack Query

### Query Key Factories

Follow the factory pattern from `tanstack-query-key-factory-reference.md`:

- Keys are **hierarchical arrays**, structured most-generic → most-specific: `[entity, category, identifier, filters]`.
- Use `as const` on every key definition for literal type inference.
- One factory per entity, colocated with the hooks that consume it.
- All parameters that vary the response **must** be in the key. Sensitive values (tokens, passwords) never enter keys; use identifiers.

```typescript
export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  list: (projectName: string) => [...sessionKeys.lists(), { projectName }] as const,
  details: () => [...sessionKeys.all, "detail"] as const,
  detail: (projectName: string, sessionName: string) =>
    [...sessionKeys.details(), projectName, sessionName] as const,
  diff: (projectName: string, sessionName: string) =>
    [...sessionKeys.detail(projectName, sessionName), "diff"] as const,
} as const;

export const conversationKeys = {
  all: ["conversations"] as const,
  lists: () => [...conversationKeys.all, "list"] as const,
  active: (projectName: string, sessionName: string) =>
    [...conversationKeys.lists(), "active", projectName, sessionName] as const,
  detail: (projectName: string, sessionName: string, conversationId: string) =>
    [...conversationKeys.all, "detail", projectName, sessionName, conversationId] as const,
  messages: (projectName: string, sessionName: string, conversationId: string) =>
    [...conversationKeys.detail(projectName, sessionName, conversationId), "messages"] as const,
} as const;
```

Centralize factories in `src/lib/query-keys.ts`. Hooks in `src/lib/queries.ts` consume them; mutations in `src/lib/mutations.ts` reference them for invalidation and optimistic updates.

### Lean response shapes

- One endpoint, one purpose. Don't return a session bundle that includes the conversation list, the diff, and the dev-server status because one component happens to want all three.
- Each query should fetch the smallest payload that satisfies its consumer. If two components need overlapping but distinct slices, expose two queries; let the cache do the deduplication.
- Endpoints that return ≥50 KB are a smell. Split by concern (messages vs metadata, diff vs file list) and let consumers compose.

### Hook pattern (Query Options API)

```typescript
export const sessionQueries = {
  detail: (projectName: string, sessionName: string) =>
    queryOptions({
      queryKey: sessionKeys.detail(projectName, sessionName),
      queryFn: () => fetchSession(projectName, sessionName),
      staleTime: 30_000,
    }),
};

export function useSessionQuery(projectName: string, sessionName: string) {
  return useQuery(sessionQueries.detail(projectName, sessionName));
}
```

Colocate the key, the fetcher, and the options so they cannot drift.

---

## Cache Invalidation

### Scope as narrowly as possible

- Invalidating `sessionKeys.all` is almost always wrong. If the SSE event carries `{ projectName, sessionName }`, invalidate `sessionKeys.detail(projectName, sessionName)`.
- "Invalidate the most generic key I can justify" is the wrong heuristic. The right heuristic is "invalidate the key whose contents could have changed because of this specific event."
- Remember TanStack semantics: `invalidateQueries` marks queries stale, but only *observed* queries refetch immediately. So overly-broad invalidation isn't free — it triggers refetches on every mounted component whose key matches the prefix.

### Canonical example — MCP config

The MCP update flow is the reference pattern: a single helper (`computeMcpConfigInvalidations`) maps a typed change descriptor to the exact set of keys that need invalidation, scoped by `{ projectName, sessionName, scope }`. New event-handling code follows the same shape:

```typescript
function handleMessageDelta(event: MessageDeltaEvent) {
  // Patch in place — no refetch needed
  queryClient.setQueryData(
    conversationKeys.messages(event.projectName, event.sessionName, event.conversationId),
    (prev) => applyDelta(prev, event.delta),
  );
}

function handleConversationStatus(event: ConversationStatusEvent) {
  // Narrow invalidation — only the affected conversation's status
  queryClient.invalidateQueries({
    queryKey: conversationKeys.detail(event.projectName, event.sessionName, event.conversationId),
  });
}
```

### Prefer `setQueryData` over invalidation when the event carries the change

If the SSE payload contains enough information to update the cache directly, do that — no refetch.

| Event payload | Reaction |
|---|---|
| Full new entity inline (small) | `setQueryData` |
| Delta (append/patch a known field) | `setQueryData` with patcher |
| "Something changed, here's the id" | `invalidateQueries` with narrow key |
| "Something changed somewhere" (no id) | The event is wrong — fix the broadcaster |

---

## Optimistic Updates

Use optimistic mutations for high-confidence operations: rename, archive, mark-read, simple toggles, single-field edits. Skip them for operations with significant server-side computation (spawning processes, running workflows) where the optimistic state would be misleading.

### Pattern

```typescript
export function useRenameConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: renameConversation,
    onMutate: async ({ projectName, sessionName, conversationId, newName }) => {
      const key = conversationKeys.detail(projectName, sessionName, conversationId);
      await queryClient.cancelQueries({ queryKey: key });

      const previous = queryClient.getQueryData<Conversation>(key);
      if (previous) {
        queryClient.setQueryData(key, { ...previous, name: newName });
      }
      return { previous, key };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous && context.key) {
        queryClient.setQueryData(context.key, context.previous);
      }
    },
    onSettled: (_data, _err, { projectName, sessionName, conversationId }) => {
      queryClient.invalidateQueries({
        queryKey: conversationKeys.detail(projectName, sessionName, conversationId),
      });
    },
  });
}
```

Rules:

- Always `cancelQueries` before snapshotting to avoid an in-flight refetch overwriting the optimistic value.
- Always snapshot for rollback. Never assume success.
- `onSettled` invalidates so the server's authoritative response wins eventually — even if the SSE event also fires.
- If both the optimistic update and the SSE-driven invalidation race, the SSE handler's `setQueryData` should be idempotent (delta application, not replacement) so order doesn't matter.

---

## Polling

SSE-first. Polling is a fallback, not a default.

### When polling is allowed

- **External process liveness** that we cannot push from (dev server health, external job runners). Use `refetchInterval` with a sane cadence (≥5s).
- **Bootstrap reconciliation** on tab focus when the SSE connection was offline. Sequenced *after* the reconnect `?since=<seq>` cursor sync — never as a substitute for it.

### When polling is forbidden

- Anything the server already broadcasts via SSE. If you find yourself adding `refetchInterval` next to a query whose data is event-driven, the SSE coverage is incomplete — fix the broadcaster.
- "Just in case" intervals on lists, details, or status queries that have a publication path.
- `setInterval`-based custom pollers in feature code. All polling goes through TanStack `refetchInterval`, so it's observable in DevTools and pauseable when the tab is hidden.

### `refetchOnWindowFocus`

- Global default: `false`.
- The global SSE bus + `?since=<seq>` reconciliation on reconnect cover the staleness window that focus-refetch would catch.
- Per-query opt-in (`refetchOnWindowFocus: true`) is allowed for queries that intentionally cannot be SSE-driven (e.g., external system status snapshots).

---

## Intersection — Putting It Together

### Decision table for "the server changed something, how does the client find out?"

| Change size | Frequency | Mechanism |
|---|---|---|
| Tiny (status enum, rename) | Any | SSE event with full payload inline → `setQueryData` |
| Small delta on a large cached object | High (per-message) | SSE delta event → `setQueryData` patcher |
| Medium (single record changed, can refetch cheaply) | Low | SSE id-only event → narrow `invalidateQueries` |
| Large (list of N items, expensive to recompute) | Low | SSE id-only event → narrow `invalidateQueries`, ensure endpoint is paginated |
| External system state (no server hook) | Slow-changing | TanStack polling with `refetchInterval` |

### Reconnect sequence

1. EventSource reconnects (browser-managed) with `Last-Event-ID`.
2. Server replays buffered frames newer than the supplied seq.
3. Client reconciliation: for each active cursor (in-flight jobs, open conversation tails), issue `GET /api/.../events?since=<lastSeq>` and apply returned deltas via `setQueryData`.
4. Only after reconciliation completes does the client trust the cache for any feature that was open during the disconnect.

### Anti-patterns

- ❌ Broadcasting a full transcript on every assistant message.
- ❌ `invalidateQueries({ queryKey: sessionKeys.all })` from a handler that knows `{ projectName, sessionName }`.
- ❌ A `useQuery` with `refetchInterval` next to a feature whose state is already broadcast by SSE.
- ❌ A mutation that writes via API and then waits for the SSE event to update local state with no optimistic step (visible UI lag for trivial operations).
- ❌ A second `new EventSource(...)` somewhere in feature code for "lifecycle" updates.
- ❌ Per-feature route handlers calling `sse-broadcaster.broadcast(...)` directly, bypassing `StatusBus`.
- ❌ SSE handlers that re-fetch via `invalidateQueries` when the event payload already contained the delta.

---

## File Layout

| Path | Contents |
|---|---|
| `src/lib/query-keys.ts` | All query key factories |
| `src/lib/queries.ts` | `useXxxQuery` hooks + `queryOptions` |
| `src/lib/mutations.ts` | `useXxxMutation` hooks with `onMutate`/`onError`/`onSettled` |
| `src/lib/schemas.ts` | Zod schemas for SSE events and API payloads |
| `src/lib/sse-broadcaster.ts` | Server-side broadcast primitive |
| `src/lib/workflows/primitives/status-bus.ts` | Canonical publication surface |
| `src/components/NotificationListener.tsx` | Sole SSE consumer; dispatches to query cache |
| `src/app/api/events/route.ts` | Single SSE endpoint with replay + heartbeat |
