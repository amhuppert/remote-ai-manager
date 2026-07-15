# Activity Panel Rework — Locked Design

**Status:** Implemented; retained as the decision record for the app-wide conversations sidebar and bounded Active Work surface.

Full design rationale and negotiation history: `memory-bank/collaboration/bb7eb154-8f40-447d-9aca-04e30968ed84/round-1/agent_one/final_answer/answer.md`. This document is the implementation-facing spec, updated with Alex's gate decisions (2026-07-11).

## Locked decisions

1. **Inline bounded Active Work section** in the conversations sidebar (not tabs).
2. **The conversations sidebar goes app-wide.** Page layouts are refactored so the sidebar (with Active Work) is present on: the projects page, the session page, the graph workflow builder pages, and the workflow execution page. It is NOT shown on the settings page or the workflow diagrams pages.
3. **Keep the minimal exceptions-only Attention surface** (unresolved count, dismiss-only, no read state).

## Scope changes caused by decision 2

- **Topbar Active Work chip + popover: cut.** Its purpose was ambient visibility on pages without the sidebar; those are now only settings and workflow diagrams, where job monitoring is not needed. Push notifications still cover exceptional events everywhere.
- **Topbar Attention indicator: cut from v1.** Attention renders as a pinned group in the (now app-wide) sidebar. The existing amber "Needs You" topbar badge stays as-is.
- **Tabs+mini-strip fallback: cut** (decision 1 made it moot).
- **Drawer-removal ordering concern dissolves** once the sidebar is global — but the drawer still goes last in the rollout.

## Product boundary

| Concept | Meaning | Lifecycle |
|---|---|---|
| **Active Work** | Live or concretely actionable operations (jobs, graph workflows, collaborations) | Enters on start; leaves on terminal state or after the action is taken |
| **Attention** | Missed exceptional events with no durable recovery state elsewhere (non-resumable failures) | Unresolved until resolved or explicitly dismissed; count = unresolved, never "unread" |
| **History** | Audit trail (`job_records`) | Owning session/job surfaces; out of the primary UI |

## Active Work section (sidebar)

- Sits between the sidebar controls and the conversation groups; replaces the existing Graph Workflows and Collaborations strips.
- Auto-hides when empty. Ambient summary shows **max 3 rows**, needs-action items first, then running; within each group sorted oldest-first (stable — rows don't jump as new work arrives). Always shows the true total with a `Show all N` affordance that expands the full list in place; `Show less` collapses. No nested scroll region.
- Row contract: what (title carries the operation type), where (project / session), current phase ("Validating…", "Resolving conflicts", "4/7"), and — only when actionable — an inline action (`Land`, `Resolve`, `Resume`, `Respond`) in the amber waiting-on-you recipe.
- Excluded from conversation search and the All/Needs/Run/Session filters.
- **Attention group** renders below Active Work when unresolved exceptions exist: red-toned rows (title + detail), explicit dismiss (✕), click navigates to the owning context.
- Terminal lifecycle: success → toast + row removal (no acknowledgment); actionable states stay pinned until acted on; non-resumable failures move to Attention.

## Presentation architecture

`ActiveWorkItem` is a **presentation-only** discriminated view model (`kind: "job" | "workflow" | "collab"`) produced by pure per-source adapters from the existing schemas (`BackgroundJob`, `ActiveGraphWorkflowExecution`, `ActiveCollaborationExecution`). Source schemas stay authoritative. Data sources already exist: `/api/conversations/active` (workflows + collabs) and the `job-status` SSE stream feeding `notification.store.ts`. Pinned actionable terminals need a durable source (job store currently drops terminal jobs immediately) — addressed in rollout step 5, not assumed free.

## Sidebar globalization (decision 2)

Current state: the sidebar is mounted on `/conversations` (page-level grid via `.main[data-with-sidebar="on"]`, `data-page="detail"`) and embedded in `/projects/[name]`'s ProjectCockpit rail. Mechanism: generalize the existing grid pattern rather than inventing a new shell — each included page renders `<ConversationSidebar>` as the first `.main` grid column, with `data-with-sidebar="on"` no longer scoped to `data-page="detail"` only.

| Route | Today | Target |
|---|---|---|
| `/conversations` | Sidebar (page grid) | Unchanged |
| `/projects/[name]` (project detail) | Sidebar embedded in cockpit rail | Unchanged (already present) |
| `/projects` (projects index) | No sidebar | **Add** |
| `/projects/[name]/[session]` (session page) | No sidebar | **Add** |
| `/projects/[name]/workflows` + `/templates` (workflow builder) | 3-column builder layout (240px defs / canvas / 500px inspector) | **Add**; see collision note |
| `/projects/[name]/[session]/workflow` (execution page) | Full-bleed graph + 500px right inspector | **Add**; see collision note |
| `/config` (settings) | No sidebar | **Excluded** (decision 2) |
| `/workflows`, `/workflows/[machine]` (workflow diagrams) | No sidebar | **Excluded** (decision 2) |
| `/projects/[name]/[session]/{diff,conflicts,templates}` | No sidebar | Not in v1 scope (unmentioned in decision 2; revisit after v1) |

Notes:

- **Collapse state stays global** (existing `useSidebarCollapsed` persisted store, `Mod+\` everywhere). On the builder and execution pages — which already have right-side inspectors at 500px/420px — the rail plus inspector compresses the canvas below ~1440px viewports; the rail is collapsible to 0 and the collapse preference persists, which is the v1 mitigation. Per-page collapse defaults are a follow-up if this proves annoying in practice.
- **Navigation semantics on non-conversations pages:** unchanged from the sidebar's existing behavior — session-scoped rows open the peek popover in place; "Open conversation" navigates to `/conversations?c=…`; workflow/collab/job rows navigate to their owning context.
- The sidebar's host-configuration props (`showNewConversationButton`, `showCollapseControl`, `enableSearchHotkey`, `onOpenConversation`) already support embedding variance; new host pages use the defaults unless a conflict exists.

## Removal list (unchanged from the negotiated design)

Activity drawer + backdrop (`NotificationsPanel.tsx`, `NotificationsPanelContainer.tsx`), `unified-panel.store.ts`, `GlobalActivePanelHotkey` (Shift+B rebinds or retires), the topbar hamburger + combined `unreadCount + activeJobs` badge, mark-as-read / mark-all-read mutations and routes' UI consumers, and the sidebar's special-cased workflow/collab strips. Notification creation + push dispatch stay untouched in v1; backend slimming is a separate later assessment.

## Rollout

1. **Storybook prototype + Alex approval** — ActiveWorkSection stories (empty/hidden, single running, mixed sources, needs-action variants, overflow 4 & 8, focused Show-all, Attention group, long labels, in-sidebar placement). No integration before approval.
2. Presentation model — per-source adapters (pure, tested) + section/row components finalized.
3. Sidebar integration — Active Work section replaces the workflow/collab strips on the existing sidebar surfaces (`/conversations`, project detail).
4. Sidebar globalization — layout refactor for projects index, session page, builder, execution pages per the table above.
5. Terminal lifecycle — durable source for pinned actionable terminals; Attention persistence semantics (dismiss-only); success toasts.
6. Retire the drawer — delete panel/store/badge/read-UI, rebind Shift+B.
7. Optional: notification-persistence cleanup assessment.
