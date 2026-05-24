# PR-26 Workflow-Graph Audit Counts

Computed at the start of PR-26 per the "Workflow-Graph Audit Specification" in
`memory-bank/codebase-reorganization-implementation-plan.md` (referenced from
the main reorganize worktree).

## Raw counts (run from worktree root)

| Command | Result |
|---|---|
| `git grep -c "from \"@/lib/workflow-graph" -- "src/lib/workflows/graph-workflow/*.ts"` (sum) | **47** |
| `git grep -c "from \"@/lib/workflows/graph-workflow" -- "src/lib/workflow-graph/*.ts"` (sum) | **13** |
| `git grep -c "from \"@/lib/workflow-graph" -- "*.ts" "*.tsx"` (sum) | **120** (= A) |
| `git grep -c "from \"@/lib/workflows/graph-workflow" -- "*.ts" "*.tsx"` (sum) | **18** (= B) |

## Derived booleans

- `engineImportsBinding` (does `src/lib/workflow-graph/` import from
  `src/lib/workflows/graph-workflow/`?): **true** — 13 import sites in
  `src/lib/workflow-graph/` reach into the binding folder, notably
  `execution-route-handlers.ts`, `graph-workflow-signal-halt.ts`,
  `implementer-runner.ts`, `parallel-worktrees.ts`,
  `runtime-edit-route-handlers.ts`, `validator-runner.ts`.
- `bindingImportsEngine` (does `src/lib/workflows/graph-workflow/` import from
  `src/lib/workflow-graph/`?): **true** — 47 import sites.
- `A` (total importers of `@/lib/workflow-graph`) = **120**.
- `B` (total importers of `@/lib/workflows/graph-workflow`) = **18**.

## Decision-table outcome

The decision table:

| Condition | Action |
|---|---|
| `engineImportsBinding == false` AND `bindingImportsEngine == true` AND `B` is much smaller than `A` | Rename binding → `graph-binding/`. |
| `engineImportsBinding == true` OR boundary unclear | **Merge binding into engine.** |
| `bindingImportsEngine == true` AND `A == B` | Nest engine into binding. |
| Otherwise | Default to merge. |

`engineImportsBinding == true`, so row 2 applies: **merge
`src/lib/workflows/graph-workflow/` into `src/lib/workflow-graph/`**. The
boundary is not one-directional (the engine reaches back into the binding for
manager/continuity/runtime-edit wiring), so the layering cannot be preserved by
a rename — collapsing the two folders into one is the correct outcome.
