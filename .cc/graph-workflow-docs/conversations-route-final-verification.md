# Final Verification: /conversations Route Rework

Execution of contracts §8 (final-verification context). Date: 2026-06-12.

## 1. Wiring review (§8.1) — PASS, no gaps

All checks performed with fresh greps and file reads against the merged tree
(branch `csm/rework-the-conversation-page-418ab4-identity-foundation`, HEAD `04b6fb89`).

### §7 final state

- `grep -rn 'encodeURIComponent(sessionName)' src/`, `grep -rn '/projects/\${' src/`,
  `grep -rn 'activeConversationHref' src/`: zero old-shape
  `/projects/{project}/{session}/{conversationId}` page-URL constructions remain. Surviving
  `/projects/...` template literals are session-landing breadcrumbs/links, diff/conflicts/workflow
  subroute links, and `/api/...` endpoint paths — all out of scope by charter D5/D7.
- The only non-API page-URL builders left in `src/lib/` are the two project-scope
  `?focus=` builders (`src/lib/active-conversations/row-helpers.ts:24`,
  `src/lib/project-conversations-client/routes.ts:5`) — correct per charter D8.
- Old route dir `src/app/projects/[name]/[session]/[conversationId]/` is **deleted**; the
  session landing `page.tsx` and `diff/`, `conflicts/`, `workflow/` subroutes are intact (D5, D7).

### §1.2 history semantics

- The entire same-page selection path lives in
  `src/features/session/hooks/use-conversations-page-selection.ts`: `pushState` for switches,
  `replaceState` for auto-open, seeding strip, autoFocus strip, and disappearance fallback —
  URL strings built by the pure helpers in `src/features/session/conversations-page-state.ts`.
- No `router.push`/`router.replace` anywhere in that path; no `popstate` listener anywhere in
  `src/features/session/` or `src/lib/conversations/`.
- `ConversationWorkspace`'s `useRouter` is used only for leave-page navigations (session delete →
  project page). Workspace-originated switches (fork: `use-session-handlers.ts:114`,
  focus-initialization finalize: `use-focus-initialization.ts:96`) route through the
  `onOpenConversation` seam when provided, falling back to `router.push(conversationsPageHref(...))`.

### §6 state reachability

All states are decided by the pure `resolveConversationsRenderState`
(`conversations-page-state.ts:31`) and rendered in `ConversationsPage.tsx`'s `renderPanel`:
`workspace` (lookup success → `ConversationWorkspace` with `key={conversationId}`), `loading`,
`not-found` (lookup 404 → `data === null`), `error`, `empty`. Auto-open candidate selection
(`selectAutoOpenCandidate`: session-scoped, filter-restricted, most recent `lastActivityAt`) and
§6.6 seeding (store filter + rail list-filter switched to "session" + `replaceState` strip) are
unit-tested pure helpers. The rail stays mounted in every state.

### §2 endpoint

- Thin route file `src/app/api/conversations/[conversationId]/route.ts` re-exports the
  DI-factory handler in `src/lib/conversations/conversation-lookup-route-handlers.ts`.
- Resolution reuses the focused `findConversationById` in
  `src/lib/conversations/cross-project-list.ts` (same data source as `/api/conversations/all`,
  no broad `readState` scan). Archived conversations resolvable; project-scoped conversations
  never found ⇒ 404 `{"error":"conversation_not_found"}`.
- Structured logging via `createLogger`: `conversation.lookup.hit` (info),
  `conversation.lookup.miss` (warn, with conversationId), `conversation.lookup.failed` (error).
- Client hook `useConversationLookupQuery` (`src/lib/conversations/queries.ts:36`) disabled on
  null id, key in the existing factory (`query-keys.ts:11`), 404 surfaced as a distinguishable
  `data === null` not-found state.

### §3 href helpers

`src/lib/conversations/hrefs.ts`: pure `conversationsPageHref` (encodes, omits absent params,
lone project/session half omitted, plain `/conversations` with no opts) and
`parseConversationsPageParams`; colocated unit tests. §3.2 flip in place: the session branch of
`activeConversationHref` returns `conversationsPageHref({ conversationId: row.id })`; the
project-scope branch unchanged.

### §4 workspace boundaries

`ConversationWorkspace` is fully prop-driven (`projectName`, `sessionName`, `conversationId`,
`defaultModel`, `defaultEffort`, `autoFocus`, plus the `onOpenConversation` seam). Zero
`useParams`/`usePathname`/`useSearchParams` in the workspace subtree (verified by grep over the
workspace, its view, `conversation/`, and the page-handler/lifecycle/focus hooks). Hosts mount
with `key={conversationId}`. The rail and its collapse affordances are owned by the host shell
(`ConversationsPage` renders `main.main` with `data-with-sidebar`/`data-sidebar-collapsed` and
the expand float).

