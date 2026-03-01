# Design: File Autocomplete

## Architecture Overview

Server-side file scanning + client-side fuzzy filtering. Follows the same architecture as CommandAutocomplete but with `@`-trigger instead of `/`, and project-level data (no session needed).

## Components

### 1. File Scanner (`src/lib/file-scanner.ts`)

Pure utility function:
```typescript
export async function scanProjectFiles(projectPath: string): Promise<FileItem[]>
```
- Uses `fs.readdir(projectPath, { recursive: true, withFileTypes: true })`
- Filters out excluded directories (checked during traversal) and file patterns
- Returns `{ path: string }` with paths relative to projectPath

### 2. API Route (`src/app/api/projects/[name]/files/route.ts`)

```
GET /api/projects/[name]/files → { items: FileItem[] }
```
- Uses `resolveProjectPath()` for project resolution
- Calls `scanProjectFiles()` and returns results
- No session needed — files are project-level

### 3. Schemas & Types

In `src/lib/schemas.ts`:
```typescript
export const fileItemSchema = z.object({ path: z.string() });
export const projectFilesResponseSchema = z.object({ items: z.array(fileItemSchema) });
```

In `src/types/index.ts`: Re-export `FileItem`, `ProjectFilesResponse`

In `src/lib/query-keys.ts`:
```typescript
export const fileKeys = {
  all: ["files"] as const,
  list: (projectName: string) => [...fileKeys.all, "list", projectName] as const,
};
```

### 4. React Query Hook (`src/lib/queries.ts`)

```typescript
export function useProjectFilesQuery(projectName: string, options?: { enabled?: boolean })
```
- Fetches `GET /api/projects/{name}/files`
- Uses `fileKeys.list(projectName)` as query key

### 5. @-Trigger Hook (`src/hooks/use-file-autocomplete-trigger.ts`)

Extracts the @-word at cursor position:
```typescript
export function useFileAutocompleteTrigger(text: string, cursorPosition: number)
  → { query: string | null; startIndex: number; endIndex: number }
```
- Walks backward from cursor to find `@` at a word boundary
- Returns null query when no `@`-word is under cursor

### 6. Integration Pattern

Each prompt input that supports file autocomplete:
1. Tracks cursor position via `onSelect` / `onChange`
2. Uses `useFileAutocompleteTrigger(text, cursor)` to detect @-words
3. Fetches files via `useProjectFilesQuery(projectName)`
4. Filters with `fuzzyMatch(query, file.path)` in a `useMemo`
5. Caps at 50 results, passes `totalCount` for truncation display
6. On selection: replaces text from `startIndex` to `endIndex` with `@path `
7. FileAutocomplete `handleKeyDown` intercepts keyboard events before textarea

### 7. FileAutocomplete Component (existing)

Already implemented in `src/components/FileAutocomplete.tsx`. Pure display component receiving:
- `items: ScoredFileItem[]` — pre-filtered and scored
- `visible: boolean` — show/hide
- `loading/error` — loading and error states
- `totalCount` — for truncation display
- `onSelect(path)` — selection callback
- `onClose()` — close callback

## Exclusion Patterns

### Directories (skip during traversal)
`node_modules`, `.git`, `.next`, `.turbo`, `.nuxt`, `.output`, `.cache`, `.vscode`, `.idea`, `.cursor`, `coverage`, `.nyc_output`, `storybook-static`, `.worktrees`, `dist`, `build`, `.svelte-kit`, `.parcel-cache`

### Files (skip by name)
`.DS_Store`, `Thumbs.db`, `.eslintcache`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lockb`

### Extensions (skip binary/media)
`.png`, `.jpg`, `.jpeg`, `.gif`, `.ico`, `.svg`, `.webp`, `.mp4`, `.mp3`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.zip`, `.tar`, `.gz`, `.pdf`, `.exe`, `.dll`, `.so`, `.dylib`
