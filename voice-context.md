# Voice Context

## Project

Command Center (CC) is a web-based control plane for managing remote Claude Code sessions. Each session runs in its own git worktree and branch (`csm/<name>`); the UI provides create/monitor/interact across multiple parallel sessions, plus graph workflows for autonomous multi-context development.

## Technologies

- **TypeScript** (strict; `noUncheckedIndexedAccess`)
- **Next.js** 16 (App Router) + **React** 19 + **Node.js**
- **Tailwind CSS** v4 (CSS-first `@theme`)
- **Zod** v4 — schema-first; types derived via `z.infer`
- **Zustand** + **Immer** — client state
- **TanStack Query** + **react-virtuoso** — server state + virtualized lists
- **XState** — workflow orchestration
- **better-sqlite3** / **SQLite** (WAL) — `command-center.db`, the source of truth
- **Umzug** — database migrations
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — drives Claude Code
- **Codex** (`@openai/codex-sdk`) and **MCP** (`@modelcontextprotocol/sdk`)
- **Tiptap** — rich-text prompt editor
- **React Flow** (`@xyflow/react`) — graph rendering; **mermaid** + **svg-pan-zoom** — diagrams
- **react-markdown** + **remark-gfm** + **react-syntax-highlighter**
- **Vitest** — tests; **Storybook** — UI prototyping; **Playwright** — browser automation
- **ESLint**, **Prettier**, **Knip**, **Husky**, **Chromatic**, **PostCSS** — tooling
- **Bun** — package manager and script runner; **Tailscale** — remote dev-server URLs

## Terminology

- **CC** - Command Center; the app itself.
- **Kiro** - the `.kiro/` directory, which holds steering (and the superseded spec artifacts). Often mis-transcribed as "Cairo" or "Keiro".
- **AI-DLC** - AI Development Life Cycle.
- **steering** - project-wide guidance docs in `.kiro/steering/`.
- **spec** / **specs** - durable native specs, read and authored through `cctl spec`.
- **Spec Studio** - the UI surface where a human reviews, approves, and browses specs.
- **EARS** - the EARS-format requirements syntax.
- **worktree** - a git worktree; each session is isolated in one.
- **SSE** - Server-Sent Events (real-time conversation/job/workflow broadcasts).
- **JSONL** / **NDJSON** - newline-delimited JSON (transcript and log format).
- **Zod** - the schema-validation library ("zode"; not "god" or "sod").
- **Zustand** - the client-state library (German, "TSOO-shtahnt").
- **XState** - the state-machine library powering workflows.
- **Immer** - the immutable-update library.
- **TanStack** - the org behind React Query and Virtual.
- **Tiptap** - the rich-text editor.
- **Umzug** - the SQLite migration runner.
- **Codex** - OpenAI Codex (invoked via `run_codex`).
- **Whisper** - OpenAI speech-to-text used for CC's voice input.
- **Tailscale** - VPN used to expose remote dev-server URLs.
- **WAL** - Write-Ahead Logging (SQLite journal mode).
- **single-flight locking** - per-session concurrency lock keyed by `projectPath::sessionName`.
- **graph workflow** - declarative multi-context execution with task graphs, validation, and retries.
- **circuit breaker** - the workflow failure-halting mechanism.
- **Shama** - the macOS voice-to-text app these files configure.

## Naming Conventions

- React components: PascalCase, default export, named by function (`ProjectCard.tsx`).
- Lib modules: kebab-case (`project-resolver.ts`).
- Types/Interfaces: PascalCase (`SessionState`).
- Zod schemas: camelCase + `Schema` suffix (`sessionStateSchema`).
- Branches: `csm/<name>`. Import alias `@/` maps to `./src/`.
- Project config files: `CommandCenter.json`, `command-center.db`, `config.json`.

## Claude Commands & Skills

### Commands (`.claude/commands/`)

- **/spec** - Author a durable native Command Center spec in this conversation.
- **/ui-design** - Design a new UI feature using Storybook for prototyping.

### Steering skills

- **/kiro-steering** - Maintain `.kiro/steering/` as persistent project memory (bootstrap/sync).
- **/kiro-steering-custom** - Create custom steering documents for specialized contexts.

### CC tooling skills (`.claude/skills/` + plugin)

- **cc-design-system** - Design, build, or review CC UI against the design system (tokens, components, motion).
- **cc-live-feature-test** - End-to-end live verification of a CC feature with Playwright + real LLM calls.
- **cc-performance-log-analysis** - Diagnose CC performance issues from structured server logs.
- **cc-rebuild-restart** - Rebuild CC in the main worktree and restart the running server.
- **debug-logs** - Trace CC issues through logs and state (failures, lock contention, prompt errors).
- **graph-workflow-planning** - Plan, revise, or diagnose graph workflow execution graphs.
- **native-sdd-authoring** - Author and review native specs and their managed graph delivery workflows.
- **nextjs-mcp** - Diagnose app/runtime/build errors and inspect routes via Next.js dev tools.
- **playwright-cli** - Automate browser interactions and test web pages with Playwright.
- **react-scan** - Measure and diff React render counts to find unnecessary re-renders.
- **agent-context** - Orient an agent to its CC environment (worktree, MCP tools, config).
- **dev-server-setup** - Add or configure dev servers in `CommandCenter.json`.
- **project-setup** - Configure a project for CC (`CommandCenter.json`, worktree init, pre-merge).
