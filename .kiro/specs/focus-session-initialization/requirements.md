# Requirements Document

## Introduction
This specification covers the focus session initialization flow improvement for CSM (Claude Session Manager). The goal is to transform focus mode session creation from a single monolithic prompt into a structured multi-step flow with explicit user confirmation. The initialization conversation — where Claude researches the objective and asks clarifying questions — is treated as a distinct phase. A confirmation bar lets the user signal satisfaction, after which the focus document is written, the initialization conversation is archived, and the user is navigated to a fresh regular conversation.

## Requirements

### Requirement 1: Initialization Conversation Role Identification
**Objective:** As a developer, I want the system to distinguish the initialization conversation from regular conversations, so that the UI can apply special behavior to it.

#### Acceptance Criteria
1. When a focus session is created, CSM shall mark the first conversation with a role of "initialization".
2. When a non-focus (fast) session is created, CSM shall set the conversation role to null.
3. The ConversationState schema shall include a `role` field that accepts "initialization" or null.

### Requirement 2: Two-Phase Prompt Execution
**Objective:** As a developer, I want the initialization prompt to be split into research/Q&A and document-writing phases, so that the user can confirm understanding before the focus document is written.

#### Acceptance Criteria
1. When a focus session's initialization conversation starts, CSM shall send only the "understand objective" prompt (research, ask questions, present summary).
2. While the understand-objective prompt is executing, CSM shall not write the focus.md document.
3. The system shall provide a separate "write focus document" prompt that can be triggered independently after user confirmation.

### Requirement 3: Focus Confirmation Bar
**Objective:** As a user, I want a confirmation bar to appear after Claude finishes its research, so that I can explicitly confirm I'm satisfied with its understanding before proceeding.

#### Acceptance Criteria
1. When the active conversation has role "initialization" and the conversation is not busy and has at least one completed prompt, CSM shall display a confirmation bar.
2. While a blocking question (AskUserQuestion) is pending, CSM shall hide the confirmation bar.
3. The confirmation bar shall display the text "Satisfied with the understanding?" and a "Confirm & Continue" button.
4. While the session is in a finished state, CSM shall disable the confirmation button.

### Requirement 4: Focus Document Writing on Confirmation
**Objective:** As a user, I want the focus.md document to be written automatically when I press the confirm button, so that the enriched understanding is persisted for future conversations.

#### Acceptance Criteria
1. When the user clicks "Confirm & Continue", CSM shall send the "write focus document" prompt to the initialization conversation.
2. While the focus document prompt is executing, the confirmation bar shall display a loading state with the text "Writing focus document..." and a spinner.
3. While the focus document prompt is executing, the confirm button shall be disabled.

### Requirement 5: Initialization Conversation Archival
**Objective:** As a user, I want the initialization conversation to be hidden after confirmation, so that it no longer clutters the conversation list.

#### Acceptance Criteria
1. When the focus document has been written successfully, CSM shall archive the initialization conversation (set archived to true).
2. When the initialization conversation is archived, CSM shall not display it in the conversation sidebar unless archived conversations are shown.

### Requirement 6: Navigation to New Conversation
**Objective:** As a user, I want to be automatically navigated to a fresh regular conversation after the initialization flow completes, so that I can begin working immediately.

#### Acceptance Criteria
1. When the initialization conversation is archived, CSM shall create a new conversation with role null.
2. When the new conversation is created, CSM shall navigate the user to it automatically.
3. The new conversation shall have no special role or initialization behavior.

### Requirement 7: Finalize Initialization API
**Objective:** As a developer, I want a single API endpoint that atomically archives the initialization conversation and creates a new regular conversation, so that the client-side flow is reliable and consistent.

#### Acceptance Criteria
1. The system shall expose a POST endpoint at `/api/projects/[name]/sessions/[session]/finalize-initialization`.
2. When called, the endpoint shall find the conversation with role "initialization" and archive it.
3. When called, the endpoint shall create a new regular conversation and return its ID and name.
4. If no initialization conversation is found, the endpoint shall return a 404 error.
5. If the session is not a focus session, the endpoint shall return a 400 error.
