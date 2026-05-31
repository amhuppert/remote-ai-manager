---
name: agent-context
description: >-
  This skill should be used when an agent running inside Command Center needs
  to understand the CC-specific context of its environment. Use when the agent
  asks "what is Command Center", "how does CC work", "what MCP tools do I
  have", "what's my worktree", "how is this project configured", "what dev
  servers are available", or needs
  orientation about the CC environment it is running in.
---

# Command Center Agent Context

You are running inside **Command Center (CC)** — a web-based control plane for managing remote Claude Code sessions. CC created this session, its git worktree, and is managing your conversation lifecycle.

Most of the time you can work exactly as you would in a normal Claude Code session. This document covers the areas where CC adds capabilities or changes behavior.

## Your Environment

### Worktree Isolation

Your session runs in an isolated git worktree. CC created it when the session started:

| Property | Value |
|---|---|
| Working directory | A `.worktrees/<session-name>/` directory under the project root |
| Branch | `csm/<session-name>` (branched from `main`) |
| Dependencies | Installed by the project's init script (if configured) |

The worktree is a full copy of the repository. You have complete read/write access. Other sessions have their own worktrees and cannot interfere with yours.

**Rules:**
- Stay within your worktree. Never `cd` to the project root or another session's worktree.
- Use the worktree path for all file operations and git commands.
- If you need to compare against `main`, use `git diff` or `git log` — do not modify `main`'s working tree.

### Permissions

CC runs with `permissionMode: "bypassPermissions"`. You have full tool access without permission prompts. Use this responsibly — there is no safety net for destructive operations.

### Session Objective

If the session was created in **Focus mode**, your system prompt includes an `<objective>` tag with the user's stated goal. Prioritize work toward that objective.

## MCP Tools

CC injects custom MCP tools into your session. These are in-process servers — no network calls.

### Dev-Server Tools

These tools are scoped to your session worktree. Use them before driving any browser, Playwright, visual, or Next.js MCP tooling — never assume a port like 3000 or 6006 belongs to your worktree, because parallel sessions get different ports.

| Tool | Purpose |
|---|---|
| `get_dev_servers` | List configured dev servers and their reconciled runtime status (`status`, `port`, `localUrl`, `remoteUrl`, `ownedByThisSession`, `source`, `logFilePath`). |
| `ensure_dev_server({ name?, wait?, timeout_ms? })` | Make sure a dev server is running for THIS session. Starts a stopped/errored server or waits for an already-starting one. Returns the `localUrl`, `remoteUrl`, and `logFilePath` to use. If an unmanaged process is already listening on the target port, the call fails with an `UNMANAGED_DEV_SERVER_DETECTED` error — surface that to the user via the UI rather than retrying blindly. |
| `stop_dev_server({ name })` | Stop a named dev server. CC verifies worktree ownership before signalling so externally owned listeners are never killed. |

**Diagnosing dev-server problems:** Each running server has a `logFilePath` pointing to its interleaved stdout/stderr log on disk (truncated per spawn, line-prefixed `[OUT]`/`[ERR]`). When a server fails to start or behaves badly, read that file with the `Read` tool for the full output — it's authoritative and not size-limited like `recentOutput`.

**How to use them:**

1. Before any browser / Playwright / Next.js MCP / visual verification, call `ensure_dev_server` (omit `name` if exactly one server is configured).
2. Read the returned `localUrl` (typical: `http://localhost:<port>`) or `remoteUrl` and use that exact URL — do not guess.
3. Only fall back to asking the user to start a server from the UI when `ensure_dev_server` returns `NO_DEV_SERVERS_CONFIGURED` or an unrecoverable start failure.

**Error codes you may receive (in `isError: true` responses):**

| Code | Meaning |
|---|---|
| `AMBIGUOUS_DEV_SERVER` | Multiple servers are configured; re-call with `name`. The error payload includes `availableNames`. |
| `NO_DEV_SERVERS_CONFIGURED` | Project has no `devServers` in `CommandCenter.json`. Ask the user to configure one. |
| `UNKNOWN_DEV_SERVER` | The `name` you supplied isn't in `CommandCenter.json`. |
| `DEV_SERVER_START_FAILED` | The server failed to start; `recentOutput` is in the payload. |
| `DEV_SERVER_WAIT_TIMEOUT` | Server didn't reach running within `timeoutMs`. Inspect status with `get_dev_servers`. |

## Project Configuration

Projects can have a `CommandCenter.json` at the repository root. If present, it configures:

### Init Script (`initScriptPath`)

Runs after CC creates your worktree. Typically installs dependencies. If the init script ran successfully, your worktree has dependencies ready.

**Environment variables available to the init script:**

| Variable | Value |
|---|---|
| `PROJECT_ROOT` | Original project root path |
| `WORKTREE_PATH` | Your session worktree path |
| `SESSION_NAME` | Session identifier |
| `BRANCH_NAME` | Git branch (`csm/<name>`) |

### Pre-Merge Validation (`preMergeCommand`)

Runs before CC squash-merges your branch into `main`. This is CC's merge workflow — you don't invoke it directly. The script typically runs formatters, linters, type checks, and tests.

If validation fails, CC may use auto-fix: it sends the error output to Claude to fix issues, then re-runs validation. The script may run multiple times.

### Dev Servers (`devServers`)

CC can launch dev servers for your session. Each entry has a `name` and `command`.

Dev servers use the **`cc-assigned` port strategy**: CC scans the entry's configured port range, picks an owned-or-free port, injects it into the child process via `$CC_ASSIGNED_PORT` (and `$PORT`), and waits for TCP readiness. CC monitors liveness by polling the port every 5 seconds.

**How agents interact with dev servers**: use the `ensure_dev_server` MCP tool (see *Dev-Server Tools* above) to get a server running for your session worktree on demand. The tool returns the correct `localUrl` and `remoteUrl` for your worktree's port — do not assume defaults like 3000 or 6006.

**Common dev servers:**

| Name | Typical Port | Purpose |
|---|---|---|
| `nextjs` | 3000+ | Next.js development server |
| `storybook` | 6006+ | Storybook component explorer |

Ports may differ from defaults when multiple sessions run in parallel — each worktree gets its own port. Always read the actual port from `ensure_dev_server` or `get_dev_servers`.

## What CC Manages (Not Your Concern)

These happen automatically — no action needed from you:

- **Conversation persistence** — CC writes JSONL transcripts of your conversation.
- **SSE broadcasting** — Status changes are broadcast to the CC UI in real time.
- **Session lifecycle** — Creating, monitoring, and deleting sessions.
- **Merge workflow** — Squash-merging your branch into main (user-initiated from the UI).
- **Git worktree cleanup** — Handled when the session is deleted.

## Key Differences from Direct CLI Usage

| Aspect | Direct CLI | Inside CC |
|---|---|---|
| Working directory | User's chosen directory | Isolated git worktree |
| Permissions | User-configured | `bypassPermissions` (full access) |
| Session persistence | Local `~/.claude/` | CC manages its own transcripts |
| Dev servers | User starts manually | CC manages lifecycle and port allocation; agents call `ensure_dev_server` |
| Merge to main | User runs git commands | CC's merge workflow with validation |

## Tips

- **Check `CommandCenter.json`** in the repo root to understand what's configured for this project.
- **Call `ensure_dev_server` before browser/Playwright/Next.js MCP work** — the returned `localUrl` is the only URL you should hit. A common port responding does not mean it belongs to your worktree.
- **Your branch is `csm/<session-name>`** — commits go here. CC handles merging to `main` when the user requests it.
