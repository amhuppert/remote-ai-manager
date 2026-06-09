# Requirements Document

## Introduction

This feature makes message queuing into running conversations reliable and backend-neutral. When a user sends a follow-up message while an agent is actively working, Command Center must accept and durably queue the message, then deliver it within the agent's current turn when the active backend supports in-turn delivery (e.g. Claude) or as the next turn when the agent finishes when it does not (e.g. Codex). It also resolves the failure, UI, transcript, and image-handling gaps identified in the implementation review so a queued message is never silently lost or misrepresented. Discovery context, the selected approach, and design decisions are recorded in `brief.md`.

## Boundary Context

- **In scope**: Queuing follow-up messages into running, user-interactive conversations; in-turn delivery for capable backends; automatic next-turn delivery for backends without in-turn support (including Codex); coalescing multiple queued messages into a single next-turn delivery; durable, no-loss, recoverable queuing; capability-aware composer feedback; correct failure handling and client-state integrity; transcript integrity; image attachments on queued messages; honoring cancellation of an undelivered queued message.
- **Out of scope**: A full queued-message edit/cancel user interface; queuing into managed/iteration (non-interactive) workflow conversations; collaboration and graph-workflow turn orchestration; a general transcript-rendering overhaul (ordering and duplicate-display fixes only where the defect is reproduced); reworking the background-task auto-continuation behavior beyond what reliable post-turn delivery requires.
- **Adjacent expectations**: Relies on the conversation turn lifecycle to know when a turn starts and ends; relies on each backend runtime to report whether it can accept input during an in-progress turn; relies on existing image-attachment handling for the message payload; relies on existing transcript persistence and real-time update mechanisms.

## Requirements

### Requirement 1: Queue a follow-up message into a running conversation
**Objective:** As a user, I want to send a follow-up message while the agent is still working, so that I can add context or a new instruction without waiting for the agent to finish.

#### Acceptance Criteria
1. When a user submits a message while the conversation's agent is actively working, Command Center shall accept the message and queue it for that conversation.
2. When a message is queued, Command Center shall record it durably so that it survives delayed delivery, delivery failure, and process restart until it is delivered.
3. While a queued message has not yet been delivered, Command Center shall display it to the user as pending.
4. If a user submits a message while the conversation is not actively running, then Command Center shall not use the queue path and shall instead handle the message as a new prompt.

### Requirement 2: Backend-appropriate delivery timing
**Objective:** As a user, I want my queued message delivered as soon as the agent can act on it, so that it is handled within the current turn when the backend allows and otherwise as the next turn.

#### Acceptance Criteria
1. Where the active backend supports delivering input during an in-progress turn, Command Center shall deliver the queued message into the agent's current turn.
2. Where the active backend does not support in-turn delivery, Command Center shall deliver the queued message as the next turn after the current turn ends.
3. When the current turn ends and one or more messages are queued for a backend without in-turn delivery, Command Center shall automatically start the next turn with the queued message(s) without requiring further user action.
4. When the agent finishes processing a delivered queued message, Command Center shall persist and display the agent's response in the conversation.

### Requirement 3: Coalescing multiple queued messages
**Objective:** As a user, I want multiple messages I queue during one turn to be handled together, so that the agent receives them as a single coherent follow-up.

#### Acceptance Criteria
1. When multiple messages are queued during a single turn for next-turn delivery, Command Center shall combine them into a single delivery, preserving their original order.
2. When queued messages are combined, Command Center shall deliver them as one turn rather than as multiple separate turns.

### Requirement 4: Durability, no silent loss, and recovery
**Objective:** As a user, I want confidence that a queued message is never silently lost, so that I can trust the agent will receive it.

#### Acceptance Criteria
1. Command Center shall treat the durably recorded queued message as the source of truth until delivery to the agent is confirmed.
2. If delivery of a queued message to the agent fails, then Command Center shall retain the message for retry or surface it as failed, and shall not silently discard it.
3. If the conversation's turn completes concurrently with a message being queued, then Command Center shall still deliver the queued message as the next turn rather than dropping it.
4. While a queued message has not been confirmed delivered, Command Center shall not present it as answered.

### Requirement 5: Failure handling and client-state integrity
**Objective:** As a user, I want correct feedback when queuing fails, so that the interface never misrepresents what happened.

#### Acceptance Criteria
1. If a queue request fails, then Command Center shall surface a clear error to the user.
2. If a queue request fails while the conversation's turn is still running, then Command Center shall continue to indicate that the conversation is running.
3. If a queue request fails, then Command Center shall not leave the message displayed as accepted or queued.
4. If a message cannot be queued because the selected backend does not support queuing, then Command Center shall communicate that specific reason rather than a generic failure.

### Requirement 6: Capability-aware composer
**Objective:** As a user, I want the composer to reflect what will happen to a message I send during a running turn, so that I am not surprised by the outcome.

#### Acceptance Criteria
1. While a conversation is running, Command Center shall indicate in the composer whether a submitted message will be delivered within the current turn or after it.
2. Where the active backend cannot accept a queued message, Command Center shall not present queuing as available without explanation.
3. While a conversation is running, Command Center shall base the composer's queuing behavior on the active conversation's backend capability.

### Requirement 7: Transcript integrity
**Objective:** As a user, I want the transcript to accurately reflect queued messages and their responses, so that the conversation history is trustworthy.

#### Acceptance Criteria
1. When a queued message is accepted, Command Center shall place it in the transcript in the order it will be processed relative to other messages.
2. If a queued message is never delivered to the agent, then Command Center shall not leave it in the transcript as a message awaiting a response that can never arrive.
3. Command Center shall display each queued message exactly once, without duplicate entries.

### Requirement 8: Image attachments on queued messages
**Objective:** As a user, I want to attach images to a message I queue during a running turn, so that visual context is preserved.

#### Acceptance Criteria
1. When a user queues a message that includes image attachments, Command Center shall queue the images together with the message text.
2. When a queued message that includes images is delivered, Command Center shall provide the images to the agent along with the text.
3. If the image attachments cannot be queued, then Command Center shall inform the user rather than silently dropping them.

### Requirement 9: Cancelling an undelivered queued message
**Objective:** As a user, I want a queued message that the agent has not yet seen to be cancellable, so that I can retract something I no longer want sent.

#### Acceptance Criteria
1. Where a queued message has not yet been delivered to the agent, Command Center shall support cancelling its delivery.
2. When a queued message is cancelled before delivery, Command Center shall not deliver it and shall remove it from the pending display.
3. If a queued message has already been delivered, then Command Center shall not cancel it.

### Requirement 10: Interactive-conversation boundary
**Objective:** As an operator, I want queuing limited to user-interactive conversations, so that managed workflow turns are not disrupted.

#### Acceptance Criteria
1. If a user attempts to queue a message into a managed, non-interactive workflow conversation, then Command Center shall reject the request.
2. Command Center shall apply message queuing only to user-interactive conversations.
