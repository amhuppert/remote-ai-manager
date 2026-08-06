# TypeScript Reference

Load this reference when TypeScript is detected (`typescript` in `dependencies`/`devDependencies`, or a `tsconfig.json` at the project root).

## Why full-project, always

Unlike linting, formatting, and tests, `tsc` MUST run over the whole project. A changed file can break type-checking in an unchanged dependent — a renamed export, a changed function signature, a removed field. Scoping `tsc` to changed files would let those breakages merge into main.

This is the single deliberate exception in the validation pipeline. Linters and formatters scope to changed files; tests scope to the changed-file module graph; `tsc` runs against the full project.

## Validation wrapper invocation

```bash
run_quiet npx tsc --noEmit --pretty false
```

No conditional, no scoping, no flags depending on `$merge_base`. Always full-project.

| Flag | Purpose |
|---|---|
| `--noEmit` | Type-check only; do not emit JavaScript. |
| `--pretty false` | One-line-per-error format (~7x reduction vs. default). Ideal for AI consumption and log capture. |

## Parallelism

`tsc` is single-process by design. No worker pool to cap.
Register this wrapper with cost `1` unless the project's fixed build profile is materially heavier.

## Monorepo note

For projects using TypeScript project references or a workspace `tsc --build`, replace the invocation with the project's existing build command (e.g. `npx tsc -b`). Keep it full-project; the rationale above still applies.
