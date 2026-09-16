# Technology Stack

## Architecture

Server-rendered Next.js + API routes as backend. **Persistence**: a single SQLite database (`command-center.db`, WAL mode) is the source of truth for all durable state — sessions, projects, conversations, jobs, notifications — accessed through a serialized write queue (`src/lib/state-store/`). Global config lives in `config.json`. Claude and Codex execute behind registered descriptors and neutral conversation/task facets in `src/lib/agent-backends/`; provider SDKs stay inside their adapters.

## Stack

- **TypeScript** — `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `allowJs: false`. The registered `typecheck` runs the native TypeScript 7 compiler through the `typescript-native` npm alias (`node_modules/typescript-native/bin/tsc`, own build-info file under `node_modules/.cache/typescript-native/`); the `typescript` package stays on 5.x because the architecture scanners and lint rules import its compiler JS API, which the native package does not ship. `bun run typecheck` still runs tsc 5.9 and can differ on newer diagnostics (TS2871 is one); the registered command is the gate.
- **Next.js 16** (App Router) + **React 19** + **Node.js**
- **Tailwind CSS v4** (`@tailwindcss/postcss`, CSS-first `@theme`) — the styling system: utility-first classNames + React primitives in `src/components/ui/` + the `cn()` helper (`src/lib/ui/cn.ts`). Custom tokens are defined in `src/features/_root/styles/theme.css` (`@theme`) — the single source of truth for which utilities exist. Which built-ins may/may not be used: `docs/tailwind-conventions.md`. Preflight is intentionally OFF (`reset.css` is the canonical base reset).
- **Zod v4** — schema-first; types derived via `z.infer`; `safeParse` external/untrusted, `parse` internal/trusted. Backend structured-output transport is adapter-owned; see `agent-backends.md`.
- **Zustand + Immer** — client state (`src/stores/`)
- **@tanstack/react-query** — server state; per-domain factories in `src/lib/<domain>/{queries,mutations,query-keys}.ts`
- **react-virtuoso** — virtualized message lists
- **react-markdown + remark-gfm + react-syntax-highlighter** — markdown rendering
- **mermaid + svg-pan-zoom** — diagram rendering
- **Central hotkey dispatcher + Tiptap keymaps** — contextual app shortcuts and prompt-native editing bindings
- **better-sqlite3** — SQLite (WAL); primary persistent store (`command-center.db`) for all state

### Zod v4 gotcha

```typescript
z.record(z.string(), valueSchema);  // ✅ v4 requires explicit key schema
z.record(valueSchema);              // ❌ v4 treats single arg as key schema
```

## Dependency patches

`patches/` holds bun `patchedDependencies` (declared in `package.json`, applied by `bun install`). Each patch is pinned to one package version, so a version bump must regenerate it: `bun patch <pkg>`, re-apply the change in `node_modules/<pkg>`, `bun patch --commit 'node_modules/<pkg>'`, and re-run the test that pins the behavior.

- `@openai/codex-sdk` — splits the `codex exec --json` stream on `\n` only. Node 24's `readline` also breaks lines on U+2028 / U+2029, which codex emits unescaped inside JSON strings, so tool output carrying either character shattered the event and failed the turn. Pinned by `src/lib/agent-backends/codex/sdk-line-splitting.test.ts`. The same trap applies to any JSONL reader in CC: split on newline bytes, never `readline`.

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

[AGENTS.md](../../AGENTS.md#commands) owns validation commands, scope, and the narrow direct-diagnostic exception. Use `cctl dev ensure` for a session dev server. Before running a production build, inspect `package.json` and the task's deployment scope: Next.js build-time imports can open the configured database.

## Test execution profiles

`scripts/test-profiles.ts` is the single owner of test discovery and profile membership. The registered `seams` validator proves that every test has exactly one profile; do not select Vitest projects by hand to compensate for an incorrect assignment.

- An ordinary test defaults to `node-integration`; it needs no registry entry.
- A test with `// @vitest-environment jsdom` belongs to `dom-integration`.
- Tests under `scripts/` or `eslint-rules/`, and files named `*.arch.test.*` or `*.architecture.test.*`, belong to `architecture-toolchain`. Any other test that reads repository, configuration, generated, packaged, or toolchain files outside its import graph must be added to `ARCHITECTURE_TOOLCHAIN_TEST_FILES`, even when the file also contains behavioral tests.
- An architecture/toolchain test that reads repository paths outside its import graph declares them at the top of the file with `// @vitest-inputs <glob> [<glob>...]` (repository-relative, `picomatch` syntax, several lines allowed). Changed validation runs the test when a changed path matches a declared glob or when the test imports a changed module; a test that only imports needs no directive. `vitest.architecture.setup.ts` records every repository read while the file runs and fails the file when a content read or targeted existence probe falls outside its declarations; the failure lists the undeclared paths as glob-shaped groups. A directive on a test outside the profile fails the inventory. Declare what the test scans (`src/**/*.{ts,tsx}`, `scripts/validate/**`), not the accidental shape of a walk; a spawned script is opaque, so declare the files it sources as well. Set `CC_TEST_INPUTS_REPORT_DIR=<dir>` on a direct run to dump everything a file read.
- A file named `*.acceptance.test.ts` belongs to `browser-live-acceptance` and is not part of the unit validator.
- `pure-node` is an audited, setup-free cohort. Add a file to `PURE_NODE_TEST_FILES` only after checking its transitive imports for process-global side effects and confirming that it does not rely on shared setup; a profile directive cannot bypass that registry review.

Keep profile counts, worker settings, and benchmark results out of steering. They are derived from the inventory or recorded with their evidence in `PERFORMANCE.md`.

## Code style

- ESLint via `eslint-config-next` + Tailwind guardrail rules (`no-hardcoded-color`, `no-dynamic-class`, `no-appearance-in-layout-classname`, `no-unapproved-global-css`) on migrated utility-first files
- Styling: **Tailwind v4** utility-first (+ `ui/` primitives + `cn()`); tokens in `src/features/_root/styles/theme.css`; new global CSS is rejected by the `no-unapproved-global-css` guardrail. Allowed vs forbidden built-in utilities: `docs/tailwind-conventions.md`. Legacy/preserved stylesheets use kebab-case BEM (`project-card-header`)
- Vitest tests colocated next to source

## Key Decisions

- **Git worktrees** for session isolation
- **Scoped single-flight locking** — conversation turns key on `projectPath::sessionName::conversationId`; session-level locks remain for git/worktree operations
- **Registered agent backends** — neutral consumers resolve descriptor facets/capabilities; provider SDK options, native frames, structured-output transport, and failure semantics stay inside `agent-backends/{claude,codex}/`
- **Own transcript storage** — CC writes lossless backend envelopes and conversation JSONL; no dependency on a provider's private transcript directory
- **Typed SSE publication** — domain code publishes through `src/lib/events/publication.ts`; the raw broadcaster is private transport
- **Responsiveness contract** — every mutable action gives immediate visual feedback: optimistic update by default, pending indicator (`mutation.isPending` + visible in-progress state) as the floor. `invalidateQueries` alone is never user feedback. Full strategy: `.kiro/steering/data-fetching-and-sse.md` §Perceived Responsiveness
- **OS-aware config dir** — macOS `~/Library/Application Support/cc`, Linux `$XDG_CONFIG_HOME/cc` or `~/.config/cc`
- **Command Center project identity** — `config.json` may set the file-only `commandCenterProjectName` override. The override is authoritative and must name an available project. Without it, the server auto-detects a unique registered checkout whose canonical Git common directory matches the server checkout; ambiguous, non-Git, and packaged deployments remain unresolved.
