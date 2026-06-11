# Requirements Document

## Project Description (Input)
Implement a human approval gate in the graph workflow functionality, configured at the execution-context level and functioning as an additional validator stage. When an execution context completes and all other validators (script + agent) succeed, and a human approval gate is enabled for that context, the context parks in a waiting state and prompts the user to review and approve the work before the workflow can continue to dependent contexts. Independent parallel contexts keep executing.

The user has two options:
- **Approve** — the context completes normally (including merge for parallel-isolation contexts) and dependents unblock.
- **Reject** — with a message sent to the implementer agent explaining what's wrong and providing additional direction. Rejection follows the full validation loop: tasks reopen, the message feeds the next iteration prompt like an agent-validator failure, and script + agent validators re-run before the gate triggers again. Rejections consume an iteration but do not count toward the consecutive-failure circuit breaker.

When a human approval gate is triggered, the affected conversation appears in the active conversations list under the Needs Input section, sorted to the top, with a dedicated approval panel (Approve button; Reject expands a message textarea) posting to a dedicated approval endpoint. Pending gates survive server restart.

See `.kiro/specs/human-review-gate/brief.md` for discovery context, chosen approach, scope boundaries, and viability findings.

## Introduction
Graph workflows currently run unattended: once an execution context's automated validators pass, the context completes and dependent contexts start immediately. This feature adds an optional human approval gate per execution context. When enabled, a context whose automated validators have all passed pauses in an awaiting-approval state until the operator approves (context completes and the workflow proceeds) or rejects with a mandatory message (the implementer re-attempts through the standard validation loop). Pending reviews surface prominently in the active conversations list so the operator notices them quickly, and pending gates survive server restarts.

## Boundary Context
- **In scope**: per-context human approval gating that triggers only after all enabled automated validators pass; approve/reject review flow with a required rejection message routed to the implementer; surfacing pending reviews in the Needs Input section with notifications; chat with the gated conversation while the gate is pending; durability of pending gates across server restarts.
- **Out of scope**: approval delegation, multi-approver flows, or reviewer roles; approval timeouts or auto-approve deadlines; gates at the task level (context level only); generated review artifacts (diff summaries, review reports) beyond what the conversation and existing views already show; changes to collaboration-execution behavior.
- **Adjacent expectations**: relies on the existing validator pipeline (script and agent validators) having passed before a gate triggers; relies on the existing Needs Input surfacing and notification behavior for conversations that need input; does not redefine merge mechanics, the iteration limit, or the circuit-breaker policy beyond the accounting rules stated below.

## Requirements

### Requirement 1: Gate Configuration
**Objective:** As a workflow operator, I want to enable a human approval gate on selected execution contexts when defining a graph workflow, so that high-stakes work pauses for my review before the workflow proceeds.

#### Acceptance Criteria
1. Where a graph workflow definition includes an execution context, the Workflow Engine shall support enabling or disabling a human approval gate for that context.
2. The Workflow Engine shall support a workflow-level human approval gate setting that applies to every context that does not define its own override.
3. The Workflow Engine shall treat the human approval gate as disabled unless explicitly enabled.
4. When a workflow definition with gate settings is created or replaced, the Workflow Engine shall persist those settings as part of the workflow definition.
5. Where a human approval gate is disabled for a context, the Workflow Engine shall complete the context without pausing for human review.

### Requirement 2: Gate Triggering and Context Parking
**Objective:** As a workflow operator, I want a gated context to pause only after all automated validators pass, so that I review work that already meets the automated checks.

#### Acceptance Criteria
1. While a human approval gate is enabled for an execution context, when the context's implementer completes all tasks and every enabled validator for that context passes, the Workflow Engine shall place the context into an awaiting-approval state instead of completing it.
2. If any enabled validator fails for a gated context, the Workflow Engine shall handle the failure through the standard validation-failure flow and shall not trigger the human approval gate.
3. While an execution context is awaiting approval, the Workflow Engine shall not start any execution context that depends on it.
4. While an execution context is awaiting approval, the Workflow Engine shall continue executing and scheduling independent execution contexts.
5. While any execution context is awaiting approval, the Workflow Engine shall not report the workflow execution as completed.
6. When a context enters the awaiting-approval state, the Workflow Engine shall record a gate-pending event in the workflow execution history.

