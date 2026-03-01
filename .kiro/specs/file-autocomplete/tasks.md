# Tasks: File Autocomplete

## Task 1: Define schemas, types, and query keys
- [x] Add `fileItemSchema` and `projectFilesResponseSchema` to `src/lib/schemas.ts`
- [x] Re-export `FileItem` and `ProjectFilesResponse` types from `src/types/index.ts`
- [x] Add `fileKeys` to `src/lib/query-keys.ts`

## Task 2: File scanner utility (TDD)
- [x] Write tests in `src/lib/file-scanner.test.ts`
- [x] Implement `scanProjectFiles()` in `src/lib/file-scanner.ts`

## Task 3: API route (TDD)
- [x] Write tests in `src/lib/files-route.test.ts`
- [x] Implement `GET /api/projects/[name]/files/route.ts`

## Task 4: React Query hook
- [x] Add `useProjectFilesQuery()` to `src/lib/queries.ts`

## Task 5: @-trigger detection hook (TDD)
- [x] Write tests for trigger detection
- [x] Implement `useFileAutocompleteTrigger` hook

## Task 6: Integration — Conversation prompt
- [x] Wire FileAutocomplete into SessionDetailPage prompt area

## Task 7: Integration — Focus mode dialog
- [x] Wire FileAutocomplete into focus mode prompt

## Task 8: Integration — Optimistic dialog
- [x] Wire FileAutocomplete into OptimisticDialog

## Task 9: Final validation
- [x] Run full test suite and typecheck
- [x] Fix any failures
