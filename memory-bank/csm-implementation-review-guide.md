# Code Change Review Guide: Claude Session Manager (CSM)

## Overview

This is a complete greenfield implementation of **Claude Session Manager (CSM)** — a web-based control panel for managing remote Claude Code sessions across multiple git repositories. The application is built with **Next.js 15** (App Router), **React 19**, **TypeScript** (strict mode), and **Bun** as the package manager. It follows a dark, sci-fi-inspired "Ground Control" aesthetic.

The architecture spans three major layers:

1. **Service Layer** (`src/lib/`) — Pure Node.js modules handling file I/O, git operations, process spawning, and state persistence. This is where the core domain logic lives.
2. **API Layer** (`src/app/api/`) — Next.js route handlers exposing the service layer over HTTP with proper error handling and validation.
3. **UI Layer** (`src/components/` + `src/app/` pages) — Server-rendered pages with client-side interactivity for session management, conversation viewing, and diff inspection.

The system manages coding sessions by creating **git worktrees** per session, spawning Claude CLI processes within those worktrees, and integrating with **Claude Code hooks** to capture transcript and session metadata.

---

## Phase 1: High-Level Overview

### 1. Project Setup & Tooling

**Files:** `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.eslintrc.json`, `.gitignore`

Next.js 15 + React 19 project with strict TypeScript, Vitest for testing, and path aliases (`@/*` maps to `./src/*`). Minimal config — the project leans on Next.js defaults with `reactStrictMode` enabled.

### 2. Design System

**File:** `src/app/globals.css`

A comprehensive 1,850-line design system built entirely with CSS custom properties. Defines a five-level dark elevation palette, four accent color families (cyan, amber, green, red), three font families, and full component styling including responsive breakpoints at 900px and 768px. All animations, atmospheric effects (noise + scan lines), and mobile adaptations are in this single file.

### 3. TypeScript Type Definitions

**File:** `src/types/index.ts`

Central type definitions for all data entities: `GlobalConfig`, `ManagerState`, `ProjectState`, `SessionState`, plus API request/response types (`DiscoveredProject`, `CreateSessionRequest`, `TranscriptMessage`, `FileDiff`, `SessionDiff`, etc.). This file is the contract between the service layer and the UI.

### 4. App Shell & Entry

**Files:** `src/app/layout.tsx`, `src/app/page.tsx`

Root layout configures three Google Fonts (Anybody, Manrope, Geist Mono) via `next/font/google` with CSS variable injection. The root page (`/`) immediately redirects to `/projects`.

### 5. Service Layer — Config & State Persistence

**Files:** `src/lib/config.ts`, `src/lib/state.ts`

Config service reads/writes `GlobalConfig` JSON from the OS-appropriate config directory (XDG on Linux, `~/Library/Application Support` on macOS). State service manages `ManagerState` with **atomic file writes** (write-to-temp, then rename) to prevent corruption.

### 6. Service Layer — Project Discovery

**Files:** `src/lib/discovery.ts`, `src/lib/project-resolver.ts`

Discovery scans `baseDir` one level deep for directories containing `.git`, filters by ignore patterns, and enriches results with session metadata from manager state. Project resolver maps URL-encoded project names to absolute filesystem paths.

### 7. Service Layer — Session Management

**File:** `src/lib/sessions.ts`

Creates and deletes sessions. Session creation involves: name validation, uniqueness check, `git worktree add` with a `csm/<name>` branch, optional init script execution (from `ClaudeSessionManager.json`), and full rollback on any failure.

### 8. Service Layer — Prompt Execution & Locking

**Files:** `src/lib/prompt.ts`, `src/lib/lock.ts`

Single-flight lock prevents concurrent prompt executions per session using an in-memory `Map<string, Promise>`. Prompt execution spawns `claude -p` (or `claude -c -p` for continuations) in the worktree directory, manages session status transitions, and enforces timeouts.

### 9. Service Layer — Transcript Parsing & Diff Computation

**Files:** `src/lib/transcript.ts`, `src/lib/diff.ts`

