# Gap Analysis: Smart Merge

## Analysis Summary

- **Scope**: 9 requirements spanning backend infrastructure (background jobs, two-phase merge, conflict resolution via Claude SDK) and frontend integration (async dialogs, toasts, notifications panel, conflict review page)
- **Starting Point**: UI prototypes for all 4 new components already exist (SmartMergeDialog, MergeConflictsPage, MergeToast, NotificationsPanel) but none are wired to backend logic or SSE events
- **Core Gap**: No background job infrastructure exists — all git operations (commit, merge) are synchronous and block the API response. This is the foundational piece everything else depends on.
- **SSE Foundation**: A working SSE broadcaster exists (`sse-broadcaster.ts`) with global event subscription (`/api/events`), but only carries `conversation-status` and `ask-question` events. Needs extension for `job-status` events.
- **Conflict Resolution**: Current merge aborts on conflict and cleans up. The two-phase strategy and Claude-powered resolution are entirely new capabilities.

---

## Requirement-to-Asset Map

### Requirement 1: Two-Phase Merge Strategy

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Merge main → feature branch (in worktree) | None — `squashMerge()` only does feature → main | **Missing**: New `git merge main` operation in the session worktree |
| Leave worktree in conflict state | `squashMerge()` runs `merge --abort` + `reset --hard` on conflict | **Constraint**: Must reverse current abort-on-conflict behavior |
| Report conflicting files | Conflict detected via stderr string matching only | **Missing**: Parse `git diff --name-only --diff-filter=U` to list conflicted files |
| Proceed to squash merge after success | `squashMerge()` in `git-operations.ts` | Exists — reusable after phase 1 succeeds |
| Report merge commit hash | `squashMerge()` already returns `{ mergeHash }` | Exists |

**Key files to modify**: `src/lib/git-operations.ts` (new `mergeMainIntoFeature()` function, modify `squashMerge()` pipeline)

### Requirement 2: Asynchronous Merge Operations

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Fire-and-forget merge API | `POST .../merge` route is synchronous, blocks until complete | **Missing**: Background job dispatch + immediate 202 response |
| Session lock during background job | `acquireSessionLock()` in `lock.ts` | Exists — but `release()` must be called from background job completion, not route handler |
| SSE broadcast on completion | `broadcast()` in `sse-broadcaster.ts` | **Missing**: New `job-status` SSE event type |
| Toast notification on completion | `MergeToast.tsx` (UI-only) | **Missing**: Client-side SSE listener → toast rendering pipeline |
| Navigate away while merge runs | Current dialog blocks and navigates on success | **Missing**: SmartMergeDialog wiring (stub `handleSubmit` exists) |

**Key files to modify**: `src/app/api/.../merge/route.ts`, `src/lib/sse-broadcaster.ts` (or schemas), `src/components/NotificationListener.tsx`
**Key files to create**: `src/lib/background-jobs.ts` (job registry)

### Requirement 3: Asynchronous Commit Operations

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Fire-and-forget commit API | `POST .../commit` route is synchronous | **Missing**: Same background job dispatch as merge |
| Session lock during background job | `acquireSessionLock()` | Exists — same extension as Req 2 |
| SSE broadcast on completion | `broadcast()` | **Missing**: Same `job-status` event extension |
| Toast notification | `MergeToast.tsx` covers merge only | **Missing**: Commit toast variant (or generalize MergeToast → JobToast) |

**Key files to modify**: `src/app/api/.../commit/route.ts`
**Reuses**: Background job infrastructure from Req 4

### Requirement 4: Background Job Infrastructure

| Need | Existing Asset | Gap |
|------|---------------|-----|
| In-memory job registry | None | **Missing**: New module with `globalThis` storage (follows `sse-broadcaster.ts` pattern) |
| Job lifecycle states (pending → running → completed/failed/conflicts) | None | **Missing**: Job state machine |
| `job-status` SSE event | `SSEEvent` union type has 2 variants | **Missing**: Third variant `JobStatusEvent` in schemas |
| Prevent concurrent jobs per session | `isSessionBusy()` checks prompt lock only | **Constraint**: Must integrate job lock with existing session lock, or share the same lock |
| Release lock on job completion | `acquireSessionLock()` returns sync `release()` function | **Constraint**: Release function must be callable from async background context |

**Key files to create**: `src/lib/background-jobs.ts`
**Key files to modify**: `src/lib/schemas.ts` (new event type), `src/lib/lock.ts` (may need to extend for background job compatibility)

