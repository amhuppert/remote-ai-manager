# Data Fetching & SSE

Read before changing query hooks, mutations, or SSE reactions. The conventions below guide changed behavior; they do not require an unrelated migration. `src/components/NotificationListener.tsx` owns connection assembly and each domain owns its `sse-reactions.ts`.

## Core Model

Two responsibilities, never conflated:

| Concern | Mechanism |
|---|---|
| Bulk data, paginated/filtered lists, large objects | TanStack Query — HTTP `GET`, cached, observable |
| Lightweight "something changed" notifications | SSE — single global bus, fan-out to all tabs |

SSE never delivers bulk data. TanStack Query never polls when an SSE channel can push. The two collaborate: SSE tells the client *what* changed; TanStack Query (or `setQueryData`) decides *how* the cache reacts.

---

## Perceived Responsiveness

**Hard rule: every mutable action gives the user immediate visual feedback.** Either the change appears instantly (optimistic update) or the UI visibly shows work in progress (pending indicator). Under no circumstances may the app look unresponsive between the user's action and the API response — a click that changes nothing on screen reads as a broken app, even if the cache eventually catches up.

### Decision ladder — pick the highest rung that applies

1. **Optimistic update (default).** The client can predict the post-mutation state: rename, archive/unarchive, toggles, mark-read, single-field edits, list add/remove. Apply it in `onMutate` with snapshot + rollback (pattern below). Prefer this whenever the predicted state won't mislead.
2. **Optimistic placeholder.** The client can't predict the full result but can represent the *attempt*: insert a placeholder entry with a `pending` status and a temporary id (`optimistic-<uuid>`), then reconcile with the server response or SSE event. Reference implementation: `src/lib/document-comments/mutations.ts`.
3. **Pending indicator (the floor).** Neither applies — spawning processes, launching workflows, server-side computation whose outcome is genuinely unknown. The triggering control must reflect `mutation.isPending` with *visible* in-progress state: spinner, label change ("Creating…"), or a progress row — plus disabling. Disabling alone is not feedback; a button that merely stops responding is indistinguishable from a hang.

There is no rung 4. "Fire mutation → `invalidateQueries` → wait for the refetch or SSE event to repaint" is **not** an acceptable feedback mechanism on its own. Background invalidation is cache hygiene — it guarantees eventual correctness, not perceived responsiveness. Every mutation that today relies on it still needs rung 1, 2, or 3 layered on top.

### How this composes with SSE

- The optimistic layer is presentation-only; the server stays authoritative. `onSettled` invalidation (or the SSE-driven `setQueryData`) overwrites the optimistic state with the real one.
- Optimistic writes and SSE handlers touch the same caches, so SSE `setQueryData` handlers must tolerate duplicate and out-of-order delivery. Upsert by stable id, use versions where order matters, or invalidate to refetch authoritative state. Applying a delta is not inherently idempotent (appending twice duplicates data).
- Placeholder entries (rung 2) are reconciled by id: the success handler or SSE event replaces the `optimistic-*` entry rather than appending a duplicate.

### Pending-indicator conventions (rung 3)

- Consume `isPending` from the mutation hook at the triggering control — don't thread bespoke `loading` booleans through state.
- Buttons: disable **and** swap the label or show a spinner. Modals: disable inputs and show progress on the confirm button.
- If a mutation updates several caches or the affected entity is visible in multiple places (list + detail), the pending state should appear where the user acted; the other surfaces update on settle.

---

## SSE

### Single global notification bus

- One `EventSource("/api/events")` per tab, opened by `NotificationListener` mounted at the root layout.
- Per-feature streams are forbidden except for genuinely high-frequency content streams (live token streaming for an active prompt). Lifecycle/status updates ride the global bus.
- The typed publication module (`src/lib/events/publication.ts`) is the **sole production interface** for cross-client events. Its private broadcaster adapter owns the raw transport; API routes and workflow modules publish through `publishEvent`, an injected `PublishFn`, `publishEventBestEffort`, or `publishScopedStatus`.

### Typed events, discriminator-driven

`src/lib/api/sse-events.ts` assembles the canonical discriminated union from domain-owned schemas. Read it for current event names and payloads rather than copying an illustrative shape.

- `event.type` selects the event schema and reaction.
- Listener reactions validate frames with `safeParse`; invalid frames are logged and dropped.
- Register a domain's reactions from `NotificationListener`; keep cache decisions in the domain module.

### Payload shape

Keep frames small. ≤1–2 KB per event is the target. Two valid shapes:

1. **Inline data** — the change *is* the payload (status enum flip, rename, new notification record).
2. **Identifier + change descriptor** — for anything larger than ~1 KB, send `{ entityId, changeType }` and let the client refetch the affected query or apply a delta.

Keep full transcripts, session lists, and diffs on HTTP reads. For frequent updates to large caches, prefer a small keyed delta; a low-frequency id-only event may narrowly invalidate the affected query.

### Reconnect correctness

- Server emits `id: <seq>\n` on every frame and a periodic `: heartbeat\n\n` comment every 15s.
- `replayFramesSince` in `src/lib/events/broadcaster.ts` returns newer buffered frames only when the requested interval is complete. A gap or server restart requires reconciliation from durable reads.
- `registerJobsReconnectReconciliation` invokes `reconnectReconcile` (`src/lib/events/sse-reconnect.ts`) after a connection error. Cached session transcript tails use `/messages?since=<transcriptSeq>`; other caches are invalidated, and running jobs reload from `/api/jobs`. Transcript sequence numbers and SSE event IDs are separate cursors.

### Publication path

```
domain code → publication.publishEvent(event) → broadcaster adapter → all clients
                                      └──────→ lifecycle projection (enumerated events only)
```

