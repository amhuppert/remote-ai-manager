# Zustand + TanStack Query Migration Implementation Plan

## Overview

Refactor the CC UI from server-component data fetching with local React state to:
- **TanStack Query** — all server data fetching (replaces server-component `await` + `router.refresh()` polling)
- **Zustand** — centralized UI/interaction state (replaces scattered `useState` for shared state)
- **`useState`** — strictly local state only (text inputs, ephemeral single-component UI)

Server page components become thin shells that extract route params and render client components. Client components fetch data via TanStack Query hooks and manage UI state via Zustand store hooks.

## Architecture

### Data Flow (Before → After)

**Before**: Server page `await fetchData()` → props → Client component → `useState` + `router.refresh()`

**After**: Server page extracts params → Client component → `useQuery()` for data + Zustand hooks for UI state → `useMutation()` + cache invalidation for writes

### State Ownership

| Layer | Owns | Examples |
|-------|------|----------|
| TanStack Query | Server data, loading/error states, cache, polling | Projects list, session state, messages, diff, commits |
| Zustand | Shared UI state, interaction state | Layout mode, sending flag, optimistic messages, dialog visibility, filters |
| `useState` | Single-component local state | Text input values, form fields in modals, keyboard selection index |

## Technology Stack

| Package | Purpose |
|---------|---------|
| `zustand` (v5) | UI state stores with Immer middleware |
| `immer` (v10) | Immutable state updates via mutation syntax |
| `@tanstack/react-query` (v5) | Server data fetching, caching, mutations |
| `@tanstack/react-query-devtools` (v5) | DevTools panel (development only) |

## File Structure

New and modified files:

```
src/
├── stores/                          # NEW directory
│   ├── projects.store.ts
│   ├── sessions.store.ts
│   ├── session-detail.store.ts
│   └── conversations.store.ts
├── lib/
│   ├── query-keys.ts                # NEW — all query key factories
│   ├── queries.ts                   # NEW — all useQuery hooks
│   └── mutations.ts                 # NEW — all useMutation hooks
├── hooks/
│   ├── use-send-prompt.ts           # NEW — SSE streaming + Zustand + cache invalidation
│   └── useVoiceRecorder.ts          # UNCHANGED
├── components/
│   ├── Providers.tsx                # NEW — QueryClientProvider wrapper
│   └── NotificationListener.tsx     # MODIFIED — add query cache invalidation
├── app/
│   ├── layout.tsx                   # MODIFIED — wrap with Providers
│   ├── api/
│   │   ├── config/route.ts                                              # NEW
│   │   ├── projects/preferences/route.ts                                # NEW
│   │   └── projects/[name]/sessions/[session]/
│   │       ├── route.ts                                                 # NEW (GET handler)
│   │       ├── diff/route.ts                                            # NEW
│   │       └── conversations/[conversationId]/messages/route.ts         # NEW
│   └── projects/
│       ├── page.tsx                 # SIMPLIFIED — thin shell
│       ├── ProjectsGrid.tsx         # RENAMED from ProjectsGridClient, uses hooks
│       ├── [name]/
│       │   ├── page.tsx             # SIMPLIFIED
│       │   ├── SessionsList.tsx     # MODIFIED — uses hooks
│       │   ├── [session]/
│       │   │   ├── page.tsx         # SIMPLIFIED
│       │   │   ├── ConversationList.tsx  # MODIFIED
│       │   │   ├── [conversationId]/
│       │   │   │   └── page.tsx     # SIMPLIFIED
│       │   │   ├── SessionDetailPage.tsx  # MODIFIED — uses hooks
│       │   │   ├── ConversationSidebar.tsx  # MODIFIED
│       │   │   ├── DiffPanel.tsx    # MODIFIED
│       │   │   └── CommitHistory.tsx # MODIFIED
```

## Query Key Factories

File: `src/lib/query-keys.ts`

Hierarchical key structure enabling targeted cache invalidation:

