# Domain & architecture context

Vocabulary for Command Center's modules and seams. Architecture terms follow the
"deep modules" language (module / interface / seam / adapter / depth / leverage /
locality); domain terms name the concepts the code is about.

## Architecture terms

- **Route resolution** — the shared seam that turns a route handler's opening
  cross-section (unwrap dynamic params → resolve the addressed entities with a
  404 → validate the request body with a 400) into one `RouteResolution<T>`
  value. Handlers thread it with `if (!r.ok) return r.response;`, keeping only
  their own service call and response shape. Lives in
  `src/lib/shared/route-resolution.ts`.

- **RouteResolution<T>** — the contract every resolution step returns:
  `{ ok: true; value: T } | { ok: false; response: Response }`. The failure
  variant is independent of `T`, so a failure from one step returns directly
  from a resolver producing a different `T`.

- **Route resolver (adapter)** — a domain function that produces a
  `RouteResolution` for one addressing shape. Three adapters exist:
  `resolveSessionRoute` / `resolveSessionConversationRoute` (session-scoped,
  `src/lib/conversations/route-resolution.ts`) and
  `resolveProjectConversationRoute` (project-scoped,
  `src/lib/project-conversations/route-resolution.ts`), plus
  `resolveTicketProjectOr404` (ticket-scoped,
  `src/lib/tickets/route-resolution.ts`). All compose `resolveProjectOr404`.

- **SSE publication** — the typed seam for every server-to-client event.
  `publishEvent` returns a delivery outcome without throwing, `PublishFn` is the
  dependency-injection interface, and `publishEventBestEffort` keeps a
  post-mutation publication failure from failing the committed mutation. The
  wire adapter and lifecycle projection are private implementation details of
  `src/lib/events/publication.ts`.

- **Conversation lifecycle** — the deep Module that owns conversation turn
  submission, completion, persistence, and attached-workflow cancellation. Its
  interface exposes domain operations and projections; XState actors, events,
  and state topology remain private implementation details.

- **Continuation disposition** — the adapter-owned `retain | clear` decision
  returned with a backend turn result. It is derived from normalized failure
  evidence; `clear` always carries a null backend ref, while callers only apply
  the declared result and never infer policy from backend identity.

- **Task execution profile** — a semantic policy on an agent task request that
  adapters either translate into provider controls or explicitly reject before
  provider invocation. `isolated-one-shot` means one turn, no
  tools/MCP/inherited settings, and no persisted continuation.

- **Compatibility preflight** — the read-only first step when opening an
  existing state database. It refuses a future schema version before any DDL,
  data mutation, purge, or adjacent filesystem change.

- **Lifecycle projection** — the events Module that maps only authoritative
  lifecycle events onto scoped in-process status. Child context/task activity
  cannot overwrite a graph execution's lifecycle.

- **Graph validation session ref** — the provider-neutral identity envelope for
  a validation lane. `refKind` assigns ownership: conversation refs name a
  stable Command Center conversation, while backend refs remain opaque handles.
  `workflowConversationId` is the explicit navigation identity and is never
  inferred from provider type.

- **Validation review artifact** — a review link whose `kind` states its owner:
  `conversation` names a Command Center conversation; `response` names a
  backend-owned response and carries its rendered output and usage.

## Domain terms

- **Session conversation** — a conversation owned by a session worktree;
  addressed by `project → session → conversation`.
- **Project conversation** — a session-less, project-scoped conversation;
  addressed by `project → conversation`.
