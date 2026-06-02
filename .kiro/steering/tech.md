# Technology Stack

## Architecture

Server-rendered Next.js + API routes as backend. **Persistence**: a single SQLite database (`command-center.db`, WAL mode) is the source of truth for all durable state — sessions, projects, conversations, jobs, notifications — accessed through a serialized write queue (`src/lib/state-store/`). Global config lives in `config.json`. Claude Code driven via `@anthropic-ai/claude-agent-sdk` `query()`.

## Stack

- **TypeScript** — `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `allowJs: false`
- **Next.js 16** (App Router) + **React 19** + **Node.js**
- **Zod v4** — schema-first; types derived via `z.infer`; `safeParse` external/untrusted, `parse` internal/trusted
- **Zustand + Immer** — client state (`src/stores/`)
- **@tanstack/react-query** — server state; per-domain factories in `src/lib/<domain>/{queries,mutations,query-keys}.ts`
- **@tanstack/react-virtual** — virtualized message lists
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

## Commands

```bash
bun run dev          # dev server
bun run build        # production
bun run test         # vitest single
bun run test:watch   # vitest watch
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
```

## Code style

- ESLint via `eslint-config-next`
- CSS: kebab-case BEM-style (`project-card-header`)
- Vitest tests colocated next to source

## Key Decisions

- **Git worktrees** for session isolation
- **Single-flight locking** via in-memory promise map keyed by `projectPath::sessionName`
- **Claude Agent SDK** options: `systemPrompt: { type: "preset", preset: "claude_code" }`, `permissionMode: "bypassPermissions"`, `settingSources: ["user", "project", "local"]`
- **Own transcript storage** — CC writes its own JSONL files; no dependency on `~/.claude/projects/`
- **SSE over hooks** — conversation/job/notification updates broadcast via SSE
- **OS-aware config dir** — macOS `~/Library/Application Support/cc`, Linux `$XDG_CONFIG_HOME/cc` or `~/.config/cc`