```typescript
export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
  preferences: () => [...projectKeys.all, "preferences"] as const,
};

export const configKeys = {
  all: ["config"] as const,
};

export const hooksKeys = {
  all: ["hooks"] as const,
  status: () => [...hooksKeys.all, "status"] as const,
};

export const sessionKeys = {
  all: ["sessions"] as const,
  list: (projectName: string) =>
    [...sessionKeys.all, "list", projectName] as const,
  detail: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "detail", projectName, sessionName] as const,
  diff: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "diff", projectName, sessionName] as const,
  commits: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "commits", projectName, sessionName] as const,
  commitDiff: (projectName: string, sessionName: string, hash: string) =>
    [...sessionKeys.all, "commitDiff", projectName, sessionName, hash] as const,
};

export const conversationKeys = {
  all: ["conversations"] as const,
  list: (projectName: string, sessionName: string) =>
    [...conversationKeys.all, "list", projectName, sessionName] as const,
  messages: (
    projectName: string,
    sessionName: string,
    conversationId: string,
  ) =>
    [
      ...conversationKeys.all,
      "messages",
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

export const commandKeys = {
  all: ["commands"] as const,
  list: (projectName: string, sessionName: string) =>
    [...commandKeys.all, "list", projectName, sessionName] as const,
};
```

## New API Routes

Five new GET routes to expose server-side data for client-side fetching. All follow existing conventions: `withTracing` wrapper, `force-dynamic`, `NextResponse.json`, `ApiError` type for errors.

### 1. `GET /api/config`

**File**: `src/app/api/config/route.ts`
**Handler**: Calls `readConfig()` from `@/lib/config`
**Response**: `{ baseDir: string }`

### 2. `GET /api/projects/preferences`

**File**: `src/app/api/projects/preferences/route.ts`
**Handler**: Calls `getArchivedProjects()` and `getPinnedProjects()` from `@/lib/state`
**Response**: `{ archived: string[], pinned: string[] }` (convert Sets to arrays)

### 3. `GET /api/projects/[name]/sessions/[session]`

**File**: `src/app/api/projects/[name]/sessions/[session]/route.ts`
**Handler**: Resolves project path, calls `getSession(projectPath, sessionName)` from `@/lib/state`
**Response**: `SessionState`
**Error**: 404 if project or session not found

### 4. `GET /api/projects/[name]/sessions/[session]/diff`

**File**: `src/app/api/projects/[name]/sessions/[session]/diff/route.ts`
**Handler**: Resolves project path, gets session, calls `computeDiff(session.worktreePath)` from `@/lib/git`
**Response**: `SessionDiff`

### 5. `GET /api/projects/[name]/sessions/[session]/conversations/[conversationId]/messages`

**File**: `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/messages/route.ts`
**Handler**: Resolves project path, gets session, gets conversation, calls `readConversationMessages(conversation.transcriptPath)` from `@/lib/transcripts`
**Response**: `TranscriptMessage[]`

## Zustand Stores

All stores use Immer middleware. State and actions are typed as separate interfaces. Raw store is never exported — only custom selector/action hooks.

### `src/stores/projects.store.ts`

**State**:
- `statusFilter`: `"all" | "active" | "idle"` (default: `"all"`)
- `showArchived`: `boolean` (default: `false`)
- `openMenuId`: `string | null` (default: `null`)

**Actions** (event names):
- `filterByStatus(status)` — user changed status filter
- `toggleArchived()` — user toggled archived visibility
- `openProjectMenu(id)` — user opened a project's context menu
- `closeProjectMenu()` — user closed context menu / clicked away
- `resetFilters()` — user reset all filters to defaults

**Exported hooks**: `useStatusFilter`, `useShowArchivedProjects`, `useOpenMenuId`, `useFilterByStatus`, `useToggleArchivedProjects`, `useOpenProjectMenu`, `useCloseProjectMenu`, `useResetFilters`

### `src/stores/sessions.store.ts`

**State**:
- `showCreateModal`: `boolean` (default: `false`)
- `deleteTarget`: `{ sessionName: string; projectName: string } | null` (default: `null`)
- `showArchived`: `boolean` (default: `false`)

**Actions**:
- `openCreateModal()` — user clicked "New Session"
- `closeCreateModal()` — user closed create modal
- `confirmDeleteSession(target)` — user clicked delete on a session
- `cancelDeleteSession()` — user canceled delete confirmation
- `toggleArchived()` — user toggled archived sessions visibility