### Requirement 3: Surfacing Pending Reviews
**Objective:** As a workflow operator, I want pending approvals to surface prominently in the active conversations list, so that I notice and act on required reviews quickly.

#### Acceptance Criteria
1. When an execution context enters the awaiting-approval state, the Command Center UI shall show the context's conversation in the Needs Input section of the active conversations list.
2. While one or more conversations are pending human approval, the Command Center UI shall sort those conversations above other entries within the Needs Input section.
3. When an execution context enters the awaiting-approval state, the system shall notify the user through the same notification channels used for other conversations that need input.
4. When a pending approval appears or is resolved, the Command Center UI shall update the active conversations list without requiring a page reload.
5. While a context is awaiting approval, the Command Center UI shall display an approval panel offering an Approve action and a Reject action in both the conversation view and the conversation's peek view.

### Requirement 4: Approval Flow
**Objective:** As a workflow operator, I want approving a gated context to let the workflow continue exactly as if the context had completed without a gate, so that approval adds no operational overhead.

#### Acceptance Criteria
1. When the user approves a context that is awaiting approval, the Workflow Engine shall complete the context, including integrating (merging) its work product the same way as a non-gated context.
2. When a gated context completes after approval, the Workflow Engine shall make contexts that depend on it eligible to start.
3. When the user approves a context, the Command Center UI shall dismiss the approval panel and remove the conversation's pending-approval standing from the Needs Input section.
4. When a context is approved, the Workflow Engine shall record the approval decision in the workflow execution history.

### Requirement 5: Rejection Flow
**Objective:** As a workflow operator, I want to reject gated work with a message explaining what's wrong, so that the implementer receives concrete direction and re-attempts within the normal validation loop.

#### Acceptance Criteria
1. When the user chooses to reject, the Command Center UI shall require a non-empty rejection message before the rejection can be submitted.
2. When the user submits a rejection, the Workflow Engine shall return the context to active implementation and deliver the rejection message to the implementer as human-reviewer feedback in the next iteration.
3. When a rejected context's implementer finishes addressing the feedback, the Workflow Engine shall re-run every enabled validator before the human approval gate can trigger again.
4. When a rejection is submitted, the Workflow Engine shall count one iteration toward the context's iteration limit.
5. The Workflow Engine shall not count human rejections toward the consecutive-validation-failure circuit breaker.
6. If a context reaches its iteration limit, the Workflow Engine shall halt the context per the standard iteration-limit behavior regardless of whether iterations were consumed by rejections or by validation failures.
7. When a rejection is submitted, the Workflow Engine shall record the rejection decision and its message in the workflow execution history.

### Requirement 6: Conversation Interaction While Awaiting Approval
**Objective:** As a workflow operator, I want to chat with the implementer conversation while its gate is pending, so that I can ask clarifying questions before deciding.

#### Acceptance Criteria
1. While a context is awaiting approval, the system shall allow the user to send regular chat messages to the context's conversation alongside the approval panel.
2. When the user sends a chat message to a conversation awaiting approval, the Workflow Engine shall keep the approval gate pending.
3. When the agent finishes responding to a chat message in a conversation awaiting approval, the Command Center UI shall continue to display the approval panel and the conversation shall remain in the Needs Input section.

### Requirement 7: Gate Lifecycle, Durability, and Error Handling
**Objective:** As a workflow operator, I want pending gates to be durable and to fail safely, so that reviews are never lost or double-applied.

#### Acceptance Criteria
1. If the server restarts while a context is awaiting approval, the system shall restore the pending gate such that the conversation remains in the Needs Input section and the approval panel remains functional.
2. If an approval or rejection is submitted for a context that is not awaiting approval, the system shall reject the action with an explanatory error and the Command Center UI shall refresh the displayed state.
3. When concurrent approval or rejection decisions are submitted for the same context, the system shall apply only the first decision and reject subsequent ones with an explanatory error.
4. If the workflow execution is aborted while a context is awaiting approval, the system shall dismiss the pending gate and remove the conversation's pending-approval standing from the Needs Input section.
5. If the workflow execution is halted or paused while a context is awaiting approval, the system shall preserve the pending gate so it can be resolved when the execution resumes.
