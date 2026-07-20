# Quick Ticket & CC Bug Report — Technical Design

Status: **v2 — revised after Codex review** (`memory-bank/agent-runs/quick-ticket-design-review.md`, 26 findings; disposition in §14). Inputs: UX direction (`docs/reports/2026-07-19_quick-ticket-ux-direction.md`), Claude Design prototype (`claude-design/quick-ticket-dialog-design/`), ticket-system v1 codebase. Standalone design document — Alex explicitly waived the Kiro spec flow for this feature (2026-07-19); this document is the design of record.

## 1. Scope

A globally available quick-ticket dialog (topbar button + hotkey) with context prefill, a Command Center bug-report mode that assembles a diagnostic bundle, background conversation-compaction snapshots, a post-create agent enrichment pass, and an **auto-start option** that triggers the existing start-work flow (session + kickoff prompt) right after creation.

Out of scope: ticket detail page redesign, graph-workflow integration, enrichment for non-CC-bug tickets, enrichment retry surface (v1 accepts logged-only failure — §9).

## 2. UX summary (resolved by the prototype)

Binding choices from `project/Quick Ticket.dc.html`:

- **Dialog**: 480px desktop modal / full-height mobile bottom sheet. Section order: header ("New ticket") → mode-switch row → Target (Project + Work type, 2-col) → Title → Description → Context (conversation chip) → Diagnostic bundle (bug mode) → error banner → footer.
- **Mode switch**: a toggle **Switch**, label "Command Center bug report"; helper text varies (off: "retarget to command-center and attach a diagnostic bundle"; on: "files to command-center · type bug · bundle below"; disabled: "unavailable on this instance" + tooltip "The Command Center project isn't resolvable on this instance"). In bug mode the Target section collapses (`grid-template-rows 0fr→1fr`).
- **Conversation chip**: single chip in a Context section — icon, conversation title, subtitle "conversation · compaction snapshot generates after create", X-remove. Hidden in bug mode (the bundle's Conversation row covers it).
- **Bundle panel**: bordered vertical stack; per-row icon | (screenshot thumbnail) | expandable title/value | chevron | X-remove; expandable monospace detail (screenshot: inline preview). Header: "N of 7" badge + "restore removed" link. Footer copy: "Everything above attaches to the ticket — remove anything you don't want captured."
- **Validation**: Project required ("Choose an owning project."), Title required ("Title is required."); first invalid field focused.
- **Draft safety**: restore mode — dismiss stashes a dirty draft; reopen shows "Draft restored" + Discard. (Confirm-discard variant dropped.)
- **Submit**: ⌘/Ctrl+Enter; footer hint. Button "Create ticket" / "File bug report". Pending: spinner-in-button, inputs disabled. Failure: inline banner + Retry.
- **Toast**: bottom-center, "`<ident>` created" + "View ticket" action, ~6s (existing `ACTION_TOAST_TTL_MS`).
- **Topbar affordance**: quiet icon button (document+plus) in the right cluster before the Tickets pill, tooltip "Quick ticket" + hotkey.

New (not in prototype): **auto-start row** — Checkbox above the footer, "Start agent after create", hint "creates a session and sends the ticket kickoff prompt". Default off, both modes.

## 3. Architecture overview

```
Client
  src/stores/quick-ticket.store.ts             open/mode/draft + context REGISTRY (owner tokens)
  src/components/quick-ticket/QuickTicketHost.tsx     root mount: hotkey + dialog + error-buffer init
  src/components/quick-ticket/QuickTicketDialog.tsx   canonical dialog (CreateTicketDialog retires into it)
  src/components/quick-ticket/screenshot.ts           dynamic-import DOM capture
  src/components/topbar/QuickTicketButton.tsx         topbar affordance
  src/lib/client-errors/ring-buffer.ts                sanitized error capture
  src/lib/tickets/quick-ticket-context.ts             pure route-pattern table + registry composition
Server
  src/lib/tickets/schemas.ts                   createTicketInputSchema extension + diagnostics schemas
  src/lib/tickets/service.ts                   create() orchestration via attachment PLANNER dep
  src/lib/tickets/create-attachment-planner.ts validates facts, pre-captures blobs → { attachments, compensate }
  src/lib/state-store/tickets-repo.ts          createWithAttachments + compareAndSwapConversationSnapshot
  src/lib/tickets/snapshot-refresh.ts          background capture + retry verb + startup recovery
  src/lib/projects/command-center-project.ts   CC-project resolution (override + git-common-dir identity)
  src/lib/tickets/cc-project-route-handlers.ts + thin src/app/api/command-center-project/route.ts shell
  src/lib/tickets/enrichment.ts                server-owned one-shot structured triage (§9)
  src/lib/tickets/diagnostics.ts               diagnostic-note composition
```

Cross-feature placement per `structure.md`: the dialog is used by the global host and the /tickets feature, so it lives in `src/components/quick-ticket/`; feature-local helpers it needs (ticket-reference chip helpers, work-type visuals, ticket URL-state parsing) get promoted to `src/lib/tickets/` or `src/components/` as part of the move. All new app routes are thin re-exports of domain route handlers. All new modules use `createLogger` structured logging.

## 4. Global availability

### 4.1 Host, store, availability predicate

`QuickTicketHost` mounts in `RootLayout` **inside** the `UiTooltipProvider` boundary (today only `children` are inside it — RootLayout.tsx:63-70; the host goes there, or the provider widens). One shared predicate `isQuickTicketAvailable(pathname)` (v1 exclusion: `/config`) gates the host's hotkey, the desktop Topbar button, and the mobile-menu item together — ConfigPage does render the Topbar, so without the shared predicate the button would be a dead affordance there.

The zustand store owns `open`, `bugMode`, `draft` (field values + removed bundle keys), and the **context registry** (§5). Topbar button and hotkey both call `openQuickTicket()`.

### 4.2 Hotkey

New `HOTKEY_REGISTRY` entry `quickTicket` (extends the `HotkeyId` union + exhaustive Record), default **`mod+shift+k`** — the prototype's ⌘⇧T is browser-reserved (Chrome tab-restore; pages cannot intercept it). Known conflict: Firefox web console; acceptable v1. The entry sets `enableOnFormTags` and `enableOnContentEditable` so the press-again-to-close chord works while focus is in the dialog's inputs, combined with `keepActiveInOverlay: open` (Topbar-switcher pattern). Copy renders the registry binding, never a hard-coded combo.

### 4.3 Topbar button

`QuickTicketButton` renders in the Topbar right cluster before the Tickets pill (insertion at Topbar.tsx:187-210) for every `page` value, gated by the availability predicate. Hidden on mobile widths; the mobile menu (Topbar.tsx:360-380) gains a "Quick ticket" item.

## 5. Context prefill

Composed in `resolveQuickTicketContext()` (pure, unit-tested) from two sources; a compatible live registration overrides route inference; the dialog snapshots the result at open time.

**1. Route-pattern table** — explicit, with `decodeRouteSegment` on every segment: `/projects/[name]` → project; `/projects/[name]/[session]` → project + session **only for valid dynamic session subroutes** (static children like `workflows` are reserved words in the table); `/tickets/[projectName]/[number]` → that project; `/tickets?…` filter → prefill project (URL-state parsing promoted out of the feature into `src/lib/tickets/`). Malformed encodings and every current route shape covered in the test matrix.

**2. Conversation registry (push-based, owner tokens)** — surfaces that display a conversation register `{ token, projectName, sessionName | null, conversationId, title }` into a small ordered registry; the newest compatible registration wins; unregistering removes **own token only**, revealing any still-mounted older registration (survives StrictMode double-effects and overlapping mounts). Exactly three registration sites:

1. `ConversationsPageInner` — the centrally-resolved active conversation (panes do **not** register individually; pane focus already flows into the page's active selection).
2. `ProjectCockpit` — its active project-level conversation (`sessionName: null`).
3. `WorkflowConversationViewer` — its exact project/session/conversation props.

The session overview page (`/projects/[name]/[session]` → SessionListPage) has no single active conversation and registers nothing — route inference supplies project/session only.

Prefill result `{ projectName?, conversation? }`; empty project on global pages, validated on submit.

## 6. Create flow

### 6.1 API extension — attachments at create

`createTicketInputSchema` gains two optional fields (canonical Zod in `src/lib/tickets/schemas.ts`; types via `z.infer` only):

```ts
conversationContext?: {
  sourceProjectName: string;      // the project OWNING the conversation — independent of the ticket's target project
  sessionName: string | null;     // null for project-level conversations
  conversationId: string;
  title?: string;                 // display label for the attachment description
}
diagnostics?: QuickTicketDiagnostics   // §7.3 — bug mode only, strictly bounded
```

Source identity is explicit because conversation attachments are cross-project by construction (attachment payloads persist source `projectPath`; the CC-bug mode always retargets, and generic mode allows changing the target while keeping the chip). The service resolves and verifies the **source** project independently of the target.

**Stale-context rule** (product decision): create never blocks on context. If the source project resolves but the conversation is unknown, the attachment persists as `failed` with a safe error (visible, retryable, removable). If the source project itself no longer resolves, the attachment is omitted and the create response carries a warning the client surfaces in the toast.

**Service assembly**: `TicketServiceDeps` gains one focused dependency — a **create-attachment planner** that validates conversation/diagnostic facts, pre-generates attachment IDs, captures file blobs to the content store (`capture(bytes)` — notes are inline payload JSON, no blob), and returns `{ attachments, compensate }`. `create()` then calls `repo.createWithAttachments`, returns the repo's actual detail, and publishes the real list item (`attachmentCount`, `attachmentIndexChanged: true` — the current helper hardcodes false and must take it as input). Production wiring lands in `service-factory.ts`. Blob compensation runs only on **guaranteed precommit failure** (§6.3).

### 6.2 Conversation snapshot: pending state machine + compare-and-swap

`conversationAttachmentPayloadSchema` evolves into an explicit state machine. Because ticket attachment schemas are **trusted persisted schemas** (production `parseTrusted` skips parsing; Zod defaults/transforms are forbidden by the effect-free contract), the design uses no defaults:

```ts
snapshotKey: string | null
snapshotCapturedAt: string | null
snapshotStatus?: "pending" | "captured" | "failed"   // ABSENT ⇒ captured (legacy rows); no Zod default
snapshotError?: string                                // bounded; REQUIRED for failed, FORBIDDEN otherwise
```

An effect-free `superRefine` enforces the exact matrix — `captured`/absent ⟺ both fields non-null; `pending`/`failed` ⟺ both null; no other combination parses. A pure `effectiveSnapshotStatus(payload)` helper maps absence to `captured` at every read site. Compatibility is one-directional (new binary reads legacy rows; pending rows are not downgrade-safe) — documented, accepted.

**Concurrency**: every snapshot transition goes through one repo-owned mutation, `compareAndSwapConversationSnapshot`, which returns `won | lost (with current payload) | missing`, advances the ticket revision and publishes only on a winning transition. All refreshers use it — the background task, the retry verb, and the start-service refresh (whose current exact-payload CAS ignores the changes count and whose cleanup assumes non-null previous keys; both get reconciled onto the shared mutation). Candidate blobs use unique filenames; losers delete their own candidates; the previous winner's blob is retired only after successful adoption; removal reclaims only non-null captured keys; row-removal and ticket/project deletion during capture are tolerated (`missing` result). Deterministic race tests: background-vs-start, background-vs-retry, background-vs-removal, background-vs-project-deletion.

**Background task + durability**: after the create transaction commits, the service schedules `refreshConversationSnapshot(ticketRef, attachmentId)` — an in-process async task that re-enters the project-operation gate, runs `ensureConversationCompaction` → `contentStore.captureText` → CAS transition → `ticket-changed`/`attachments` publication. A bare promise is not durable, so: **startup recovery** sweeps `pending` rows to `failed` (joining the existing interrupted-compaction/agent-run sweeps in `instrumentation.node.ts`), and **retry** is allowed from both `pending` and `failed`.

**Retry surface**: `POST /api/projects/{name}/tickets/{number}/attachments/{id}/refresh-snapshot` (thin shell → domain handler) + a new **`cctl ticket attachment refresh`** verb. Consumer updates (the review's full inventory, adopted): attachment-service resolve branches on effective status (never `read(null)`, never serves live content for pending); removal narrows null keys; `ResolvedAttachment` gains canonical `pending`/`failed` response arms (state, safe error, retry command) consumed by both the client resolve query and the CLI's own renderer schema; `AttachmentIndex` renders pending ("snapshotting…" StatusChip) / failed (chip + Retry); the materializer only receives captured payloads or returns a typed context-preparation failure; existing synchronous producers write `captured` explicitly; `service-factory` wires the new deps. Contract coverage: the repo durability fixture gains conversation-arm cases for all four shapes (legacy-absent, captured, pending, failed) — the round-trip helper treats union payloads as opaque leaves, so each shape needs its own fixture entry.

### 6.3 createWithAttachments (repo)

`createWithConversationAttachment` generalizes to `createWithAttachments(input, attachments[])`; the `/ticket` command migrates (list of one). Contract hardening: all attachments and ticketId matches validate **before** the transaction; all rows insert in the same immediate transaction (any duplicate rolls back counter + ticket, preserving the existing rollback contract test); the detail read moves **inside** the transaction callback (or is assembled from validated inputs + allocated number) so a rejection guarantees nothing landed — today's post-commit `readDetail` can throw after commit, which would make the slash-command-style "rejection ⇒ delete blobs" compensation destroy a committed row's content. Tests: N-row success, duplicate-at-index-N rollback, validation-before-write, post-create-read failure, multi-blob compensation.

Deterministic bundle order: attachments reload ordered by `created_at, id`, so the planner assigns strictly increasing `createdAt` values (report note → screenshot → conversation) with a reload assertion.

### 6.4 Success behavior

Unified for every invocation: close dialog, `pushToast("<ident> created", { action: "View ticket" → ticketDetailHref })`. The current post-create "Add context →" navigation step is removed (**behavior change on /tickets**). Draft clears on success only.

## 7. CC bug-report mode

### 7.1 Command Center project resolution

`src/lib/projects/command-center-project.ts`:

1. **Config override (authoritative)**: optional `commandCenterProjectName` added to **both** `rawGlobalConfigSchema` and `globalConfigSchema` — the loader parses disk JSON through the raw schema first, so a normalized-only field would be silently stripped. Validated to resolve to an available project. v1 is file-only (no ConfigPage field); documented with the global-config steering material, not in `project-configuration.md` (which owns per-repo `CommandCenter.json`).
2. **Auto-detect (worktree-safe)**: compare canonical realpaths of `git rev-parse --path-format=absolute --git-common-dir` for the server's checkout and each candidate project — linked worktrees share the common dir, so a dev server started from a session worktree still matches the registered main checkout (`process.cwd()` equality would not; precedent: `src/lib/git/worktree.ts` already uses `--git-common-dir`). Ambiguity (multiple matches) → unresolved, require the override. Non-git/packaged deployments → override only.

Resolution is cached **per config version** (the config loader already reloads on file mtime/size — a permanent cache would regress that). Exposed via `GET /api/command-center-project` (thin shell → handler); the client query uses a finite staleTime and refetches on config change rather than `Infinity`. `null` → mode switch disabled with the prototype tooltip.

### 7.2 Mode flip

Flipping on: target project := resolved CC project, workType := bug (Target collapses), bundle panel appears, screenshot capture starts (§7.4). Flipping off restores pre-flip project/workType. Bundle removals live in dialog state and stash with the draft.

### 7.3 Diagnostics payload — strictly bounded

Client sends raw facts; the server composes attachments. `quickTicketDiagnosticsSchema` (canonical Zod, `schemas.ts`) bounds everything: string maxima on every field, `removed` as an enum set of the seven bundle keys, ISO-timestamp validation, client errors capped (≤25 entries, message ≤500 chars, stackHead ≤3 frames), screenshot validated as canonical base64 with decoded-byte ceiling (≤2 MB), image magic-byte check, media type ∈ {`image/webp`, `image/png`} (client normalizes to WebP; PNG is the Safari fallback), and dimension sanity. The create route reads the body through a **bounded JSON reader** — Content-Length precheck + streaming cutoff → 413 — following the existing pattern in `attachment-route-handlers.ts:127-165`. Client downscaling is UX, not the enforcement boundary.

Server-side composition (`diagnostics.ts`), honoring `removed`:

- **Diagnostic report** — one note attachment (inline markdown): route + view state; observed identity IDs (project, session, conversation, workflow execution) each with a deep link; server build + environment (`BUILD_INFO.sha`/`buildTime`, app version, platform); **cctl crib** — conversation-scoped, self-reference-free: `cctl conversation read <id> --outline`, `cctl conversation compaction get <id> --format markdown`, debug-logs pointer. Ticket-self commands (`cctl ticket get <ref>` etc.) are deliberately **omitted** — the ticket number does not exist until the repo transaction allocates it, and `cctl ticket get` already renders the attachment index with per-entry retrieval commands after creation, so the crib loses nothing.
- **Client errors** — a section of the same note.
- **Screenshot** — file attachment via `contentStore.capture` (Uint8Array), extension derived from the validated media type, description "Page state behind the dialog when the bug was filed".
- **Conversation** — standard conversation attachment (pending snapshot), description "Conversation active when the bug was observed".

All rows land in the single `createWithAttachments` transaction; the bundle panel preview renders from the same client-side facts the server receives — nothing invisible.

### 7.4 Screenshot capture

`modern-screenshot`, **dynamically imported** on first bug-mode flip (a static import from the root-mounted host would drag the library into every page's client graph). Capture targets the **`.app` page subtree** — Radix portals (dialog, scrim, positioning wrapper) render outside it, which excludes the overlay without per-node filtering (the scrim is a separate element a content-only data-attribute would miss). One in-flight capture per draft; stale results are discarded when the mode flips off or the dialog closes; thumbnail shimmers until ready; capture failure renders the row as "capture failed", removable, never blocking create.

### 7.5 Client error ring buffer

`src/lib/client-errors/ring-buffer.ts`: module singleton initialized by the host; listeners for `window.onerror`, `unhandledrejection`, a `console.error` wrap (HMR double-install guard), and a React Query error subscription. Ring of 25 `{ ts, kind, message, stackHead }`. **Sanitization is explicit, not aspirational**: only Error/string values are summarized (arbitrary console objects are never stringified), URLs are stripped of query strings, common credential patterns are redacted, and messages/stacks are truncated at capture time. The bundle preview shows exactly the sanitized entries that will be sent.

## 8. Auto-start option

UI: Checkbox above the footer — "Start agent after create". Default off, both modes.

Flow (client-orchestrated; no new server surface):

1. `createMutation.mutateAsync` resolves (instant); dialog closes; toast "`<ident>` created — starting agent…" with View ticket.
2. `startMutation.mutateAsync({ projectName, number, mode: "agent" })` — no backend/model/effort overrides, which applies the **configured server defaults**: kickoff resolves `config.defaultAgentBackend`, then the conversation/backend model-effort cascade. (Note: this can differ from `StartTicketDialog`, which hardcodes Claude + catalog defaults client-side — a pre-existing divergence; a server-owned start-default resolver shared by both is flagged as follow-up, with a `defaultAgentBackend=codex` test pinning agreement.)
3. Outcome handling is **reconciliation, not fire-and-forget** (start is failure-safe, not idempotent): HTTP 409 `active_session` naming this ticket's current link ⇒ treat as success; 409 `start_in_progress` ⇒ refetch the ticket's session links and report their state; network/5xx ⇒ refetch links before declaring failure (`ApiCallError` preserves status/code/details). Success toast says "**Agent queued** on `<ident>`" (`initialPromptQueued` proves queueing, not a running agent) with an **Open conversation** action deep-linking `/conversations?c=<output.conversationId>` (the session URL is an overview list, not the transcript). `initialPromptQueued === false` ⇒ "Session prepared — open it to send the kickoff prompt". Failure after reconciliation ⇒ error toast + View ticket (the ticket is intact; start remains available from the detail page).

A crash between create and start leaves a valid not-started ticket. Model/backend pickers stay out of the quick dialog; the escape hatch is the detail page's StartTicketDialog.

**Ordering vs enrichment**: when auto-start is selected on a bug-mode ticket, the separate enrichment run is **skipped** — the started agent receives the diagnostic report through the kickoff's attachment index and triages as part of the work itself. Running both would race (start snapshots ticket fields + attachments at lock entry, so a late enrichment note is invisible to the first turn) and duplicate agent spend. A test pins this ordering.

## 9. Enrichment pass (bug mode, auto-start not selected)

**Server-owned, structured, idempotent** — the agent never mutates the ticket. The review established that reusing the agent-runs subsystem as-is is unsound: its runs require a session identity, its public route enforces session-worktree containment, its task subprocesses blank ambient `CC_*` env (so `cctl` inside would have no server URL/token/PATH), it forces its own memory-bank output contract, grants full access rather than read-only, and has no terminal callback — and prompt text cannot enforce exactly-once.

Design instead: `src/lib/tickets/enrichment.ts` invokes the backend task-runner primitive directly (the same one-shot layer behind agent runs and `/ticket` generation) with a strict output schema `{ markdown: string }`, a server-enforced size cap, a read-only-investigation prompt carrying the diagnostic facts inline (no cctl dependency), and a bounded timeout. On success **the server** appends exactly one "Agent triage" note through the attachment service using a **deterministic attachment ID** derived from the ticket (idempotency — a retry after a crash cannot duplicate), publishing the normal attachments event. Never blocks or fails the create.

**Failure surfacing — v1 scope decision**: logged (structured event) only; no notification row and no retry surface. The notifications domain supports only job and project-conversation sources (schema + repo + SQLite CHECK constraint + client toast filter), so a first-class enrichment notification needs a table-rebuild migration and client/push updates — disproportionate for additive garnish whose absence leaves a fully usable ticket with the deterministic bundle. The note's arrival is the success signal. Revisit (as a real job type or notification source) if enrichment becomes load-bearing.

## 10. Schema & persistence changes (complete list)

1. `conversationAttachmentPayloadSchema`: nullable snapshot fields + `snapshotStatus`/`snapshotError`, effect-free superRefine state matrix, `effectiveSnapshotStatus` helper (§6.2).
2. `ResolvedAttachment` union: `pending`/`failed` conversation arms; client resolve query + CLI renderer schemas follow.
3. `createTicketInputSchema`: optional `conversationContext` (with `sourceProjectName`) + `quickTicketDiagnosticsSchema` (bounded).
4. `tickets-repo`: `createWithAttachments` (transaction-internal detail read) + `compareAndSwapConversationSnapshot`; `/ticket` command migrates.
5. Config: `commandCenterProjectName` in **raw + normalized** global schemas; loader round-trip tests; file-only v1.
6. `HOTKEY_REGISTRY` + `HotkeyId`: `quickTicket` entry (`enableOnFormTags`, `enableOnContentEditable`).
7. New routes (thin shells → domain handlers): `GET /api/command-center-project`, `POST …/attachments/{id}/refresh-snapshot`. New CLI verb: `cctl ticket attachment refresh`.
8. New dependency: `modern-screenshot` (dynamic import only).
9. Startup recovery sweep for pending snapshots in `instrumentation.node.ts`.
10. No new tables; no column migrations (attachment payloads are JSON; notifications untouched).

## 11. Testing strategy (red-green)

- **Pure logic**: route-pattern table (incl. reserved static children, encoded segments, ticket-detail route, malformed encodings); context-registry owner-token semantics (StrictMode double-effect, overlap, unmount-restore); payload state matrix + `effectiveSnapshotStatus`; diagnostics composition (removed-keys honoring, crib content, order); ring-buffer sanitization (object rejection, query-string stripping, redaction, truncation, capacity, HMR guard).
- **Service + persistence** (`createPersistenceFixture`, reload through the repo): `createWithAttachments` N-row success / duplicate rollback / validation-before-write / post-create-read failure / multi-blob compensation; CAS won/lost/missing incl. the four race pairs (§6.2); startup recovery pending→failed; contract fixture arms for legacy-absent/captured/pending/failed; deterministic attachment order reload assertion; enrichment idempotent append.
- **Routes**: bounded-body 413; create with conversationContext (incl. source≠target for both modes, project-level `sessionName: null`, stale-context rules); refresh-snapshot; command-center-project (override, common-dir auto-detect, ambiguity, unresolved).
- **CLI**: attachment get/refresh rendering of pending/failed arms (text + JSON).
- **Dialog (RTL, no Storybook imports, real hooks/stores + fetch fixtures)**: validation focus order, mode flip, item remove/restore, draft stash/restore/discard, auto-start reconciliation branches (success / active_session / start_in_progress / network ambiguity), ⌘Enter, toasts.
- **Browser pass** (per ui-design practice): evolve the CreateTicketDialog story to the new dialog; Storybook interaction coverage + real keyboard/axe verification — focus trap/return, form-tag hotkey, nested overlays, mobile sheet, error focus, reduced motion.
- **SSE**: snapshot-status update event refreshes detail cache; auto-start/enrichment ordering pin.
- `bun run seams:check` on every boundary touch; events only via `publication.ts`; no `vi.mock` of internal modules.

## 12. Deviations (from prototype / direction doc)

1. **Hotkey**: ⌘⇧T → `mod+shift+k` (browser-reserved; §4.2).
2. **Screenshot copy**: "page state before the dialog opened" → "page behind the dialog" (capture-on-flip of the `.app` subtree).
3. **/tickets create flow**: post-create navigation replaced by the unified toast.
4. **Draft safety**: restore mode only.
5. **Enrichment status UI** (direction doc §7): v1 has no pending indicator, no failure notification, no retry — logged-only failure (§9 rationale). Compaction-snapshot failures, by contrast, ARE visible with retry (§6.2).
6. **cctl crib**: no ticket-self commands in the at-create note (number not yet allocated; index provides them post-create).
7. **Toast duration**: ~6s (existing constant), not 7s.

## 13. Open items

- Final hotkey vetting (hotkey-helper) before implementation.
- Enrichment backend/model default (proposal: instance default backend, fast tier) and prompt wording.
- Server-owned start-default resolver shared with StartTicketDialog (follow-up beyond v1).
- Whether the mobile menu item ships in v1 or the affordance stays desktop-first.

## 14. Codex review disposition (2026-07-19)

Review: `memory-bank/agent-runs/quick-ticket-design-review.md` (4 blockers / 16 major / 5 minor / 1 nit). **Accepted and folded in**: B1 source-project identity (§6.1); B2 crib self-reference (§7.3 — dropped rather than callback-composed); B3 snapshot CAS + races (§6.2); B4 enrichment redesign (§9); M5 state matrix + effect-free constraints; M6 full consumer inventory (§6.2); M7 startup recovery; M8 transaction-internal detail read + compensation contract; M9 planner dependency + publication truth; M10 bounded reader + sanitization; M11 "configured server defaults" wording + resolver follow-up; M12 start reconciliation + conversation deep link; M13 skip-enrichment-on-auto-start; M14 git-common-dir identity + config-version cache; M15 raw+normalized config schemas; M16 resolved by §9's no-notification scope; M17 tooltip-provider mount, shared availability predicate, form-tag hotkey flags, `.app` capture root; M18 corrected registration sites + owner-token registry; M19 route-pattern table + parser promotion; M20 file layout under `src/components/quick-ticket/` + thin route shells + canonical schemas; m21–m25 and the nit as specified. **Rejected**: M20's spec-flow requirement — Alex explicitly directed a standalone design document with no Kiro workflow for this feature; the ticket-system spec is untouched by that decision.