**Exported hooks**: `useShowCreateModal`, `useDeleteTarget`, `useShowArchivedSessions`, `useOpenCreateModal`, `useCloseCreateModal`, `useConfirmDeleteSession`, `useCancelDeleteSession`, `useToggleArchivedSessions`

### `src/stores/conversations.store.ts`

**State**:
- `showArchived`: `boolean` (default: `false`)
- `deleteTargetId`: `string | null` (default: `null`)

**Actions**:
- `toggleArchived()` — user toggled archived conversations
- `requestDeleteConversation(id)` — user requested conversation deletion
- `cancelDeleteConversation()` — user canceled deletion

**Exported hooks**: `useShowArchivedConversations`, `useDeleteTargetConversationId`, `useToggleArchivedConversations`, `useRequestDeleteConversation`, `useCancelDeleteConversation`

### `src/stores/session-detail.store.ts`

**State**:
- `layout`: `LayoutMode` (default: `"default"`)
- `mobilePanel`: `"chat" | "diff"` (default: `"chat"`)
- `sending`: `boolean` (default: `false`)
- `isVoiceRecording`: `boolean` (default: `false`)
- `promptPlaceholder`: `string | null` (default: `null`)
- `promptError`: `string | null` (default: `null`)
- `optimisticMessages`: `TranscriptMessage[]` (default: `[]`)
- `messageCountBeforeSubmit`: `number` (default: `0`)
- `currentMsgIndex`: `number` (default: `0`)
- `showDeleteConfirm`: `boolean` (default: `false`)
- `showCommitDialog`: `boolean` (default: `false`)
- `showMergeDialog`: `boolean` (default: `false`)
- `infoExpanded`: `boolean` (default: `false`)
- `sidebarCollapsed`: `boolean` (default: `false`)

**Actions**:
- `switchLayout(mode, storageKey)` — user changed layout (persists to localStorage)
- `hydrateLayout(storageKey)` — reads layout from localStorage on mount
- `switchMobilePanel(panel)` — user tapped mobile tab
- `submitPrompt(text, currentMessageCount)` — user submitted prompt (sets `sending=true`, creates optimistic user message, stores `messageCountBeforeSubmit`)
- `receiveStreamContent(userText, allBlocks)` — SSE content block arrived (updates optimistic messages with user + assistant)
- `completePrompt()` — stream finished (`sending=false`)
- `failPrompt(error)` — prompt failed (sets `promptError`, `sending=false`)
- `dismissError()` — user dismissed error
- `reconcileMessages(serverCount)` — reconcile optimistic messages when server catches up (called from effect watching query data)
- `navigateToMessage(index)` — user navigated to message index
- `startRecording()` — user started voice recording
- `stopRecording()` — user stopped voice recording
- `showPlaceholder(text)` — command hint shown
- `clearPlaceholder()` — command hint cleared
- `requestCommit()` — user clicked Commit
- `cancelCommit()` — user closed commit dialog
- `requestMerge()` — user clicked Merge
- `cancelMerge()` — user closed merge dialog
- `requestDeleteSession()` — user clicked Delete
- `cancelDeleteSession()` — user closed delete confirm
- `toggleInfoStrip()` — user toggled info strip expansion
- `toggleSidebar()` — user toggled conversation sidebar (persists to localStorage)
- `hydrateSidebar()` — reads sidebar state from localStorage on mount
- `resetStore()` — cleanup on navigation away (resets all transient state to defaults)

**Exported hooks**: One hook per state field and one hook per action. Examples: `useLayout`, `useSending`, `useOptimisticMessages`, `useSubmitPrompt`, `useReceiveStreamContent`, `useSwitchLayout`, `useRequestCommit`, etc.

### Store Implementation Pattern

All stores follow this exact structure:

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// 1. Separate State and Actions interfaces
interface ExampleState {
  count: number;
}

interface ExampleActions {
  incrementCount: () => void;
}

type ExampleStore = ExampleState & ExampleActions;

// 2. Private store — never exported
const useExampleStore = create<ExampleStore>()(
  immer((set) => ({
    count: 0,
    incrementCount: () =>
      set((state) => {
        state.count++;
      }),
  })),
);

