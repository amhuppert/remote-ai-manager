# Product Overview

CC (Command Center) — web control plane for managing remote Claude Code sessions. Each session runs in its own git worktree + branch (`csm/<name>`); UI provides create/monitor/interact across multiple parallel sessions.

## Core Capabilities

- **Project discovery** — scans configurable base directory for git repos
- **Session lifecycle** — create/monitor/delete; backed by worktrees + branches; Fast and Focus creation modes
- **Prompt execution** — `@anthropic-ai/claude-agent-sdk` `query()` API, single-flight locking, message queuing
- **Live observability** — own JSONL transcripts + computed git diffs per session
- **Real-time SSE** — conversation/job/notification/workflow/dev-server status broadcasts
- **Background jobs** — fire-and-forget merge/commit/conflict-resolution with SQLite history
- **Graph workflows** — declarative multi-context execution with task graphs, validation, retries, circuit breakers
- **Dev server automation** — per-session spawning, liveness polling, remote URL via Tailscale
- **Voice input** — Whisper-based prompt transcription

## Use Cases

- Multi-repo + parallel session management from one UI
- Remote monitoring of Claude activity (transcripts, diffs, status)
- Autonomous development via graph workflows for unattended operation

## Value

"Ground control" for Claude Code — turns ad-hoc CLI usage into structured multi-session workflow with full git isolation per session.
