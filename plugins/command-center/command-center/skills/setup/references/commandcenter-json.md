# CommandCenter.json Reference

## File Location

Place `CommandCenter.json` at the root of the git repository. It is optional — projects without it work normally.

## Schema

```json
{
  "initScriptPath": "scripts/worktree-init.sh",
  "preMergeCommand": "scripts/pre-merge-validate.sh",
  "devServers": [
    { "name": "nextjs", "command": ".cc/dev-servers/nextjs.sh" },
    { "name": "storybook", "command": ".cc/dev-servers/storybook.sh" }
  ]
}
```

## Field Types

| Field | Type | Required | Description |
|---|---|---|---|
| `initScriptPath` | `string \| null` | Yes (can be null) | Script to run after a session worktree is created |
| `preMergeCommand` | `string \| null` | No | Validation script to run before squash-merging into main |
| `devServers` | `Array<{ name: string, command: string }>` | No | Dev servers launchable from the session UI |

## Path Resolution

Both `initScriptPath` and `preMergeCommand` can be relative or absolute paths. Relative paths resolve from the **project root** (the original repository, not the worktree).

## Dev Server Entry

Each dev server entry requires:
- `name` — unique identifier (min 1 char), displayed in the UI
- `command` — shell command or script path to start the server (min 1 char)

Server names must be unique within the `devServers` array.

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
    { "name": "nextjs", "command": ".cc/dev-servers/nextjs.sh" },
    { "name": "storybook", "command": ".cc/dev-servers/storybook.sh" }
  ]
}
```
