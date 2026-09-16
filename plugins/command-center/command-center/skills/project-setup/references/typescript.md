# TypeScript Reference

Load this reference when TypeScript is detected (`typescript` in `dependencies`/`devDependencies`, or a `tsconfig.json` at the project root).

## Scope to the dependency graph

A changed file can break type-checking in an unchanged dependent — a renamed export, changed signature, or removed field. Run the full project by default; use an established workspace/project-reference affected mode only when it includes those dependents. Passing changed source files directly to `tsc` does not provide that guarantee.

Use the compiler selected by the project (for example `tsc` or a configured native TypeScript compiler); preserve its build mode and cache location. The example below targets `tsc` without introducing a compiler migration.

## Validation wrapper invocation

```bash
run_quiet npx tsc --noEmit --pretty false
```

No conditional, no scoping, no flags depending on `$merge_base`. Always full-project.
Register it only as `command.full`; Command Center automatically reports effective full scope for changed requests.

| Flag | Purpose |
|---|---|
| `--noEmit` | Type-check only; do not emit JavaScript. |
| `--pretty false` | One-line-per-error format (~7x reduction vs. default). Ideal for AI consumption and log capture. |

## Parallelism

`tsc` is single-process by design. No worker pool to cap.
Register this wrapper with cost `1` unless the project's fixed build profile is materially heavier.

## Monorepo note

For projects using TypeScript project references or a workspace `tsc --build`, replace the invocation with the project's existing build command (e.g. `npx tsc -b`). Preserve its project-reference dependency traversal; affected selection must include unchanged dependents.