### §5 sidebar seam

Optional `onOpenConversation` on `ConversationSidebar`; `openSessionScopedConversation`
(`ConversationSidebar.tsx:210-226`) invokes it instead of `router.push` for every session-scoped
open: row navigate (~line 622), context-menu "Open conversation" (~line 747), open-after-create
(~line 344), open-after-fork-from-peek (~line 502), peek open-full (~line 1049). Project-scoped
rows always `router.push`. Rows render real `<Link href>` anchors from `activeConversationHref`
and intercept plain left clicks only — after the fix below, `ConversationSidebarRow.tsx:198-210`
lets non-primary and modifier clicks fall through to the native anchor before any other branch
runs. Prop-absent fallback is today's
`router.push(href)` — which, post-flip, navigates the cockpit rail to `/conversations?c=<id>`.

**Gap found and fixed (context-validation follow-up):** the row's `handleClick` originally
checked the current-row and session-peek branches *before* the modifier/non-primary guard, so a
cmd/ctrl/shift/alt-click on a session row (where `onPeek` is always provided) or on the current
row called `preventDefault()` and opened the peek instead of letting the real `<Link href>`
open in a new tab — violating §5's "callback intercepts plain left clicks only". Fixed
trivially in-scope by moving the modifier/non-primary guard to the top of `handleClick`
(`ConversationSidebarRow.tsx:198-219`). TDD: two failing tests written first
("lets modifier-clicks on session rows fall through to the anchor instead of opening the peek",
"lets modifier-clicks on the current row fall through to the anchor"), confirmed red, then the
reorder made them green. Full sidebar suite 124/124 green; typecheck clean; lint 0 errors.
Plain-left-click behavior (peek on session rows, no-op on current row, `onClick` otherwise) is
unchanged, so the live-smoke evidence below remains valid.

### Charter D1–D8

| D | Status |
|---|---|
| D1 ?c= + native history API, refresh/back/deep-link restore | HOLDS (code + live) |
| D2 old route deleted, no shims, all link sites migrated | HOLDS |
| D3 workspace swaps as one component, rail/shell stay mounted | HOLDS (live-verified, tagged DOM node) |
| D4 new page shares existing components, cockpit untouched | HOLDS (cockpit change limited to SessionRow button per D5) |
| D5 session landing stays, rows → new URL, SessionRow quick-link | HOLDS (`SessionRow.tsx:144` icon Link, stopPropagation, aria-label, data-tooltip) |
| D6 auto-open most recent, empty-state fallback | HOLDS (code + live) |
| D7 diff/conflicts/workflow untouched | HOLDS |
| D8 project-scoped → `/projects/{p}?focus=`, never on /conversations | HOLDS (sidebar always router.push for project rows; lookup 404s sentinel-session conversations) |

### Gates

- `bun run typecheck` — clean.
- `bun run lint` — 0 errors (87 pre-existing warnings).
- `bun run test` (full suite) — **624 files passed | 3 skipped; 7,629 tests passed | 13 skipped | 1 todo; 0 failures** (206 s).

No remediation tasks needed.

## 2. Live smoke (§8.2) — PASS, all six scenarios

### Environment (honest reporting)

The CC-managed dev server for this session runs in the session **root** worktree
(`.worktrees/rework-the-conversation-page-418ab4`), which contains only the charter commit —
not this workflow's implementation. Testing against it would have exercised the old code, so a
dev server was started **in this context worktree** instead (`PORT=3133 bun run dev`), with the
worktree-local config dir (`CC_CONFIG_DIR=$PWD/.config`) per the cc-live-feature-test skill —
an isolated fresh SQLite DB, never the production config dir.

Data was seeded through the **production write path** (a throwaway `tsx` script using the real
`projects`/`sessions`/`conversations` repos over `getDb()`): scratch git repo
`.cc/smoke-scratch/smoke-rocket` with a real `csm/smoke-session` worktree, one session, three
session-scoped conversations (Alpha `lastActivityAt` 12:00Z, Beta 11:00Z, Gamma 10:30Z) with
real transcript JSONL files containing unique markers (`ALPHA-MARKER-7421`, `BETA-MARKER-9952`,
`GAMMA-MARKER-3318`). `.config/config.json` pointed `baseDir` at the scratch dir so the project
resolver could resolve `smoke-rocket`. No real LLM turns were needed — every §8.2 scenario is
about routing/remount/URL semantics, which transcripts on disk fully exercise.

Browser driven via `playwright-cli` (session `ccsmoke`, Chrome). All evidence below is from
`eval` against the live page plus server-side NDJSON logs (`.config/logs/global.log`).