### Requirement 5: Auto-Resolve Conflicts Toggle

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Toggle in merge dialog | `SmartMergeDialog.tsx` already has toggle UI (on by default) | Exists — UI complete |
| Auto-invoke Claude on conflicts | None — conflicts currently abort | **Missing**: Pipeline logic: detect conflicts → invoke Claude → commit resolution → continue merge |
| Fall back to manual on Claude failure | None | **Missing**: Error handling branch in merge pipeline |
| Commit resolution and continue merge | None | **Missing**: `git add -A` + `git commit` after Claude resolves, then proceed to squash merge |

**Key files to modify**: Merge pipeline (new function or extension of two-phase merge)

### Requirement 6: Conflict Analysis with Claude Code

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Invoke Claude Agent SDK `query()` for conflict resolution | `executePromptStream()` in `prompt.ts` | **Partial**: Exists but designed for interactive streaming to UI; conflict resolution needs a fire-and-forget variant that captures structured output |
| Structured output (file, description, resolution, rationale) | None | **Missing**: Conflict resolution prompt template + output parsing |
| Store results via conflicts API | None | **Missing**: API endpoint + in-memory or file-based storage for conflict analysis results |
| Resolve conflict markers in working tree | None | **Missing**: Part of the Claude prompt instructions |

**Research Needed**:
- How to extract structured JSON from Claude Agent SDK `query()` responses (the SDK returns `SDKMessage` stream — need to parse assistant text for JSON)
- Whether to use a separate `query()` call with `maxTurns: 1` or allow multi-turn tool use for conflict resolution
- The existing `fix-merge-conflicts` skill prompt — adapt for programmatic use

**Key files to create**: `src/lib/conflict-resolution.ts` (or extend `git-operations.ts`)
**Key files to modify**: `src/lib/schemas.ts` (conflict analysis result schema)

### Requirement 7: Manual Conflict Review Page

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Full-page conflict review UI | `MergeConflictsPage.tsx` (complete UI) | Exists — but not routed or data-connected |
| Per-conflict approve/reject | Component has toggle buttons + feedback textarea | Exists |
| Summary banner | Component has approved/rejected/pending counts | Exists |
| "Accept All and Fix" action | `onAcceptAll` callback prop (not wired) | **Missing**: API integration |
| "Fix with Claude" action | `onFixApproved` callback prop (not wired) | **Missing**: API integration |
| Navigate away without losing progress | No route or state management | **Missing**: Next.js `page.tsx` route, conflict state storage (server-side), client data fetching |

**Key files to create**: `src/app/projects/[name]/[session]/conflicts/page.tsx` (route)
**Key files to modify**: Wire `MergeConflictsPage.tsx` to API data

### Requirement 8: Notifications Panel

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Slide-in panel UI | `NotificationsPanel.tsx` (complete UI) | Exists |
| Conversations + Jobs sections | Component supports both section types | Exists |
| Topbar trigger button | Existing unified panel toggle button | **Constraint**: Must decide — replace UnifiedPanel, add second button, or merge both panels |
| Real-time SSE updates | `NotificationListener.tsx` listens for `conversation-status` | **Missing**: Extend listener for `job-status` events, feed data to NotificationsPanel |
| Badge count | Topbar shows active conversation count | **Missing**: Include job count in badge |

**Key files to modify**: `src/components/NotificationListener.tsx`, `src/components/Topbar.tsx`, `src/app/layout.tsx`

### Requirement 9: Smart Merge Dialog

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Dialog with branch info + message + toggle | `SmartMergeDialog.tsx` (complete UI) | Exists |
| Uncommitted changes warning | Component shows warning based on `hasUncommittedChanges` prop | Exists |
| Submit → background job | `handleSubmit` is a stub | **Missing**: API call to async merge endpoint |
| Submitted confirmation state | Component has two-state UI | Exists |
| Cmd/Ctrl+Enter to submit | Component supports keyboard shortcut | Exists |
| Replace old MergeDialog | `SessionDetailPage.tsx` renders old `MergeDialog` | **Missing**: Swap MergeDialog → SmartMergeDialog in SessionDetailPage |

**Key files to modify**: `src/app/projects/[name]/[session]/SessionDetailPage.tsx`

---

## Implementation Approach Options

### Option A: Extend Existing Components

**Strategy**: Add background job logic directly into existing route handlers and extend `sse-broadcaster.ts` / `lock.ts`.

- Merge route handler spawns a `Promise` (not awaited), stores it in a module-level Map
- Extend `SSEEvent` union with `JobStatusEvent`
- Extend `NotificationListener.tsx` to handle `job-status` events

**Trade-offs**:
- ✅ Minimal new files, fast to implement
- ✅ Leverages existing locking and broadcast patterns
- ❌ Route handlers become complex (sync response + async background work)
- ❌ Job state management mixed into route files

