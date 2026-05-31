# CommandCenter.json Reference

## File Location

Place `CommandCenter.json` at the root of the git repository. It is optional — projects without it work normally.

## Schema

```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "preMergeCommand": "scripts/pre-merge-validate.sh",
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "port": { "strategy": "cc-assigned", "base": 3000, "range": 100 }
    }
  ]
}
```

## Field Types

| Field | Type | Required | Description |
|---|---|---|---|
| `initScriptPath` | `string \| null` | Yes (can be null) | Script to run after a session worktree is created |
| `preMergeCommand` | `string \| null` | No | Validation script to run before squash-merging into main |
| `devServers` | `Array<DevServer>` | No | Dev servers launchable from the session UI |

## Path Resolution

Both `initScriptPath` and `preMergeCommand` can be relative or absolute paths. Relative paths resolve from the **project root** (the original repository, not the worktree).

## Dev Server Entry

Each dev server entry requires:
- `name` — unique identifier (min 1 char), displayed in the UI
- `command` — shell command or script path to start the server (min 1 char)

Optional fields:
- `cwd` — working directory relative to the worktree (e.g. `apps/web`)
- `port` — port allocation strategy (see [`references/dev-servers.md`](./dev-servers.md))
- `readiness` — how CC decides the server is ready

Server names must be unique within the `devServers` array.

### Port Strategy

`cc-assigned` is the only supported strategy. CC picks the port from `[base, base+range)`, injects `$CC_ASSIGNED_PORT`/`$PORT`/your optional `env` alias, and waits for TCP readiness.

See `references/dev-servers.md` for full examples and field reference.

## Minimal Example

```json
{
  "initScriptPath": "scripts/worktree-init.sh"
}
```

## Full Example

```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "preMergeCommand": "scripts/pre-merge-validate.sh",
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "port": { "strategy": "cc-assigned", "base": 3000, "range": 100 },
      "readiness": { "type": "tcp", "timeoutMs": 60000 }
    },
    {
      "name": "storybook",
      "command": "npx storybook dev --port $CC_ASSIGNED_PORT --no-open",
      "port": { "strategy": "cc-assigned", "base": 6006, "range": 50 }
    }
  ]
}
```