// 3. Only export custom hooks
export const useCount = () => useExampleStore((s) => s.count);
export const useIncrementCount = () => useExampleStore((s) => s.incrementCount);
```

## TanStack Query Setup

### Providers Component

File: `src/components/Providers.tsx` — `"use client"` component.

QueryClient config:
- `defaultOptions.queries.staleTime`: `30_000` (30s — dashboard data is semi-fresh)
- `defaultOptions.queries.gcTime`: `300_000` (5min — default)
- `defaultOptions.queries.retry`: `1`
- `defaultOptions.queries.refetchOnWindowFocus`: `true`

Wraps children with `QueryClientProvider`. Create `queryClient` via `useState` to avoid re-creation on re-render (standard Next.js pattern). Include `ReactQueryDevtools` in development.

### Root Layout Update

File: `src/app/layout.tsx` — wrap `{children}` with `<Providers>`. `NotificationListener` stays inside the layout but moves inside the Providers boundary (it needs `useQueryClient`).

## Query Hooks

File: `src/lib/queries.ts`

Each hook wraps `useQuery` with typed key + queryFn. Query functions use `fetch()` → check `res.ok` → return typed JSON.

| Hook | Key Factory | Endpoint | Notes |
|------|-------------|----------|-------|
| `useProjectsQuery()` | `projectKeys.list()` | `GET /api/projects` | |
| `useProjectPreferencesQuery()` | `projectKeys.preferences()` | `GET /api/projects/preferences` | |
| `useConfigQuery()` | `configKeys.all` | `GET /api/config` | |
| `useHooksStatusQuery()` | `hooksKeys.status()` | `GET /api/hooks/status` | |
| `useSessionsQuery(projectName)` | `sessionKeys.list(projectName)` | `GET /api/projects/{name}/sessions` | |
| `useSessionQuery(projectName, sessionName)` | `sessionKeys.detail(projectName, sessionName)` | `GET /api/projects/{name}/sessions/{session}` | |
| `useSessionDiffQuery(projectName, sessionName, opts?)` | `sessionKeys.diff(projectName, sessionName)` | `GET /api/projects/{name}/sessions/{session}/diff` | `refetchInterval: 3000` when active |
| `useCommitsQuery(projectName, sessionName)` | `sessionKeys.commits(projectName, sessionName)` | `GET /api/projects/{name}/sessions/{session}/commits` | |
| `useCommitDiffQuery(projectName, sessionName, hash)` | `sessionKeys.commitDiff(projectName, sessionName, hash)` | `GET /api/projects/{name}/sessions/{session}/commits/{hash}/diff` | `enabled: !!hash` |
| `useConversationsQuery(projectName, sessionName)` | `conversationKeys.list(projectName, sessionName)` | `GET /api/projects/{name}/sessions/{session}/conversations?import=true` | Always auto-imports |
| `useConversationMessagesQuery(projectName, sessionName, conversationId, opts?)` | `conversationKeys.messages(...)` | `GET /api/projects/{name}/sessions/{session}/conversations/{id}/messages` | `refetchInterval: 3000` when active |
| `useCommandsQuery(projectName, sessionName)` | `commandKeys.list(projectName, sessionName)` | `GET /api/projects/{name}/sessions/{session}/commands` | Used by CommandAutocomplete |

### Conditional Polling

For session detail, messages and diff queries accept an options parameter for conditional refetching:

```typescript
// In component:
const sending = useSending();
const session = useSessionQuery(projectName, sessionName);
const isActive = sending || deriveSessionStatus(session.data) === "running";

