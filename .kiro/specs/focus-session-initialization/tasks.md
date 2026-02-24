# Implementation Plan

## Tasks

- [x] 1. Add conversation role to data model
- [x] 1.1 Add `conversationRoleSchema` and `role` field to `conversationStateSchema` in `src/lib/schemas.ts`
  - Define `conversationRoleSchema` as `z.enum(["initialization"]).nullable().default(null)`
  - Add `role: conversationRoleSchema` to `conversationStateSchema`
  - Export `ConversationRole` type
  - _Requirements: 1_
- [x] 1.2 Re-export `ConversationRole` from `src/types/index.ts`
  - _Requirements: 1_
- [x] 1.3 Update test helpers in all test files to include `role: null` in conversation objects
  - Update `SessionsList.test.tsx`, `SessionDetailPage.test.tsx`, `conversations.test.ts`, `prompt.test.ts`
  - _Requirements: 1_

- [x] 2. Set role during session provisioning
- [x] 2.1 Update `provisionSession` in `src/lib/sessions.ts` to set `role: "initialization"` for focus sessions and `role: null` for fast sessions
  - _Requirements: 1_
- [x] 2.2 Update `createConversation` in `src/lib/conversations.ts` to accept optional `role` parameter
  - Add `opts?: { role?: ConversationRole }` parameter
  - Set `role: opts?.role ?? null` on created conversation
  - _Requirements: 1_

- [x] 3. Split prompt templates into two phases
- [x] 3.1 Refactor `getUnderstandObjectivePrompt` in `src/lib/prompt-templates.ts` to cover only research and Q&A (Steps 1-3)
  - Add explicit instruction: "Do NOT write focus.md"
  - _Requirements: 2_
- [x] 3.2 Create `getWriteFocusDocumentPrompt` in `src/lib/prompt-templates.ts` for the document-writing phase
  - Template includes focus.md structure (Objective, Detailed Requirements, Key Design Decisions, Implementation Approach, Relevant Patterns)
  - Instruct "Write the file and nothing else. Do NOT begin any implementation work."
  - _Requirements: 2_

- [x] 4. Implement finalize initialization domain logic
- [x] 4.1 Add `finalizeInitialization` function in `src/lib/conversations.ts`
  - Find conversation with `role === "initialization"`, archive it
  - Create new conversation with `role: null`
  - Persist state atomically
  - Return `{ conversationId, name }`
  - _Requirements: 5, 6_

- [x] 5. Create finalize initialization API endpoint
- [x] 5.1 Create `src/app/api/projects/[name]/sessions/[session]/finalize-initialization/route.ts`
  - POST handler: validate project/session exist, validate focus mode, call `finalizeInitialization`, return result
  - Return 400 if not focus session, 404 if not found, 500 on error
  - _Requirements: 7_

- [x] 6. Create client mutation hook
- [x] 6.1 Add `useFinalizeInitializationMutation` in `src/lib/mutations.ts`
  - POST to finalize-initialization endpoint
  - On success: invalidate conversation list and session detail queries
  - _Requirements: 6, 7_

- [x] 7. Create FocusConfirmationBar component (P)
- [x] 7.1 Create `src/components/FocusConfirmationBar.tsx`
  - Props: `onConfirm`, `disabled`, `loading`
  - Default state: "Satisfied with the understanding?" + "Confirm & Continue" button
  - Loading state: "Writing focus document..." + spinner
  - _Requirements: 3_
- [x] 7.2 Create `src/components/FocusConfirmationBar.stories.tsx` with Default, Disabled, Loading stories
  - _Requirements: 3_
- [x] 7.3 Add `.focus-confirm-bar` CSS styles in `src/app/globals.css`
  - Flexbox layout, border-top separator, mono font text, design system tokens
  - _Requirements: 3_

- [x] 8. Integrate confirmation flow into SessionDetailPage
- [x] 8.1 Add initialization detection logic in `src/app/projects/[name]/[session]/SessionDetailPage.tsx`
  - Derive `isInitConversation` from `activeConversation.role === "initialization"`
  - Add `focusConfirmLoading` state
  - _Requirements: 3_
- [x] 8.2 Implement `handleConfirmFocus` handler
  - Send write-focus-document prompt via `sendPrompt`
  - Call `finalizeMutation.mutateAsync()` on success
  - Navigate to new conversation via `router.push`
  - Handle errors via `failPrompt`
  - _Requirements: 4, 5, 6_
- [x] 8.3 Render `FocusConfirmationBar` conditionally above prompt input
  - Show when: `isInitConversation && !pendingQuestions && !isBusy && promptCount > 0`
  - Disable when: `isFinished`
  - _Requirements: 3_

- [x] 9. Add unit tests for finalize initialization
- [x] 9.1 Test `finalizeInitialization` in `src/lib/conversations.test.ts`
  - Test: archives init conversation, creates new regular conversation
  - Test: throws when no init conversation found
  - _Requirements: 5, 6_
- [x] 9.2 Test prompt template outputs in `src/lib/prompt-templates.test.ts`
  - Verify `getUnderstandObjectivePrompt` contains "Do NOT write focus.md"
  - Verify `getWriteFocusDocumentPrompt` contains focus.md structure
  - _Requirements: 2_
