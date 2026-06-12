# Charter: /conversations Route Rework

This document is the foundational charter for the "conversations route rework" graph workflow.
Every execution context MUST read this charter and the companion contract document
(`.cc/graph-workflow-docs/conversations-route-contracts.md`) before writing any code.
The contracts document is the single source of truth for acceptance criteria details;
acceptance criteria on execution contexts reference its numbered sections (§).

## 1. Objective

Replace the per-conversation route `/projects/[name]/[session]/[conversationId]` with a single
global `/conversations` page where the selected conversation is a shallow query parameter
(`/conversations?c=<conversationId>`).

**Why:** Next.js App Router keys each route segment by its dynamic param values, so navigating
from one conversation to another remounts the entire page subtree — the active-conversations
rail, all stores wiring, SSE-driven queries, and layout re-initialize on every switch. Switching
conversations should only swap the conversation-scoped workspace while the page shell and rail
stay mounted.

**Strategic driver:** planned future work adds a split-screen view showing multiple conversations
at once. That requires a self-contained, prop-parameterized "conversation workspace" component
that can be mounted N times side by side, and a URL scheme not built around a single
conversation id path segment. The split-screen feature itself is OUT OF SCOPE here; this rework
only makes it structurally possible.

## 2. Decisions (resolved with Alex — do not relitigate)

| # | Decision |
|---|----------|
| D1 | Selected conversation is reflected as `/conversations?c=<id>`, updated with the native `window.history.pushState`/`replaceState` API (shallow — NO App Router navigation for same-page switches). Refresh, back/forward, and deep links restore the open conversation. |
| D2 | The old per-conversation route `/projects/[name]/[session]/[conversationId]` is **deleted**. No redirect shims, no backward compatibility. Every link/`router.push` site is updated to the new URL. Stale `href`s stored in old notification rows will 404; this is accepted. |
| D3 | Switching conversations swaps ALL conversation-scoped panels (transcript, info strip, right pane, prompt input, dialogs) as one self-contained `ConversationWorkspace` component. The rail and page shell stay mounted. |
| D4 | `/conversations` is a new page that shares existing components (ConversationSidebar, conversation panel, prompt composer). The project cockpit (`/projects/[name]`) is untouched. |
| D5 | The session landing page `/projects/[name]/[session]` (conversation list) **stays**; its rows link to the new URL. Session rows in the project cockpit get an easy-access button linking to `/conversations` with that session's rail filter pre-applied. |
| D6 | With no `?c=` param, `/conversations` auto-opens the most recently active conversation (URL synced via `replaceState`), falling back to an empty-state panel if none exist. |
| D7 | Session subroutes (`/projects/[name]/[session]/{diff,conflicts,workflow}`) are untouched. |
| D8 | Project-scoped conversations (sentinel session `__project__`) continue to open in the project cockpit via `/projects/[name]?focus=<id>`. They never open on `/conversations`. |

## 3. Architecture Overview

```
src/app/conversations/page.tsx        (server: reads config defaults, renders client page)
  └─ ConversationsPage (client, in src/features/session/)
       ├─ ConversationSidebar          (rail — persistent across switches)
       └─ ConversationWorkspace        (key={conversationId} — swaps per selection)
            ├─ SessionInfoStrip
            ├─ ConversationPanelContainer (transcript + prompt input slot)
            ├─ RightPane (diff/docs/specs)
            ├─ dialogs / mobile panels
```

- **URL is the source of truth for selection.** The page reads `?c=` via `useSearchParams`
  (which reflects native history API updates in Next.js). No new Zustand store for selection.
- **Same-page switches** use `window.history.pushState` (rail click) / `replaceState`
  (auto-open, param cleanup). Navigation INTO the page from elsewhere uses normal
  `<Link>`/`router.push` with the shared href builder.
- **Identity resolution:** the URL carries only the conversation id; a new lookup endpoint
  `GET /api/conversations/[conversationId]` resolves `projectName`/`sessionName` (contracts §2).
- The feature code for the new page lives in `src/features/session/` — that feature dir already
  owns multiple routes (conversation detail, session list, diff, conflicts, workflow), so this
  adds no new cross-feature imports.

## 4. Execution Contexts & Ownership

| Context | Owns (write surface) | Contracts |
|---|---|---|
| `identity-foundation` | New lookup endpoint + service fn, `src/lib/conversations/hrefs.ts` href/param helpers, lookup query hook + query keys. **Purely additive — changes no existing behavior.** | §1.1, §2, §3.1 |
| `workspace-extraction` | Refactor `src/features/session/` page composition: extract `ConversationWorkspace`, lift rail to shell, add sidebar `onOpenConversation` seam. **Old route keeps rendering identically.** | §4, §5 |
| `conversations-page` | `src/app/conversations/page.tsx` + `ConversationsPage` client component, selection mechanics, auto-open, empty/not-found states, filter seeding. | §1, §6 |
| `link-migration` | Flip `activeConversationHref`, migrate all link sites, delete old route, SessionRow filter button. | §3.2, §7 |
| `final-verification` | End-to-end wiring review, live smoke verification, PERFORMANCE.md entry, final report. May add remediation tasks. | §8 |

Do not write outside your context's surface. If a contract seems wrong or impossible, say so in
your output rather than silently deviating; the contracts document wins over any other
assumption.

## 5. Engineering Ground Rules

- Follow the steering docs (auto-loaded via CLAUDE.md): `engineering-principles.md`,
  `structure.md`, `tech.md`. Read `.kiro/steering/logs.md` before adding server-side code
  (structured logging via `createLogger` is required on new route handlers/services).
- Red-green TDD: failing test first, then implementation. Extract pure functions so logic is
  testable without mocking. Never `vi.mock()` internal modules — use the DI patterns from
  engineering-principles.md.
- Type safety: Zod schema first, `z.infer` types, no `any`, no `@ts-expect-error`.
- Read `PERFORMANCE.md` before touching state-store accessors or per-request handlers.
- UI work (empty state, SessionRow button) must follow the design system:
  `.claude/skills/cc-design-system/SKILL.md`.
- Comments policy per CLAUDE.md: no temporal/refactoring comments; the code describes its
  current state only.
- Local verification: `bun run typecheck`, `bun run lint`, `bun run test` (scoped to touched
  files while iterating; the final context runs the full pre-merge validation).

## 6. Out of Scope

- Split-screen / multi-workspace rendering (this rework only enables it).
- Any cockpit (`/projects/[name]`) behavior change beyond the SessionRow button.
- Session subroutes: diff, conflicts, workflow pages.
- Redirects or any backward compatibility for old conversation URLs.
- Migrating stored notification `href` data.
- Promoting `ConversationSidebar` to `src/components/` (the cockpit's existing cross-feature
  import predates this work and stays as-is).