const messages = useConversationMessagesQuery(projectName, sessionName, conversationId, {
  refetchInterval: isActive ? 3000 : false,
});
const diff = useSessionDiffQuery(projectName, sessionName, {
  refetchInterval: isActive ? 3000 : false,
});
```

## Mutation Hooks

File: `src/lib/mutations.ts`

Each hook wraps `useMutation` with typed variables, calls `tracedFetch`, and invalidates relevant caches on success.

| Hook | Endpoint | Invalidates on Success |
|------|----------|----------------------|
| `useCreateSessionMutation(projectName)` | `POST /api/projects/{name}/sessions` | `sessionKeys.list(projectName)` |
| `useDeleteSessionMutation(projectName)` | `DELETE /api/projects/{name}/sessions?sessionName=...` | `sessionKeys.list(projectName)` |
| `useArchiveSessionMutation(projectName, sessionName)` | `POST /api/projects/{name}/sessions/{session}/archive` | `sessionKeys.list(projectName)` |
| `useArchiveProjectMutation()` | `POST /api/projects/{name}/archive` | `projectKeys.list()`, `projectKeys.preferences()` |
| `usePinProjectMutation()` | `POST /api/projects/{name}/pin` | `projectKeys.preferences()` |
| `useCommitMutation(projectName, sessionName)` | `POST /api/projects/{name}/sessions/{session}/commit` | `sessionKeys.diff(...)`, `sessionKeys.commits(...)` |
| `useMergeMutation(projectName, sessionName)` | `POST /api/projects/{name}/sessions/{session}/merge` | `sessionKeys.detail(...)`, `sessionKeys.list(projectName)` |
| `useCreateConversationMutation(projectName, sessionName)` | `POST /api/projects/{name}/sessions/{session}/conversations` | `conversationKeys.list(...)` |
| `useArchiveConversationMutation(projectName, sessionName)` | `PATCH /api/projects/{name}/sessions/{session}/conversations/{id}/archive` | `conversationKeys.list(...)` |

## Prompt Streaming Hook

File: `src/hooks/use-send-prompt.ts`

This is the most complex piece — it coordinates Zustand (optimistic state), Fetch API (SSE streaming), and TanStack Query (cache invalidation).

```typescript
export function useSendPrompt(
  projectName: string,
  sessionName: string,
  conversationId?: string,
): (text: string, currentMessageCount: number) => Promise<void>
```

**Flow**:
1. Calls `submitPrompt(text, currentMessageCount)` on Zustand store → sets `sending=true`, creates optimistic user message
2. Builds prompt URL (with or without conversationId)
3. Calls `tracedFetch()` with POST
4. If not ok: calls `failPrompt(error)` → early return
5. Gets `ReadableStream` reader, reads SSE events in a loop
6. On `event: content` → parses `MessageContentBlock`, accumulates in local array, calls `receiveStreamContent(userText, allBlocks)` on store
7. On `event: error` → calls `failPrompt(message)`
8. On `event: done` or stream end → calls `completePrompt()`
9. Invalidates TanStack Query caches: `conversationKeys.messages(...)`, `sessionKeys.diff(...)`, `sessionKeys.commits(...)`

### Message Reconciliation

A `useEffect` in `SessionDetailPage` handles reconciliation between server messages (from TanStack Query) and optimistic messages (from Zustand):

```typescript
// In SessionDetailPage component
const messages = useConversationMessagesQuery(...);
const optimistic = useOptimisticMessages();
const sending = useSending();
const countBeforeSubmit = useMessageCountBeforeSubmit();
const reconcile = useReconcileMessages();

useEffect(() => {
  if (optimistic.length === 0) return;
  const serverCount = messages.data?.length ?? 0;
  if (serverCount > countBeforeSubmit) {
    reconcile(serverCount);
  }
}, [messages.data?.length, optimistic.length, sending, countBeforeSubmit]);
```

The `reconcileMessages` action in the store:
- If `sending` is true: drop optimistic user message, keep streaming assistant message
- If `sending` is false: clear all optimistic messages

## Page Transformations

### Pattern

Server pages become thin shells that resolve route params only:

```typescript
// BEFORE (server component with data fetching)
export default async function Page({ params }: Props) {
  const { name } = await params;
  const [data1, data2] = await Promise.all([fetch1(), fetch2()]);
  return <ClientComponent data1={data1} data2={data2} />;
}

