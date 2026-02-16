# Project Structure

## Organization Philosophy

Hybrid approach: **feature-colocated components** within App Router pages, **shared components** in a central directory, and **domain logic** in `lib/`.

## Directory Patterns

### App Router Pages (`src/app/`)

**Location**: `src/app/**/{page,layout}.tsx`
**Purpose**: Route definitions following Next.js App Router conventions
**Pattern**: Dynamic segments use `[param]` directories (e.g., `[name]`, `[session]`)

### Feature Components (`src/app/**/`)

**Location**: Colocated with the page that uses them
**Purpose**: Page-specific UI components, not reused elsewhere
**Example**: `src/app/projects/ProjectCard.tsx`, `src/app/projects/[name]/SessionsList.tsx`

### Shared Components (`src/components/`)

**Location**: `src/components/`
**Purpose**: Cross-page UI components used from multiple routes
**Example**: `Topbar.tsx`, `ConfirmDialog.tsx`

### Domain Logic (`src/lib/`)

**Location**: `src/lib/`
**Purpose**: All business logic, data access, and utilities
**Pattern**: One module per domain concept (e.g., `sessions.ts`, `state.ts`, `config.ts`, `hooks.ts`); use nested directories when a domain has multiple related files (e.g., `src/lib/logging/`)

### API Routes (`src/app/api/`)

**Location**: Nested under `src/app/api/` mirroring the resource structure
**Purpose**: REST-style API endpoints
**Pattern**: `route.ts` files with exported HTTP method handlers (GET, POST, DELETE)
**Example**: `src/app/api/projects/[name]/sessions/[session]/prompt/route.ts`

### Schemas & Types

**Location**: `src/lib/schemas.ts` (Zod schemas) + `src/types/index.ts` (type re-exports & interfaces)
**Purpose**: Single source of truth for all data shapes
**Pattern**: Zod schemas define entities; `z.infer` derives types; additional interfaces (API responses, UI-only types) live in `src/types/index.ts`

## Naming Conventions

- **Files**: PascalCase for React components (`ProjectCard.tsx`), kebab-case for lib modules (`project-resolver.ts`)
- **Components**: PascalCase, default export, named by function
- **Types/Interfaces**: PascalCase, suffixed by domain (`SessionState`, `FileDiff`)
- **Schemas**: camelCase with `Schema` suffix (`sessionStateSchema`)
- **Test files**: Same name as source with `.test.ts` suffix, colocated in `src/lib/`

## Import Organization

```typescript
// Node built-ins first
import { readFile } from "node:fs/promises";
import path from "node:path";

// External packages
import { z } from "zod";

// Internal absolute imports via alias
import type { SessionState } from "@/types";
import { readConfig } from "@/lib/config";

// Relative imports (same directory)
import { someHelper } from "./helper";
```

**Path Aliases**:

- `@/` maps to `./src/`

## Code Organization Principles

- **Schema-first**: Data entities start as Zod schemas; types are derived, never hand-written duplicates
- **Colocation**: Components live next to the page that uses them; shared components are promoted to `src/components/` only when reused
- **Organized lib**: Modules are focused on a single domain concept; use nested directories when a domain has multiple related files
- **API mirrors resources**: API route structure follows REST resource hierarchy (`/api/projects/[name]/sessions/[session]/prompt`)

---

_Document patterns, not file trees. New files following patterns shouldn't require updates_
