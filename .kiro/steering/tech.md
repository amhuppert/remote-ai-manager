# Technology Stack

## Architecture

Server-rendered Next.js + API routes as backend. **Persistence**: a single SQLite database (`command-center.db`, WAL mode) is the source of truth for all durable state — sessions, projects, conversations, jobs, notifications — accessed through a serialized write queue (`src/lib/state-store/`). Global config lives in `config.json`. Claude and Codex execute behind registered descriptors and neutral conversation/task facets in `src/lib/agent-backends/`; provider SDKs stay inside their adapters.

## Stack

- **TypeScript** — `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `allowJs: false`
- **Next.js 16** (App Router) + **React 19** + **Node.js**
- **Tailwind CSS v4** (`@tailwindcss/postcss`, CSS-first `@theme`) — the styling system: utility-first classNames + React primitives in `src/components/ui/` + the `cn()` helper (`src/lib/ui/cn.ts`). Custom tokens are defined in `src/features/_root/styles/theme.css` (`@theme`) — the single source of truth for which utilities exist. Which built-ins may/may not be used: `docs/tailwind-conventions.md`. Preflight is intentionally OFF (`reset.css` is the canonical base reset).
- **Zod v4** — schema-first; types derived via `z.infer`; `safeParse` external/untrusted, `parse` internal/trusted. Backend wire-schema compatibility is adapter-owned; see `agent-backends.md`.
- **Zustand + Immer** — client state (`src/stores/`)
- **@tanstack/react-query** — server state; per-domain factories in `src/lib/<domain>/{queries,mutations,query-keys}.ts`
- **react-virtuoso** — virtualized message lists
- **react-markdown + remark-gfm + react-syntax-highlighter** — markdown rendering
- **mermaid + svg-pan-zoom** — diagram rendering
- **react-hotkeys-hook** — shortcuts
- **better-sqlite3** — SQLite (WAL); primary persistent store (`command-center.db`) for all state

### Zod v4 gotcha

```typescript
z.record(z.string(), valueSchema);  // ✅ v4 requires explicit key schema
z.record(valueSchema);              // ❌ v4 treats single arg as key schema
```

## Schema location

Each domain owns its schemas in `src/lib/<domain>/schemas.ts`; types are derived via `z.infer` and exported from the same file. No central `src/lib/schemas.ts`. Cross-domain shared primitives (rare) live in `src/lib/shared/schemas.ts`. See `structure.md`.

## Database schema migrations

Two layers manage `command-center.db` as the schema evolves (`src/lib/state-store/`):

- **Synchronous schema floor** (`state-db.ts`): `CREATE … IF NOT EXISTS` DDL + idempotent additive-column back-fills + structural rebuilds that must hold the instant the DB opens. Runs on **every** connection, so it must stay idempotent. Keeps fresh / `:memory:` DBs current with no async step — contract-test fixtures depend on this.
- **Umzug runner** (`migrator.ts` + `migrations/`): ordered, ledgered migrations for **data migrations, one-time cleanups, and future ordered changes**. Async, so it registers at server startup from `instrumentation.node.ts`'s `register()` — NOT from the synchronous `getDb()` open path — and that registration runs in **every server worker**. Concurrent workers over one file-backed DB converge because each `up` is idempotent (an overlapping worker at worst replays it, identical to a crash-replay) and the `INSERT OR IGNORE` ledger write records each migration exactly once. "Once" describes the eventual ledger state — one `applied_migrations` row per migration — not the number of `up` executions.

**Where a change goes:** structural shape that must hold at open time → floor; everything else → a new Umzug migration. Migrations MUST be idempotent (the ledger write is a separate step from `up`, so a crash replays). A **breaking** change (an older build can no longer read the data) additionally bumps `KNOWN_SCHEMA_VERSION` and inserts a `schema_migrations` row so the forward-only gate stops older builds from opening the upgraded DB.

Three bookkeeping tables, kept distinct: `applied_migrations` (Umzug ledger, by name — branch-friendly), `schema_migrations` (forward-only compat-version gate), `applied_data_migrations` (legacy purge marker).

**To add a migration:** follow `src/lib/state-store/migrations/README.md` — drop a `NNNN-name.ts`, append it to `index.ts`, keep it idempotent, add a test beside `migrator.test.ts`.

## Commands

```bash
bun install          # install dependencies
bun run dev          # dev server
bun run build        # production Next.js + cctl builds
bun run test         # full Vitest suite
bun run test path/to/file.test.ts # targeted Vitest file
bun run test:watch   # vitest watch
bun run typecheck    # tsc --noEmit
bun run lint         # ESLint + architecture seam ratchet
bun run seams:check  # architecture seam ratchet only
```

## Code style

- ESLint via `eslint-config-next` + Tailwind guardrail rules (`no-hardcoded-color`, `no-dynamic-class`, `no-appearance-in-layout-classname`, `no-unapproved-global-css`) on migrated utility-first files
- Styling: **Tailwind v4** utility-first (+ `ui/` primitives + `cn()`); tokens in `src/features/_root/styles/theme.css`; new global CSS is rejected by the `no-unapproved-global-css` guardrail. Allowed vs forbidden built-in utilities: `docs/tailwind-conventions.md`. Legacy/preserved stylesheets use kebab-case BEM (`project-card-header`)
- Vitest tests colocated next to source

## Key Decisions

- **Git worktrees** for session isolation
- **Scoped single-flight locking** — conversation turns key on `projectPath::sessionName::conversationId`; session-level locks remain for git/worktree operations
- **Registered agent backends** — neutral consumers resolve descriptor facets/capabilities; provider SDK options, native frames, schema projection, and failure semantics stay inside `agent-backends/{claude,codex}/`
- **Own transcript storage** — CC writes lossless backend envelopes and conversation JSONL; no dependency on a provider's private transcript directory
- **Typed SSE publication** — domain code publishes through `src/lib/events/publication.ts`; the raw broadcaster is private transport
- **Responsiveness contract** — every mutable action gives immediate visual feedback: optimistic update by default, pending indicator (`mutation.isPending` + visible in-progress state) as the floor. `invalidateQueries` alone is never user feedback. Full strategy: `.kiro/steering/data-fetching-and-sse.md` §Perceived Responsiveness
- **OS-aware config dir** — macOS `~/Library/Application Support/cc`, Linux `$XDG_CONFIG_HOME/cc` or `~/.config/cc`
