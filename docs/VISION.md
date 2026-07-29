# Vision

This document describes where I see Command Center functionality going, so that designs for new features are aligned with this direction. These are not necessarily settled decisions. This vision encompass multiple units of work to be delivered over time. It does not specify which parts of the vision should be delivered as one feature or the order in which they should be implemented. The features and behavior described here are deliberately high-level; detailed functional specs and technical designs are deferred until we pick up the work for each part of the vision.

## High-Level

- Graph Workflow machinery used to implement CC native features
- Graph Workflows are more versatile and dynamic (orchestrating agent, conditional paths, looping behavior, course-correcting)
- Graph Workflows can be lighter weight, can be created and used by agents in the course of a normal conversation, do not need a persistent definition (though persistent definitions/templates will still be supported)

## Dynamic Workflows

Graph workflows are dynamic in the sense that they are be planned specifically for a particular feature implementation, but have limited dynamism when it comes to reacting to new information after execution has already begun.

We want to preserve the strengths of the current graph workflow functionality, while taking inspiration from Claude Code native dynamic workflows (the Workflow tool, https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code).

### Goal: Graph Workflows can cleanly support general forms of at least the 6 workflow patterns described in the Anthropic blog post (and larger workflows that combine multiple of these patterns)

[6 Workflow patterns](./workflow-patterns.png)

Patterns:
1. Classify-And-Act
2. Fanout-And-Synthesize
3. Adversarial Verification
4. Generate-And-Filter
5. Tournament
6. Loop Until Done

Graph Workflows support limited, non-general forms of some of these patterns (pre-determined task completion loop and verification loops, for example). Others might be supported, but force a heavy-weight execution model beyond what is needed or make communication between agents indirect and awkward.

## Parallelism

- Allow planning agents to choose between performing work in separate worktrees and lighter weight orchestration of parallel agents in the same worktree (like Claude Code Workflows).
  - File ownership list for same-worktree coordination

## Keep supporting first-class forms of the most useful patterns

- Task completion loop & context validators: native support is valuable. Keep it.
- Be open to adding special Graph Workflow support for additional workflow patterns when justified.
  - When might it be justified?: when it enables higher quality outputs, improves reliability, lowers cost, or simplifies planning for agents creating or orchestrating graph workflows.

## Planning

- Make it easier for agents to create good workflow definitions and to make adjustments to running workflows.
- Let agents plan the lanes for each execution context rather than assigning lanes deterministically, giving them more control over parallism.
  - Hypothesis: Will allow agents to produce graph workflows that execute more efficiently, lower overhead

### Workflow DSL

- Workflow definitions can be very large and complicated, making them difficult to plan efficiently and effectively.
- A workflow DSL might help agents plan by allowing them to work at a higher level, without having to think about the schema of a workflow definition.
- The DSL could have first-class support for general patterns (like the 6 listed above: "Classify-And-Act", etc.) without having graph workflows actually have first-class support for them. The DSL would be compiled into the lower-level building blocks that make up a graph workflow.

## Structured Output Interfaces

- Support specifying execution context to produce structured output adhering to the specified JSON schema.

## Validators

- Agent validators work well, but could be improved by supporting multiple specialist validators
  - Custom agent prompts
  - One validator focus on security, another on type safety, etc. Configurable.
- Also, we should support configurable specialized *implementors*.

## Owning/Orchestrating Agent

- Let an agent own a workflow execution
- Give ability to dynamically adjust the workflow and resolve issues during execution
- Circuit breaker trips (or after every validation failure): orchestrating agent automatically reviews the failure to determine if it was caused a planning defect, and, if so, updates the charter/AC/other plan artifacts to resolve the issue. This alone would likely fix the vast majority of workflow issues (misalignment) and prevent burning iterations on impossible-to-satisfy AC.
