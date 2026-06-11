# Requirements Document

## Introduction

Command Center's commit and smart-merge flows are currently triggered from Git-panel buttons outside any conversation, and their commit messages are either hand-typed by the user (standalone commit) or meaningless auto-generated text (smart merge's `"Merge X into Y"` squash message). This feature moves both triggers into the conversation as slash commands — `/commit` and `/merge` — and has the conversation's agent write the commit message, exploiting the context the implementing agent already holds. The agent's role is strictly limited to producing the message; staging, committing, validation, conflict handling, and publication remain Command Center's deterministic background flows, unchanged.

## Boundary Context

- **In scope**: recognizing `/commit [hint…]` and `/merge [hint…]` in session conversations; an in-conversation agent turn that produces the commit message; handing the generated message to the existing commit and smart-merge background flows; fallback to a default message when generation fails; removal of the Commit/Merge trigger buttons and their dialogs; listing both commands in the conversation editor's command autocomplete.
- **Out of scope**: any behavioral change to the background commit and smart-merge flows themselves (validation, automatic fixes, conflict resolution, prepare/publish, ready-to-land/land/discard handling, session finalization); agent-written messages for intermediate merge commits (uncommitted-changes, conflict-resolution, and validation-fix commits keep their existing fixed messages); per-invocation merge options (no auto-resolve toggle or flags); merges initiated by graph workflows.
- **Adjacent expectations**: the existing background job system continues to report job progress, completion, failure, and history exactly as today; the conflict-review and ready-to-land user flows remain reachable and unchanged when a merge ends in those states.

## Requirements

### Requirement 1: /commit command in session conversations

**Objective:** As a Command Center user, I want to commit my session's changes by typing `/commit` in the conversation, so that committing happens where the work happened and benefits from that context.

#### Acceptance Criteria

1. When a user submits a message beginning with `/commit` in a session conversation, Command Center shall initiate the commit flow for that session's worktree instead of forwarding the message to the agent as a normal prompt.
2. When `/commit` is followed by trailing text, Command Center shall treat that text as guidance for commit-message generation and shall not use it verbatim as the commit message.
3. When the commit flow is initiated, Command Center shall commit all changes in the session worktree through the existing background commit flow, including its post-commit validation and automatic fix behavior.
4. If the session worktree has no uncommitted changes when `/commit` is submitted, Command Center shall inform the user in the conversation and shall not start a message-generation turn or a commit job.
5. If `/commit` is submitted in a conversation that has no associated session worktree, Command Center shall reject the command with an explanatory message in the conversation.
6. If `/commit` is submitted for a finished session, Command Center shall reject the command with an explanatory message in the conversation.
7. If a commit, merge, or conflict-resolution background job is already active for the session, Command Center shall reject the command with an explanatory message in the conversation.

### Requirement 2: /merge command in session conversations

**Objective:** As a Command Center user, I want to trigger the smart-merge flow by typing `/merge` in the conversation, so that the merge's commit message reflects what was actually built.

#### Acceptance Criteria

1. When a user submits a message beginning with `/merge` in a session conversation, Command Center shall initiate the smart-merge flow for that session instead of forwarding the message to the agent as a normal prompt.
2. When the smart-merge flow is initiated via `/merge`, Command Center shall run it with automatic conflict resolution enabled, with no per-invocation option to disable it.
3. When the smart-merge flow produces its final squash commit, Command Center shall use the agent-generated message as the squash commit message.
4. When `/merge` is followed by trailing text, Command Center shall treat that text as guidance for commit-message generation and shall not use it verbatim as the commit message.
5. The smart-merge flow triggered by `/merge` shall behave identically to the existing smart-merge flow in all respects other than its trigger and the source of the squash commit message.
6. If `/merge` is submitted in a conversation that has no associated session worktree, for a finished session, or while a commit, merge, or conflict-resolution background job is already active for the session, Command Center shall reject the command with an explanatory message in the conversation.

### Requirement 3: Agent-generated commit messages

