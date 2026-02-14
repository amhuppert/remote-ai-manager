# Technology Stack

## Architecture

Server-rendered Next.js application with API routes acting as the backend. No database — state is persisted as JSON files on the local filesystem. Claude Code CLI is invoked as a child process for prompt execution.

## Core Technologies

- **Language**: TypeScript (strict mode, `noUncheckedIndexedAccess`)
- **Framework**: Next.js 15 (App Router)
- **Runtime**: Node.js with React 19
- **Validation**: Zod v4 (schemas define all data entities)

## Key Libraries

- **Zod v4** — Schema-first data modeling; all entity types derived via `z.infer`
- **next/font/google** — Typography (Anybody, Manrope, Geist Mono)
- No external state management, HTTP client, or ORM libraries — kept deliberately minimal

### Zod v4 Convention

```typescript
// CORRECT — Zod v4 requires explicit key schema for records
z.record(z.string(), valueSchema);

// WRONG — single arg is treated as key schema in v4
z.record(valueSchema);
```

## Development Standards

### Type Safety

- TypeScript `strict: true` with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- `allowJs: false` — no JavaScript files
- All data entities defined as Zod schemas in `src/lib/schemas.ts`, types re-exported from `src/types/index.ts`
- `safeParse` for external/untrusted input; `parse` for internal/trusted data

### Code Quality

- ESLint via `eslint-config-next`
- CSS class naming: kebab-case BEM-style (e.g., `project-card-header`, `topbar-breadcrumb`)

### Testing

- **Vitest** — test files colocated with source: `*.test.ts` next to `*.ts` in `src/lib/`
- Tests run via `bun run test` (watch) or `npm run test:run` (single run)
- Typecheck via `bun run typecheck`

## Development Environment

### Common Commands

```bash
# Dev server
bun run dev

# Production build
bun run build

# Run tests (watch mode)
bun run test

# Run tests (single run)
bun run test:run

# Type checking
bun run typecheck

# Lint
bun run lint
```

## Key Technical Decisions

- **Filesystem-backed state** — No database; JSON state file with atomic writes (write-to-temp + rename) for crash safety
- **Git worktrees for isolation** — Each session creates a worktree + branch, avoiding workspace conflicts between parallel sessions
- **Single-flight locking** — In-memory promise map prevents concurrent prompt execution on the same session
- **Claude Code as subprocess** — Prompts are executed by spawning `claude` CLI via `execFile`, not through an API
- **Hook-based event ingestion** — Claude Code hooks (UserPromptSubmit, Stop) POST session metadata to CSM's API, enabling real-time status tracking
- **OS-aware config** — Config directory follows platform conventions (macOS: `~/Library/Application Support/csm`, Linux: `$XDG_CONFIG_HOME/csm` or `~/.config/csm`)

---

_Document standards and patterns, not every dependency_
