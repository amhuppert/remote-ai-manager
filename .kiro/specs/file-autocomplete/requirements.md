# Requirements: File Autocomplete

## REQ-1: @-Trigger Detection
- The file autocomplete dropdown MUST activate when the user types `@` at the beginning of any word in a prompt input
- Detection MUST work mid-text (not only at the start of input like `/` for commands)
- The system MUST extract the query text after `@` by walking backward from the cursor position to find the `@` character
- The dropdown MUST close when the cursor moves away from the @-word or on Escape

## REQ-2: File Indexing API
- A `GET /api/projects/[name]/files` endpoint MUST scan and return all project files
- The scan MUST use `fs.readdir` recursive (not git commands) to include gitignored files
- The scan MUST exclude: `node_modules/`, `.git/`, build artifacts (`.next/`, `.turbo/`, `.nuxt/`, `.output/`, `storybook-static/`), dev tool caches (`.cache/`, `.eslintcache`), package manager lock files (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lockb`), IDE/editor dirs (`.vscode/`, `.idea/`, `.cursor/`), OS files (`.DS_Store`, `Thumbs.db`), coverage/test output (`coverage/`, `.nyc_output/`), and common binary extensions
- Response shape MUST be `{ items: FileItem[] }` where `FileItem = { path: string }`

## REQ-3: Fuzzy Filtering
- File paths MUST be filtered using the existing `fuzzyMatch` utility from `src/lib/fuzzy.ts`
- Filtering MUST use the text after `@` as the query against file paths
- Displayed results MUST be capped at ~50 items
- When truncated, the header MUST show "X of Y" count

## REQ-4: File Selection
- On selection (Enter/Tab or click), `@query` MUST be replaced with `@selected-path ` (with trailing space) in the input text
- Focus MUST return to the input after selection

## REQ-5: Keyboard Navigation
- Arrow Up/Down MUST navigate the file list
- Enter/Tab MUST select the active item
- Escape MUST close the dropdown
- The `handleKeyDown` intercept pattern from CommandAutocomplete MUST be followed

## REQ-6: Integration Points
- File autocomplete MUST be wired into three prompt inputs:
  1. Conversation prompt in SessionDetailPage
  2. Focus mode dialog prompt
  3. Optimistic mode dialog prompt (OptimisticDialog.tsx)

## REQ-7: React Query Integration
- A `useProjectFilesQuery()` hook MUST be added following existing query patterns
- Query key, Zod schema, and TypeScript types MUST be added to the standard locations
