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
  `RouteResolution` for one addressing shape. Domain adapters include:
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
  backend runtimes as
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
- **Agent profile** — prompt identity only: name, description, instructions,
  advisory `recommendedFor`, and tags (`src/lib/agent-profiles/`). It carries no
  runtime (backend / model / reasoning effort) and no policy (tools, MCP,
  skills, permissions, output schemas). `agentProfileSchema` is `.strict()`, so
  those keys fail to parse rather than being ignored — a profile cannot grow
  into a second, competing runtime or policy cascade.

- **Profile tier / qualified identity** — the three tiers (`builtin`, `global`,
  `project`) are SIBLING SCOPES, not a shadowing chain. A profile is addressed
  only as `{tier, id}`, so `global:reviewer` and `project:reviewer` coexist as
  two different profiles and neither hides the other. The compact `tier:id`
  spelling exists only at text and CLI boundaries — `parseAgentProfileRef`
  normalizes it at parse and refuses a bare id with a located failure — and
  everything persisted is the structured form. Resolution fails closed:
  `library-service.resolve` raises for an unknown, deleted, or quarantined
  reference and never falls back to a similarly named profile in another tier.

- **Resolved profile snapshot** — what a consumer persists when it is staffed
  with a profile: the record's identity, its revision, its instructions, and the
  composed `renderedInstructionBlock`, copied at resolution time. A conversation
  holds a snapshot, not a reference, so editing or deleting a library record
  never changes work already under way, and a restart replays the STORED block
  byte-for-byte rather than re-rendering it. Two hashes, neither covering any
  other prompt layer: `sourceContentHash` covers the library record's
  instructions as stored, `resolvedInstructionHash` covers the block exactly as
  delivered. Only `redactedProfileSnapshot` crosses the public conversation
  schema.

- **Assignment** — naming which profile a consumer runs under. Conversation
  creation is the assignment surface in place: a creation path may name a
  profile, resolution defaults to `builtin:standard-agent`, the snapshot is
  persisted before the provider runtime exists, a session-derived fork inherits
  the source snapshot verbatim rather than re-resolving it, and the choice locks
  after the first turn (a pre-lock swap goes through the profile-change route).
  Collaboration Mode is the second assignment surface: the start request may
  name Agent Two's profile (resolved fail-closed before anything durable, full
  snapshot persisted in the envelope's `featureSnapshot.agents`), Agent One
  inherits the originating conversation's stored snapshot verbatim, and each
  lane's stored rendered block is appended to its governing instructions at the
  `callPrimitive` seam. Collab config has no post-start edit surface, so the
  snapshots are fixed at start by construction. Workflow assignments resolve through
  `src/lib/workflow-graph/seed-assignment-snapshots.ts` at execution start,
  after config resolution. It snapshots implementers and every validator
  assignment, including dormant cohorts and frozen loop templates; later
  turns replay those stored instructions without consulting the library.

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

- **Memory Note** — a markdown record the state store owns (`src/lib/memory/`,
  spec `memory`): a one-line fact-bearing `hook`, a byte-capped `body`, and on
  durable kinds one separately leased `statusNote`. Scoped `global | project |
  session`, where a session note binds to the exact incarnation (name plus
  created-at), never the reusable name. Addressed by agents through a
  scope-local `slug` (plus aliases); the internal id is canonical in link rows,
  revisions, watermarks, and `--json` envelopes only.
- **Memory actor** — who is writing and what they can see: `user` or `agent`
  (with its conversation id), each carrying its own visibility union
  (`projectPath`, session incarnation). The visibility bounds handle
  resolution and IS the scope authority: a note's scope owner is taken from the
  actor, never from the request, so a conversation writes only where it stands.
  The kinds differ only where the spec says so — an agent's global create lands
  as a `proposed` note, and proposal approval or rejection is a human act.