// AFTER (server component — thin shell)
export default async function Page({ params }: Props) {
  const { name } = await params;
  return <ClientComponent projectName={name} />;
}
```

Client components receive only route params as props. All data comes from query hooks.

### `/projects` Page

**`page.tsx`**: Remove all `await` calls. Pass no data props. Render `<ProjectsGrid />`.

**`ProjectsGrid.tsx`** (renamed from `ProjectsGridClient.tsx`):
- Props: none (was `projects`, `archivedPaths`, `pinnedPaths`)
- Uses: `useProjectsQuery()`, `useProjectPreferencesQuery()`, `useConfigQuery()`, `useHooksStatusQuery()`
- Uses: `useStatusFilter()`, `useShowArchivedProjects()`, `useOpenMenuId()` from projects store
- Uses: `useArchiveProjectMutation()`, `usePinProjectMutation()` for archive/pin actions
- `searchQuery` stays as `useState` (text input)
- Loading state: show skeleton/spinner while `useProjectsQuery().isPending`
- Hooks status banner: derived from `useHooksStatusQuery().data`
- Filtered/sorted project lists: `useMemo` over query data + store filters (same logic as current)

### `/projects/[name]` Page

**`page.tsx`**: Extract `name` from params only. Render `<SessionsList projectName={name} />`.

**`SessionsList.tsx`**:
- Props: `{ projectName: string }` (was `{ projectName, initialSessions }`)
- Uses: `useSessionsQuery(projectName)`, `useHooksStatusQuery()`
- Uses: sessions store hooks for modal/delete state
- Uses: `useCreateSessionMutation(projectName)`, `useDeleteSessionMutation(projectName)`

### `/projects/[name]/[session]` Page

**`page.tsx`**: Extract `name`, `session` from params. Render `<ConversationList projectName={name} sessionName={session} />`.

**`ConversationList.tsx`**:
- Props: `{ projectName: string; sessionName: string }` (was `{ projectName, session, conversations }`)
- Uses: `useSessionQuery(projectName, sessionName)`, `useConversationsQuery(projectName, sessionName)`
- Uses: conversations store hooks
- Uses: `useCreateConversationMutation(...)`, `useArchiveConversationMutation(...)`

### `/projects/[name]/[session]/[conversationId]` Page

**`page.tsx`**: Extract `name`, `session`, `conversationId` from params. Render `<SessionDetailPage projectName={name} sessionName={session} conversationId={conversationId} />`.

**`SessionDetailPage.tsx`**:
- Props: `{ projectName: string; sessionName: string; conversationId: string }` (was 7 data props)
- Uses: `useSessionQuery(...)`, `useConversationMessagesQuery(...)`, `useSessionDiffQuery(...)`, `useCommitsQuery(...)`, `useConversationsQuery(...)`
- Uses: session-detail store hooks for all UI state
- Uses: `useSendPrompt(...)` hook for prompt submission
- Uses: `useCommitMutation(...)`, `useMergeMutation(...)`, `useDeleteSessionMutation(...)`
- Reconciliation effect for optimistic messages (described above)
- `promptText` stays as `useState` (text input)
- DOM refs (`textareaRef`, `panelBodyRef`, `messageRefs`, `conversationEndRef`, `autocompleteRef`, `voiceRef`) stay as `useRef`
- IntersectionObserver logic stays in component (DOM-specific, not state management)
- Auto-scroll effects stay in component

**Sub-components updated**:
- `ConversationSidebar.tsx` — Uses session-detail store for `sidebarCollapsed` + `useCreateConversationMutation`
- `DiffPanel.tsx` — Receives diff/commits as props from parent (which gets them from queries). `activeTab` and `collapsedFiles` stay as `useState` (local to DiffPanel)
- `CommitHistory.tsx` — `expandedHash`, `loadingHash`, `commitDiff` stay as `useState` (local). Uses `useCommitDiffQuery` for lazy-loading commit diffs
- `CommitDialog.tsx` — `message` and `error` stay as `useState` (form fields). Uses `useCommitMutation`
- `MergeDialog.tsx` — `message` and `error` stay as `useState` (form fields). Uses `useMergeMutation`
- `CommandAutocomplete.tsx` — Uses `useCommandsQuery(...)` instead of manual fetch. `activeIndex` stays as `useState`

### `NotificationListener.tsx`

Add `useQueryClient()` hook. On `session-ready` SSE event, call `queryClient.invalidateQueries({ queryKey: sessionKeys.all })` to refresh session data across all pages.

## Implementation Steps

### Phase 1: Foundation

1. **Install dependencies**: `npm install zustand immer @tanstack/react-query @tanstack/react-query-devtools`
2. **Create `src/components/Providers.tsx`**: Client component with `QueryClientProvider` + `ReactQueryDevtools`. QueryClient created via `useState` with config described above.
3. **Update `src/app/layout.tsx`**: Wrap children with `<Providers>`. Move `NotificationListener` inside Providers boundary.
4. **Create `src/lib/query-keys.ts`**: All key factories as specified above.

### Phase 2: New API Routes

5. **Create `src/app/api/config/route.ts`**: GET handler calling `readConfig()`.
6. **Create `src/app/api/projects/preferences/route.ts`**: GET handler calling `getArchivedProjects()` + `getPinnedProjects()`, converting Sets to arrays.
7. **Create `src/app/api/projects/[name]/sessions/[session]/route.ts`**: GET handler calling `getSession()`.
8. **Create `src/app/api/projects/[name]/sessions/[session]/diff/route.ts`**: GET handler calling `computeDiff()`.
9. **Create `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/messages/route.ts`**: GET handler calling `readConversationMessages()`.

### Phase 3: Query & Mutation Hooks

10. **Create `src/lib/queries.ts`**: All query hooks as specified in the Query Hooks table. Each hook exports a named function.
11. **Create `src/lib/mutations.ts`**: All mutation hooks as specified in the Mutation Hooks table. Each hook uses `tracedFetch` and invalidates caches on success.

### Phase 4: Zustand Stores

12. **Create `src/stores/projects.store.ts`**: State + actions + exported hooks.
13. **Create `src/stores/sessions.store.ts`**: State + actions + exported hooks.
14. **Create `src/stores/conversations.store.ts`**: State + actions + exported hooks.
15. **Create `src/stores/session-detail.store.ts`**: State + actions + exported hooks. Includes localStorage read/write in `switchLayout`, `hydrateLayout`, `toggleSidebar`, `hydrateSidebar` actions.

### Phase 5: Prompt Streaming Hook

16. **Create `src/hooks/use-send-prompt.ts`**: Coordinates Zustand store actions with SSE fetch and TanStack Query cache invalidation as specified above.

### Phase 6: Page Migration (one page at a time)

17. **Migrate `/projects` page**: Simplify `page.tsx`, rename `ProjectsGridClient.tsx` → `ProjectsGrid.tsx`, replace props with query + store hooks. Remove `force-dynamic` from page.
18. **Migrate `/projects/[name]` page**: Simplify `page.tsx`, update `SessionsList.tsx` to use query + store hooks.
19. **Migrate `/projects/[name]/[session]` page**: Simplify `page.tsx`, update `ConversationList.tsx` to use query + store hooks.
20. **Migrate `/projects/[name]/[session]/[conversationId]` page**: Simplify `page.tsx`, update `SessionDetailPage.tsx` and all sub-components (`ConversationSidebar`, `DiffPanel`, `CommitHistory`, `CommitDialog`, `MergeDialog`).
21. **Update `NotificationListener.tsx`**: Add `useQueryClient` and cache invalidation on SSE events.
22. **Update `CommandAutocomplete.tsx`**: Replace manual fetch with `useCommandsQuery`.

### Phase 7: Cleanup & Verification

23. **Remove unused imports**: Clean up server-side data fetching imports from page files. Remove `force-dynamic` from pages that no longer need it (pages are now thin shells).
24. **Run typecheck**: `bun run typecheck` — fix all TypeScript errors.
25. **Run tests**: `bun run test:run` — fix any failures. Update existing tests that depend on the old data-fetching pattern.

## Error Handling

- **Query errors**: Components check `query.isError` and display error UI. No global error boundary for queries.
- **Mutation errors**: Handled in `onError` callback of each mutation. Display via component-local state or existing error patterns.
- **Prompt streaming errors**: Handled by `failPrompt(error)` Zustand action → `promptError` state displayed in SessionDetailPage.
- **API route errors**: Follow existing pattern: `NextResponse.json({ error: message } satisfies ApiError, { status: code })`.

## Testing

- **Stores**: Test directly via `store.getState()` and action calls. Reset between tests with `store.setState(initialState)`. Place test files in `src/stores/*.test.ts`.
- **Query/mutation hooks**: Test with `@tanstack/react-query` test utilities (QueryClient wrapper). Place in `src/lib/queries.test.ts` and `src/lib/mutations.test.ts`.
- **Existing tests**: Update any tests that import from modified files. API route tests in `src/lib/` should not need changes (routes are additive).
