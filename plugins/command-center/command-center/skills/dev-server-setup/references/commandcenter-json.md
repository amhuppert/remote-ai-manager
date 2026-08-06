# CommandCenter.json Reference

## File Location

Place `CommandCenter.json` at the repository root. It is optional; projects without it work normally.

## Schema

```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "validation": {
    "commands": {
      "lint": {
        "command": "scripts/validate/lint.sh",
        "cost": 1,
        "description": "Lint changed files"
      },
      "test": {
        "command": "scripts/validate/test.sh",
        "cost": 4,
        "timeoutMs": 900000,
        "scopeArgs": "paths"
      }
    },
    "preMerge": ["lint", "test"],
    "laneMerge": ["test"]
  },
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "port": { "base": 3000, "range": 100 }
    }
  ]
}
```

## Field Types

| Field | Type | Required | Description |
|---|---|---|---|
| `initScriptPath` | `string \| null` | No | Script to run after a session worktree is created |
| `validation` | `ValidationConfig` | No | Registered validation commands and merge-gate selections |
| `devServers` | `Array<DevServer>` | No | Dev servers launchable from the session UI |

### ValidationConfig

| Field | Type | Required | Description |
|---|---|---|---|
| `commands` | `Record<string, ValidationCommand>` | Yes | Commands keyed by stable kebab-case names |
| `preMerge` | `string[]` | No | Ordered selection for Smart Merge and Smart Commit; defaults to `[]` |
| `laneMerge` | `string[]` | No | Ordered graph lane-merge selection; inherits `preMerge` when omitted |

Every name selected by `validation.preMerge` or `validation.laneMerge` must exist in `validation.commands`.

### ValidationCommand

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | Yes | Executable wrapper path, normally under `scripts/validate/` |
| `cost` | positive integer | Yes | Fixed reservation weight against the global validation budget |
| `timeoutMs` | positive integer | No | Command-specific execution timeout |
| `description` | `string` | No | Human-readable text surfaced by validation discovery |
| `scopeArgs` | `"forbid" \| "paths"` | No | Whether validated relative path arguments may narrow the run; defaults to `"forbid"` |

`cost` must describe the wrapper's maximum fixed resource profile. Use about one unit per configured test worker and keep the convention consistent across projects on the same machine.

## Path Resolution and Execution

`initScriptPath` and validation `command` paths may be relative or absolute. Relative paths resolve from the canonical project root, while validation runs use the target session or lane worktree as `cwd`. Validation wrappers are invoked with `execFile`, so they need a shebang and executable permissions and cannot be shell command strings.

Because command paths resolve from the canonical project root, an unmerged branch cannot test edits to its own registry or wrappers through `cctl validate`.

## Dev Server Entry

Each dev-server entry requires a unique `name`, a `command`, and `port.base`. Optional fields are `cwd`, `port.range`, and `port.env`. CC picks a port from `[base, base+range)`, injects `$CC_ASSIGNED_PORT`, `$PORT`, and the optional alias, then waits for TCP readiness.

For the complete dev-server schema and examples, use `references/dev-servers.md`. The dev-server setup workflow preserves existing initialization and validation configuration.

## Minimal Example

```json
{
  "initScriptPath": "scripts/worktree-init.sh"
}
```

## Validation-Only Example

```json
{
  "validation": {
    "commands": {
      "typecheck": {
        "command": "scripts/validate/typecheck.sh",
        "cost": 1
      }
    },
    "preMerge": ["typecheck"]
  }
}
```