- **Memory service** — the single owner of memory write decisions
  (`src/lib/memory/service.ts`, reached through `getMemoryService()`): slug
  collision-safety within a scope owner (generated slugs suffix, explicit ones
  refuse), compare-and-swap edits over full-snapshot revisions, rename keeps
  the old slug as an alias, supersession archives the predecessor in the same
  transaction, archive before separately confirmed delete, and the global
  proposal lifecycle, whose approve and reject each name the proposed revision
  the human reviewed and refuse a stale one. Advisory assists (overlap candidates, vague-hook warning)
  ride beside a successful create and never refuse one. Every accepted
  mutation publishes one `memory-changed` frame (a `change` discriminator,
  identity, scope owner, lifecycle, head revision — never prose) through the
  SSE publication seam from inside the service; a refused mutation publishes
  nothing, and the route layer publishes nothing of its own.
- **Memory delivery policy** — what a conversation reads unasked and whether
  it may write (`src/lib/memory/delivery-policy.ts`, spec R10/D7): per role
  (`conversation`, `implementer`, `validator`) a `read` of `off | linked-only |
  ambient` and a `contribute` of `on | off`, each half resolving independently
  through the configuration cascade. Ordinary conversations read
  `memory.conversations` in global settings; workflow lanes read the per-role
  snapshot frozen on their execution context at seed time
  (`workflowDefaults.memory` → `workflowConfig.memory` → the context's
  `memory`, with provenance; `null` on the definition edit ops is the reset),
  falling back to the global role default when the row predates the snapshot.
  Shipped: conversations and implementers ambient+on, validators off+off.
  Read governs only what arrives unasked — the retrieval verbs are never gated
  — and is enforced by the per-turn index provider through its required
  `resolveReadPolicy` dep; contribution is enforced inside the memory service
  through its required `contributionGate` dep, which places an agent by its
  conversation id (and a lane by the execution's own binding) and refuses every
  mutation verb with `policy_refused` naming the verb, role, value, and tier.
  Linked-only is exact to the context under validation: a lane's block carries
  only the notes about-linked to its own execution context (the
  `workflow_context` artifact reference), never the run's or the ticket's.
  Hermetic profiles are excluded by surface: an isolated one-shot gets no CC
  identity even when a scope is attached, and no task-dispatch path composes
  the block.
  The index budget is `memory.indexBudget` in global settings and has no other
  home; a contract test walks every config schema to keep it that way.
- **Memory freshness engine** — the one owner of staleness decisions
  (`src/lib/memory/freshness.ts`, reached through `getMemoryFreshnessEngine()`).
  Two levels: a stale `statusNote` (its lease passed, or a statusNote-target
  watch drifted) withholds only the line while hook and body keep flowing; a
  stale note (its own `reviewAfter` passed, or a note-target watch drifted) is
  withheld from ambient delivery entirely; a passed `expiresAt` excludes
  unconditionally. Freshness gates AMBIENT delivery only — search and get never
  consult it. Two cadences: `check(candidates)` is the lazy comparison for notes
  a delivery build already selected (the per-turn hot path reads only their
  links); `buildReviewQueue(filter)` scans every non-archived note's leases and
  watch tokens (optionally narrowed to a visibility or a session incarnation),
  so a note never delivered still surfaces, each entry attributed to what went
  stale (`lease | watch | expiry`, by target). Delivery composers call the
  engine; they never compare leases or tokens themselves. Lease arithmetic and
  the age vocabulary (`renderMemoryStatusLine`, `describeMemoryAge`) live here
  too, so every surface renders one age.
- **Memory watch-token registry** — the per-artifact-kind resolvers behind
  watch links (`src/lib/memory/watch-resolvers.ts`): a ticket's token is its
  status (never `updatedAt`, so comments and field edits cannot fire a watch);
  a session's token is its exact incarnation's completion (`active` until
  `finished`, then `completed`; archival alone never moves it), and a later
  session reusing the name resolves to nothing. Kinds
  without an entry (spec, workflow execution) have no token, so a watch on them
  is refused at link time rather than recorded blind. A status line carries at
  most one watched artifact and a status watch needs a line to guard; both
  rules are decided inside the repository's serialized link write (never from
  a caller's earlier read), and a write that clears the status line drops its
  watches. The note level may carry several watches.
- **Memory review act** — `markReviewed(handle, { target })` on the memory
  service: `note` refreshes the note's lease (state notes short, durable notes
  the status period; never earlier than the lease it replaces; an unleased note
  stays unleased) and re-records its note-target watch tokens; `statusNote`
  refreshes the status line's lease and its watched token while leaving the
  claim's own `updatedAt` — its rendered age — untouched. Each restores the
  corresponding delivery, states an optional compare-and-swap base, and
  publishes `reviewed`.
