## cctl validate

List and execute the project's registered validation commands through the server-owned ValidationService and its global cost budget.

```
cctl validate list [--json]
cctl validate run <name> [--scope changed|full] [--queue-if-busy] [--timeout <dur>] [--require-match] [--json] [-- <validated paths>]
cctl validate status [run-id] [--json]
cctl validate cancel <run-id> [--json]
```

- `list` shows stable command names, declared costs, descriptions, path-scope support, caller enablement, and current global capacity. It intentionally does not reveal executable paths.
- `run` submits one registered name and always blocks to a verdict. `--queue-if-busy` decides only how a busy scheduler answers — join the strict weighted FIFO queue instead of refusing immediately. It does not control whether validation blocks, unlike `agent run --wait` / `workflow run --wait`, where `--wait` decides whether to block at all. A capacity refusal means systemic capacity or an older waiter currently blocks admission, not that the validation tool failed. A command whose declared cost exceeds the machine limit is invalid configuration and is rejected even with `--queue-if-busy`.
- A pass prints one verdict line — `validation passed: <name> (scope <requested>→<effective>, <n> files, run <id>)` — followed by the tail of the runner output; the full output stays in the `--json` envelope and in `validate status <id>`. A narrowing path that matches nothing still passes and says `0 files matched — vacuous pass, verify the scope path`; `--require-match` turns that into exit `1`. Use `--require-match` when citing a pass on explicit paths. Read the verdict instead of trusting a silent green.
- `--timeout` bounds only the client wait (default 2h, covering queue time). On expiry the run continues server-side and the failure names `cctl validate status <run-id>`, which recovers the verdict.
- Values after `--` may only narrow a command registered with path scoping. The server rejects option tokens, absolute paths, traversal, and worktree escapes, so callers cannot override workers, heap, pool, or configuration. Omit `--` entirely for a command that forbids scope arguments.
- A command disabled for the caller's graph role exits successfully as a policy no-op, consumes no capacity, and spawns nothing. Do not retry it or bypass the policy.
- `status` without an id lists active queued/running jobs and capacity; with an id it reports that run's queue or terminal state. `cancel` requires the submitter's private lease. A blocking `run` renews its lease and attempts cancellation on SIGINT/SIGTERM; lease expiry is the fallback for a dead client.

Run registered validation only through `cctl validate run <name>`. Scope defaults to changed; use `--scope full` when full-project evidence is required. Full-only commands fall back automatically. Paths after `--` narrow native changed runs only. Do not invoke Vitest, ESLint, TypeScript, formatters, builds, their package-script aliases, or registered validation scripts directly. Never bypass the wrapper to avoid a queue or an execution-context policy. A direct invocation is allowed only for a narrow diagnostic the registered commands cannot express — state the reason first and use the smallest possible scope. If it is resource-intensive or repeatable, register a command instead.

Use `cctl validate list` before assuming a conventional name such as `test`, `lint`, or `typecheck`; projects may register arbitrary kebab-case names. Use the `project-setup` skill when adding or changing registry entries and wrappers.
