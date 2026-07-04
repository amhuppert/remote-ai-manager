# Requirements Document

## Project Description (Input)

Graph-workflow implementer and context-validator agents run fully autonomously today: `cctl ask` is blocked server-side for workflow-driven turns, so when an unattended workflow hits a consequential, hard-to-reverse, or genuinely ambiguous decision, the agent must guess — and a wrong guess can send an entire context and its downstream dependents down the wrong path. Alex (the CC operator) wants these agents to be able to ask him questions mid-task.

This feature allows implementer and context-validator agents in a graph workflow to invoke the existing `cctl ask` tool, gated by a new cascading boolean toggle (global → workflow → per-context, disabled by default, one toggle covering both roles). When an agent asks, its execution context parks in a new `awaiting_user_input` status mirroring the human approval gate: indefinite wait, sibling contexts keep running, the wait survives pause/restart, burns no iterations, and the workflow's completion guard refuses to finish while parked. Answers are stored on the context's `pendingUserInput` record (not the lane conversation's message queue; auto-drain never fires on lane conversations) and the execution loop resumes the same lane conversation with the `<cc-question-answers>` block in a follow-up prompt; context-limit rotation (`rotateBeforeNextTurn`) outranks the conversation pin, in which case the answer is delivered into the fresh conversation's follow-up prompt. Questions are answerable from the graph page (inline, reusing the existing question panel) and from the lane conversation view.

See `.kiro/specs/ask-question-in-graph-workflows/brief.md` for the discovery brief, including scope boundaries, adjacent specs, and the agreed design invariants (detection ordering, parked-wait invariants, answer storage, resume conversation pinning).

## Introduction

Command Center's graph workflows execute multi-context task graphs autonomously. This feature adds an opt-in, human-in-the-loop capability: when enabled through the workflow configuration cascade, a context's implementer or context-validator agent may ask the CC operator multiple-choice questions mid-task using the same ask tool and question panel that ordinary conversations use. The asking context parks in a dedicated awaiting-user-input state — visible on the graph page, durable across pause and restart, free of iteration or failure-count cost — while sibling contexts keep running. When the operator answers, the workflow resumes the conversation that asked, delivering the answers in the standard answer format, and continues the context's remaining work.

## Boundary Context

- **In scope**: the cascading enable/disable toggle; accept/deny gating of workflow-agent ask invocations; prompt guidance telling implementer and context-validator agents when the ask tool is available and how to use it; the awaiting-user-input context state and its cost/scheduling/completion invariants; answering from the graph page and the lane conversation view; resumption of the asking conversation (including the context-window-rotation precedence rule); real-time visibility of the state; durability across pause, halt, restart, and clean withdrawal on abort.
- **Out of scope**: asking by collaboration second-agents or the reserved planner session (both remain denied); any timeout or auto-skip mechanism; per-role toggles; changes to the question panel component, the ask/answer wire format, or the generic conversation ask/answer flow; enabling the capability by default; changes to how manual user prompts to lane conversations behave outside the answer flow.
- **Adjacent expectations**: the existing asynchronous ask/answer flow (question registration, single-pending-batch rule, question panel, answer recording, notification on registration) is reused unchanged; the human approval gate's park/resume behavior is the model for this state but the approval gate itself is not modified; the existing three-tier workflow configuration cascade resolves the new toggle; the workflow continuity feature continues to govern conversation reuse for all turns other than the answer-resume turn.

## Requirements

### Requirement 1: Cascading capability toggle

**Objective:** As the CC operator, I want a single toggle that controls whether graph-workflow agents may ask me questions, configurable at the global, workflow, and per-context tiers, so that I can enable interactive workflows selectively while unattended workflows stay fully autonomous.

#### Acceptance Criteria

1. The system shall provide a boolean workflow configuration setting that controls whether a context's workflow agents may ask the user questions.
2. The system shall resolve the setting through the existing three-tier cascade: a per-context value overrides a workflow-level value, which overrides the global default.
3. Where no tier sets a value, the system shall treat the capability as disabled.
4. When a workflow execution starts, the system shall fix the resolved toggle value for each execution context; configuration changes made after launch shall not alter the behavior of the running execution.
5. The system shall apply one shared toggle value to both the implementer and the context-validator agents of a context, with no per-role configuration.

### Requirement 2: Question submission by workflow agents

**Objective:** As a workflow implementer or context-validator agent, I want my ask invocation accepted when the capability is enabled, so that I can obtain user input at consequential decision points instead of guessing.

#### Acceptance Criteria

1. While a context's resolved toggle is enabled, when that context's implementer or context-validator agent invokes the ask tool during its turn, the CC server shall register the question batch under the same validation rules as ordinary conversations.
2. While a context's resolved toggle is disabled, when a workflow agent invokes the ask tool, the CC server shall deny the request with the existing autonomous-conversation refusal.
3. The CC server shall deny ask invocations from collaboration second-agents and from the reserved planner session regardless of the toggle value.
4. When a workflow agent's question batch is registered, the system shall notify the user in the same way as for pending questions in ordinary conversations.
5. If a workflow agent invokes the ask tool while a question batch is already pending on its conversation, the CC server shall reject the new batch under the existing single-pending-batch rule.

### Requirement 3: Awaiting-user-input context state

**Objective:** As the CC operator, I want a context whose agent asked a question to park visibly and safely until I answer, so that the workflow neither proceeds on a guess nor spends budget while waiting.

#### Acceptance Criteria

1. When an implementer turn ends with a question batch pending on its conversation, the workflow engine shall place the execution context in an awaiting-user-input state instead of starting another iteration or proceeding to validation.
2. When a context-validator turn ends with a question batch pending and no verdict rendered, the workflow engine shall place the context in the awaiting-user-input state and shall not record a validation failure for that turn.
3. While a context awaits user input, the workflow engine shall not consume iterations and shall not increase the context's consecutive-failure count.
4. While a context awaits user input, the workflow engine shall continue scheduling and running other eligible contexts.
5. While any context awaits user input, the workflow engine shall not complete the workflow execution.
6. The system shall allow multiple contexts to await user input concurrently, each answerable independently.
7. The workflow engine shall keep an awaiting-user-input context parked until the user acts, with no timeout or automatic skip.

### Requirement 4: Answering workflow questions

**Objective:** As the CC operator, I want to answer workflow questions from the graph page or the lane conversation view using the familiar question panel, so that answering is quick and consistent with ordinary conversations.

#### Acceptance Criteria

1. When a context awaits user input, the graph workflow page shall present the pending questions inline with the existing question panel interaction (option selection, optional note, skip).
2. When a context awaits user input, the lane conversation view shall present the same pending questions with the existing question panel behavior.
3. When the user submits answers from either surface, the system shall record exactly one answer set for the question batch and shall reject a subsequent submission for the same batch as already answered.
4. When the user skips a question, the system shall deliver that question to the agent marked as skipped, per existing skip semantics.

### Requirement 5: Workflow resumption after an answer

**Objective:** As the CC operator, I want the workflow to pick up exactly where the agent left off once I answer, so that asking costs no lost context and no duplicated work.

#### Acceptance Criteria

1. When answers are recorded for a context awaiting user input, the workflow engine shall resume that context by continuing the same conversation that asked, delivering the answers in the standard answer format agents receive in ordinary conversations.
2. The workflow engine shall resume the asking conversation for the answer-delivery turn even when conversation continuity is configured off for that context.
3. If the asking conversation already requires replacement because it reached its context-window limit, the workflow engine shall start the replacement conversation instead and deliver the answers, including the original question text, in that conversation's first prompt.
4. If answers are recorded before the asking turn has ended, the workflow engine shall continue the context's work without leaving it parked for further user action.
5. When a context resumes after an answer, the resumed turn shall be subject to the context's normal iteration accounting and limits.

### Requirement 6: Real-time visibility

**Objective:** As the CC operator, I want awaiting-input contexts clearly visible the moment they park, so that I notice pending questions promptly and workflows are not stalled longer than necessary.

#### Acceptance Criteria

1. When a context enters the awaiting-user-input state, the graph workflow page shall display a distinct visual state for that context without requiring a manual refresh.
2. When the awaiting-user-input state is entered or resolved, all open UI surfaces showing that workflow shall update in real time.
3. The workflow status readouts available to agents and operators (including the workflow status command output) shall reflect the awaiting-user-input state of a context.

### Requirement 7: Lifecycle durability

**Objective:** As the CC operator, I want the awaiting state to survive pauses, halts, and server restarts, and to end cleanly when the workflow ends, so that parked questions are never lost and never dangle.

#### Acceptance Criteria

1. While a context awaits user input, when the workflow execution is paused or halted and later resumed, the workflow engine shall restore the awaiting-user-input state and continue waiting for the answer.
2. If the CC server restarts while a context awaits user input, the system shall restore the awaiting-user-input state and the pending questions after the restart.
3. If answers are recorded while the workflow execution is paused or halted, the workflow engine shall apply them when the execution resumes.
4. When the workflow execution is aborted while a context awaits user input, the system shall withdraw the pending questions so they are no longer presented as answerable.

### Requirement 8: Agent prompt guidance

**Objective:** As a workflow implementer or context-validator agent, I want my prompt to tell me when the ask tool is available and how to use it, so that I use the capability at the right moments and follow the correct protocol instead of assuming asking is denied.

#### Acceptance Criteria

1. While a context's resolved toggle is enabled, the system shall include instructions in that context's implementer and context-validator prompts stating that the ask tool is available for questions to the user.
2. Where the capability is enabled, the instructions shall describe the usage protocol: ask only at consequential, hard-to-reverse, or genuinely ambiguous decision points; batch related questions into one invocation; end the turn after asking; and expect the answers to arrive when the context resumes, with a skipped question meaning proceed with best judgment.
3. Where the capability is enabled, the instructions shall state that the workflow pauses the context until the user answers, so the agent does not treat asking as a lightweight or free action.
4. While a context's resolved toggle is disabled, the system shall not present the ask tool as available in that context's agent prompts, and the existing guidance to proceed autonomously with best judgment shall remain in effect.
