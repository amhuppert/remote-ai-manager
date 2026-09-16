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
        "command": {
          "full": "scripts/validate/lint-full.sh",
          "changed": "scripts/validate/lint-changed.sh"
        },
        "cost": 1,
        "description": "Lint project files",
        "pathArgs": "forbid"
      },
      "test": {
        "command": {
          "full": "scripts/validate/test-full.sh",
          "changed": "scripts/validate/test-changed.sh"
        },
        "cost": 4,
        "timeoutMs": 900000,
        "pathArgs": "paths"
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

Every name selected by `preMerge` or `laneMerge` must exist in `validation.commands`.

### ValidationCommand

| Field | Type | Required | Description |
|---|---|---|---|
| `command.full` | `string` | Yes | Full-run wrapper path, normally under `scripts/validate/` |
| `command.changed` | `string` | No | Native changed-run wrapper; changed requests fall back to full when omitted |
| `cost` | positive integer, or `{ full, changed?, paths? }` | Yes | Reservation weight against the global validation budget |
| `timeoutMs` | positive integer | No | Command-specific execution timeout |
| `description` | `string` | No | Human-readable text surfaced by validation discovery |
| `pathArgs` | `"forbid" \| "paths"` | No | Whether validated relative paths may narrow a native changed run; defaults to `"forbid"` |

`timeoutMs` is shared by both variants. A scalar `cost` is also shared and must describe their maximum fixed resource profile. The table form prices scopes separately: `full` is the required honest maximum, `changed` defaults to `full`, and `paths` charges `base + perPath * N` for N forwarded paths, capped at the changed weight. The schema rejects a `paths` block without `pathArgs: "paths"`, a `changed` above `full`, and a `paths.base` above the changed weight. Every invocation requests changed or full; changed is the default and falls back to `command.full` when `command.changed` is absent. Paths require changed scope, a changed wrapper, and `pathArgs: "paths"`.

## Path Resolution and Execution

`initScriptPath` and both validation command paths may be relative or absolute. Relative paths resolve from the canonical project root, while validation runs use the target session or lane worktree as `cwd`. Validation wrappers are invoked with `execFile`, so they need a shebang and executable permissions and cannot be shell command strings. Each wrapper implements one fixed mode and never parses Command Center's scope.

Because command paths resolve from the canonical project root, an unmerged branch cannot test edits to its own registry or wrappers through `cctl validate`.

## Dev Server Entry

Each dev-server entry requires a unique `name`, a `command`, and `port.base`. Optional fields are `cwd`, `port.range`, and `port.env`. CC picks a port from `[base, base+range)`, injects `$CC_ASSIGNED_PORT`, `$PORT`, and the optional alias, and waits for TCP readiness. Readiness has a fixed 60-second timeout; there is no `readiness` or `port.strategy` configuration field.

For the complete dev-server schema and examples, read [the dev-server reference](../../dev-server-setup/references/dev-servers.md). This skill preserves existing `devServers` entries but does not create or change them.

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
        "command": { "full": "scripts/validate/typecheck.sh" },
        "cost": 1,
        "pathArgs": "forbid"
      }
    },
    "preMerge": ["typecheck"]
  }
}
```