- `publishEvent` and the `PublishFn` interface in `src/lib/events/publication.ts` are canonical. A mutation that has already committed uses `publishEventBestEffort`; primitive-owned lifecycle status uses `publishScopedStatus`. Only the publication module and SSE transport may import `src/lib/events/broadcaster.ts`.
- Every route that mutates state and would otherwise require the client to poll publishes one event before returning.
- A `202 Accepted` response must not await the work it accepts. It returns once intent is recorded and the work is initiated, then the client observes completion through SSE — never by the route blocking until the work is done. Work expected to exceed ~1s runs as a job that reports progress over SSE; the accepting route responds promptly with the current status and readiness propagates through the existing event reactions (e.g. dev-server start returns `202` at its acceptance boundary while `dev-server-status` events carry the later readiness transition).

### An event's scope names what it invalidates

When one event kind reaches consumers at more than one scope, the payload states which —
a consumer must never have to choose between over-invalidating everything and missing the
right query. `agent-profile-library-changed` (the agent profile library, `src/lib/agent-profiles/`)
is the worked example:

```typescript
// src/lib/agent-profiles/schemas.ts — discriminated on `scope`
type AgentProfileLibraryChangedEvent =
  | { type: "agent-profile-library-changed"; scope: "global"; tier: "global"; id: string; revision: number; action: AgentProfileLibraryChangeAction }
  | { type: "agent-profile-library-changed"; scope: "project"; projectPath: string; tier: "project"; id: string; revision: number; action: AgentProfileLibraryChangeAction };
```

- `scope`/`tier` describe the **changed record**, not the route the change arrived on. A
  global-tier profile edited from inside one project is visible to every project, so it
  invalidates every project's library queries; a project-tier change invalidates only that
  project's (`src/lib/agent-profiles/sse-reactions.ts`).
- `projectPath` is present **exactly on the project variant**, structurally — the union
  makes a project-tier change that cannot name its project unspellable. Query keys are
  addressed by project NAME, and `agentProfileProjectNameFromPath` bridges the two.
- `action` is `created | updated | deleted`, published **after** the write commits, and
  best-effort — a refused or conflicted write publishes nothing at all.
- Which profile a CONVERSATION runs under is a different event at a different scope, and
  both carry the REDACTED snapshot only: `conversation-created` through
  `publicConversationStateSchema`, and `conversation-profile-changed` (a pre-lock swap)
  through `redactedProfileSnapshot`. An SSE frame is a read surface like any response
  body, so instruction text never rides one.

---

## TanStack Query

### Query Key Factories

Follow the production factories in `src/lib/sessions/query-keys.ts` and `src/lib/conversations/query-keys.ts`:

- Keys are **hierarchical arrays**, structured most-generic → most-specific: `[entity, category, identifier, filters]`.
- Use `as const` on every key definition for literal type inference.
- One factory per entity, colocated with the hooks that consume it.
- All parameters that vary the response **must** be in the key. Sensitive values (tokens, passwords) never enter keys; use identifiers.

Each domain owns its factories, colocated: keys in `src/lib/<domain>/query-keys.ts`, hooks in `src/lib/<domain>/queries.ts`, mutations in `src/lib/<domain>/mutations.ts` (which reference the keys for invalidation and optimistic updates).

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

Optimistic mutations are the default for mutable actions (see **Perceived Responsiveness** above): rename, archive, mark-read, simple toggles, single-field edits, list add/remove. Skip them only where the optimistic state would be misleading — significant server-side computation, spawning processes, running workflows — and in that case a pending indicator is mandatory, not optional.

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
- Handle duplicate and out-of-order delivery using the cache reconciliation rules under Perceived Responsiveness.

---

## Polling

SSE-first. Polling is a fallback, not a default.

### When polling is allowed

- **External process liveness** that we cannot push from (dev server health, external job runners). Use `refetchInterval` with a sane cadence (≥5s).
- **Bootstrap reconciliation** on tab focus when the SSE connection was offline. Use the shared reconnect reconciliation path; a focus refetch is not a substitute for event recovery.

### When polling is forbidden

- Anything the server already broadcasts via SSE. If you find yourself adding `refetchInterval` next to a query whose data is event-driven, the SSE coverage is incomplete — fix the broadcaster.
- "Just in case" intervals on lists, details, or status queries that have a publication path.
- `setInterval`-based custom pollers in feature code. All polling goes through TanStack `refetchInterval`, so it's observable in DevTools and pauseable when the tab is hidden.

### `refetchOnWindowFocus`

- Global default: `false`.
- The global SSE bus and shared reconnect reconciliation recover event-driven caches.
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

## File Layout

| Path | Contents |
|---|---|
| `src/lib/<domain>/query-keys.ts` | Per-domain query key factories |
| `src/lib/<domain>/queries.ts` | `useXxxQuery` hooks + `queryOptions` |
| `src/lib/<domain>/mutations.ts` | `useXxxMutation` hooks with `onMutate`/`onError`/`onSettled` |
| `src/lib/<domain>/schemas.ts` | Zod schemas for SSE events and API payloads |
| `src/lib/api/sse-events.ts` | Canonical `SSEEvent` union (assembled from per-domain schemas) |
| `src/lib/events/publication.ts` | Typed publication interface, delivery policy, and lifecycle projection composition |
| `src/lib/events/{status-bus,lifecycle-projection}.ts` | Private in-process lifecycle projection implementation |
| `src/lib/events/broadcaster.ts` | Raw server-side transport; imported only by publication and the SSE route |
| `src/components/NotificationListener.tsx` | Sole SSE consumer; dispatches to query cache |
| `src/app/api/events/route.ts` | Single SSE endpoint with replay + heartbeat |
