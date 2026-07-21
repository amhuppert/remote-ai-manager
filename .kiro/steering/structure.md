# Project Structure

App Router routing layer is **isolated** in `src/app/`. All page-level UI lives in `src/features/`. All domain/business/server logic lives in `src/lib/<domain>/`. Colocation applies fully outside `src/app/`.

## Directories

| Directory | Purpose | Pattern |
|---|---|---|
| `src/app/**/{page,layout,loading,error,not-found,route,template,default}.{tsx,ts}` | Next.js App Router shells ONLY. Each file is a thin re-export (two grandfathered exceptions — see "Grandfathered exceptions"). | No domain code, no helpers, no inline components. |
| `src/features/<feature>/` | Page-level UI for one route or sub-route. Owns its components, hooks, CSS, dialogs, and tests. | Files inside a feature MUST NOT be imported from another feature — promote to `src/components/` instead. |
| `src/features/_root/` | Layout + global styles (tokens, reset, typography, shell, topbar; plus session/conversation/prompt/sidebar/dialogs styles that are consumed across multiple features). Leading underscore = not a route. | Imported by `src/app/layout.tsx` and `src/app/globals.css`. |
| `src/components/` | Cross-feature shared UI. | Promote here only when reused by ≥2 features. |
| `src/hooks/` | Cross-feature shared hooks. | Promote here only when reused by ≥2 features. |
| `src/stores/` | Zustand stores. | One per concern; Immer middleware (`*.store.ts`). |
| `src/lib/<domain>/` | Business logic, server actions, route handlers, queries, mutations, schemas for one domain. | Each domain owns `schemas.ts`, `route-handlers.ts`, `service.ts` (or split), `queries.ts`, `mutations.ts`, `query-keys.ts`, tests. |
| `src/lib/api/` | Shared React Query / fetch plumbing only (`fetcher.ts`, `errors.ts`, `sse-events.ts`). No domain code. | Per-domain queries/mutations live in `src/lib/<domain>/`. |

## Routing & Domain Boundary (the Next.js exception)

Colocation applies fully **outside** `src/app/`. Inside `src/app/`, the Next.js App Router convention dictates layout, so route files stay where Next.js requires them, but they hold no logic:

- `src/app/<route>/page.tsx` — `export { default } from "@/features/<feature>/<Feature>Page";`
- `src/app/api/<resource>/route.ts` — `export { GET, POST, PUT, DELETE } from "@/lib/<domain>/route-handlers";`
- `src/app/layout.tsx` — re-exports `RootLayout` from `@/features/_root/RootLayout`.

No other code in `src/app/` (two grandfathered exceptions below). CSS imports in `globals.css` chain through `@/features/_root/styles/index.css`.

### Route resolution

- Nested API addressing composes `RouteResolution<T>` from `src/lib/shared/route-resolution.ts`. A resolution step returns either the resolved value or one already-formed HTTP error response.
- Shared project lookup lives in the shared resolver; each domain owns a small route adapter for its addressing shape (conversation, project conversation, ticket, or a future domain).
- Route handlers compose those adapters and return early on failure. Use the shared `jsonError`/`notFound` response helpers; do not rebuild project/session/entity 404 ladders or define another result union.
- A `202` response must not await the work it accepts: it returns once intent is recorded and the work is initiated, never after the work completes. Work expected to exceed ~1s runs as a job that reports progress over SSE, so the handler stays off the request's critical path. The dev-server start route is the reference — it returns at the durable-acceptance boundary (intent recorded + spawn initiated) while readiness propagates later through `dev-server-status` events.

### Grandfathered exceptions

Two files predate the thin re-export rule and still hold real logic. Relocating them into `src/features/` is scheduled program work; until then they are the complete exception list — the rule applies to every new file under `src/app/`, and these are not precedent:

- `src/app/projects/[name]/[session]/conflicts/page.tsx` — a full client page (queries, mutations, local state, rendering).
- `src/app/workflows/[machine]/page.tsx` — param validation (`isMachineId` → `notFound()`) and derived sibling props.

## Schemas

- Each domain owns `src/lib/<domain>/schemas.ts` (Zod schemas + `z.infer` types).
- No central `src/lib/schemas.ts`, no central `src/types/index.ts`.
- Cross-domain shared primitives (rare) live in `src/lib/shared/schemas.ts`.

## React Query

- Shared plumbing in `src/lib/api/` (`fetcher.ts`, `errors.ts`, `sse-events.ts`).
- Per-domain query/mutation/key factories in `src/lib/<domain>/{queries,mutations,query-keys}.ts`.

## Naming

- React components: PascalCase (`ProjectCard.tsx`), default export, named by function.
- Lib modules: kebab-case (`project-resolver.ts`). When a module moves into its domain folder, strip the redundant domain prefix (`session-repo.ts` → `src/lib/sessions/repo.ts`).
- Types/Interfaces: PascalCase.
- Schemas: camelCase + `Schema` suffix (`sessionStateSchema`).
- Tests: `.test.ts`/`.test.tsx` colocated with source.
- Styling: Tailwind v4 utility-first classNames + the `ui/` primitives (`src/components/ui/`) + `cn()` — author new UI with utilities, not new stylesheets (the `no-unapproved-global-css` guardrail rejects new global CSS). Tone-coded status/lifecycle pills use `ui/StatusChip`; do not hand-author its geometry. Custom tokens live in `src/features/_root/styles/theme.css` (`@theme`, the single source of truth); author with the Tailwind utilities, not raw `var(--…)` names. Existing `src/features/<feature>/styles/*.css` are grandfathered legacy/preserved CSS (kebab-case BEM, e.g. `project-card-header`); foundation tokens + reset live in `src/features/_root/styles/`. See `docs/tailwind-conventions.md`.

## Imports

```typescript
import { readFile } from "node:fs/promises";              // Node built-ins
import { z } from "zod";                                   // External
import type { SessionState } from "@/lib/sessions/schemas";// Internal absolute (@/ = ./src/)
import { someHelper } from "./helper";                     // Relative same-dir
```

## Principles

- **Schema-first** — Zod schemas define entities; never hand-write duplicate types.
- **Colocation outside `src/app/`** — components, hooks, CSS, tests live next to the code that uses them.
- **No barrel re-exports for backward compatibility.** Direct importers are updated when files move.
- **API mirrors resources** — `/api/projects/[name]/sessions/[session]/prompt` maps to `src/lib/prompt/route-handlers.ts`.
- **Depth over line count** — a module earns its size by concentrating knowledge: it hides a named design decision and passes the deletion test (removing it would respread complexity into its callers, not just vanish). Split by knowledge boundaries — when a file mixes decisions that different callers care about — never mechanically on line count. A large module that hides one substantial decision and improves locality stays whole; a small module that hides nothing is still too shallow.
