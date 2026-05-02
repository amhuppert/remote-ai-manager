# Project Structure

Hybrid: feature-colocated components in App Router pages, shared components in `src/components/`, domain logic in `src/lib/`.

## Directories

| Directory | Purpose | Pattern |
|---|---|---|
| `src/app/**/{page,layout}.tsx` | Route definitions | Dynamic segments use `[param]` |
| `src/app/**/` | Page-specific components | Colocated; not reused (e.g. `ProjectCard.tsx`) |
| `src/components/` | Cross-page shared UI | Promote here only when reused (e.g. `Topbar.tsx`) |
| `src/lib/` | Business logic, data access, utilities | One module per domain; nest dirs for multi-file domains (`logging/`, `workflows/`) |
| `src/app/api/**/route.ts` | REST endpoints | Mirrors resource hierarchy; HTTP method exports |
| `src/stores/` | Zustand stores | One per concern; Immer middleware (`*.store.ts`) |
| `src/hooks/` | Shared React hooks | `use-<name>.ts` or `use<Name>.ts`; promoted when reused across routes |
| `src/lib/schemas.ts` + `src/types/index.ts` | Single source of truth for shapes | Zod schemas → `z.infer` types |

React Query: factories in `src/lib/queries.ts`, `mutations.ts`, `query-keys.ts`.

## Naming

- React components: PascalCase (`ProjectCard.tsx`), default export, named by function
- Lib modules: kebab-case (`project-resolver.ts`)
- Types/Interfaces: PascalCase (`SessionState`, `FileDiff`)
- Schemas: camelCase + `Schema` suffix (`sessionStateSchema`)
- Tests: `.test.ts`/`.test.tsx` colocated with source
- API route tests: `*-route.test.ts` in `src/lib/` (e.g. `prompt-route.test.ts`)

## Imports

```typescript
import { readFile } from "node:fs/promises";    // Node built-ins
import { z } from "zod";                         // External
import type { SessionState } from "@/types";    // Internal absolute (@/ = ./src/)
import { someHelper } from "./helper";           // Relative same-dir
```

## Principles

- **Schema-first** — Zod schemas define entities; never hand-write duplicate types
- **Colocation** — components live next to their page; promote to `src/components/` only when reused
- **API mirrors resources** — `/api/projects/[name]/sessions/[session]/prompt`
- **Organized lib** — one focused module per concept; nest dirs for multi-file domains
