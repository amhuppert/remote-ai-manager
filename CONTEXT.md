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
  A scope pair (session adapter + project adapter) resolves into the SAME shared
  domain operation; the operation takes a `ConversationTarget` (or a
  `ConversationScopeRef`) and never forks by scope. Ask, answer and abort are the
  shape to copy: `registerAskBatchAfterRoleGate`, `deliverAnswers` and `abortTurn`
  are the scope-invariant cores, and only the session adapters carry the
  graph-lane divert, which is session-only by spec non-goal. The message queue is
  the same shape: `enqueueQueuedMessage` and `cancelQueuedMessage`
  (`src/lib/prompt/queue-operations.ts`) hold the guards, the enqueue-then-drain
  ordering, and the cancellation semantics for both scopes, and each adapter
  supplies only its own 404 ladder and scope ref. On the client, a pending queue
  row is retired by ONE path for both scopes: the `message-queue-updated`
  reaction settles the optimistic entry when the durable row reaches a terminal
  status (`isTerminalQueuedMessageStatus`). Nothing else can — the durable row
  leaves the active queue in the same write, so a stand-in left behind would
  render the delivered message a second time as still-queued.
  `persistPendingPromptText` (`src/lib/prompt/route-handlers.ts`) is the same
  shape for the conversation DRAFT: both adapters resolve into it, and it names
  the store key `storeSessionName` so the sentinel is materialized at the write
  and never bound to a name a log line could pick up.

- **Conversation scope contract (agent environment)** — a spawned agent is told
  its scope EXPLICITLY. `buildSessionEnvContract`
  (`src/lib/agent-gateway/session-env.ts`) takes a `ConversationTarget` and
  exports `CC_CONVERSATION_SCOPE` (`session` | `project`); for a project
  conversation it exports `CC_SESSION` as an explicitly neutralized `""` — present,
  because the contract is merged OVER `process.env` and a deleted key resurrects
  the ambient value. A session target carrying the sentinel is REFUSED rather than
  exported, the way `conversationTargetApiBase` refuses it for URLs — the agent env
  is a public surface because the agent routes with what it reads. Scope reaches
  both backend runtimes as
  `ConversationBackendCreateInput.conversationTarget`, never re-derived from a
  session name or worktree path. In `cctl`, `readSessionEnv` is the one sanctioned
  env session read (a falsy check — `?? null` would pass `""` through and build
  `/sessions//conversations/…`), `readConversationScope` reads the discriminator,
  and `src/cli/session-env-inventory.ts` classifies every command that reads the
  session env as project-supported or intentionally session-only, enforced by
  `session-env-inventory.arch.test.ts`.

- **ConversationTarget** — the conversation addressing vocabulary for every
  public boundary (`src/lib/conversations/conversation-target.ts`): a
  discriminated union whose `session` variant carries project + session +
  conversation and whose `project` variant carries project + conversation only.
  It is what URL builders, API payloads, React Query keys, diagnostic identity,
  and user-visible labels address a conversation with, so the internal
  `__project__` sentinel has no public field to occupy.
  `conversationTargetStoreSessionName` / `targetFromStoreSessionName` are the
  only sanctioned crossings into and out of the sentinel, for the session-keyed
  state-store / runtime / lock / actor APIs that serve both scopes through one
  storage key. `refuseProjectSentinelSessionParam` (in
  `src/lib/shared/route-resolution.ts`) refuses the sentinel in a public session
  route position with a 400 naming the project route, and
  `src/lib/conversations/sentinel-public-surface.arch.test.ts` classifies every
  module allowed to reach the sentinel.

  Every public session route refuses through ONE contract: status 400, code
  `PROJECT_SENTINEL_REFUSAL_CODE`, and a message built by
  `projectSentinelRefusalMessage` naming the concrete project-shaped route for
  THAT endpoint. A route family with its own error envelope joins the contract
  by mapping to the same code — `CapabilityRouteScopeRefusalError` is the
  agent-capabilities case. Session-LEVEL routes are in the contract too: an
  operation with no project counterpart is refused as session-only rather than
  pointed at a route that would 404. A route that resolves the project itself
  instead of composing the session seam silently opts out of the refusal, so
  `src/lib/shared/session-route-refusal.arch.test.ts` requires every route under
  `/api/projects/[name]/sessions/[session]` to reach a refusal entry point.

- **Project route equivalent** — which project-shaped route a refusal names
  (`src/lib/conversations/project-route-equivalent.ts`). The equivalence is
  structural: the project router mirrors the session router with the
  `/sessions/<session>` pair removed, so the leaf and its dynamic segments carry
  over verbatim. `projectRouteForSessionRequestPath` reads the request path off
  the trace context (`TraceContext.requestPath`, stamped by `withTracing`),
  because route params identify the conversation but not WHICH of its endpoints
  was called. Which leaves the project router actually serves is not structural,
  so `PROJECT_CONVERSATION_ROUTE_OPERATIONS` pins them and its test compares that
  set against the App Router directory listing; an operation outside the
  inventory is refused as session-only rather than named as a route that would
  404. `resolveProjectSentinelRefusalTarget` is the shared entry point, with a
  caller-supplied fallback for untraced calls.

  A session-LEVEL operation (outside the `conversations/<id>` subtree) is not
  automatically session-only, and the mapping is wrong in both directions if it
  is treated that way. Three inventories decide, each pinned against the App
  Router tree: `PROJECT_LEVEL_ROUTE_OPERATIONS` mirrors to
  `/api/projects/<p>/<op>` (`commands`, `files`, `diff`, `prompt`,
  `conversations`, `agent-capabilities`, `mcp-config`);
  `PROJECT_CONVERSATION_SCOPED_SESSION_OPERATIONS` mirrors to a
  conversation-scoped project route the session path has no id for, so the name
  carries `CONVERSATION_ID_PLACEHOLDER` (`notifications`); and
  `SAME_NAME_DIFFERENT_OPERATION` records a name both routers serve while doing
  different things (`archive` archives a session vs the whole project), which is
  session-only despite the matching directory. The classification test fails on
  any operation both routers serve that is in none of the three, so a new shared
  operation has to be decided rather than defaulted.