### Option B: Create New Background Job Module

**Strategy**: New `src/lib/background-jobs.ts` module owns all job lifecycle, separate from route handlers. Routes dispatch to the job system, which owns execution, state tracking, and SSE broadcasting.

- `background-jobs.ts`: job registry (globalThis Map), `startMergeJob()`, `startCommitJob()`, state transitions, broadcast on transition
- Routes become thin dispatchers: validate → dispatch job → return 202
- Conflict resolution in dedicated `src/lib/conflict-resolution.ts`
- Two-phase merge logic as a new function in `git-operations.ts`

**Trade-offs**:
- ✅ Clean separation: routes validate, jobs execute, broadcaster notifies
- ✅ Job state machine is testable in isolation
- ✅ Matches existing `globalThis` singleton pattern (sse-broadcaster, question-registry, abort-registry)
- ❌ More new files
- ❌ Requires careful lock coordination between job system and existing session lock

### Option C: Hybrid — New Job Module + Extend Existing

**Strategy**: New `background-jobs.ts` for job lifecycle, but reuse existing `acquireSessionLock()` directly (jobs acquire the lock, hold it during execution, release on completion). Extend existing SSE infrastructure rather than creating parallel channels.

- Background jobs acquire the same session lock as prompts — prevents job + prompt concurrency automatically
- Extend `SSEEvent` union type (not a new broadcast channel)
- Extend `NotificationListener.tsx` (not a new listener)
- New `conflict-resolution.ts` for Claude-powered resolution
- New `mergeMainIntoFeature()` in `git-operations.ts`

**Trade-offs**:
- ✅ Balanced: new module for new concept, extensions for existing infrastructure
- ✅ Lock unification means no concurrent job + prompt races by default
- ✅ Single SSE channel, single listener — no duplication
- ❌ Must verify lock semantics work for long-running background tasks (lock was designed for prompt duration)

---

## Effort and Risk Assessment

**Effort: L (1–2 weeks)**
Justification: 9 requirements spanning backend infrastructure (background jobs, two-phase merge pipeline, Claude SDK integration for conflict resolution), SSE extension, and frontend wiring of 4 new components. The UI prototypes significantly reduce frontend effort, but the backend pipeline (especially async job lifecycle + conflict resolution via Claude) is substantial.

**Risk: Medium**
Justification:
- The SSE broadcaster and session lock are proven patterns — extending them is low risk
- Two-phase merge is straightforward git operations — low risk
- Background job infrastructure is a new pattern but follows existing `globalThis` singleton approach — medium risk
- Claude-powered conflict resolution is the highest uncertainty: parsing structured output from the SDK, handling partial resolution failures, and ensuring no work is lost — medium-high risk for this piece specifically

---

## Recommendations for Design Phase

### Preferred Approach
**Option C (Hybrid)** — Create a new `background-jobs.ts` module for job lifecycle management while extending existing SSE and lock infrastructure. This provides clean separation for the new concept without duplicating existing patterns.

### Key Design Decisions Needed

1. **Lock sharing**: Should background jobs use `acquireSessionLock()` directly, or should there be a separate job-level lock? (Recommendation: share the same lock — simplest, prevents all concurrency issues)

2. **Job state storage**: In-memory only (lost on server restart) vs. persisted to state.json? (Recommendation: in-memory with SSE replay — jobs are short-lived, and `recoverStaleConversations()` pattern can be adapted for stale jobs)

3. **Conflict resolution output**: How to extract structured JSON from Claude's response — parse from assistant text, use a tool-based approach, or use system prompt constraints? (Research needed — check SDK capabilities)

4. **NotificationsPanel vs. UnifiedPanel**: Merge into a single panel, or keep separate? Both show real-time activity. (Design decision — impacts Topbar button layout)

5. **Commit async transition**: Should commit also become fully async (fire-and-forget with SSE notification), or only merge? Requirements say both, but commit is typically fast. (Requirements say both — implement both)

### Research Items for Design Phase

- **Claude Agent SDK structured output**: How to reliably get JSON-structured conflict analysis from `query()`. Options: system prompt with JSON schema, tool-based extraction, or post-processing of assistant text.
- **Existing `fix-merge-conflicts` skill**: Read and adapt the skill prompt for programmatic use in conflict resolution.
- **Pre-commit hook duration**: Understand typical durations to set appropriate timeouts for background commit jobs.
- **Job cancellation**: Whether background merge/commit jobs should be cancellable (requirements don't mention it, but it's a natural UX expectation).
