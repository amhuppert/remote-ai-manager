# Phase 6: Agent MCP Tools

## Objective

Give agents a consistent, on-demand way to discover and prepare dev servers for
their own session worktree. Agents should not guess ports or use a server just
because a common port responds.

## Tool Surface

Expose these tools through `cc-session-tools`:

```text
get_dev_servers()
ensure_dev_server({ name?: string, wait?: boolean, timeout_ms?: number })
stop_dev_server({ name: string })
```

Do not expose `start_dev_server` initially. `ensure_dev_server` is the safer
agent primitive because it is idempotent.

## Files To Create

- `src/lib/dev-server-mcp-tools.ts`
- `src/lib/dev-server-mcp-tools.test.ts`
- Optional `src/lib/dev-server-service.ts`
- Optional `src/lib/dev-server-service.test.ts`

## Files To Update

- `src/lib/mcp-gateway/session-server.ts`
- `src/lib/mcp-gateway/session-server.test.ts`
- `src/lib/prompt.ts`
- `plugins/command-center/command-center/skills/agent-context/SKILL.md`
- `docs/project-configuration.md`

## Service Layer

Create a high-level service used by both API routes and MCP tools:

```ts
listDevServers({ projectPath, sessionName }): Promise<DevServerRuntimeState[]>
ensureDevServer({ projectPath, sessionName, serverName?, wait, timeoutMs })
stopDevServer({ projectPath, sessionName, serverName })
```

This avoids duplicating route logic inside MCP handlers.

## Tool Semantics

### `get_dev_servers`

- Reconcile first.
- Return configured servers and runtime status.
- Include `localUrl`, `remoteUrl`, `port`, `source`, `ownedByThisSession`,
  `worktreePath`, and diagnostics.

### `ensure_dev_server`

- Reconcile first.
- If exactly one configured server exists and `name` is omitted, use it.
- If multiple configured servers exist and `name` is omitted, return a
  structured ambiguity error.
- If a verified owned server already runs, return it.
- If stopped, start it.
- If starting and `wait` is true, wait for readiness.
- If errored, retry once by starting from stopped/error state.
- Return final URL/port or a clear error with recent output.

### `stop_dev_server`

- Stop the named server.
- Automatic shutdown of adopted servers is allowed, but stop must still verify
  worktree ownership before signaling by port.

## Red Tests First

1. Session server registers dev-server tools.

2. `get_dev_servers` returns reconciled status.

3. `ensure_dev_server` adopts existing owned server.

4. `ensure_dev_server` starts stopped server.

5. `ensure_dev_server` waits until running when requested.

6. `ensure_dev_server` returns ambiguity error when multiple servers exist and
   no name is supplied.

7. `ensure_dev_server` returns no-config error when project has no dev servers.

8. `stop_dev_server` delegates to ownership-safe stop.

## Prompt And Skill Updates

Update the agent-facing guidance:

- Before Playwright, browser, visual, or Next.js MCP verification, call
  `ensure_dev_server`.
- Use the returned `localUrl` or `remoteUrl`.
- Do not assume `3000`, `6006`, or any visible server belongs to the current
  worktree.
- Do not ask the user to start a dev server from the UI unless the MCP tool
  reports missing configuration or an unrecoverable start failure.

## Logging Requirements

Add structured events:

- `dev-server.tool.list`
- `dev-server.tool.ensure`
- `dev-server.tool.ensure_wait`
- `dev-server.tool.ensure_error`
- `dev-server.tool.stop`

## Acceptance Criteria

- Agents can query status on demand from their session-scoped MCP tools.
- Agents can prepare a usable dev server without knowing project/session IDs.
- Returned status explicitly identifies correct-worktree ownership.
- Existing UI/API flows continue to work.

## Residual Risk

Some agent backends may not expose MCP tool results identically. Keep responses
plain JSON text inside MCP content so both Claude and Codex can parse them.