Transcript service parses Claude JSONL transcript files, extracting user/assistant messages and handling both string and content-block-array formats. Diff service runs `git diff main` and parses unified diff output into structured `FileDiff`/`DiffHunk`/`DiffLine` objects.

### 10. Service Layer — Claude Hooks Integration

**File:** `src/lib/hooks.ts`

Processes hook events from Claude Code by matching `cwd` to managed session worktree paths, updating `claudeSessionId` and `transcriptPath`. Also detects whether hooks are installed by reading `~/.claude/settings.json`.

### 11. API Routes

**Files:** `src/app/api/projects/route.ts`, `src/app/api/projects/[name]/sessions/route.ts`, `src/app/api/projects/[name]/sessions/[session]/prompt/route.ts`, `src/app/api/hooks/route.ts`, `src/app/api/hooks/status/route.ts`

Five API routes covering project discovery (GET), session CRUD (GET/POST/DELETE), prompt execution (POST), hook event ingestion (POST), and hook status detection (GET). All use `satisfies ApiError` for type-safe error responses.

### 12. UI Components

**Files:** `src/components/Topbar.tsx`, `ProjectCard.tsx`, `SessionsList.tsx`, `CreateSessionModal.tsx`, `ConfirmDialog.tsx`, `LayoutSwitcher.tsx`, `DiffPanel.tsx`

Seven client components: sticky frosted-glass topbar with context-aware breadcrumbs, project cards with hover effects, sessions table with inline status badges, create-session modal with branch preview, generic confirm dialog, SVG-icon layout switcher, and a full diff panel with collapse/expand, file navigation, and hunk navigation.

### 13. Page Views

**Files:** `src/app/projects/page.tsx`, `src/app/projects/[name]/page.tsx`, `src/app/projects/[name]/[session]/page.tsx`, `src/app/projects/[name]/[session]/SessionDetailPage.tsx`

Three views: projects list ("Ground Control"), sessions list per project, and session detail. The detail page is split into a server component (data fetching) and a large client component (`SessionDetailPage.tsx`) handling layout switching, mobile panel tabs, conversation rendering with message navigation, prompt input, and diff display.

### 14. Unit Tests

**Files:** `src/lib/__tests__/config.test.ts`, `state.test.ts`, `lock.test.ts`, `diff.test.ts`, `transcript.test.ts`, `hooks.test.ts`

37 tests across 6 files covering the service layer. Tests use temp directories, module mocking (`vi.mock`), and test against the pure-function interfaces. Diff parsing has particularly thorough coverage (empty input, single file, multi-file, multi-hunk, new file mode).

---

## Phase 2: Detailed Walkthrough

### 1. Project Setup & Tooling

The project uses a deliberately minimal dependency set — only Next.js, React, and React DOM as runtime dependencies. No CSS-in-JS libraries, no state management libraries, no component frameworks.

