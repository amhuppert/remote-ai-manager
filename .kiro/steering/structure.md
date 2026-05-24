# Project Structure

App Router routing layer is **isolated** in `src/app/`. All page-level UI lives in `src/features/`. All domain/business/server logic lives in `src/lib/<domain>/`. Colocation applies fully outside `src/app/`.

## Directories

| Directory | Purpose | Pattern |
|---|---|---|
| `src/app/**/{page,layout,loading,error,not-found,route,template,default}.{tsx,ts}` | Next.js App Router shells ONLY. Each file is a thin re-export. | No domain code, no helpers, no inline components. |
| `src/features/<feature>/` | Page-level UI for one route or sub-route. Owns its components, hooks, CSS, dialogs, and tests. | Files inside a feature MUST NOT be imported from another feature — promote to `src/components/` instead. |
| `src/features/_root/` | Layout + global styles (tokens, reset, typography, shell, topbar; plus session/conversation/prompt/sidebar/dialogs styles that are consumed across multiple features). Leading underscore = not a route. | Imported by `src/app/layout.tsx` and `src/app/globals.css`. |
| `src/components/` | Cross-feature shared UI. | Promote here only when reused by ≥2 features. |
| `src/hooks/` | Cross-feature shared hooks. | Promote here only when reused by ≥2 features. |
| `src/stores/` | Zustand stores. | One per concern; Immer middleware (`*.store.ts`). |
| `src/lib/<domain>/` | Business logic, server actions, route handlers, queries, mutations, schemas for one domain. | Each domain owns `schemas.ts`, `route-handlers.ts`, `service.ts` (or split), `queries.ts`, `mutations.ts`, `query-keys.ts`, tests. |
| `src/lib/api/` | Shared React Query / fetch plumbing only (`fetcher.ts`, `errors.ts`, `sse.ts`). No domain code. | Per-domain queries/mutations live in `src/lib/<domain>/`. |
| `src/types/` | Ambient/global `.d.ts` only (module shims, global window types). | No application types — those live in the owning domain's `schemas.ts`. |

## Routing & Domain Boundary (the Next.js exception)

Colocation applies fully **outside** `src/app/`. Inside `src/app/`, the Next.js App Router convention dictates layout, so route files stay where Next.js requires them, but they hold no logic:

- `src/app/<route>/page.tsx` — `export { default } from "@/features/<feature>/<Feature>Page";`
- `src/app/api/<resource>/route.ts` — `export { GET, POST, PUT, DELETE } from "@/lib/<domain>/route-handlers";`
- `src/app/layout.tsx` — re-exports `RootLayout` from `@/features/_root/RootLayout`.

No other code in `src/app/`. CSS imports in `globals.css` chain through `@/features/_root/styles/index.css`.

## Schemas

- Each domain owns `src/lib/<domain>/schemas.ts` (Zod schemas + `z.infer` types).
- No central `src/lib/schemas.ts`, no central `src/types/index.ts`.
- Cross-domain shared primitives (rare) live in `src/lib/shared/schemas.ts`.

## React Query

- Shared plumbing in `src/lib/api/` (`fetcher.ts`, `errors.ts`, `sse.ts`).
- Per-domain query/mutation/key factories in `src/lib/<domain>/{queries,mutations,query-keys}.ts`.

## Naming

- React components: PascalCase (`ProjectCard.tsx`), default export, named by function.
- Lib modules: kebab-case (`project-resolver.ts`). When a module moves into its domain folder, strip the redundant domain prefix (`session-repo.ts` → `src/lib/sessions/repo.ts`).
- Types/Interfaces: PascalCase.
- Schemas: camelCase + `Schema` suffix (`sessionStateSchema`).
- Tests: `.test.ts`/`.test.tsx` colocated with source.
- CSS files: kebab-case BEM (`project-card-header`), one file per feature concern under `src/features/<feature>/styles/`.

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
- **One focused module per concept** — split when a single file approaches ~600 lines unless there is a strong reason to keep it whole.