- **Memory session-end** — session completion's memory step (`finishSession` on
  the memory service, reached from the merge publish actor through
  `finalizeSessionMemory` in `src/lib/memory/session-end.ts`, which resolves the
  incarnation from the session the lifecycle just marked finished). It archives
  the incarnation's wholly perishable `state` notes and reports the durable ones
  as promotion candidates. It is server-initiated: no actor, and the archives
  state no compare-and-swap base, so a session never fails to close on a
  concurrent edit. Archival is gated on the incarnation actually being over,
  never on the caller's say-so, so calling it early no-ops rather than retiring
  a live session's working state. It runs after the finished row is written and
  never blocks the merge on failure — and a failure is deferred, not lost, on
  three levels: the finalizer retries, `finishSession` reconciles every over
  incarnation of its project (so a later completion heals an earlier one, in
  `reconciled`), and `reconcileSessionMemory` sweeps EVERY project at server
  startup, which is what covers a project whose last session has already
  completed. No queued work item is needed: an active `state` note whose
  incarnation is over IS the durable record of the outstanding work, so any
  later sweep finds it, and the sweep is idempotent.
- **Memory promotion candidate** — a durable, active, session-scoped note whose
  incarnation is OVER. Candidacy is DERIVED, never stored, so it cannot drift
  from the session lifecycle: `isPromotableSessionNote` is the shape half and
  `isSessionIncarnationOver` is the other. "Over" includes an incarnation whose
  session row is gone or whose name a later session has taken — those notes are
  orphaned, which is exactly when a promotion decision is still owed, so
  candidacy does not evaporate with the row. The review queue is the one
  contract that carries it — `buildReviewQueue({ session, promotionCandidates })`
  narrows to candidates and every entry carries `promotionCandidate`, while
  `countPromotionCandidates` (the Library badge and the session-completion
  count) is that queue's length by construction. Both take a
  `MemoryProjectSessionRef`: a name and a created-at identify an incarnation
  only WITHIN a project, and the queue scans every scope owner. An entry is
  queued because it went stale, because it is a candidate, or both; there is no
  third membership rule.
- **Memory promotion** — `promote(handle, request, actor)`: one act creating the
  project-scope successor of a session note by superseding it, optionally
  rewriting hook, body, status line, slug, aliases, or index mode in the same
  act (an unstated status line carries forward WITH its lease and age, because
  promoting a claim is not re-verifying it). The handle resolves in session
  scope first, so a project note holding the same slug is the collision rather
  than a second candidate for the read. Every handle the promoted note would
  claim — slug and aliases — must be free among the project's active notes, and
  a collision is refused naming the holder: no suffixing, no overwrite. The
  compare-and-swap base is checked inside the repository's create transaction
  (`supersedes.baseRevision`), because the content is carried forward and a
  pre-read comparison would let an intervening edit be dropped silently; an
  unstated base defaults to the revision the act resolved rather than to no
  check, and only an explicit null opts out. The handle check is equally
  in-transaction (`requireFreeHandles`): a service-level precheck refuses early
  with the collision named, but only the transaction can promise that no writer
  claimed the slug or alias between the check and the insert. Both
  revision histories survive; the act publishes `promoted` and `superseded`.