**TypeScript is configured for maximum strictness:**

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true
}
```

The `noUncheckedIndexedAccess` flag is particularly notable — it forces explicit handling of `T | undefined` when accessing arrays/records by index, which catches a class of bugs that even `strict: true` misses.

**Vitest** is configured in Node environment (not jsdom) since most tests target service-layer code, and path aliases are mirrored so `@/lib/config` works in test files.

The `.gitignore` includes `bun.lock` (treated as regenerable) and `.env.*` files (security), but preserves `.env.example`.

### 2. Design System

The entire visual language lives in `globals.css` — a deliberate choice to avoid CSS-in-JS complexity for a project of this size. The design system is built on CSS custom properties organized into semantic groups:

**Elevation palette (5 levels):**

```css
--bg-void: #06090f; /* deepest background */
--bg-base: #0b1019; /* standard page bg */
--bg-surface: #111825; /* card/panel bg */
--bg-raised: #172033; /* hover/elevated state */
--bg-hover: #1c2841; /* active hover */
```

**Atmospheric effects** are a distinguishing design decision — two full-screen `::before`/`::after` pseudo-elements on `body` create a noise texture overlay (SVG data URI, 2.5% opacity) and scan lines (repeating gradient). These are `position: fixed` with `pointer-events: none` and very high z-index, creating a subtle CRT/retro atmosphere without impacting interactivity.

**Responsive strategy** follows a mobile-down approach with three tiers:

- Desktop (default): dual-column layouts, full topbar, hover tooltips
- Tablet (<=900px): single-column grids, info strip wrapping
- Mobile (<=768px): bottom action bar, panel tab switching, touch targets enlarged to 44px, modals become bottom sheets (`slideUpSheet` animation), breadcrumbs collapse to back-arrow pattern

The `stagger-in` CSS class is a parent-applied utility that staggers child animations using `nth-child` delays (0ms to 350ms). This is used on card grids and table bodies for page-load polish.

### 3. TypeScript Type Definitions

The type system reflects the domain model cleanly:

```
GlobalConfig -> ManagerState -> ProjectState -> SessionState
```

Key design decisions in the types:

- **`SessionStatus`** is a union type `"idle" | "ready" | "running"` — three states are sufficient because there's no "error" state (sessions reset to "ready" after failures).
- **`claudeSessionId` and `transcriptPath`** are `string | null` — they start null and get populated asynchronously via hooks, not during session creation.
- **`FileDiff` / `DiffHunk` / `DiffLine`** model unified diff output as a hierarchy. `DiffLine.type` uses `"hunk-header"` as a line type rather than separating headers from content, which simplifies rendering.
- **`ApiError`** includes an optional `code` field for programmatic handling (used by `SESSION_BUSY` to distinguish lock conflicts from other errors).

### 4. App Shell & Entry

The root layout sets up font loading using Next.js's built-in Google Fonts optimization:

```tsx
const anybody = Anybody({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-anybody",
});
const manrope = Manrope({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-manrope",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-geist-mono",
});
```

Fonts are injected as CSS variables on `<html>`, then consumed via `var(--font-anybody)` etc. in `globals.css`. This avoids FOUT while keeping the font system decoupled from component code.

The root page is a single-line redirect — there's no landing page, the user always enters at `/projects`.

### 5. Service Layer — Config & State Persistence

**Config service** (`config.ts`) follows the XDG Base Directory Specification on Linux, falling back to `~/.config/csm`. On macOS it uses `~/Library/Application Support/csm`. The `readConfig` function auto-creates defaults on first run and merges saved configs with defaults on read — this ensures forward compatibility when new config fields are added.

**State service** (`state.ts`) implements **atomic writes** via write-then-rename:

```ts
const tmpPath = `${statePath}.tmp.${Date.now()}`;
await writeFile(tmpPath, json, "utf-8");
await rename(tmpPath, statePath);
```

This pattern prevents partial writes from corrupting state if the process crashes mid-write. The `rename` syscall is atomic on most filesystems.

The state module exports focused CRUD functions (`getOrCreateProject`, `updateSession`, `removeSession`, `getProjectSessions`, `getSession`) rather than exposing raw state manipulation, creating a clean boundary.

### 6. Service Layer — Project Discovery

`discovery.ts` scans `baseDir` one level deep, checks for `.git` existence (which handles both regular repos and worktrees, since worktrees have a `.git` file), and enriches results with session data from manager state.

Sorting is intentional: **projects with active sessions sort first**, then alphabetical. This surfaces the most relevant projects immediately.

`project-resolver.ts` is a thin validation layer that converts URL-slug project names to verified filesystem paths. It's extracted as a separate module because it's used by both page components (server-side) and API routes.

### 7. Service Layer — Session Management

Session creation (`sessions.ts`) is the most complex service function, implementing a careful **create-or-rollback** pattern:

1. Validate session name (regex: must start with alphanumeric, allows spaces/hyphens/underscores)
2. Check uniqueness within the project
3. Sanitize name to branch-safe slug (`"My Feature" -> "my-feature"`)
4. Create git worktree: `git worktree add -b csm/<slug> <path> main`
5. Optionally execute init script from `ClaudeSessionManager.json`
6. On **any failure**: force-remove worktree, force-delete branch, then re-throw

The rollback has two layers of cleanup — first `git worktree remove --force`, then raw `rm -rf` as a last resort. Branch deletion uses `-D` (force) since the branch may not have commits yet.

Session deletion deliberately **keeps the branch and transcripts** — only the worktree directory and state entry are removed. This is a conscious choice to preserve history.

### 8. Service Layer — Prompt Execution & Locking

The **single-flight lock** (`lock.ts`) is elegantly minimal:

```ts
const activeLocks = new Map<string, Promise<void>>();
```

The lock key is `projectPath::sessionName`. When acquired, a Promise is stored in the map; the release function deletes the entry and resolves the promise. Because this is in-memory, it only works within a single Node.js process — but that's sufficient for a local development tool.

**Prompt execution** (`prompt.ts`) handles the Claude CLI's conversation model:

- First prompt: `claude -p "<prompt>"`
- Subsequent prompts: `claude -c -p "<prompt>"` (the `-c` flag continues the most recent conversation in the cwd)

Because each session has its own worktree, `-c` is unambiguous — there's exactly one conversation per directory. The `CI=1` environment variable prevents Claude from trying to open a browser or ask for interactive input.

The status lifecycle during execution is: `ready -> running -> (execute) -> ready`, with a `finally` block that always resets to "ready" even on errors.

### 9. Service Layer — Transcript Parsing & Diff Computation

**Transcript parsing** (`transcript.ts`) handles Claude's JSONL transcript format where each line is a JSON event. Not all events contain messages — tool events, permission events, etc. are silently skipped. The message content can be either a plain string or an array of content blocks (text, tool_use, tool_result), and only `text` blocks are extracted. This dual-format handling makes the parser resilient to Claude API format variations.

**Diff computation** (`diff.ts`) shells out to `git diff main --unified=3` and parses the result. The parser is a single-pass state machine that tracks `currentFile` and `currentHunk`, pushing completed objects as new headers are encountered. The `parseDiff` function is exported separately (not just `computeDiff`) specifically so it can be unit tested without git.

### 10. Service Layer — Claude Hooks Integration

The hooks system bridges Claude Code's hook mechanism with CSM. The flow:

1. Claude Code fires a hook event (e.g., `UserPromptSubmit`, `Stop`)
2. The hook command pipes JSON to `POST /api/hooks`
3. CSM matches the event's `cwd` against all known session worktree paths
4. On match, updates `claudeSessionId` and `transcriptPath` in state

The `detectHooksStatus` function reads `~/.claude/settings.json` to verify that both `UserPromptSubmit` and `Stop` hooks exist with commands referencing "csm". This enables the warning banner on the UI when hooks aren't configured.

### 11. API Routes

The API follows RESTful conventions within Next.js App Router:

| Route                                            | Methods           | Purpose                 |
| ------------------------------------------------ | ----------------- | ----------------------- |
| `/api/projects`                                  | GET               | Discover all projects   |
| `/api/projects/[name]/sessions`                  | GET, POST, DELETE | Session CRUD            |
| `/api/projects/[name]/sessions/[session]/prompt` | POST              | Execute prompt          |
| `/api/hooks`                                     | POST              | Receive hook events     |
| `/api/hooks/status`                              | GET               | Check hook installation |

All routes use `export const dynamic = "force-dynamic"` to prevent Next.js from caching responses.

The prompt route has a pre-flight busy check (`isSessionBusy`) before even parsing the request body, returning HTTP 409 with `code: "SESSION_BUSY"`. This avoids unnecessary work when a session is already executing.

Error responses consistently use `satisfies ApiError` to maintain type safety without redundant type annotations.

### 12. UI Components

**Topbar** (`Topbar.tsx`) is the only component shared across all views. It accepts a `page` prop that controls which right-side content renders: global status indicators (hooks status, running count) on list views, or session controls (status, layout switcher, refresh, delete) on the detail view. Breadcrumbs are data-driven via a `BreadcrumbSegment[]` array.

**SessionsList** (`SessionsList.tsx`) is a client component that wraps both the sessions table and the create/delete modals. It uses `router.refresh()` after mutations to trigger server re-rendering — a pattern that works well with Next.js App Router's server component model.

**DiffPanel** (`DiffPanel.tsx`) is the most complex component, implementing:

- File collapse/expand toggle per file (managed via `Set<number>` state)
- Collapse all / expand all buttons
- File navigation (prev/next) with auto-expand of collapsed files
- Hunk navigation (prev/next change)
- Ref tracking for scroll targets (`fileHeaderRefs`, `hunkRefs`)

Navigation uses `scrollIntoView({ behavior: "smooth", block: "start" })` and tracks the current scroll position to determine "current" file/hunk for relative navigation.

**LayoutSwitcher** (`LayoutSwitcher.tsx`) renders four inline SVG icons representing layout modes. SVGs are embedded directly in JSX rather than using an icon library, keeping the component dependency-free.

### 13. Page Views

The three-view architecture follows a clear hierarchy:

**Projects List** (`projects/page.tsx`) — Server component that fetches projects, config, and hooks status in parallel via `Promise.all`. Renders the "Ground Control" header with the characteristic cyan accent glow.

**Sessions List** (`projects/[name]/page.tsx`) — Server component that resolves the project path, fetches sessions and hooks status. Delegates all interactivity to the `SessionsList` client component.

**Session Detail** — Split into two files:

- `[session]/page.tsx` (server) — Fetches session state, computes diff, reads transcript. Passes everything as props to the client component.
- `SessionDetailPage.tsx` (client) — 420-line component managing layout mode (persisted to localStorage), mobile panel switching, prompt input, message navigation via `IntersectionObserver`, delete confirmation, and the info strip's mobile collapsed/expanded toggle.

The `IntersectionObserver` setup in `SessionDetailPage` is worth noting: it watches all message elements within the panel body, updating `currentMsgIndex` as messages enter the viewport. This makes the message counter (e.g., "3 / 12") stay accurate whether the user scrolls manually or uses the navigation buttons.

### 14. Unit Tests

Tests are structured to test the service layer independently from Next.js:

- **Config tests** mock `node:os` to redirect to a temp directory, then test default creation, write-read round-trip, and partial config merging (forward compatibility).
- **State tests** use the same temp-directory pattern to test atomic writes and CRUD operations.
- **Lock tests** verify single-flight semantics: acquire succeeds, double-acquire throws, release allows re-acquire.
- **Diff tests** exercise `parseDiff` directly with raw diff strings — empty input, single file, multi-file, multi-hunk, new file mode.
- **Transcript tests** cover the JSONL parser with string content, content-block arrays, malformed lines, and mixed event types.
- **Hooks tests** mock the filesystem to test hook event processing and hook detection logic.

Each test file uses `beforeEach`/`afterEach` cleanup and `vi.resetModules()` to ensure isolation, especially important for modules with top-level `const` initializations (like config directory paths).

---

## Summary

Key architectural decisions:

- **Git worktrees** as the session isolation primitive — each session gets its own working directory branching from main, enabling fully parallel Claude sessions.
- **Atomic state persistence** via write-then-rename prevents corruption from concurrent writes or crashes.
- **Single-flight locking** via in-memory Promises prevents double-execution without adding external dependencies.
- **Server/client component split** — data fetching and validation happen in server components, all interactivity is in client components. This maximizes server rendering while keeping the interactive surface well-contained.
- **Pure CSS design system** — no runtime CSS-in-JS overhead, one file to understand the entire visual language.
- **Claude Code hooks integration** — non-invasive metadata capture that bridges the gap between Claude CLI sessions and the manager UI.
- **Graceful degradation** — hooks not installed? Warning banner shows. No projects? Empty state. Session busy? 409 with explicit code. Diff fails? Empty result. Every edge case has a user-visible fallback.