### Scenarios

1. **Auto-open with replaceState** — `goto /conversations` → URL became
   `/conversations?c=smoke-conv-alpha` (most recent) with `history.length` unchanged by the
   rewrite (no history entry added); workspace rendered the Alpha transcript
   (`ALPHA-MARKER-7421` present). PASS.
2. **No-remount switch via tagged DOM node** — tagged the rail container
   (`.convo-sidebar`) with `el.__smokeTag = 'rail-tag-12345'` and `window.__smokeNav`.
   Opened Beta through the rail (row click opens the peek preview by design; its
   "Open conversation" button drives the same `openSessionScopedConversation` →
   `onOpenConversation` seam). Result:
   `{url: "...?c=smoke-conv-beta", histLen: 3→4 (exactly one pushState entry),
   railTagSurvives: true, windowTagSurvives: true, wsHasBeta: true, wsHasAlpha: false}` —
   URL changed, transcript swapped, the tagged property survives on the **same** rail node
   (shell/rail not remounted), `window` property survives (no document navigation). PASS.
3. **Browser back** — `go-back` returned to `?c=smoke-conv-alpha`, Alpha transcript restored,
   both tags still present (popstate handled client-side via `useSearchParams`, no document
   navigation, no custom popstate listener). PASS.
4. **Deep-link known id** — fresh `goto /conversations?c=smoke-conv-gamma` rendered the Gamma
   conversation (`GAMMA-MARKER-3318` in the workspace). PASS.
5. **Deep-link unknown id** — `goto /conversations?c=no-such-conversation-999` rendered the
   "Conversation not found" panel; the bad `c` stayed in the URL (no auto-redirect); the rail
   remained fully usable (3 rows; opening Beta from the rail switched to
   `?c=smoke-conv-beta`). Server logged `conversation.lookup.miss` at **warn** with the id. PASS.
6. **Filter seeding** — `goto /conversations?project=smoke-rocket&session=smoke-session` →
   URL ended as `/conversations?c=smoke-conv-alpha` (params stripped via replaceState, most
   recent in-session conversation auto-opened) and the rail's **Session** list-filter tab was
   selected (filter live in the store, clearable through the rail UI). PASS.

### Backend evidence

`.config/logs/global.log` (worktree-local dev instance) shows the lookup endpoint serving every
scenario: `conversation.lookup.hit` (info) for `smoke-conv-alpha`/`-beta`/`-gamma` with traceIds,
and `conversation.lookup.miss` (warn) for `no-such-conversation-999`. Direct API checks:
`GET /api/conversations/smoke-conv-alpha` → 200 with the full `/all`-items-schema body;
`GET /api/conversations/does-not-exist` → 404 `{"error":"conversation_not_found"}`;
`GET /api/conversations/active` → the three seeded rows ordered by `lastActivityAt`.

### Cleanup

Playwright session closed; smoke dev server stopped; `.cc/smoke-scratch/` (scratch repo + seed
script) and `.config/` (isolated dev DB/logs/transcripts) deleted. Nothing was committed from
the smoke environment.

## 3. PERFORMANCE.md entry (§8.3) — DONE

Added "2026-06-12 — Switching conversations remounted the entire page subtree" at the top of
Resolved issues, in the file's symptom → root cause → fix → lesson format, citing the live
no-remount evidence and the lesson that a dynamic route param is a remount boundary.

## 4. Deferred / notes

- **Stale notification hrefs**: old conversation URLs stored in historical notification rows
  will 404. Accepted by charter D2; no migration performed (out of scope §6).
- **Rail row click opens the peek preview** (with navigation via the peek's "Open conversation"
  or the context menu) — this is the rail's designed behavior for plain left clicks
  (`ConversationSidebarRow.tsx:217-220`), identical on the cockpit; not a regression of this
  rework.
- **§5 modifier-click gap (found in context validation, now fixed)**: the original `handleClick`
  ordering ran the current-row and peek branches before the modifier guard, so cmd/ctrl/shift/
  alt-clicks on session rows opened the peek instead of the native anchor. Fixed by reordering
  the guard to the top (see §1, "Gap found and fixed"); pinned by two new unit tests in
  `ConversationSidebarRow.test.tsx`. Middle-click was unaffected throughout (it fires `auxclick`,
  not `click`, so it always reached the native anchor).
- **Console 404s during the first smoke attempt** were a seeding-environment artifact (project
  resolver needs `baseDir` to cover the scratch project) — resolved by the smoke `config.json`;
  not a product issue.
- No remediation tasks were filed: the one real gap (§5 modifier-click) was trivially in-scope
  and fixed directly; the wiring review and all six live scenarios otherwise passed.
