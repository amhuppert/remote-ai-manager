# Tasks: File Autocomplete

## Task 1: Define schemas, types, and query keys
- [x] Add `fileItemSchema` and `projectFilesResponseSchema` to `src/lib/files/schemas.ts`
- [x] Types `FileItem` and `ProjectFilesResponse` are derived via `z.infer` from `src/lib/files/schemas.ts`
- [x] Add `fileKeys` to `src/lib/files/query-keys.ts`

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
- [ ] Wire FileAutocomplete into focus mode prompt
  > **Not implemented:** no focus-mode dialog wires in file autocomplete. Only the conversation prompt area (Task 6, via `PromptEditorFileMentionPopup`) is integrated.

## Task 8: Integration — Optimistic dialog
- [ ] Wire FileAutocomplete into OptimisticDialog
  > **Not implemented:** `OptimisticDialog` does not exist (see optimistic-mode task 4.2); this integration point was never built.

## Task 9: Final validation
- [x] Run full test suite and typecheck
- [x] Fix any failures
