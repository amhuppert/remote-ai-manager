# Dev Server Reference

CC manages every dev server with the `cc-assigned` port strategy: CC scans the configured port range, picks an owned-or-free port, injects it into the child process via `CC_ASSIGNED_PORT`, `PORT`, and any user-defined alias, and waits for TCP readiness on that port. **No shell helper scripts are required.**

## `CommandCenter.json` entries

```json
{
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

| Field | Default | Notes |
|---|---|---|
| `port.strategy` | `"cc-assigned"` | The only supported strategy. |
| `port.base` | required | First port in the scan window. |
| `port.range` | `100` | Number of ports to scan upward from `base`. |
| `port.env` | none | Optional extra env var name to set to the assigned port. |
| `readiness.type` | `"tcp"` | The only supported readiness type. |
| `readiness.timeoutMs` | `60000` | Hard timeout before transitioning to `error`. |
| `cwd` | the worktree root | Optional subdirectory (e.g. `apps/web`). |

## Subdirectory variant (monorepos)

Set `cwd` to the subdirectory relative to the worktree. CC will spawn the command there and verify port ownership against that working directory.

```json
{
  "devServers": [
    {
      "name": "nextjs",
      "command": "npx next dev --port $CC_ASSIGNED_PORT",
      "cwd": "apps/web",
      "port": { "strategy": "cc-assigned", "base": 3000, "range": 100 }
    }
  ]
}
```

## Custom servers

Any framework that accepts a port flag works the same way — just reference `$CC_ASSIGNED_PORT` in the command:

```json
{
  "devServers": [
    {
      "name": "api",
      "command": "node server.js --port $CC_ASSIGNED_PORT",
      "port": { "strategy": "cc-assigned", "base": 8080, "range": 50 }
    }
  ]
}
```

If your framework only reads `PORT`, you can omit the flag — CC always exports `PORT=$CC_ASSIGNED_PORT` too:

```json
{
  "command": "node server.js",
  "port": { "strategy": "cc-assigned", "base": 8080, "range": 50 }
}
```

## Server lifecycle

```
[Start]
  → CC scans [base, base+range) and picks an owned-or-free port
  → "starting" — env injected (CC_ASSIGNED_PORT, PORT, alias), command spawned in cwd
  → CC polls TCP loopback on the assigned port
  → port accepting connections within readiness.timeoutMs → "running"
  → timeout → "error" (process killed, last 10 output lines surfaced)
  → liveness check loses the port → "stopped"
```

## Unmanaged process detection

If CC finds a process already listening on a candidate port that was not started by CC for this worktree, the start attempt fails with an `UNMANAGED_DEV_SERVER_DETECTED` conflict. The UI surfaces a dialog with three options:

- **Cancel** — do nothing.
- **Try again** — retry the start (useful if the conflicting process exited in the meantime).
- **Stop server & retry** — kill the conflicting process (only allowed when CC can confirm the process was launched from the same worktree) and immediately retry.

Operator output is captured to `<worktree>/.cc/dev-server-logs/<server>.log` and exposed via the MCP `logFilePath` field.
