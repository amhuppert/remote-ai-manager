# Contracts: /conversations Route Rework

Single source of truth for the acceptance criteria of the "conversations route rework" graph
workflow. Execution-context acceptance criteria reference the numbered sections below. Read the
charter first: `.cc/graph-workflow-docs/conversations-route-charter.md`.

Line numbers cited below are approximate (state at planning time); re-locate with grep if files
have drifted.

---

## §1 URL Contract for `/conversations`

### §1.1 Query parameters

| Param | Meaning | Example |
|---|---|---|
| `c` | Selected conversation id. Absent ⇒ auto-open behavior (§6.4). | `/conversations?c=abc123` |
| `project` + `session` | Entry-only pair: seed the rail's session filter (§6.6), then strip from the URL. Always used together. | `/conversations?project=my-app&session=fix-bug` |
| `autoFocus` | `true` ⇒ focus the prompt editor once on initial mount (same semantics as the old route's `?autoFocus=true`). Stripped on the next conversation switch. | `/conversations?c=abc123&autoFocus=true` |

All values are `encodeURIComponent`-encoded. Unknown params are preserved when rewriting the URL.

### §1.2 History semantics

- **Same-page conversation switch** (rail click, post-create/fork/reply open while on
  `/conversations`): `window.history.pushState` with the new `?c=`. Back/forward then walks
  through previously viewed conversations (Next.js `useSearchParams` reflects popstate
  automatically — no extra popstate listener may be added).
- **Auto-open and param cleanup** (filter seeding strip, `autoFocus` strip, fallback after the
  selected conversation disappears): `window.history.replaceState` — these must NOT create
  history entries.
- **Same-page switches must not trigger an App Router navigation.** `router.push`/`router.replace`
  are forbidden for selection changes on `/conversations` (they cause an RSC round trip). Only the
  native history API is allowed. Navigation INTO `/conversations` from other pages uses normal
  `<Link>`/`router.push`.

## §2 Conversation Lookup Endpoint

### §2.1 Route

`GET /api/conversations/[conversationId]` — thin route file at
`src/app/api/conversations/[conversationId]/route.ts` re-exporting a handler from
`src/lib/conversations/` (pattern per structure.md). Static siblings `/active` and `/all`
already exist and take precedence; do not touch them.

### §2.2 Behavior

- Resolves a **session-scoped** conversation by id alone, searching the same data source the
  `/api/conversations/all` handler uses (`src/lib/conversations/all-conversations-route-handlers.ts`).
  Reuse/extract that listing logic — do not duplicate it and do not add a broad `readState` scan
  (see PERFORMANCE.md: focused accessors).
- `200` with a body that is exactly one item of the `/api/conversations/all` items schema
  (reuse the existing Zod schema — includes `projectName`, `projectPath`, `sessionName`,
  `worktreePath`, `conversationId`, `conversationName`, `summary`, `firstPromptSnippet`,
  `backend`, `backendRef`, `transcriptPath`, `debugLogPath`, `status`, `lastActivityAt`,
  `archived`).
- Archived conversations ARE resolvable (deep links to archived conversations must render).
- `404` with `{ "error": "conversation_not_found" }` when no session-scoped conversation
  matches. Project-scoped conversations (sentinel session) are NOT resolvable here ⇒ 404.
- Structured logging via `createLogger` per `.kiro/steering/logs.md` (module naming + event
  conventions; log lookup misses at `warn` with the conversationId).

### §2.3 Client hook

`useConversationLookupQuery(conversationId: string | null)` in
`src/lib/conversations/queries.ts`, disabled when `conversationId` is null, with a key added to
the existing key factory in `src/lib/conversations/query-keys.ts`. 404 must surface as a
distinguishable "not found" state (not a generic error) so §6.5 can render the not-found panel.

## §3 Href Helpers

### §3.1 Builder (additive — `identity-foundation` context)

New module `src/lib/conversations/hrefs.ts`:

```ts
conversationsPageHref(opts: {
  conversationId?: string;
  projectName?: string;   // only together with sessionName
  sessionName?: string;
  autoFocus?: boolean;
}): string
```

- Produces `/conversations` URLs per §1.1 with proper encoding; omits absent params; plain
  `/conversations` when no opts.
- Also export a parse helper that maps a `URLSearchParams` to a typed
  `{ conversationId, sessionFilter: { projectName, sessionName } | null, autoFocus }` object —
  the page (§6) must use it rather than reading params ad hoc.
- Pure functions, unit-tested first (TDD). No React imports.

### §3.2 Flip (`link-migration` context)

`activeConversationHref` (`src/lib/active-conversations/row-helpers.ts:19-26`): the
`scope === "session"` branch returns `conversationsPageHref({ conversationId: row.id })`. The
project-scope branch (`/projects/{p}?focus={id}`) is unchanged.

## §4 ConversationWorkspace Component Contract

### §4.1 Interface

```ts
interface ConversationWorkspaceProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  defaultModel: string;
  defaultEffort?: EffortLevel;   // @/lib/agent-backends/schemas
  autoFocus?: boolean;
}
```

Extracted from the current `ConversationDetailPage`
(`src/features/session/SessionPage.tsx` — already prop-driven with exactly these props) into
`src/features/session/ConversationWorkspace.tsx`.

### §4.2 Boundaries

- Renders everything the old conversation detail page renders EXCEPT the
  `ConversationSidebar` rail and its collapse/expand affordances (currently rendered inside
  `SessionContent`, `src/features/session/conversation/SessionContent.tsx:110-128`): info strip,
  transcript panel + prompt input, right pane, banners, dialogs, mobile bottom bar / info panel,
  loading view.
- MUST NOT read route identity from `useParams`/`usePathname`/`useSearchParams` — identity comes
  only from props.
- Hosts mount it with `key={conversationId}`; per-conversation state may rely on remount for
  reset.
- Rail visibility state (desktop `sidebarCollapsed`, mobile sidebar open) is owned by the host
  shell. Coordinating through the existing `session-detail.store` is acceptable; the workspace
  may trigger toggles but must not render the rail.
- Existing post-action navigations that leave the conversation page entirely (e.g. session
  delete → project page) keep their current targets.
- The old route (`/projects/[name]/[session]/[conversationId]`) is recomposed as
  rail + `ConversationWorkspace` and must render **identically** to before (same DOM structure
  and CSS hooks: `main.main`, `data-with-sidebar`, `data-sidebar-collapsed`,
  `.session-detail-layout`, mobile panel behavior). This context changes structure, not
  behavior.

## §5 Sidebar Selection Seam

`ConversationSidebar` (`src/features/session/sidebar/ConversationSidebar.tsx`) gains an optional
prop:

```ts
onOpenConversation?: (target: {
  conversationId: string;
  projectName: string;
  sessionName: string;
}) => void;
```

- When provided, it is invoked INSTEAD of `router.push` for every session-scoped open: row click
  (`onNavigate`, ~line 576), open-after-create (~line 311), open-after-fork (~line 459),
  open-after-reply-from-peek (~line 981).
- When absent, behavior is exactly today's (`router.push` to `activeConversationHref(row)`),
  which is what the cockpit and (until deletion) the old route rely on.
- Project-scoped rows ALWAYS `router.push` to `/projects/{p}?focus={id}` regardless of the prop.
- Rows keep rendering real `<Link href>` anchors (from `activeConversationHref`) so middle-click
  / cmd-click open-in-new-tab still works; the callback intercepts plain left clicks only.

## §6 `/conversations` Page Behavior

### §6.1 Files

- `src/app/conversations/page.tsx` — server component: `await readConfig()` for
  `defaultModel`/`defaultEffort` (same as the old route file did), renders the client page.
  No other logic.
- Client page component in `src/features/session/` (e.g. `ConversationsPage.tsx` plus
  colocated hooks/styles per structure.md). It composes the rail + workspace with the same
  layout classes the old page used so existing CSS applies.

### §6.2 Selection resolution

- Parse params with the §3.1 helper. When `c` is present, resolve identity with
  `useConversationLookupQuery`; while loading show the existing loading treatment; on success
  mount `ConversationWorkspace` with `key={conversationId}` and the resolved
  `projectName`/`sessionName`.
- The rail stays mounted and interactive in ALL states (loading, not-found, empty).
- Rail highlight (`activeConversationId`) follows `?c=`.

### §6.3 Switching

- The page passes `onOpenConversation` (§5) to the rail; the handler does
  `history.pushState` per §1.2 — no remount of the page shell or rail may occur, only the
  workspace swaps.

### §6.4 Auto-open (no `c` param)

- After the active-conversations query (`useActiveConversationsQuery`) resolves: select the
  most recent (`lastActivityAt`) non-archived **session-scoped** row — restricted to the rail's
  session filter when one is active — and `replaceState` to `?c=<id>`.
- If no candidate exists: render the empty-state panel (rail + centered placeholder following
  the design system, e.g. "Select a conversation"). No crash, no redirect.

### §6.5 Not-found / disappearance

- Lookup 404 ⇒ not-found panel ("Conversation not found") with the rail usable. Do NOT
  auto-redirect away; the bad `c` stays until the user picks another conversation.
- If the currently open conversation is archived/deleted while open (it disappears from the
  rail's data), the page clears `c` via `replaceState` and re-enters §6.4. No crash.

### §6.6 Session-filter seeding

- On mount with `project`+`session` params: set the existing rail session filter
  (`sidebarSessionFilter` in `src/stores/session-detail.store.ts`) to that pair, then strip both
  params via `replaceState` (preserving `c`/`autoFocus`). The filter then lives purely in the
  store, clearable through the rail's existing UI.

### §6.7 autoFocus

- `autoFocus=true` is forwarded to the workspace for the initially opened conversation only,
  and stripped from the URL on the next switch (§1.1).

### §6.8 Testing

- Selection/auto-open/seeding logic must be extracted into pure helpers or a small hook with
  colocated unit tests (TDD); do not leave it implicit in JSX.

## §7 Link Migration & Deletion (final state)

After this context, **no code constructs `/projects/{project}/{session}/{conversationId}`
URLs.** Verify with greps at minimum: `grep -rn 'encodeURIComponent(sessionName)' src/`,
`grep -rn '/projects/\${' src/`, `grep -rn 'activeConversationHref' src/`.

### §7.1 Link sites to migrate (use §3.1/§3.2 helpers — never inline strings)

| Site | File (approx) | New target |
|---|---|---|
| Rail row hrefs + fallback push | via §3.2 flip | `/conversations?c=<id>` |
| Session list rows | `src/features/session/conversation/ConversationList.tsx:~384` | `conversationsPageHref({ conversationId })` |
| Sidebar open-after-create / fork / reply fallbacks | `ConversationSidebar.tsx` (§5 sites) | helper |
| Workflow collaboration rows with a conversationId | `ConversationSidebar.tsx:~918` | helper (rows without one keep `/workflow` link) |
| Create session modal | `src/features/project-detail/.../CreateSessionModal.tsx:~262` | helper, preserving its current autoFocus semantics |
| Session lifecycle focus | `src/features/session/hooks/use-session-lifecycle.ts:~117` | helper, preserving autoFocus |
| Focus initialization | `src/features/session/hooks/use-focus-initialization.ts:~88` | helper, preserving autoFocus |
| Anything else the greps surface (incl. server-side notification href builders, if any) | — | helper |

Update all tests asserting old URL shapes.

### §7.2 Deletion

- Delete `src/app/projects/[name]/[session]/[conversationId]/` (route dir).
- Remove code that becomes dead as a result (e.g. an old-route-only page wrapper), but do NOT
  delete `ConversationWorkspace` consumers' shared pieces or the session landing page
  (`/projects/[name]/[session]` stays — charter D5).

### §7.3 SessionRow button

`src/features/project-detail/components/SessionRow.tsx`: add a compact icon button/Link →
`conversationsPageHref({ projectName, sessionName })`. It must not hijack the row's existing
link to the session landing page (stopPropagation; keyboard accessible; `data-tooltip` per
design system).

## §8 Final Verification

1. **Wiring review** (code-level, with fresh greps): §7 final state holds; old route dir gone;
   `/conversations` page contains no `router.push`/`router.replace` in the same-page selection
   path (§1.2); every §6 state (selected / loading / not-found / empty / auto-open / filter
   seed) is reachable in code.
2. **Live smoke** (honest reporting — if a dev server cannot be started in this environment,
   say so explicitly; never fake results): start the dev server, then with Playwright:
   - Open `/conversations` → auto-opens most recent conversation, URL gains `?c=` without a
     history entry.
   - Tag the rail DOM node via JS property, click a different conversation row → URL `?c=`
     changes, transcript swaps, the tagged property is still present on the same node (shell
     not remounted), no document navigation occurred.
   - Browser back returns to the previous conversation.
   - Deep-link `/conversations?c=<known id>` directly → conversation renders.
   - Deep-link with unknown id → not-found panel, rail usable.
   - `/conversations?project=X&session=Y` → rail filtered, params stripped, most recent
     conversation in that session opened.
3. **PERFORMANCE.md entry**: symptom (full page remount on conversation switch) → root cause
   (App Router segment keyed by `[conversationId]` path param) → fix (single route + shallow
   history-API selection) → lesson.
4. **Report**: write `.cc/graph-workflow-docs/conversations-route-final-verification.md`
   summarizing checks, evidence, and any deferred items; add remediation tasks for real gaps
   instead of papering over them.
