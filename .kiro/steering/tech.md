# Technology Stack

## Architecture

Server-rendered Next.js + API routes as backend. **Dual storage**: JSON state file (atomic write-temp-rename) for session/project state; SQLite (WAL mode) for notification/job history. Claude Code driven via `@anthropic-ai/claude-agent-sdk` `query()`.

## Stack

- **TypeScript** — `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `allowJs: false`
- **Next.js 16** (App Router) + **React 19** + **Node.js**
- **Zod v4** — schema-first; types derived via `z.infer`; `safeParse` external/untrusted, `parse` internal/trusted
- **Zustand + Immer** — client state (`src/stores/`)
- **@tanstack/react-query** — server state; factories in `src/lib/queries.ts`, `mutations.ts`, `query-keys.ts`
- **@tanstack/react-virtual** — virtualized message lists
- **react-markdown + remark-gfm + react-syntax-highlighter** — markdown rendering
- **mermaid + svg-pan-zoom** — diagram rendering
- **react-hotkeys-hook** — shortcuts
- **better-sqlite3** — SQLite (WAL) for jobs/notifications

### Zod v4 gotcha

```typescript
z.record(z.string(), valueSchema);  // ✅ v4 requires explicit key schema
z.record(valueSchema);              // ❌ v4 treats single arg as key schema
```

## Schema location

All entity schemas in `src/lib/schemas.ts`; types/interfaces re-exported from `src/types/index.ts`.

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