**Objective:** As a Command Center user, I want the commit message written by the agent in the conversation that produced the changes, so that messages describe intent rather than being generic placeholders.

#### Acceptance Criteria

1. When a commit or merge flow is initiated from a conversation, Command Center shall obtain the commit message by running an agent turn in that same conversation before performing any git operation.
2. While the message-generation turn is running, Command Center shall display it in the conversation like a normal agent turn so the user can observe it.
3. The message-generation turn shall limit the agent's task to producing the commit message; all git operations shall be performed by Command Center's deterministic flows.
4. When generating the message, Command Center shall make the current changes of the session worktree available to the agent as input, in addition to the conversation's existing context.
5. When trailing hint text was provided with the command, Command Center shall include it as steering input for the generated message.
6. When the agent returns a message, Command Center shall validate that it is non-empty and well-formed before using it.
7. The message generation shall function regardless of which agent backend the conversation uses; if the active backend cannot produce a valid message, the fallback behavior of Requirement 4 shall apply.

### Requirement 4: Fallback when message generation fails

**Objective:** As a Command Center user, I want the commit or merge to proceed even when message generation fails, so that the deterministic flow is never blocked by the agent.

#### Acceptance Criteria

1. If the message-generation turn fails or returns an invalid or empty message, Command Center shall proceed with the commit or merge using a default message.
2. Where the flow is a smart merge, the default message shall identify the source branch and target branch of the merge.
3. Where the flow is a standalone commit, the default message shall be a generic commit message that identifies the session.
4. If the default message is used, Command Center shall record the generation failure in its logs and surface a user-visible notice that the default message was used.
5. The commit or merge shall never be aborted solely because message generation failed.

### Requirement 5: Deterministic flow preservation

**Objective:** As a Command Center operator, I want the background commit and merge flows to remain unchanged, so that existing validation, conflict handling, and job reporting behavior is preserved.

#### Acceptance Criteria

1. The background commit flow and smart-merge flow shall behave identically to their current behavior in all respects other than the trigger source and the origin of the commit/squash message.
2. The intermediate commits created during a smart merge (uncommitted-changes commit, conflict-resolution commit, validation-fix commit) shall keep their existing fixed messages.
3. When a commit or merge job runs, completes, fails, or ends in conflicts or ready-to-land, Command Center shall report job status, send notifications, and record job history exactly as it does today.

### Requirement 6: Command discovery in the conversation editor

**Objective:** As a Command Center user, I want `/commit` and `/merge` to appear in the conversation editor's command autocomplete, so that the commands are discoverable.

#### Acceptance Criteria

1. When the user opens the slash-command autocomplete in a session conversation's editor, Command Center shall list `/commit` and `/merge` as built-in commands with descriptions of what they do.
2. When the user selects `/commit` or `/merge` from the autocomplete, the editor shall insert the command ready for optional trailing hint text.

### Requirement 7: Removal of legacy commit and merge triggers

**Objective:** As a Command Center user, I want a single way to trigger commits and merges, so that the interface stays simple and messages always benefit from conversation context.

#### Acceptance Criteria

1. The Command Center UI shall no longer present the Commit button, the commit message dialog, the Merge button, or the smart-merge dialog as triggers for these flows.
2. The slash commands shall be the only user-facing triggers for the standalone commit flow and the smart-merge flow.
3. The removal of the trigger dialogs shall not remove or alter the user flows for reviewing conflicts, landing a ready-to-land merge, or discarding a prepared merge.

### Requirement 8: Commands submitted while the conversation is busy

**Objective:** As a Command Center user, I want a `/commit` or `/merge` submitted during an active turn to run after that turn finishes, so that the command is not lost and does not interfere with the running turn.

#### Acceptance Criteria

1. When `/commit` or `/merge` is submitted while the conversation is processing another turn, Command Center shall queue the command and execute it after the active turn completes.
2. While a turn is active, Command Center shall not deliver the literal command text to the agent as message content.
3. When a queued command executes, Command Center shall apply the same behavior (interception, eligibility checks, message generation, and dispatch) as if the command had been submitted while the conversation was idle.
