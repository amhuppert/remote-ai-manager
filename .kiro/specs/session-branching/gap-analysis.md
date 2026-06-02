# Gap Analysis: Session Branching

## Requirement-to-Asset Map

| Requirement | Existing Assets | Gap |
|---|---|---|
| **R1: Session State Schema** | `sessionStateSchema` in `src/lib/sessions/schemas.ts:540-555` has all session fields but lacks `targetBranch` and `parentSessionName` | **Missing**: Two new fields with Zod `.default()` |
| **R2: Create Session Request** | `createSessionRequestSchema` in `src/lib/sessions/schemas.ts:675-692` — discriminated union with `fast`, `focus`, `optimistic` modes; no parent session field | **Missing**: Optional `parentSessionName` field on each variant |
| **R3: Child Session Provisioning** | `provisionSession()` in `src/lib/sessions.ts:202-280` creates worktree with `git worktree add -b <branch> <path> main`; always uses `main` as base | **Missing**: `baseBranch` parameter; parent session lookup; setting `targetBranch`/`parentSessionName` on new state |
| **R4: Git Operations** | `src/lib/git-operations.ts` — `getCommitLog`, `getCommitDiff`, `mergeMainIntoFeature`, `isBranchAncestorOfMain`, `isBranchMentionedInMainLog`, `squashMerge` all hardcode `"main"` | **Missing**: `targetBranch` parameter on each function (6 functions total) |
| **R5: Merge Workflow** | `MergeInput` in `types.ts:83-96`, `MergeContext` in `types.ts:23-80`, `MergeMainInput` in `actors.ts:31-33`, `SquashMergeInput` in `actors.ts:80-83` — no `targetBranch` field | **Missing**: `targetBranch` field on all merge types; threading through machine; squash merge worktree resolution |
| **R6: Orphan Handling** | No existing orphan detection. Session deletion is in `deleteSession()` (`sessions.ts`). Session finish marking happens in merge actors and merge detection. | **Missing**: Entirely new capability — retarget child sessions on parent merge/delete |
| **R7: UI Dynamic Branch Refs** | 12+ locations with hardcoded `"main"` strings across `SmartMergeDialog`, `MergeDialog`, `MergeToast`, `SessionDetailPage`, `ConversationList`, `MobileActionMenu`, `OptimisticDialog`, `CreateSessionModal` | **Missing**: All UI components need to read `targetBranch` from session state and display it dynamically |

## Existing Patterns to Leverage

### Schema-First with Zod Defaults (Backward Compatibility)
The `forkedFromSchema` (`src/lib/sessions/schemas.ts:176-186`) demonstrates the pattern for nullable fields with `.default(null)`. The `sessionStateSchema` already uses `.default()` extensively — adding `targetBranch: z.string().default("main")` and `parentSessionName: z.string().nullable().default(null)` follows the exact same convention. No migration needed.

### DI Service Pattern (Testing)
`createGitOperationsService()` and `createSessionService()` both use the factory pattern for DI. Adding a `targetBranch` parameter to git operation functions and `baseBranch` to `provisionSession()` fits naturally. Tests can inject deps without `vi.mock()`.

### Conversation `forkedFrom` (Parent Tracking Precedent)
`forkedFrom` on `conversationStateSchema` tracks source conversation for forked conversations. Session-level `parentSessionName` follows an analogous pattern — a simpler string reference rather than a structured object, since session names are unique within a project.

### Merge Machine Actor Inputs
Each merge actor has explicit `Input`/`Output` interfaces. Adding `targetBranch` to `MergeMainInput`, `SquashMergeInput`, and `ResolveConflictsInput` is straightforward. The machine assigns actor inputs from context, so `targetBranch` flows from `MergeInput` → `MergeContext` → actor inputs.

### Background Job Dispatch
`dispatchMergeJob()` constructs `MergeInput` from route parameters. The merge and resolve-conflicts API routes already read session state — adding `targetBranch: session.targetBranch ?? "main"` to the dispatch call is minimal.

## Implementation Approach

### Recommended: Option A — Extend Existing Components
This feature is a natural extension of existing structures. No new files or modules are needed.

**Rationale**:
- All changes add a `targetBranch` parameter to existing functions/types
- Schema changes are additive with backward-compatible defaults
- Orphan handling is a small addition to existing session finish/delete flows
- UI changes are string interpolation updates in existing components

**Files requiring changes** (ordered by dependency):

1. `src/lib/sessions/schemas.ts` — Add `targetBranch`, `parentSessionName` to session schema; add optional fields to creation request
2. Types are auto-derived via `z.infer` from the domain's `src/lib/sessions/schemas.ts` — no changes needed
3. `src/lib/git-operations.ts` — Add `targetBranch` param (default `"main"`) to 6 functions; rename `mergeMainIntoFeature` → `mergeTargetIntoFeature`
4. `src/lib/sessions.ts` — Add `baseBranch` to `provisionSession()`; parent session lookup; set new fields
5. `src/lib/workflows/merge/types.ts` — Add `targetBranch` to `MergeInput`, `MergeContext`
6. `src/lib/workflows/merge/actors.ts` — Add `targetBranch` to actor input types; thread to git operations
7. `src/lib/workflows/merge/machine.ts` — Thread `targetBranch` from input to context to actor invocations
8. `src/lib/background-jobs.ts` — Include `targetBranch` in merge/resolve-conflicts dispatch
9. `src/lib/optimistic.ts` — Thread `targetBranch` through optimistic merge flow
10. `src/lib/merge-detection.ts` — Use `targetBranch` for detection checks
11. API routes (merge, resolve-conflicts, session creation) — Read/pass `targetBranch`
12. UI components (8+ files) — Replace hardcoded `"main"` with `targetBranch`

**Trade-offs**:
- (+) No new files, minimal structural change
- (+) Leverages all existing patterns
- (+) Backward compatible via Zod defaults
- (-) Many files touched (20+), needs careful threading

## Complexity & Risk

**Effort: M (3–7 days)** — Many files but each change is mechanical (add parameter, replace hardcoded string). The squash merge worktree resolution and orphan handling require more thought.

**Risk: Medium** — The merge workflow is well-tested with XState machine tests. Adding `targetBranch` threading is straightforward but requires careful attention to ensure no hardcoded `"main"` is missed. The squash merge into a non-main target (running in parent worktree) is the highest-risk area — needs careful error handling for cases where the parent worktree no longer exists.

## Research Needed (for Design Phase)

1. **Squash merge in parent worktree**: Verify that the parent session's worktree is guaranteed to be on the target branch when child merges. Consider lock acquisition order.
2. **Merge detection with non-main targets**: `merge-detection.ts` periodically checks if branches are merged into main. Needs to check against `targetBranch` instead — confirm approach.
3. **Multi-level nesting**: Clarify if grandchild sessions (child of a child) are in scope. Orphan retargeting to `"main"` only handles one level — deeper chains may need cascading retarget.
