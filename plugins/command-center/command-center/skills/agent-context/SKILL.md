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

Dev servers use the **CC_PORT protocol**: the script must print `CC_PORT=<port>` to stdout within 60 seconds. CC monitors liveness by polling the port every 5 seconds.

**If your project has dev servers configured**, you can ask the user to start them from the CC UI. You don't launch dev servers yourself — CC manages their lifecycle.

**Common dev servers:**

| Name | Typical Port | Purpose |
|---|---|---|
| `nextjs` | 3000+ | Next.js development server |
| `storybook` | 6006+ | Storybook component explorer |

Ports may differ from defaults when multiple sessions run in parallel — each worktree gets its own port.

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
| Dev servers | User starts manually | CC manages lifecycle, port allocation |
| Merge to main | User runs git commands | CC's merge workflow with validation |

## Tips

- **Check `CommandCenter.json`** in the repo root to understand what's configured for this project.
- **Don't worry about ports** — if a dev server is running, CC handles the port assignment.
- **Your branch is `csm/<session-name>`** — commits go here. CC handles merging to `main` when the user requests it.
