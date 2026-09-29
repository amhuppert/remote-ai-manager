# Module graph reports

Run from the worktree root. Reports are written under
`.cc/temp/module-graph/`; terminal output lists the artifact paths.

```bash
# Production files, cycle witnesses, and every edge in a cross-domain cycle.
bun run deps:graph --report --no-render

# Forward/reverse reach for both files and their shortest import path.
bun run deps:graph --no-render \
  --from src/lib/workflows/conversation/manager.ts \
  --to src/lib/workflows/conversation/production.ts

# Trace a test fixture and estimate which tests depend on it.
bun run deps:graph --tests --no-render \
  --from src/lib/workflows/conversation/testing/lifecycle-fixture.ts

# Estimate selection for one or more changed paths, including new/deleted files.
bun run deps:graph --tests --no-render \
  --changed src/lib/specs/delivery-plan-policy.ts \
  --changed src/app/api/new/route.ts
```

`--from` and `--to` each include forward and reverse reach, including the queried
file itself. Together they also request the shortest directed import path;
`null` means no path. A file absent from the chosen graph is an error. Use
`--tests` for test files. `--changed` accepts absent paths because declared input
globs can select tests for additions and deletions. With `--tests`, `--from` is
the default changed path when no `--changed` flags are supplied. Without either,
the report includes the unit-test inventory count and a query hint.

The default command still renders the domain SVG. Use `--no-render` to skip
Graphviz. Domain aggregation can create apparent cycles between folders where
no file-level cycle exists; use the JSON witnesses when investigating ownership.

## Artifacts and interpretation

- `production.json`: dependency-cruiser's complete production cruise. The roots
  come from `scripts/module-graph-roots.ts`: App Router entries, instrumentation,
  middleware, CLI, and Cursor worker. UI and library modules follow their imports.
  A module reached only through a type import remains visible in this artifact.
- `validation.json` and `test-inputs.json`, with `--tests`: the additional unit
  tests, fixtures reached by imports, setup modules, profile inventory, and
  `@vitest-inputs` declarations.
- `report.json`, with `--report`, `--tests`, or a path query: production value
  reach, file-level strongly connected components and cycle witnesses,
  cross-domain cycle edges, requested reach/path queries, and test-impact estimates.

Value analysis drops edges marked `preCompilationOnly` and excludes external or
unresolved modules. Production summaries further restrict membership to value
reach from the real application entries. A cycle witness is a closed sequence
of actual files. Every edge inside a component spanning two or more
`src/lib/<domain>` folders is reported, including edges through bridge files and
edges within one of those domains. Thus an added edge inside an existing large
cycle remains visible. A cross-domain cycle is evidence to review, not proof
that its ownership is wrong.

Raw edges retain `preCompilationOnly`, `dynamic`, `moduleSystem`, and
`dependencyTypes`. The report distinguishes type-only dependencies, static
imports, dynamic imports, and `require` calls whose timing is unknown. These are
syntax classifications, not observations of module evaluation. Dynamic imports
and `require` remain in reachability. Unresolved dependencies are listed; inspect
them before making claims about a path through a package.

The seam ratchet uses the same pure cycle/path analysis over a different input:
`scripts/module-imports.ts` erases TypeScript before extracting imports. That
also removes value-spelled imports used only as types. The cruise-based report
states its own filter and should not be treated as identical to that scanner or
to Vite's runtime graph.

## Test impact

`testImpact.estimate` reports three sorted lists: import-selected tests,
declared-input-selected tests, and their deduplicated union. Declared inputs use
the registered runner's existing `selectTestsForChangedPaths` matcher. Only unit
tests in the current inventory count; browser acceptance and stories do not.

The estimate does **not** simulate setup/configuration changes that make the
registered runner expand to full scope, nor runtime module evaluation. It is
not a measured selection result or a prediction of wall-clock savings. Compare
the registered runner's actual selection and timing for equivalent edits before
using these counts to rank performance work. Public type changes and incremental
typecheck have different dependency and cost models.

## Enforced boundaries and cycle ratchet

`cctl validate run seams --queue-if-busy --json` checks the reviewed core
boundaries transitively and compares production cycle edges with
`scripts/module-cycle-baseline.json`. Each surviving edge has a rationale and
removal condition. Adding an edge inside an existing cycle also fails. Removing
an edge requires shrinking the baseline:

```bash
bun scripts/module-seams.ts --ratchet
```

That command can only remove allowances; it refuses new edges, duplicate
allowances, or core-boundary violations. It cannot approve a larger baseline.
The guard includes literal deferred imports. It does not resolve computed
imports or imports hidden inside external packages.

## Measured test selection and phases

```bash
cctl validate run test-impact --queue-if-busy --json -- src/lib/workflows/production.ts
```

The registered diagnostic writes native Vitest related-file selection under
`.cc/temp/validation-impact/` without executing tests. It deliberately measures
only that selection mechanism: the normal wrapper also expands declared inputs
and setup/configuration changes. No source paths records the full unit inventory.

The reporter is resolved beside the launcher, so a registered wrapper can also
serve older session checkouts that lack the new reporter file. Its output still
belongs to the tested checkout.

The unit-test launcher writes `.cc/temp/validation-metrics/` JSON with the
selected test modules and their observed collection, setup, environment,
preparation, and execution durations. Transform duration is a run-level total
when the installed Vitest exposes it; unavailable values are `null`. Transform
and collection overlap, so these durations cannot be added into wall time.
Artifacts include the validation run ID when provided by the runner.

Until these wrapper and registration changes reach the registered checkout,
installed `cctl` still uses that checkout's previous launchers. Branch-local
wrapper verification is required when developing this tooling.
