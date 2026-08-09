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

You are running inside **Command Center (CC)** — a web-based control plane for managing remote coding-agent sessions (Claude Code, Codex, and future backends). CC created this session, its git worktree, and is managing your conversation lifecycle.

Most of the time you can work exactly as you would in a session outside CC. This document covers the areas where CC adds capabilities or changes behavior.

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

CC runs agents with permission prompts bypassed. You have full tool access without approval prompts. Use this responsibly — there is no safety net for destructive operations.

### Session Objective

If the session was created in **Focus mode**, your system prompt includes an `<objective>` tag with the user's stated goal. Prioritize work toward that objective.

## Session Tools — the `cctl` CLI

CC provides a command-line tool, **`cctl`**, on your `PATH` for session actions: registered validation, dev servers, notifications, reference documents, workflow authoring/lifecycle, Codex runs, and session alignment. It talks to CC's token-gated HTTP API; your identity (project, session, conversation) is injected via environment variables, so you never pass those explicitly. Run `cctl doctor` to confirm connectivity. For the full command reference, invoke the **`cc-cli`** skill.

### Validation commands and global capacity

Run `cctl validate list` to inspect the project's registered command names, declared costs, native/fallback changed support, caller policy, and current capacity. Run one with `cctl validate run <name>`; scope defaults to changed, `--scope full` requests full evidence, and full-only commands fall back automatically. Add `--wait` when the turn should join the strict FIFO queue instead of using fail-fast admission. Use values after `--` only to narrow a native changed command whose registration permits paths.

Every validation execution shares one server-owned global cost budget across all projects, sessions, conversations, graph workflows, and merge flows. A capacity refusal reports systemic capacity or an older queued request, not a validation-tool error. Decide whether waiting fits the turn; never respond by invoking the registered tool, package alias, or wrapper directly. A declared cost above the machine limit is a configuration error that must be fixed rather than queued.

### Dev-server commands

Use these before driving any browser, Playwright, visual, or Next.js MCP tooling — never assume a port like 3000 or 6006 belongs to your worktree, because parallel sessions get different ports.

| Command | Purpose |
|---|---|
| `cctl dev list [--json]` | List configured dev servers and their reconciled runtime status (`status`, `port`, `localUrl`, `remoteUrl`, `ownedByThisSession`, …). The `--json` output includes each server's log-file path. |
| `cctl dev ensure [<serverName>]` | Make sure a dev server is running for THIS session. Starts a stopped/errored server or waits for a starting one, blocks until liveness (or a bounded timeout), and prints the `localUrl`/`remoteUrl` to use. Omit `<serverName>` when exactly one server is configured. |
| `cctl dev stop <serverName>` | Stop a named dev server. CC verifies worktree ownership before signalling so externally owned listeners are never killed. |

**Diagnosing dev-server problems:** each running server has a log file on disk (interleaved stdout/stderr, line-prefixed `[OUT]`/`[ERR]`); `cctl dev list --json` reports its path. When a server fails to start or misbehaves, read that file for the full, authoritative output.

**How to use them:**

1. Before any browser / Playwright / Next.js MCP / visual verification, run `cctl dev ensure` (omit the name if exactly one server is configured).
2. Read the printed `localUrl` (typical: `http://localhost:<port>`) or `remoteUrl` and use that exact URL — do not guess.
3. `cctl dev ensure` exits non-zero with a one-line reason on failure. When it reports `NO_DEV_SERVERS_CONFIGURED`, the project has no `devServers` in `CommandCenter.json` — ask the user to configure one (or start a server from the UI) rather than retrying blindly. If multiple servers are configured it will ask you to pass a `<serverName>`.

## Project Configuration

Projects can have a `CommandCenter.json` at the repository root. If present, it configures:

### Init Script (`initScriptPath`)

Runs after CC creates your worktree. Typically installs dependencies. If the init script ran successfully, your worktree has dependencies ready.

**Environment variables available to the init script:**

| Variable | Value |
|---|---|
| `PROJECT_ROOT` | Original project root path |
| `WORKTREE_PATH` | Your session worktree path |
| `PARENT_WORKTREE_PATH` | Worktree this session was branched from (the parent session's worktree, or `PROJECT_ROOT` when branched off main) |
| `SESSION_NAME` | Session identifier |
| `BRANCH_NAME` | Git branch (`csm/<name>`) |

### Validation Registry (`validation`)

Projects register named executable wrappers in `validation.commands`, each with a required fixed cost and optional timeout, description, and path-scoping policy. `validation.preMerge` is the ordered selection for Smart Merge and Smart Commit. `validation.laneMerge` can select a cheaper ordered graph lane-merge profile and otherwise inherits `preMerge`.

All callers, including merge workflows and graph script gates, submit those names through the same ValidationService and global budget. Wrapper paths resolve from the canonical project root and execute with the target worktree as `cwd`, so an unmerged session cannot exercise edits to its own registry or wrappers through `cctl validate`.

### Dev Servers (`devServers`)

CC can launch dev servers for your session. Each entry has a `name` and `command`.

Dev servers use the **`cc-assigned` port strategy**: CC scans the entry's configured port range, picks an owned-or-free port, injects it into the child process via `$CC_ASSIGNED_PORT` (and `$PORT`), and waits for TCP readiness. CC monitors liveness by polling the port every 5 seconds.

**How agents interact with dev servers**: run `cctl dev ensure` (see *Dev-server commands* above) to get a server running for your session worktree on demand. It prints the correct `localUrl` and `remoteUrl` for your worktree's port — do not assume defaults like 3000 or 6006.

**Common dev servers:**

| Name | Typical Port | Purpose |
|---|---|---|
| `nextjs` | 3000+ | Next.js development server |
| `storybook` | 6006+ | Storybook component explorer |

Ports may differ from defaults when multiple sessions run in parallel — each worktree gets its own port. Always read the actual port from `cctl dev ensure` or `cctl dev list`.

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
| Session persistence | Backend-local (e.g. `~/.claude/`, `~/.codex/`) | CC manages its own transcripts |
| Dev servers | User starts manually | CC manages lifecycle and port allocation; agents run `cctl dev ensure` |
| Validation | User invokes tools directly | Registered commands run through `cctl validate` and share the server-owned global budget |
| Merge to main | User runs git commands | CC's merge workflow with validation |

## Tips

- **Check `CommandCenter.json`** in the repo root to understand what's configured for this project.
- **Use `cctl validate list` before validating** to discover the registered names, costs, scope support, policy, and live global capacity.
- **Run `cctl dev ensure` before browser/Playwright/Next.js MCP work** — the printed `localUrl` is the only URL you should hit. A common port responding does not mean it belongs to your worktree.
- **Your branch is `csm/<session-name>`** — commits go here. CC handles merging to `main` when the user requests it.
