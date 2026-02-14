# Product Overview

CSM (Claude Session Manager) is a web-based control plane for managing remote Claude Code coding sessions. It allows developers to create, monitor, and interact with multiple isolated Claude Code instances — each running in its own git worktree — through a centralized dashboard.

## Core Capabilities

1. **Project Discovery** — Scans a configurable base directory for git repositories and surfaces them as manageable projects
2. **Session Lifecycle** — Creates isolated coding sessions backed by git worktrees and dedicated branches (`csm/<name>`), with full create/monitor/delete lifecycle
3. **Prompt Execution** — Sends prompts to Claude Code CLI processes running in session worktrees, with single-flight locking to prevent concurrent executions
4. **Live Observability** — Parses Claude Code JSONL transcripts and git diffs to show conversation history and code changes per session
5. **Hook Integration** — Receives Claude Code lifecycle events (UserPromptSubmit, Stop) to track session activity and status in real time

## Target Use Cases

- **Multi-repo development** — Manage Claude Code sessions across several repositories from one place
- **Parallel sessions** — Run multiple isolated Claude sessions within the same project simultaneously (each in its own worktree)
- **Remote monitoring** — Observe what Claude is doing across sessions: conversation transcripts, code diffs, session status

## Value Proposition

CSM acts as "ground control" for Claude Code — turning ad-hoc CLI usage into a structured, multi-session workflow. Each session gets full git isolation (worktree + branch), preventing interference between parallel tasks while keeping everything within the same repository.

---

_Focus on patterns and purpose, not exhaustive feature lists_
