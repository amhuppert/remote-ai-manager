# Gap Analysis: Roadmap Item Tracker

## Requirement-to-Asset Map

| Requirement | Existing Assets | Gap |
|---|---|---|
| **1. Data Model** | `schemas.ts` (Zod patterns), `projectStateSchema`, `conversationStateSchema` (archiving pattern) | **Missing** — No `roadmapItemSchema`, `ProjectState` has no `roadmapItems` field |
| **2. Adding Items** | `mutateState()` / `mutateSession()` mutex patterns in `state.ts`, `crypto.randomUUID()` for IDs | **Missing** — No `createRoadmapItem()` function, no API endpoint |
| **3. Removing Items** | `deleteSession()` pattern in `state.ts`, route patterns in `api/projects/[name]/sessions/` | **Missing** — No delete function or endpoint for roadmap items |
| **4. Status Tracking** | `setSessionArchived()`, `setConversationArchived()` toggle patterns | **Missing** — No status toggle for roadmap items |
| **5. Archiving** | `archived: z.boolean().default(false)` on conversations/sessions, `showArchived` Zustand toggle in `sessions.store.ts`, `useMemo` filtering in `SessionsList.tsx` | **Missing** — Same pattern needs to be applied to roadmap items |
| **6. List UI** | `SessionsList.tsx` (table layout, filtering, action buttons), `ProjectActionsBar.tsx`, `ConfirmDialog.tsx` | **Missing** — No `RoadmapItemsPanel` component |
| **7. Focus Transition** | `createSessionFocus(projectPath, objective)` in `sessions.ts`, `generateSessionName()`, `provisionSession()` with `mode: "focus"` | **Missing** — No integration to call `createSessionFocus` from a roadmap item |

## Implementation Approach: Option C (Hybrid) — Recommended

### Extend Existing
- **`src/lib/schemas.ts`** — Add `roadmapItemSchema`, update `projectStateSchema` with `roadmapItems` array
- **`src/lib/state.ts`** — Add roadmap CRUD mutations using existing `mutateState()` pattern
- **`src/lib/queries.ts`** — Add `useRoadmapItemsQuery()` following `useSessionsQuery()` pattern
- **`src/lib/query-keys.ts`** — Add `roadmapItemKeys` namespace
- **`src/lib/mutations.ts`** — Add create/update/delete/focus mutations
- **`src/types/index.ts`** — Re-export `RoadmapItem` type

### Create New
- **`src/app/api/projects/[name]/roadmap-items/route.ts`** — POST (create) + GET (list)
- **`src/app/api/projects/[name]/roadmap-items/[id]/route.ts`** — PATCH (update) + DELETE
- **`src/app/projects/[name]/RoadmapItemsPanel.tsx`** — List UI component (colocated with project page)
- **`src/stores/roadmap-items.store.ts`** — Zustand store for UI state (showArchived toggle, editing)

### Integration Points
- **`SessionsList.tsx`** — Render `RoadmapItemsPanel` on the project page
- **`createSessionFocus()`** — Called from Focus transition with item title+description as objective

## Trade-offs

| Approach | Pros | Cons |
|---|---|---|
| **Extend existing files** (schemas, state, queries, mutations) | Leverages proven patterns; minimal discovery cost | Increases file size of `schemas.ts` and `mutations.ts` |
| **New API routes + UI component** | Clean separation; roadmap is a distinct domain | More files to navigate |
| **Hybrid** | Best of both — reuses infrastructure, isolates new UI logic | Slightly more planning needed |

## Effort & Risk

**Effort: S (1–3 days)** — Straightforward CRUD extending well-established patterns. Schema, state mutations, API routes, queries/mutations, and UI all follow existing templates exactly.

**Risk: Low** — Familiar tech (Zod, Next.js API routes, TanStack Query, Zustand), no architectural changes, no external integrations, no performance concerns. Focus mode transition reuses existing `createSessionFocus()` directly.

## Recommendations for Design Phase

### Preferred Approach
Hybrid — extend shared infrastructure files (schemas, state, queries, mutations), create new API routes and UI component.

### Key Decisions for Design
1. **Storage location** — `ProjectState.roadmapItems: RoadmapItem[]` in state.json (per-project, inline with sessions)
2. **UI placement** — Collapsible panel on the project page, above or alongside the sessions table
3. **Focus transition flow** — Combine `title + "\n\n" + description` as objective, call `createSessionFocus()`, mark item as done, navigate to new session

### Research Items
None — all integration points are well-understood and follow existing patterns.