- **ConversationScopeRef** — the scope union for surfaces that know their
  project but may have no conversation id yet (the composer's file and
  slash-command popups). `scopeRefFromStoreSessionName` is the only conversion
  from a stored session name into public scope, and each composer host applies
  it once at its own boundary — `PromptEditor` for its popups, `PromptComposer`
  for the capability drawer it and its toolbar mount; everything downstream
  branches on `scope` alone. An optional `sessionName` where `undefined` meant
  "project" is what let the sentinel build `/sessions/__project__/files` and
  session-keyed query keys.

  The composer's two capability surfaces — the slash-command popup's
  enabled/disabled filter and the configuration drawer where overrides are set —
  derive their cascade layer through one function,
  `conversationCapabilityScope`
  (`src/components/agent-capabilities/conversation-capability-scope.ts`), so a
  project conversation resolves `conversationScope: "project"` on both rather
  than one surface asking whether a session name looks absent.

  Server-side, the same ref is the DIAGNOSTIC identity of a turn. Structured-log
  fields are a public identity surface, and the project turn path is handed the
  store key at every stage (`sdk-driver` → conversation `manager` → turn
  resource acquisition → `actor-implementations` →
  `with-runtime-replacement-retry`, plus `transcript` and the message queue), so
  each derives one `scopeRef` and spreads it instead of logging a session name.
  Startup rehydration, the workflow task-run entrypoint, and state-store read
  timing are the project-reachable stages outside the turn. Modules under this
  rule take their `Logger` through deps so a test can read what they emitted;
  `.kiro/steering/logs.md` holds the rule and the stage tables.

  The GUARANTEE, though, is at the sink: `buildEntry` drops a sentinel-valued
  `sessionName` and substitutes `scope: "project"`. That belongs in the logger
  because the request trace context stamps `sessionName` onto every entry emitted
  inside a request, so a project request can leak from call sites that never
  mention a session and no per-site audit can be complete. Carriers that must
  transport the store key past a
  logging site name it `storeSessionName` (`TranscriptBroadcastMeta`,
  `AppendNoticeInput`, `acquireConversationLock`) so it cannot be spread onto a
  public surface by accident, and free-form diagnostic labels are built from the
  ref too — the query semaphore echoes its label into both its events and its
  queue-timeout error text.

  The log FILE PATH is a diagnostic identity too, and it is resolved from the raw
  trace context rather than from the sanitized entry, so the field guard cannot
  reach it. A project conversation therefore routes to
  `logs/projects/<projectSlug>/…` instead of
  `logs/sessions/<projectSlug>__<sentinel>/…`; `discoverScopedLogPaths` walks
  both trees so moving the destination does not hide project logs from readers.

- **Conversation draft** — unsent composer content, owned by the conversation
  rather than by the composer. Text lives on the record as `pendingPromptText`,
  so it is conversation-local by construction and survives a reload;
  `usePendingPromptPersistence` (`src/hooks/`) is the one implementation of the
  hydration gate, 500ms debounce, switch flush and unload beacon, and takes a
  `ConversationTarget` so both scopes share it. Image attachments have no
  persisted field and are held per conversation by `useImageAttachments`'
  `scopeKey`. Both halves matter where ONE composer instance serves many
  conversations — the project cockpit behind its tab strip — because there the
  default is for a draft to follow the user to the next tab.

- **Project-scope command refusals** — a slash command that needs a session
  branch or worktree is refused BY the project boundary, not by whatever
  session lookup it would otherwise reach. `ProjectCollaborationUnsupportedError`
  (`src/lib/project-conversations/prompt-entry.ts`) is the case in place:
  `/collab` is rejected before any get-or-create, so a refused command leaves no
  conversation behind, and the project prompt route maps it to a coded SSE
  `error` frame. Delegating instead produced `Session "__project__" not found` —
  a scope decision disguised as a missing record, publishing the sentinel.

- **Cross-scope conversation lookup** — `GET /api/conversations/<id>` resolves a
  conversation of EITHER scope by id alone (`findConversationById` queries the
  session repo, then `getProjectConversationById`) and answers with the
  scope-discriminated list item. `cctl conversation <verb> <id>` parses that
  discriminator and retries on the project route, so a cross-scope read of a
  project conversation never depends on guessing a session name.

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
- **Provisional conversation key** — the client-side slot a create-and-send
  submission allocates for itself before the server names the conversation it
  creates. Every piece of that turn's state is attributed to the key, so two
  concurrent creations can never reach each other's turn.
- **Creation request id** — the opaque token a create-and-send submission
  generates for itself and sends with its request. The project conversation it
  creates records the token, so the conversation carries the provenance of the
  submission that caused it. Persisted on project conversations only; no other
  creation path needs it, because every other path hands the conversation
  straight back to its caller.
- **Adoption** — moving a turn's state from its provisional key onto the
  conversation the server named for it, and releasing the provisional key. The
  name arrives from either the turn's own prompt request stream or the project
  conversation list; whichever arrives first adopts, and the other is a no-op.
  Both sources are causal: the stream frame arrives on the very request that
  created the conversation, and a listed conversation names a turn by recording
  that turn's creation request id. List membership alone never names a turn — an
  id is equally new to a client whether it was created for a pending submission,
  created by another tab, reopened after being closed, or simply absent from a
  first fetch that had not resolved.
