# Graph workflow execution

[![How Command Center graph workflows execute](graph-workflow-execution.png)](graph-workflow-execution.svg)

The visualization separates four concepts that are easy to conflate:

- An **execution context** is an authored unit of ordered tasks, acceptance criteria, and execution policy. Its implementer and validator conversations are separate, and each one persists for the whole execution.
- A **lane** is a reusable Git history that can carry multiple contexts over time. A lane runs at most one context at a time; separate worktree lanes may execute in parallel.
- A worktree lane owns one branch and one isolated checkout. At fan-out, one child reuses the parent lane while competing children fork from its committed head.
- After a context's tasks, enabled validators run, then optional human approval, then Command Center commits the changes, adopts the agent-moved HEAD, or records a clean no-change completion.
- A `context_merge` converges upstream lanes before a fan-in context runs. A later, quiescent `final_publish` proof-gates and converges terminal lanes into the session worktree without marking the run Delivered; the session-to-project merge is the separate delivery boundary.
- A context join targets the most recently updated source lane (then lane ID ascending as a tie-breaker). The `β → α` target in the example is illustrative.
- After successful completion, Command Center attempts best-effort cleanup of landed lane worktrees and branches; cleanup failures do not undo completion. Halted or aborted lanes remain until session deletion.

The SVG is the editable source. The PNG is a rendered preview. Runtime semantics are grounded in `.kiro/steering/workflows.md` and `src/lib/workflow-graph/`.
